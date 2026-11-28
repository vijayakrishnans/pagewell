/**
 * Sharing in the console (PW3): pure helpers for the share dialog, Shared with me and the
 * guests page. Dependency-free so they are unit-testable (tests/web-console-next/src/sharing.test.ts).
 */

import type { DriveRole, LinkRole, PublicGrant, PublicLink } from "@saas/contracts/sharing";

export const DRIVE_ROLES: readonly DriveRole[] = ["viewer", "commenter", "editor"];
export const LINK_ROLES: readonly LinkRole[] = ["viewer", "commenter"];

const USER_ID = /^usr_[0-9a-f]{32}$/;
const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}\.[^\s@]{1,63}$/;

export function roleLabel(role: DriveRole | LinkRole): string {
  return { viewer: "Can view", commenter: "Can comment", editor: "Can edit" }[role];
}

/** What the "Add people" box holds: a member's user id, an email address, or nothing usable. */
export function principalFrom(input: string): { userId: string } | { email: string } | null {
  const v = input.trim();
  if (USER_ID.test(v)) return { userId: v };
  if (EMAIL.test(v) && v.length <= 320) return { email: v.toLowerCase() };
  return null;
}

/** Who a grant is for, as the dialog shows it. */
export function grantSubject(g: PublicGrant): { primary: string; secondary: string } {
  if (g.principal.kind === "member") return { primary: g.principal.userId, secondary: "Member" };
  const name = g.principal.name?.trim();
  return {
    primary: name || g.principal.email,
    secondary: `${name ? `${g.principal.email} · ` : ""}Guest${g.principal.verified ? "" : " · hasn't opened it yet"}`,
  };
}

/** "From <folder>" for a grant inherited from a folder above, else null. */
export function inheritedNote(g: PublicGrant): string | null {
  return g.inheritedFrom ? `From ${g.inheritedFrom.name || "a folder above"}` : null;
}

/** Grants that sit on this resource first, then inherited ones; each group by when it was made. */
export function sortGrants(grants: PublicGrant[]): PublicGrant[] {
  return [...grants].sort((a, b) => Number(Boolean(a.inheritedFrom)) - Number(Boolean(b.inheritedFrom)) || a.createdAt.localeCompare(b.createdAt));
}

export type ExpiryChoice = "never" | "1d" | "7d" | "30d";
export const EXPIRY_CHOICES: ReadonlyArray<{ value: ExpiryChoice; label: string }> = [
  { value: "never", label: "Never expires" },
  { value: "1d", label: "Expires in 1 day" },
  { value: "7d", label: "Expires in 7 days" },
  { value: "30d", label: "Expires in 30 days" },
];

export function expiresAt(choice: ExpiryChoice, now: Date = new Date()): string | null {
  const days = { never: 0, "1d": 1, "7d": 7, "30d": 30 }[choice];
  return days ? new Date(now.getTime() + days * 86_400_000).toISOString() : null;
}

/** The URL to share: the editor's read-only viewer for the token. The token is the key. */
export function shareLinkUrl(editorOrigin: string, token: string): string {
  return new URL(`/l/${encodeURIComponent(token)}`, editorOrigin).toString();
}

/** One line about a link: its role, password, download and expiry. */
export function linkSummary(l: PublicLink, now: Date = new Date()): string {
  const parts = [roleLabel(l.role)];
  if (l.hasPassword) parts.push("password");
  if (!l.allowDownload) parts.push("no download");
  if (l.expiresAt) {
    const left = new Date(l.expiresAt).getTime() - now.getTime();
    parts.push(left <= 0 ? "expired" : `expires ${new Date(l.expiresAt).toLocaleDateString()}`);
  }
  return parts.join(" · ");
}

/** Pages a person who is only a guest may open without first creating an org. */
export function isSharedPath(pathname: string | null): boolean {
  return pathname === "/shared" || (pathname?.startsWith("/shared/") ?? false);
}
