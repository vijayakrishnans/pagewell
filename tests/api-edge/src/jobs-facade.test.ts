import { isJobsRoute, handleJobsRoute } from "@api-edge/jobs-facade";

// Pagewell's heavy jobs facade (PW4): /v1/organizations/{org}/jobs → JOBS_WORKER, signed in,
// with the actor and verified email passed down and nothing else.

const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fetcherWith(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = {
    fetch(input: string, init?: RequestInit) {
      calls.push({ url: input, init: init ?? {} });
      return Promise.resolve(respond(input, init ?? {}));
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}
const identity = fetcherWith(() =>
  Response.json({
    data: { actor: { actorType: "user", actorId: "usr_abc", email: "user@test.com" }, session: { id: "ses_1", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" }, user: { id: "usr_abc", email: "user@test.com", displayName: "T" } },
  }),
).fetcher;

describe("api-edge jobs facade", () => {
  it.each([`/v1/organizations/${ORG}/jobs`, `/v1/organizations/${ORG}/jobs/job_1`, `/v1/organizations/${ORG}/jobs/job_1/cancel`, `/v1/organizations/${ORG}/jobs/job_1/files/page-1.png`])("routes %s", (p) => {
    expect(isJobsRoute(p)).toBe(true);
  });
  it.each([`/v1/organizations/${ORG}/jobsx`, `/v1/organizations/${ORG}/documents`, "/v1/jobs"])("leaves %s alone", (p) => {
    expect(isJobsRoute(p)).toBe(false);
  });

  it("forwards a job with the actor and email, never the bearer token", async () => {
    const { fetcher, calls } = fetcherWith(() => Response.json({ data: { job: { id: "job_1" } } }, { status: 202 }));
    const path = `/v1/organizations/${ORG}/jobs`;
    const res = await handleJobsRoute(
      new Request(`https://api.example.com${path}`, { method: "POST", headers: { authorization: "Bearer sps_ses_secret.x", "content-type": "application/json" }, body: JSON.stringify({ operation: "ocr" }) }),
      { IDENTITY_WORKER: identity, JOBS_WORKER: fetcher, ENVIRONMENT: "test" },
      "req",
      path,
    );
    expect(res.status).toBe(202);
    const h = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(calls[0]!.url).toBe(`https://jobs.internal${path}`);
    expect([h.get("x-actor-subject-id"), h.get("x-actor-email"), h.get("authorization")]).toEqual(["usr_abc", "user@test.com", null]);
  });

  it("refuses other methods and answers 503 when jobs are not bound", async () => {
    const path = `/v1/organizations/${ORG}/jobs`;
    expect((await handleJobsRoute(new Request(`https://api.example.com${path}`, { method: "DELETE" }), { ENVIRONMENT: "test" }, "req", path)).status).toBe(405);
    const res = await handleJobsRoute(new Request(`https://api.example.com${path}`, { headers: { authorization: "Bearer sps_ses_x.y" } }), { IDENTITY_WORKER: identity, ENVIRONMENT: "test" }, "req", path);
    expect(res.status).toBe(503);
  });
});
