// Wire types for sharing in Pagewell's drive (PW3): grants, guests, share links, Shared with
// me, and the activity of a document. Ids on the wire: grt_/gst_/lnk_ + 32 hex. A link's token
// is shown once, when it is created, and never again.

import type { PublicDocument, PublicFolder } from "./files.js";

export type DriveRole = "editor" | "commenter" | "viewer";
export type LinkRole = "viewer" | "commenter";
export type DriveAction = "files.read" | "files.comment" | "files.write" | "files.delete" | "files.share";
export type ShareResourceKind = "folder" | "document";

/** Error codes sharing adds (errors.ts). Dead links are 404 like anything else not found. */
export const SHARING_ERROR_CODES = {
  /** The link has a password and none (or a wrong one) was sent. 401; carries nothing else. */
  LINK_PASSWORD_REQUIRED: "link_password_required",
} as const;

/** The header a link opener sends the link's password in, on every request. */
export const LINK_PASSWORD_HEADER = "x-pagewell-link-password";

/** What the asking person may do on one resource, and why. */
export interface PublicAccess {
  role: DriveRole | null;
  actions: DriveAction[];
  /** "member", "guest" or "link": how they reached it. */
  principal: "member" | "guest" | "link";
}

export interface PublicGrant {
  id: string;
  resource: { kind: ShareResourceKind; id: string };
  principal: { kind: "member"; userId: string } | { kind: "guest"; guestId: string; email: string; name: string | null; verified: boolean };
  role: DriveRole;
  /** The folder this grant comes from, when it sits on a folder above the resource asked about. */
  inheritedFrom: { folderId: string; name: string } | null;
  createdBy: string;
  createdAt: string;
}

export interface PublicGuest {
  id: string;
  email: string;
  name: string | null;
  invitedAt: string;
  verifiedAt: string | null;
}

export interface PublicLink {
  id: string;
  resource: { kind: ShareResourceKind; id: string };
  role: LinkRole;
  hasPassword: boolean;
  expiresAt: string | null;
  allowDownload: boolean;
  createdBy: string;
  createdAt: string;
}

/** POST …/grants: a member by user id, or anyone by email (a guest unless they are a member). */
export interface CreateGrantRequest {
  userId?: string;
  email?: string;
  name?: string | null;
  role: DriveRole;
  /** Send the person an email about it (default true for a guest). */
  notify?: boolean;
  message?: string | null;
}

export interface GrantResponse {
  grant: PublicGrant;
}

/** GET …/grants: who has access, inherited grants included, and what the caller may do. */
export interface AccessListResponse {
  grants: PublicGrant[];
  links: PublicLink[];
  access: PublicAccess;
}

export interface CreateLinkRequest {
  role: LinkRole;
  password?: string | null;
  expiresAt?: string | null;
  allowDownload?: boolean;
}

/** The token is in this response only. The URL to share is the editor's /l/<token>. */
export interface CreateLinkResponse {
  link: PublicLink;
  token: string;
}

export interface ListGuestsResponse {
  guests: PublicGuest[];
}

export interface SharedItem {
  orgId: string;
  resource: { kind: ShareResourceKind; id: string };
  name: string;
  role: DriveRole;
  updatedAt: string;
  document: Pick<PublicDocument, "currentVersion" | "size" | "pageCount" | "folderId"> | null;
}

export interface SharedWithMeResponse {
  items: SharedItem[];
}

/** GET /v1/l/{token}: what a link opens. A folder link lists its folder; a document link names its document. */
export interface LinkOpenResponse {
  link: { role: LinkRole; allowDownload: boolean; expiresAt: string | null };
  folder: PublicFolder | null;
  document: PublicDocument | null;
  /** For a folder link: what is in the folder asked for (?folderId= within the linked one). */
  folders: PublicFolder[];
  documents: PublicDocument[];
}

export interface ActivityEntry {
  id: string;
  type: string;
  actor: { type: string; id: string };
  description: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface ActivityResponse {
  entries: ActivityEntry[];
  nextCursor: string | null;
}

/** Share links stop working after this; a link may be made shorter, not longer. */
export const LINK_MAX_DAYS = 365;
export const LINK_PASSWORD_MIN = 8;
export const LINK_PASSWORD_MAX = 200;
