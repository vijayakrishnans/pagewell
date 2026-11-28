// sign-worker over the REAL files-worker (one SQLite engine with every migration, one in-memory
// R2, the real policy engine). pdf-jobs-worker's internal route is a fake that records what it
// was sent and answers like the runner (a stand-in "signed" PDF), or 503 when `runnerDown`.
import { route as filesRoute } from "@files-worker/router";
import { route as signRoute } from "@sign-worker/router";
import { housekeeping } from "@sign-worker/cron";
import type { Env as SignEnv } from "@sign-worker/env";
import { forwardSignComplete } from "../../../apps/pdf-jobs-worker/src/runner.js";
import { fixturePdf, world as filesWorld, type World as FilesWorld } from "../../files-worker/src/harness.js";

export { fixturePdf };

export interface RunnerCall {
  header: { operation: string; options: Record<string, any>; inputs: number[]; images: number[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  inputs: Uint8Array[];
  images: Uint8Array[];
}

export interface SignWorld {
  files: FilesWorld;
  env: SignEnv;
  runnerDown: boolean;
  runnerCalls: RunnerCall[];
  /** The sealed PDF from a real runner (RUNNER_URL), for the validators. */
  realSealed?: Uint8Array;
  /** Move both clocks (the drive's and sign-worker's). */
  advance(ms: number): void;
  request(method: string, path: string, init?: { user?: string; email?: string; json?: unknown }): Promise<Response>;
  /** A signer's request: no account, the link token in the path. */
  signer(method: string, token: string, rest?: string, json?: unknown, headers?: Record<string, string>): Promise<Response>;
  housekeeping(): ReturnType<typeof housekeeping>;
}

export function signWorld(): SignWorld {
  const files = filesWorld();
  const w: SignWorld = {
    files,
    runnerDown: false,
    runnerCalls: [],
    env: undefined as unknown as SignEnv,
    advance(ms) {
      files.now = new Date(files.now.getTime() + ms);
    },
    async request(method, path, init = {}) {
      const headers: Record<string, string> = {};
      if (init.user) {
        headers["x-actor-subject-id"] = init.user;
        headers["x-actor-subject-type"] = "user";
        if (init.email) headers["x-actor-email"] = init.email;
      }
      let body: string | null = null;
      if (init.json !== undefined) {
        body = JSON.stringify(init.json);
        headers["content-type"] = "application/json";
      }
      return signRoute(new Request(`http://sign${path}`, { method, headers, body }), w.env, files.now);
    },
    async signer(method, token, rest = "", json, headers = {}) {
      const h: Record<string, string> = { "cf-connecting-ip": "203.0.113.9", "user-agent": "sign-tests", ...headers };
      let body: string | null = null;
      if (json !== undefined) {
        body = JSON.stringify(json);
        h["content-type"] = "application/json";
      }
      return signRoute(new Request(`http://sign/v1/s/${token}${rest}`, { method, headers: h, body }), w.env, files.now);
    },
    housekeeping: () => housekeeping(w.env, files.now),
  };
  const jobs = {
    async fetch(input: string | Request, init?: RequestInit) {
      const req = input instanceof Request ? input : new Request(input, init);
      if (w.runnerDown) return Response.json({ error: { code: "runner_unavailable" } }, { status: 503 });
      // With RUNNER_URL (a local pdf-runner with a test signing ID), the real thing, through
      // pdf-jobs-worker's own forwarding.
      if (process.env.RUNNER_URL) {
        const res = await forwardSignComplete({ ENVIRONMENT: "test", RUNNER_URL: process.env.RUNNER_URL } as never, req.clone());
        if (res.ok) w.realSealed = new Uint8Array(await res.clone().arrayBuffer()).slice(0, (JSON.parse(res.headers.get("x-pagewell-outputs")!) as Array<{ size: number }>)[0]!.size);
        return res;
      }
      const header = JSON.parse(req.headers.get("x-pagewell-run") ?? "{}") as RunnerCall["header"];
      const body = new Uint8Array(await req.arrayBuffer());
      let at = 0;
      const take = (n: number) => body.slice(at, (at += n));
      const call: RunnerCall = { header, inputs: header.inputs.map(take), images: (header.images ?? []).map(take) };
      w.runnerCalls.push(call);
      // A stand-in for the sealed PDF: the first input with a marker; the real one is tested on the runner image.
      const pdf = new Uint8Array([...call.inputs[0]!, ...new TextEncoder().encode("\n%pagewell-test-sealed\n")]);
      const report = new TextEncoder().encode(JSON.stringify({ count: 1, signatures: [{ signed: true, modification: "none", sub_filter: "ETSI.CAdES.detached" }] }));
      return new Response(new Uint8Array([...pdf, ...report]), {
        headers: { "x-pagewell-outputs": JSON.stringify([{ name: "result.pdf", type: "application/pdf", size: pdf.length }, { name: "signature.json", type: "application/json", size: report.length }]), "x-pagewell-pages": "3" },
      });
    },
  };
  w.env = {
    ENVIRONMENT: "test",
    DEBUG_DELIVERY: "true",
    SIGN_URL: "https://editor.example.com",
    PLATFORM_DB: files.env.PLATFORM_DB!,
    FILES_BUCKET: files.env.FILES_BUCKET!,
    NOTIFICATIONS_WORKER: files.env.NOTIFICATIONS_WORKER!,
    FILES_WORKER: { fetch: (input: string | Request, init?: RequestInit) => filesRoute(input instanceof Request ? input : new Request(input, init), files.env, files.now) } as unknown as Fetcher,
    JOBS_WORKER: jobs as unknown as Fetcher,
  };
  return w;
}
