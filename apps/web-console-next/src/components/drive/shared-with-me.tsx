"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, FileText, Folder, Users } from "lucide-react";
import type { SharedItem } from "@saas/contracts/sharing";
import type { PublicDocument } from "@saas/contracts/files";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { formatBytes } from "@/lib/drive";
import { roleLabel } from "@/lib/sharing";
import { useOpenInEditor } from "./open-in-editor";

function OpenDocument({ orgId, docId, name }: { orgId: string; docId: string; name: string }) {
  const open = useOpenInEditor(orgId);
  return (
    <button type="button" className="min-w-0 flex-1 truncate text-left font-medium hover:underline" disabled={!open} onClick={() => open?.(docId)}>
      {name}
    </button>
  );
}

/** Shared with me (PW3): what others shared with the signed-in person, in any organization. */
export function SharedWithMe() {
  const { client } = useSession();
  const items = useApiQuery(qk.sharedWithMe(), () => wrap(async () => (await client.files.sharedWithMe()).items));
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Shared with me</h1>
        <p className="text-sm text-muted-foreground">Folders and documents people shared with you, by your account or your email address.</p>
      </header>
      {items.loading ? (
        <Skeleton className="h-32 w-full" />
      ) : items.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">Couldn't load what's shared with you</CardTitle>
            <CardDescription>{items.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : (items.data ?? []).length === 0 ? (
        <EmptyState icon={Users} title="Nothing shared with you yet" description="When someone shares a folder or document with you, it shows up here." />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Shared with me">
          {(items.data ?? []).map((item: SharedItem) => (
            <li key={`${item.orgId}:${item.resource.id}`} className="flex items-center gap-3 px-4 py-3">
              {item.resource.kind === "folder" ? (
                <>
                  <Folder className="h-5 w-5 shrink-0 text-primary" />
                  <Link href={`/shared/${item.orgId}/${item.resource.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                    {item.name}
                  </Link>
                </>
              ) : (
                <>
                  <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <OpenDocument orgId={item.orgId} docId={item.resource.id} name={item.name} />
                  {item.document && <span className="hidden text-xs text-muted-foreground sm:block">v{item.document.currentVersion} · {formatBytes(item.document.size)}</span>}
                </>
              )}
              <span className="text-xs text-muted-foreground">{roleLabel(item.role)}</span>
              <span className="hidden text-xs text-muted-foreground md:block">{new Date(item.updatedAt).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A folder someone shared with you: its contents, and the path from the shared folder down. */
export function SharedFolder({ orgId, folderId }: { orgId: string; folderId: string }) {
  const { client } = useSession();
  const listing = useApiQuery(qk.sharedFolder(orgId, folderId), () => wrap(() => client.files.listFolder(orgId, folderId)));
  const data = listing.data;
  return (
    <div className="space-y-5">
      <header>
        <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <Link href="/shared" className="hover:text-foreground">
            Shared with me
          </Link>
          {data?.breadcrumb.map((b) => (
            <React.Fragment key={b.id}>
              <ChevronRight className="h-3.5 w-3.5" />
              <Link href={`/shared/${orgId}/${b.id}`} className="max-w-[12rem] truncate hover:text-foreground">
                {b.name}
              </Link>
            </React.Fragment>
          ))}
        </nav>
        <h1 className="truncate text-xl font-semibold tracking-tight">{data?.folder?.name ?? "Shared folder"}</h1>
      </header>
      {listing.loading ? (
        <Skeleton className="h-32 w-full" />
      ) : listing.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">This folder isn't shared with you</CardTitle>
            <CardDescription>It may have been unshared or moved to the trash. Make sure you signed in with the email it was shared to.</CardDescription>
          </CardHeader>
        </Card>
      ) : !data || data.folders.length + data.documents.length === 0 ? (
        <EmptyState icon={Folder} title="This folder is empty" description="Nothing has been added to it yet." />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Files">
          {data.folders.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-4 py-3">
              <Folder className="h-5 w-5 shrink-0 text-primary" />
              <Link href={`/shared/${orgId}/${f.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                {f.name}
              </Link>
            </li>
          ))}
          {data.documents.map((d: PublicDocument) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-3">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <OpenDocument orgId={orgId} docId={d.id} name={d.name} />
              <span className="hidden text-xs text-muted-foreground sm:block">
                v{d.currentVersion} · {formatBytes(d.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
