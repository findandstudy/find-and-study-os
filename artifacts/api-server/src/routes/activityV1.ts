import { Router, type IRouter } from "express";
import { db, entityViewEventsTable, userSessionsTable, agentsTable, usersTable } from "@workspace/db";
import { eq, and, gte, lte, isNull, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { validate, getValidated } from "../middlewares/validate";
import { requireAuth, requireRole, requireAgentStaffPermission } from "../lib/auth";
import { STAFF_ROLES, ADMIN_ROLES } from "../lib/roles";
import { getAgentVisibleIds } from "../lib/agentVisibility";
import {
  isValidActivityReportRange,
  normalizeActivitySession,
} from "../lib/activityNormalize";

const router: IRouter = Router();

const ENTITY_TYPES = ["lead", "student", "application", "message_thread"] as const;

const viewBodySchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.number().int().positive(),
});

const summaryQuerySchema = z.object({
  range: z.enum(["daily", "weekly", "monthly", "yearly"]).default("daily"),
  staffId: z.coerce.number().int().positive().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).refine((value) => Boolean(value.from) === Boolean(value.to), {
  message: "from and to must be provided together",
});

function getRangeBounds(range: "daily" | "weekly" | "monthly" | "yearly"): { from: Date; to: Date } {
  const now = new Date();
  const to = new Date(now);
  let from: Date;
  switch (range) {
    case "daily":
      from = new Date(now);
      from.setHours(0, 0, 0, 0);
      break;
    case "weekly":
      from = new Date(now);
      from.setDate(now.getDate() - 6);
      from.setHours(0, 0, 0, 0);
      break;
    case "monthly":
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "yearly":
      from = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      from = new Date(now);
      from.setHours(0, 0, 0, 0);
  }
  return { from, to };
}

router.post(
  "/v1/activity/view",
  requireAuth,
  validate({ body: viewBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { entityType, entityId } = getValidated<{ body: typeof viewBodySchema }>(req).body;

    const dedupCutoff = new Date(Date.now() - 5 * 60 * 1000);
    const [existing] = await db
      .select({ id: entityViewEventsTable.id })
      .from(entityViewEventsTable)
      .where(
        and(
          eq(entityViewEventsTable.userId, user.id),
          eq(entityViewEventsTable.entityType, entityType),
          eq(entityViewEventsTable.entityId, entityId),
          isNull(entityViewEventsTable.deletedAt),
          gte(entityViewEventsTable.viewedAt, dedupCutoff),
        )
      )
      .limit(1);

    if (existing) {
      res.json({ ok: true, deduplicated: true });
      return;
    }

    let agentId: number | null = null;
    if (user.role === "agent" || user.role === "sub_agent" || user.role === "agent_staff") {
      const [agentRow] = await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(eq(agentsTable.userId, user.id))
        .limit(1);
      agentId = agentRow?.id ?? null;
    }

    await db.insert(entityViewEventsTable).values({
      userId: user.id,
      entityType,
      entityId,
      viewedAt: new Date(),
      agentId,
    });

    res.status(201).json({ ok: true, deduplicated: false });
  }
);

router.get(
  "/v1/activity/summary",
  requireAuth,
  requireRole(...STAFF_ROLES, "agent_staff"),
  requireAgentStaffPermission("leads"),
  validate({ query: summaryQuerySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const {
      range,
      staffId: rawStaffId,
      from: rawFrom,
      to: rawTo,
    } = getValidated<{ query: typeof summaryQuerySchema }>(req).query;
    const fallbackBounds = getRangeBounds(range);
    const from = rawFrom ? new Date(rawFrom) : fallbackBounds.from;
    const to = rawTo ? new Date(rawTo) : fallbackBounds.to;
    if (!isValidActivityReportRange(from, to)) {
      res
        .status(400)
        .json({ error: "activity range must be valid and at most 366 days" });
      return;
    }
    const periodSeconds = Math.max(0, (to.getTime() - from.getTime()) / 1000);
    const isAdmin = (ADMIN_ROLES as readonly string[]).includes(user.role);
    const isAgentStaff = user.role === "agent_staff";

    let targetUserIds: number[] | null = null;

    if (isAdmin) {
      targetUserIds = rawStaffId ? [rawStaffId] : null;
    } else if (isAgentStaff) {
      const agentIds = await getAgentVisibleIds(user.id, user.role);
      if (agentIds.length === 0) {
        res.json({
          range,
          leadsViewed: 0, studentsViewed: 0, applicationsViewed: 0, messagesViewed: 0,
          activeDurationSeconds: 0, idleDurationSeconds: 0, totalDurationSeconds: 0,
        });
        return;
      }
      const rows = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(inArray(usersTable.id, agentIds));
      targetUserIds = rows.map(r => r.id);
    } else {
      targetUserIds = [user.id];
    }

    const viewBaseConditions = [
      isNull(entityViewEventsTable.deletedAt),
      gte(entityViewEventsTable.viewedAt, from),
      sql`${entityViewEventsTable.viewedAt} <= ${to.toISOString()}`,
    ];
    if (targetUserIds !== null) {
      viewBaseConditions.push(inArray(entityViewEventsTable.userId, targetUserIds));
    }

    const viewCounts = await db
      .select({
        entityType: entityViewEventsTable.entityType,
        count: sql<number>`count(*)`,
      })
      .from(entityViewEventsTable)
      .where(and(...viewBaseConditions))
      .groupBy(entityViewEventsTable.entityType);

    const counts: Record<string, number> = {};
    for (const r of viewCounts) {
      counts[r.entityType as string] = Number(r.count);
    }

    const sessionBaseConditions = [
      lte(userSessionsTable.startedAt, to),
      sql`coalesce(${userSessionsTable.endedAt}, ${userSessionsTable.lastSeenAt}) >= ${from}`,
      inArray(usersTable.role, STAFF_ROLES),
    ];
    if (targetUserIds !== null) {
      sessionBaseConditions.push(inArray(userSessionsTable.userId, targetUserIds));
    }

    const sessionRows = await db
      .select({
        userId: userSessionsTable.userId,
        startedAt: userSessionsTable.startedAt,
        endedAt: userSessionsTable.endedAt,
        lastSeenAt: userSessionsTable.lastSeenAt,
        activeDurationSeconds: userSessionsTable.activeDurationSeconds,
        idleDurationSeconds: userSessionsTable.idleDurationSeconds,
        totalDurationSeconds: userSessionsTable.totalDurationSeconds,
      })
      .from(userSessionsTable)
      .innerJoin(usersTable, eq(userSessionsTable.userId, usersTable.id))
      .where(and(...sessionBaseConditions));

    const byUser = new Map<number, { active: number; idle: number; total: number }>();
    for (const session of sessionRows) {
      const normalized = normalizeActivitySession(session, from, to);
      const aggregate = byUser.get(session.userId) ?? { active: 0, idle: 0, total: 0 };
      aggregate.active += normalized.activeDurationSeconds;
      aggregate.idle += normalized.idleDurationSeconds;
      aggregate.total += normalized.totalDurationSeconds;
      byUser.set(session.userId, aggregate);
    }

    let totalSeconds = 0;
    let activeSeconds = 0;
    let idleSeconds = 0;
    for (const aggregate of byUser.values()) {
      const userTotal = Math.min(aggregate.total, periodSeconds);
      const userActive = Math.min(aggregate.active, userTotal);
      const userIdle = Math.min(aggregate.idle, Math.max(0, userTotal - userActive));
      totalSeconds += userTotal;
      activeSeconds += userActive;
      idleSeconds += userIdle;
    }

    res.json({
      range,
      leadsViewed: counts["lead"] ?? 0,
      studentsViewed: counts["student"] ?? 0,
      applicationsViewed: counts["application"] ?? 0,
      messagesViewed: counts["message_thread"] ?? 0,
      activeDurationSeconds: activeSeconds,
      idleDurationSeconds: idleSeconds,
      totalDurationSeconds: totalSeconds,
    });
  }
);

export default router;
