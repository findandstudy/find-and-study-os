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
import { applicationsTable } from "./applications";
import { leadsTable } from "./leads";
import { studentsTable } from "./students";
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
    accountKind: text("account_kind").notNull().default("PROFILE"),
    currencyCode: text("currency_code"),
    integrationKey: text("integration_key"),
    externalAccountRefHash: text("external_account_ref_hash"),
    verificationReceiptHash: text("verification_receipt_hash"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastVerificationAt: timestamp("last_verification_at", {
      withTimezone: true,
    }),
    lastVerificationErrorCode: text("last_verification_error_code"),
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

export const socialAccountVerificationsTable = pgTable(
  "social_account_verifications",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    accountId: uuid("account_id").notNull(),
    actorLegacyUserId: integer("actor_legacy_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    requestKey: text("request_key").notNull(),
    outcome: text("outcome").notNull(),
    providerRequestHash: text("provider_request_hash").notNull(),
    providerReceiptHash: text("provider_receipt_hash"),
    externalAccountRefHash: text("external_account_ref_hash"),
    errorCode: text("error_code"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.id],
      name: "social_account_verifications_pk",
    }),
    unique("social_account_verifications_request_uq").on(
      table.tenantId,
      table.requestKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [socialAccountsTable.tenantId, socialAccountsTable.id],
      name: "social_account_verifications_account_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_account_verifications_organization_fk",
    }).onDelete("restrict"),
    index("social_account_verifications_account_idx").on(
      table.tenantId,
      table.organizationId,
      table.accountId,
      table.occurredAt,
    ),
    check("social_account_verifications_id_v7_chk", uuidV7(table.id)),
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
    trackingKey: text("tracking_key").notNull(),
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
    unique("social_content_briefs_tracking_key_uq").on(table.trackingKey),
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

export const socialAttributedLeadsTable = pgTable(
  "social_attributed_leads",
  {
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    briefId: uuid("brief_id").notNull(),
    trackingKey: text("tracking_key").notNull(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leadsTable.id, { onDelete: "restrict" }),
    leadStatus: text("lead_status").notNull(),
    convertedStudentId: integer("converted_student_id").references(
      () => studentsTable.id,
      { onDelete: "set null" },
    ),
    leadDeletedAt: timestamp("lead_deleted_at", { withTimezone: true }),
    firstTouchAt: timestamp("first_touch_at", { withTimezone: true }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "social_attributed_leads_pk",
      columns: [table.tenantId, table.leadId],
    }),
    unique("social_attributed_leads_one_touch_uq").on(table.leadId),
    foreignKey({
      columns: [table.tenantId, table.briefId],
      foreignColumns: [
        socialContentBriefsTable.tenantId,
        socialContentBriefsTable.id,
      ],
      name: "social_attributed_leads_brief_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_attributed_leads_organization_fk",
    }).onDelete("restrict"),
    index("social_attributed_leads_scope_touch_idx").on(
      table.tenantId,
      table.organizationId,
      table.firstTouchAt,
      table.leadId,
    ),
    index("social_attributed_leads_brief_idx").on(
      table.tenantId,
      table.organizationId,
      table.briefId,
      table.firstTouchAt,
    ),
  ],
).enableRLS();

export const socialAttributedApplicationsTable = pgTable(
  "social_attributed_applications",
  {
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    briefId: uuid("brief_id").notNull(),
    leadId: integer("lead_id").notNull(),
    applicationId: integer("application_id")
      .notNull()
      .references(() => applicationsTable.id, { onDelete: "restrict" }),
    applicationStage: text("application_stage").notNull(),
    applicationDeletedAt: timestamp("application_deleted_at", {
      withTimezone: true,
    }),
    applicationCreatedAt: timestamp("application_created_at", {
      withTimezone: true,
    }).notNull(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "social_attributed_applications_pk",
      columns: [table.tenantId, table.applicationId],
    }),
    unique("social_attributed_applications_one_touch_uq").on(
      table.applicationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.leadId],
      foreignColumns: [
        socialAttributedLeadsTable.tenantId,
        socialAttributedLeadsTable.leadId,
      ],
      name: "social_attributed_applications_lead_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.briefId],
      foreignColumns: [
        socialContentBriefsTable.tenantId,
        socialContentBriefsTable.id,
      ],
      name: "social_attributed_applications_brief_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_attributed_applications_organization_fk",
    }).onDelete("restrict"),
    index("social_attributed_applications_scope_created_idx").on(
      table.tenantId,
      table.organizationId,
      table.applicationCreatedAt,
      table.applicationId,
    ),
    index("social_attributed_applications_brief_stage_idx").on(
      table.tenantId,
      table.organizationId,
      table.briefId,
      table.applicationStage,
    ),
  ],
).enableRLS();

