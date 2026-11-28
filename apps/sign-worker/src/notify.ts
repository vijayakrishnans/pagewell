import { buildIdempotencyKey, enqueueNotification } from "@saas/notifications-client";
import type { Env } from "./env.js";

// E-sign emails through notifications-worker (sign-worker is an allowed internal caller). The
// signing link and the email code are the only secrets that go into an email, each to its own
// signer. Best-effort: a failed send never fails the request (a resend issues a new link).

export type SignTemplate = "sign.requested" | "sign.code" | "sign.reminder" | "sign.declined" | "sign.completed" | "sign.voided";

export async function notify(
  env: Env,
  ctx: { orgId: string; actor: { type: string; id: string }; requestId: string },
  templateKey: SignTemplate,
  to: string,
  data: Record<string, string | number | boolean | null>,
  idempotencyParts: string[],
): Promise<void> {
  await enqueueNotification(
    env,
    { internalActor: "sign-worker", actorSubjectType: ctx.actor.type, actorSubjectId: ctx.actor.id, requestId: ctx.requestId },
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

/** The signing page link for a token, or null when SIGN_URL is not a plain https origin. */
export function signingUrl(env: Env, token: string): string | null {
  const base = env.SIGN_URL;
  if (!base || !/^https:\/\/[^\s/]+$/.test(base)) return env.ENVIRONMENT === "test" ? `https://sign.example.com/s/${token}` : null;
  return `${base}/s/${token}`;
}
