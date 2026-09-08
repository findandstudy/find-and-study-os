/**
 * Portal Automation API — regression tests (T1–T7).
 *
 * T1  dry enqueue → 201, status=queued
 * T2  real mode without confirm → 422 CONFIRM_REQUIRED
 * T3  real mode with confirm:true → 201
 * T4  list isolation — applicationId filter returns only correct submission
 * T5  cancel → queued→canceled; second cancel → 409 NOT_CANCELABLE
 * T6  retry → canceled→queued
 * T7  GET /university-portals — verified readiness booleans, no secret values
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:portal-automation
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  applicationsTable,
  portalSubmissionsTable,
  portalUniversitiesTable,
  studentsTable,
  usersTable,
} from "@workspace/db";
import portalAutomationRouter from "../src/routes/portalAutomation.js";
import {
  loadPortalPartnerVerificationBinding,
  PortalVerificationIdempotencyConflictError,
  recordPortalPartnerVerificationReceipt,
} from "@workspace/portal-runner";
import {
  assertDisposablePortalVerificationTarget,
  seedVerifiedPortalPartnerFixture,
} from "./portalVerificationFixture.js";

assertDisposablePortalVerificationTarget();

const RUN_ID = `pa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// Queue-lifecycle coverage intentionally uses an adapter without a strict
// submission-readiness manifest. Strict preflight behavior is covered by its
// own regression suite; these tests exercise enqueue/cancel/retry semantics.
// The portal account is created for this run so production configuration does
// not affect the API contract test.
const QUEUE_TEST_UNIVERSITY = `${RUN_ID}_queue`;
const QUEUE_TEST_ADAPTER = `${RUN_ID}_adapter`;

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------
const cleanupSubmissionIds: number[] = [];
const cleanupAppIds: number[] = [];
const cleanupStudentIds: number[] = [];
let cleanupPortalUniversityId: number | null = null;
let cleanupUserId: number | null = null;

before(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_ID}.admin@example.com`,
      firstName: "Portal",
      lastName: "Queue Admin",
      role: "super_admin",
      isActive: true,
      emailVerified: true,
    })
    .returning({ id: usersTable.id });
  cleanupUserId = user.id;
  currentUser.id = user.id;

  const [portalUniversity] = await db
    .insert(portalUniversitiesTable)
    .values({
      universityKey: QUEUE_TEST_UNIVERSITY,
      universityName: `Portal queue test ${RUN_ID}`,
      adapterKey: QUEUE_TEST_ADAPTER,
      isActive: true,
    })
    .returning({ id: portalUniversitiesTable.id });
  cleanupPortalUniversityId = portalUniversity.id;
  await seedVerifiedPortalPartnerFixture({
    portalUniversityId: portalUniversity.id,
    universityKey: QUEUE_TEST_UNIVERSITY,
    universityName: `Portal queue test ${RUN_ID}`,
    adapterKey: QUEUE_TEST_ADAPTER,
  });
});

after(async () => {
  if (cleanupSubmissionIds.length) {
    await db
      .delete(portalSubmissionsTable)
      .where(eq(portalSubmissionsTable.id, cleanupSubmissionIds[0]))
      .catch(() => {});
    for (const id of cleanupSubmissionIds) {
      await db
        .delete(portalSubmissionsTable)
        .where(eq(portalSubmissionsTable.id, id))
        .catch(() => {});
    }
  }
  for (const id of cleanupAppIds) {
    await db
      .delete(applicationsTable)
      .where(eq(applicationsTable.id, id))
      .catch(() => {});
  }
  for (const id of cleanupStudentIds) {
    await db
      .delete(studentsTable)
      .where(eq(studentsTable.id, id))
      .catch(() => {});
  }
  if (cleanupPortalUniversityId !== null) {
    await db
      .delete(portalUniversitiesTable)
      .where(eq(portalUniversitiesTable.id, cleanupPortalUniversityId))
      .catch(() => {});
  }
  if (cleanupUserId !== null) {
    await db
      .delete(usersTable)
      .where(eq(usersTable.id, cleanupUserId))
      .catch(() => {});
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Auth stub
// ---------------------------------------------------------------------------
let currentUser: { id: number; role: string; isActive: boolean; emailVerified?: boolean } = {
  id: 1,
  role: "super_admin",
  isActive: true,
  emailVerified: true,
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { ...currentUser };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", portalAutomationRouter);
  return app;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function sendReq(
  server: http.Server,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const json = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
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
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
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
async function createStudent(): Promise<number> {
  const [s] = await db
    .insert(studentsTable)
    .values({ firstName: `PA_${RUN_ID}`, lastName: "Test" })
    .returning({ id: studentsTable.id });
  cleanupStudentIds.push(s.id);
  return s.id;
}

async function createApp(studentId: number): Promise<number> {
  const [a] = await db
    .insert(applicationsTable)
    .values({ studentId })
    .returning({ id: applicationsTable.id });
  cleanupAppIds.push(a.id);
  return a.id;
}

// ---------------------------------------------------------------------------
// T1 — dry enqueue → 201, status=queued
// ---------------------------------------------------------------------------
test("T1: dry enqueue returns 201 with status=queued", async () => {
  const studentId = await createStudent();
  const appId = await createApp(studentId);
  const app = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", `/api/applications/${appId}/portal-submissions`, {
      universityKey: QUEUE_TEST_UNIVERSITY,
      mode: "dry",
    });
    assert.equal(res.status, 201, `Expected 201 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.status, "queued");
    assert.equal(res.body.mode, "dry");
    assert.equal(res.body.applicationId, appId);
    cleanupSubmissionIds.push(res.body.id);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// T2 — real mode without confirm → 422
// ---------------------------------------------------------------------------
test("T2: real mode without confirm returns 422 CONFIRM_REQUIRED", async () => {
  const studentId = await createStudent();
  const appId = await createApp(studentId);
  const app = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", `/api/applications/${appId}/portal-submissions`, {
      universityKey: QUEUE_TEST_UNIVERSITY,
      mode: "real",
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "CONFIRM_REQUIRED");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// T3 — real mode with confirm:true → 201
// ---------------------------------------------------------------------------
test("T3: real mode with confirm:true returns 201", async () => {
  const studentId = await createStudent();
  const appId = await createApp(studentId);
  const app = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", `/api/applications/${appId}/portal-submissions`, {
      universityKey: QUEUE_TEST_UNIVERSITY,
      mode: "real",
      confirm: true,
    });
    assert.equal(res.status, 201, `Expected 201 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.mode, "real");
    assert.equal(res.body.status, "queued");
    cleanupSubmissionIds.push(res.body.id);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// T4 — list isolation: applicationId filter returns only matching submissions
// ---------------------------------------------------------------------------
test("T4: list filtered by applicationId returns only that application's submissions", async () => {
  const studentId = await createStudent();
  const app1Id = await createApp(studentId);
  const app2Id = await createApp(studentId);

  const app = buildApp();
  const server = await listen(app);
  try {
    // Enqueue one submission for each application
    const r1 = await sendReq(server, "POST", `/api/applications/${app1Id}/portal-submissions`, {
      universityKey: QUEUE_TEST_UNIVERSITY,
      mode: "dry",
    });
    assert.equal(r1.status, 201);
    cleanupSubmissionIds.push(r1.body.id);

    const r2 = await sendReq(server, "POST", `/api/applications/${app2Id}/portal-submissions`, {
      universityKey: QUEUE_TEST_UNIVERSITY,
      mode: "dry",
    });
    assert.equal(r2.status, 201);
    cleanupSubmissionIds.push(r2.body.id);

    // Filter by app1Id — should only return app1's submission
    const list = await sendReq(server, "GET", `/api/portal-submissions?applicationId=${app1Id}`);
    assert.equal(list.status, 200);
    const ids: number[] = list.body.data.map((row: any) => row.applicationId);
    assert.ok(ids.every((id) => id === app1Id), `Expected all applicationId=${app1Id}, got: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(app1Id), "app1 submission missing from list");
    assert.ok(!list.body.data.some((row: any) => row.applicationId === app2Id), "app2 submission leaked into filtered list");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// T4b — step-1 chain labels: original applied app → X1; fan-out copy (linked via
//       mainApplicationId to a different-university root) → Y1. Every attempt is
//       labeled and surfaced on the board (acceptance: X1/Y1 visible per attempt).
// ---------------------------------------------------------------------------
test("T4b: step-1 attempts are labeled X1 (original) and Y1 (fan-out)", async () => {
  const studentId = await createStudent();
  // Original applied application (no supersession parent, no mainApplicationId).
  const originalAppId = await createApp(studentId);
  // Fan-out copy: same student, linked to the original as its chain root.
  const [fanOut] = await db
    .insert(applicationsTable)
    .values({ studentId, mainApplicationId: originalAppId })
    .returning({ id: applicationsTable.id });
  cleanupAppIds.push(fanOut.id);

  const app = buildApp();
  const server = await listen(app);
  try {
    const rOrig = await sendReq(server, "POST", `/api/applications/${originalAppId}/portal-submissions`, {
      universityKey: QUEUE_TEST_UNIVERSITY,
      mode: "dry",
    });
    assert.equal(rOrig.status, 201);
    cleanupSubmissionIds.push(rOrig.body.id);

    const rFan = await sendReq(server, "POST", `/api/applications/${fanOut.id}/portal-submissions`, {
      universityKey: QUEUE_TEST_UNIVERSITY,
      mode: "dry",
    });
    assert.equal(rFan.status, 201);
    cleanupSubmissionIds.push(rFan.body.id);

    const origList = await sendReq(server, "GET", `/api/portal-submissions?applicationId=${originalAppId}`);
    assert.equal(origList.status, 200);
    assert.equal(origList.body.data[0]?.fallbackStep, "X1", "original applied attempt must be labeled X1");

    const fanList = await sendReq(server, "GET", `/api/portal-submissions?applicationId=${fanOut.id}`);
    assert.equal(fanList.status, 200);
    assert.equal(fanList.body.data[0]?.fallbackStep, "Y1", "fan-out attempt must be labeled Y1");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// T5 — cancel: queued→canceled; second cancel → 409
// ---------------------------------------------------------------------------
test("T5: cancel queued submission, then 409 on second cancel", async () => {
  const studentId = await createStudent();
  const appId = await createApp(studentId);
  const app = buildApp();
  const server = await listen(app);
  try {
    const enq = await sendReq(server, "POST", `/api/applications/${appId}/portal-submissions`, {
      universityKey: QUEUE_TEST_UNIVERSITY,
      mode: "dry",
    });
    assert.equal(enq.status, 201);
    const subId: number = enq.body.id;
    cleanupSubmissionIds.push(subId);

    // First cancel → 200
    const c1 = await sendReq(server, "POST", `/api/portal-submissions/${subId}/cancel`);
    assert.equal(c1.status, 200, `Expected 200 got ${c1.status}: ${JSON.stringify(c1.body)}`);
    assert.equal(c1.body.ok, true);

    // Verify DB status
    const [dbRow] = await db
      .select({ status: portalSubmissionsTable.status })
      .from(portalSubmissionsTable)
      .where(eq(portalSubmissionsTable.id, subId));
    assert.equal(dbRow?.status, "canceled");

    // Second cancel → 409
    const c2 = await sendReq(server, "POST", `/api/portal-submissions/${subId}/cancel`);
    assert.equal(c2.status, 409);
    assert.equal(c2.body.error, "NOT_CANCELABLE");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// T6 — retry: canceled→queued
// ---------------------------------------------------------------------------
test("T6: retry canceled submission sets status back to queued", async () => {
  const studentId = await createStudent();
  const appId = await createApp(studentId);
  const app = buildApp();
  const server = await listen(app);
  try {
    const enq = await sendReq(server, "POST", `/api/applications/${appId}/portal-submissions`, {
      universityKey: QUEUE_TEST_UNIVERSITY,
      mode: "dry",
    });
    assert.equal(enq.status, 201);
    const subId: number = enq.body.id;
    cleanupSubmissionIds.push(subId);

    // Cancel first
    const cancel = await sendReq(server, "POST", `/api/portal-submissions/${subId}/cancel`);
    assert.equal(cancel.status, 200);

    // Retry → 200
    const retry = await sendReq(server, "POST", `/api/portal-submissions/${subId}/retry`);
    assert.equal(retry.status, 200, `Expected 200 got ${retry.status}: ${JSON.stringify(retry.body)}`);
    assert.equal(retry.body.ok, true);

    // Verify DB
    const [dbRow] = await db
      .select({ status: portalSubmissionsTable.status })
      .from(portalSubmissionsTable)
      .where(eq(portalSubmissionsTable.id, subId));
    assert.equal(dbRow?.status, "queued");

    // Retry again when queued → 409 NOT_RETRYABLE
    const retry2 = await sendReq(server, "POST", `/api/portal-submissions/${subId}/retry`);
    assert.equal(retry2.status, 409);
    assert.equal(retry2.body.error, "NOT_RETRYABLE");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// T7 — GET /university-portals: hasCredentials boolean, no secret values
// ---------------------------------------------------------------------------
test("T7: /university-portals returns verified readiness booleans without secrets", async () => {
  const app = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "GET", "/api/university-portals");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), "Expected array");
    assert.ok(res.body.length > 0, "Expected at least one university portal");

    for (const portal of res.body) {
      assert.ok("key" in portal, "Missing key");
      assert.ok("label" in portal, "Missing label");
      assert.ok("hasCredentials" in portal, "Missing hasCredentials");
      assert.equal(typeof portal.hasCredentials, "boolean", "hasCredentials must be boolean");
      assert.equal(portal.dryRunReady, true, "listed portals must be safe for strict dry run");
      assert.equal(typeof portal.realRunReady, "boolean", "realRunReady must be explicit");
      // Ensure no credential values are leaked
      const keys = Object.keys(portal);
      const secretKeys = keys.filter(
        (k) => k.toLowerCase().includes("password") || k.toLowerCase().includes("secret") || k.toLowerCase().includes("token"),
      );
      assert.equal(secretKeys.length, 0, `Secret keys leaked: ${secretKeys.join(", ")}`);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("T8: verification request keys allow exact replay and reject conflicting evidence", async () => {
  assert.notEqual(cleanupPortalUniversityId, null);
  const binding = await loadPortalPartnerVerificationBinding(cleanupPortalUniversityId!);
  assert.ok(binding);
  const requestKey = `test-login:idempotency:${RUN_ID}`;
  const exact = {
    binding,
    verificationType: "TEST_LOGIN" as const,
    outcome: "PASSED" as const,
    requestKey,
    performedBy: cleanupUserId,
    evidence: { headless: true, source: "idempotency-test" },
  };

  await recordPortalPartnerVerificationReceipt(exact);
  await recordPortalPartnerVerificationReceipt(exact);
  await assert.rejects(
    recordPortalPartnerVerificationReceipt({
      ...exact,
      outcome: "FAILED",
      failureCode: "PORTAL_LOGIN_FAILED",
    }),
    PortalVerificationIdempotencyConflictError,
  );
});
