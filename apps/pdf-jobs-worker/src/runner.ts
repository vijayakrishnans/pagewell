import type { Env } from "./env.js";

// The pdf-runner container's one route, POST /run: the inputs go in the body, the outputs come
// back in the response (containers/pdf-runner/server.mjs). Reached through the Containers
// binding once it exists (WAITING W4), or over HTTP at RUNNER_URL for local and test runs.

export interface RunnerOutput {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export class RunnerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Worth another attempt: the runner was unreachable or failed, not the job's own fault. */
    readonly transient: boolean,
  ) {
    super(message);
  }
}

export interface Runner {
  run(job: { operation: string; options: Record<string, unknown>; limits: Record<string, number> }, inputs: Uint8Array[]): Promise<{ outputs: RunnerOutput[]; pages: number | null }>;
}

export function runnerAvailable(env: Env): boolean {
  return Boolean(env.PDF_RUNNER || env.RUNNER_URL);
}

function target(env: Env): ((request: Request) => Promise<Response>) | null {
  if (env.PDF_RUNNER) {
    // One container instance per job keeps jobs apart; the Container class sleeps it after use.
    const ns = env.PDF_RUNNER;
    return (request) => ns.get(ns.newUniqueId()).fetch(request);
  }
  if (env.RUNNER_URL && /^https?:\/\/[^\s]+$/.test(env.RUNNER_URL)) return (request) => fetch(request);
  return null;
}

export function runnerFor(env: Env): Runner | null {
  const send = target(env);
  if (!send) return null;
  const base = env.PDF_RUNNER ? "http://pdf-runner" : env.RUNNER_URL!.replace(/\/$/, "");
  return {
    async run(job, inputs) {
      const total = inputs.reduce((n, b) => n + b.byteLength, 0);
      const body = new Uint8Array(total);
      let at = 0;
      for (const b of inputs) {
        body.set(b, at);
        at += b.byteLength;
      }
      let res: Response;
      try {
        res = await send(
          new Request(`${base}/run`, {
            method: "POST",
            headers: { "x-pagewell-run": JSON.stringify({ ...job, inputs: inputs.map((b) => b.byteLength) }), "content-length": String(total) },
            body,
          }),
        );
      } catch {
        throw new RunnerError(503, "runner_unavailable", "The PDF runner could not be reached", true);
      }
      if (!res.ok) {
        let code = "runner_failed";
        let message = `The PDF runner answered ${res.status}`;
        try {
          const b = (await res.json()) as { error?: { code?: string; message?: string } };
          code = b.error?.code ?? code;
          message = b.error?.message ?? message;
        } catch {
          /* not JSON */
        }
        throw new RunnerError(res.status, code, message, res.status >= 500);
      }
      const manifest = JSON.parse(res.headers.get("x-pagewell-outputs") ?? "[]") as Array<{ name: string; type: string; size: number }>;
      const bytes = new Uint8Array(await res.arrayBuffer());
      let offset = 0;
      const outputs = manifest.map((o) => {
        const slice = bytes.subarray(offset, offset + o.size);
        offset += o.size;
        return { name: o.name, type: o.type, bytes: slice };
      });
      if (offset !== bytes.byteLength) throw new RunnerError(502, "runner_failed", "The runner's outputs did not add up", true);
      const pages = Number(res.headers.get("x-pagewell-pages"));
      return { outputs, pages: Number.isFinite(pages) && pages > 0 ? pages : null };
    },
  };
}
