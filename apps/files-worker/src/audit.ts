import type { EventsCursorPosition, EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";

// Event ids are UUIDv7 with a counter inside the millisecond, so events written in the same
// millisecond (a guest invited and their grant, in one request) list in the order they happened:
// the audit read orders by (occurred_at, id).
let lastMs = -1;
let seq = 0;
export function eventId(at: Date): string {
  const ms = at.getTime();
  if (ms === lastMs) seq = (seq + 1) & 0xfff;
  else {
    lastMs = ms;
    seq = 0;
  }
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
  const time = hex(ms, 12);
  const variant = hex(0x8000 | ((rand[0]! << 8) | rand[1]!) & 0x3fff, 4);
  const tail = [...rand.slice(2)].map((b) => hex(b, 2)).join("");
  return `${time.slice(0, 8)}-${time.slice(8)}-7${hex(seq, 3)}-${variant}-${tail}`;
}

// Every change in the drive and every share event goes to the platform's events and audit log
// (the same tables events-worker serves the console's audit page from), as the design's domain
// events: folder.*, document.*, version.*, grant.*, link.*, guest.*. Best-effort: a failed
// write never fails the change, and never logs the document's name.

export interface AuditSubject {
  kind: "folder" | "document" | "organization";
  id: Uuid | string;
  name?: string | null;
}

export interface HistoryEntry {
  id: string;
  type: string;
  actor: { type: string; id: string };
  description: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface Auditor {
  record(type: string, subject: AuditSubject, description: string, payload?: Record<string, unknown>): Promise<void>;
  /** What happened to one folder or document, newest first. Null when the log cannot be read. */
  history(subject: AuditSubject, limit: number, cursor: string | null): Promise<{ entries: HistoryEntry[]; nextCursor: string | null } | null>;
}

const encode = (c: EventsCursorPosition) => btoa(`${c.occurredAt}|${c.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function decode(cursor: string | null): EventsCursorPosition | null | "invalid" {
  if (!cursor) return null;
  try {
    const [occurredAt, id, extra] = atob(cursor.replace(/-/g, "+").replace(/_/g, "/")).split("|");
    if (!occurredAt || !id || extra !== undefined || Number.isNaN(Date.parse(occurredAt))) return "invalid";
    return { occurredAt, id };
  } catch {
    return "invalid";
  }
}

export function createAuditor(opts: {
  events: EventsRepository | null;
  orgId: Uuid;
  actor: { type: string; id: string };
  requestId: string;
  now: Date;
}): Auditor {
  return {
    async record(type, subject, description, payload = {}) {
      if (!opts.events) return;
      try {
        const r = await opts.events.appendEventWithAudit({
          event: {
            id: eventId(opts.now),
            type,
            version: 1,
            source: "files-worker",
            occurredAt: opts.now,
            actorType: opts.actor.type,
            actorId: opts.actor.id,
            orgId: opts.orgId,
            subjectKind: subject.kind,
            subjectId: subject.id,
            subjectName: subject.name ?? null,
            requestId: opts.requestId,
            payload,
          },
          audit: { id: eventId(opts.now), category: "files", description },
        });
        if (!r.ok) console.warn(JSON.stringify({ level: "warn", msg: "audit write failed", type, requestId: opts.requestId }));
      } catch {
        console.warn(JSON.stringify({ level: "warn", msg: "audit write failed", type, requestId: opts.requestId }));
      }
    },

    async history(subject, limit, cursor) {
      if (!opts.events) return null;
      const position = decode(cursor);
      if (position === "invalid") return null;
      const r = await opts.events.queryAuditByTarget(opts.orgId, subject.kind, subject.id, { limit, cursor: position });
      if (!r.ok) return null;
      return {
        entries: r.value.items.map((e) => ({
          id: e.id,
          type: e.eventType,
          actor: { type: e.actorType, id: e.actorId },
          description: e.description,
          occurredAt: e.occurredAt.toISOString(),
          payload: e.payload,
        })),
        nextCursor: r.value.nextCursor ? encode(r.value.nextCursor) : null,
      };
    },
  };
}
