import { isFilesRoute, handleFilesRoute } from "@api-edge/files-facade";
import { isAllowedOrigin } from "@api-edge/cors";
import { isSoloSuppressed } from "@api-edge/solo-mode";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({ data: {}, meta: { requestId: "req_test", cursor: null } }),
): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(response.clone());
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createThrowingFetcher(): Fetcher {
  return {
    fetch(): Promise<Response> {
      return Promise.reject(new Error("network error"));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createSessionFetcher(userId: string): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      if (url.includes("/v1/auth/resolve")) {
        return Promise.resolve(
          Response.json({
            data: { actor: { actorType: "user", actorId: userId, email: "user@test.com" }, session: { id: "ses_abc", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" }, user: { id: userId, email: "user@test.com", displayName: "Test" } },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: {}, meta: { requestId: "req_test", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

// Pagewell's drive facade (PW-12): /v1/organizations/{org}/folders|documents|
// uploads|trash|quota → FILES_WORKER, with the actor resolved at the edge and
// bodies streamed both ways.

const ORG = "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const env = (files: Fetcher, identity: Fetcher) => ({ IDENTITY_WORKER: identity, FILES_WORKER: files, ENVIRONMENT: "test" });

describe("api-edge files facade", () => {
  it.each([
    `/v1/organizations/${ORG}/folders`,
    `/v1/organizations/${ORG}/folders/fld_1`,
    `/v1/organizations/${ORG}/documents`,
    `/v1/organizations/${ORG}/documents/doc_1/versions/2/restore`,
    `/v1/organizations/${ORG}/documents/doc_1/content`,
    `/v1/organizations/${ORG}/uploads/upl_1/parts/3`,
    `/v1/organizations/${ORG}/trash`,
    `/v1/organizations/${ORG}/quota`,
  ])("routes %s to the drive", (path) => {
    expect(isFilesRoute(path)).toBe(true);
  });

  it.each([`/v1/organizations/${ORG}`, `/v1/organizations/${ORG}/projects`, `/v1/organizations/${ORG}/members`, "/v1/auth/resolve", `/v1/organizations/${ORG}/documentsx`])(
    "leaves %s alone",
    (path) => {
      expect(isFilesRoute(path)).toBe(false);
    },
  );

  it("is not hidden by the Solo profile", () => {
    expect(isSoloSuppressed(`/v1/organizations/${ORG}/documents`, "GET")).toBe(false);
  });

  it("streams an upload to FILES_WORKER with the actor and the drive's headers, never the bearer token", async () => {
    const { fetcher: identity } = createSessionFetcher("usr_abc123");
    const { fetcher: files, calls } = createFakeFetcher(Response.json({ data: { document: { id: "doc_1" } } }, { status: 201 }));
    const pdf = new TextEncoder().encode("%PDF-1.7 generated");
    const path = `/v1/organizations/${ORG}/documents/doc_1/versions`;
    const res = await handleFilesRoute(
      new Request(`https://api.example.com${path}?x=1`, {
        method: "POST",
        headers: {
          authorization: "Bearer sps_ses_secret.token",
          "content-type": "application/pdf",
          "x-pagewell-base-version": "3",
          "x-pagewell-page-count": "2",
          "x-not-forwarded": "1",
        },
        body: pdf,
      }),
      env(files, identity),
      "req_test",
      path,
    );
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://files.internal${path}?x=1`);
    const forwarded = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(forwarded.get("x-actor-subject-id")).toBe("usr_abc123");
    expect(forwarded.get("x-pagewell-base-version")).toBe("3");
    expect(forwarded.get("x-pagewell-page-count")).toBe("2");
    expect(forwarded.get("content-type")).toBe("application/pdf");
    expect(forwarded.get("authorization")).toBeNull();
    expect(forwarded.get("x-not-forwarded")).toBeNull();
    expect(new Uint8Array(await new Response(calls[0]!.init.body as BodyInit).arrayBuffer())).toEqual(pdf);
  });

  it("passes a content response through untouched, headers included", async () => {
    const { fetcher: identity } = createSessionFetcher("usr_abc123");
    const pdf = new TextEncoder().encode("%PDF-1.7 generated");
    const { fetcher: files, calls } = createFakeFetcher(
      new Response(pdf, { status: 200, headers: { "content-type": "application/pdf", etag: '"abc"', "x-pagewell-version": "2" } }),
    );
    const path = `/v1/organizations/${ORG}/documents/doc_1/content`;
    const res = await handleFilesRoute(
      new Request(`https://api.example.com${path}`, { headers: { authorization: "Bearer sps_ses_abc.secret", "if-none-match": '"old"' } }),
      env(files, identity),
      "req_test",
      path,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-pagewell-version")).toBe("2");
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf);
    expect(new Headers(calls[0]!.init.headers as HeadersInit).get("if-none-match")).toBe('"old"');
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("refuses an unknown method and answers 503 when the drive is not bound", async () => {
    const { fetcher: identity } = createSessionFetcher("usr_abc123");
    const path = `/v1/organizations/${ORG}/folders`;
    const odd = await handleFilesRoute(new Request(`https://api.example.com${path}`, { method: "OPTIONS" }), env(createThrowingFetcher(), identity), "req", path);
    expect(odd.status).toBe(405);
    const unbound = await handleFilesRoute(
      new Request(`https://api.example.com${path}`, { headers: { authorization: "Bearer sps_ses_abc.secret" } }),
      { IDENTITY_WORKER: identity, ENVIRONMENT: "test" },
      "req",
      path,
    );
    expect(unbound.status).toBe(503);
    const down = await handleFilesRoute(
      new Request(`https://api.example.com${path}`, { headers: { authorization: "Bearer sps_ses_abc.secret" } }),
      env(createThrowingFetcher(), identity),
      "req",
      path,
    );
    expect(down.status).toBe(503);
  });

  it("lets Pagewell's editor origin call the API on stage and prod, and no other editor's", () => {
    const stage = { ENVIRONMENT: "stage" } as never;
    expect(isAllowedOrigin("https://pagewell-editor-web-stage.vijayakrishnan12994.workers.dev", stage)).toBe(true);
    expect(isAllowedOrigin("https://pagewell-editor-web-prod.vijayakrishnan12994.workers.dev", stage)).toBe(false);
    expect(isAllowedOrigin("https://pagewell-editor-web-stage.evil.workers.dev", stage)).toBe(false);
  });
});
