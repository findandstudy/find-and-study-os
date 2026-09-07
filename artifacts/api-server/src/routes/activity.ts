import { Router, type IRouter } from "express";
import { execSync } from "child_process";
import fs from "fs";
import {
  db,
  userSessionsTable,
  userPageVisitsTable,
  userActivityEventsTable,
  userPresenceTable,
  usersTable,
} from "@workspace/db";
import { eq, and, desc, sql, gte, lte, inArray, ne, count } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../lib/auth";
import { getValidated, validate } from "../middlewares/validate";
import { ADMIN_ROLES, STAFF_ROLES } from "../lib/roles";
import { withRenderLock } from "../lib/renderLock";
import {
  deriveModuleName,
  normalizeModuleBreakdown,
  clampSessionMetrics,
  normalizeActivitySession,
  MAX_HEARTBEAT_DELTA_SECONDS,
  MAX_TRACKED_SESSION_SECONDS,
  isValidActivityReportRange,
} from "../lib/activityNormalize";
import {
  loadBrandedPdfSettings,
  resolveBrandedAssets,
  buildBrandedHtml,
  buildBrandedFooterTemplate,
  buildDailyBarChartSvg,
} from "../lib/pdf/brandedBase";

// Map the app's i18n language codes to BCP-47 tags so PDF dates format per the
// viewer's selected locale (no hardcoded date locale).
const LOCALE_MAP: Record<string, string> = {
  en: "en-GB", tr: "tr-TR", ar: "ar", fr: "fr-FR", ru: "ru-RU",
  fa: "fa-IR", zh: "zh-CN", hi: "hi-IN", es: "es-ES", id: "id-ID",
};
function resolveLocale(l?: string): string {
  return (l && LOCALE_MAP[l]) || "en-GB";
}

let cachedChromiumPath: string | undefined;
let chromiumPathResolved = false;
function resolveChromium(): string | undefined {
  if (chromiumPathResolved) return cachedChromiumPath;
  chromiumPathResolved = true;
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (fromEnv) {
    cachedChromiumPath = fromEnv;
    return cachedChromiumPath;
  }
  try {
    const nixDir = "/nix/store";
    if (fs.existsSync(nixDir)) {
      for (const entry of fs.readdirSync(nixDir)) {
        if (!entry.includes("chromium")) continue;
        const candidate = `${nixDir}/${entry}/bin/chromium`;
        if (fs.existsSync(candidate)) {
          cachedChromiumPath = candidate;
          return cachedChromiumPath;
        }
      }
    }
  } catch {
    // Fall through to PATH resolution.
  }
  try {
    const found = execSync("which chromium", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (found) cachedChromiumPath = found;
  } catch {
    // Playwright will apply its own executable lookup.
  }
  return cachedChromiumPath;
}

function capSessionWallClock<T extends {
  startedAt: Date | string | null;
  endedAt: Date | string | null;
  lastSeenAt: Date | string | null;
  totalDurationSeconds: number | null;
  activeDurationSeconds: number | null;
  idleDurationSeconds: number | null;
}>(s: T): T {
  const normalized = normalizeActivitySession(s);
  return {
    ...s,
    totalDurationSeconds: normalized.totalDurationSeconds,
    activeDurationSeconds: normalized.activeDurationSeconds,
    idleDurationSeconds: normalized.idleDurationSeconds,
  };
}

const router: IRouter = Router();

const STALE_HEARTBEAT_SECONDS = 120;
const activitySessionIdSchema = z.coerce.number().int().positive();
const activityRouteSchema = z.string().trim().min(1).max(512).regex(/^\/[^\u0000-\u001f\u007f?#]*$/);
const heartbeatBodySchema = z.object({
  sessionId: activitySessionIdSchema,
  status: z.enum(["active", "idle"]).default("active"),
  route: activityRouteSchema.optional(),
});
const pageVisitBodySchema = z.object({
  sessionId: activitySessionIdSchema,
  route: activityRouteSchema,
  moduleName: z.string().trim().min(1).max(100).optional(),
});
const pageLeaveBodySchema = z.object({
  visitId: z.coerce.number().int().positive(),
  activeDuration: z.coerce.number().finite().nonnegative().max(MAX_TRACKED_SESSION_SECONDS).default(0),
  idleDuration: z.coerce.number().finite().nonnegative().max(MAX_TRACKED_SESSION_SECONDS).default(0),
});
const activityEventBodySchema = z.object({
  sessionId: activitySessionIdSchema.nullish(),
  eventType: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9._:-]*$/i),
  route: activityRouteSchema.optional(),
  metadata: z.record(z.string(), z.unknown())
    .refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 8_192)
    .optional(),
});
const sessionEndBodySchema = z.object({
  sessionId: activitySessionIdSchema.nullish(),
  reason: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9._:-]*$/i).default("manual_logout"),
});

