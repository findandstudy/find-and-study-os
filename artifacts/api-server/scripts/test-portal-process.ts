/**
 * test-portal-process.ts — A6 regression tests (TP1–TP7) +
 *                          Doc-slot mapping (TMD1–TMD10) +
 *                          Skip-reason surface (TSR1–TSR2) +
 *                          Queue mechanics (TAP1–TAP5)
 *
 * TP1: POST /portal-submissions/process-queued with empty queue → 202 accepted
 * TP2: POST /portal-submissions/:id/process → 404 on nonexistent id
 * TP3: POST /portal-submissions/:id/process on a canceled submission → 409 NOT_QUEUED
 * TP4: POST /portal-submissions/:id/process → 403 when user lacks required role
 * TP5: POST /portal-submissions/process-queued → 403 when user lacks required role
 * TP6: POST /portal-submissions/reset-stuck is worker-owned
 * TP7: API reset preserves a 15-min-old running row
 * TP8: API cancellation cannot revoke a running worker lease
 *
 * TMD1–TMD10: mapDocType canonical cases including #2103 document types
 * TSR1: writebackResult stores result.detail in resultJson for program_missing
 * TSR2: filledSlots/missingSlots stored in resultJson from meta
 *
 * TAP1: claimNext(worker,[keyA]) does NOT claim a submission for keyB
 * TAP2: claimNext(worker,[keyA]) claims the matching submission
 * TAP3: claimNext(worker) without filter claims any queued submission
 * TAP4: claimNext claims a queued submission even when attempts == max_attempts
 * TAP5: releaseStale resets attempts=0 on crash-recovered submissions
 *
 * Note: TP1–TP3 use a running API server stub backed by real DB.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:portal-process
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  applicationsTable,
  portalSubmissionsTable,
  portalAutomationSettingsTable,
  portalUniversitiesTable,
  studentsTable,
} from "@workspace/db";
import portalAutomationRouter from "../src/routes/portalAutomation.js";
import { mapDocType, REQUIRED_DOCS } from "@workspace/portal-adapters";
import { claimNext, releaseStale, writebackResult } from "@workspace/portal-runner";

// ---------------------------------------------------------------------------
// Run-specific tag (avoids cross-run pollution)
// ---------------------------------------------------------------------------
const RUN_ID = `pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------
const cleanupStudentIds:      number[] = [];
const cleanupAppIds:          number[] = [];
const cleanupSubmissionIds:   number[] = [];
const cleanupUniIds:          number[] = [];
const cleanupSettingsIds:     number[] = [];

after(async () => {
  for (const id of cleanupSubmissionIds) {
    await db.delete(portalSubmissionsTable).where(eq(portalSubmissionsTable.id, id)).catch(() => {});
  }
  for (const id of cleanupAppIds) {
    await db.delete(applicationsTable).where(eq(applicationsTable.id, id)).catch(() => {});
  }
  for (const id of cleanupStudentIds) {
    await db.delete(studentsTable).where(eq(studentsTable.id, id)).catch(() => {});
  }
  for (const id of cleanupUniIds) {
    await db.delete(portalUniversitiesTable).where(eq(portalUniversitiesTable.id, id)).catch(() => {});
  }
  for (const id of cleanupSettingsIds) {
    await db.delete(portalAutomationSettingsTable).where(eq(portalAutomationSettingsTable.id, id)).catch(() => {});
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Auth stubs
// ---------------------------------------------------------------------------
function buildApp(role = "super_admin"): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, role, isActive: true, emailVerified: true };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", portalAutomationRouter);
  return app;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendReq(
  server: http.Server,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr   = server.address() as { port: number };
    const json   = body !== undefined ? JSON.stringify(body) : undefined;
    const req    = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(json !== undefined ? { "Content-Length": Buffer.byteLength(json) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          try   { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      },
    );
    req.on("error", reject);
    if (json !== undefined) req.write(json);
    req.end();
  });
}

function listen(app: Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------
async function seedStudent(): Promise<number> {
  const [row] = await db
    .insert(studentsTable)
    .values({ firstName: `PP_${RUN_ID}`, lastName: "TestProcess" })
    .returning({ id: studentsTable.id });
  cleanupStudentIds.push(row.id);
  return row.id;
}

async function seedApp(studentId: number): Promise<number> {
  const [row] = await db
    .insert(applicationsTable)
    .values({ studentId })
    .returning({ id: applicationsTable.id });
  cleanupAppIds.push(row.id);
  return row.id;
}

async function seedSubmission(
  appId: number,
  studentId: number,
  status: "queued" | "canceled" | "failed" = "queued",
  universityKey = "topkapi",
): Promise<number> {
  const [row] = await db
    .insert(portalSubmissionsTable)
    .values({
      applicationId: appId,
      studentId,
      universityKey,
      universityName: `${universityKey} University (Test)`,
      mode: "dry",
      status,
      attempts: 0,
      maxAttempts: 3,
    })
    .returning({ id: portalSubmissionsTable.id });
  cleanupSubmissionIds.push(row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// TP1 — process-queued is an asynchronous acceptance endpoint. It never runs
// a browser in the API process, including when the queue is empty.
// ---------------------------------------------------------------------------
test("TP1: POST /portal-submissions/process-queued returns 202 acceptance", async () => {
  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", "/api/portal-submissions/process-queued");
    assert.equal(res.status, 202, `Expected 202, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.accepted, true);
    assert.ok(typeof res.body.queued === "number", "queued must be a number");
    assert.equal(typeof res.body.statusUrl, "string");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// TP2 — POST /portal-submissions/:id/process for nonexistent id → 404
// ---------------------------------------------------------------------------
test("TP2: POST /portal-submissions/:id/process with nonexistent id returns 404", async () => {
  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", "/api/portal-submissions/9999999/process");
    assert.equal(res.status, 404, `Expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "NOT_FOUND");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// TP3 — POST /portal-submissions/:id/process for canceled submission → 409 NOT_QUEUED
// ---------------------------------------------------------------------------
test("TP3: POST /portal-submissions/:id/process on canceled submission returns 409 NOT_QUEUED", async () => {
  const studentId    = await seedStudent();
  const appId        = await seedApp(studentId);
  const submissionId = await seedSubmission(appId, studentId, "canceled");

  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", `/api/portal-submissions/${submissionId}/process`);
    assert.equal(res.status, 409, `Expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "NOT_QUEUED", `Expected NOT_QUEUED, got ${res.body.error}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// TP4 — POST /portal-submissions/:id/process without required role → 403
//        requireRole fires before DB lookup, so no seed required.
// ---------------------------------------------------------------------------
test("TP4: POST /portal-submissions/:id/process as agent returns 403", async () => {
  const app    = buildApp("agent");
  const server = await listen(app);
  try {
    // Any integer id — 403 returned before the DB is touched
    const res = await sendReq(server, "POST", "/api/portal-submissions/1/process");
    assert.equal(res.status, 403, `Expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// TP5 — POST /portal-submissions/process-queued without required role → 403
// ---------------------------------------------------------------------------
test("TP5: POST /portal-submissions/process-queued as student returns 403", async () => {
  const app    = buildApp("student");
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", "/api/portal-submissions/process-queued");
    assert.equal(res.status, 403, `Expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// TP6 — API-side stale reset is fail-closed; only the worker may recover it.
// ---------------------------------------------------------------------------
test("TP6: POST /portal-submissions/reset-stuck is worker-owned", async () => {
  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", "/api/portal-submissions/reset-stuck", {});
    assert.equal(res.status, 409, `Expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "WORKER_OWNED_RECOVERY");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// TP7 — API reset cannot race a still-active browser action.
// ---------------------------------------------------------------------------
test("TP7: POST /portal-submissions/reset-stuck preserves an old running submission", async () => {
  const studentId    = await seedStudent();
  const appId        = await seedApp(studentId);
  const submissionId = await seedSubmission(appId, studentId, "queued");

  // Manually set the row to 'running' with a locked_at 15 minutes in the past.
  await db.execute(
    sql`UPDATE portal_submissions
        SET status = 'running',
            locked_at = NOW() - INTERVAL '15 minutes',
            locked_by = 'test-old-worker'
        WHERE id = ${submissionId}`,
  );

  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", "/api/portal-submissions/reset-stuck", { thresholdMinutes: 10 });
    assert.equal(res.status, 409, `Expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "WORKER_OWNED_RECOVERY");

    const [row] = await db
      .select({ status: portalSubmissionsTable.status })
      .from(portalSubmissionsTable)
      .where(eq(portalSubmissionsTable.id, submissionId));
    assert.equal(row?.status, "running", `Expected status=running, got ${row?.status}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("TP8: POST /portal-submissions/:id/cancel rejects a worker-owned running submission", async () => {
  const studentId = await seedStudent();
  const appId = await seedApp(studentId);
  const submissionId = await seedSubmission(appId, studentId, "queued");
  await db
    .update(portalSubmissionsTable)
    .set({
      status: "running",
      lockedAt: new Date(),
      lockedBy: `worker-cancel-${RUN_ID}`,
    })
    .where(eq(portalSubmissionsTable.id, submissionId));

  const app = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", `/api/portal-submissions/${submissionId}/cancel`);
    assert.equal(res.status, 409, `Expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "RUNNING_SUBMISSION_WORKER_OWNED");
    const [row] = await db
      .select({ status: portalSubmissionsTable.status, lockedBy: portalSubmissionsTable.lockedBy })
      .from(portalSubmissionsTable)
      .where(eq(portalSubmissionsTable.id, submissionId));
    assert.equal(row?.status, "running");
    assert.equal(row?.lockedBy, `worker-cancel-${RUN_ID}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ===========================================================================
// TMD1–TMD10: mapDocType canonical cases
// ===========================================================================

test("TMD1: passport → 'passport'", () => {
  assert.equal(mapDocType("passport"), "passport");
});

test("TMD2: photo → 'photo'", () => {
  assert.equal(mapDocType("photo"), "photo");
});

test("TMD3: photograph → 'photo'", () => {
  assert.equal(mapDocType("photograph"), "photo");
});

test("TMD4: class_12th_hsc_marks_sheet → 'transcript' (#2103 transcript doc)", () => {
  assert.equal(mapDocType("class_12th_hsc_marks_sheet"), "transcript");
});

test("TMD5: high_school_diploma_translation → 'diploma' (#2103 diploma doc)", () => {
  assert.equal(mapDocType("high_school_diploma_translation"), "diploma");
});

test("TMD6: hsc standalone → 'transcript' (new hsc keyword)", () => {
  assert.equal(mapDocType("hsc"), "transcript");
});

test("TMD7: hsc_marksheet → 'transcript' (hsc+marksheet, transcript wins)", () => {
  assert.equal(mapDocType("hsc_marksheet"), "transcript");
});

test("TMD8: bachelors_certificate → 'diploma' (new certificate keyword)", () => {
  assert.equal(mapDocType("bachelors_certificate"), "diploma");
});

test("TMD9: unknown_document_type → null (unmapped returns null)", () => {
  assert.equal(mapDocType("unknown_document_type"), null);
});

test("TMD10: #2103 scenario — all 4 REQUIRED_DOCS slots filled by the student's doc types", () => {
  const studentDocTypes = [
    "photo",
    "passport",
    "class_12th_hsc_marks_sheet",
    "high_school_diploma_translation",
  ];
  const mappedSlots = new Set(
    studentDocTypes.map(mapDocType).filter((s): s is string => s !== null),
  );
  for (const required of REQUIRED_DOCS) {
    assert.ok(
      mappedSlots.has(required),
      `Required slot "${required}" not covered. Mapped: [${[...mappedSlots].join(", ")}]`,
    );
  }
  assert.equal(
    mappedSlots.size, 4,
    `Expected 4 unique slots, got ${mappedSlots.size}: [${[...mappedSlots].join(", ")}]`,
  );
});

// ===========================================================================
// TSR1: writebackResult stores result.detail in resultJson for program_missing
// ===========================================================================

test("TSR1: writebackResult stores result.detail in resultJson for program_missing", async () => {
  const studentId    = await seedStudent();
  const appId        = await seedApp(studentId);
  const submissionId = await seedSubmission(appId, studentId, "queued");

  await writebackResult(submissionId, {
    result: {
      submitted:      false,
      alreadyExists:  false,
      programMissing: true,
      detail:         `Program "Computer Science" not found in dropdown (12 option(s) available)`,
    },
    screenshotUrls: [],
    meta: { adapterKey: "topkapi" },
  });

  const [row] = await db
    .select({ status: portalSubmissionsTable.status, resultJson: portalSubmissionsTable.resultJson })
    .from(portalSubmissionsTable)
    .where(eq(portalSubmissionsTable.id, submissionId));

  assert.equal(row?.status, "program_missing",
    `Expected status=program_missing, got ${row?.status}`);

  const rj     = row?.resultJson as Record<string, unknown> | null;
  const result = rj?.["result"] as Record<string, unknown> | undefined;
  assert.ok(result, "resultJson.result should be set");
  assert.equal(
    result["detail"],
    `Program "Computer Science" not found in dropdown (12 option(s) available)`,
    `Unexpected resultJson.result.detail: ${JSON.stringify(result["detail"])}`,
  );
});

// ===========================================================================
// TSR2: filledSlots/missingSlots stored in resultJson from meta
// ===========================================================================

test("TSR2: writebackResult stores filledSlots and missingSlots from meta in resultJson", async () => {
  const studentId    = await seedStudent();
  const appId        = await seedApp(studentId);
  const submissionId = await seedSubmission(appId, studentId, "queued");

  await writebackResult(submissionId, {
    result: {
      submitted:      false,
      alreadyExists:  false,
      programMissing: true,
      detail:         `Program "Computer Science" not found in dropdown (5 option(s) available)`,
    },
    screenshotUrls: [],
    meta: {
      adapterKey:   "topkapi",
      filledSlots:  ["photo", "passport", "transcript", "diploma"],
      missingSlots: [] as string[],
    },
  });

  const [row] = await db
    .select({ resultJson: portalSubmissionsTable.resultJson })
    .from(portalSubmissionsTable)
    .where(eq(portalSubmissionsTable.id, submissionId));

  const rj = row?.resultJson as Record<string, unknown> | null;
  assert.ok(rj, "resultJson should be set");
  assert.deepEqual(rj?.["filledSlots"],  ["photo", "passport", "transcript", "diploma"],
    `Unexpected filledSlots: ${JSON.stringify(rj?.["filledSlots"])}`);
  assert.deepEqual(rj?.["missingSlots"], [],
    `Unexpected missingSlots: ${JSON.stringify(rj?.["missingSlots"])}`);
});

// ===========================================================================
// TAP1: claimNext with universityKeys filter excludes non-matching submissions
// ===========================================================================

test("TAP1: claimNext(worker, [keyA]) does not claim a queued submission for keyB", async () => {
  const KEY_A = `tap1_a_${RUN_ID}`;
  const KEY_B = `tap1_b_${RUN_ID}`;

  const studentId = await seedStudent();
  const appId     = await seedApp(studentId);
  // Seed a submission for KEY_A
  const subId = await seedSubmission(appId, studentId, "queued", KEY_A);
  const WORKER = `TAP1_${RUN_ID}`;

  try {
    // Filter for KEY_B only — KEY_A submission must NOT be claimed
    const sub = await claimNext(WORKER, [KEY_B]);
    assert.equal(sub, null, `claimNext filtered for [${KEY_B}] should return null — KEY_A submission must not be claimed`);
  } finally {
    // Release if accidentally locked by a parallel worker
    await db
      .update(portalSubmissionsTable)
      .set({ status: "queued", lockedBy: null, lockedAt: null } as any)
      .where(eq(portalSubmissionsTable.id, subId))
      .catch(() => {});
  }
});

// ===========================================================================
// TAP2: claimNext with matching universityKeys filter claims the submission
// ===========================================================================

test("TAP2: claimNext(worker, [keyA]) claims a queued submission for keyA", async () => {
  const KEY_A = `tap2_a_${RUN_ID}`;
  const WORKER = `TAP2_${RUN_ID}`;

  const studentId = await seedStudent();
  const appId     = await seedApp(studentId);
  const subId     = await seedSubmission(appId, studentId, "queued", KEY_A);

  const sub = await claimNext(WORKER, [KEY_A]);
  try {
    assert.ok(sub !== null, `claimNext filtered for [${KEY_A}] should claim the submission`);
    assert.equal(sub!.id, subId, `Expected claimed submission id=${subId}, got ${sub?.id}`);
    assert.equal(sub!.universityKey, KEY_A, `Expected universityKey=${KEY_A}, got ${sub?.universityKey}`);
  } finally {
    // Release the claim so cleanup can delete the row
    if (sub) {
      await db
        .update(portalSubmissionsTable)
        .set({ status: "failed", lockedBy: null, lockedAt: null } as any)
        .where(eq(portalSubmissionsTable.id, sub.id))
        .catch(() => {});
    }
  }
});

// ===========================================================================
// TAP3: claimNext without filter claims submissions for any university
// ===========================================================================

test("TAP3: claimNext(worker) without filter claims any queued submission regardless of university", async () => {
  const KEY_ANY = `tap3_any_${RUN_ID}`;
  const WORKER  = `TAP3_${RUN_ID}`;

  const studentId = await seedStudent();
  const appId     = await seedApp(studentId);
  const subId     = await seedSubmission(appId, studentId, "queued", KEY_ANY);

  // Call claimNext without any universityKeys filter
  const sub = await claimNext(WORKER);
  try {
    assert.ok(sub !== null, "claimNext without filter should claim a queued submission");
    // The claimed submission should be ours (may pick up other test submissions but that's OK)
    assert.ok(typeof sub!.id === "number", "Claimed submission must have a numeric id");
  } finally {
    if (sub) {
      await db
        .update(portalSubmissionsTable)
        .set({ status: "failed", lockedBy: null, lockedAt: null } as any)
        .where(eq(portalSubmissionsTable.id, sub.id))
        .catch(() => {});
    }
    // Ensure our seeded submission is also cleaned up if it wasn't claimed
    await db
      .update(portalSubmissionsTable)
      .set({ status: "failed" } as any)
      .where(eq(portalSubmissionsTable.id, subId))
      .catch(() => {});
  }
});

// ===========================================================================
// TAP4: claimNext claims a queued submission even when attempts == max_attempts
// ===========================================================================

test("TAP4: claimNext claims a queued submission whose attempts equals max_attempts", async () => {
  const KEY = `tap4_${RUN_ID}`;
  const WORKER = `TAP4_${RUN_ID}`;

  const studentId = await seedStudent();
  const appId     = await seedApp(studentId);
  const subId     = await seedSubmission(appId, studentId, "queued", KEY);

  // Exhaust all attempts so attempts == max_attempts (3 == 3)
  await db
    .update(portalSubmissionsTable)
    .set({ attempts: sql`max_attempts` } as any)
    .where(eq(portalSubmissionsTable.id, subId));

  const sub = await claimNext(WORKER, [KEY]);
  try {
    assert.ok(
      sub !== null,
      `claimNext must claim a queued submission even when attempts == max_attempts (got null — permanent-lock bug)`,
    );
    assert.equal(sub!.id, subId);
  } finally {
    await db
      .update(portalSubmissionsTable)
      .set({ status: "failed", lockedBy: null, lockedAt: null } as any)
      .where(eq(portalSubmissionsTable.id, subId))
      .catch(() => {});
  }
});

// ===========================================================================
// TAP5: releaseStale resets attempts = 0 on crash-recovered submissions
// ===========================================================================

test("TAP5: releaseStale resets attempts to 0 for crash-recovered running submissions", async () => {
  const KEY = `tap5_${RUN_ID}`;
  const WORKER = `TAP5_${RUN_ID}`;

  const studentId = await seedStudent();
  const appId     = await seedApp(studentId);
  const subId     = await seedSubmission(appId, studentId, "queued", KEY);

  // Simulate a crashed worker: mark the row running with max attempts, 1 hour ago
  await db
    .update(portalSubmissionsTable)
    .set({
      status:   "running",
      lockedBy: WORKER,
      lockedAt: sql`NOW() - INTERVAL '1 hour'`,
      attempts: sql`max_attempts`,
    } as any)
    .where(eq(portalSubmissionsTable.id, subId));

  // releaseStale with 10-minute threshold — the 1-hour-old row must be reset
  const resetIds = await releaseStale(10 * 60 * 1000);
  assert.ok(resetIds.includes(subId), `releaseStale must include subId=${subId} in returned ids`);

  // Verify attempts were reset to 0 (not left at max_attempts)
  const [after] = await db
    .select({ status: portalSubmissionsTable.status, attempts: portalSubmissionsTable.attempts })
    .from(portalSubmissionsTable)
    .where(eq(portalSubmissionsTable.id, subId));

  assert.equal(after.status,   "queued", "releaseStale must reset status to queued");
  assert.equal(after.attempts, 0,        "releaseStale must reset attempts to 0 (permanent-lock fix)");

  // Cleanup
  await db
    .update(portalSubmissionsTable)
    .set({ status: "failed" } as any)
    .where(eq(portalSubmissionsTable.id, subId))
    .catch(() => {});
});
