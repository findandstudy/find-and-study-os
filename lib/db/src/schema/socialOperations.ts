import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationsTable, tenantsTable } from "./authorization";
import { usersTable } from "./users";

const uuidV7 = (column: { name: string }) =>
  sql`substring(${sql.identifier(column.name)}::text from 15 for 1) = '7'`;

export const socialAccountsTable = pgTable(
  "social_accounts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").notNull(),
    provider: text("provider").notNull(),
    accountKey: text("account_key").notNull(),
    displayName: text("display_name").notNull(),
    integrationKey: text("integration_key"),
    externalAccountRefHash: text("external_account_ref_hash"),
    status: text("status").notNull().default("DISCONNECTED"),
    createdByLegacyUserId: integer("created_by_legacy_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("social_accounts_tenant_id_id_uq").on(table.tenantId, table.id),
    unique("social_accounts_scope_key_uq").on(
      table.tenantId,
      table.organizationId,
      table.accountKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_accounts_organization_fk",
    }).onDelete("restrict"),
    index("social_accounts_scope_status_idx").on(
      table.tenantId,
      table.organizationId,
      table.status,
    ),
    check("social_accounts_id_v7_chk", uuidV7(table.id)),
  ],
).enableRLS();

export const socialContentBriefsTable = pgTable(
  "social_content_briefs",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    audience: text("audience").notNull(),
    contentKind: text("content_kind").notNull(),
    locales: text("locales").array().notNull().default([]),
    channels: text("channels").array().notNull().default([]),
    campaignKey: text("campaign_key"),
    caption: text("caption"),
    mediaRefs: jsonb("media_refs")
      .$type<Array<{ kind: string; ref: string }>>()
      .notNull()
      .default([]),
    utm: jsonb("utm").$type<Record<string, string>>().notNull().default({}),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    status: text("status").notNull().default("DRAFT"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdByLegacyUserId: integer("created_by_legacy_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    reviewedByLegacyUserId: integer("reviewed_by_legacy_user_id").references(
      () => usersTable.id,
      { onDelete: "restrict" },
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("social_content_briefs_tenant_id_id_uq").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_content_briefs_organization_fk",
    }).onDelete("restrict"),
    index("social_content_briefs_calendar_idx").on(
      table.tenantId,
      table.organizationId,
      table.scheduledFor,
      table.status,
    ),
    check("social_content_briefs_id_v7_chk", uuidV7(table.id)),
    check(
      "social_content_briefs_status_chk",
      sql`${table.status} IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED')`,
    ),
    check(
      "social_content_briefs_kind_chk",
      sql`${table.contentKind} IN ('POST', 'STORY', 'REEL', 'VIDEO', 'ARTICLE', 'AD_CREATIVE')`,
    ),
    check("social_content_briefs_version_chk", sql`${table.version} > 0`),
  ],
);

export const socialContentReviewsTable = pgTable(
  "social_content_reviews",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    briefId: uuid("brief_id").notNull(),
    briefVersion: bigint("brief_version", { mode: "number" }).notNull(),
    reviewerLegacyUserId: integer("reviewer_legacy_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    reason: text("reason"),
    requestKey: text("request_key").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.id],
      name: "social_content_reviews_pk",
    }),
    unique("social_content_reviews_once_uq").on(
      table.tenantId,
      table.briefId,
      table.briefVersion,
    ),
    unique("social_content_reviews_request_uq").on(
      table.tenantId,
      table.requestKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.briefId],
      foreignColumns: [
        socialContentBriefsTable.tenantId,
        socialContentBriefsTable.id,
      ],
      name: "social_content_reviews_brief_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_content_reviews_organization_fk",
    }).onDelete("restrict"),
    check("social_content_reviews_id_v7_chk", uuidV7(table.id)),
  ],
);

