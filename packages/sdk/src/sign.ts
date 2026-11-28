import type { EnvelopeInput, EnvelopeResponse, EvidenceResponse, FieldValueInput, ListEnvelopesResponse, SigningSession } from "@saas/contracts/sign";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Pagewell's e-sign (PW6): envelopes for a sender (signed in), and the signer's side of a
 * signing link (no account; the token is the key). Maps to `apps/sign-worker` through api-edge.
 * A simple electronic signature with an audit trail.
 */
export class SignClient {
  constructor(private readonly transport: Transport) {}

  private env(orgId: string, envelopeId?: string): string {
    return `/v1/organizations/${encodeURIComponent(orgId)}/envelopes${envelopeId ? `/${encodeURIComponent(envelopeId)}` : ""}`;
  }

  listEnvelopes(orgId: string, opts: RequestOptions = {}): Promise<ListEnvelopesResponse> {
    return this.transport.request<ListEnvelopesResponse>({ method: "GET", path: this.env(orgId) }, opts);
  }
  createEnvelope(orgId: string, body: EnvelopeInput, opts: RequestOptions = {}): Promise<EnvelopeResponse> {
    return this.transport.request<EnvelopeResponse>({ method: "POST", path: this.env(orgId), body }, opts);
  }
  getEnvelope(orgId: string, envelopeId: string, opts: RequestOptions = {}): Promise<EnvelopeResponse> {
    return this.transport.request<EnvelopeResponse>({ method: "GET", path: this.env(orgId, envelopeId) }, opts);
  }
  updateEnvelope(orgId: string, envelopeId: string, body: EnvelopeInput, opts: RequestOptions = {}): Promise<EnvelopeResponse> {
    return this.transport.request<EnvelopeResponse>({ method: "PATCH", path: this.env(orgId, envelopeId), body }, opts);
  }
  /** Freeze the documents and give the first signers their links. */
  send(orgId: string, envelopeId: string, opts: RequestOptions = {}): Promise<EnvelopeResponse> {
    return this.transport.request<EnvelopeResponse>({ method: "POST", path: `${this.env(orgId, envelopeId)}/send` }, opts);
  }
  resend(orgId: string, envelopeId: string, opts: RequestOptions = {}): Promise<{ resent: number }> {
    return this.transport.request<{ resent: number }>({ method: "POST", path: `${this.env(orgId, envelopeId)}/resend` }, opts);
  }
  void(orgId: string, envelopeId: string, reason: string | null = null, opts: RequestOptions = {}): Promise<EnvelopeResponse> {
    return this.transport.request<EnvelopeResponse>({ method: "POST", path: `${this.env(orgId, envelopeId)}/void`, body: { reason } }, opts);
  }
  /** The evidence log and whether its hash chain verifies. */
  evidence(orgId: string, envelopeId: string, opts: RequestOptions = {}): Promise<EvidenceResponse> {
    return this.transport.request<EvidenceResponse>({ method: "GET", path: `${this.env(orgId, envelopeId)}/evidence` }, opts);
  }

  // ---- the signer's side (no account) ----

  private s(token: string): string {
    return `/v1/s/${encodeURIComponent(token)}`;
  }
  signingSession(token: string, opts: RequestOptions = {}): Promise<{ session: SigningSession }> {
    return this.transport.request<{ session: SigningSession }>({ method: "GET", path: this.s(token) }, opts);
  }
  sendCode(token: string, opts: RequestOptions = {}): Promise<{ sent: boolean }> {
    return this.transport.request<{ sent: boolean }>({ method: "POST", path: `${this.s(token)}/code` }, opts);
  }
  verifyCode(token: string, code: string, opts: RequestOptions = {}): Promise<{ verified: boolean }> {
    return this.transport.request<{ verified: boolean }>({ method: "POST", path: `${this.s(token)}/verify`, body: { code } }, opts);
  }
  submit(token: string, values: FieldValueInput[], opts: RequestOptions = {}): Promise<{ signed: boolean; envelopeStatus: string }> {
    return this.transport.request<{ signed: boolean; envelopeStatus: string }>({ method: "POST", path: `${this.s(token)}/submit`, body: { consent: true, values } }, opts);
  }
  decline(token: string, reason: string | null = null, opts: RequestOptions = {}): Promise<{ declined: boolean }> {
    return this.transport.request<{ declined: boolean }>({ method: "POST", path: `${this.s(token)}/decline`, body: { reason } }, opts);
  }
}
