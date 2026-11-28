/**
 * Stable react-query cache keys (Task 0130 / PERF1).
 *
 * Dependency-free (no React, no react-query) so the key composition is
 * unit-testable in isolation. One factory per resource; the id args already
 * encode the org/project scope, so keys never collide across resources, and
 * the same resource+scope always produces an equal key (shared cache entry).
 */
export const qk = {
  orgs: () => ["orgs"] as const,
  profile: () => ["profile"] as const,
  projects: (orgId: string) => ["projects", orgId] as const,
  environments: (orgId: string, projectId: string) =>
    ["environments", orgId, projectId] as const,
  members: (orgId: string) => ["members", orgId] as const,
  invitations: (orgId: string) => ["invitations", orgId] as const,
  apiKeys: (orgId: string) => ["apiKeys", orgId] as const,
  webhooks: (orgId: string) => ["webhooks", orgId] as const,
  webhookEndpoint: (orgId: string, endpointId: string) =>
    ["webhookEndpoint", orgId, endpointId] as const,
  notificationPrefs: (orgId: string) => ["notificationPrefs", orgId] as const,
  integrations: (orgId: string) => ["integrations", orgId] as const,
  repoLinks: (orgId: string, projectId: string) => ["repoLinks", orgId, projectId] as const,
  configSettings: (scopeKey: string) => ["configSettings", scopeKey] as const,
  configFlags: (scopeKey: string) => ["configFlags", scopeKey] as const,
  configSecrets: (scopeKey: string) => ["configSecrets", scopeKey] as const,
  billingSummary: (orgId: string) => ["billingSummary", orgId] as const,
  entitlements: (orgId: string) => ["entitlements", orgId] as const,
  invoices: (orgId: string) => ["invoices", orgId] as const,
  // Pagewell's drive (PW2).
  driveFolder: (orgId: string, folderId: string | null) => ["driveFolder", orgId, folderId ?? "root"] as const,
  driveTrash: (orgId: string) => ["driveTrash", orgId] as const,
  driveQuota: (orgId: string) => ["driveQuota", orgId] as const,
  envelopes: (orgId: string) => ["envelopes", orgId] as const,
  envelopeEvidence: (orgId: string, envelopeId: string) => ["envelopeEvidence", orgId, envelopeId] as const,
  driveVersions: (orgId: string, docId: string) => ["driveVersions", orgId, docId] as const,
  // Sharing (PW3).
  driveAccess: (orgId: string, kind: string, id: string) => ["driveAccess", orgId, kind, id] as const,
  driveActivity: (orgId: string, docId: string) => ["driveActivity", orgId, docId] as const,
  driveGuests: (orgId: string) => ["driveGuests", orgId] as const,
  sharedWithMe: () => ["sharedWithMe"] as const,
  sharedFolder: (orgId: string, folderId: string) => ["sharedFolder", orgId, folderId] as const,
};
