import type { MigrationManifest } from "./types.js";

export const manifest: MigrationManifest = {
  version: 1,
  migrations: [
    {
      id: "000_control_baseline",
      context: "control",
      path: "000_control/up.sql",
      checksum:
        "c7f11499fa82d6fd2baa1af7fc75eeb73cd7be252af2e56841509c66001d638b",
      description:
        "Baseline control migration — creates the migration tracking schema",
    },
    {
      id: "010_identity_core",
      context: "identity",
      path: "010_identity_core/up.sql",
      checksum:
        "e8275904e2c60c42c6c977c208acd857086c6b93b35f552fd10e41ca16607872",
      description:
        "Identity persistence foundation — users, auth identities, login challenges, sessions",
    },
    {
      id: "020_membership_core",
      context: "membership",
      path: "020_membership_core/up.sql",
      checksum:
        "857bbac3e351b71a2549e6639127611e0918a16a6efe94fe0edb8d12dc7392d5",
      description:
        "Membership persistence foundation — organizations, members, invitations, role assignments",
    },
    {
      id: "030_events_audit_core",
      context: "events",
      path: "030_events_audit_core/up.sql",
      checksum:
        "13c451ca150371f301a85c3a00b36689a6108f31da05c8d1a3fa64b3b1b6bfb4",
      description:
        "Events/audit persistence foundation — canonical event log and audit entry projections",
    },
    {
      id: "040_projects_core",
      context: "projects",
      path: "040_projects_core/up.sql",
      checksum:
        "f40bd14d98f399f0a0cfb6f82a5ac7be31792c74950e597bc90ffe6a6ead3949",
      description:
        "Projects persistence foundation — projects and environments tables with tenant isolation",
    },
    {
      id: "050_identity_security_events",
      context: "identity",
      path: "050_identity_security_events/up.sql",
      checksum:
        "e97f0dc7d4e7f3e246bbdd80f041a64a178949281e30c9e94ceb8a64d9472009",
      description:
        "Identity-owned security-event source facts — pre-organization user activity log",
    },
    {
      id: "060_identity_api_keys",
      context: "identity",
      path: "060_identity_api_keys/up.sql",
      checksum:
        "9adceb6281c2f88449415dceba7f387e16591ffbc115d6199a5efce4acf92aff",
      description:
        "Identity-owned service principals and API keys — org-bound automation actors and credential persistence",
    },
    {
      id: "070_config_settings_flags",
      context: "config",
      path: "070_config_settings_flags/up.sql",
      checksum:
        "0996c9c8e483b1aff84a2b17e4176eaa21316f3c9834070eaee78c23c0b18a48",
      description:
        "Config persistence foundation — scoped settings, feature flags, and secret metadata",
    },
    {
      id: "080_webhooks_core",
      context: "webhooks",
      path: "080_webhooks_core/up.sql",
      checksum:
        "c9157f4836d229b73dd3918b0b090fc776e0ba73727a876e37a2b6c1b098a38a",
      description:
        "Webhook persistence foundation — endpoints, subscriptions, and delivery attempts",
    },
    {
      id: "090_webhooks_delivery",
      context: "webhooks",
      path: "090_webhooks_delivery/up.sql",
      checksum:
        "79ea5500c1e5dff36f70ad6a3f63f4335c1423c4695ca0ac5b60942d6f20cce4",
      description:
        "Webhook delivery runtime — fixes event_id type, adds dispatch cursor and delivery indexes",
    },
    {
      id: "100_metering_foundation",
      context: "metering",
      path: "100_metering_foundation/up.sql",
      checksum:
        "f5448db51935ade1fab8670a27c1104d20b07d0003608550d1749a013f0ac6b9",
      description:
        "Metering persistence foundation — usage records, rollups, quota definitions, and quota violations",
    },
    {
      id: "110_billing_foundation",
      context: "billing",
      path: "110_billing_foundation/up.sql",
      checksum:
        "446e002fada272b2488c745eb855f49685e7f9899297c8df7e39f25ad591e06f",
      description:
        "Billing persistence foundation — provider-neutral plans, billing customers, subscriptions, invoices, and entitlements",
    },
    {
      id: "120_notifications_core",
      context: "notifications",
      path: "120_notifications_core/up.sql",
      checksum:
        "ca99fc52528d2697885776096ee0d0b2b46cab6c18ca37cfc6e46ed4cf0b4d59",
      description:
        "Notifications persistence foundation — preferences, notifications, attempts, suppressions",
    },
    {
      id: "130_webhook_secret_rotation_grace",
      context: "webhooks",
      path: "130_webhook_secret_rotation_grace/up.sql",
      checksum:
        "de5929da0705b34ae3ac94ce978705c857d232997f553ed4abd92996b9ba8134",
      description:
        "Dual-secret rotation window — adds previous_secret_{ciphertext,version,expires_at} for grace-period delivery signing",
    },
    {
      id: "140_support_action_records",
      context: "support",
      path: "140_support_action_records/up.sql",
      checksum:
        "4379358a3692ebc734c1125c3d21c00c023185f42572351d7366f3292388b4b3",
      description:
        "Support persistence foundation — append-only audited support-action ledger owned by the admin-support worker",
    },
    {
      id: "150_entitlement_decision_observations",
      context: "billing",
      path: "150_entitlement_decision_observations/up.sql",
      checksum:
        "51950b97f41b5b03107cf1414a068e5d2a82901331f00687aa647139f40043d5",
      description:
        "Entitlement-decision observability — append-only, counts-only observation table (org × entitlement key × outcome) owned by the billing context",
    },
    {
      id: "160_identity_user_last_org",
      context: "identity",
      path: "160_identity_user_last_org/up.sql",
      checksum:
        "ebfead333c9a5ccfdc782744eef2911ae9c63c70358a8fccecbd8b545a851806",
      description:
        "Per-user last-viewed organization preference (nullable slug hint on identity_users) backing the console's cross-device default landing",
    },
    {
      id: "170_membership_org_parent",
      context: "membership",
      path: "170_membership_org_parent/up.sql",
      checksum:
        "33e280e66b1752832a434fb122d41733e1c325faa443e819a8b402ca63995581",
      description:
        "Optional parent-organization pointer (nullable parent_org_id on membership_organizations) — the dormant seam for the saas-multi-org-billing epic; NULL = standalone, no behavior change",
    },
    {
      id: "180_integrations_foundation",
      context: "integrations",
      path: "180_integrations_foundation/up.sql",
      checksum:
        "f0a65edf90d7d63349628335ca80ddf825555b1686c4873aa4f75ab633b8f2bd",
      description:
        "Integrations persistence foundation (IG0, dormant) — provider-agnostic connections, GitHub installation facts, repo links with branch→environment maps, the durable inbound-delivery inbox, and the encrypted installation-token cache",
    },
    {
      id: "190_integrations_delivery_attribution",
      context: "integrations",
      path: "190_integrations_delivery_attribution/up.sql",
      checksum:
        "b5ffe67f60e3486b9c733146c375341e757145b5d4381475256f1399328d81a0",
      description:
        "Connection pointer on the inbound-delivery inbox (nullable connection_id + partial index) — lets the per-connection delivery log scope precisely; attributed by the IG2 cron drain",
    },
    {
      id: "200_files_core",
      context: "files",
      path: "200_files_core/up.sql",
      checksum:
        "912407c98648428d3d270b471835e6da7d42aa802fa52fb47b39b92221538a85",
      description:
        "Pagewell drive foundation (PW2) — org-scoped folders, documents, versions (numbers from the primary key) and in-flight multipart uploads, with a 30-day soft-delete trash",
    },
    {
      id: "210_files_sharing",
      context: "files",
      path: "210_files_sharing/up.sql",
      checksum:
        "b8b29c0a4e81c6f2e5985d735a2efef2faf691b7d26fcabe13dad7d20d886fe3",
      description:
        "Pagewell drive sharing (PW3) — member and guest grants on folders and documents (inherited down the folder tree at read time), share links stored as token hashes with optional PBKDF2 passwords and expiry, link opens (hashed), and guests matched by verified email",
    },
    {
      id: "220_jobs_core",
      context: "jobs",
      path: "220_jobs_core/up.sql",
      checksum:
        "8fb4ff648b5ddafea84a73ed9c15449e7d8d0b8249f2f21f9851c5aa52c93d3c",
      description:
        "Pagewell heavy jobs (PW4) — one org-scoped row per PdfCraft operation run in the pdf-runner container: inputs (documents at fixed versions), options, status, the versions, documents or day-long result files it made, bounded errors",
    },
    {
      id: "230_files_link_lockout",
      context: "files",
      path: "230_files_link_lockout/up.sql",
      checksum:
        "9078902fc3fe0dddc56ef3cd3d81ae58c93bb6d580a337520b693f3d9c7141ad",
      description:
        "Share-link password lockout (PW-26) — wrong-password count and a lock time on files_links: 10 wrong passwords in a row lock a link for 15 minutes",
    },
    {
      id: "240_review_core",
      context: "review",
      path: "240_review_core/up.sql",
      checksum:
        "c5d998588108a6b27bc3409e3be2ea3c0bd8d91839f4a3dfb35b58aaf8b09d35",
      description:
        "Pagewell review (PW5) — comment threads anchored on a page of a version (carried forward or marked outdated), their comments with mentions, review requests and their reviewers",
    },
    {
      id: "250_sign_core",
      context: "sign",
      path: "250_sign_core/up.sql",
      checksum:
        "6ee769696061ebb8f905785311fd05257c6c28b754679f7725fa4fb5a7e82e2d",
      description:
        "Pagewell e-sign (PW6) — envelopes, their documents (versions and hashes frozen at send), signers with hashed single-use links and email codes, fields per signer, and the append-only hash-chained evidence log",
    },
    {
      id: "251_sign_sender",
      context: "sign",
      path: "251_sign_sender/up.sql",
      checksum:
        "19e192367d7617ac336fafba9484cc036a2030168033daa2809174f7ed3bfa49",
      description:
        "Pagewell e-sign (PW6) — the sender's email on an envelope, shown to signers and used to tell the sender of a decline or completion",
    },
  ],
};
