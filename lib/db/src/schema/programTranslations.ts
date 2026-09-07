import {
  boolean,
  check,
  index,
  integer,
  primaryKey,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { programsTable } from "./universities";

/**
 * Materialized localized projections for the canonical English programme row.
 *
 * The same row also acts as a durable, lease-based translation queue. Only a
 * PUBLISHED row is served to catalogue consumers; every other state safely
 * falls back to the canonical English programme content.
 */
export const programTranslationsTable = pgTable(
  "program_translations",
  {
    programId: integer("program_id")
      .notNull()
      .references(() => programsTable.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    name: text("name"),
    description: text("description"),
    field: text("field"),
    duration: text("duration"),
    intakes: text("intakes"),
    requirements: text("requirements"),
    sourceHash: text("source_hash").notNull(),
    status: text("status").notNull().default("queued"),
    isManual: boolean("is_manual").notNull().default(false),
    provider: text("provider"),
    model: text("model"),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leasedAt: timestamp("leased_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    workerId: text("worker_id"),
    translatedAt: timestamp("translated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.programId, table.locale], name: "program_translations_pk" }),
    index("program_translations_queue_idx").on(table.status, table.nextAttemptAt, table.programId),
    index("program_translations_program_status_idx").on(table.programId, table.status),
    index("program_translations_locale_name_idx").on(table.locale, table.name),
    check(
      "program_translations_locale_chk",
      sql`${table.locale} IN ('tr','ar','fr','ru','fa','zh','hi','es','id','ur','tk','ky','kk','uz','tg')`,
    ),
    check(
      "program_translations_status_chk",
      sql`${table.status} IN ('queued','processing','retrying','published','failed','stale_manual')`,
    ),
    check("program_translations_source_hash_chk", sql`${table.sourceHash} ~ '^[0-9a-f]{64}$'`),
    check("program_translations_attempts_chk", sql`${table.attempts} >= 0 AND ${table.attempts} <= 20`),
  ],
);

export type ProgramTranslation = typeof programTranslationsTable.$inferSelect;
export type InsertProgramTranslation = typeof programTranslationsTable.$inferInsert;
