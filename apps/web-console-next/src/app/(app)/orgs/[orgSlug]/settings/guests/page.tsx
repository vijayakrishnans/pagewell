"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { UserRoundPlus } from "lucide-react";
import type { PublicGuest } from "@saas/contracts/sharing";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";

/** Guests (PW3): people outside the organization that a folder or document was shared with. */
export default function GuestsPage() {
  const params = useParams<{ orgSlug: string }>();
  return <OrgScope slug={params?.orgSlug ?? ""}>{(org) => <Guests orgId={org.id} />}</OrgScope>;
}

function Guests({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const guests = useApiQuery(qk.driveGuests(orgId), () => wrap(async () => (await client.files.listGuests(orgId)).guests));
  const [removing, setRemoving] = React.useState<PublicGuest | null>(null);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Guests</h1>
        <p className="text-sm text-muted-foreground">
          People outside this organization that something in the drive was shared with. They see only what was shared with them, and never share it on.
        </p>
      </header>
      {guests.loading ? (
        <Skeleton className="h-24 w-full" />
      ) : guests.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{guests.error.code === "not_found" ? "Only owners, admins and builders manage guests" : "Couldn't load guests"}</CardTitle>
            <CardDescription>{guests.error.code === "not_found" ? "Ask one of them to remove a guest." : guests.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : (guests.data ?? []).length === 0 ? (
        <EmptyState icon={UserRoundPlus} title="No guests" description="Share a folder or document with someone outside the organization, and they appear here." />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Guests">
          {(guests.data ?? []).map((g) => (
            <li key={g.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{g.name || g.email}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {g.name ? `${g.email} · ` : ""}
                  {g.verifiedAt ? `first opened ${new Date(g.verifiedAt).toLocaleDateString()}` : "hasn't opened anything yet"}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setRemoving(g)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove guest?"
        description="They lose access to everything shared with them in this organization, at once."
        resourceName={removing?.email}
        confirmLabel="Remove"
        onConfirm={async () => {
          if (!removing) return;
          const r = await wrap(() => client.files.removeGuest(orgId, removing.id));
          if (!r.ok) toast({ kind: "error", title: "Couldn't remove the guest", description: r.error.message });
          else toast({ kind: "success", title: `Removed ${removing.email}` });
          setRemoving(null);
          guests.reload();
        }}
      />
    </div>
  );
}
