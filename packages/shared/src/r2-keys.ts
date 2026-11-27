// THE R2 key builder for Pagewell's bucket (pagewell-files-<env>). Tenancy is
// the security boundary: every key starts org/<orgId>/, and this module is the
// only place a key is put together (a lint rule in the files worker forbids
// building one anywhere else). Ids are checked, so nothing a caller passes can
// climb out of its org's prefix.
//
//   org/<orgId>/doc/<docId>/blob/<blobId>.pdf          a version's bytes (one fresh id per write)
//   org/<orgId>/doc/<docId>/thumb/<version>/<page>.webp
//   org/<orgId>/doc/<docId>/text/<version>.json
//   org/<orgId>/tmp/<uploadId>                          an in-flight multipart upload
//
// Version bytes get a fresh id per write, not their version number: two
// writers racing on the same baseVersion then never overwrite each other's
// object, and a restore points the new version at the old object. (Not the
// sha256 either: the key is needed before the bytes have streamed through.)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class R2KeyError extends Error {
  constructor(what: string) {
    super(`r2 key: invalid ${what}`);
    this.name = "R2KeyError";
  }
}

function uuid(value: string, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new R2KeyError(what);
  return value;
}

function positive(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new R2KeyError(what);
  return value;
}

/** org/<orgId>/ — the prefix every key of this org starts with. */
export function orgPrefix(orgId: string): string {
  return `org/${uuid(orgId, "org id")}/`;
}

export const r2Key = {
  blob(orgId: string, docId: string, blobId: string): string {
    return `${orgPrefix(orgId)}doc/${uuid(docId, "document id")}/blob/${uuid(blobId, "blob id")}.pdf`;
  },
  thumb(orgId: string, docId: string, version: number, page: number): string {
    return `${orgPrefix(orgId)}doc/${uuid(docId, "document id")}/thumb/${positive(version, "version")}/${positive(page, "page")}.webp`;
  },
  text(orgId: string, docId: string, version: number): string {
    return `${orgPrefix(orgId)}doc/${uuid(docId, "document id")}/text/${positive(version, "version")}.json`;
  },
  upload(orgId: string, uploadId: string): string {
    return `${orgPrefix(orgId)}tmp/${uuid(uploadId, "upload id")}`;
  },
  /** Every key under one document (for listing or purging its derived files). */
  docPrefix(orgId: string, docId: string): string {
    return `${orgPrefix(orgId)}doc/${uuid(docId, "document id")}/`;
  },
};

/** True when `key` belongs to `orgId`: the check a reader makes before serving a stored key. */
export function keyBelongsTo(key: string, orgId: string): boolean {
  return typeof key === "string" && key.startsWith(orgPrefix(orgId)) && !key.includes("..") && !key.includes("//");
}
