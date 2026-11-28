import type { MembershipFact } from "@saas/contracts/policy";
import type { DriveAction, PublicAccess } from "@saas/contracts/sharing";
import type { Grant, ResourceRef, SharingRepository } from "@saas/db/files";
import type { Uuid } from "@saas/db/ids";
import { authorizeOrg, filesPermissions, type Actor, type FilesAction } from "./auth.js";
import type { Env } from "./env.js";

// What one person may do in one org's drive, for the length of one request. The org role is
// the floor; grants on a folder or document (and every folder above it) add to it; policy
// decides from those facts. Answers are cached per resource for the request.

const WIDEST_FLOOR = new Set(["owner", "admin", "builder"]);
const ROLE_ORDER = ["editor", "commenter", "viewer"] as const;

export interface Access {
  /** "member" when the person has a role in the org; "guest" otherwise (grants only). */
  readonly principal: "member" | "guest";
  /** An org-wide action: members only. */
  org(action: FilesAction): Promise<boolean>;
  /** An action on one folder or document. */
  can(action: DriveAction, resource: ResourceRef): Promise<boolean>;
  /** What the person may do on one resource, for the UI. */
  describe(resource: ResourceRef): Promise<PublicAccess>;
  /** The grants of this person that reach the resource (for a guest's breadcrumb). */
  myGrants(resource: ResourceRef): Promise<Grant[]>;
}

export function createAccess(opts: {
  env: Env;
  actor: Actor;
  orgId: Uuid;
  facts: MembershipFact[];
  sharing: SharingRepository;
  requestId: string;
  /** Called once per request when a guest is let in, to record their first verified visit. */
  onGuestAllowed: () => Promise<void>;
}): Access {
  const { env, actor, orgId, facts, sharing, requestId } = opts;
  const orgFacts = facts.filter((f) => f.scope?.orgId === orgId && f.scope.kind === "organization");
  const principal: "member" | "guest" = orgFacts.length > 0 ? "member" : "guest";
  // An owner, admin or builder already edits everything here; no grant can widen that.
  const grantsCannotWiden = orgFacts.some((f) => WIDEST_FLOOR.has(f.role));
  const who = { memberId: actor.subjectType === "user" ? actor.subjectId : null, email: actor.email };
  const grantCache = new Map<string, Promise<Grant[]>>();
  const permCache = new Map<string, Promise<Set<string>>>();
  const orgCache = new Map<string, Promise<boolean>>();
  let guestRecorded = false;

  const key = (r: ResourceRef) => `${r.kind}:${r.id}`;
  const myGrants = (r: ResourceRef) => {
    let p = grantCache.get(key(r));
    if (!p) {
      p = sharing.grantsReaching(orgId, r, who).then((g) => (g.ok ? g.value : []));
      grantCache.set(key(r), p);
    }
    return p;
  };
  const permissions = (r: ResourceRef) => {
    let p = permCache.get(key(r));
    if (!p) {
      p = (async () => {
        const grants = grantsCannotWiden ? [] : (await myGrants(r)).map((g) => g.role);
        if (principal === "guest" && grants.length === 0) return new Set<string>();
        return filesPermissions(env, actor, orgId, facts, r, { principal, grants }, requestId);
      })();
      permCache.set(key(r), p);
    }
    return p;
  };

  return {
    principal,
    org(action) {
      if (principal !== "member") return Promise.resolve(false);
      let p = orgCache.get(action);
      if (!p) {
        p = authorizeOrg(env, actor, orgId, facts, action, requestId);
        orgCache.set(action, p);
      }
      return p;
    },
    async can(action, resource) {
      const allowed = (await permissions(resource)).has(action);
      if (allowed && principal === "guest" && !guestRecorded) {
        guestRecorded = true;
        await opts.onGuestAllowed().catch(() => undefined);
      }
      return allowed;
    },
    async describe(resource) {
      const actions = [...(await permissions(resource))].filter((a): a is DriveAction => a.startsWith("files.")) as DriveAction[];
      const role = actions.includes("files.write") ? "editor" : actions.includes("files.comment") ? "commenter" : actions.includes("files.read") ? "viewer" : null;
      return { role: role ?? null, actions: actions.sort(), principal };
    },
    myGrants,
  };
}

/** The widest of some roles, for display. */
export function widest(roles: string[]): (typeof ROLE_ORDER)[number] | null {
  return ROLE_ORDER.find((r) => roles.includes(r)) ?? null;
}
