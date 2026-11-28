import type { EventsRepository } from "@saas/db/events";
import type { Job } from "@saas/db/jobs";

// Jobs in the platform's events and audit log (category "jobs"), on the job's first document so
// they show in its Activity: job.created, job.succeeded, job.failed, job.canceled. Best-effort.
// Ids are UUIDv7 with a counter inside the millisecond, so a document's activity keeps order.

let lastMs = -1;
let seq = 0;
function eventId(at: Date): string {
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
  return `${time.slice(0, 8)}-${time.slice(8)}-7${hex(seq, 3)}-${hex(0x8000 | (((rand[0]! << 8) | rand[1]!) & 0x3fff), 4)}-${[...rand.slice(2)].map((b) => hex(b, 2)).join("")}`;
}

export async function audit(
  deps: { events: EventsRepository | null; requestId: string; now: () => Date },
  job: Job,
  type: string,
  description: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!deps.events) return;
  const now = deps.now();
  try {
    await deps.events.appendEventWithAudit({
      event: {
        id: eventId(now),
        type,
        version: 1,
        source: "pdf-jobs-worker",
        occurredAt: now,
        actorType: job.actorKind === "user" ? "user" : "service_principal",
        actorId: job.createdBy,
        orgId: job.orgId,
        subjectKind: "document",
        subjectId: job.inputs[0]?.docId ?? job.id,
        requestId: deps.requestId,
        payload: { operation: job.operation, ...payload },
      },
      audit: { id: eventId(now), category: "jobs", description },
    });
  } catch {
    console.warn(JSON.stringify({ level: "warn", msg: "audit write failed", type, requestId: deps.requestId }));
  }
}
