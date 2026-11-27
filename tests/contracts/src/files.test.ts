import { r2Key, orgPrefix, keyBelongsTo, R2KeyError } from "@saas/shared/r2-keys";
import { FILES_ERROR_CODES, BASE_VERSION_HEADER, TRASH_RETENTION_DAYS } from "@saas/contracts/files";
import * as contracts from "@saas/contracts";

// Tenancy is the security boundary: every R2 key starts org/<orgId>/ and is
// built by one helper that refuses anything that is not a canonical id.

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER = "bbbbbbbb-0000-4000-8000-00000000000b";
const DOC = "dddddddd-0000-4000-8000-00000000000d";
const UPL = "eeeeeeee-0000-4000-8000-00000000000e";
const SHA = "ab".repeat(32);

describe("r2Key", () => {
  it("builds every key under org/<orgId>/", () => {
    expect(r2Key.blob(ORG, DOC, SHA)).toBe(`org/${ORG}/doc/${DOC}/blob/${SHA}.pdf`);
    expect(r2Key.thumb(ORG, DOC, 2, 1)).toBe(`org/${ORG}/doc/${DOC}/thumb/2/1.webp`);
    expect(r2Key.text(ORG, DOC, 3)).toBe(`org/${ORG}/doc/${DOC}/text/3.json`);
    expect(r2Key.upload(ORG, UPL)).toBe(`org/${ORG}/tmp/${UPL}`);
    expect(r2Key.docPrefix(ORG, DOC)).toBe(`org/${ORG}/doc/${DOC}/`);
    expect(orgPrefix(ORG)).toBe(`org/${ORG}/`);
  });

  it.each([
    ["an empty org id", () => r2Key.blob("", DOC, SHA)],
    ["a path in the org id", () => r2Key.blob(`${ORG}/../${OTHER}`, DOC, SHA)],
    ["a public id where a uuid belongs", () => r2Key.blob("org_aaaaaaaa00004000800000000000000a", DOC, SHA)],
    ["an upper-case uuid", () => r2Key.upload(ORG.toUpperCase(), UPL)],
    ["a traversal in the document id", () => r2Key.text(ORG, "../x", 1)],
    ["a short sha256", () => r2Key.blob(ORG, DOC, "abc")],
    ["a slash in the sha256", () => r2Key.blob(ORG, DOC, `${"a".repeat(63)}/`)],
    ["version 0", () => r2Key.text(ORG, DOC, 0)],
    ["a fractional page", () => r2Key.thumb(ORG, DOC, 1, 1.5)],
  ])("refuses %s", (_what, build) => {
    expect(build).toThrow(R2KeyError);
  });

  it("tells whether a stored key belongs to an org", () => {
    const key = r2Key.blob(ORG, DOC, SHA);
    expect(keyBelongsTo(key, ORG)).toBe(true);
    expect(keyBelongsTo(key, OTHER)).toBe(false);
    expect(keyBelongsTo(`org/${ORG}/../${OTHER}/x`, ORG)).toBe(false);
    expect(keyBelongsTo(`org/${ORG}//x`, ORG)).toBe(false);
  });
});

describe("files contracts", () => {
  it("names the drive's error codes, header and retention", () => {
    expect(FILES_ERROR_CODES.VERSION_CONFLICT).toBe("version_conflict");
    expect(FILES_ERROR_CODES.QUOTA_EXCEEDED).toBe("quota_exceeded");
    expect(BASE_VERSION_HEADER).toBe("x-pagewell-base-version");
    expect(TRASH_RETENTION_DAYS).toBe(30);
  });

  it("is exported from the package root", () => {
    expect(contracts.FILES_ERROR_CODES).toBe(FILES_ERROR_CODES);
  });
});
