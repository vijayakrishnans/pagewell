import { hexToUuid, uuidToHex, type Uuid } from "@saas/db/ids";

export type IdKind = "org" | "doc" | "thr" | "cmt" | "rvr";

export function toPublic(kind: IdKind, uuid: string): string {
  return `${kind}_${uuidToHex(uuid)}`;
}

export function fromPublic(kind: IdKind, publicId: string | null | undefined): Uuid | null {
  if (typeof publicId !== "string" || !publicId.startsWith(`${kind}_`)) return null;
  const hex = publicId.slice(kind.length + 1);
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return hexToUuid(hex) as Uuid | null;
}

export function newUuid(): Uuid {
  return crypto.randomUUID() as Uuid;
}

let lastMs = -1;
let seq = 0;
/**
 * A time-ordered id (UUIDv7, with a counter inside the millisecond) for threads and comments:
 * they are listed by (created_at, id), so two written in the same millisecond keep their order.
 */
export function orderedUuid(at: Date = new Date()): Uuid {
  const ms = at.getTime();
  if (ms === lastMs) seq = (seq + 1) & 0xfff;
  else {
    lastMs = ms;
    seq = 0;
  }
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
  const time = hex(ms, 12);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${hex(seq, 3)}-${hex(0x8000 | (((rand[0]! << 8) | rand[1]!) & 0x3fff), 4)}-${[...rand.slice(2)].map((b) => hex(b, 2)).join("")}` as Uuid;
}

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return `req_${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