export const socialPublicationIntentsTable = pgTable(
  "social_publication_intents",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    briefId: uuid("brief_id").notNull(),
    accountId: uuid("account_id").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    providerMode: text("provider_mode").notNull().default("MANAGED_PROVIDER"),
    status: text("status").notNull().default("DRAFT"),
    idempotencyKey: text("idempotency_key").notNull(),
    providerJobRefHash: text("provider_job_ref_hash"),
    executionReceiptHash: text("execution_receipt_hash"),
    lastErrorCode: text("last_error_code"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseTokenHash: text("lease_token_hash"),
    leasedAt: timestamp("leased_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    workerId: text("worker_id"),
    providerPostRefHash: text("provider_post_ref_hash"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    createdByLegacyUserId: integer("created_by_legacy_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    approvedByLegacyUserId: integer("approved_by_legacy_user_id").references(
      () => usersTable.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("social_publication_intents_tenant_id_id_uq").on(
      table.tenantId,
      table.id,
    ),
    unique("social_publication_intents_scope_key_uq").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.briefId],
      foreignColumns: [
        socialContentBriefsTable.tenantId,
        socialContentBriefsTable.id,
      ],
      name: "social_publication_intents_brief_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [socialAccountsTable.tenantId, socialAccountsTable.id],
      name: "social_publication_intents_account_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_publication_intents_organization_fk",
    }).onDelete("restrict"),
    index("social_publication_intents_queue_idx").on(
      table.tenantId,
      table.organizationId,
      table.status,
      table.scheduledFor,
    ),
    check("social_publication_intents_id_v7_chk", uuidV7(table.id)),
  ],
);

export const socialPublicationReviewsTable = pgTable(
  "social_publication_reviews",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    publicationIntentId: uuid("publication_intent_id").notNull(),
    reviewerLegacyUserId: integer("reviewer_legacy_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    reason: text("reason"),
    requestKey: text("request_key").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.id],
      name: "social_publication_reviews_pk",
    }),
    unique("social_publication_reviews_once_uq").on(
      table.tenantId,
      table.publicationIntentId,
    ),
    unique("social_publication_reviews_request_uq").on(
      table.tenantId,
      table.requestKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.publicationIntentId],
      foreignColumns: [
        socialPublicationIntentsTable.tenantId,
        socialPublicationIntentsTable.id,
      ],
      name: "social_publication_reviews_intent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_publication_reviews_organization_fk",
    }).onDelete("restrict"),
    check("social_publication_reviews_id_v7_chk", uuidV7(table.id)),
  ],
);

export const socialPublicationAttemptsTable = pgTable(
  "social_publication_attempts",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    publicationIntentId: uuid("publication_intent_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id").notNull(),
    runtimeReleaseId: text("runtime_release_id").notNull(),
    outcome: text("outcome").notNull(),
    providerRequestHash: text("provider_request_hash").notNull(),
    providerReceiptHash: text("provider_receipt_hash"),
    providerPostRefHash: text("provider_post_ref_hash"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.id],
      name: "social_publication_attempts_pk",
    }),
    unique("social_publication_attempts_once_uq").on(
      table.tenantId,
      table.publicationIntentId,
      table.attemptNumber,
    ),
    foreignKey({
      columns: [table.tenantId, table.publicationIntentId],
      foreignColumns: [
        socialPublicationIntentsTable.tenantId,
        socialPublicationIntentsTable.id,
      ],
      name: "social_publication_attempts_intent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_publication_attempts_organization_fk",
    }).onDelete("restrict"),
    check("social_publication_attempts_id_v7_chk", uuidV7(table.id)),
  ],
);

export const socialOperationReceiptsTable = pgTable(
  "social_operation_receipts",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    actorLegacyUserId: integer("actor_legacy_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    operation: text("operation").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    requestKey: text("request_key").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    resultSha256: text("result_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.id],
      name: "social_operation_receipts_pk",
    }),
    unique("social_operation_receipts_request_uq").on(
      table.tenantId,
      table.requestKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_operation_receipts_organization_fk",
    }).onDelete("restrict"),
    index("social_operation_receipts_entity_idx").on(
      table.tenantId,
      table.organizationId,
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    check("social_operation_receipts_id_v7_chk", uuidV7(table.id)),
  ],
);

export const socialPerformanceSnapshotsTable = pgTable(
  "social_performance_snapshots",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    publicationIntentId: uuid("publication_intent_id").notNull(),
    metrics: jsonb("metrics").$type<Record<string, number>>().notNull(),
    providerReceiptHash: text("provider_receipt_hash").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.id],
      name: "social_performance_snapshots_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.publicationIntentId],
      foreignColumns: [
        socialPublicationIntentsTable.tenantId,
        socialPublicationIntentsTable.id,
      ],
      name: "social_performance_snapshots_intent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_performance_snapshots_organization_fk",
    }).onDelete("restrict"),
    check("social_performance_snapshots_id_v7_chk", uuidV7(table.id)),
  ],
);

export type SocialContentBrief = typeof socialContentBriefsTable.$inferSelect;
export type SocialAccount = typeof socialAccountsTable.$inferSelect;
export type SocialPublicationIntent =
  typeof socialPublicationIntentsTable.$inferSelect;
