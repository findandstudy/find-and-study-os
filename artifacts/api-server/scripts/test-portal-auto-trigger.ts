/**
 * test-portal-auto-trigger.ts — TAT1 / TAT2 / TAT3 / TAT4
 *
 * TAT1: maybeEnqueuePortalSubmission enqueues when all gates pass
 *       (isEnabled, stage in triggerStages, active portal_uni, credentials, no dedup)
 *       → portal_submissions row inserted with correct mode/universityKey
 *
 * TAT2: Trigger-stage filter — does NOT enqueue when newStage is NOT in triggerStages
 *
 * TAT3: Scope filter — 'selected' scope skips when universityKey ∉ selectedUniversityKeys
 *
 * TAT4: Dedup — does NOT enqueue when an active submission (queued) already exists
 *       for the same application × universityKey
 *
 * TAT5: Scheduled OFF (autoProcessEnabled=false) — immediate drain trigger fires
 *       right after a successful enqueue (with the configured triggerStages);
 *       does NOT fire again on a dedup skip
 *
 * TAT6: Scheduled ON (autoProcessEnabled=true) — no immediate drain on enqueue;
 *       scheduler tick: no drain before the interval elapses, drain after it
 *       elapses with last_auto_drain_at updated
 *
 * TAT7: Enabled OFF (isEnabled=false) — neither immediate drain nor scheduled
 *       drain (kill-switch)
 *
 * Run:
 *   pnpm --filter @workspace/api-server test:portal-auto-trigger
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  applicationsTable,
  studentsTable,
  portalAutomationSettingsTable,
  portalUniversitiesTable,
  portalSubmissionsTable,
  portalWorkerHeartbeatsTable,
  pipelineStagesTable,
  universitiesTable,
  portalAccountUniversitiesTable,
  usersTable,
} from "@workspace/db";
import {
  currentPortalRuntimeReleaseId,
  recordPortalWorkerHeartbeat,
} from "@workspace/portal-runner";
import {
  maybeEnqueuePortalSubmission,
  resolvePortalRouting,
  __setDrainTriggerForTests,
} from "../src/lib/portalAutoTrigger.js";
import { runPortalAutoDrainTick } from "../src/routes/portalAutomation.js";
import {
  assertDisposablePortalVerificationTarget,
  seedVerifiedPortalPartnerFixture,
} from "./portalVerificationFixture.js";

assertDisposablePortalVerificationTarget();

// ---------------------------------------------------------------------------
// Run-specific unique key
// ---------------------------------------------------------------------------

const RUN = `tat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

// Adapter key derived from RUN (uppercase = env-var prefix)
const ADAPTER_KEY  = `test_${RUN}`;
const UNI_KEY      = `uni_${RUN}`;
const UNI_NAME     = `TAT Test University ${RUN}`;
const TRIGGER_STAGE = `tat_stage_${RUN}`;
const WORKER_ID = `tat-worker-${RUN}`;

// Aggregator fixture identifiers (for TAT8-TAT11)
const AGG_ADAPTER_KEY  = `agg_adp_${RUN}`;
const AGG_UNI_KEY      = `agg_sit_${RUN}`;
const AGG_UNI_LABEL    = `TAT Aggregator Portal ${RUN}`;
const AGG_MEMBER_NAME  = `Istanbul Gelisim University ${RUN}`;

// ---------------------------------------------------------------------------
// Credential injection — set env vars so hasPortalCredentials() returns true
// ---------------------------------------------------------------------------
const ENV_PREFIX = ADAPTER_KEY.toUpperCase().replace(/-/g, "_");
process.env[`${ENV_PREFIX}_USER`]     = "tat-test-user";
process.env[`${ENV_PREFIX}_PASSWORD`] = "tat-test-pass";

const AGG_ENV_PREFIX = AGG_ADAPTER_KEY.toUpperCase().replace(/-/g, "_");
process.env[`${AGG_ENV_PREFIX}_USER`]     = "tat-agg-user";
process.env[`${AGG_ENV_PREFIX}_PASSWORD`] = "tat-agg-pass";

// ---------------------------------------------------------------------------
// Saved originals for settings restore
// ---------------------------------------------------------------------------
let savedSettings: { id: number; row: Record<string, unknown> } | null = null;

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------
const cleanupStudentIds:    number[] = [];
const cleanupAppIds:        number[] = [];
const cleanupSubIds:        number[] = [];
const cleanupPortalUniIds:  number[] = [];
const cleanupCatalogUniIds: number[] = [];
const cleanupMembershipIds: number[] = [];
const cleanupPipelineStageIds: number[] = [];
let   settingsRowId: number | null   = null;
let authUserId = 0;

// Shared aggregator fixture state (set in before(), read in TAT8-TAT11)
let aggPortalUniId:  number | null = null;
let aggCatalogUniId: number | null = null;

// ---------------------------------------------------------------------------
// before — create shared fixtures
// ---------------------------------------------------------------------------
before(async () => {
  const releaseId = currentPortalRuntimeReleaseId();
  assert.ok(releaseId, "portal auto-trigger fixture requires a release identity");
  await recordPortalWorkerHeartbeat({
    workerId: WORKER_ID,
    releaseId,
    executionModes: new Set(["dry"]),
  });

  const [authUser] = await db.insert(usersTable).values({
    email: `${RUN}.admin@example.com`,
    firstName: "Portal",
    lastName: "Trigger Admin",
    role: "super_admin",
    isActive: true,
    emailVerified: true,
  }).returning({ id: usersTable.id });
  authUserId = authUser.id;

  const [triggerStage] = await db.insert(pipelineStagesTable).values({
    entityType: "application",
    key: TRIGGER_STAGE,
    label: `TAT Trigger ${RUN}`,
    sortOrder: 90_000,
  }).returning({ id: pipelineStagesTable.id });
  cleanupPipelineStageIds.push(triggerStage.id);

  // Save existing settings row (if any)
  const [existing] = await db.select().from(portalAutomationSettingsTable).limit(1);
  if (existing) {
    savedSettings = { id: existing.id, row: existing as Record<string, unknown> };
  }

  // Upsert settings: enabled, triggerStage = TRIGGER_STAGE, mode=dry, scope=only_applied
  if (existing) {
    await db.update(portalAutomationSettingsTable)
      .set({
        isEnabled:              true,
        triggerStages:          [TRIGGER_STAGE],
        mode:                   "dry",
        scope:                  "only_applied",
        selectedUniversityKeys: [],
        autoProcessEnabled:     false,
        autoProcessIntervalMinutes: 20,
        lastAutoDrainAt:        null,
      })
      .where(eq(portalAutomationSettingsTable.id, existing.id));
    settingsRowId = existing.id;
  } else {
    const [ins] = await db.insert(portalAutomationSettingsTable).values({
      isEnabled:              true,
      triggerStages:          [TRIGGER_STAGE],
      mode:                   "dry",
      scope:                  "only_applied",
      selectedUniversityKeys: [],
      autoProcessEnabled:     false,
      autoProcessIntervalMinutes: 20,
    }).returning({ id: portalAutomationSettingsTable.id });
    settingsRowId = ins.id;
  }

  // Create portal_universities row for test university (standalone — TAT1-TAT7)
  const [pu] = await db.insert(portalUniversitiesTable).values({
    universityKey: UNI_KEY,
    universityName: UNI_NAME,
    adapterKey:    ADAPTER_KEY,
    isActive:      true,
  }).returning({ id: portalUniversitiesTable.id });
  cleanupPortalUniIds.push(pu.id);

  // --- Aggregator fixtures (TAT8–TAT11) ---
  // 1. Catalog university row (universities table)
  const [catUni] = await db.insert(universitiesTable).values({
    name:     AGG_MEMBER_NAME,
    country:  "Turkey",
  }).returning({ id: universitiesTable.id });
  aggCatalogUniId = catUni.id;
  cleanupCatalogUniIds.push(catUni.id);

  // 2. Aggregator portal_universities row (SIT-like)
  const [aggPu] = await db.insert(portalUniversitiesTable).values({
    universityKey: AGG_UNI_KEY,
    universityName: AGG_UNI_LABEL,
    adapterKey:    AGG_ADAPTER_KEY,
    isActive:      true,
  }).returning({ id: portalUniversitiesTable.id });
  aggPortalUniId = aggPu.id;
  cleanupPortalUniIds.push(aggPu.id);

  await seedVerifiedPortalPartnerFixture({
    portalUniversityId: pu.id,
    universityKey: UNI_KEY,
    universityName: UNI_NAME,
    adapterKey: ADAPTER_KEY,
  });
  await seedVerifiedPortalPartnerFixture({
    portalUniversityId: aggPu.id,
    universityKey: AGG_UNI_KEY,
    universityName: AGG_UNI_LABEL,
    adapterKey: AGG_ADAPTER_KEY,
  });

  // 3. Membership row linking catalog university → aggregator
  const [mem] = await db.insert(portalAccountUniversitiesTable).values({
    portalKey:          AGG_UNI_KEY,
    catalogUniversityId: catUni.id,
    enabled:            true,
  }).returning({ id: portalAccountUniversitiesTable.id });
  cleanupMembershipIds.push(mem.id);
});

// ---------------------------------------------------------------------------
// after — restore settings and clean test data
// ---------------------------------------------------------------------------
after(async () => {
  await db.delete(portalWorkerHeartbeatsTable)
    .where(eq(portalWorkerHeartbeatsTable.workerId, WORKER_ID))
    .catch(() => {});

  // Restore settings
  if (savedSettings && settingsRowId) {
    const {
      isEnabled, triggerStages, mode, scope, selectedUniversityKeys,
      autoProcessEnabled, autoProcessIntervalMinutes, lastAutoDrainAt,
    } = savedSettings.row as {
        isEnabled: boolean;
        triggerStages: string[];
        mode: "dry" | "real";
        scope: "only_applied" | "selected" | "all";
        selectedUniversityKeys: string[];
        autoProcessEnabled: boolean;
        autoProcessIntervalMinutes: number;
        lastAutoDrainAt: Date | null;
      };
    await db.update(portalAutomationSettingsTable)
      .set({
        isEnabled, triggerStages, mode, scope, selectedUniversityKeys,
        autoProcessEnabled, autoProcessIntervalMinutes, lastAutoDrainAt,
      })
      .where(eq(portalAutomationSettingsTable.id, settingsRowId))
      .catch(() => {});
  } else if (settingsRowId && !savedSettings) {
    // We inserted it — remove it
    await db.delete(portalAutomationSettingsTable)
      .where(eq(portalAutomationSettingsTable.id, settingsRowId))
      .catch(() => {});
  }

  // Clean submissions
  for (const id of cleanupSubIds) {
    await db.delete(portalSubmissionsTable).where(eq(portalSubmissionsTable.id, id)).catch(() => {});
  }
  // Clean portal_account_universities (memberships) — before portal_universities (FK)
  for (const id of cleanupMembershipIds) {
    await db.delete(portalAccountUniversitiesTable).where(eq(portalAccountUniversitiesTable.id, id)).catch(() => {});
  }
  // Clean portal_universities
  for (const id of cleanupPortalUniIds) {
    await db.delete(portalUniversitiesTable).where(eq(portalUniversitiesTable.id, id)).catch(() => {});
  }
  // Clean catalog universities — after memberships (cascade would handle it but be explicit)
  for (const id of cleanupCatalogUniIds) {
    await db.delete(universitiesTable).where(eq(universitiesTable.id, id)).catch(() => {});
  }
  // Clean apps + students
  for (const id of cleanupAppIds) {
    await db.delete(applicationsTable).where(eq(applicationsTable.id, id)).catch(() => {});
  }
  for (const id of cleanupStudentIds) {
    await db.delete(studentsTable).where(eq(studentsTable.id, id)).catch(() => {});
  }
  for (const id of cleanupPipelineStageIds) {
    await db.delete(pipelineStagesTable).where(eq(pipelineStagesTable.id, id)).catch(() => {});
  }
  if (authUserId > 0) {
    await db.delete(usersTable).where(eq(usersTable.id, authUserId)).catch(() => {});
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Seed helper
// ---------------------------------------------------------------------------
async function seedApp(): Promise<{ studentId: number; appId: number }> {
  const [student] = await db.insert(studentsTable).values({
    firstName: `TAT`,
    lastName:  `Test_${RUN}`,
    email:     `tat_${Date.now()}@test.local`,
  }).returning({ id: studentsTable.id });
  cleanupStudentIds.push(student.id);

  const [app] = await db.insert(applicationsTable).values({
    studentId:     student.id,
    universityName: UNI_NAME,
    stage:         "inquiry",
    season:        "2026",
  }).returning({ id: applicationsTable.id });
  cleanupAppIds.push(app.id);

  return { studentId: student.id, appId: app.id };
}

// Helper: find the auto-enqueued submission for a given app
async function findSub(appId: number): Promise<typeof portalSubmissionsTable.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(portalSubmissionsTable)
    .where(
      and(
        eq(portalSubmissionsTable.applicationId, appId),
        eq(portalSubmissionsTable.universityKey, UNI_KEY),
        isNull(portalSubmissionsTable.deletedAt),
      ),
    )
    .limit(1);
  if (row) cleanupSubIds.push(row.id);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// TAT1 — happy path: all gates pass → submission enqueued
// ---------------------------------------------------------------------------
test("TAT1: enqueues when isEnabled + stage in triggerStages + active uni + credentials + no dedup", async () => {
  const { studentId, appId } = await seedApp();

  await maybeEnqueuePortalSubmission({
    applicationId: appId,
    studentId,
    newStage:      TRIGGER_STAGE,
    universityName: UNI_NAME,
    universityId:  null,
    actorUserId:   authUserId,
  });

  const sub = await findSub(appId);
  assert.ok(sub !== null,            "submission was enqueued");
  assert.equal(sub!.status,          "queued",     "status=queued");
  assert.equal(sub!.mode,            "dry",         "mode=dry (from settings)");
  assert.equal(sub!.universityKey,   UNI_KEY,       "universityKey correct");
  assert.equal(sub!.universityName,  UNI_NAME,      "universityName correct");
  assert.equal(sub!.applicationId,   appId,         "applicationId correct");
  assert.equal(sub!.studentId,       studentId,     "studentId correct");
  assert.equal(sub!.enqueuedBy,      authUserId,    "enqueuedBy=actorUserId");
});

// ---------------------------------------------------------------------------
// TAT2 — trigger-stage filter: stage NOT in triggerStages → no enqueue
// ---------------------------------------------------------------------------
test("TAT2: does NOT enqueue when newStage is not in triggerStages", async () => {
  const { studentId, appId } = await seedApp();

  await maybeEnqueuePortalSubmission({
    applicationId: appId,
    studentId,
    newStage:      "some_other_stage",   // NOT in triggerStages
    universityName: UNI_NAME,
    universityId:  null,
    actorUserId:   authUserId,
  });

  const sub = await findSub(appId);
  assert.equal(sub, null, "no submission when stage not in triggerStages");
});

// ---------------------------------------------------------------------------
// TAT3 — scope='selected': universityKey NOT in selectedUniversityKeys → skip
// ---------------------------------------------------------------------------
test("TAT3: scope=selected skips when universityKey is not in selectedUniversityKeys", async () => {
  const { studentId, appId } = await seedApp();

  // Update settings to scope=selected with DIFFERENT key list
  await db.update(portalAutomationSettingsTable)
    .set({ scope: "selected", selectedUniversityKeys: ["some_other_uni_key"] })
    .where(eq(portalAutomationSettingsTable.id, settingsRowId!));

  try {
    await maybeEnqueuePortalSubmission({
      applicationId: appId,
      studentId,
      newStage:      TRIGGER_STAGE,
      universityName: UNI_NAME,
      universityId:  null,
      actorUserId:   authUserId,
    });

    const sub = await findSub(appId);
    assert.equal(sub, null, "no submission when universityKey not in selectedUniversityKeys");
  } finally {
    // Restore scope=only_applied
    await db.update(portalAutomationSettingsTable)
      .set({ scope: "only_applied", selectedUniversityKeys: [] })
      .where(eq(portalAutomationSettingsTable.id, settingsRowId!));
  }
});

// ---------------------------------------------------------------------------
// TAT4 — dedup: active submission exists → second call skips
// ---------------------------------------------------------------------------
test("TAT4: dedup — skips enqueue when an active submission already exists", async () => {
  const { studentId, appId } = await seedApp();

  // First call → enqueues
  await maybeEnqueuePortalSubmission({
    applicationId: appId,
    studentId,
    newStage:      TRIGGER_STAGE,
    universityName: UNI_NAME,
    universityId:  null,
    actorUserId:   authUserId,
  });
  const first = await findSub(appId);
  assert.ok(first !== null, "first submission created");

  // Second call → dedup kicks in (status=queued counts as active)
  await maybeEnqueuePortalSubmission({
    applicationId: appId,
    studentId,
    newStage:      TRIGGER_STAGE,
    universityName: UNI_NAME,
    universityId:  null,
    actorUserId:   authUserId,
  });

  // Count submissions for this app
  const all = await db
    .select({ id: portalSubmissionsTable.id })
    .from(portalSubmissionsTable)
    .where(
      and(
        eq(portalSubmissionsTable.applicationId, appId),
        eq(portalSubmissionsTable.universityKey, UNI_KEY),
        isNull(portalSubmissionsTable.deletedAt),
      ),
    );
  assert.equal(all.length, 1, "only one submission — dedup prevented duplicate");
});

// ---------------------------------------------------------------------------
// TAT4b — max_failures: 3 failed rows for the pair stop automatic re-enqueue
// ---------------------------------------------------------------------------
test("TAT4b: max_failures — does NOT enqueue after 3 failed submissions for the pair", async () => {
  const { studentId, appId } = await seedApp();

  // Seed 3 failed rows (failed is NOT in ACTIVE_STATUSES, so without the cap
  // the trigger would happily create a 4th queued row — the infinite loop).
  for (let i = 0; i < 3; i++) {
    await db.insert(portalSubmissionsTable).values({
      applicationId: appId,
      studentId,
      universityKey: UNI_KEY,
      universityName: UNI_NAME,
      adapterKey: ADAPTER_KEY,
      mode: "dry",
      status: "failed",
      attempts: 1,
    });
  }

  await maybeEnqueuePortalSubmission({
    applicationId: appId,
    studentId,
    newStage:      TRIGGER_STAGE,
    universityName: UNI_NAME,
    universityId:  null,
    actorUserId:   authUserId,
  });

  const rows = await db
    .select({ id: portalSubmissionsTable.id, status: portalSubmissionsTable.status })
    .from(portalSubmissionsTable)
    .where(
      and(
        eq(portalSubmissionsTable.applicationId, appId),
        eq(portalSubmissionsTable.universityKey, UNI_KEY),
        isNull(portalSubmissionsTable.deletedAt),
      ),
    );
  assert.equal(rows.length, 3, "no new row — max_failures gate blocked re-enqueue");
  assert.ok(rows.every((r) => r.status === "failed"), "all rows remain failed");
});

// ---------------------------------------------------------------------------
// TAT5 — Scheduled OFF: immediate drain trigger fires after a successful enqueue
// ---------------------------------------------------------------------------
test("TAT5: Scheduled OFF — immediate drain trigger fires after enqueue (not on dedup)", async () => {
  const { studentId, appId } = await seedApp();

  // Baseline: enabled + autoProcessEnabled=false (set in before())
  const calls: Array<{ label: string; stages: string[] | undefined }> = [];
  __setDrainTriggerForTests((label, stages) => calls.push({ label, stages }));

  try {
    // Successful enqueue → drain trigger fires exactly once
    await maybeEnqueuePortalSubmission({
      applicationId: appId,
      studentId,
      newStage:      TRIGGER_STAGE,
      universityName: UNI_NAME,
      universityId:  null,
      actorUserId:   authUserId,
    });

    const sub = await findSub(appId);
    assert.ok(sub !== null, "submission was enqueued");
    assert.equal(calls.length, 1, "drain trigger fired exactly once after enqueue");
    assert.ok(Array.isArray(calls[0].stages), "trigger received a triggerStages array");
    assert.ok(
      calls[0].stages!.includes(TRIGGER_STAGE),
      "trigger received the configured trigger stage",
    );

    // Dedup skip → NO additional fire
    await maybeEnqueuePortalSubmission({
      applicationId: appId,
      studentId,
      newStage:      TRIGGER_STAGE,
      universityName: UNI_NAME,
      universityId:  null,
      actorUserId:   authUserId,
    });
    assert.equal(calls.length, 1, "no drain trigger on a dedup skip");
  } finally {
    __setDrainTriggerForTests(null);
  }
});

// ---------------------------------------------------------------------------
// TAT6 — Scheduled ON: no immediate drain; periodic tick respects the interval
//        and updates last_auto_drain_at
// ---------------------------------------------------------------------------
test("TAT6: Scheduled ON — no immediate drain; tick drains only after interval + updates last_auto_drain_at", async () => {
  const { studentId, appId } = await seedApp();

  const calls: string[] = [];
  __setDrainTriggerForTests((label) => calls.push(label));

  try {
    // Scheduled ON, last drain = now → interval not elapsed
    const now = new Date();
    await db.update(portalAutomationSettingsTable)
      .set({ autoProcessEnabled: true, autoProcessIntervalMinutes: 20, lastAutoDrainAt: now })
      .where(eq(portalAutomationSettingsTable.id, settingsRowId!));

    // Enqueue → NO immediate drain trigger (scheduler owns draining)
    await maybeEnqueuePortalSubmission({
      applicationId: appId,
      studentId,
      newStage:      TRIGGER_STAGE,
      universityName: UNI_NAME,
      universityId:  null,
      actorUserId:   authUserId,
    });
    const sub = await findSub(appId);
    assert.ok(sub !== null, "submission was still enqueued");
    assert.equal(calls.length, 0, "no immediate drain trigger when Scheduled ON");

    // Tick BEFORE the interval elapses → no drain, timestamp unchanged
    const early = await runPortalAutoDrainTick();
    assert.equal(early.ran, false, "tick did not drain before the interval elapsed");
    assert.equal(
      (early as { ran: false; reason: string }).reason,
      "interval_not_elapsed",
      "reason=interval_not_elapsed",
    );
    const [afterEarly] = await db.select().from(portalAutomationSettingsTable)
      .where(eq(portalAutomationSettingsTable.id, settingsRowId!));
    assert.equal(
      new Date(afterEarly.lastAutoDrainAt as unknown as string | Date).getTime(),
      now.getTime(),
      "last_auto_drain_at unchanged before the interval",
    );

    // Backdate last drain past the interval → tick drains + updates timestamp
    const past = new Date(Date.now() - 21 * 60_000);
    await db.update(portalAutomationSettingsTable)
      .set({ lastAutoDrainAt: past })
      .where(eq(portalAutomationSettingsTable.id, settingsRowId!));

    const due = await runPortalAutoDrainTick();
    assert.equal(due.ran, true, "tick drained once the interval elapsed");

    const [afterDue] = await db.select().from(portalAutomationSettingsTable)
      .where(eq(portalAutomationSettingsTable.id, settingsRowId!));
    const updatedMs = new Date(afterDue.lastAutoDrainAt as unknown as string | Date).getTime();
    assert.ok(
      Date.now() - updatedMs < 60_000,
      "last_auto_drain_at updated to now after the scheduled drain",
    );
  } finally {
    __setDrainTriggerForTests(null);
    // Restore baseline: Scheduled OFF
    await db.update(portalAutomationSettingsTable)
      .set({ autoProcessEnabled: false, lastAutoDrainAt: null })
      .where(eq(portalAutomationSettingsTable.id, settingsRowId!));
  }
});

// ---------------------------------------------------------------------------
// TAT7 — Enabled OFF: kill-switch blocks BOTH immediate and scheduled drain
// ---------------------------------------------------------------------------
test("TAT7: Enabled OFF — neither immediate drain nor scheduled drain", async () => {
  const { studentId, appId } = await seedApp();

  const calls: string[] = [];
  __setDrainTriggerForTests((label) => calls.push(label));

  try {
    await db.update(portalAutomationSettingsTable)
      .set({ isEnabled: false, autoProcessEnabled: true, lastAutoDrainAt: null })
      .where(eq(portalAutomationSettingsTable.id, settingsRowId!));

    // Enqueue attempt → kill-switch: nothing enqueued, no drain trigger
    await maybeEnqueuePortalSubmission({
      applicationId: appId,
      studentId,
      newStage:      TRIGGER_STAGE,
      universityName: UNI_NAME,
      universityId:  null,
      actorUserId:   authUserId,
    });
    const sub = await findSub(appId);
    assert.equal(sub, null, "no submission enqueued when isEnabled=false");
    assert.equal(calls.length, 0, "no immediate drain trigger when isEnabled=false");

    // Scheduled tick → disabled, timestamp untouched
    const tick = await runPortalAutoDrainTick();
    assert.equal(tick.ran, false, "tick did not drain when isEnabled=false");
    assert.equal(
      (tick as { ran: false; reason: string }).reason,
      "disabled",
      "reason=disabled",
    );
    const [row] = await db.select().from(portalAutomationSettingsTable)
      .where(eq(portalAutomationSettingsTable.id, settingsRowId!));
    assert.equal(row.lastAutoDrainAt, null, "last_auto_drain_at untouched when disabled");
  } finally {
    __setDrainTriggerForTests(null);
    // Restore baseline: enabled + Scheduled OFF
    await db.update(portalAutomationSettingsTable)
      .set({ isEnabled: true, autoProcessEnabled: false, lastAutoDrainAt: null })
      .where(eq(portalAutomationSettingsTable.id, settingsRowId!));
  }
});

test("TAT7b: a new partner generation revokes old verification receipts", async () => {
  const [partner] = await db
    .select({ generation: portalUniversitiesTable.verificationGeneration })
    .from(portalUniversitiesTable)
    .where(eq(portalUniversitiesTable.universityKey, UNI_KEY));
  await db
    .update(portalUniversitiesTable)
    .set({ verificationGeneration: partner.generation + 1 })
    .where(eq(portalUniversitiesTable.universityKey, UNI_KEY));

  const { studentId, appId } = await seedApp();
  await maybeEnqueuePortalSubmission({
    applicationId: appId,
    studentId,
    newStage: TRIGGER_STAGE,
    universityName: UNI_NAME,
    universityId: null,
    actorUserId: authUserId,
  });

  const sub = await findSub(appId);
  assert.equal(sub, null, "stale generation receipts must not unlock automatic enqueue");
});

// ---------------------------------------------------------------------------
// TAT8 — resolvePortalRouting: aggregator membership resolved by NAME
//        (universityId=null, only universityName provided)
// ---------------------------------------------------------------------------
test("TAT8: resolvePortalRouting routes to aggregator by universityName when universityId=null", async () => {
  assert.ok(aggCatalogUniId !== null, "aggregator fixture set up");

  const result = await resolvePortalRouting({
    universityId:  null,
    universityName: AGG_MEMBER_NAME,
  });

  assert.ok(result !== null, "routing resolved (not null)");
  assert.equal(result!.portalUni.universityKey, AGG_UNI_KEY,     "routed to aggregator portalKey");
  assert.equal(result!.portalUni.adapterKey,    AGG_ADAPTER_KEY, "aggregator adapterKey");
  assert.ok(result!.target !== null,                              "target is set (not standalone)");
  assert.equal(result!.target!.catalogUniversityId, aggCatalogUniId!, "target.catalogUniversityId = catalog uni");
  assert.equal(result!.target!.universityName,       AGG_MEMBER_NAME,  "target.universityName = member name");
});

// ---------------------------------------------------------------------------
// TAT9 — resolvePortalRouting: aggregator membership resolved by universityId
//        (regression — existing id-based path still works)
// ---------------------------------------------------------------------------
test("TAT9: resolvePortalRouting routes to aggregator by universityId (regression)", async () => {
  assert.ok(aggCatalogUniId !== null, "aggregator fixture set up");

  const result = await resolvePortalRouting({
    universityId:  aggCatalogUniId,
    universityName: null,
  });

  assert.ok(result !== null, "routing resolved by universityId");
  assert.equal(result!.portalUni.universityKey, AGG_UNI_KEY,     "routed to aggregator");
  assert.ok(result!.target !== null,                              "target set");
  assert.equal(result!.target!.catalogUniversityId, aggCatalogUniId!, "correct catalogUniversityId");
});

// ---------------------------------------------------------------------------
// TAT10 — resolvePortalRouting: standalone university (not an aggregator member)
//         resolves via its own portal_universities row by name
// ---------------------------------------------------------------------------
test("TAT10: resolvePortalRouting falls back to standalone row for non-member university", async () => {
  // UNI_NAME has a portal_universities row but no portal_account_universities entry
  const result = await resolvePortalRouting({
    universityId:  null,
    universityName: UNI_NAME,
  });

  assert.ok(result !== null, "standalone routing resolved");
  assert.equal(result!.portalUni.universityKey, UNI_KEY, "uses the standalone portal row");
  assert.equal(result!.target,                  null,    "target=null on standalone path");
});

// ---------------------------------------------------------------------------
// TAT11 — resolvePortalRouting: unknown university name → null (no auto-trigger)
// ---------------------------------------------------------------------------
test("TAT11: resolvePortalRouting returns null for an unknown universityName", async () => {
  const result = await resolvePortalRouting({
    universityId:  null,
    universityName: `unknown_uni_not_in_db_${RUN}`,
  });

  assert.equal(result, null, "null when university has no catalog row and no standalone portal row");
});
