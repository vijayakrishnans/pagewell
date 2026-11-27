"use client";

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { DriveBrowser } from "@/components/drive/drive-browser";

/** One folder of the org's drive. */
export default function DriveFolderPage() {
  const params = useParams<{ orgSlug: string; folderId: string }>();
  const slug = params?.orgSlug ?? "";
  const folderId = params?.folderId ?? null;
  return <OrgScope slug={slug}>{(org) => <DriveBrowser orgId={org.id} orgSlug={org.slug} folderId={folderId} />}</OrgScope>;
}
