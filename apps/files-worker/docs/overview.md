# files-worker

Pagewell's drive (milestone PW2). It owns folders, documents, versions, multipart
uploads, the 30-day trash and the drive's quotas. Rows live in the shared D1
database (migration `200_files_core`, tables `files_*`); bytes live in the R2
bucket `pagewell-files-<env>`, which is never public.

- **No public route.** `api-edge` authenticates the caller and reaches this worker by
  service binding, passing the actor in `x-actor-subject-id` / `x-actor-subject-type`.
- **Tenancy.** Every route is under `/v1/organizations/{org}/`. The caller's right in the
  org (`files.read`, `files.write` or `files.delete`) is decided by `policy-worker` from
  `membership-worker`'s facts before any row is read. Every repository statement scopes
  by `org_id`, every R2 key starts `org/<orgId>/` (`packages/shared/src/r2-keys.ts`), and
  another org's resource is always `404`, never `403`.
- **Versions.** A save is the whole PDF with `X-Pagewell-Base-Version`; a stale base is
  `409 version_conflict` carrying `currentVersion`. Version bytes get a fresh key per
  write, so racing writers never overwrite each other (D9). A restore makes the next
  version point at the old bytes.
- **Quotas.** Storage, file size and versions per document, from the org's billing
  entitlements (`files.storage_bytes`, `files.max_file_bytes`,
  `files.versions_per_document`), with the free tier when a plan sets none.
  Over a limit is `402 quota_exceeded`.
- **Cron** (03:17 UTC): purge what has been in the trash for 30 days, and abort expired
  multipart uploads.
- **Logs** carry counts and error classes only: never document text, names or keys.

## Routes (under `/v1/organizations/{org}`)

| Method | Path | Right |
|---|---|---|
| GET | `/folders`, `/folders/{fld}` | read: the listing, with a breadcrumb |
| POST | `/folders` | write |
| PATCH / DELETE | `/folders/{fld}` | write / delete (trash) |
| POST | `/folders/{fld}/restore` | delete |
| GET | `/documents` | read: recent, cursor-paged |
| POST | `/documents?name=&folderId=` | write: the PDF as the body (≤ 95 MiB) |
| GET / PATCH / DELETE | `/documents/{doc}` | read / write / delete |
| POST | `/documents/{doc}/restore` | delete |
| GET | `/documents/{doc}/content?version=` | read: streamed |
| GET / POST | `/documents/{doc}/versions` | read / write (a save) |
| POST | `/documents/{doc}/versions/{n}/restore` | write |
| GET / PUT | `/documents/{doc}/versions/{n}/thumbnail` | read / write |
| PUT | `/documents/{doc}/versions/{n}/text` | write |
| POST | `/uploads`, `/uploads/{upl}/complete` | write |
| PUT | `/uploads/{upl}/parts/{n}` | write |
| DELETE | `/uploads/{upl}` | write |
| GET | `/trash`, `/quota` | read |
