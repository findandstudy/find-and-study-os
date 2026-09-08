import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveModuleName,
  normalizeStoredModuleName,
  normalizeModuleBreakdown,
  clampSessionMetrics,
  normalizeActivitySession,
  MAX_HEARTBEAT_DELTA_SECONDS,
  MAX_ACTIVITY_REPORT_RANGE_MS,
  isValidActivityReportRange,
} from "../src/lib/activityNormalize";

test("deriveModuleName: known routes resolve to labels", () => {
  assert.equal(deriveModuleName("/staff/leads"), "Leads");
  assert.equal(deriveModuleName("/staff/leads/123"), "Leads");
  assert.equal(deriveModuleName("/admin/staff-cards"), "Staff Cards");
  assert.equal(deriveModuleName("/agent/commissions"), "Commissions");
  assert.equal(deriveModuleName("/student/applications"), "Applications");
});

test("deriveModuleName: nested known sub-routes use prefix match", () => {
  assert.equal(deriveModuleName("/staff/leads/detail"), "Leads");
  assert.equal(deriveModuleName("/admin/settings/notifications"), "Settings");
  assert.equal(deriveModuleName("/agent/leads/new"), "Leads");
  assert.equal(deriveModuleName("/student/applications/view"), "Applications");
});

test("deriveModuleName: UUID/numeric tails stripped before match", () => {
  assert.equal(deriveModuleName("/staff/students/42"), "Students");
  assert.equal(deriveModuleName("/admin/users/550e8400-e29b-41d4-a716-446655440000"), "Users");
});

test("deriveModuleName: unknown routes → Other", () => {
  assert.equal(deriveModuleName("/en"), "Other");
  assert.equal(deriveModuleName("/login"), "Other");
  assert.equal(deriveModuleName("/tr"), "Other");
  assert.equal(deriveModuleName("/staff/foo-experiment"), "Other");
  assert.equal(deriveModuleName("/abc123def"), "Other");
  assert.equal(deriveModuleName(""), "Other");
});

test("normalizeStoredModuleName: clean labels are preserved", () => {
  assert.equal(normalizeStoredModuleName("Leads"), "Leads");
  assert.equal(normalizeStoredModuleName("Applications"), "Applications");
  assert.equal(normalizeStoredModuleName("Course Finder"), "Course Finder");
  assert.equal(normalizeStoredModuleName("Staff Cards"), "Staff Cards");
});

test("normalizeStoredModuleName: dirty historical values → Other", () => {
  assert.equal(normalizeStoredModuleName("Login"), "Other");
  assert.equal(normalizeStoredModuleName("login"), "Other");
  assert.equal(normalizeStoredModuleName("En"), "Other");
  assert.equal(normalizeStoredModuleName("tr"), "Other");
  assert.equal(normalizeStoredModuleName("Unknown"), "Other");
  assert.equal(normalizeStoredModuleName("unknown"), "Other");
  assert.equal(normalizeStoredModuleName(null), "Other");
  assert.equal(normalizeStoredModuleName(""), "Other");
  assert.equal(normalizeStoredModuleName("id"), "Other");
});

test("normalizeStoredModuleName: token-like strings → Other", () => {
  assert.equal(normalizeStoredModuleName("abc123def"), "Other");
  assert.equal(normalizeStoredModuleName("tok4en89"), "Other");
});

test("normalizeStoredModuleName: pure numeric labels → Other", () => {
  assert.equal(normalizeStoredModuleName("123"), "Other");
  assert.equal(normalizeStoredModuleName("987654"), "Other");
  assert.equal(normalizeStoredModuleName("42"), "Other");
});

test("normalizeStoredModuleName: route paths delegate to deriveModuleName", () => {
  assert.equal(normalizeStoredModuleName("/staff/leads"), "Leads");
  assert.equal(normalizeStoredModuleName("/login"), "Other");
});

test("normalizeModuleBreakdown: route-like values properly derived", () => {
  const rows = [
    { moduleName: "/staff/leads", visitCount: 10, totalDuration: 100, activeDuration: 80, idleDuration: 20 },
    { moduleName: "/staff/leads/42", visitCount: 5, totalDuration: 50, activeDuration: 40, idleDuration: 10 },
    { moduleName: "Leads", visitCount: 3, totalDuration: 30, activeDuration: 20, idleDuration: 10 },
  ];
  const result = normalizeModuleBreakdown(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].moduleName, "Leads");
  assert.equal(result[0].visitCount, 18);
});