export const socialMediaAssetsTable = pgTable(
  "social_media_assets",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").notNull(),
    objectPath: text("object_path").notNull(),
    contentSha256: text("content_sha256").notNull(),
    mediaKind: text("media_kind").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    originalFileName: text("original_file_name").notNull(),
    createdByLegacyUserId: integer("created_by_legacy_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "social_media_assets_pk",
      columns: [table.tenantId, table.id],
    }),
    unique("social_media_assets_tenant_id_id_uq").on(table.tenantId, table.id),
    unique("social_media_assets_content_uq").on(
      table.tenantId,
      table.organizationId,
      table.contentSha256,
    ),
    unique("social_media_assets_object_uq").on(table.objectPath),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_media_assets_organization_fk",
    }).onDelete("restrict"),
    index("social_media_assets_scope_created_idx").on(
      table.tenantId,
      table.organizationId,
      table.createdAt,
      table.id,
    ),
    check("social_media_assets_id_v7_chk", uuidV7(table.id)),
    check(
      "social_media_assets_hash_chk",
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "social_media_assets_kind_chk",
      sql`${table.mediaKind} IN ('image', 'video')`,
    ),
  ],
).enableRLS();

export const socialCreativeRequestsTable = pgTable(
  "social_creative_requests",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    briefId: uuid("brief_id").notNull(),
    outputKind: text("output_kind").notNull(),
    provider: text("provider").notNull(),
    integrationKey: text("integration_key").notNull(),
    model: text("model"),
    locale: text("locale").notNull(),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt"),
    aspectRatio: text("aspect_ratio"),
    durationSeconds: integer("duration_seconds"),
    maxCostMinor: integer("max_cost_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    status: text("status").notNull().default("PENDING_APPROVAL"),
    requestKey: text("request_key").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseTokenHash: text("lease_token_hash"),
    leasedAt: timestamp("leased_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    workerId: text("worker_id"),
    providerRequestHash: text("provider_request_hash"),
    providerJobRef: text("provider_job_ref"),
    providerJobRefHash: text("provider_job_ref_hash"),
    providerReceiptHash: text("provider_receipt_hash"),
    resultCaption: text("result_caption"),
    generatedAssetId: uuid("generated_asset_id"),
    resolvedModel: text("resolved_model"),
    usage: jsonb("usage").$type<{
      inputUnits?: number;
      outputUnits?: number;
      estimatedCostMinor?: number;
      currencyCode?: string;
    }>(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    createdByLegacyUserId: integer("created_by_legacy_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    approvedByLegacyUserId: integer("approved_by_legacy_user_id").references(
      () => usersTable.id,
      { onDelete: "restrict" },
    ),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("social_creative_requests_tenant_id_id_uq").on(
      table.tenantId,
      table.id,
    ),
    unique("social_creative_requests_scope_key_uq").on(
      table.tenantId,
      table.organizationId,
      table.requestKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.briefId],
      foreignColumns: [
        socialContentBriefsTable.tenantId,
        socialContentBriefsTable.id,
      ],
      name: "social_creative_requests_brief_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.generatedAssetId],
      foreignColumns: [socialMediaAssetsTable.tenantId, socialMediaAssetsTable.id],
      name: "social_creative_requests_asset_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_creative_requests_organization_fk",
    }).onDelete("restrict"),
    index("social_creative_requests_queue_idx").on(
      table.tenantId,
      table.organizationId,
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
    index("social_creative_requests_brief_idx").on(
      table.tenantId,
      table.organizationId,
      table.briefId,
      table.createdAt,
    ),
    check("social_creative_requests_id_v7_chk", uuidV7(table.id)),
  ],
).enableRLS();

export const socialCreativeAttemptsTable = pgTable(
  "social_creative_attempts",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    creativeRequestId: uuid("creative_request_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id").notNull(),
    runtimeReleaseId: text("runtime_release_id").notNull(),
    outcome: text("outcome").notNull(),
    providerRequestHash: text("provider_request_hash").notNull(),
    providerReceiptHash: text("provider_receipt_hash"),
    generatedAssetSha256: text("generated_asset_sha256"),
    resolvedModel: text("resolved_model"),
    usage: jsonb("usage").$type<{
      inputUnits?: number;
      outputUnits?: number;
      estimatedCostMinor?: number;
      currencyCode?: string;
    }>(),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "social_creative_attempts_pk",
      columns: [table.tenantId, table.id],
    }),
    unique("social_creative_attempts_once_uq").on(
      table.tenantId,
      table.creativeRequestId,
      table.attemptNumber,
    ),
    foreignKey({
      columns: [table.tenantId, table.creativeRequestId],
      foreignColumns: [
        socialCreativeRequestsTable.tenantId,
        socialCreativeRequestsTable.id,
      ],
      name: "social_creative_attempts_request_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_creative_attempts_organization_fk",
    }).onDelete("restrict"),
    index("social_creative_attempts_request_idx").on(
      table.tenantId,
      table.organizationId,
      table.creativeRequestId,
      table.attemptNumber,
    ),
    check("social_creative_attempts_id_v7_chk", uuidV7(table.id)),
  ],
).enableRLS();

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
    unique("social_performance_snapshots_receipt_uq").on(
      table.tenantId,
      table.publicationIntentId,
      table.providerReceiptHash,
    ),
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
    index("social_performance_snapshots_observed_idx").on(
      table.tenantId,
      table.organizationId,
      table.observedAt,
      table.publicationIntentId,
    ),
  ],
);

