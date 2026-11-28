import type {
  AuthorizationContextResponse,
  AuthorizationRequest,
  AuthorizationResponse,
  EffectivePermissionsRequest,
  EffectivePermissionsResponse,
  MembershipFact,
} from "@saas/contracts/policy";
import type { Uuid } from "@saas/db/ids";
import type { Env } from "./env.js";

// Who is asking (set by api-edge, which authenticated them) and what they may do. The
// membership facts come from membership-worker; policy-worker decides, both for the org as a
// whole and for one folder or document (with the grants and link files-worker found, PW3).
// Anything short of an explicit allow is a 404 to the caller.

export type FilesAction = "files.read" | "files.write" | "files.delete" | "files.share";

export interface Actor {
  subjectId: string;
  subjectType: string;
  /** The verified email of a signed-in person (api-edge forwards it); guest grants match it. */
  email: string | null;
}

const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}$/;

export function resolveActor(request: Request): Actor | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  const email = request.headers.get("x-actor-email")?.trim().toLowerCase() ?? "";
  return { subjectId, subjectType, email: subjectType === "user" && EMAIL.test(email) ? email : null };
}

export async function membershipFacts(env: Env, actor: Actor, orgId: Uuid, requestId: string): Promise<MembershipFact[] | null> {
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

async function policy<T>(env: Env, path: string, body: unknown, requestId: string): Promise<T | null> {
  if (!env.POLICY_WORKER) return null;
  try {
    const res = await env.POLICY_WORKER.fetch(`http://policy-worker${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { data?: T }).data ?? null;
  } catch {
    return null;
  }
}

const subjectOf = (actor: Actor) => ({ type: actor.subjectType as AuthorizationRequest["subject"]["type"], id: actor.subjectId });

/** An org-wide drive action (list the root, recent documents, trash, quota, guests). */
export async function authorizeOrg(env: Env, actor: Actor, orgId: Uuid, facts: MembershipFact[], action: FilesAction, requestId: string): Promise<boolean> {
  const body: AuthorizationRequest = { subject: subjectOf(actor), action, resource: { kind: "files", orgId }, context: { memberships: facts } };
  const decision = await policy<AuthorizationResponse>(env, "/v1/internal/policy/authorize", body, requestId);
  return decision?.allow === true;
}

/** Every files action allowed on one resource, given the facts files-worker gathered. */
export async function filesPermissions(
  env: Env,
  actor: Actor | null,
  orgId: Uuid,
  facts: MembershipFact[],
  resource: { kind: "folder" | "document"; id: string },
  files: { principal: "member" | "guest" | "link"; grants: string[]; link?: string | null },
  requestId: string,
): Promise<Set<string>> {
  const body: EffectivePermissionsRequest = {
    subject: actor ? subjectOf(actor) : { type: "system", id: "share-link" },
    resource: { kind: "files", id: `${resource.kind}:${resource.id}`, orgId },
    context: { memberships: facts, attributes: { files } },
  };
  const result = await policy<EffectivePermissionsResponse>(env, "/v1/internal/policy/effective-permissions", body, requestId);
  return new Set((result?.permissions ?? []).filter((p) => p.allow && p.action.startsWith("files.")).map((p) => p.action));
}
