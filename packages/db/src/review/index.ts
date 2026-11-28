import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import { executeBatch } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";

// Pagewell's review (PW5): comment threads, comments, review requests. Every statement names
// org_id except the cron's read of due requests, which works across orgs and hands back rows
// that carry their org.

export type ThreadStatus = "open" | "resolved" | "outdated";
export type AuthorKind = "member" | "guest" | "agent";
export type Decision = "approved" | "changes_requested";

export interface Anchor {
  page: number;
  /** [x, y, w, h] in points from the page's top-left. */
  rect: [number, number, number, number];
  /** The text under the anchor when it was made, if any. */
  quote: string | null;
}

export interface Comment {
  id: string;
  orgId: string;
  threadId: string;
  authorKind: AuthorKind;
  authorId: string;
  authorName: string | null;
  body: string;
  mentions: string[];
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface Thread {
  id: string;
  orgId: string;
  docId: string;
  anchor: Anchor;
  version: number;
  status: ThreadStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  comments: Comment[];
}

export interface Reviewer {
  email: string;
  userId: string | null;
  decision: Decision | null;
  decidedAt: Date | null;
}

export interface ReviewRequest {
  id: string;
  orgId: string;
  docId: string;
  version: number;
  message: string | null;
  dueAt: Date | null;
  status: "open" | "closed" | "canceled";
  createdBy: string;
  createdAt: Date;
  remindedAt: Date | null;
  reviewers: Reviewer[];
}

export type ReviewResult<T> = { ok: true; value: T } | { ok: false; error: { kind: "not_found" } | { kind: "internal"; message: string } };

export interface NewComment {
  id: Uuid;
  authorKind: AuthorKind;
  authorId: string;
  authorName: string | null;
  body: string;
  mentions: string[];
}

export interface ReviewRepository {
  createThread(input: { id: Uuid; orgId: Uuid; docId: Uuid; anchor: Anchor; version: number; comment: NewComment; now: Date }): Promise<ReviewResult<Thread>>;
  listThreads(orgId: Uuid, docId: Uuid): Promise<ReviewResult<Thread[]>>;
  getThread(orgId: Uuid, threadId: Uuid): Promise<ReviewResult<Thread>>;
  addComment(orgId: Uuid, threadId: Uuid, comment: NewComment, now: Date): Promise<ReviewResult<Comment>>;
  /** Only by its author; a deleted comment cannot be edited. */
  editComment(orgId: Uuid, commentId: Uuid, authorId: string, body: string, mentions: string[], now: Date): Promise<ReviewResult<Comment>>;
  /** Blank a comment (its author, or `force` for an editor of the document). */
  deleteComment(orgId: Uuid, commentId: Uuid, authorId: string | null, now: Date): Promise<ReviewResult<Comment>>;
  setStatus(orgId: Uuid, threadId: Uuid, status: "open" | "resolved", by: string, now: Date): Promise<ReviewResult<Thread>>;
  /** Move a thread to a newer version: carried forward (open, its anchor maybe updated) or outdated. */
  carry(orgId: Uuid, threadId: Uuid, fromVersion: number, toVersion: number, outcome: { status: "open" | "resolved" | "outdated"; anchor: Anchor }, now: Date): Promise<ReviewResult<Thread>>;

