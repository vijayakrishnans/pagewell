"use client";

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { DriveBrowser } from "@/components/drive/drive-browser";

/** The org's drive, at its root. */
export default function DrivePage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <DriveBrowser orgId={org.id} orgSlug={org.slug} folderId={null} />}</OrgScope>;
}
