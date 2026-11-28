import type { JobOperation, PublicJob } from "@saas/contracts/jobs";
import type { Job } from "@saas/db/jobs";
import { toPublic } from "./ids.js";

/** A job on the wire: public ids, never storage keys. */
export function publicJob(j: Job): PublicJob {
  return {
    id: toPublic("job", j.id),
    orgId: toPublic("org", j.orgId),
    operation: j.operation as JobOperation,
    status: j.status,
    documentIds: j.inputs.map((i) => toPublic("doc", i.docId)),
    version: j.inputs.length === 1 ? j.inputs[0]!.version : null,
    output: j.outputMode,
    result: j.result
      ? { documents: j.result.documents.map((d) => ({ id: toPublic("doc", d.docId), version: d.version })), files: j.result.files.map((f) => ({ name: f.name, type: f.type, size: f.size })) }
      : null,
    error: j.errorCode ? { code: j.errorCode, message: j.errorMessage ?? "" } : null,
    pages: j.pages,
    createdBy: j.createdBy,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}