  createRequest(input: { id: Uuid; orgId: Uuid; docId: Uuid; version: number; message: string | null; dueAt: Date | null; reviewers: string[]; createdBy: string; now: Date }): Promise<ReviewResult<ReviewRequest>>;
  listRequests(orgId: Uuid, docId: Uuid): Promise<ReviewResult<ReviewRequest[]>>;
  getRequest(orgId: Uuid, requestId: Uuid): Promise<ReviewResult<ReviewRequest>>;
  /** A reviewer (by email) decides; closes the request when everyone has. */
  decide(orgId: Uuid, requestId: Uuid, email: string, userId: string, decision: Decision, now: Date): Promise<ReviewResult<ReviewRequest>>;
  cancelRequest(orgId: Uuid, requestId: Uuid): Promise<ReviewResult<ReviewRequest>>;
  /** Housekeeping, across orgs: open requests due within `window` of `now` not reminded since `since`. */
  dueForReminder(now: Date, windowMs: number, since: Date, limit: number): Promise<ReviewResult<ReviewRequest[]>>;
  markReminded(orgId: Uuid, requestId: Uuid, now: Date): Promise<ReviewResult<void>>;
}

const date = (v: unknown) => new Date(v as string);
const dateOrNull = (v: unknown) => (v ? new Date(v as string) : null);
const iso = (d: Date) => d.toISOString();
const fail = (message: string): ReviewResult<never> => ({ ok: false, error: { kind: "internal", message } });
const notFound: ReviewResult<never> = { ok: false, error: { kind: "not_found" } };
function parse<T>(v: unknown, fallback: T): T {
  try {
    return typeof v === "string" ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function mapComment(r: SqlRow): Comment {
  const deleted = dateOrNull(r.deleted_at);
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    threadId: r.thread_id as string,
    authorKind: r.author_kind as AuthorKind,
    authorId: r.author_id as string,
    authorName: (r.author_name as string | null) ?? null,
    body: deleted ? "" : (r.body as string),
    mentions: deleted ? [] : parse<string[]>(r.mentions_json, []),
    createdAt: date(r.created_at),
    editedAt: dateOrNull(r.edited_at),
    deletedAt: deleted,
  };
}

function mapThread(r: SqlRow, comments: Comment[]): Thread {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    docId: r.doc_id as string,
    anchor: parse<Anchor>(r.anchor_json, { page: 1, rect: [0, 0, 0, 0], quote: null }),
    version: Number(r.version),
    status: r.status as ThreadStatus,
    createdBy: r.created_by as string,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
    resolvedBy: (r.resolved_by as string | null) ?? null,
    resolvedAt: dateOrNull(r.resolved_at),
    comments,
  };
}

function mapRequest(r: SqlRow, reviewers: Reviewer[]): ReviewRequest {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    docId: r.doc_id as string,
    version: Number(r.version),
    message: (r.message as string | null) ?? null,
    dueAt: dateOrNull(r.due_at),
    status: r.status as ReviewRequest["status"],
    createdBy: r.created_by as string,
    createdAt: date(r.created_at),
    remindedAt: dateOrNull(r.reminded_at),
    reviewers,
  };
}

const mapReviewer = (r: SqlRow): Reviewer => ({
  email: r.email as string,
  userId: (r.user_id as string | null) ?? null,
  decision: (r.decision as Decision | null) ?? null,
  decidedAt: dateOrNull(r.decided_at),
});

