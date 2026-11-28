// The e-sign evidence chain (PW6). Every event of an envelope is hashed together with the hash
// of the event before it, so changing, removing or reordering any event breaks every hash after
// it. Uses WebCrypto (Workers and Node 20+).
//
//   hash(n) = SHA-256( prev_hash "\n" seq "\n" kind "\n" at "\n" canonical(payload) )
//
// canonical(): JSON with object keys sorted at every level, no spaces; numbers as JSON writes
// them. The first event's prev_hash is 64 zeros.

// @saas/shared builds without DOM or Workers types; these are the two globals this file uses,
// present in every runtime it runs on (Workers, browsers, Node 20+).
declare const crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
declare const TextEncoder: { new (): { encode(text: string): Uint8Array } };

export const GENESIS = "0".repeat(64);

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface EvidenceEvent {
  seq: number;
  kind: string;
  at: string;
  payload: Json;
  prevHash: string;
  hash: string;
}

/** JSON with sorted keys at every level; `undefined` members are dropped, as JSON.stringify does. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("canonical: numbers must be finite");
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function eventHash(prevHash: string, seq: number, kind: string, at: string, payload: unknown): Promise<string> {
  return sha256Hex(`${prevHash}\n${seq}\n${kind}\n${at}\n${canonical(payload)}`);
}

/** The next event after `last` (or the first, when `last` is null). */
export async function nextEvent(last: Pick<EvidenceEvent, "seq" | "hash"> | null, kind: string, at: string, payload: Json): Promise<EvidenceEvent> {
  const seq = last ? last.seq + 1 : 1;
  const prevHash = last ? last.hash : GENESIS;
  return { seq, kind, at, payload, prevHash, hash: await eventHash(prevHash, seq, kind, at, payload) };
}

export type ChainVerdict = { ok: true; head: string; length: number } | { ok: false; brokenAt: number; reason: "sequence" | "link" | "hash" };

/** Check a whole chain, in order: sequence 1..n, each prev_hash the hash before, each hash recomputed. */
export async function verifyChain(events: readonly EvidenceEvent[]): Promise<ChainVerdict> {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq !== i + 1) return { ok: false, brokenAt: i + 1, reason: "sequence" };
    if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq, reason: "link" };
    if ((await eventHash(e.prevHash, e.seq, e.kind, e.at, e.payload)) !== e.hash) return { ok: false, brokenAt: e.seq, reason: "hash" };
    prev = e.hash;
  }
  return { ok: true, head: prev, length: events.length };
}
