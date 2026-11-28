"use client";

import * as React from "react";
import { Link2, Trash2, UserPlus, X } from "lucide-react";
import type { DriveRole, LinkRole, PublicGrant, ShareResourceKind } from "@saas/contracts/sharing";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { appConfig } from "@/lib/app-config";
import { editorOrigin } from "@/lib/drive";
import {
  DRIVE_ROLES,
  EXPIRY_CHOICES,
  LINK_ROLES,
  expiresAt,
  grantSubject,
  inheritedNote,
  linkSummary,
  principalFrom,
  roleLabel,
  shareLinkUrl,
  sortGrants,
  type ExpiryChoice,
} from "@/lib/sharing";

interface Props {
  orgId: string;
  resource: { kind: ShareResourceKind; id: string; name: string };
  onClose: () => void;
}

function RoleSelect<R extends string>({ value, roles, onChange, label, disabled }: { value: R; roles: readonly R[]; onChange: (r: R) => void; label: string; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as R)} disabled={disabled}>
      <SelectTrigger className="w-36 shrink-0" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roles.map((r) => (
          <SelectItem key={r} value={r}>
            {roleLabel(r as DriveRole)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Share a folder or document: people (with inherited access shown), and share links. */
export function ShareDialog({ orgId, resource, onClose }: Props) {
  const { client, target } = useSession();
  const { toast } = useToast();
  const list = useApiQuery(qk.driveAccess(orgId, resource.kind, resource.id), () => wrap(() => client.files.accessList(orgId, resource.kind, resource.id)));
  const members = useApiQuery(qk.members(orgId), () => wrap(async () => (await client.memberships.listMembers(orgId)).members));

  const [who, setWho] = React.useState("");
  const [role, setRole] = React.useState<DriveRole>("viewer");
  const [message, setMessage] = React.useState("");
  const [notify, setNotify] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const [linkRole, setLinkRole] = React.useState<LinkRole>("viewer");
  const [expiry, setExpiry] = React.useState<ExpiryChoice>("never");
  const [password, setPassword] = React.useState("");
  const [allowDownload, setAllowDownload] = React.useState(true);
  const [newLink, setNewLink] = React.useState<string | null>(null);

  const principal = principalFrom(who);
  const kindWord = resource.kind === "folder" ? "folder" : "document";

  const share = async (body: { userId?: string; email?: string; role: DriveRole }, quiet = false) => {
    setBusy(true);
    const r = await wrap(() => client.files.share(orgId, resource.kind, resource.id, { ...body, notify: quiet ? false : notify, message: message.trim() || null }));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Couldn't share", description: r.error.message });
      return false;
    }
    list.reload();
    return true;
  };

  const add = async () => {
    if (!principal) return;
    if (await share({ ...principal, role })) {
      toast({ kind: "success", title: `Shared with ${"email" in principal ? principal.email : "a member"}` });
      setWho("");
      setMessage("");
    }
  };

  const remove = async (g: PublicGrant) => {
    const r = await wrap(() => client.files.unshare(orgId, resource.kind, resource.id, g.id));
    if (!r.ok) toast({ kind: "error", title: "Couldn't remove access", description: r.error.message });
    list.reload();
  };

  const createLink = async () => {
    setBusy(true);
    const r = await wrap(() =>
      client.files.createLink(orgId, resource.kind, resource.id, { role: linkRole, expiresAt: expiresAt(expiry), password: password || null, allowDownload }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Couldn't create the link", description: r.error.message });
      return;
    }
    setNewLink(shareLinkUrl(editorOrigin(appConfig(), target.name), r.data.token));
    setPassword("");
    list.reload();
  };

  const revoke = async (linkId: string) => {
    const r = await wrap(() => client.files.revokeLink(orgId, resource.kind, resource.id, linkId));
    if (!r.ok) toast({ kind: "error", title: "Couldn't turn the link off", description: r.error.message });
    else toast({ kind: "success", title: "Link turned off. It stops working right away." });
    list.reload();
  };

  const cannotShare = list.error?.code === "not_found";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="truncate">Share “{resource.name}”</DialogTitle>
          <DialogDescription>
            Everyone in this organization already has access by their role. Share with others here, by email or with a link.
          </DialogDescription>
        </DialogHeader>

        {cannotShare ? (
          <p className="text-sm text-muted-foreground">You can view this {kindWord}, but only its editors in this organization can share it.</p>
        ) : list.loading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="space-y-6">
            <section aria-labelledby="share-add" className="space-y-2">
              <h3 id="share-add" className="text-sm font-medium">
                Add people
              </h3>
              <div className="flex gap-2">
                <Input
                  value={who}
                  onChange={(e) => setWho(e.target.value)}
                  placeholder="Email address, or a member"
                  list="share-members"
                  aria-label="Email address or member"
                  aria-invalid={who.length > 0 && !principal}
                />
                <datalist id="share-members">
                  {(members.data ?? []).map((m) => (
                    <option key={m.id} value={m.subjectId}>
                      {m.roles.map((r) => r.role).join(", ")}
                    </option>
                  ))}
                </datalist>
                <RoleSelect value={role} roles={DRIVE_ROLES} onChange={setRole} label="Role for the person added" />
              </div>
              {principal && "email" in principal && (
                <>
                  <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message (optional)" maxLength={500} aria-label="Message" />
                  <div className="flex items-center gap-2">
                    <Checkbox id="share-notify" checked={notify} onCheckedChange={setNotify} />
                    <Label htmlFor="share-notify" className="text-sm font-normal">
                      Email them about it
                    </Label>
                  </div>
                </>
              )}
              <Button onClick={() => void add()} disabled={!principal || busy}>
                <UserPlus className="mr-1.5 h-4 w-4" />
                Share
              </Button>
            </section>

            <section aria-labelledby="share-people" className="space-y-2">
              <h3 id="share-people" className="text-sm font-medium">
                People with access
              </h3>
              {list.data && list.data.grants.length === 0 ? (
                <p className="text-sm text-muted-foreground">Only people in this organization, by their role.</p>
              ) : (
                <ul className="divide-y rounded-lg border" aria-label="People with access">
                  {sortGrants(list.data?.grants ?? []).map((g) => {
                    const subject = grantSubject(g);
                    const from = inheritedNote(g);
                    return (
                      <li key={g.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{subject.primary}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {subject.secondary}
                            {from ? ` · ${from}` : ""}
                          </div>
                        </div>
                        {from ? (
                          <span className="text-xs text-muted-foreground">{roleLabel(g.role)}</span>
                        ) : (
                          <>
                            <RoleSelect
                              value={g.role}
                              roles={DRIVE_ROLES}
                              label={`Role for ${subject.primary}`}
                              onChange={(r) =>
                                void share(g.principal.kind === "member" ? { userId: g.principal.userId, role: r } : { email: g.principal.email, role: r }, true)
                              }
                            />
                            <Button variant="ghost" size="icon" aria-label={`Remove ${subject.primary}`} onClick={() => void remove(g)}>
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section aria-labelledby="share-links" className="space-y-2">
              <h3 id="share-links" className="text-sm font-medium">
                Links
              </h3>
              <p className="text-xs text-muted-foreground">Anyone with the link can {linkRole === "commenter" ? "view and comment" : "view"}, no account needed. A link never lets anyone edit.</p>
              {(list.data?.links ?? []).length > 0 && (
                <ul className="divide-y rounded-lg border" aria-label="Active links">
                  {list.data!.links.map((l) => (
                    <li key={l.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{linkSummary(l)}</span>
                      <Button variant="ghost" size="sm" onClick={() => void revoke(l.id)}>
                        <Trash2 className="mr-1 h-4 w-4" />
                        Turn off
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {newLink && (
                <div className="space-y-1 rounded-lg border border-primary/40 p-3">
                  <p className="text-xs text-muted-foreground">Copy the link now. For safety it is shown only once.</p>
                  <div className="flex gap-2">
                    <Input readOnly value={newLink} aria-label="New share link" onFocus={(e) => e.currentTarget.select()} />
                    <CopyButton value={newLink} />
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <RoleSelect value={linkRole} roles={LINK_ROLES} onChange={setLinkRole} label="Link role" />
                <Select value={expiry} onValueChange={(v) => setExpiry(v as ExpiryChoice)}>
                  <SelectTrigger className="w-44" aria-label="Link expiry">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_CHOICES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="password"
                  className="w-44"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password (optional)"
                  aria-label="Link password"
                  autoComplete="new-password"
                />
                <div className="flex items-center gap-2">
                  <Checkbox id="link-download" checked={allowDownload} onCheckedChange={setAllowDownload} />
                  <Label htmlFor="link-download" className="text-sm font-normal">
                    Allow download
                  </Label>
                </div>
                <Button variant="outline" onClick={() => void createLink()} disabled={busy || (password.length > 0 && password.length < 8)}>
                  <Link2 className="mr-1.5 h-4 w-4" />
                  Create link
                </Button>
              </div>
              {password.length > 0 && password.length < 8 && <p className="text-xs text-destructive">A link password is at least 8 characters.</p>}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
