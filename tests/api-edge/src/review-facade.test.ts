import { isReviewRoute, isRoomRoute, handleRoomRoute } from "@api-edge/review-facade";
import { isFilesRoute } from "@api-edge/files-facade";

// Pagewell's review facade (PW5): which paths go to review-worker (before the files facade, which
// shares the /documents prefix), and the DocRoom WebSocket passed through with only what a
// WebSocket needs: never a cookie or a bearer token.
const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DOC = "doc_dddddddddddddddddddddddddddddddd";

describe("api-edge review facade", () => {
  it.each([`/v1/organizations/${ORG}/documents/${DOC}/threads`, `/v1/organizations/${ORG}/documents/${DOC}/review-requests`, `/v1/organizations/${ORG}/documents/${DOC}/room/ticket`, `/v1/organizations/${ORG}/threads/thr_1`, `/v1/organizations/${ORG}/threads/thr_1/comments`, `/v1/organizations/${ORG}/threads/thr_1/comments/cmt_1`, `/v1/organizations/${ORG}/review-requests/rvr_1`, `/v1/organizations/${ORG}/review-requests/rvr_1/decision`])("routes %s to review", (p) => {
    expect(isReviewRoute(p)).toBe(true);
  });
  it("leaves the drive's own document routes to the files facade", () => {
    expect(isReviewRoute(`/v1/organizations/${ORG}/documents/${DOC}/content`)).toBe(false);
    expect(isFilesRoute(`/v1/organizations/${ORG}/documents/${DOC}/content`)).toBe(true);
    expect(isRoomRoute(`/v1/organizations/${ORG}/documents/${DOC}/room`)).toBe(true);
    expect(isRoomRoute(`/v1/organizations/${ORG}/documents/${DOC}/room/ticket`)).toBe(false);
  });

  it("passes the room's upgrade through with the ticket and the WebSocket headers only", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const review = { fetch: async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("ok")) } as unknown as Fetcher;
    const path = `/v1/organizations/${ORG}/documents/${DOC}/room`;
    const ticket = "T".repeat(43);
    await handleRoomRoute(
      new Request(`https://api.example.com${path}?ticket=${ticket}`, { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "k", "sec-websocket-version": "13", cookie: "s=1", authorization: "Bearer sps_ses_x.y" } }),
      { REVIEW_WORKER: review, ENVIRONMENT: "test" },
      "req",
      path,
    );
    expect(calls[0]!.url).toBe(`https://review.internal${path}?ticket=${ticket}`);
    const h = new Headers(calls[0]!.init.headers as HeadersInit);
    expect([h.get("upgrade"), h.get("sec-websocket-key"), h.get("cookie"), h.get("authorization")]).toEqual(["websocket", "k", null, null]);
    const noUpgrade = await handleRoomRoute(new Request(`https://api.example.com${path}?ticket=${ticket}`), { REVIEW_WORKER: review, ENVIRONMENT: "test" }, "req", path);
    expect(noUpgrade.status).toBe(426);
    const badTicket = await handleRoomRoute(new Request(`https://api.example.com${path}?ticket=../x`, { headers: { upgrade: "websocket" } }), { REVIEW_WORKER: review, ENVIRONMENT: "test" }, "req", path);
    expect(badTicket.status).toBe(404);
  });
});
