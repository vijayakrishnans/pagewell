import { buildIdempotencyKey, enqueueNotification } from "@saas/notifications-client";
import type { Env } from "./env.js";

// Review emails through notifications-worker (review-worker is an allowed internal caller):
// review.mentioned, review.requested, review.reminder. Best-effort: a failed send never fails
// the comment or the request. Template data never carries a token.

export async function notify(
  env: Env,
  ctx: { orgId: string; actor: { type: string; id: string }; requestId: string },
  templateKey: "review.mentioned" | "review.requested" | "review.reminder",
  to: string,
  data: Record<string, string | number | boolean | null>,
  idempotencyParts: string[],
): Promise<void> {
  await enqueueNotification(
    env,
    { internalActor: "review-worker", actorSubjectType: ctx.actor.type, actorSubjectId: ctx.actor.id, requestId: ctx.requestId },
    {
      orgId: ctx.orgId,
      category: "product",
      templateKey,
      templateData: data,
      recipient: { channel: "email", address: to },
      idempotencyKey: buildIdempotencyKey(templateKey, ...idempotencyParts),
    },
  ).catch(() => undefined);
}

const MENTION = /(?:^|[\s(])@([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24})/g;

/** The email addresses @-mentioned in a comment, lower-cased, at most 10. */
export function mentionsIn(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION)) {
    out.add(m[1]!.toLowerCase());
    if (out.size >= 10) break;
  }
  return [...out];
}
