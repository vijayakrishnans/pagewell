import { JOB_FILES_TTL_HOURS } from "@saas/contracts/jobs";
import type { EventsRepository } from "@saas/db/events";
import type { Job, JobResult, JobsRepository } from "@saas/db/jobs";
import type { Uuid } from "@saas/db/ids";
import { r2Key } from "@saas/shared/r2-keys";
import { DriveError, type Drive } from "./drive.js";
import type { JobLimits } from "./limits.js";
import { fromPublic, toPublic } from "./ids.js";
import { RunnerError, type Runner } from "./runner.js";
import { audit } from "./audit.js";

// One job, start to finish: take it (queued → running, once), read its inputs from the drive
// as the person who asked, run the operation in pdf-runner, and put the result where it goes
// (the next version, new documents, or result files kept a day), then record how it ended.
// A runner that could not be reached is worth another attempt; anything else ends the job.

export interface ExecuteDeps {
  repo: JobsRepository;
  events: EventsRepository | null;
  bucket: R2Bucket | null;
  runner: Runner | null;
  /** The drive, acting as the job's creator. */
  drive: (job: Job) => Drive;
  limits: (job: Job) => Promise<JobLimits>;
  requestId: string;
  now: () => Date;
}

export type Outcome = "done" | "retry" | "skipped";

const stem = (name: string) => name.replace(/\.pdf$/i, "");
const clip = (name: string) => (name.length > 240 ? `${name.slice(0, 236)}.pdf` : name);

/** Names for the documents a job makes. */
function documentName(job: Job, firstName: string, i: number, count: number): string {
  const s = stem(firstName);
  switch (job.operation) {
    case "merge":
      return clip(`${s} (merged).pdf`);
    case "split":
      return clip(`${s} (part ${i + 1} of ${count}).pdf`);
    case "extract":
      return clip(`${s} (pages ${(job.options.pages as number[] | undefined)?.join(", ") ?? ""}).pdf`);
    default:
      return clip(`${s} (${job.operation}).pdf`);
  }
}

export async function runJob(deps: ExecuteDeps, orgId: Uuid, jobId: Uuid): Promise<Outcome> {
  const started = await deps.repo.start(orgId, jobId, deps.now());
  if (!started.ok) return "skipped"; // taken by another runner, canceled, or gone
  const job = started.value;
  const end = async (code: string, message: string): Promise<Outcome> => {
    await deps.repo.fail(orgId, jobId, code, message, deps.now());
    await audit(deps, job, "job.failed", `${job.operation} failed: ${message}`, { jobId: toPublic("job", jobId), code });
    return "done";
  };

  if (!deps.runner) return end("runner_unavailable", "The PDF runner is not available here");
  const drive = deps.drive(job);
  try {
    const limits = await deps.limits(job);
    const firstDoc = toPublic("doc", job.inputs[0]!.docId);
    const meta = await drive.document(firstDoc);
    const inputs: Uint8Array[] = [];
    for (const input of job.inputs) inputs.push(await drive.content(toPublic("doc", input.docId), input.version));

    const { outputs, pages } = await deps.runner.run(
      { operation: job.operation, options: job.options, limits: { pages: limits.pagesPerJob, cpuSeconds: limits.cpuSecondsPerJob, memoryMb: limits.memoryMb, wallSeconds: limits.wallSeconds } },
      inputs,
    );

    const result: JobResult = { documents: [], files: [] };
    let expiresAt: Date | null = null;
    if (job.outputMode === "version") {
      const pdf = outputs.find((o) => o.name === "result.pdf");
      if (!pdf) return end("runner_failed", "The runner returned no PDF");
      const saved = await drive.saveVersion(firstDoc, job.inputs[0]!.version, pdf.bytes);
      result.documents.push({ docId: job.inputs[0]!.docId, version: saved.version });
    } else if (job.outputMode === "document") {
      const pdfs = outputs.filter((o) => o.type === "application/pdf");
      if (pdfs.length === 0) return end("runner_failed", "The runner returned no PDF");
      for (const [i, pdf] of pdfs.entries()) {
        const made = await drive.createDocument(documentName(job, meta.name, i, pdfs.length), meta.folderId, pdf.bytes);
        const id = fromPublic("doc", made.id);
        if (id) result.documents.push({ docId: id, version: made.version });
      }
    } else {
      if (!deps.bucket) return end("internal_error", "No place to keep the result files");
      expiresAt = new Date(deps.now().getTime() + JOB_FILES_TTL_HOURS * 3_600_000);
      for (const o of outputs) {
        const key = r2Key.jobFile(orgId, jobId, o.name);
        await deps.bucket.put(key, o.bytes, { httpMetadata: { contentType: o.type } });
        result.files.push({ name: o.name, type: o.type, size: o.bytes.byteLength, r2Key: key });
      }
    }
    const done = await deps.repo.succeed(orgId, jobId, result, pages, deps.now(), expiresAt);
    if (!done.ok) return "done";
    await audit(deps, job, "job.succeeded", `${job.operation} finished${pages ? ` (${pages} pages)` : ""}`, {
      jobId: toPublic("job", jobId),
      pages,
      documents: result.documents.map((d) => ({ id: toPublic("doc", d.docId), version: d.version })),
      files: result.files.map((f) => f.name),
    });
    return "done";
  } catch (e) {
    if (e instanceof RunnerError) {
      if (e.transient) {
        await deps.repo.requeue(orgId, jobId);
        return "retry";
      }
      return end(e.code, e.message);
    }
    if (e instanceof DriveError) {
      if (e.status === 404) return end("not_found", "The document is gone, or no longer shared with the person who asked");
      if (e.status === 409) return end("version_conflict", "The document changed while the job ran: run it again on the new version");
      if (e.status === 402) return end("quota_exceeded", e.message);
      if (e.status >= 500) {
        await deps.repo.requeue(orgId, jobId);
        return "retry";
      }
      return end(e.code, e.message);
    }
    return end("internal_error", "The job failed");
  }
}
