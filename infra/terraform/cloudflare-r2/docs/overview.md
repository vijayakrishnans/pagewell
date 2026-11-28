# cloudflare-r2

Provisions the private R2 bucket Pagewell stores documents in (stage and prod): `pagewell-files-stage` and `pagewell-files-prod`. Every object key starts with `org/<orgId>/` (`packages/shared/src/r2-keys.ts`).

Terraform-managed infrastructure, planned and applied per environment by its CI lane.

|              |                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Type         | `terraform`                                                                                          |
| Source       | `infra/terraform/cloudflare-r2`                                                                      |
| Environments | `stage`: `plan-only`, `apply` on a push to `main` · `prod`: `plan-only`, `apply` on a push to `main` |

## Depends on

- (none)

## Depended on by

- **files-worker** (PW-10): binds the bucket as `FILES_BUCKET` for document versions, multipart uploads, thumbnails and extracted text
