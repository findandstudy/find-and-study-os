import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { portalUniversitiesTable } from "./portalUniversities";
import { usersTable } from "./users";

export const portalWorkerHeartbeatsTable = pgTable(
  "portal_worker_heartbeats",
  {
    workerKind: text("worker_kind").notNull(),
    workerId: text("worker_id").notNull(),
    runtimeReleaseId: text("runtime_release_id").notNull(),
    executionModes: text("execution_modes").array().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workerKind, table.workerId] }),
    check("portal_worker_heartbeats_kind_chk", sql`${table.workerKind} IN ('portal_execution')`),
    check("portal_worker_heartbeats_worker_id_chk", sql`length(${table.workerId}) BETWEEN 1 AND 160`),
    check("portal_worker_heartbeats_release_chk", sql`${table.runtimeReleaseId} ~ '^[A-Za-z0-9._:-]{1,80}$'`),
    check("portal_worker_heartbeats_modes_chk", sql`${table.executionModes} <@ ARRAY['test_login', 'dry', 'real', 'status_check', 'artifact', 'program_catalog_sync', 'lifecycle_execute']::text[]`),
  ],
);

export const portalWorkerJobsTable = pgTable(
  "portal_worker_jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobKind: text("job_kind").notNull(),
    portalUniversityId: integer("portal_university_id").references(
      () => portalUniversitiesTable.id,
      { onDelete: "restrict" },
    ),
    requestKey: text("request_key").notNull(),
    requestedReleaseId: text("requested_release_id").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastErrorCode: text("last_error_code"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    requestedBy: integer("requested_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("portal_worker_jobs_request_uq").on(
      table.jobKind,
      sql`coalesce(${table.portalUniversityId}, 0)`,
      table.requestKey,
    ),
    index("portal_worker_jobs_claim_idx")
      .on(table.status, table.nextAttemptAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    index("portal_worker_jobs_partner_idx").on(table.portalUniversityId, table.createdAt),
    check("portal_worker_jobs_kind_chk", sql`${table.jobKind} IN ('test_login', 'status_sweep', 'program_catalog_sync', 'lifecycle_execute')`),
    check("portal_worker_jobs_partner_chk", sql`(${table.jobKind} IN ('status_sweep', 'lifecycle_execute')) = (${table.portalUniversityId} IS NULL)`),
    check("portal_worker_jobs_request_key_chk", sql`length(${table.requestKey}) BETWEEN 1 AND 100 AND ${table.requestKey} ~ '^[A-Za-z0-9._:-]+$'`),
    check("portal_worker_jobs_release_chk", sql`${table.requestedReleaseId} ~ '^[A-Za-z0-9._:-]{1,80}$'`),
    check("portal_worker_jobs_payload_hash_chk", sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$' AND jsonb_typeof(${table.payload}) = 'object'`),
    check("portal_worker_jobs_status_chk", sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter', 'canceled')`),
    check("portal_worker_jobs_attempts_chk", sql`${table.attempts} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 10 AND ${table.attempts} <= ${table.maxAttempts}`),
    check("portal_worker_jobs_lock_pair_chk", sql`(${table.lockedAt} IS NULL) = (${table.lockedBy} IS NULL)`),
    check("portal_worker_jobs_terminal_chk", sql`(${table.status} IN ('succeeded', 'failed', 'dead_letter', 'canceled')) = (${table.finishedAt} IS NOT NULL)`),
    check("portal_worker_jobs_result_chk", sql`${table.result} IS NULL OR jsonb_typeof(${table.result}) = 'object'`),
  ],
);

export const portalWorkerJobReceiptsTable = pgTable(
  "portal_worker_job_receipts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => portalWorkerJobsTable.id, { onDelete: "restrict" }),
    attempt: integer("attempt").notNull(),
    outcome: text("outcome").notNull(),
    workerId: text("worker_id").notNull(),
    runtimeReleaseId: text("runtime_release_id").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    errorCode: text("error_code"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("portal_worker_job_receipts_attempt_uq").on(table.jobId, table.attempt),
    check("portal_worker_job_receipts_attempt_chk", sql`${table.attempt} > 0`),
    check("portal_worker_job_receipts_outcome_chk", sql`${table.outcome} IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTER')`),
    check("portal_worker_job_receipts_worker_id_chk", sql`length(${table.workerId}) BETWEEN 1 AND 160`),
    check("portal_worker_job_receipts_release_chk", sql`${table.runtimeReleaseId} ~ '^[A-Za-z0-9._:-]{1,80}$'`),
    check("portal_worker_job_receipts_hash_chk", sql`${table.evidenceSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type PortalWorkerJob = typeof portalWorkerJobsTable.$inferSelect;
