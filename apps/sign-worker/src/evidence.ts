import type { SignRepository } from "@saas/db/sign";
import type { Uuid } from "@saas/db/ids";
import { nextEvent, type Json } from "@saas/shared/evidence";

// Append to an envelope's evidence log: read the last event, chain the new one onto it, insert.
// Two writers racing for the same place: the second is refused by the primary key and tries
// again from the new last event. An evidence write that still fails is reported, not swallowed:
// the action it records is not acknowledged without it.

export class EvidenceError extends Error {}

export async function record(repo: SignRepository, orgId: Uuid, envelopeId: Uuid, kind: string, payload: Json, at: Date): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await repo.lastEvent(orgId, envelopeId);
    if (!last.ok) throw new EvidenceError("could not read the evidence log");
    const e = await nextEvent(last.value, kind, at.toISOString(), payload);
    const r = await repo.appendEvent(orgId, envelopeId, e);
    if (r.ok) return e.hash;
    if (r.error.kind !== "conflict") throw new EvidenceError("could not write the evidence log");
  }
  throw new EvidenceError("the evidence log is busy");
}
