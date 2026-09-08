/**
 * test-portal-manual-submit.ts — manual portal submission regression tests
 *
 * MSUB1: GET /portal-automation/eligible-applications — finds eligible app (q search)
 * MSUB2: POST /portal-automation/submit single dry → 201, queued row mode=dry status=queued
 * MSUB3: duplicate guard — re-submit same app → skipped ALREADY_QUEUED, no new row
 * MSUB4: bulk submit [appB, appA] → appB queued, appA skipped ALREADY_QUEUED
 * MSUB5: real mode without confirm → 422 CONFIRM_REQUIRED
 * MSUB6: real mode with confirm → 201, row mode=real
 * MSUB7: unknown id (single) → 404
 * MSUB8: deleted app (single) → 404; (bulk) → skipped NOT_FOUND
 * MSUB9: RBAC — non-admin role → 403
 * MSUB10: rate limit — burst of identical submits → 429
 * MSUB14: concurrent submits for the same app create exactly one active row
 *
 * Run:
 *   pnpm --filter @workspace/api-server test:portal-manual-submit
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  studentsTable,
  applicationsTable,
  portalUniversitiesTable,
  portalSubmissionsTable,
} from "@workspace/db";
import portalAutomationRouter, {
  buildManualFanOutMeta,
} from "../src/routes/portalAutomation.js";
import {
  assertDisposablePortalVerificationTarget,
  seedVerifiedPortalPartnerFixture,
} from "./portalVerificationFixture.js";

assertDisposablePortalVerificationTarget();

// ---------------------------------------------------------------------------
// Run-specific tag + fixtures
// ---------------------------------------------------------------------------
const RUN = `msub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
const UNI_NAME = `Manual Submit Uni ${RUN}`;
const UNI_KEY = `uni_${RUN}`;

let studentId = 0;
let portalUniId = 0;
let unverifiedPortalUniId = 0;
let authUserId = 0;
let rlUserId = 0;
let appA = 0; // dry single + dedup
let appB = 0; // bulk
let appC = 0; // real-confirm
let appD = 0; // soft-deleted
let appE = 0; // no matching portal university
let appF = 0; // concurrent idempotency
let appG = 0; // mapped partner without current verification receipts

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
after(async () => {
  const appIds = [appA, appB, appC, appD, appE, appF, appG].filter((x) => x > 0);
  if (appIds.length > 0) {
    await db.delete(portalSubmissionsTable).where(inArray(portalSubmissionsTable.applicationId, appIds)).catch(() => {});
    await db.delete(applicationsTable).where(inArray(applicationsTable.id, appIds)).catch(() => {});
  }
  if (portalUniId > 0) {
    await db.delete(portalUniversitiesTable).where(eq(portalUniversitiesTable.id, portalUniId)).catch(() => {});
  }
  if (unverifiedPortalUniId > 0) {
    await db.delete(portalUniversitiesTable).where(eq(portalUniversitiesTable.id, unverifiedPortalUniId)).catch(() => {});
  }
  if (studentId > 0) {
    await db.delete(studentsTable).where(eq(studentsTable.id, studentId)).catch(() => {});
  }
  if (authUserId > 0) {
    await db.delete(usersTable).where(eq(usersTable.id, authUserId)).catch(() => {});
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Auth stub — role/id parametrized so RBAC + rate-limit can use distinct users
// ---------------------------------------------------------------------------
function buildApp(role = "super_admin", id = authUserId): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id, role, isActive: true, emailVerified: true };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", portalAutomationRouter);
  return app;
}

function sendReq(
  server: http.Server,
  method: "GET" | "POST",
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
function close(server: http.Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

// ---------------------------------------------------------------------------
// Fixture setup (runs first as a test so node:test ordering is deterministic)
// ---------------------------------------------------------------------------
test("MSUB0: seed fixtures", async () => {
  const [authUser] = await db
    .insert(usersTable)
    .values({
      email: `${RUN}.admin@example.com`,
      firstName: "Portal",
      lastName: "Admin",
      role: "super_admin",
      isActive: true,
      emailVerified: true,
    })
    .returning({ id: usersTable.id });
  authUserId = authUser.id;
  rlUserId = authUser.id;

  const [stu] = await db
    .insert(studentsTable)
    .values({ firstName: `Manual${RUN}`, lastName: "Tester", email: `${RUN}@example.com` })
    .returning({ id: studentsTable.id });
  studentId = stu.id;

  const [uni] = await db
    .insert(portalUniversitiesTable)
    .values({
      universityKey:  UNI_KEY,
      universityName: UNI_NAME,
      adapterKey:     `adapter_${RUN}`,
      isActive:       true,
    })
    .returning({ id: portalUniversitiesTable.id });
  portalUniId = uni.id;

  const mkApp = async (deleted = false): Promise<number> => {
    const [a] = await db
      .insert(applicationsTable)
      .values({
        studentId,
        universityName: UNI_NAME,
        stage:          "offer",
        ...(deleted ? { deletedAt: new Date() } : {}),
      })
      .returning({ id: applicationsTable.id });
    return a.id;
  };

  appA = await mkApp();
  appB = await mkApp();
  appC = await mkApp();
  appD = await mkApp(true);
  appF = await mkApp();

  // appE: a non-deleted app whose university matches NO active portal_universities row.
  const [e] = await db
    .insert(applicationsTable)
    .values({ studentId, universityName: `No Portal Uni ${RUN}`, stage: "offer" })
    .returning({ id: applicationsTable.id });
  appE = e.id;

  const unverifiedUniversityName = `Unverified Portal Uni ${RUN}`;
  const [unverifiedPortal] = await db
    .insert(portalUniversitiesTable)
    .values({
      universityKey: `unverified_${RUN}`,
      universityName: unverifiedUniversityName,
      adapterKey: `unverified_adapter_${RUN}`,
      isActive: true,
    })
    .returning({ id: portalUniversitiesTable.id });
  unverifiedPortalUniId = unverifiedPortal.id;
  const [unverifiedApplication] = await db
    .insert(applicationsTable)
    .values({
      studentId,
      universityName: unverifiedUniversityName,
      stage: "offer",
    })
    .returning({ id: applicationsTable.id });
  appG = unverifiedApplication.id;

  await seedVerifiedPortalPartnerFixture({
    portalUniversityId: portalUniId,
    universityKey: UNI_KEY,
    universityName: UNI_NAME,
    adapterKey: `adapter_${RUN}`,
  });

  assert.ok(studentId && portalUniId && unverifiedPortalUniId && appA && appB && appC && appD && appE && appF && appG);
});

test("MSUB0b: manual fan-out metadata marks direct and aggregator rows as manual", () => {
  assert.deepEqual(buildManualFanOutMeta(), { manual: true });
  assert.deepEqual(
    buildManualFanOutMeta(
      { universityKey: "sit", adapterKey: "sit" },
      { crmUniversityId: 42, universityName: "Member University" },
    ),
    {
      manual: true,
      targetCatalogUniversityId: 42,
      targetUniversityName: "Member University",
      routedViaAggregator: "sit",
    },
  );
});

// ---------------------------------------------------------------------------
// MSUB1 — eligible-applications finds the seeded app
// ---------------------------------------------------------------------------
test("MSUB1: GET eligible-applications finds seeded app via q search", async () => {
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "GET", `/api/portal-automation/eligible-applications?q=Manual${RUN}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids = res.body.data.map((r: any) => r.id);
    assert.ok(ids.includes(appA), "appA should be eligible");
    assert.ok(!ids.includes(appD), "deleted appD must not be eligible");
    const row = res.body.data.find((r: any) => r.id === appA);
    assert.equal(row.portalUniversityKey, UNI_KEY);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB2 — single dry submit
// ---------------------------------------------------------------------------
test("MSUB2: POST submit single dry → 201, queued mode=dry", async () => {
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/submit", {
      applicationIds: [appA],
      mode: "dry",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.queued.length, 1);
    assert.equal(res.body.queued[0].applicationId, appA);

    const [row] = await db
      .select()
      .from(portalSubmissionsTable)
      .where(eq(portalSubmissionsTable.applicationId, appA));
    assert.ok(row, "submission row should exist");
    assert.equal(row.mode, "dry");
    assert.equal(row.status, "queued");
    assert.equal(row.universityKey, UNI_KEY, "universityKey resolved from app's own record");
    assert.equal(row.enqueuedBy, authUserId);
    assert.equal((row.meta as Record<string, unknown> | null)?.manual, true);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB3 — duplicate guard
// ---------------------------------------------------------------------------
test("MSUB3: re-submit same app → skipped ALREADY_QUEUED, no new row", async () => {
  const server = await listen(buildApp());
  try {
    const before = await db.select().from(portalSubmissionsTable).where(eq(portalSubmissionsTable.applicationId, appA));
    const res = await sendReq(server, "POST", "/api/portal-automation/submit", {
      applicationIds: [appA],
      mode: "dry",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.queued.length, 0);
    assert.equal(res.body.skipped.length, 1);
    assert.equal(res.body.skipped[0].reason, "ALREADY_QUEUED");

    const after2 = await db.select().from(portalSubmissionsTable).where(eq(portalSubmissionsTable.applicationId, appA));
    assert.equal(after2.length, before.length, "no new row should be inserted");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB4 — bulk: appB queued, appA skipped
// ---------------------------------------------------------------------------
test("MSUB4: bulk submit [appB, appA] → appB queued, appA skipped", async () => {
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/submit", {
      applicationIds: [appB, appA],
      mode: "dry",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.queued.map((q: any) => q.applicationId), [appB]);
    assert.equal(res.body.skipped.find((s: any) => s.applicationId === appA)?.reason, "ALREADY_QUEUED");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB5 — real without confirm → 422
// ---------------------------------------------------------------------------
test("MSUB5: real mode without confirm → 422 CONFIRM_REQUIRED", async () => {
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/submit", {
      applicationIds: [appC],
      mode: "real",
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error, "CONFIRM_REQUIRED");

    const rows = await db.select().from(portalSubmissionsTable).where(eq(portalSubmissionsTable.applicationId, appC));
    assert.equal(rows.length, 0, "nothing should be queued without confirm");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB6 — real with confirm → 201, mode=real
// ---------------------------------------------------------------------------
test("MSUB6: real mode with confirm → 201, mode=real", async () => {
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/submit", {
      applicationIds: [appC],
      mode: "real",
      confirm: true,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.queued.length, 1);

    const [row] = await db.select().from(portalSubmissionsTable).where(eq(portalSubmissionsTable.applicationId, appC));
    assert.equal(row.mode, "real");
    assert.equal(row.status, "queued");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB7 — unknown id single → 404
// ---------------------------------------------------------------------------
test("MSUB7: unknown application id (single) → 404", async () => {
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/submit", {
      applicationIds: [999999999],
      mode: "dry",
    });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error, "NOT_FOUND");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB8 — deleted app: single → 404, bulk → skipped NOT_FOUND
// ---------------------------------------------------------------------------
test("MSUB8: deleted app single → 404; bulk → skipped NOT_FOUND", async () => {
  const server = await listen(buildApp());
  try {
    const single = await sendReq(server, "POST", "/api/portal-automation/submit", {
      applicationIds: [appD],
      mode: "dry",
    });
    assert.equal(single.status, 404, JSON.stringify(single.body));

    const bulk = await sendReq(server, "POST", "/api/portal-automation/submit", {
      applicationIds: [appD, appB],
      mode: "dry",
    });
    // appB already queued in MSUB4, appD deleted → both skipped
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    assert.equal(bulk.body.skipped.find((s: any) => s.applicationId === appD)?.reason, "NOT_FOUND");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB9 — RBAC: non-admin role → 403
// ---------------------------------------------------------------------------
test("MSUB9: non-admin role → 403", async () => {
  const server = await listen(buildApp("student", 2));
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/submit", {
      applicationIds: [appA],
      mode: "dry",
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB11 — single app with no matching portal university → 400 NO_PORTAL
// ---------------------------------------------------------------------------
test("MSUB11: single app w/ no portal mapping → 400 NO_PORTAL", async () => {
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/submit", {
      applicationIds: [appE],
      mode: "dry",
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "NO_PORTAL");

    // It must also be absent from the eligible list (innerJoin to active portal).
    const elig = await sendReq(server, "GET", `/api/portal-automation/eligible-applications?q=Manual${RUN}`);
    assert.ok(!elig.body.data.some((r: any) => r.id === appE), "no-portal app must not be eligible");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB12 — eligible-applications honors stage + universityKey filters
// ---------------------------------------------------------------------------
test("MSUB12: eligible-applications stage + universityKey filters", async () => {
  const server = await listen(buildApp());
  try {
    // Matching stage + universityKey → seeded apps appear.
    const ok = await sendReq(
      server,
      "GET",
      `/api/portal-automation/eligible-applications?stage=offer&universityKey=${UNI_KEY}&q=Manual${RUN}`,
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.data.some((r: any) => r.id === appA), "appA matches stage+key filter");
    assert.ok(ok.body.data.every((r: any) => r.portalUniversityKey === UNI_KEY), "all rows match the key filter");

    // Non-matching stage → seeded offer-stage apps excluded.
    const wrongStage = await sendReq(
      server,
      "GET",
      `/api/portal-automation/eligible-applications?stage=visa&q=Manual${RUN}`,
    );
    assert.equal(wrongStage.status, 200);
    assert.ok(!wrongStage.body.data.some((r: any) => r.id === appA), "wrong stage excludes appA");

    // Non-matching universityKey → excluded.
    const wrongKey = await sendReq(
      server,
      "GET",
      `/api/portal-automation/eligible-applications?universityKey=__none__&q=Manual${RUN}`,
    );
    assert.equal(wrongKey.status, 200);
    assert.equal(wrongKey.body.data.length, 0, "unknown key returns nothing");
  } finally {
    await close(server);
  }
});

test("MSUB12b: mapped but unverified partner fails closed with an explicit 409", async () => {
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/submit", {
      applicationIds: [appG],
      mode: "dry",
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, "PARTNER_VERIFICATION_REQUIRED");
    const rows = await db
      .select()
      .from(portalSubmissionsTable)
      .where(eq(portalSubmissionsTable.applicationId, appG));
    assert.equal(rows.length, 0, "verification gate must run before queue insertion");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB14 — concurrent idempotency across API requests
// ---------------------------------------------------------------------------
test("MSUB14: concurrent submits create one row and reuse it", async () => {
  const server = await listen(buildApp());
  try {
    const [first, second] = await Promise.all([
      sendReq(server, "POST", "/api/portal-automation/submit", {
        applicationIds: [appF],
        mode: "dry",
      }),
      sendReq(server, "POST", "/api/portal-automation/submit", {
        applicationIds: [appF],
        mode: "dry",
      }),
    ]);
    assert.deepEqual(
      [first.status, second.status].sort((a, b) => a - b),
      [200, 201],
    );

    const inserted = [first, second].find((res) => res.status === 201);
    const reused = [first, second].find((res) => res.status === 200);
    assert.equal(inserted?.body.queued.length, 1);
    assert.equal(reused?.body.skipped[0]?.reason, "ALREADY_QUEUED");
    assert.equal(
      reused?.body.skipped[0]?.submissionId,
      inserted?.body.queued[0]?.submissionId,
    );

    const rows = await db
      .select()
      .from(portalSubmissionsTable)
      .where(eq(portalSubmissionsTable.applicationId, appF));
    assert.equal(rows.length, 1, "advisory lock prevents a duplicate insert");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// MSUB13 — rate limit: burst of submits → 429
// NOTE: registered LAST on purpose. The rate limiter is module-level/in-memory
// and persists across tests in this process, so the burst (which saturates its
// user) must run after every other /submit test to avoid cross-test bleed.
// ---------------------------------------------------------------------------
test("MSUB13: burst submits → 429", async () => {
  // Use an existing user id so the fire-and-forget audit insert doesn't violate
  // the audit_logs → users FK (which would only produce harmless stderr noise).
  const server = await listen(buildApp("super_admin", rlUserId));
  try {
    let got429 = false;
    for (let i = 0; i < 25; i++) {
      const res = await sendReq(server, "POST", "/api/portal-automation/submit", {
        applicationIds: [appA],
        mode: "dry",
      });
      if (res.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, "expected a 429 within the burst");
  } finally {
    await close(server);
  }
});
