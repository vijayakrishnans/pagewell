import { isEnvelopeRoute, isSigningRoute, handleSigningRoute } from "@api-edge/sign-facade";

// Pagewell's e-sign facade (PW6): which paths go to sign-worker, and the signer's routes passed
// down with only what the signing page needs: never a cookie or a bearer token.
const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENV = "env_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TOKEN = "T".repeat(43);

describe("api-edge sign facade", () => {
  it.each([`/v1/organizations/${ORG}/envelopes`, `/v1/organizations/${ORG}/envelopes/${ENV}`, `/v1/organizations/${ORG}/envelopes/${ENV}/send`, `/v1/organizations/${ORG}/envelopes/${ENV}/evidence`])("routes %s to the sender's side", (p) => {
    expect(isEnvelopeRoute(p)).toBe(true);
  });
  it("routes the signer's paths and nothing else", () => {
    for (const p of [`/v1/s/${TOKEN}`, `/v1/s/${TOKEN}/code`, `/v1/s/${TOKEN}/verify`, `/v1/s/${TOKEN}/submit`, `/v1/s/${TOKEN}/decline`, `/v1/s/${TOKEN}/documents/doc_${"d".repeat(32)}`]) expect(isSigningRoute(p)).toBe(true);
    for (const p of [`/v1/s/short`, `/v1/s/${TOKEN}/admin`, `/v1/s/${TOKEN}/documents/../x`, `/v1/organizations/${ORG}/envelopes/${ENV}/delete`]) expect(isSigningRoute(p) || isEnvelopeRoute(p)).toBe(false);
  });

  it("passes the signer's request down without cookies or tokens, with the IP and user agent", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sign = { fetch: async (url: string, init: RequestInit) => (calls.push({ url, init }), Response.json({ data: {} })) } as unknown as Fetcher;
    const path = `/v1/s/${TOKEN}/verify`;
    await handleSigningRoute(
      new Request(`https://api.example.com${path}?x=1`, { method: "POST", headers: { "content-type": "application/json", cookie: "s=1", authorization: "Bearer sps_ses_x.y", "cf-connecting-ip": "203.0.113.5", "user-agent": "ua" }, body: JSON.stringify({ code: "123456" }) }),
      { SIGN_WORKER: sign, ENVIRONMENT: "test" },
      "req",
      path,
    );
    expect(calls[0]!.url).toBe(`https://sign.internal${path}`);
    const h = new Headers(calls[0]!.init.headers as HeadersInit);
    expect([h.get("cookie"), h.get("authorization"), h.get("cf-connecting-ip"), h.get("user-agent"), h.get("x-actor-subject-id")]).toEqual([null, null, "203.0.113.5", "ua", null]);
    const big = await handleSigningRoute(new Request(`https://api.example.com${path}`, { method: "POST", headers: { "content-length": String(3 * 1024 * 1024) }, body: "x" }), { SIGN_WORKER: sign, ENVIRONMENT: "test" }, "req", path);
    expect(big.status).toBe(413);
  });
});
