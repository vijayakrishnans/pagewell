"use client";

import * as React from "react";
import { ExternalLink, Loader2, Wrench, X } from "lucide-react";
import type { PublicDocument } from "@saas/contracts/files";
import type { JobOperation, PublicJob } from "@saas/contracts/jobs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { TOOLS, isActive, jobRequest, jobSummary, primaryFile, toolFor, type ToolForm } from "@/lib/jobs";

/** Run a heavy job on a document (PW4): pick a tool, answer what it asks, start it. */
export function RunToolDialog({
  orgId,
  doc,
  siblings,
  onStarted,
  onClose,
}: {
  orgId: string;
  doc: PublicDocument;
  siblings: PublicDocument[];
  onStarted: (job: PublicJob) => void;
  onClose: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [op, setOp] = React.useState<JobOperation>("ocr");
  const [form, setForm] = React.useState<ToolForm>({ output: "version" });
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const tool = toolFor(op);

  const start = async () => {
    const built = jobRequest(op, doc.id, doc.pageCount, form);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    const r = await wrap(() => client.jobs.create(orgId, built.request, { idempotencyKey: crypto.randomUUID() }));
    setBusy(false);
    if (!r.ok) {
      setError(r.error.code === "runner_unavailable" ? "Heavy tools aren't available here yet." : r.error.code === "jobs_busy" ? r.error.message : r.error.message);
      return;
    }
    toast({ kind: "success", title: `${tool.label} started` });
    onStarted(r.data.job);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Run a tool</DialogTitle>
          <DialogDescription className="truncate">{doc.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Tool</Label>
            <Select
              value={op}
              onValueChange={(v) => {
                setOp(v as JobOperation);
                setError(null);
              }}
            >
              <SelectTrigger aria-label="Tool">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TOOLS.map((t) => (
                  <SelectItem key={t.operation} value={t.operation}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{tool.description}</p>
          </div>

          {tool.asks.includes("degrees") && (
            <div className="space-y-1">
              <Label>Turn by</Label>
              <Select value={String(form.degrees ?? 90)} onValueChange={(v) => setForm({ ...form, degrees: Number(v) as 90 | 180 | 270 })}>
                <SelectTrigger aria-label="Degrees">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[90, 180, 270].map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d}° clockwise
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {tool.asks.includes("pages") && (
            <div className="space-y-1">
              <Label htmlFor="tool-pages">Pages{op === "extract" ? "" : " (all if empty)"}</Label>
              <Input id="tool-pages" placeholder={op === "render" ? "1" : "1, 3-5"} value={form.pages ?? ""} onChange={(e) => setForm({ ...form, pages: e.target.value })} />
            </div>
          )}
          {tool.asks.includes("every") && (
            <div className="space-y-1">
              <Label htmlFor="tool-every">A new document every … pages</Label>
              <Input id="tool-every" type="number" min={1} value={form.every ?? 1} onChange={(e) => setForm({ ...form, every: Number(e.target.value) })} />
            </div>
          )}
          {tool.asks.includes("preset") && (
            <div className="space-y-1">
              <Label>Quality</Label>
              <Select value={form.preset ?? "standard"} onValueChange={(v) => setForm({ ...form, preset: v as "standard" | "mobile" })}>
                <SelectTrigger aria-label="Compression">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="mobile">Smallest (for phones)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {tool.asks.includes("merge-with") && (
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Merge with, in this order after “{doc.name}”</legend>
              {siblings.filter((d) => d.id !== doc.id).length === 0 && <p className="text-xs text-muted-foreground">There are no other documents in this folder.</p>}
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {siblings
                  .filter((d) => d.id !== doc.id)
                  .map((d) => {
                    const chosen = form.mergeWith?.includes(d.id) ?? false;
                    return (
                      <li key={d.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          id={`merge-${d.id}`}
                          checked={chosen}
                          onCheckedChange={(c) => setForm({ ...form, mergeWith: c ? [...(form.mergeWith ?? []), d.id] : (form.mergeWith ?? []).filter((x) => x !== d.id) })}
                        />
                        <Label htmlFor={`merge-${d.id}`} className="truncate font-normal">
                          {d.name}
                        </Label>
                      </li>
                    );
                  })}
              </ul>
            </fieldset>
          )}
          {tool.versioning && (
            <div className="space-y-1">
              <Label>Result</Label>
              <Select value={form.output ?? "version"} onValueChange={(v) => setForm({ ...form, output: v as "version" | "document" })}>
                <SelectTrigger aria-label="Result">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="version">Save as the next version</SelectItem>
                  <SelectItem value="document">Save as a new document</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void start()} disabled={busy}>
            <Wrench className="mr-1.5 h-4 w-4" />
            Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The jobs started from this page: each polled until it ends; a finished file opens in a new tab. */
export function JobsTray({ orgId, jobs, onUpdate, onDismiss, onFinished }: { orgId: string; jobs: PublicJob[]; onUpdate: (job: PublicJob) => void; onDismiss: (id: string) => void; onFinished: (job: PublicJob) => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const active = jobs.filter(isActive).map((j) => j.id).join(",");

  React.useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(async () => {
      for (const id of active.split(",")) {
        const r = await wrap(() => client.jobs.get(orgId, id));
        if (!r.ok) continue;
        onUpdate(r.data.job);
        if (!isActive(r.data.job)) {
          toast({ kind: r.data.job.status === "succeeded" ? "success" : "error", title: jobSummary(r.data.job) });
          onFinished(r.data.job);
        }
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [active, client, orgId, onUpdate, onFinished, toast]);

  const open = async (job: PublicJob, name: string) => {
    // Opened before the fetch so the browser keeps the new tab as the user's own action.
    const tab = window.open("", "_blank");
    const r = await wrap(async () => (await client.jobs.file(orgId, job.id, name)).blob());
    if (!r.ok) {
      tab?.close();
      toast({ kind: "error", title: "Couldn't open the result", description: r.error.message });
      return;
    }
    const url = URL.createObjectURL(r.data);
    if (tab) tab.location.href = url;
    else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  if (jobs.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-xl border bg-card p-3 text-sm" aria-label="Tools running">
      {jobs.map((job) => {
        const file = job.status === "succeeded" ? primaryFile(job) : null;
        return (
          <li key={job.id} className="flex items-center gap-2">
            {isActive(job) ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <Wrench className="h-4 w-4 text-muted-foreground" />}
            <span className={`min-w-0 flex-1 truncate ${job.status === "failed" ? "text-destructive" : ""}`}>{jobSummary(job)}</span>
            {file && (
              <Button variant="ghost" size="sm" onClick={() => void open(job, file)}>
                <ExternalLink className="mr-1 h-4 w-4" />
                Open
              </Button>
            )}
            {!isActive(job) && (
              <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={() => onDismiss(job.id)}>
                <X className="h-4 w-4" />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
