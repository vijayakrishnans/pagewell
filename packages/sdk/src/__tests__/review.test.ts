// The review client (PW5): URL shapes and bodies.
import { describe, expect, it, vi } from "vitest";
import { Pagewell } from "../index.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DOC = "doc_dddddddddddddddddddddddddddddddd";

function client() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ data: { threads: [], thread: {}, comment: {}, requests: [], request: {}, ticket: "t" }, meta: { requestId: "r" } }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { pw: new Pagewell({ baseUrl: "https://api.example.com", auth: { kind: "bearer", token: "t" }, fetch }), calls };
}

describe("ReviewClient", () => {
  it("threads, comments, requests and room tickets go where they should", async () => {
    const { pw, calls } = client();
    const anchor = { page: 2, rect: [1, 2, 3, 4] as [number, number, number, number], quote: null };
    await pw.review.listThreads(ORG, DOC);
    await pw.review.startThread(ORG, DOC, { anchor, body: "Look" });
    await pw.review.reply(ORG, "thr_1", "Yes");
    await pw.review.setStatus(ORG, "thr_1", "resolved");
    await pw.review.editComment(ORG, "thr_1", "cmt_1", "Fixed");
    await pw.review.deleteComment(ORG, "thr_1", "cmt_1");
    await pw.review.requestReview(ORG, DOC, { reviewers: ["b@example.com"], dueAt: null });
    await pw.review.decide(ORG, "rvr_1", "approved");
    await pw.review.cancelRequest(ORG, "rvr_1");
    await pw.review.roomTicket(ORG, DOC);
    const base = `https://api.example.com/v1/organizations/${ORG}`;
    expect(calls.map((c) => `${c.init.method} ${c.url.replace(base, "")}`)).toEqual([
      `GET /documents/${DOC}/threads`,
      `POST /documents/${DOC}/threads`,
      "POST /threads/thr_1/comments",
      "PATCH /threads/thr_1",
      "PATCH /threads/thr_1/comments/cmt_1",
      "DELETE /threads/thr_1/comments/cmt_1",
      `POST /documents/${DOC}/review-requests`,
      "POST /review-requests/rvr_1/decision",
      "DELETE /review-requests/rvr_1",
      `POST /documents/${DOC}/room/ticket`,
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ anchor, body: "Look" });
    expect(JSON.parse(String(calls[7]!.init.body))).toEqual({ decision: "approved" });
  });
});
