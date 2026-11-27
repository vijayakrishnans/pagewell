"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FileText, Folder, RotateCcw, Trash2 } from "lucide-react";
import type { PublicTrashEntry } from "@saas/contracts/files";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { purgeIn } from "@/lib/drive";

/** What is in the org's trash, and restore. Items are removed for good after 30 days. */
export default function TrashPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={org.slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const trash = useApiQuery(qk.driveTrash(orgId), () => wrap(async () => (await client.files.listTrash(orgId)).entries));

  const restore = async (e: PublicTrashEntry) => {
    const r = e.kind === "folder" ? await wrap(() => client.files.restoreFolder(orgId, e.id)) : await wrap(() => client.files.restoreDocument(orgId, e.id));
    if (!r.ok) {
      toast({ kind: "error", title: "Restore failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Restored ${e.name}` });
    trash.reload();
  };

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <Link href={`/orgs/${orgSlug}/drive`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" />
            Drive
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Trash</h1>
          <p className="text-sm text-muted-foreground">Items here are removed for good 30 days after they were trashed.</p>
        </div>
      </header>
      {trash.loading ? (
        <Skeleton className="h-24 w-full" />
      ) : (trash.data ?? []).length === 0 ? (
        <EmptyState icon={Trash2} title="The trash is empty" description="Anything you move to the trash shows up here for 30 days." />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Trashed items">
          {(trash.data ?? []).map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-4 py-3">
              {e.kind === "folder" ? <Folder className="h-5 w-5 text-primary" /> : <FileText className="h-5 w-5 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate font-medium">{e.name}</span>
              <span className="hidden text-xs text-muted-foreground sm:block">Removed for good {purgeIn(e.purgeAt)}</span>
              <Button variant="outline" size="sm" onClick={() => void restore(e)}>
                <RotateCcw className="h-4 w-4 mr-1.5" />
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
