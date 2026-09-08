import { pgTable, serial, text, timestamp, integer, boolean, jsonb, real, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const userSessionsTable = pgTable("user_sessions_activity", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  totalDurationSeconds: integer("total_duration_seconds").notNull().default(0),
  activeDurationSeconds: integer("active_duration_seconds").notNull().default(0),
  idleDurationSeconds: integer("idle_duration_seconds").notNull().default(0),
  endReason: text("end_reason"),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  isActive: boolean("is_active").notNull().default(true),
}, (table) => [
  index("user_sessions_activity_user_started_idx").on(table.userId, table.startedAt.desc()),
  index("user_sessions_activity_overlap_idx").on(
    sql`COALESCE(${table.endedAt}, ${table.lastSeenAt})`,
    table.startedAt,
    table.userId,
  ),
  index("user_sessions_activity_active_last_seen_idx")
    .on(table.lastSeenAt, table.id)
    .where(sql`${table.isActive} = true`),
]);

export const userPageVisitsTable = pgTable("user_page_visits", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => userSessionsTable.id, { onDelete: "cascade" }),
  route: text("route").notNull(),
  moduleName: text("module_name").notNull(),
  enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
  leftAt: timestamp("left_at", { withTimezone: true }),
  totalDurationSeconds: integer("total_duration_seconds").notNull().default(0),
  activeDurationSeconds: integer("active_duration_seconds").notNull().default(0),
  idleDurationSeconds: integer("idle_duration_seconds").notNull().default(0),
}, (table) => [
  index("user_page_visits_user_entered_idx").on(table.userId, table.enteredAt.desc()),
  index("user_page_visits_module_entered_idx").on(table.moduleName, table.enteredAt.desc()),
]);

export const userActivityEventsTable = pgTable("user_activity_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => userSessionsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  route: text("route"),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("user_activity_events_user_created_idx").on(table.userId, table.createdAt.desc()),
]);

export const userPresenceTable = pgTable("user_presence", {
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }).primaryKey(),
  status: text("status").notNull().default("offline"),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  currentRoute: text("current_route"),
  sessionId: integer("session_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("user_presence_status_last_active_idx")
    .on(table.status, table.lastActiveAt.desc())
    .where(sql`${table.status} <> 'offline'`),
]);

export type UserSessionActivity = typeof userSessionsTable.$inferSelect;
export type UserPageVisit = typeof userPageVisitsTable.$inferSelect;
export type UserActivityEvent = typeof userActivityEventsTable.$inferSelect;
export type UserPresence = typeof userPresenceTable.$inferSelect;

export const ENTITY_VIEW_TYPES = ["lead", "student", "application", "message_thread"] as const;
export type EntityViewType = (typeof ENTITY_VIEW_TYPES)[number];

export const entityViewEventsTable = pgTable("entity_view_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull().$type<EntityViewType>(),
  entityId: integer("entity_id").notNull(),
  viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  agentId: integer("agent_id").references(() => usersTable.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("entity_view_events_user_viewed_at_idx").on(table.userId, table.viewedAt),
  index("entity_view_events_entity_type_viewed_at_idx").on(table.entityType, table.viewedAt),
]);

export type EntityViewEvent = typeof entityViewEventsTable.$inferSelect;
