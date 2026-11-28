import type { EventsRepository } from "@saas/db/events";

// E-sign in the platform's events and audit log (category "sign"), on the envelope's first document so it shows
// in its Activity: envelope.created, envelope.sent, signer.signed, envelope.completed and the rest.


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
  events: EventsRepository | null,
  ctx: { orgId: string; actor: { type: string; id: string }; requestId: string; now: Date },
  docId: string,
  type: string,
  description: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!events) return;
  try {
    await events.appendEventWithAudit({
      event: {
        id: eventId(ctx.now),
        type,
        version: 1,
        source: "sign-worker",
        occurredAt: ctx.now,
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        orgId: ctx.orgId,
        subjectKind: "document",
        subjectId: docId,
        requestId: ctx.requestId,
        payload,
      },
      audit: { id: eventId(ctx.now), category: "sign", description },
    });
  } catch {
    console.warn(JSON.stringify({ level: "warn", msg: "audit write failed", type, requestId: ctx.requestId }));
  }
}
