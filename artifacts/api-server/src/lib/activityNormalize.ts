export const ROUTE_MODULE_MAP: Record<string, string> = {
  "/admin": "Dashboard", "/staff": "Dashboard", "/student": "Dashboard", "/agent": "Dashboard",
  "/staff/leads": "Leads", "/staff/students": "Students", "/staff/applications": "Applications",
  "/staff/documents": "Documents", "/staff/course-finder": "Course Finder", "/staff/agents": "Agents",
  "/staff/finance": "Finance", "/staff/messages": "Messages", "/staff/settings": "Settings",
  "/staff/tasks": "Tasks",
  "/admin/users": "Users", "/admin/catalog": "Catalog", "/admin/audit": "Audit Log",
  "/admin/settings": "Settings", "/admin/activity": "Activity",
  "/admin/staff-cards": "Staff Cards", "/admin/campaigns": "Campaigns",
  "/admin/commissions": "Commissions", "/admin/finance": "Finance",
  "/admin/reports": "Reports",
  "/student/applications": "Applications", "/student/account": "Account",
  "/student/documents": "Documents", "/student/messages": "Messages",
  "/agent/referrals": "Referrals", "/agent/commissions": "Commissions", "/agent/account": "Account",
  "/agent/leads": "Leads", "/agent/students": "Students", "/agent/finance": "Finance",
  "/agent/messages": "Messages", "/agent/documents": "Documents",
};

export const EXCLUDE_SEGMENT_RE = /^(en|tr|ar|fr|ru|fa|zh|hi|es|id|ur|tk|ky|kk|uz|tg|login|register|verify|reset|confirm|auth|callback|public|embed|apply|sign|contract|token|oauth|sso|invite|accept|decline|redirect|error|404|500)$/i;
export const DIRTY_LABEL_RE = /^(login|register|verify|reset|confirm|auth|callback|public|embed|apply|sign|contract|unknown|en|tr|ar|fr|ru|fa|zh|hi|es|id|ur|tk|ky|kk|uz|tg|404|500|error|redirect|null|undefined)$/i;
const UUID_RE = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUM_TAIL_RE = /\/\d+$/;
const LONG_TOKEN_RE = /\/[A-Za-z0-9_-]{20,}$/;

const SORTED_ROUTE_ENTRIES = Object.entries(ROUTE_MODULE_MAP).sort((a, b) => b[0].length - a[0].length);

function tryRouteMatch(r: string): string | null {
  for (const [pattern, name] of SORTED_ROUTE_ENTRIES) {
    if (r === pattern) return name;
    const isRoot = pattern.split("/").filter(Boolean).length === 1;
    if (!isRoot && r.startsWith(pattern + "/")) return name;
  }
  return null;
}

export function deriveModuleName(route: string): string {
  let hit = tryRouteMatch(route);
  if (hit) return hit;

  const cleaned = route.replace(UUID_RE, "").replace(NUM_TAIL_RE, "").replace(LONG_TOKEN_RE, "");

  if (cleaned && cleaned !== route) {
    hit = tryRouteMatch(cleaned);
    if (hit) return hit;
  }

  const base = cleaned || route;
  const parts = base.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (
    !last ||
    last.length <= 2 ||
    last.length > 30 ||
    /^\d+$/.test(last) ||
    EXCLUDE_SEGMENT_RE.test(last) ||
    (/^[a-z0-9_-]{6,}$/i.test(last) && /\d/.test(last) && /[a-zA-Z]/.test(last))
  ) return "Other";
  return "Other";
}

export function normalizeStoredModuleName(name: string | null): string {
  if (!name) return "Other";
  if (name.startsWith("/")) return deriveModuleName(name);
  const trimmed = name.trim();
  if (!trimmed) return "Other";
  if (DIRTY_LABEL_RE.test(trimmed)) return "Other";
  if (trimmed.length <= 2) return "Other";
  if (/^\d+$/.test(trimmed)) return "Other";
  if (/^[a-z0-9_-]{6,}$/i.test(trimmed) && /\d/.test(trimmed) && /[a-zA-Z]/.test(trimmed)) return "Other";
  return trimmed;
}

export function normalizeModuleBreakdown<T extends { moduleName: string | null; visitCount?: number | null; totalDuration?: number | null; activeDuration?: number | null; idleDuration?: number | null }>(rows: T[]): T[] {
  const acc = new Map<string, { row: T; visitCount: number; totalDuration: number; activeDuration: number; idleDuration: number; uniqueUsers: number }>();
  for (const r of rows) {
    const name = normalizeStoredModuleName(r.moduleName);
    const vn = Number(r.visitCount) || 0;
    const td = Number(r.totalDuration) || 0;
    const ad = Number(r.activeDuration) || 0;
    const id_ = Number(r.idleDuration) || 0;
    const uu = Number((r as any).uniqueUsers) || 0;
    const existing = acc.get(name);
    if (existing) {
      existing.visitCount += vn;
      existing.totalDuration += td;
      existing.activeDuration += ad;
      existing.idleDuration += id_;
      existing.uniqueUsers = Math.max(existing.uniqueUsers, uu);
    } else {
      acc.set(name, { row: r, visitCount: vn, totalDuration: td, activeDuration: ad, idleDuration: id_, uniqueUsers: uu });
    }
  }
  return Array.from(acc.entries()).map(([name, v]) => ({
    ...v.row,
    moduleName: name,
    visitCount: v.visitCount,
    totalDuration: v.totalDuration,
    activeDuration: v.activeDuration,
    idleDuration: v.idleDuration,
    uniqueUsers: v.uniqueUsers,
    avgDuration: v.visitCount > 0 ? Math.round(v.totalDuration / v.visitCount) : 0,
  } as T)).sort((a, b) => (Number(b.visitCount) || 0) - (Number(a.visitCount) || 0));
}