export const socialPerformanceSyncStateTable = pgTable(
  "social_performance_sync_state",
  {
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    publicationIntentId: uuid("publication_intent_id").notNull(),
    status: text("status").notNull().default("PENDING"),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
    totalAttemptCount: bigint("total_attempt_count", { mode: "number" })
      .notNull()
      .default(0),
    consecutiveFailureCount: integer("consecutive_failure_count")
      .notNull()
      .default(0),
    maximumConsecutiveFailures: integer("maximum_consecutive_failures")
      .notNull()
      .default(8),
    leaseTokenHash: text("lease_token_hash"),
    leasedAt: timestamp("leased_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    workerId: text("worker_id"),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.publicationIntentId],
      name: "social_performance_sync_state_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.publicationIntentId],
      foreignColumns: [
        socialPublicationIntentsTable.tenantId,
        socialPublicationIntentsTable.id,
      ],
      name: "social_performance_sync_state_intent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_performance_sync_state_organization_fk",
    }).onDelete("restrict"),
    index("social_performance_sync_state_due_idx").on(
      table.tenantId,
      table.organizationId,
      table.nextSyncAt,
      table.publicationIntentId,
    ),
  ],
).enableRLS();

export const socialPerformanceAttemptsTable = pgTable(
  "social_performance_attempts",
  {
    id: uuid("id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    publicationIntentId: uuid("publication_intent_id").notNull(),
    attemptNumber: bigint("attempt_number", { mode: "number" }).notNull(),
    workerId: text("worker_id").notNull(),
    runtimeReleaseId: text("runtime_release_id").notNull(),
    outcome: text("outcome").notNull(),
    providerRequestHash: text("provider_request_hash").notNull(),
    providerReceiptHash: text("provider_receipt_hash"),
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
      name: "social_performance_attempts_pk",
    }),
    unique("social_performance_attempts_once_uq").on(
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
      name: "social_performance_attempts_intent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_performance_attempts_organization_fk",
    }).onDelete("restrict"),
    check("social_performance_attempts_id_v7_chk", uuidV7(table.id)),
  ],
).enableRLS();

export const socialWorkerHeartbeatsTable = pgTable(
  "social_worker_heartbeats",
  {
    tenantId: uuid("tenant_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    workerKind: text("worker_kind").notNull(),
    workerId: text("worker_id").notNull(),
    runtimeReleaseId: text("runtime_release_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.organizationId,
        table.workerKind,
        table.workerId,
      ],
      name: "social_worker_heartbeats_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "social_worker_heartbeats_organization_fk",
    }).onDelete("restrict"),
    check(
      "social_worker_heartbeats_kind_chk",
      sql`${table.workerKind} IN ('publication', 'performance', 'creative')`,
    ),
    check(
      "social_worker_heartbeats_worker_id_chk",
      sql`${table.workerId} ~ '^[A-Za-z0-9._:-]{1,96}$'`,
    ),
    check(
      "social_worker_heartbeats_release_chk",
      sql`${table.runtimeReleaseId} ~ '^[A-Za-z0-9._:-]{1,96}$'`,
    ),
    check(
      "social_worker_heartbeats_time_chk",
      sql`${table.lastSeenAt} >= ${table.startedAt}`,
    ),
    index("social_worker_heartbeats_liveness_idx").on(
      table.tenantId,
      table.organizationId,
      table.workerKind,
      table.lastSeenAt,
    ),
  ],
).enableRLS();

export type SocialContentBrief = typeof socialContentBriefsTable.$inferSelect;
export type SocialAccount = typeof socialAccountsTable.$inferSelect;
export type SocialCreativeRequest =
  typeof socialCreativeRequestsTable.$inferSelect;
export type SocialCreativeAttempt =
  typeof socialCreativeAttemptsTable.$inferSelect;
export type SocialPublicationIntent =
  typeof socialPublicationIntentsTable.$inferSelect;
