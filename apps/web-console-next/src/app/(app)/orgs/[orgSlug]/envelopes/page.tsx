"use client";

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Envelopes } from "@/components/sign/envelopes";

/** The envelopes this person sent for signature (PW6). */
export default function EnvelopesPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => (
        <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
          <h1 className="text-xl font-semibold">Envelopes</h1>
          <Envelopes orgId={org.id} />
        </div>
      )}
    </OrgScope>
  );
}