async function closeStaleSession(sessionId: number, reason: string) {
  const [session] = await db.select().from(userSessionsTable).where(eq(userSessionsTable.id, sessionId));
  if (!session || !session.isActive) return;

  const endedAt = session.lastSeenAt;
  const totalSec = (session.activeDurationSeconds || 0) + (session.idleDurationSeconds || 0);
  await db.update(userSessionsTable).set({
    isActive: false,
    endedAt,
    endReason: reason,
    totalDurationSeconds: totalSec,
  }).where(eq(userSessionsTable.id, sessionId));

  await db.update(userPresenceTable).set({
    status: "offline",
    updatedAt: new Date(),
    sessionId: null,
  }).where(eq(userPresenceTable.userId, session.userId));
}

async function cleanupStaleSessions() {
  const threshold = new Date(Date.now() - STALE_HEARTBEAT_SECONDS * 1000);
  const stale = await db.select({ id: userSessionsTable.id })
    .from(userSessionsTable)
    .where(and(
      eq(userSessionsTable.isActive, true),
      lte(userSessionsTable.lastSeenAt, threshold)
    ))
    .orderBy(userSessionsTable.lastSeenAt)
    .limit(500);
  for (const s of stale) {
    await closeStaleSession(s.id, "stale_heartbeat");
  }
}

export function startActivityStaleSessionCleanup(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void cleanupStaleSessions()
      .catch(() => console.error("[activity] stale-session cleanup failed"))
      .finally(() => { running = false; });
  };
  run();
  const timer = setInterval(run, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

router.post("/activity/session/start", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const userAgent = req.headers["user-agent"] || "";

  const existing = await db.select().from(userSessionsTable)
    .where(and(eq(userSessionsTable.userId, userId), eq(userSessionsTable.isActive, true)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(userSessionsTable).set({ lastSeenAt: new Date() }).where(eq(userSessionsTable.id, existing[0].id));
    await db.insert(userPresenceTable).values({ userId, status: "active", lastActiveAt: new Date(), sessionId: existing[0].id })
      .onConflictDoUpdate({ target: userPresenceTable.userId, set: { status: "active", lastActiveAt: new Date(), sessionId: existing[0].id, updatedAt: new Date() } });
    res.json({ sessionId: existing[0].id, resumed: true });
    return;
  }

  const [session] = await db.insert(userSessionsTable).values({
    userId, userAgent, ipAddress: req.ip || null,
  }).returning();

  await db.insert(userPresenceTable).values({ userId, status: "active", lastActiveAt: new Date(), sessionId: session.id })
    .onConflictDoUpdate({ target: userPresenceTable.userId, set: { status: "active", lastActiveAt: new Date(), sessionId: session.id, updatedAt: new Date() } });

  await db.insert(userActivityEventsTable).values({ userId, sessionId: session.id, eventType: "session_started", metadata: { userAgent } });

  res.json({ sessionId: session.id });
});

router.post("/activity/heartbeat", requireAuth, validate({ body: heartbeatBodySchema }), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const { sessionId, status, route } = getValidated<{ body: typeof heartbeatBodySchema }>(req).body;

  const now = new Date();
  const presenceStatus = status === "idle" ? "idle" : "active";
  // Never trust elapsed seconds reported by the browser. Sleeping tabs and
  // multiple tabs previously turned a sub-minute session into 20+ hours. The
  // database's previous last_seen_at is the atomic source of elapsed time, and
  // the accepted interval is capped slightly above the 30-second heartbeat.
  const elapsedSeconds = sql<number>`least(
    greatest(extract(epoch from (now() - ${userSessionsTable.lastSeenAt})), 0),
    ${MAX_HEARTBEAT_DELTA_SECONDS}
  )::integer`;
  const [updated] = await db.update(userSessionsTable).set({
    lastSeenAt: now,
    activeDurationSeconds: presenceStatus === "active"
      ? sql`${userSessionsTable.activeDurationSeconds} + ${elapsedSeconds}`
      : userSessionsTable.activeDurationSeconds,
    idleDurationSeconds: presenceStatus === "idle"
      ? sql`${userSessionsTable.idleDurationSeconds} + ${elapsedSeconds}`
      : userSessionsTable.idleDurationSeconds,
    totalDurationSeconds: sql`${userSessionsTable.totalDurationSeconds} + ${elapsedSeconds}`,
  }).where(and(
    eq(userSessionsTable.id, sessionId),
    eq(userSessionsTable.userId, userId),
    eq(userSessionsTable.isActive, true),
  )).returning({ id: userSessionsTable.id });

  if (!updated) {
    res.status(409).json({ error: "Activity session is no longer active" });
    return;
  }

  await db.insert(userPresenceTable).values({
    userId, status: presenceStatus, lastActiveAt: presenceStatus === "active" ? now : undefined, currentRoute: route, sessionId, updatedAt: now,
  }).onConflictDoUpdate({
    target: userPresenceTable.userId,
    set: { status: presenceStatus, ...(presenceStatus === "active" ? { lastActiveAt: now } : {}), currentRoute: route, sessionId, updatedAt: now },
  });

  res.json({ ok: true });
});

