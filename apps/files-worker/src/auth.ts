import type { AuthorizationContextResponse, AuthorizationRequest, AuthorizationResponse, MembershipFact } from "@saas/contracts/policy";
import type { Uuid } from "@saas/db/ids";
import type { Env } from "./env.js";

// Who is asking (set by api-edge, which authenticated them) and what they may
// do in this org: membership-worker supplies the facts, policy-worker decides.
// Anything short of an explicit allow is a 404 to the caller.

export type FilesAction = "files.read" | "files.write" | "files.delete";

export interface Actor {
  subjectId: string;
  subjectType: string;
}

export function resolveActor(request: Request): Actor | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

async function memberships(env: Env, actor: Actor, orgId: Uuid, requestId: string): Promise<MembershipFact[] | null> {
  if (!env.MEMBERSHIP_WORKER) return null;
  try {
    const res = await env.MEMBERSHIP_WORKER.fetch("http://membership-worker/v1/internal/membership/authorization-context", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ subject: { type: actor.subjectType, id: actor.subjectId }, orgId }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: AuthorizationContextResponse };
    return Array.isArray(body?.data?.memberships) ? body.data.memberships : null;
  } catch {
    return null;
  }
}

export async function authorize(env: Env, actor: Actor, orgId: Uuid, action: FilesAction, requestId: string): Promise<boolean> {
  if (!env.POLICY_WORKER) return false;
  const facts = await memberships(env, actor, orgId, requestId);
  if (!facts) return false;
  const body: AuthorizationRequest = {
    subject: { type: actor.subjectType as AuthorizationRequest["subject"]["type"], id: actor.subjectId },
    action,
    resource: { kind: "files", orgId },
    context: { memberships: facts },
  };
  try {
    const res = await env.POLICY_WORKER.fetch("http://policy-worker/v1/internal/policy/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify(body),
    });
    if (!res.ok) return false;
    const parsed = (await res.json()) as { data?: AuthorizationResponse };
    return parsed?.data?.allow === true;
  } catch {
    return false;
  }
}
