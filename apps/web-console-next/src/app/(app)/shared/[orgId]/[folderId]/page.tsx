"use client";

import { useParams } from "next/navigation";
import { SharedFolder } from "@/components/drive/shared-with-me";

/** A folder shared with the signed-in person, in an organization they may not belong to. */
export default function SharedFolderPage() {
  const params = useParams<{ orgId: string; folderId: string }>();
  return <SharedFolder orgId={params?.orgId ?? ""} folderId={params?.folderId ?? ""} />;
}
