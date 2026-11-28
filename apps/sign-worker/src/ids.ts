import { hexToUuid, uuidToHex, type Uuid } from "@saas/db/ids";

export type IdKind = "org" | "doc" | "env" | "sgn" | "fdl" | "usr";

export function toPublic(kind: IdKind, uuid: string): string {
  return `${kind}_${uuidToHex(uuid)}`;
}

export function fromPublic(kind: IdKind, publicId: string | null | undefined): Uuid | null {
  if (typeof publicId !== "string" || !publicId.startsWith(`${kind}_`)) return null;
  const hex = publicId.slice(kind.length + 1);
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return hexToUuid(hex) as Uuid | null;
}

let lastMs = -1;
let seq = 0;
/** A time-ordered id (UUIDv7, a counter inside the millisecond): envelopes list newest first. */
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

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A signing link's token: 32 random bytes, base64url. Only its SHA-256 is stored. */
export function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b64url(b);
}

/** A six-digit email code, uniformly drawn. */
export function newCode(): string {
  const b = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(b);
    n = b[0]!;
  } while (n >= 4_294_000_000); // drop the top sliver so every code is equally likely
  return String(n % 1_000_000).padStart(6, "0");
}
