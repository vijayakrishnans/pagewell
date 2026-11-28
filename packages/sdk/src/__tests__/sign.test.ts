// The sign client (PW6): URL shapes and bodies, for the sender and the signer.
import { describe, expect, it, vi } from "vitest";
import { Pagewell } from "../index.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENV = "env_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TOKEN = "t".repeat(43);

describe("SignClient", () => {
  it("envelopes and signing links go where they should", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ data: {}, meta: { requestId: "r" } }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const pw = new Pagewell({ baseUrl: "https://api.example.com", auth: { kind: "bearer", token: "t" }, fetch });
    const input = { title: "T", documents: [{ documentId: "doc_x" }], signers: [{ key: "a", name: "Ann", email: "ann@example.com" }], fields: [] };
    await pw.sign.listEnvelopes(ORG);
    await pw.sign.createEnvelope(ORG, input);
    await pw.sign.getEnvelope(ORG, ENV);
    await pw.sign.updateEnvelope(ORG, ENV, input);
    await pw.sign.send(ORG, ENV);
    await pw.sign.resend(ORG, ENV);
    await pw.sign.void(ORG, ENV, "Mistake");
    await pw.sign.evidence(ORG, ENV);
    await pw.sign.signingSession(TOKEN);
    await pw.sign.sendCode(TOKEN);
    await pw.sign.verifyCode(TOKEN, "123456");
    await pw.sign.submit(TOKEN, [{ fieldId: "fdl_1", text: "Ann" }]);
    await pw.sign.decline(TOKEN, "No");
    const api = "https://api.example.com";
    expect(calls.map((c) => `${c.init.method} ${c.url.replace(api, "")}`)).toEqual([
      `GET /v1/organizations/${ORG}/envelopes`,
      `POST /v1/organizations/${ORG}/envelopes`,
      `GET /v1/organizations/${ORG}/envelopes/${ENV}`,
      `PATCH /v1/organizations/${ORG}/envelopes/${ENV}`,
      `POST /v1/organizations/${ORG}/envelopes/${ENV}/send`,
      `POST /v1/organizations/${ORG}/envelopes/${ENV}/resend`,
      `POST /v1/organizations/${ORG}/envelopes/${ENV}/void`,
      `GET /v1/organizations/${ORG}/envelopes/${ENV}/evidence`,
      `GET /v1/s/${TOKEN}`,
      `POST /v1/s/${TOKEN}/code`,
      `POST /v1/s/${TOKEN}/verify`,
      `POST /v1/s/${TOKEN}/submit`,
      `POST /v1/s/${TOKEN}/decline`,
    ]);
    expect(JSON.parse(String(calls[11]!.init.body))).toEqual({ consent: true, values: [{ fieldId: "fdl_1", text: "Ann" }] });
  });
});
