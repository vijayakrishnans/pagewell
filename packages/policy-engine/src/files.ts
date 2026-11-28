// Pagewell's drive: who may do what to one folder or document (PW3).
//
// The org role sets the floor: owner, admin and builder edit everything in their org's drive,
// a viewer reads it, billing_admin sees none of it. Grants on a folder or a document add
// editor, commenter or viewer; a folder's grants reach everything under it, and the most
// permissive role wins. There is no "none" that takes access away. A share link carries
// viewer or commenter, never more. Guests (people outside the org) have no floor: only what
// they were granted. Only members may share; a guest or a link holder never can.
//
// files-worker gathers the facts (memberships, the grants along the resource's folder chain
// for this person, the link if one was presented) and asks policy-worker; this decides.

export const DRIVE_ROLES = ["viewer", "commenter", "editor"] as const;
export type DriveRole = (typeof DRIVE_ROLES)[number];

export const LINK_ROLES = ["viewer", "commenter"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export type DrivePrincipal = "member" | "guest" | "link";

export const FILES_RESOURCE_ACTIONS = ["files.read", "files.comment", "files.write", "files.delete", "files.share"] as const;
export type FilesResourceAction = (typeof FILES_RESOURCE_ACTIONS)[number];

/** What files-worker tells policy about one resource, in `context.attributes.files`. */
export interface FilesAccessFacts {
  /** Who is asking: an org member, a guest of the org, or the holder of a share link. */
  principal: DrivePrincipal;
  /** The roles of the grants that reach this resource for this person (its own and its folders'). */
  grants: DriveRole[];
  /** The role of the share link presented, when the principal is a link. */
  link?: LinkRole | null;
}

const RANK: Record<DriveRole, number> = { viewer: 1, commenter: 2, editor: 3 };

const ROLE_ACTIONS: Record<DriveRole, readonly FilesResourceAction[]> = {
  viewer: ["files.read"],
  commenter: ["files.read", "files.comment"],
  editor: ["files.read", "files.comment", "files.write", "files.delete", "files.share"],
};

/** The drive role an org role gives everywhere in that org's drive. */
export function floorRole(orgRole: string | null | undefined): DriveRole | null {
  if (orgRole === "owner" || orgRole === "admin" || orgRole === "builder") return "editor";
  if (orgRole === "viewer") return "viewer";
  return null;
}

export const isDriveRole = (v: unknown): v is DriveRole => typeof v === "string" && (DRIVE_ROLES as readonly string[]).includes(v);
export const isLinkRole = (v: unknown): v is LinkRole => typeof v === "string" && (LINK_ROLES as readonly string[]).includes(v);

export function maxRole(roles: Array<DriveRole | null | undefined>): DriveRole | null {
  let best: DriveRole | null = null;
  for (const r of roles) if (r && (!best || RANK[r] > RANK[best])) best = r;
  return best;
}

export interface FilesDecision {
  allow: boolean;
  /** The role the person ends up with on this resource, null for none. */
  role: DriveRole | null;
  /** Where the deciding role came from: org_<role>, grant_<role>, link_<role>, or why not. */
  reason: string;
}

/**
 * The decision for `action` on one resource. `orgRole` is the person's role in the resource's
 * org (null for a guest or a link holder).
 */
export function decideFiles(action: string, orgRole: string | null, facts: FilesAccessFacts): FilesDecision {
  if (!(FILES_RESOURCE_ACTIONS as readonly string[]).includes(action)) return { allow: false, role: null, reason: "unknown_action" };
  const floor = facts.principal === "member" ? floorRole(orgRole) : null;
  const grants = facts.principal === "link" ? [] : facts.grants.filter(isDriveRole);
  const link = facts.principal === "link" && isLinkRole(facts.link) ? facts.link : null;
  const role = maxRole([floor, ...grants, link]);
  if (!role) return { allow: false, role: null, reason: "no_access" };
  // A link is read or comment only, whatever its stored role says; sharing is for members.
  if (facts.principal === "link" && action !== "files.read" && action !== "files.comment") return { allow: false, role, reason: "link_cannot" };
  if (action === "files.share" && facts.principal !== "member") return { allow: false, role, reason: "only_members_share" };
  const source = role === floor ? `org_${orgRole}` : role === link ? `link_${role}` : `grant_${role}`;
  return ROLE_ACTIONS[role].includes(action as FilesResourceAction) ? { allow: true, role, reason: source } : { allow: false, role, reason: `role_${role}` };
}

/** Every action a role allows, for the UI's "what can I do here". */
export function actionsFor(role: DriveRole | null, principal: DrivePrincipal): FilesResourceAction[] {
  if (!role) return [];
  return ROLE_ACTIONS[role].filter((a) => {
    if (principal === "link") return a === "files.read" || a === "files.comment";
    if (a === "files.share") return principal === "member";
    return true;
  });
}
