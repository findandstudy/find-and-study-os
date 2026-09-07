import { pgTable, text, serial, timestamp, integer, boolean, real, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const universitiesTable = pgTable("universities", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  city: text("city"),
  website: text("website"),
  logoUrl: text("logo_url"),
  description: text("description"),
  ranking: integer("ranking"),
  isActive: boolean("is_active").notNull().default(true),

  universityType: text("university_type"),
  taxType: text("tax_type"),
  taxPercent: real("tax_percent"),
  qsRanking: integer("qs_ranking"),
  timesRanking: integer("times_ranking"),
  shanghaiRanking: integer("shanghai_ranking"),
  cwtsLeidenRanking: integer("cwts_leiden_ranking"),
  address: text("address"),
  onlinePaymentUrl: text("online_payment_url"),
  cricosLink: text("cricos_link"),
  documentsLink: text("documents_link"),
  currentFeeListLink: text("current_fee_list_link"),
  initialDepositOptions: text("initial_deposit_options"),
  admissionProcess: text("admission_process"),
  contactPersonName: text("contact_person_name"),
  contactPersonPhone: text("contact_person_phone"),
  contactPersonEmail: text("contact_person_email"),
  status: text("status").notNull().default("open"),

  // Active staff explicitly responsible for this university — they
  // also receive university-contract expiry warnings (alongside
  // active super_admin/admin/manager users).
  assignedStaffIds: jsonb("assigned_staff_ids").notNull().default([]).$type<number[]>(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("universities_country_idx").on(table.country),
  index("universities_is_active_idx").on(table.isActive),
]);

export const programsTable = pgTable("programs", {
  id: serial("id").primaryKey(),
  universityId: integer("university_id").notNull().references(() => universitiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // English is the canonical source language for programme content. Localized
  // projections live in program_translations and are regenerated whenever one
  // of the human-readable source fields changes.
  description: text("description"),
  degree: text("degree"),
  field: text("field"),
  language: text("language"),
  duration: text("duration"),
  tuitionFee: real("tuition_fee"),
  currency: text("currency").default("USD"),
  scholarship: real("scholarship"),
  intakes: text("intakes"),
  requirements: text("requirements"),
  commissionRate: real("commission_rate"),
  applicationFee: real("application_fee"),
  advancedFee: real("advanced_fee"),
  depositFee: real("deposit_fee"),
  serviceFeeAmount: real("service_fee_amount"),
  discountedFee: real("discounted_fee"),
  languageFee: real("language_fee"),
  feeType: text("fee_type"),
  minGpa: real("min_gpa"),
  minLanguageScore: real("min_language_score"),
  quota: integer("quota"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("programs_university_id_idx").on(table.universityId),
  index("programs_degree_idx").on(table.degree),
  index("programs_field_idx").on(table.field),
  index("programs_is_active_idx").on(table.isActive),
]);

export const insertUniversitySchema = createInsertSchema(universitiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUniversity = z.infer<typeof insertUniversitySchema>;
export type University = typeof universitiesTable.$inferSelect;

export const insertProgramSchema = createInsertSchema(programsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProgram = z.infer<typeof insertProgramSchema>;
export type Program = typeof programsTable.$inferSelect;
