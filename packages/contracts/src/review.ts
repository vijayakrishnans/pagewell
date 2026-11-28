// Wire types for Pagewell's review (PW5): comment threads on a page of a document, review
// requests, and the DocRoom's live messages. Ids on the wire: thr_/cmt_/rvr_ + 32 hex.

export type ThreadStatus = "open" | "resolved" | "outdated";

export interface PublicAnchor {
  page: number;
  /** [x, y, w, h] in points from the page's top-left. */
  rect: [number, number, number, number];
  quote: string | null;
}

export interface PublicComment {
  id: string;
  author: { kind: "member" | "guest" | "agent"; id: string; name: string | null };
  body: string;
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface PublicThread {
  id: string;
  documentId: string;
  anchor: PublicAnchor;
  /** The version the anchor was last checked against. */
  version: number;
  status: ThreadStatus;
  createdAt: string;
  resolvedAt: string | null;
  comments: PublicComment[];
}

export interface CreateThreadRequest {
  anchor: PublicAnchor;
  /** The version the commenter is looking at (default: current). */
  version?: number;
  body: string;
}

export interface ThreadResponse {
  thread: PublicThread;
}
export interface ListThreadsResponse {
  threads: PublicThread[];
}
export interface CommentResponse {
  comment: PublicComment;
}

export interface PublicReviewRequest {
  id: string;
  documentId: string;
  version: number;
  message: string | null;
  dueAt: string | null;
  status: "open" | "closed" | "canceled";
  createdBy: string;
  createdAt: string;
  reviewers: Array<{ email: string; decision: "approved" | "changes_requested" | null; decidedAt: string | null }>;
}

export interface CreateReviewRequest {
  reviewers: string[];
  message?: string | null;
  dueAt?: string | null;
}

export interface ReviewRequestResponse {
  request: PublicReviewRequest;
}
export interface ListReviewRequestsResponse {
  requests: PublicReviewRequest[];
}

/** Messages the DocRoom sends to everyone in the room (over its WebSocket). */
export type RoomEvent =
  | { type: "presence"; people: Array<{ id: string; name: string | null; editing: boolean }> }
  | { type: "lease"; holder: { id: string; name: string | null } | null; expiresAt: string | null }
  | { type: "thread"; thread: PublicThread }
  | { type: "version"; version: number; by: string | null }
  | { type: "job"; jobId: string; status: string };

/** Messages a client sends to the DocRoom. */
export type RoomCommand = { type: "lease.take" } | { type: "lease.renew" } | { type: "lease.release" } | { type: "lease.break" } | { type: "version"; version: number } | { type: "ping" };

/** POST …/room/ticket: a single-use ticket to open the room's WebSocket within a minute. */
export interface RoomTicketResponse {
  ticket: string;
  expiresAt: string;
  /** What the caller may do in the room. */
  canEdit: boolean;
  canBreak: boolean;
}

/** An edit lease lasts this long without a renewal. */
export const LEASE_TTL_MS = 60_000;
export const COMMENT_MAX_CHARS = 10_000;