test("normalizeModuleBreakdown: dirty values collapsed to Other", () => {
  const rows = [
    { moduleName: "Login", visitCount: 5, totalDuration: 50, activeDuration: 40, idleDuration: 10 },
    { moduleName: "En", visitCount: 3, totalDuration: 30, activeDuration: 20, idleDuration: 10 },
    { moduleName: "Unknown", visitCount: 2, totalDuration: 20, activeDuration: 15, idleDuration: 5 },
    { moduleName: "Leads", visitCount: 8, totalDuration: 80, activeDuration: 60, idleDuration: 20 },
  ];
  const result = normalizeModuleBreakdown(rows);
  const leadsRow = result.find(r => r.moduleName === "Leads");
  const otherRow = result.find(r => r.moduleName === "Other");
  assert.ok(leadsRow, "Leads must be preserved");
  assert.ok(otherRow, "dirty values must be grouped under Other");
  assert.equal(leadsRow!.visitCount, 8);
  assert.equal(otherRow!.visitCount, 10);
});

test("clampSessionMetrics: idle clamped when total < active+idle", () => {
  const s = { activeDurationSeconds: 100, idleDurationSeconds: 80, totalDurationSeconds: 50 };
  const r = clampSessionMetrics(s);
  assert.equal(r.totalDurationSeconds, 180);
  assert.equal(r.idleDurationSeconds, 80);
});

test("clampSessionMetrics: idle clamped when idle > total - active", () => {
  const s = { activeDurationSeconds: 100, idleDurationSeconds: 200, totalDurationSeconds: 250 };
  const r = clampSessionMetrics(s);
  assert.equal(r.totalDurationSeconds, 300);
  assert.equal(r.idleDurationSeconds, 200);
});

test("clampSessionMetrics: consistent values pass through unchanged", () => {
  const s = { activeDurationSeconds: 60, idleDurationSeconds: 40, totalDurationSeconds: 100 };
  const r = clampSessionMetrics(s);
  assert.equal(r.totalDurationSeconds, 100);
  assert.equal(r.idleDurationSeconds, 40);
});

test("normalizeActivitySession: browser sleep cannot turn 53 seconds into 20 hours", () => {
  const start = new Date("2026-07-31T05:26:14.000Z");
  const end = new Date("2026-07-31T05:27:07.000Z");
  const result = normalizeActivitySession({
    startedAt: start,
    endedAt: end,
    lastSeenAt: end,
    activeDurationSeconds: 74_090,
    idleDurationSeconds: 0,
    totalDurationSeconds: 74_090,
  });

  assert.equal(result.totalDurationSeconds, 53);
  assert.equal(result.activeDurationSeconds, 53);
  assert.equal(result.idleDurationSeconds, 0);
});

test("normalizeActivitySession: inflated idle does not erase valid active time", () => {
  const start = new Date("2026-07-31T05:00:00.000Z");
  const end = new Date("2026-07-31T06:00:00.000Z");
  const result = normalizeActivitySession({
    startedAt: start,
    endedAt: end,
    lastSeenAt: end,
    activeDurationSeconds: 1_200,
    idleDurationSeconds: 50_000,
    totalDurationSeconds: 51_200,
  });

  assert.equal(result.totalDurationSeconds, 3_600);
  assert.equal(result.activeDurationSeconds, 1_200);
  assert.equal(result.idleDurationSeconds, 2_400);
});

test("normalizeActivitySession: partial date range is allocated without exceeding overlap", () => {
  const result = normalizeActivitySession({
    startedAt: new Date("2026-07-31T08:00:00.000Z"),
    endedAt: new Date("2026-07-31T10:00:00.000Z"),
    lastSeenAt: new Date("2026-07-31T10:00:00.000Z"),
    activeDurationSeconds: 3_600,
    idleDurationSeconds: 3_600,
    totalDurationSeconds: 7_200,
  }, new Date("2026-07-31T09:00:00.000Z"), new Date("2026-07-31T10:00:00.000Z"));

  assert.equal(result.overlapDurationSeconds, 3_600);
  assert.equal(result.totalDurationSeconds, 3_600);
  assert.equal(result.activeDurationSeconds, 1_800);
  assert.equal(result.idleDurationSeconds, 1_800);
});

test("heartbeat safety window stays close to the 30-second client interval", () => {
  assert.equal(MAX_HEARTBEAT_DELTA_SECONDS, 45);
});

test("activity reporting accepts bounded ranges and rejects invalid or unbounded scans", () => {
  const from = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(
    isValidActivityReportRange(from, new Date("2026-12-31T00:00:00.000Z")),
    true,
  );
  assert.equal(isValidActivityReportRange(from, from), false);
  assert.equal(
    isValidActivityReportRange(new Date("invalid"), new Date()),
    false,
  );
  assert.equal(
    isValidActivityReportRange(
      from,
      new Date(from.getTime() + MAX_ACTIVITY_REPORT_RANGE_MS + 1),
    ),
    false,
  );
});
