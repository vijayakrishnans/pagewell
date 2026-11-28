"use client";

import * as React from "react";
import type { PublicDocument } from "@saas/contracts/files";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";

/** A document's activity (PW3): uploads, saves, restores, shares and link opens, newest first. */
export function ActivityDialog({ orgId, doc, onClose }: { orgId: string; doc: PublicDocument; onClose: () => void }) {
  const { client } = useSession();
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [older, setOlder] = React.useState<Array<{ id: string; description: string; occurredAt: string }>>([]);
  const first = useApiQuery(qk.driveActivity(orgId, doc.id), () => wrap(() => client.files.activity(orgId, doc.id, { limit: 30 })));
  const next = cursor ?? first.data?.nextCursor ?? null;
  const more = async () => {
    if (!next) return;
    const r = await wrap(() => client.files.activity(orgId, doc.id, { limit: 30, cursor: next }));
    if (r.ok) {
      setOlder((cur) => [...cur, ...r.data.entries]);
      setCursor(r.data.nextCursor ?? "");
    }
  };
  const entries = [...(first.data?.entries ?? []), ...older];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Activity</DialogTitle>
          <DialogDescription className="truncate">{doc.name}</DialogDescription>
        </DialogHeader>
        {first.loading ? (
          <Skeleton className="h-24 w-full" />
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ol className="max-h-96 space-y-3 overflow-y-auto" aria-label="Activity">
            {entries.map((e) => (
              <li key={e.id} className="text-sm">
                <div>{e.description}</div>
                <time className="text-xs text-muted-foreground" dateTime={e.occurredAt}>
                  {new Date(e.occurredAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        )}
        {next && (
          <Button variant="ghost" onClick={() => void more()}>
            Show older
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
