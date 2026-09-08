import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { applicationsTable } from "./applications";
import { portalAdapterSpecsTable } from "./portalAdapterSpecs";
import { portalCredentialsTable } from "./portalCredentials";
import { portalSubmissionsTable } from "./portalSubmissions";
import { portalUniversitiesTable } from "./portalUniversities";
import { usersTable } from "./users";

/**
 * Append-only evidence for the two partner-onboarding checks that are allowed
 * to unlock execution. A receipt is valid only while its configuration
 * generation, runtime release and immutable adapter binding remain current.
 */
export const portalPartnerVerificationReceiptsTable = pgTable(
  "portal_partner_verification_receipts",
  {
    id: serial("id").primaryKey(),
    portalUniversityId: integer("portal_university_id")
      .notNull()
      .references(() => portalUniversitiesTable.id, { onDelete: "restrict" }),
    verificationGeneration: integer("verification_generation").notNull(),
    verificationType: text("verification_type").notNull(),
    outcome: text("outcome").notNull(),
    adapterKey: text("adapter_key").notNull(),
    adapterSpecId: integer("adapter_spec_id").references(
      () => portalAdapterSpecsTable.id,
      { onDelete: "restrict" },
    ),
    adapterSpecVersion: integer("adapter_spec_version"),
    adapterSpecSha256: text("adapter_spec_sha256"),
    credentialId: integer("credential_id").references(
      () => portalCredentialsTable.id,
      { onDelete: "restrict" },
    ),
    credentialUpdatedAt: timestamp("credential_updated_at", { withTimezone: true }),
    runtimeReleaseId: text("runtime_release_id").notNull(),
    bindingSha256: text("binding_sha256").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    requestKey: text("request_key").notNull(),
    applicationId: integer("application_id").references(
      () => applicationsTable.id,
      { onDelete: "restrict" },
    ),
    portalSubmissionId: integer("portal_submission_id"),
    performedBy: integer("performed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    failureCode: text("failure_code"),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("portal_partner_verification_request_uq").on(
      table.portalUniversityId,
      table.verificationGeneration,
      table.verificationType,
      table.requestKey,
    ),
    index("portal_partner_verification_current_idx").on(
      table.portalUniversityId,
      table.verificationGeneration,
      table.verificationType,
      table.outcome,
      table.createdAt,
    ),
    index("portal_partner_verification_submission_idx").on(
      table.portalSubmissionId,
    ),
    foreignKey({
      columns: [table.portalSubmissionId, table.applicationId],
      foreignColumns: [
        portalSubmissionsTable.id,
        portalSubmissionsTable.applicationId,
      ],
      name: "portal_partner_verification_submission_application_fk",
    }).onDelete("restrict"),
    check(
      "portal_partner_verification_generation_chk",
      sql`${table.verificationGeneration} > 0`,
    ),
    check(
      "portal_partner_verification_type_chk",
      sql`${table.verificationType} IN ('TEST_LOGIN', 'STRICT_DRY_RUN')`,
    ),
    check(
      "portal_partner_verification_outcome_chk",
      sql`${table.outcome} IN ('PASSED', 'FAILED')`,
    ),
    check(
      "portal_partner_verification_adapter_key_chk",
      sql`length(${table.adapterKey}) BETWEEN 1 AND 100`,
    ),
    check(
      "portal_partner_verification_spec_binding_chk",
      sql`(
        ${table.adapterSpecId} IS NULL
        AND ${table.adapterSpecVersion} IS NULL
        AND ${table.adapterSpecSha256} IS NULL
      ) OR (
        ${table.adapterSpecId} IS NOT NULL
        AND ${table.adapterSpecVersion} > 0
        AND ${table.adapterSpecSha256} ~ '^[0-9a-f]{64}$'
      )`,
    ),
    check(
      "portal_partner_verification_credential_binding_chk",
      sql`(
        ${table.credentialId} IS NULL AND ${table.credentialUpdatedAt} IS NULL
      ) OR (
        ${table.credentialId} IS NOT NULL AND ${table.credentialUpdatedAt} IS NOT NULL
      )`,
    ),
    check(
      "portal_partner_verification_runtime_release_chk",
      sql`${table.runtimeReleaseId} ~ '^[A-Za-z0-9._:-]{1,80}$'`,
    ),
    check(
      "portal_partner_verification_hashes_chk",
      sql`${table.bindingSha256} ~ '^[0-9a-f]{64}$' AND ${table.evidenceSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "portal_partner_verification_request_key_chk",
      sql`length(${table.requestKey}) BETWEEN 1 AND 100 AND ${table.requestKey} ~ '^[A-Za-z0-9._:-]+$'`,
    ),
    check(
      "portal_partner_verification_failure_chk",
      sql`(${table.outcome} = 'PASSED' AND ${table.failureCode} IS NULL) OR (${table.outcome} = 'FAILED' AND length(${table.failureCode}) BETWEEN 1 AND 80)`,
    ),
    check(
      "portal_partner_verification_strict_dry_run_chk",
      sql`${table.verificationType} <> 'STRICT_DRY_RUN' OR (${table.applicationId} IS NOT NULL AND ${table.portalSubmissionId} IS NOT NULL)`,
    ),
    check(
      "portal_partner_verification_evidence_chk",
      sql`jsonb_typeof(${table.evidence}) = 'object'`,
    ),
  ],
);

export type PortalPartnerVerificationReceipt =
  typeof portalPartnerVerificationReceiptsTable.$inferSelect;
export type NewPortalPartnerVerificationReceipt =
  typeof portalPartnerVerificationReceiptsTable.$inferInsert;
