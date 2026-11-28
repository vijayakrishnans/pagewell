"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import type { PublicDocument } from "@saas/contracts/files";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { SPOTS, envelopeRequest, type SignerRow, type Spot } from "@/lib/sign";

/**
 * Request signatures on a document (PW6): who signs, in what order, where each signs, then send.
 * Each signer gets an email with a link and confirms their address with a code; no account.
 */
export function RequestSignaturesDialog({ orgId, orgSlug, doc, onClose }: { orgId: string; orgSlug: string; doc: PublicDocument; onClose: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const lastPage = doc.pageCount ?? 1;
  const blank = (): SignerRow => ({ name: "", email: "", page: lastPage, spot: "bottom-left", withDate: true });
  const [title, setTitle] = React.useState(doc.name.replace(/\.pdf$/i, ""));
  const [message, setMessage] = React.useState("");
  const [orderMode, setOrderMode] = React.useState<"parallel" | "sequential">("parallel");
  const [reminders, setReminders] = React.useState(true);
  const [signers, setSigners] = React.useState<SignerRow[]>([blank()]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const set = (i: number, patch: Partial<SignerRow>) => setSigners((cur) => cur.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const send = async () => {
    const built = envelopeRequest(doc.id, doc.pageCount, { title, message, orderMode, reminderDays: reminders ? 3 : null, signers });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    const created = await wrap(() => client.sign.createEnvelope(orgId, built.request, { idempotencyKey: crypto.randomUUID() }));
    if (!created.ok) {
      setBusy(false);
      setError(created.error.code === "not_found" ? "You need to be able to share this document to send it for signature." : created.error.message);
      return;
    }
    const sent = await wrap(() => client.sign.send(orgId, created.data.envelope.id, { idempotencyKey: crypto.randomUUID() }));
    setBusy(false);
    if (!sent.ok) {
      setError(`Saved as a draft, but not sent: ${sent.error.message}`);
      return;
    }
    toast({ kind: "success", title: "Sent for signature", description: orderMode === "sequential" ? "The first signer has been emailed." : "Every signer has been emailed." });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Request signatures</DialogTitle>
          <DialogDescription className="truncate">{doc.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="sign-title">Title</Label>
            <Input id="sign-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sign-message">Message (optional)</Label>
            <textarea id="sign-message" className="w-full rounded-md border bg-background px-3 py-2 text-sm" rows={2} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Signers</Label>
            {signers.map((s, i) => (
              <div key={i} className="rounded-md border p-3 space-y-2" data-signer={i}>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input aria-label={`Signer ${i + 1} name`} placeholder="Name" value={s.name} maxLength={200} onChange={(e) => set(i, { name: e.target.value })} />
                  <Input aria-label={`Signer ${i + 1} email`} placeholder="Email" type="email" value={s.email} onChange={(e) => set(i, { email: e.target.value })} />
                  {signers.length > 1 && (
                    <Button variant="ghost" size="icon" aria-label={`Remove signer ${i + 1}`} onClick={() => setSigners((cur) => cur.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>Signs on page</span>
                  <Input aria-label={`Signer ${i + 1} page`} className="w-20" type="number" min={1} max={lastPage} value={s.page} onChange={(e) => set(i, { page: Number(e.target.value) })} />
                  <Select value={s.spot} onValueChange={(v) => set(i, { spot: v as Spot })}>
                    <SelectTrigger className="w-40" aria-label={`Signer ${i + 1} spot`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SPOTS.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <label className="flex items-center gap-2">
                    <Checkbox checked={s.withDate} onCheckedChange={(v) => set(i, { withDate: v === true })} aria-label={`Signer ${i + 1} adds the date`} />
                    with the date
                  </label>
                </div>
              </div>
            ))}
            {signers.length < 20 && (
              <Button variant="outline" size="sm" onClick={() => setSigners((cur) => [...cur, { ...blank(), spot: cur.length % 2 ? "bottom-left" : "bottom-right" }])}>
                <Plus className="h-4 w-4 mr-1" /> Add a signer
              </Button>
            )}
          </div>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={orderMode === "sequential"} onCheckedChange={(v) => setOrderMode(v === true ? "sequential" : "parallel")} aria-label="Sign in the order listed" />
              Sign in the order listed (each is emailed when the one before has signed)
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={reminders} onCheckedChange={(v) => setReminders(v === true)} aria-label="Remind every 3 days" />
              Remind signers every 3 days
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            A simple electronic signature with an audit trail: each signer confirms their email address with a code, and the finished PDF is sealed with a digital signature and a certificate page. The
            document is sent as it is now; later edits don&apos;t change it. <Link className="underline" href={`/orgs/${orgSlug}/envelopes`}>Your envelopes</Link>
          </p>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void send()} disabled={busy}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