export function clampSessionMetrics<T extends { activeDurationSeconds?: number | null; idleDurationSeconds?: number | null; totalDurationSeconds?: number | null }>(s: T): T {
  const active = s.activeDurationSeconds || 0;
  const idle = s.idleDurationSeconds || 0;
  const rawTotal = s.totalDurationSeconds || 0;
  const clampedTotal = Math.max(rawTotal, active + idle);
  const clampedIdle = Math.max(0, Math.min(idle, clampedTotal - active));
  return { ...s, totalDurationSeconds: clampedTotal, idleDurationSeconds: clampedIdle };
}

export const MAX_TRACKED_SESSION_SECONDS = 8 * 60 * 60;
export const MAX_HEARTBEAT_DELTA_SECONDS = 45;
export const MAX_ACTIVITY_REPORT_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export function isValidActivityReportRange(from: Date, to: Date): boolean {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return (
    Number.isFinite(fromMs) &&
    Number.isFinite(toMs) &&
    fromMs < toMs &&
    toMs - fromMs <= MAX_ACTIVITY_REPORT_RANGE_MS
  );
}

export type ActivitySessionLike = {
  startedAt: Date | string | null;
  endedAt?: Date | string | null;
  lastSeenAt: Date | string | null;
  activeDurationSeconds?: number | null;
  idleDurationSeconds?: number | null;
  totalDurationSeconds?: number | null;
};

export type NormalizedActivitySession = {
  activeDurationSeconds: number;
  idleDurationSeconds: number;
  totalDurationSeconds: number;
  overlapDurationSeconds: number;
};

function safeTimestamp(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Normalizes client-reported session counters against server-observed wall time.
 *
 * Historical clients could report a browser sleep interval (or the same shared
 * session from multiple tabs) as active/idle time. A 53-second session could
 * therefore contain many hours of counters. The wall clock is the hard upper
 * bound, and partial date-range overlap is allocated proportionally because old
 * rows do not contain per-heartbeat buckets.
 */
export function normalizeActivitySession(
  session: ActivitySessionLike,
  rangeFrom?: Date | string,
  rangeTo?: Date | string,
): NormalizedActivitySession {
  const startedAt = safeTimestamp(session.startedAt);
  const endedAt = safeTimestamp(session.endedAt) ?? safeTimestamp(session.lastSeenAt);
  if (startedAt === null || endedAt === null || endedAt <= startedAt) {
    return {
      activeDurationSeconds: 0,
      idleDurationSeconds: 0,
      totalDurationSeconds: 0,
      overlapDurationSeconds: 0,
    };
  }

  const wallClockSeconds = Math.max(
    0,
    Math.min(MAX_TRACKED_SESSION_SECONDS, Math.floor((endedAt - startedAt) / 1000)),
  );
  if (wallClockSeconds === 0) {
    return {
      activeDurationSeconds: 0,
      idleDurationSeconds: 0,
      totalDurationSeconds: 0,
      overlapDurationSeconds: 0,
    };
  }

  const rawActive = Math.max(0, Number(session.activeDurationSeconds) || 0);
  const rawIdle = Math.max(0, Number(session.idleDurationSeconds) || 0);
  const rawTotal = Math.max(0, Number(session.totalDurationSeconds) || 0, rawActive + rawIdle);
  const boundedTotal = Math.min(rawTotal, wallClockSeconds);

  // Preserve valid active seconds first; inflated idle time must not dilute a
  // legitimate active counter merely because an old client reported a sleep.
  const boundedActive = Math.min(rawActive, boundedTotal);

  const fromMs = safeTimestamp(rangeFrom) ?? startedAt;
  const toMs = safeTimestamp(rangeTo) ?? endedAt;
  const overlapStart = Math.max(startedAt, fromMs);
  const overlapEnd = Math.min(endedAt, toMs);
  const overlapDurationSeconds = Math.max(
    0,
    Math.min(wallClockSeconds, Math.floor((overlapEnd - overlapStart) / 1000)),
  );
  if (overlapDurationSeconds === 0) {
    return {
      activeDurationSeconds: 0,
      idleDurationSeconds: 0,
      totalDurationSeconds: 0,
      overlapDurationSeconds: 0,
    };
  }

  const overlapRatio = overlapDurationSeconds / wallClockSeconds;
  const totalDurationSeconds = Math.min(
    overlapDurationSeconds,
    Math.round(boundedTotal * overlapRatio),
  );
  const activeDurationSeconds = Math.min(
    totalDurationSeconds,
    Math.round(boundedActive * overlapRatio),
  );

  return {
    activeDurationSeconds,
    idleDurationSeconds: Math.max(0, totalDurationSeconds - activeDurationSeconds),
    totalDurationSeconds,
    overlapDurationSeconds,
  };
}
