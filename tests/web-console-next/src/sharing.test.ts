import type { PublicGrant, PublicLink } from "@saas/contracts/sharing";
import { expiresAt, grantSubject, inheritedNote, isSharedPath, linkSummary, principalFrom, roleLabel, shareLinkUrl, sortGrants } from "../../../apps/web-console-next/src/lib/sharing";

// The share dialog's and Shared with me's pure helpers (PW3).

const grant = (over: Partial<PublicGrant>): PublicGrant => ({
  id: "grt_1",
  resource: { kind: "document", id: "doc_1" },
  principal: { kind: "guest", guestId: "gst_1", email: "guest@example.com", name: null, verified: false },
  role: "viewer",
  inheritedFrom: null,
  createdBy: "usr_x",
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

describe("sharing helpers", () => {
  it("reads the Add people box as a member id, an email, or nothing", () => {
    expect(principalFrom(" usr_0123456789abcdef0123456789abcdef ")).toEqual({ userId: "usr_0123456789abcdef0123456789abcdef" });
    expect(principalFrom("Guest@Example.com")).toEqual({ email: "guest@example.com" });
    expect(principalFrom("not an email")).toBeNull();
    expect(principalFrom("usr_short")).toBeNull();
    expect(principalFrom("")).toBeNull();
  });

  it("labels roles for people and links", () => {
    expect([roleLabel("viewer"), roleLabel("commenter"), roleLabel("editor")]).toEqual(["Can view", "Can comment", "Can edit"]);
  });

  it("names who a grant is for, and whether a guest has opened it", () => {
    expect(grantSubject(grant({}))).toEqual({ primary: "guest@example.com", secondary: "Guest · hasn't opened it yet" });
    expect(grantSubject(grant({ principal: { kind: "guest", guestId: "gst_1", email: "g@example.com", name: "Gita", verified: true } }))).toEqual({ primary: "Gita", secondary: "g@example.com · Guest" });
    expect(grantSubject(grant({ principal: { kind: "member", userId: "usr_1" } }))).toEqual({ primary: "usr_1", secondary: "Member" });
  });

  it("lists a resource's own grants before inherited ones", () => {
    const own = grant({ id: "own", createdAt: "2026-11-03T00:00:00.000Z" });
    const inherited = grant({ id: "inh", inheritedFrom: { folderId: "fld_1", name: "Projects" }, createdAt: "2026-11-01T00:00:00.000Z" });
    expect(sortGrants([inherited, own]).map((g) => g.id)).toEqual(["own", "inh"]);
    expect(inheritedNote(inherited)).toBe("From Projects");
    expect(inheritedNote(own)).toBeNull();
  });

  it("turns an expiry choice into a time, and a token into the editor's viewer URL", () => {
    const now = new Date("2026-11-01T00:00:00.000Z");
    expect(expiresAt("never", now)).toBeNull();
    expect(expiresAt("7d", now)).toBe("2026-11-08T00:00:00.000Z");
    expect(shareLinkUrl("https://pagewell-editor-web-stage.example.workers.dev", "abc_DEF-123")).toBe("https://pagewell-editor-web-stage.example.workers.dev/l/abc_DEF-123");
  });

  it("sums a link up", () => {
    const link: PublicLink = { id: "lnk_1", resource: { kind: "document", id: "doc_1" }, role: "commenter", hasPassword: true, expiresAt: "2026-10-01T00:00:00.000Z", allowDownload: false, createdBy: "usr_x", createdAt: "2026-09-01T00:00:00.000Z" };
    expect(linkSummary(link, new Date("2026-11-01T00:00:00.000Z"))).toBe("Can comment · password · no download · expired");
  });

  it("knows which pages a guest with no organization may open", () => {
    expect(isSharedPath("/shared")).toBe(true);
    expect(isSharedPath("/shared/org_1/fld_1")).toBe(true);
    expect(isSharedPath("/sharedx")).toBe(false);
    expect(isSharedPath("/orgs/acme/drive")).toBe(false);
    expect(isSharedPath(null)).toBe(false);
  });
});