router.post("/activity/page-visit", requireAuth, validate({ body: pageVisitBodySchema }), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const { sessionId, route, moduleName } = getValidated<{ body: typeof pageVisitBodySchema }>(req).body;

  const [ownedSession] = await db.select({ id: userSessionsTable.id }).from(userSessionsTable)
    .where(and(
      eq(userSessionsTable.id, sessionId),
      eq(userSessionsTable.userId, userId),
      eq(userSessionsTable.isActive, true),
    ))
    .limit(1);
  if (!ownedSession) { res.status(409).json({ error: "Activity session is no longer active" }); return; }

  const [visit] = await db.insert(userPageVisitsTable).values({
    userId, sessionId, route, moduleName: moduleName || deriveModuleName(route),
  }).returning();

  res.json({ visitId: visit.id });
});

router.post("/activity/page-leave", requireAuth, validate({ body: pageLeaveBodySchema }), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const { visitId, activeDuration, idleDuration } = getValidated<{ body: typeof pageLeaveBodySchema }>(req).body;

  const now = new Date();
  const [visit] = await db.select({ enteredAt: userPageVisitsTable.enteredAt }).from(userPageVisitsTable)
    .where(and(eq(userPageVisitsTable.id, visitId), eq(userPageVisitsTable.userId, userId)))
    .limit(1);
  if (!visit) { res.status(404).json({ error: "Activity page visit not found" }); return; }
  const wallClockSeconds = Math.max(0, Math.min(
    MAX_TRACKED_SESSION_SECONDS,
    Math.floor((now.getTime() - visit.enteredAt.getTime()) / 1_000),
  ));
  const boundedActive = Math.min(Math.round(activeDuration), wallClockSeconds);
  const boundedIdle = Math.min(Math.round(idleDuration), Math.max(0, wallClockSeconds - boundedActive));
  await db.update(userPageVisitsTable).set({
    leftAt: now,
    activeDurationSeconds: boundedActive,
    idleDurationSeconds: boundedIdle,
    totalDurationSeconds: boundedActive + boundedIdle,
  }).where(and(eq(userPageVisitsTable.id, visitId), eq(userPageVisitsTable.userId, userId)));

  res.json({ ok: true });
});

router.post("/activity/event", requireAuth, validate({ body: activityEventBodySchema }), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const { sessionId, eventType, route, metadata } = getValidated<{ body: typeof activityEventBodySchema }>(req).body;
  if (sessionId) {
    const [ownedSession] = await db.select({ id: userSessionsTable.id }).from(userSessionsTable)
      .where(and(
        eq(userSessionsTable.id, sessionId),
        eq(userSessionsTable.userId, userId),
        eq(userSessionsTable.isActive, true),
      ))
      .limit(1);
    if (!ownedSession) { res.status(409).json({ error: "Activity session is no longer active" }); return; }
  }

  await db.insert(userActivityEventsTable).values({
    userId, sessionId, eventType, route, metadata: metadata || {},
  });
  res.json({ ok: true });
});

router.post("/activity/session/end", requireAuth, validate({ body: sessionEndBodySchema }), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const { sessionId, reason } = getValidated<{ body: typeof sessionEndBodySchema }>(req).body;

  if (sessionId) {
    const [session] = await db.select().from(userSessionsTable)
      .where(and(eq(userSessionsTable.id, sessionId), eq(userSessionsTable.userId, userId)));
    if (session && session.isActive) {
      const now = new Date();
      const totalSec = (session.activeDurationSeconds || 0) + (session.idleDurationSeconds || 0);
      await db.update(userSessionsTable).set({
        isActive: false, endedAt: now, endReason: reason, totalDurationSeconds: totalSec,
      }).where(eq(userSessionsTable.id, sessionId));

      await db.insert(userActivityEventsTable).values({ userId, sessionId, eventType: "session_ended", metadata: { reason } });
    }
  }

  await db.update(userPresenceTable).set({ status: "offline", sessionId: null, updatedAt: new Date() })
    .where(eq(userPresenceTable.userId, userId));

  res.json({ ok: true });
});

const presenceQuerySchema = z.object({
  userId: z.coerce.number().int().positive().optional(),
});
type PresenceSchemas = { query: typeof presenceQuerySchema };

router.get("/activity/presence", requireAuth, requireRole(...ADMIN_ROLES), validate({ query: presenceQuerySchema }), async (req, res): Promise<void> => {
  const { userId: targetUserId } = getValidated<PresenceSchemas>(req).query;
  // User Activity scope is internal team only — exclude agent/sub_agent/agent_staff (Job H).
  const presenceConditions = [ne(userPresenceTable.status, "offline"), inArray(usersTable.role, STAFF_ROLES)];
  if (targetUserId) presenceConditions.push(eq(userPresenceTable.userId, targetUserId));
  const presences = await db.select({
    userId: userPresenceTable.userId,
    status: userPresenceTable.status,
    lastActiveAt: userPresenceTable.lastActiveAt,
    currentRoute: userPresenceTable.currentRoute,
    sessionId: userPresenceTable.sessionId,
    updatedAt: userPresenceTable.updatedAt,
    firstName: usersTable.firstName,
    lastName: usersTable.lastName,
    email: usersTable.email,
    role: usersTable.role,
    avatarUrl: usersTable.avatarUrl,
  })
  .from(userPresenceTable)
  .innerJoin(usersTable, eq(userPresenceTable.userId, usersTable.id))
  .where(and(...presenceConditions))
  .orderBy(desc(userPresenceTable.lastActiveAt));

  res.json({ data: presences });
});

const analyticsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  userId: z.coerce.number().int().positive().optional(),
});
type AnalyticsSchemas = { query: typeof analyticsQuerySchema };

router.get("/activity/analytics", requireAuth, requireRole(...ADMIN_ROLES), validate({ query: analyticsQuerySchema }), async (req, res): Promise<void> => {
  const { from, to, userId: targetUserId } = getValidated<AnalyticsSchemas>(req).query;

  const dateFrom = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
  const dateTo = to ? new Date(to) : new Date();
  if (!isValidActivityReportRange(dateFrom, dateTo)) {
    res.status(400).json({ error: "Invalid activity date range" });
    return;
  }

  const conditions: any[] = [
    lte(userSessionsTable.startedAt, dateTo),
    sql`coalesce(${userSessionsTable.endedAt}, ${userSessionsTable.lastSeenAt}) >= ${dateFrom}`,
    // Internal team only — exclude agent roles (Job H).
    inArray(usersTable.role, STAFF_ROLES),
  ];
  if (targetUserId) conditions.push(eq(userSessionsTable.userId, targetUserId));

  const sessionRows = await db.select({
    id: userSessionsTable.id,
    userId: userSessionsTable.userId,
    startedAt: userSessionsTable.startedAt,
    endedAt: userSessionsTable.endedAt,
    lastSeenAt: userSessionsTable.lastSeenAt,
    totalDurationSeconds: userSessionsTable.totalDurationSeconds,
    activeDurationSeconds: userSessionsTable.activeDurationSeconds,
    idleDurationSeconds: userSessionsTable.idleDurationSeconds,
    firstName: usersTable.firstName,
    lastName: usersTable.lastName,
    email: usersTable.email,
    role: usersTable.role,
  })
  .from(userSessionsTable)
  .innerJoin(usersTable, eq(userSessionsTable.userId, usersTable.id))
  .where(and(...conditions));

  const presences = await db.select().from(userPresenceTable);
  const presenceMap: Record<number, string> = {};
  for (const p of presences) presenceMap[p.userId] = p.status;

  type UserAggregate = {
    userId: number;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    role: string;
    totalDuration: number;
    activeDuration: number;
    idleDuration: number;
    sessionCount: number;
    firstLogin: Date;
    lastSeen: Date;
  };
  const byUser = new Map<number, UserAggregate>();
  for (const row of sessionRows) {
    const normalized = normalizeActivitySession(row, dateFrom, dateTo);
    if (normalized.overlapDurationSeconds <= 0) continue;
    const existing = byUser.get(row.userId);
    if (existing) {
      existing.totalDuration += normalized.totalDurationSeconds;
      existing.activeDuration += normalized.activeDurationSeconds;
      existing.idleDuration += normalized.idleDurationSeconds;
      existing.sessionCount += 1;
      if (row.startedAt < existing.firstLogin) existing.firstLogin = row.startedAt;
      if (row.lastSeenAt > existing.lastSeen) existing.lastSeen = row.lastSeenAt;
    } else {
      byUser.set(row.userId, {
        userId: row.userId,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        role: row.role,
        totalDuration: normalized.totalDurationSeconds,
        activeDuration: normalized.activeDurationSeconds,
        idleDuration: normalized.idleDurationSeconds,
        sessionCount: 1,
        firstLogin: row.startedAt,
        lastSeen: row.lastSeenAt,
      });
    }
  }

  const periodSeconds = Math.max(0, Math.floor((dateTo.getTime() - dateFrom.getTime()) / 1000));
  const data = Array.from(byUser.values()).map((row) => {
    // Multiple historical sessions may overlap. One person cannot contribute
    // more time than the selected wall-clock period.
    const totalDuration = Math.min(row.totalDuration, periodSeconds);
    const activeDuration = Math.min(row.activeDuration, totalDuration);
    return {
      ...row,
      totalDuration,
      activeDuration,
      idleDuration: Math.min(row.idleDuration, Math.max(0, totalDuration - activeDuration)),
      status: presenceMap[row.userId] || "offline",
    };
  });

  const totals = {
    totalDuration: data.reduce((sum, d) => sum + d.totalDuration, 0),
    activeDuration: data.reduce((sum, d) => sum + d.activeDuration, 0),
    idleDuration: data.reduce((sum, d) => sum + d.idleDuration, 0),
    totalSessions: data.reduce((sum, d) => sum + d.sessionCount, 0),
    uniqueUsers: data.length,
    onlineUsers: data.filter(d => d.status !== "offline").length,
    activeUsers: data.filter(d => d.status === "active").length,
    idleUsers: data.filter(d => d.status === "idle").length,
  };

  res.json({ data, totals });
});

const activityUserQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
type ActivityUserSchemas = { query: typeof activityUserQuerySchema };

router.get("/activity/user/:userId", requireAuth, requireRole(...ADMIN_ROLES), validate({ query: activityUserQuerySchema }), async (req, res): Promise<void> => {
  const targetUserId = parseInt(String(req.params.userId), 10);
  if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }
  const { from, to } = getValidated<ActivityUserSchemas>(req).query;

  // Internal team only — reject agent-role targets (Job H).
  const [targetRoleRow] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, targetUserId));
  if (!targetRoleRow || !STAFF_ROLES.includes(targetRoleRow.role)) { res.status(404).json({ error: "User not found" }); return; }

  const dateFrom = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
  const dateTo = to ? new Date(to) : new Date();
  if (!isValidActivityReportRange(dateFrom, dateTo)) {
    res.status(400).json({ error: "Invalid activity date range" });
    return;
  }

  const sessions = await db.select().from(userSessionsTable)
    .where(and(
      eq(userSessionsTable.userId, targetUserId),
      lte(userSessionsTable.startedAt, dateTo),
      sql`coalesce(${userSessionsTable.endedAt}, ${userSessionsTable.lastSeenAt}) >= ${dateFrom}`,
    ))
    .orderBy(desc(userSessionsTable.startedAt))
    .limit(500);

  const pageVisits = await db.select().from(userPageVisitsTable)
    .where(and(eq(userPageVisitsTable.userId, targetUserId), gte(userPageVisitsTable.enteredAt, dateFrom), lte(userPageVisitsTable.enteredAt, dateTo)))
    .orderBy(desc(userPageVisitsTable.enteredAt))
    .limit(200);

  const moduleBreakdown = await db.select({
    moduleName: userPageVisitsTable.moduleName,
    visitCount: sql<number>`count(*)`,
    totalDuration: sql<number>`sum(${userPageVisitsTable.totalDurationSeconds})`,
    activeDuration: sql<number>`sum(${userPageVisitsTable.activeDurationSeconds})`,
    idleDuration: sql<number>`sum(${userPageVisitsTable.idleDurationSeconds})`,
  })
  .from(userPageVisitsTable)
  .where(and(eq(userPageVisitsTable.userId, targetUserId), gte(userPageVisitsTable.enteredAt, dateFrom), lte(userPageVisitsTable.enteredAt, dateTo)))
  .groupBy(userPageVisitsTable.moduleName)
  .orderBy(sql`sum(${userPageVisitsTable.activeDurationSeconds}) desc`);

  const events = await db.select().from(userActivityEventsTable)
    .where(and(eq(userActivityEventsTable.userId, targetUserId), gte(userActivityEventsTable.createdAt, dateFrom), lte(userActivityEventsTable.createdAt, dateTo)))
    .orderBy(desc(userActivityEventsTable.createdAt))
    .limit(200);

  const [presence] = await db.select().from(userPresenceTable).where(eq(userPresenceTable.userId, targetUserId));
  const [user] = await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email, role: usersTable.role })
    .from(usersTable).where(eq(usersTable.id, targetUserId));

  const normalizedSessions = sessions.map((session) => {
    const normalized = normalizeActivitySession(session, dateFrom, dateTo);
    return {
      ...session,
      totalDurationSeconds: normalized.totalDurationSeconds,
      activeDurationSeconds: normalized.activeDurationSeconds,
      idleDurationSeconds: normalized.idleDurationSeconds,
    };
  });
  const dailyMap = new Map<string, { day: string; totalDuration: number; activeDuration: number; sessionCount: number }>();
  for (const session of normalizedSessions) {
    if (session.totalDurationSeconds <= 0) continue;
    const clippedStart = new Date(Math.max(session.startedAt.getTime(), dateFrom.getTime()));
    const day = clippedStart.toISOString().slice(0, 10);
    const existing = dailyMap.get(day) ?? { day, totalDuration: 0, activeDuration: 0, sessionCount: 0 };
    existing.totalDuration += session.totalDurationSeconds;
    existing.activeDuration += session.activeDurationSeconds;
    existing.sessionCount += 1;
    dailyMap.set(day, existing);
  }
  const dailyBreakdown = Array.from(dailyMap.values()).sort((a, b) => a.day.localeCompare(b.day));

  res.json({
    user,
    presence: presence || { status: "offline" },
    sessions: normalizedSessions,
    pageVisits,
    moduleBreakdown: normalizeModuleBreakdown(moduleBreakdown.map(m => ({ ...m, visitCount: Number(m.visitCount), totalDuration: Number(m.totalDuration), activeDuration: Number(m.activeDuration), idleDuration: Number(m.idleDuration) }))),
    events,
    dailyBreakdown,
  });
});

const modulesQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  userId: z.coerce.number().int().positive().optional(),
});
type ModulesSchemas = { query: typeof modulesQuerySchema };

router.get("/activity/modules", requireAuth, requireRole(...ADMIN_ROLES), validate({ query: modulesQuerySchema }), async (req, res): Promise<void> => {
  const { from, to, userId: targetUserId } = getValidated<ModulesSchemas>(req).query;
  const dateFrom = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
  const dateTo = to ? new Date(to) : new Date();
  if (!isValidActivityReportRange(dateFrom, dateTo)) {
    res.status(400).json({ error: "Invalid activity date range" });
    return;
  }

  // Internal team only — exclude agent roles (Job H).
  const moduleConditions = [gte(userPageVisitsTable.enteredAt, dateFrom), lte(userPageVisitsTable.enteredAt, dateTo), inArray(usersTable.role, STAFF_ROLES)];
  if (targetUserId) moduleConditions.push(eq(userPageVisitsTable.userId, targetUserId));

  const modules = await db.select({
    moduleName: userPageVisitsTable.moduleName,
    visitCount: sql<number>`count(*)`,
    uniqueUsers: sql<number>`count(distinct ${userPageVisitsTable.userId})`,
    totalDuration: sql<number>`sum(${userPageVisitsTable.totalDurationSeconds})`,
    activeDuration: sql<number>`sum(${userPageVisitsTable.activeDurationSeconds})`,
    avgDuration: sql<number>`avg(${userPageVisitsTable.totalDurationSeconds})`,
  })
  .from(userPageVisitsTable)
  .innerJoin(usersTable, eq(userPageVisitsTable.userId, usersTable.id))
  .where(and(...moduleConditions))
  .groupBy(userPageVisitsTable.moduleName)
  .orderBy(sql`count(*) desc`);

  const rawModules = modules.map(m => ({
    moduleName: m.moduleName,
    visitCount: Number(m.visitCount),
    uniqueUsers: Number(m.uniqueUsers),
    totalDuration: Number(m.totalDuration),
    activeDuration: Number(m.activeDuration),
    avgDuration: Number(m.avgDuration),
    idleDuration: 0,
  }));
  res.json({ data: normalizeModuleBreakdown(rawModules).map(m => ({ ...m, avgDuration: m.avgDuration ?? 0 })) });
});

