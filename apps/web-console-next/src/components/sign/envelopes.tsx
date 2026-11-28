"use client";

import * as React from "react";
import { CheckCircle2, ExternalLink, FileSignature, Mail, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import type { PublicEnvelope } from "@saas/contracts/sign";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { SIGNER_LABEL, STATUS_LABEL, actions, progress } from "@/lib/sign";
import { useOpenInEditor } from "@/components/drive/open-in-editor";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

/** The envelopes this person sent (PW6): status, signers, the evidence check, resend, void, the signed PDF. */
export function Envelopes({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const list = useApiQuery(qk.envelopes(orgId), () => wrap(() => client.sign.listEnvelopes(orgId)));
  const [open, setOpen] = React.useState<string | null>(null);

  if (list.loading) return <Skeleton className="h-32 w-full" />;
  if (list.error)
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Couldn&apos;t load your envelopes</CardTitle>
          <CardDescription>{list.error.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  const envelopes = list.data?.envelopes ?? [];
  if (envelopes.length === 0)
    return <EmptyState icon={FileSignature} title="No envelopes yet" description="Choose Request signatures… on a document in your drive." />;
  return (
    <ul className="space-y-3" aria-label="Envelopes">
      {envelopes.map((e) => (
        <li key={e.id}>
          <EnvelopeCard orgId={orgId} envelope={e} expanded={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} onChanged={list.reload} />
        </li>
      ))}
    </ul>
  );
}

function EnvelopeCard({ orgId, envelope: e, expanded, onToggle, onChanged }: { orgId: string; envelope: PublicEnvelope; expanded: boolean; onToggle: () => void; onChanged: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const openInEditor = useOpenInEditor(orgId);
  const [voiding, setVoiding] = React.useState(false);
  const can = actions(e);
  const evidence = useApiQuery(qk.envelopeEvidence(orgId, e.id), () => wrap(() => client.sign.evidence(orgId, e.id)), { enabled: expanded });

  return (
    <Card data-envelope={e.id}>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="text-left font-medium hover:underline" onClick={onToggle} aria-expanded={expanded}>
            {e.title}
          </button>
          <Badge variant={e.status === "completed" ? "success" : e.status === "declined" || e.status === "voided" || e.status === "expired" ? "destructive" : "secondary"}>{STATUS_LABEL[e.status]}</Badge>
        </div>
        <CardDescription>
          {e.documents.map((d) => d.name).join(", ")} · {progress(e)} · sent {when(e.sentAt) || "not yet"}
        </CardDescription>
        {expanded && (
          <div className="space-y-3 pt-2 text-sm">
            <ul className="space-y-1" aria-label="Signers">
              {e.signers.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {e.orderMode === "sequential" ? `${s.order}. ` : ""}
                    {s.name} &lt;{s.email}&gt;
                  </span>
                  <span className="flex items-center gap-1 text-muted-foreground">
                    {s.status === "signed" ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : s.status === "declined" ? <XCircle className="h-4 w-4 text-destructive" /> : <Mail className="h-4 w-4" />}
                    {SIGNER_LABEL[s.status]}
                    {s.signedAt ? ` · ${when(s.signedAt)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
            {e.signers.some((s) => s.declineReason) && <p className="text-muted-foreground">Reason given: {e.signers.find((s) => s.declineReason)?.declineReason}</p>}
            {e.status === "completing" && <p className="text-muted-foreground">Everyone has signed. The signed PDF is being sealed; it appears in your drive when it is ready.</p>}
            <p className="flex items-center gap-2" data-evidence>
              {evidence.data?.verdict.ok ? (
                <>
                  <ShieldCheck className="h-4 w-4 text-green-600" /> Evidence log intact ({evidence.data.events.length} events, chained by SHA-256)
                </>
              ) : evidence.data ? (
                <>
                  <ShieldAlert className="h-4 w-4 text-destructive" /> The evidence log does not verify
                </>
              ) : (
                <span className="text-muted-foreground">Checking the evidence log…</span>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {can.open && e.completedDocumentId && (
                <Button size="sm" onClick={() => openInEditor?.(e.completedDocumentId!)} disabled={!openInEditor}>
                  <ExternalLink className="h-4 w-4 mr-1" /> Open the signed PDF
                </Button>
              )}
              {can.resend && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const r = await wrap(() => client.sign.resend(orgId, e.id, { idempotencyKey: crypto.randomUUID() }));
                    toast(r.ok ? { kind: "success", title: "New links emailed", description: "Earlier links no longer work." } : { kind: "error", title: "Couldn't resend", description: r.error.message });
                  }}
                >
                  Resend
                </Button>
              )}
              {can.void && (
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => setVoiding(true)}>
                  Void
                </Button>
              )}
            </div>
          </div>
        )}
      </CardHeader>
      <ConfirmDialog
        open={voiding}
        onOpenChange={setVoiding}
        title="Void this envelope?"
        description="Its links stop working and signers are told it was withdrawn. This can't be undone."
        confirmLabel="Void"
        destructive
        onConfirm={async () => {
          const r = await wrap(() => client.sign.void(orgId, e.id, null, { idempotencyKey: crypto.randomUUID() }));
          if (!r.ok) toast({ kind: "error", title: "Couldn't void", description: r.error.message });
          setVoiding(false);
          onChanged();
        }}
      />
    </Card>
  );
}
