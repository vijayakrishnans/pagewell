# files-worker

Pagewell's drive (milestone PW2). It owns folders, documents, versions, multipart
uploads, the 30-day trash and the drive's quotas. Rows live in the shared D1
database (migration `200_files_core`, tables `files_*`); bytes live in the R2
bucket `pagewell-files-<env>`, which is never public.

- **No public route.** `api-edge` authenticates the caller and reaches this worker by
  service binding, passing the actor in `x-actor-subject-id` / `x-actor-subject-type`.
- **Tenancy and sharing (PW3).** Every org route is under `/v1/organizations/{org}/`. Each
  route is checked before any row is read, either for the org as a whole (the root, recent
  documents, trash, quota, guests: members only) or for the one folder or document in the
  path. For the latter the worker gathers the person's org role (`membership-worker`) and the
  grants that reach the resource (its own and every folder above it) and `policy-worker`
  decides `files.read|comment|write|delete|share`. Guests are people outside the org who
  were shared with by email; they reach only what was shared. Routes whose target is in the
  body (create, upload, move) check the destination folder too. Every repository statement scopes
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
- **Share links.** `/v1/l/{token}` opens a link with no account. The token is stored as its
  SHA-256, a password as PBKDF2; a missing, revoked or expired link is `404` from the next
  request on (nothing is cached). Links read (and later comment); they never write.
- **Audit.** Every drive change and share event (`folder.*`, `document.*`, `version.*`,
  `grant.*`, `link.*`, `guest.*`) is written to the platform's events and audit tables,
  category `files`; `GET /documents/{doc}/activity` reads a document's.
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
| GET | `/documents/{doc}/activity` | read: audit entries, newest first |
| GET | `/{folders\|documents}/{id}/access` | read: what the caller may do here |
| GET / POST | `/{folders\|documents}/{id}/grants` | share: who has access / add or change someone |
| DELETE | `/{folders\|documents}/{id}/grants/{grt}` | share |
| GET / POST | `/{folders\|documents}/{id}/links` | share: the token is in the POST response only |
| DELETE | `/{folders\|documents}/{id}/links/{lnk}` | share: off from the next request |
| GET / DELETE | `/guests`, `/guests/{gst}` | org share: list / remove with every grant |

Outside an org: `GET /v1/me/shared` (what is shared with the caller, any org) and
`GET /v1/l/{token}[/content]` (a share link; password in `X-Pagewell-Link-Password`).
| POST | `/documents/{doc}/versions/{n}/restore` | write |
| GET / PUT | `/documents/{doc}/versions/{n}/thumbnail` | read / write |
| PUT | `/documents/{doc}/versions/{n}/text` | write |
| POST | `/uploads`, `/uploads/{upl}/complete` | write |
| PUT | `/uploads/{upl}/parts/{n}` | write |
| DELETE | `/uploads/{upl}` | write |
| GET | `/trash`, `/quota` | read |
