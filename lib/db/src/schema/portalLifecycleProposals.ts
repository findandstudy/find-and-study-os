import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { applicationsTable } from "./applications";
import { portalLifecycleObservationsTable } from "./portalLifecycleObservations";
import { portalSubmissionsTable } from "./portalSubmissions";
import { usersTable } from "./users";

export const portalLifecycleProposalsTable = pgTable(
  "portal_lifecycle_proposals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    submissionId: integer("submission_id").notNull(),
    applicationId: integer("application_id").notNull().references(() => applicationsTable.id, { onDelete: "cascade" }),
    observationId: integer("observation_id").notNull().references(() => portalLifecycleObservationsTable.id, { onDelete: "restrict" }),
    proposalKey: text("proposal_key").notNull().unique(),
    observationHash: text("observation_hash").notNull(),
    rawStatus: text("raw_status").notNull(),
    currentStage: text("current_stage").notNull(),
    decision: jsonb("decision").$type<Record<string, unknown>>().notNull(),
    artifacts: jsonb("artifacts").$type<string[]>().notNull().default([]),
    missingDocuments: jsonb("missing_documents").$type<Array<{ code?: string; label: string }>>().notNull().default([]),
    applicationReferenceSync: text("application_reference_sync"),
    status: text("status").notNull().default("pending_review"),
    proposedByService: text("proposed_by_service").notNull().default("portal-status-worker"),
    proposedByUserId: integer("proposed_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    reviewedBy: integer("reviewed_by").references(() => usersTable.id, { onDelete: "restrict" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.submissionId, table.applicationId],
      foreignColumns: [portalSubmissionsTable.id, portalSubmissionsTable.applicationId],
      name: "portal_lifecycle_proposals_submission_application_fk",
    }).onDelete("cascade"),
    index("portal_lifecycle_proposals_review_queue_idx").on(table.createdAt, table.id).where(sql`${table.status} = 'pending_review'`),
    index("portal_lifecycle_proposals_application_idx").on(table.applicationId, table.createdAt.desc()),
    check("portal_lifecycle_proposals_key_chk", sql`${table.proposalKey} ~ '^portal_lifecycle:[0-9a-f]{64}$'`),
    check("portal_lifecycle_proposals_observation_hash_chk", sql`${table.observationHash} ~ '^[0-9a-f]{64}$'`),
    check("portal_lifecycle_proposals_status_chk", sql`${table.status} IN ('pending_review', 'approved', 'rejected', 'executing', 'executed', 'failed', 'canceled')`),
    check("portal_lifecycle_proposals_review_pair_chk", sql`(${table.reviewedBy} IS NULL) = (${table.reviewedAt} IS NULL)`),
    check("portal_lifecycle_proposals_maker_checker_chk", sql`${table.proposedByUserId} IS NULL OR ${table.reviewedBy} IS NULL OR ${table.proposedByUserId} <> ${table.reviewedBy}`),
  ],
);

export const portalLifecycleProposalReviewsTable = pgTable(
  "portal_lifecycle_proposal_reviews",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    proposalId: bigint("proposal_id", { mode: "number" }).notNull().references(() => portalLifecycleProposalsTable.id, { onDelete: "restrict" }),
    reviewerId: integer("reviewer_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    reason: text("reason"),
    requestKey: text("request_key").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("portal_lifecycle_proposal_reviews_once_uq").on(table.proposalId),
    unique("portal_lifecycle_proposal_reviews_request_uq").on(table.requestKey),
    check("portal_lifecycle_proposal_reviews_decision_chk", sql`${table.decision} IN ('approve', 'reject')`),
    check("portal_lifecycle_proposal_reviews_hash_chk", sql`${table.evidenceSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);
