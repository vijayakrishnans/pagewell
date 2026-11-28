# cloudflare-r2

Provisions the private R2 bucket Pagewell's drive stores documents in (PW2).

- **What it provisions:** one bucket per environment, `pagewell-files-<env>`
  (`pagewell-files-stage`, `pagewell-files-prod`).
- **What consumes it:** `apps/files-worker` binds it as `FILES_BUCKET`, reading
  the name from the `WIRING_CLOUDFLARE_R2` secret this root publishes after apply.
- **Keys:** every object is under `org/<orgId>/` (`packages/shared/src/r2-keys.ts`).
  Nothing is served from the bucket directly; the worker checks the caller's
  rights in the org first.
- **Token:** `CLOUDFLARE_R2_TOKEN`, brokered from the `r2-data` template and
  scoped to these two buckets. The workers-deploy token cannot touch R2.
- **Adoption:** `terraform/adopt.tf` imports a bucket that already exists under
  the name when state does not track it, so a re-bootstrap does not collide.
