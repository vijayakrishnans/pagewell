import type {
  CommentResponse,
  CreateReviewRequest,
  CreateThreadRequest,
  ListReviewRequestsResponse,
  ListThreadsResponse,
  ReviewRequestResponse,
  RoomTicketResponse,
  ThreadResponse,
} from "@saas/contracts/review";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Pagewell's review (PW5): comment threads on a page of a document, review requests, and tickets
 * for the document's live room. Maps to `apps/review-worker` through api-edge.
 */
export class ReviewClient {
  constructor(private readonly transport: Transport) {}

  private org(orgId: string): string {
    return `/v1/organizations/${encodeURIComponent(orgId)}`;
  }

  /** Threads on a document, anchors carried to its current version. */
  listThreads(orgId: string, docId: string, opts: RequestOptions = {}): Promise<ListThreadsResponse> {
    return this.transport.request<ListThreadsResponse>({ method: "GET", path: `${this.org(orgId)}/documents/${encodeURIComponent(docId)}/threads` }, opts);
  }

  startThread(orgId: string, docId: string, body: CreateThreadRequest, opts: RequestOptions = {}): Promise<ThreadResponse> {
    return this.transport.request<ThreadResponse>({ method: "POST", path: `${this.org(orgId)}/documents/${encodeURIComponent(docId)}/threads`, body }, opts);
  }

  reply(orgId: string, threadId: string, body: string, opts: RequestOptions = {}): Promise<CommentResponse> {
    return this.transport.request<CommentResponse>({ method: "POST", path: `${this.org(orgId)}/threads/${encodeURIComponent(threadId)}/comments`, body: { body } }, opts);
  }

  setStatus(orgId: string, threadId: string, status: "open" | "resolved", opts: RequestOptions = {}): Promise<ThreadResponse> {
    return this.transport.request<ThreadResponse>({ method: "PATCH", path: `${this.org(orgId)}/threads/${encodeURIComponent(threadId)}`, body: { status } }, opts);
  }

  editComment(orgId: string, threadId: string, commentId: string, body: string, opts: RequestOptions = {}): Promise<CommentResponse> {
    return this.transport.request<CommentResponse>({ method: "PATCH", path: `${this.org(orgId)}/threads/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(commentId)}`, body: { body } }, opts);
  }

  async deleteComment(orgId: string, threadId: string, commentId: string, opts: RequestOptions = {}): Promise<void> {
    await this.transport.send({ method: "DELETE", path: `${this.org(orgId)}/threads/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(commentId)}` }, opts);
  }

  listRequests(orgId: string, docId: string, opts: RequestOptions = {}): Promise<ListReviewRequestsResponse> {
    return this.transport.request<ListReviewRequestsResponse>({ method: "GET", path: `${this.org(orgId)}/documents/${encodeURIComponent(docId)}/review-requests` }, opts);
  }

  /** Ask people to review (each is shared the document as a commenter and emailed). */
  requestReview(orgId: string, docId: string, body: CreateReviewRequest, opts: RequestOptions = {}): Promise<ReviewRequestResponse> {
    return this.transport.request<ReviewRequestResponse>({ method: "POST", path: `${this.org(orgId)}/documents/${encodeURIComponent(docId)}/review-requests`, body }, opts);
  }

  decide(orgId: string, requestId: string, decision: "approved" | "changes_requested", opts: RequestOptions = {}): Promise<ReviewRequestResponse> {
    return this.transport.request<ReviewRequestResponse>({ method: "POST", path: `${this.org(orgId)}/review-requests/${encodeURIComponent(requestId)}/decision`, body: { decision } }, opts);
  }

  async cancelRequest(orgId: string, requestId: string, opts: RequestOptions = {}): Promise<void> {
    await this.transport.send({ method: "DELETE", path: `${this.org(orgId)}/review-requests/${encodeURIComponent(requestId)}` }, opts);
  }

  /** A single-use ticket (60 s) to open the document's room: `wss://<api>/v1/organizations/{org}/documents/{doc}/room?ticket=…`. */
  roomTicket(orgId: string, docId: string, opts: RequestOptions = {}): Promise<RoomTicketResponse> {
    return this.transport.request<RoomTicketResponse>({ method: "POST", path: `${this.org(orgId)}/documents/${encodeURIComponent(docId)}/room/ticket` }, opts);
  }
}
