import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export const portalUniversitiesTable = pgTable(
  "portal_universities",
  {
    id: serial("id").primaryKey(),
    universityKey: text("university_key").notNull(),
    universityName: text("university_name").notNull(),
    adapterKey: text("adapter_key").notNull(),
    /**
     * Monotonic identity for the effective adapter/credential/routing setup.
     * Verification receipts are accepted only for the current generation.
     */
    verificationGeneration: integer("verification_generation").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    /** When true, scheduled drain-once.ts will include this university's queued submissions. */
    autoProcess: boolean("auto_process").notNull().default(false),
    /**
     * When true this row is a "multi-portal" company: a single panel that submits
     * applications on behalf of several member universities (e.g. SIT, United).
     */
    isMultiPortal: boolean("is_multi_portal").notNull().default(false),
    /**
     * If set, applications for this university are routed through the multi-portal
     * company whose `universityKey` equals this value. NULL = use own adapter.
     */
    routesVia: text("routes_via"),
    crmUniversityId: integer("crm_university_id"),
    defaults: jsonb("defaults").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /**
     * Per-university fan-out mode override.
     * null = inherit from global portal_automation_settings.fan_out_mode.
     * 'off' | 'manual' | 'auto' = explicit override.
     */
    fanOutMode: text("fan_out_mode"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("portal_uni_university_key_uniq").on(table.universityKey),
    index("portal_uni_adapter_key_idx").on(table.adapterKey),
    index("portal_uni_is_active_idx").on(table.isActive),
    index("portal_uni_routes_via_idx").on(table.routesVia),
  ],
);

export type PortalUniversity = typeof portalUniversitiesTable.$inferSelect;
export type InsertPortalUniversity =
  typeof portalUniversitiesTable.$inferInsert;
