import { TRASH_RETENTION_DAYS } from "@saas/contracts/files";
import { createSqlExecutor } from "@saas/db/d1";
import { createFilesRepository } from "@saas/db/files";
import type { Uuid } from "@saas/db/ids";
import type { Env } from "./env.js";

// The daily sweep: what has sat in the trash for 30 days is removed for good
// (rows, the version objects and everything derived under the document's
// prefix), and multipart uploads past their expiry are aborted and forgotten.

const BATCH = 200;
const DOC_PREFIX = /^(org\/[0-9a-f-]{36}\/doc\/[0-9a-f-]{36}\/)/;

export interface SweepReport {
  documents: number;
  folders: number;
  objects: number;
  uploads: number;
}

export async function sweep(env: Env, now: Date = new Date()): Promise<SweepReport> {
  const report: SweepReport = { documents: 0, folders: 0, objects: 0, uploads: 0 };
  if (!env.PLATFORM_DB || !env.FILES_BUCKET) return report;
  const bucket = env.FILES_BUCKET;
  const executor = createSqlExecutor(env.PLATFORM_DB as never);
  const repo = createFilesRepository(executor);
  try {
    const purged = await repo.purgeTrash(new Date(now.getTime() - TRASH_RETENTION_DAYS * 86_400_000), BATCH);
    if (purged.ok) {
      report.documents = purged.value.documents;
      report.folders = purged.value.folders;
      // Every key under each purged document's prefix: its blobs, thumbnails and text.
      const prefixes = new Set(purged.value.r2Keys.map((k) => k.match(DOC_PREFIX)?.[1]).filter((p): p is string => !!p));
      for (const prefix of prefixes) {
        let cursor: string | undefined;
        do {
          const page = await bucket.list(cursor ? { prefix, cursor } : { prefix });
          const keys = page.objects.map((o) => o.key);
          if (keys.length) await bucket.delete(keys);
          report.objects += keys.length;
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
    }
    const expired = await repo.expiredUploads(now, BATCH);
    if (expired.ok) {
      for (const u of expired.value) {
        await bucket.resumeMultipartUpload(u.r2Key, u.r2UploadId).abort().catch(() => undefined);
        await repo.forgetUpload(u.orgId as Uuid, u.id as Uuid);
        report.uploads += 1;
      }
    }
  } finally {
    await executor.dispose();
  }
  return report;
}
