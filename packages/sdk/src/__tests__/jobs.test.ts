// The jobs client (PW4): URL shapes and polling until a job ends.
import { describe, expect, it, vi } from "vitest";
import { Pagewell } from "../index.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function client(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {});
  }) as unknown as typeof globalThis.fetch;
  return { pw: new Pagewell({ baseUrl: "https://api.example.com", auth: { kind: "bearer", token: "t" }, fetch }), calls };
}
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: { requestId: "r" } }), { status, headers: { "content-type": "application/json" } });
const base = `https://api.example.com/v1/organizations/${ORG}/jobs`;

describe("JobsClient", () => {
  it("starts, reads, lists, cancels and fetches a result file", async () => {
    const { pw, calls } = client((url) => (url.includes("/files/") ? new Response("png") : ok({ job: { id: "job_1", status: "queued" }, jobs: [] }, url.endsWith("/jobs") ? 202 : 200)));
    await pw.jobs.create(ORG, { operation: "ocr", documentIds: ["doc_1"], options: { force: true } });
    await pw.jobs.get(ORG, "job_1");
    await pw.jobs.list(ORG, { documentId: "doc_1" });
    await pw.jobs.cancel(ORG, "job_1");
    expect(await (await pw.jobs.file(ORG, "job_1", "page-1.png")).text()).toBe("png");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `POST ${base}`,
      `GET ${base}/job_1`,
      `GET ${base}?documentId=doc_1`,
      `POST ${base}/job_1/cancel`,
      `GET ${base}/job_1/files/page-1.png`,
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ operation: "ocr", documentIds: ["doc_1"], options: { force: true } });
  });

  it("waits until the job ends", async () => {
    const states = ["queued", "running", "succeeded"];
    const { pw, calls } = client(() => ok({ job: { id: "job_1", status: states.shift() } }));
    const job = await pw.jobs.wait(ORG, "job_1", { intervalMs: 1 });
    expect(job.status).toBe("succeeded");
    expect(calls).toHaveLength(3);
  });
});
