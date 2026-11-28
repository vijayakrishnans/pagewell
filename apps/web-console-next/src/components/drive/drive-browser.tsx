"use client";

import * as React from "react";
import Link from "next/link";
import {
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  History,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Share2,
  Trash2,
  Upload,
  Activity,
  Wrench,
  FileSignature,
} from "lucide-react";
import type { FolderListingResponse, PublicDocument, PublicFolder, PublicVersion } from "@saas/contracts/files";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { formatBytes, pdfFiles, uploadMode, usagePercent } from "@/lib/drive";
import { useOpenInEditor } from "./open-in-editor";
import { ShareDialog } from "./share-dialog";
import { ActivityDialog } from "./activity-dialog";
import { JobsTray, RunToolDialog } from "./run-tool";
import { RequestSignaturesDialog } from "./request-signatures";
import type { PublicJob } from "@saas/contracts/jobs";

type Item = { kind: "folder"; folder: PublicFolder } | { kind: "document"; doc: PublicDocument };

interface Props {
  orgId: string;
  orgSlug: string;
  folderId: string | null;
}

/** The drive: a folder's contents, with upload, new folder, rename, versions and trash. */
export function DriveBrowser({ orgId, orgSlug, folderId }: Props) {
  const { client } = useSession();
  const { toast } = useToast();
  const openInEditor = useOpenInEditor(orgId);
  const listing = useApiQuery(qk.driveFolder(orgId, folderId), () => wrap(() => client.files.listFolder(orgId, folderId)));
  const quota = useApiQuery(qk.driveQuota(orgId), () => wrap(async () => (await client.files.quota(orgId)).quota));
  const [uploads, setUploads] = React.useState<Array<{ name: string; progress: number; error?: string }>>([]);
  const [dragging, setDragging] = React.useState(false);
  const [newFolder, setNewFolder] = React.useState(false);
  const [renaming, setRenaming] = React.useState<Item | null>(null);
  const [trashing, setTrashing] = React.useState<Item | null>(null);
  const [versionsOf, setVersionsOf] = React.useState<PublicDocument | null>(null);
  const [sharing, setSharing] = React.useState<Item | null>(null);
  const [activityOf, setActivityOf] = React.useState<PublicDocument | null>(null);
  const [signingFor, setSigningFor] = React.useState<PublicDocument | null>(null);
  const [toolFor, setToolFor] = React.useState<PublicDocument | null>(null);
  const [jobs, setJobs] = React.useState<PublicJob[]>([]);
  const updateJob = React.useCallback((job: PublicJob) => setJobs((cur) => cur.map((j) => (j.id === job.id ? job : j))), []);
  const picker = React.useRef<HTMLInputElement>(null);

  const refresh = React.useCallback(() => {
    listing.reload();
    quota.reload();
  }, [listing, quota]);

  const upload = async (files: File[]) => {
    const { accepted, rejected } = pdfFiles(files);
    if (rejected.length) toast({ kind: "warning", title: "Only PDFs can be uploaded", description: rejected.map((f) => f.name).join(", ") });
    for (const file of accepted) {
      const update = (patch: { progress?: number; error?: string }) =>
        setUploads((cur) => cur.map((u) => (u.name === file.name ? { ...u, ...patch } : u)));
      setUploads((cur) => [...cur.filter((u) => u.name !== file.name), { name: file.name, progress: 0 }]);
      const r = await wrap(async () => {
        if (uploadMode(file.size) === "single") {
          return client.files.upload(orgId, { name: file.name, pdf: file, folderId }, { idempotencyKey: crypto.randomUUID() });
        }
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        return client.files.uploadLarge(orgId, { file, name: file.name, sha256, folderId }, { onProgress: (sent, total) => update({ progress: sent / total }) });
      });
      if (r.ok) {
        setUploads((cur) => cur.filter((u) => u.name !== file.name));
        toast({ kind: "success", title: `Uploaded ${file.name}` });
      } else {
        update({ error: r.error.code === "quota_exceeded" ? r.error.message : `${r.error.message}` });
      }
    }
    refresh();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload([...e.dataTransfer.files]);
  };

  const download = async (doc: PublicDocument, version?: number) => {
    const r = await wrap(async () => (await client.files.content(orgId, doc.id, version)).blob());
    if (!r.ok) {
      toast({ kind: "error", title: "Download failed", description: r.error.message });
      return;
    }
    const url = URL.createObjectURL(r.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = version ? doc.name.replace(/\.pdf$/i, "") + ` (v${version}).pdf` : doc.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const data: FolderListingResponse | null = listing.data;
  const items: Item[] = data
    ? [...data.folders.map((folder) => ({ kind: "folder" as const, folder })), ...data.documents.map((doc) => ({ kind: "document" as const, doc }))]
    : [];
  const base = `/orgs/${orgSlug}/drive`;
  const used = quota.data?.storageBytes.used ?? 0;
  const limit = quota.data?.storageBytes.limit ?? null;
  const percent = usagePercent(used, limit);

  return (
    <div
      className={`space-y-5 rounded-xl ${dragging ? "outline outline-2 outline-dashed outline-primary/60" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            <Link href={base} className="hover:text-foreground">
              Drive
            </Link>
            {data?.breadcrumb.map((b) => (
              <React.Fragment key={b.id}>
                <ChevronRight className="h-3.5 w-3.5" />
                <Link href={`${base}/${b.id}`} className="hover:text-foreground truncate max-w-[12rem]">
                  {b.name}
                </Link>
              </React.Fragment>
            ))}
          </nav>
          <h1 className="text-xl font-semibold tracking-tight truncate">{data?.folder?.name ?? "Drive"}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href={`${base}/trash`}>
              <Trash2 className="h-4 w-4 mr-1.5" />
              Trash
            </Link>
          </Button>
          <Button variant="outline" onClick={() => setNewFolder(true)}>
            <FolderPlus className="h-4 w-4 mr-1.5" />
            New folder
          </Button>
          <Button onClick={() => picker.current?.click()}>
            <Upload className="h-4 w-4 mr-1.5" />
            Upload
          </Button>
          <input
            ref={picker}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(e) => {
              void upload([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      {quota.data && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-label="Storage used">
          <HardDrive className="h-4 w-4" />
          <span>
            {formatBytes(used)} of {limit === null ? "unlimited" : formatBytes(limit)} used
          </span>
          {percent !== null && (
            <div className="h-1.5 w-32 rounded-full bg-muted">
              <div className={`h-1.5 rounded-full ${percent >= 90 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
      )}

      <JobsTray
        orgId={orgId}
        jobs={jobs}
        onUpdate={updateJob}
        onDismiss={(id) => setJobs((cur) => cur.filter((j) => j.id !== id))}
        onFinished={() => refresh()}
      />

      {uploads.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.name} className="flex items-center gap-2">
              <Upload className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate">{u.name}</span>
              {u.error ? (
                <span className="text-destructive">{u.error}</span>
              ) : (
                <span className="text-muted-foreground">{u.progress > 0 ? `${Math.round(u.progress * 100)}%` : "uploading…"}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {listing.loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : listing.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{listing.error.code === "not_found" ? "This folder isn't here" : listing.error.code}</CardTitle>
            <CardDescription>{listing.error.code === "not_found" ? "It may have been moved to the trash." : listing.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={folderId ? "This folder is empty" : "Your drive is empty"}
          description="Upload a PDF, or drop one anywhere on this page."
          primaryAction={{ label: "Upload a PDF", onClick: () => picker.current?.click() }}
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Files">
          {items.map((item) => (
            <li key={item.kind === "folder" ? item.folder.id : item.doc.id} className="flex items-center gap-3 px-4 py-3">
              {item.kind === "folder" ? (
                <>
                  <Folder className="h-5 w-5 shrink-0 text-primary" />
                  <Link href={`${base}/${item.folder.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                    {item.folder.name}
                  </Link>
                  <span className="hidden text-xs text-muted-foreground sm:block">{new Date(item.folder.updatedAt).toLocaleDateString()}</span>
                </>
              ) : (
                <>
                  <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-medium hover:underline disabled:no-underline"
                    disabled={!openInEditor}
                    onClick={() => openInEditor?.(item.doc.id)}
                  >
                    {item.doc.name}
                  </button>
                  <span className="hidden text-xs text-muted-foreground sm:block">
                    v{item.doc.currentVersion} · {formatBytes(item.doc.size)}
                    {item.doc.pageCount ? ` · ${item.doc.pageCount} pages` : ""}
                  </span>
                  <span className="hidden text-xs text-muted-foreground md:block">{new Date(item.doc.updatedAt).toLocaleDateString()}</span>
                </>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={`Actions for ${item.kind === "folder" ? item.folder.name : item.doc.name}`}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {item.kind === "document" && (
                    <>
                      <DropdownMenuItem disabled={!openInEditor} onSelect={() => openInEditor?.(item.doc.id)}>
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Open in editor
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setVersionsOf(item.doc)}>
                        <History className="h-4 w-4 mr-2" />
                        Version history
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setToolFor(item.doc)}>
                        <Wrench className="h-4 w-4 mr-2" />
                        Run a tool…
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setSigningFor(item.doc)}>
                        <FileSignature className="h-4 w-4 mr-2" />
                        Request signatures…
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setActivityOf(item.doc)}>
                        <Activity className="h-4 w-4 mr-2" />
                        Activity
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void download(item.doc)}>
                        <Download className="h-4 w-4 mr-2" />
                        Download
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuItem onSelect={() => setSharing(item)}>
                    <Share2 className="h-4 w-4 mr-2" />
                    Share…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRenaming(item)}>
                    <Pencil className="h-4 w-4 mr-2" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onSelect={() => setTrashing(item)}>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Move to trash
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}

      <NameDialog
        open={newFolder}
        title="New folder"
        label="Folder name"
        initial=""
        submitLabel="Create"
        onClose={() => setNewFolder(false)}
        onSubmit={async (name) => {
          const r = await wrap(() => client.files.createFolder(orgId, { name, parentId: folderId }, { idempotencyKey: crypto.randomUUID() }));
          if (!r.ok) return r.error.message;
          refresh();
          return null;
        }}
      />

      <NameDialog
        open={renaming !== null}
        title="Rename"
        label="Name"
        initial={renaming ? (renaming.kind === "folder" ? renaming.folder.name : renaming.doc.name) : ""}
        submitLabel="Rename"
        onClose={() => setRenaming(null)}
        onSubmit={async (name) => {
          if (!renaming) return null;
          const r =
            renaming.kind === "folder"
              ? await wrap(() => client.files.updateFolder(orgId, renaming.folder.id, { name }))
              : await wrap(() => client.files.updateDocument(orgId, renaming.doc.id, { name }));
          if (!r.ok) return r.error.message;
          refresh();
          return null;
        }}
      />

      <ConfirmDialog
        open={trashing !== null}
        onOpenChange={(o) => !o && setTrashing(null)}
        title="Move to trash?"
        description={
          trashing?.kind === "folder"
            ? "The folder and everything in it move to the trash. They can be restored for 30 days."
            : "The document moves to the trash. It can be restored for 30 days."
        }
        resourceName={trashing ? (trashing.kind === "folder" ? trashing.folder.name : trashing.doc.name) : undefined}
        confirmLabel="Move to trash"
        onConfirm={async () => {
          if (!trashing) return;
          const r =
            trashing.kind === "folder"
              ? await wrap(() => client.files.trashFolder(orgId, trashing.folder.id))
              : await wrap(() => client.files.trashDocument(orgId, trashing.doc.id));
          if (!r.ok) toast({ kind: "error", title: "Couldn't move to trash", description: r.error.message });
          setTrashing(null);
          refresh();
        }}
      />

      {sharing && (
        <ShareDialog
          orgId={orgId}
          resource={
            sharing.kind === "folder"
              ? { kind: "folder", id: sharing.folder.id, name: sharing.folder.name }
              : { kind: "document", id: sharing.doc.id, name: sharing.doc.name }
          }
          onClose={() => setSharing(null)}
        />
      )}

      {toolFor && (
        <RunToolDialog
          orgId={orgId}
          doc={toolFor}
          siblings={data?.documents ?? []}
          onStarted={(job) => setJobs((cur) => [job, ...cur])}
          onClose={() => setToolFor(null)}
        />
      )}

      {signingFor && <RequestSignaturesDialog orgId={orgId} orgSlug={orgSlug} doc={signingFor} onClose={() => setSigningFor(null)} />}

      {activityOf && <ActivityDialog orgId={orgId} doc={activityOf} onClose={() => setActivityOf(null)} />}

      {versionsOf && (
        <VersionsDialog
          orgId={orgId}
          doc={versionsOf}
          onClose={() => setVersionsOf(null)}
          onDownload={(v) => void download(versionsOf, v)}
          onRestored={refresh}
        />
      )}
    </div>
  );
}

function NameDialog(props: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  /** Resolves to an error message, or null when done. */
  onSubmit: (name: string) => Promise<string | null>;
}) {
  const [name, setName] = React.useState(props.initial);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (props.open) {
      setName(props.initial);
      setError(null);
    }
  }, [props.open, props.initial]);
  const clean = name.trim();
  const valid = clean.length > 0 && clean.length <= 255 && !/[/\\]/.test(clean);
  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>Up to 255 characters, without slashes.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!valid) return;
            setBusy(true);
            const err = await props.onSubmit(clean);
            setBusy(false);
            if (err) setError(err);
            else props.onClose();
          }}
        >
          <Input aria-label={props.label} value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {props.submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VersionsDialog({
  orgId,
  doc,
  onClose,
  onDownload,
  onRestored,
}: {
  orgId: string;
  doc: PublicDocument;
  onClose: () => void;
  onDownload: (version: number) => void;
  onRestored: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const versions = useApiQuery(qk.driveVersions(orgId, doc.id), () => wrap(async () => (await client.files.listVersions(orgId, doc.id)).versions));
  const current = versions.data?.[0]?.version ?? doc.currentVersion;
  const restore = async (v: PublicVersion) => {
    const r = await wrap(() => client.files.restoreVersion(orgId, doc.id, v.version, current));
    if (!r.ok) {
      toast({ kind: "error", title: "Restore failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Version ${v.version} restored as version ${r.data.version.version}` });
    versions.reload();
    onRestored();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription className="truncate">{doc.name}</DialogDescription>
        </DialogHeader>
        {versions.loading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto" aria-label="Versions">
            {(versions.data ?? []).map((v) => (
              <li key={v.version} className="flex items-center gap-3 py-2 text-sm">
                <span className="w-10 font-medium">v{v.version}</span>
                <span className="min-w-0 flex-1 text-muted-foreground">
                  {new Date(v.createdAt).toLocaleString()} · {formatBytes(v.size)}
                  {v.restoredFrom ? ` · restored from v${v.restoredFrom}` : ""}
                  {v.actorKind !== "user" ? ` · by ${v.actorKind}` : ""}
                </span>
                <Button variant="ghost" size="icon" aria-label={`Download version ${v.version}`} onClick={() => onDownload(v.version)}>
                  <Download className="h-4 w-4" />
                </Button>
                {v.version !== current && (
                  <Button variant="ghost" size="icon" aria-label={`Restore version ${v.version}`} onClick={() => void restore(v)}>
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