export function createReviewRepository(executor: SqlExecutor): ReviewRepository {
  const rows = async (text: string, params: unknown[]) => (await executor.execute(text, params)).rows;
  const one = async (text: string, params: unknown[]) => (await rows(text, params))[0];

  async function threadWithComments(orgId: Uuid, row: SqlRow): Promise<Thread> {
    const comments = await rows(`SELECT * FROM review_comments WHERE org_id = $1 AND thread_id = $2 ORDER BY created_at, id`, [orgId, row.id]);
    return mapThread(row, comments.map(mapComment));
  }
  async function requestWithReviewers(orgId: Uuid, row: SqlRow): Promise<ReviewRequest> {
    const rs = await rows(`SELECT * FROM review_request_reviewers WHERE org_id = $1 AND request_id = $2 ORDER BY email`, [orgId, row.id]);
    return mapRequest(row, rs.map(mapReviewer));
  }
  const insertComment = (orgId: Uuid, threadId: Uuid, c: NewComment, now: Date) => ({
    text: `INSERT INTO review_comments (id, org_id, thread_id, author_kind, author_id, author_name, body, mentions_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    params: [c.id, orgId, threadId, c.authorKind, c.authorId, c.authorName, c.body, JSON.stringify(c.mentions), iso(now)],
  });

  return {
    async createThread(input) {
      try {
        await executeBatch(executor, [
          {
            text: `INSERT INTO review_threads (id, org_id, doc_id, anchor_json, version, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
            params: [input.id, input.orgId, input.docId, JSON.stringify(input.anchor), input.version, input.comment.authorId, iso(input.now)],
          },
          insertComment(input.orgId, input.id, input.comment, input.now),
        ]);
        return this.getThread(input.orgId, input.id);
      } catch {
        return fail("Failed to create thread");
      }
    },
    async listThreads(orgId, docId) {
      try {
        const ts = await rows(`SELECT * FROM review_threads WHERE org_id = $1 AND doc_id = $2 ORDER BY created_at, id`, [orgId, docId]);
        if (ts.length === 0) return { ok: true, value: [] };
        const cs = await rows(
          `SELECT c.* FROM review_comments c JOIN review_threads t ON t.id = c.thread_id AND t.org_id = c.org_id
            WHERE c.org_id = $1 AND t.doc_id = $2 ORDER BY c.created_at, c.id`,
          [orgId, docId],
        );
        const by = new Map<string, Comment[]>();
        for (const c of cs.map(mapComment)) by.set(c.threadId, [...(by.get(c.threadId) ?? []), c]);
        return { ok: true, value: ts.map((t) => mapThread(t, by.get(t.id as string) ?? [])) };
      } catch {
        return fail("Failed to list threads");
      }
    },
    async getThread(orgId, threadId) {
      try {
        const row = await one(`SELECT * FROM review_threads WHERE org_id = $1 AND id = $2`, [orgId, threadId]);
        return row ? { ok: true, value: await threadWithComments(orgId, row) } : notFound;
      } catch {
        return fail("Failed to get thread");
      }
    },
    async addComment(orgId, threadId, comment, now) {
      try {
        const t = await one(`SELECT id FROM review_threads WHERE org_id = $1 AND id = $2`, [orgId, threadId]);
        if (!t) return notFound;
        const results = await executeBatch(executor, [
          insertComment(orgId, threadId, comment, now),
          { text: `UPDATE review_threads SET updated_at = $3 WHERE org_id = $1 AND id = $2`, params: [orgId, threadId, iso(now)] },
        ]);
        const row = results[0]?.rows[0];
        return row ? { ok: true, value: mapComment(row) } : fail("Failed to add comment");
      } catch {
        return fail("Failed to add comment");
      }
    },
    async editComment(orgId, commentId, authorId, body, mentions, now) {
      try {
        const row = await one(
          `UPDATE review_comments SET body = $4, mentions_json = $5, edited_at = $6
            WHERE org_id = $1 AND id = $2 AND author_id = $3 AND deleted_at IS NULL RETURNING *`,
          [orgId, commentId, authorId, body, JSON.stringify(mentions), iso(now)],
        );
        return row ? { ok: true, value: mapComment(row) } : notFound;
      } catch {
        return fail("Failed to edit comment");
      }
    },
    async deleteComment(orgId, commentId, authorId, now) {
      try {
        const row = await one(
          `UPDATE review_comments SET deleted_at = $4, body = '[deleted]', mentions_json = '[]'
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL AND ($3 IS NULL OR author_id = $3) RETURNING *`,
          [orgId, commentId, authorId, iso(now)],
        );
        return row ? { ok: true, value: mapComment(row) } : notFound;
      } catch {
        return fail("Failed to delete comment");
      }
    },
    async setStatus(orgId, threadId, status, by, now) {
      try {
        const row = await one(
          `UPDATE review_threads SET status = $3, updated_at = $5,
                  resolved_by = CASE WHEN $3 = 'resolved' THEN $4 ELSE NULL END,
                  resolved_at = CASE WHEN $3 = 'resolved' THEN $5 ELSE NULL END
            WHERE org_id = $1 AND id = $2 AND status <> 'outdated' RETURNING *`,
          [orgId, threadId, status, by, iso(now)],
        );
        return row ? { ok: true, value: await threadWithComments(orgId, row) } : notFound;
      } catch {
        return fail("Failed to change thread status");
      }
    },
    async carry(orgId, threadId, fromVersion, toVersion, outcome, now) {
      try {
        // Only from the version it was at, so two readers carrying at once do it once.
        const row = await one(
          `UPDATE review_threads SET version = $4, status = $5, anchor_json = $6, updated_at = $7
            WHERE org_id = $1 AND id = $2 AND version = $3 RETURNING *`,
          [orgId, threadId, fromVersion, toVersion, outcome.status, JSON.stringify(outcome.anchor), iso(now)],
        );
        if (row) return { ok: true, value: await threadWithComments(orgId, row) };
        return this.getThread(orgId, threadId);
      } catch {
        return fail("Failed to carry thread");
      }
    },

    async createRequest(input) {
      try {
        const emails = [...new Set(input.reviewers.map((e) => e.trim().toLowerCase()))];
        await executeBatch(executor, [
          {
            text: `INSERT INTO review_requests (id, org_id, doc_id, version, message, due_at, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            params: [input.id, input.orgId, input.docId, input.version, input.message, input.dueAt ? iso(input.dueAt) : null, input.createdBy, iso(input.now)],
          },
          ...emails.map((email) => ({ text: `INSERT INTO review_request_reviewers (org_id, request_id, email) VALUES ($1, $2, $3)`, params: [input.orgId, input.id, email] })),
        ]);
        return this.getRequest(input.orgId, input.id);
      } catch {
        return fail("Failed to create review request");
      }
    },
    async listRequests(orgId, docId) {
      try {
        const rs = await rows(`SELECT * FROM review_requests WHERE org_id = $1 AND doc_id = $2 ORDER BY created_at DESC, id DESC`, [orgId, docId]);
        const out: ReviewRequest[] = [];
        for (const r of rs) out.push(await requestWithReviewers(orgId, r));
        return { ok: true, value: out };
      } catch {
        return fail("Failed to list review requests");
      }
    },
    async getRequest(orgId, requestId) {
      try {
        const row = await one(`SELECT * FROM review_requests WHERE org_id = $1 AND id = $2`, [orgId, requestId]);
        return row ? { ok: true, value: await requestWithReviewers(orgId, row) } : notFound;
      } catch {
        return fail("Failed to get review request");
      }
    },
    async decide(orgId, requestId, email, userId, decision, now) {
      try {
        const results = await executeBatch(executor, [
          {
            text: `UPDATE review_request_reviewers SET decision = $5, decided_at = $6, user_id = $4
                    WHERE org_id = $1 AND request_id = $2 AND email = $3
                      AND EXISTS (SELECT 1 FROM review_requests r WHERE r.org_id = $1 AND r.id = $2 AND r.status = 'open')
                   RETURNING email`,
            params: [orgId, requestId, email.trim().toLowerCase(), userId, decision, iso(now)],
          },
          {
            text: `UPDATE review_requests SET status = 'closed'
                    WHERE org_id = $1 AND id = $2 AND status = 'open'
                      AND NOT EXISTS (SELECT 1 FROM review_request_reviewers v WHERE v.org_id = $1 AND v.request_id = $2 AND v.decision IS NULL)`,
            params: [orgId, requestId],
          },
        ]);
        if (!results[0]?.rows.length) return notFound;
        return this.getRequest(orgId, requestId);
      } catch {
        return fail("Failed to record the decision");
      }
    },
    async cancelRequest(orgId, requestId) {
      try {
        const row = await one(`UPDATE review_requests SET status = 'canceled' WHERE org_id = $1 AND id = $2 AND status = 'open' RETURNING *`, [orgId, requestId]);
        return row ? { ok: true, value: await requestWithReviewers(orgId, row) } : notFound;
      } catch {
        return fail("Failed to cancel review request");
      }
    },
    async dueForReminder(now, windowMs, since, limit) {
      try {
        const rs = await rows(
          `SELECT * FROM review_requests
            WHERE status = 'open' AND due_at IS NOT NULL AND due_at <= $1
              AND (reminded_at IS NULL OR reminded_at < $2)
            ORDER BY due_at LIMIT $3`,
          [iso(new Date(now.getTime() + windowMs)), iso(since), limit],
        );
        const out: ReviewRequest[] = [];
        for (const r of rs) out.push(await requestWithReviewers(r.org_id as Uuid, r));
        return { ok: true, value: out };
      } catch {
        return fail("Failed to read due review requests");
      }
    },
    async markReminded(orgId, requestId, now) {
      try {
        await executor.execute(`UPDATE review_requests SET reminded_at = $3 WHERE org_id = $1 AND id = $2`, [orgId, requestId, iso(now)]);
        return { ok: true, value: undefined };
      } catch {
        return fail("Failed to mark reminded");
      }
    },
  };
}
