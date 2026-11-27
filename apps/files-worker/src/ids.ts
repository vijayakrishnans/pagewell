import { hexToUuid, uuidToHex, type Uuid } from "@saas/db/ids";

// Public ids are <prefix>_<32 hex>; the database stores the bare UUID.

export type IdKind = "org" | "fld" | "doc" | "upl" | "usr" | "sp";

export function toPublic(kind: IdKind, uuid: string): string {
  return `${kind}_${uuidToHex(uuid)}`;
}

/** The UUID behind `<kind>_<32 hex>`, or null for anything else. Lower-case only. */
export function fromPublic(kind: IdKind, publicId: string | null | undefined): Uuid | null {
  if (typeof publicId !== "string" || !publicId.startsWith(`${kind}_`)) return null;
  const hex = publicId.slice(kind.length + 1);
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return hexToUuid(hex) as Uuid | null;
}

export function newUuid(): Uuid {
  return crypto.randomUUID() as Uuid;
}

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return `req_${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