const pdfReportQuerySchema = z.object({
  userId: z.coerce.number().int().positive(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  locale: z.string().max(10).optional(),
});
type PdfReportSchemas = { query: typeof pdfReportQuerySchema };

router.get("/activity/report/pdf", requireAuth, requireRole(...ADMIN_ROLES), validate({ query: pdfReportQuerySchema }), async (req, res): Promise<void> => {
  const { userId: targetUserId, from, to, locale: localeParam } = getValidated<PdfReportSchemas>(req).query;
  const locale = resolveLocale(localeParam);

  const dateFrom = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
  const dateTo = to ? new Date(to) : new Date();
  if (!isValidActivityReportRange(dateFrom, dateTo)) {
    res.status(400).json({ error: "Invalid activity date range" });
    return;
  }

  const [user] = await db
    .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, targetUserId));

  // Internal team only — reject agent-role targets (Job H).
  if (!user || !STAFF_ROLES.includes(user.role)) { res.status(404).json({ error: "User not found" }); return; }

  const sessions = await db.select().from(userSessionsTable)
    .where(and(eq(userSessionsTable.userId, targetUserId), gte(userSessionsTable.startedAt, dateFrom), lte(userSessionsTable.startedAt, dateTo)))
    .orderBy(desc(userSessionsTable.startedAt))
    .limit(100);

  // Real total session count — the KPI must not cap at the 100-row list length (Job I).
  const [sessionCountRow] = await db.select({ value: count() }).from(userSessionsTable)
    .where(and(eq(userSessionsTable.userId, targetUserId), gte(userSessionsTable.startedAt, dateFrom), lte(userSessionsTable.startedAt, dateTo)));
  const totalSessionCount = Number(sessionCountRow?.value) || 0;

  const moduleBreakdown = await db.select({
    moduleName: userPageVisitsTable.moduleName,
    visitCount: sql<number>`count(*)`,
    totalDuration: sql<number>`sum(${userPageVisitsTable.totalDurationSeconds})`,
    activeDuration: sql<number>`sum(${userPageVisitsTable.activeDurationSeconds})`,
  })
  .from(userPageVisitsTable)
  .where(and(eq(userPageVisitsTable.userId, targetUserId), gte(userPageVisitsTable.enteredAt, dateFrom), lte(userPageVisitsTable.enteredAt, dateTo)))
  .groupBy(userPageVisitsTable.moduleName)
  .orderBy(sql`count(*) desc`);

  const dailyBreakdown = await db.select({
    day: sql<string>`date(${userSessionsTable.startedAt})`,
    activeDuration: sql<number>`sum(${userSessionsTable.activeDurationSeconds})`,
    sessionCount: sql<number>`count(*)`,
  })
  .from(userSessionsTable)
  .where(and(eq(userSessionsTable.userId, targetUserId), gte(userSessionsTable.startedAt, dateFrom), lte(userSessionsTable.startedAt, dateTo)))
  .groupBy(sql`date(${userSessionsTable.startedAt})`)
  .orderBy(sql`date(${userSessionsTable.startedAt})`);

  const cappedPdfSessions = sessions.map(s => capSessionWallClock(s));
  const totalActive = cappedPdfSessions.reduce((s, x) => s + (x.activeDurationSeconds || 0), 0);
  const totalIdle = cappedPdfSessions.reduce((s, x) => s + (x.idleDurationSeconds || 0), 0);
  const totalTotal = cappedPdfSessions.reduce((s, x) => s + (x.totalDurationSeconds || 0), 0);

  const fromLabel = dateFrom.toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" });
  const toLabel = dateTo.toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" });

  function fmtDur(s: number): string {
    if (!s || s < 0) return "—";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }
  function pesc(v: string): string {
    return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  const clampedIdle = Math.max(0, Math.min(totalIdle, totalTotal - totalActive));

  const brandSettings = await loadBrandedPdfSettings();
  const { logoUri, sealUri } = await resolveBrandedAssets(brandSettings);
  const primary = brandSettings.pdfPrimaryColor || "#2563eb";
  const accent = brandSettings.pdfAccentColor || "#0ea5e9";

  const dailyChartData = dailyBreakdown.map(d => ({
    day: String(d.day || ""),
    activeDuration: Number(d.activeDuration) || 0,
  }));

  const barChart = dailyChartData.length > 1
    ? buildDailyBarChartSvg(dailyChartData, primary, accent)
    : "";

  const normalizedMods = normalizeModuleBreakdown(moduleBreakdown.map(m => ({ ...m, visitCount: Number(m.visitCount), totalDuration: Number(m.totalDuration), activeDuration: Number(m.activeDuration), idleDuration: Number((m as any).idleDuration) || 0 })));
  const maxModVisits = Math.max(...normalizedMods.map(m => Number(m.visitCount) || 0), 1);
  const moduleRows = normalizedMods.map((m, idx) => {
    const vis = Number(m.visitCount) || 0;
    const dur = Number(m.totalDuration) || Number(m.activeDuration) || 0;
    const pct = Math.round((vis / maxModVisits) * 100);
    const bg = idx % 2 === 0 ? "#fff" : "#f8fafc";
    return `<tr style="background:${bg}">
      <td style="padding:5px 8px;font-size:9.5px;width:40%">${pesc(m.moduleName || "")}</td>
      <td style="padding:5px 8px;font-size:9.5px;text-align:center;width:10%">${vis}</td>
      <td style="padding:5px 8px;font-size:9.5px;width:15%">${fmtDur(dur)}</td>
      <td style="padding:5px 8px;width:35%">
        <div style="height:6px;background:${pesc(accent)}33;border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${pesc(primary)};border-radius:3px"></div>
        </div>
      </td>
    </tr>`;
  }).join("");

  const sessionRows = sessions.slice(0, 50).map((s, idx) => {
    const start = s.startedAt ? new Date(s.startedAt).toLocaleString(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
    const end = s.endedAt ? new Date(s.endedAt).toLocaleString(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
    const reason = s.endReason ? pesc(s.endReason.replace(/_/g, " ")) : "—";
    const bg = idx % 2 === 0 ? "#fff" : "#f8fafc";
    return `<tr style="background:${bg}">
      <td style="padding:4px 8px;font-size:9px">${start}</td>
      <td style="padding:4px 8px;font-size:9px">${end}</td>
      <td style="padding:4px 8px;font-size:9px;font-family:monospace">${fmtDur(s.totalDurationSeconds || 0)}</td>
      <td style="padding:4px 8px;font-size:9px;font-family:monospace;color:#16a34a">${fmtDur(s.activeDurationSeconds || 0)}</td>
      <td style="padding:4px 8px;font-size:9px;color:#64748b">${reason}</td>
    </tr>`;
  }).join("");

  const body = `
<p style="font-size:9px;color:#64748b;margin:-10px 0 16px">${pesc(user.email || "")} &middot; ${pesc(user.role || "")} &middot; ${fromLabel} &ndash; ${toLabel}</p>

<div style="display:flex;gap:10px;margin-bottom:16px">
  <div style="border:1px solid #e2e8f0;border-radius:7px;padding:9px 13px;flex:1;border-top:3px solid ${pesc(primary)};background:#f8fafc">
    <div style="font-size:8px;color:#64748b;text-transform:uppercase;letter-spacing:.06em">Sessions</div>
    <div style="font-size:16px;font-weight:700;color:#0f172a;margin-top:1px">${totalSessionCount}</div>
  </div>
  <div style="border:1px solid #e2e8f0;border-radius:7px;padding:9px 13px;flex:1;border-top:3px solid ${pesc(primary)};background:#f8fafc">
    <div style="font-size:8px;color:#64748b;text-transform:uppercase;letter-spacing:.06em">Total Time</div>
    <div style="font-size:16px;font-weight:700;color:#0f172a;margin-top:1px">${fmtDur(totalTotal)}</div>
  </div>
  <div style="border:1px solid #e2e8f0;border-radius:7px;padding:9px 13px;flex:1;border-top:3px solid #16a34a;background:#f8fafc">
    <div style="font-size:8px;color:#64748b;text-transform:uppercase;letter-spacing:.06em">Active Time</div>
    <div style="font-size:16px;font-weight:700;color:#16a34a;margin-top:1px">${fmtDur(totalActive)}</div>
  </div>
  <div style="border:1px solid #e2e8f0;border-radius:7px;padding:9px 13px;flex:1;border-top:3px solid #d97706;background:#f8fafc">
    <div style="font-size:8px;color:#64748b;text-transform:uppercase;letter-spacing:.06em">Idle Time</div>
    <div style="font-size:16px;font-weight:700;color:#d97706;margin-top:1px">${fmtDur(clampedIdle)}</div>
  </div>
</div>

${barChart ? `
<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#64748b;margin-bottom:6px;padding-bottom:3px;border-bottom:2px solid ${pesc(primary)}22">Daily Active Time</div>
<div style="margin-bottom:16px">${barChart}</div>` : ""}

${moduleBreakdown.length > 0 ? `
<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#64748b;margin-bottom:6px;padding-bottom:3px;border-bottom:2px solid ${pesc(primary)}22">Module Breakdown</div>
<table style="width:100%;border-collapse:collapse;margin-bottom:16px">
  <thead><tr style="background:${pesc(primary)}">
    <th style="color:#fff;text-align:left;padding:5px 8px;font-size:8.5px;text-transform:uppercase">Module</th>
    <th style="color:#fff;text-align:center;padding:5px 8px;font-size:8.5px;text-transform:uppercase">Visits</th>
    <th style="color:#fff;text-align:left;padding:5px 8px;font-size:8.5px;text-transform:uppercase">Duration</th>
    <th style="color:#fff;text-align:left;padding:5px 8px;font-size:8.5px;text-transform:uppercase">Share</th>
  </tr></thead>
  <tbody>${moduleRows}</tbody>
</table>` : ""}

${sessions.length > 0 ? `
<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#64748b;margin-bottom:6px;padding-bottom:3px;border-bottom:2px solid ${pesc(primary)}22">Session History (last ${Math.min(sessions.length, 50)})</div>
<table style="width:100%;border-collapse:collapse;margin-bottom:8px">
  <thead><tr style="background:${pesc(primary)}">
    <th style="color:#fff;text-align:left;padding:5px 8px;font-size:8.5px;text-transform:uppercase">Started</th>
    <th style="color:#fff;text-align:left;padding:5px 8px;font-size:8.5px;text-transform:uppercase">Ended</th>
    <th style="color:#fff;text-align:left;padding:5px 8px;font-size:8.5px;text-transform:uppercase">Total</th>
    <th style="color:#fff;text-align:left;padding:5px 8px;font-size:8.5px;text-transform:uppercase">Active</th>
    <th style="color:#fff;text-align:left;padding:5px 8px;font-size:8.5px;text-transform:uppercase">End Reason</th>
  </tr></thead>
  <tbody>${sessionRows}</tbody>
</table>` : ""}
`;

  const html = buildBrandedHtml({
    title: `${(user.firstName || "")} ${(user.lastName || "")}`.trim() || "Activity Report",
    subtitle: `Activity Report — ${fromLabel} – ${toLabel}`,
    body,
    settings: brandSettings,
    logoBuri: logoUri,
    sealUri,
    locale,
  });
  const footerTemplate = buildBrandedFooterTemplate(brandSettings, locale);

  const LAUNCH_ARGS = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas", "--no-first-run", "--no-zygote",
    "--disable-gpu", "--single-process",
  ];

  try {
    const pdfBuffer = await withRenderLock(async () => {
      const { chromium } = await import("playwright-core");
      const executablePath = resolveChromium();
      const browser = await chromium.launch({ executablePath, args: LAUNCH_ARGS });
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(30000);
        await page.route("**/*", (route: any) => {
          const url = route.request().url();
          if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) {
            return route.continue();
          }
          return route.abort();
        });
        await page.setContent(html, { waitUntil: "domcontentloaded" });
        return await page.pdf({
          format: "A4",
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: "<span></span>",
          footerTemplate,
          margin: { top: "18mm", right: "16mm", bottom: "22mm", left: "16mm" },
        });
      } finally {
        await browser.close();
      }
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="activity-${targetUserId}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err: any) {
    console.error("[ActivityPDF] Failed to generate PDF:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to generate PDF" });
    }
  }
});

export default router;
