import type { PublicComment, PublicReviewRequest, PublicThread } from "@saas/contracts/review";
import type { Comment, ReviewRequest, Thread } from "@saas/db/review";
import { toPublic } from "./ids.js";

export function publicComment(c: Comment): PublicComment {
  return {
    id: toPublic("cmt", c.id),
    author: { kind: c.authorKind, id: c.authorId, name: c.authorName },
    body: c.body,
    mentions: c.mentions,
    createdAt: c.createdAt.toISOString(),
    editedAt: c.editedAt?.toISOString() ?? null,
    deleted: Boolean(c.deletedAt),
  };
}

export function publicThread(t: Thread): PublicThread {
  return {
    id: toPublic("thr", t.id),
    documentId: toPublic("doc", t.docId),
    anchor: t.anchor,
    version: t.version,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    comments: t.comments.map(publicComment),
  };
}

/** A review request; reviewers' account ids are not shown, only their emails and decisions. */
export function publicRequest(r: ReviewRequest): PublicReviewRequest {
  return {
    id: toPublic("rvr", r.id),
    documentId: toPublic("doc", r.docId),
    version: r.version,
    message: r.message,
    dueAt: r.dueAt?.toISOString() ?? null,
    status: r.status,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    reviewers: r.reviewers.map((v) => ({ email: v.email, decision: v.decision, decidedAt: v.decidedAt?.toISOString() ?? null })),
  };
}
