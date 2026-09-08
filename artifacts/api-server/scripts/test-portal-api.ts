/**
 * test-portal-api.ts — Portal REST API acceptance tests
 *
 * Coverage (complementary to test-portal-automation.ts which tests T1–T7):
 *
 *  TPA1: enqueue dry — POST /applications/:appId/portal-submissions → 201
 *  TPA2: real mode without confirm → 422 CONFIRM_REQUIRED
 *  TPA3: RBAC — agent role cannot enqueue → 403
 *  TPA4: credentials PUT → { ok: true } and invalidates verification
 *  TPA5: GET /university-portals hides an invalidated partner; current
 *        version-bound verification makes it selectable again
 *        response body must NOT contain "password" or "username" plaintext keys
 *  TPA6: DELETE /university-portals/:key/credentials → { ok: true }
 *  TPA7: GET /university-portals after delete → hasCredentials: false
 *
 * Run:
 *   pnpm --filter @workspace/api-server test:portal
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  applicationsTable,
  studentsTable,
  portalUniversitiesTable,
  portalSubmissionsTable,
  portalCredentialsTable,
  usersTable,
} from "@workspace/db";
import portalAutomationRouter from "../src/routes/portalAutomation.js";
import portalMgmtRouter from "../src/routes/portalMgmt.js";
import {
  assertDisposablePortalVerificationTarget,
  seedCurrentPortalPartnerReceipts,
  seedVerifiedPortalPartnerFixture,
} from "./portalVerificationFixture.js";

assertDisposablePortalVerificationTarget();

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------
const cleanupSubmissionIds: number[] = [];
const cleanupStudentIds:    number[] = [];
const cleanupAppIds:        number[] = [];
const cleanupUniIds:        number[] = [];
const cleanupCredKeys:      string[] = [];
let cleanupUserId: number | null = null;

const RUN = `tpa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

after(async () => {
  for (const id of cleanupSubmissionIds) {
    await db.update(portalSubmissionsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(portalSubmissionsTable.id, id), isNull(portalSubmissionsTable.deletedAt)))
      .catch(() => {});
  }
  for (const key of cleanupCredKeys) {
    await db.update(portalCredentialsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(portalCredentialsTable.portalKey, key), isNull(portalCredentialsTable.deletedAt)))
      .catch(() => {});
  }
  for (const id of cleanupUniIds) {
    await db.update(portalUniversitiesTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(portalUniversitiesTable.id, id), isNull(portalUniversitiesTable.deletedAt)))
      .catch(() => {});
  }
  for (const id of cleanupAppIds) {
    await db.update(applicationsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(applicationsTable.id, id), isNull(applicationsTable.deletedAt)))
      .catch(() => {});
  }
  for (const id of cleanupStudentIds) {
    await db.update(studentsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(studentsTable.id, id), isNull(studentsTable.deletedAt)))
      .catch(() => {});
  }
  if (cleanupUserId !== null) {
    await db.delete(usersTable)
      .where(eq(usersTable.id, cleanupUserId))
      .catch(() => {});
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Mutable user — injected per request (no real auth stack needed)
// ---------------------------------------------------------------------------
let currentUser: { id: number; role: string; isActive: boolean; emailVerified: boolean } = {
  id: 1,
  role: "super_admin",
  isActive: true,
  emailVerified: true,
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: typeof currentUser }).user = { ...currentUser };
    next();
  });
  app.use("/api", portalAutomationRouter);
  app.use("/api", portalMgmtRouter);
  return app;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function listen(app: Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer(app as unknown as http.RequestListener);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function close(srv: http.Server): Promise<void> {
  return new Promise((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())));
}

async function req(
  srv: http.Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const addr = srv.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-csrf-token": "test" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
async function createTestStudentAndApp(): Promise<{ studentId: number; appId: number; uniKey: string }> {
  const uniKey = `tpa_uni_${RUN}`;

  const [student] = await db.insert(studentsTable).values({
    firstName: "TPA",
    lastName: RUN,
    email: `tpa_${RUN}@example.test`,
    isActive: true,
  }).returning({ id: studentsTable.id });
  cleanupStudentIds.push(student.id);

  const [app] = await db.insert(applicationsTable).values({
    studentId: student.id,
    universityKey: uniKey,
    universityName: "TPA Test University",
    programKey: "cs",
    programName: "Computer Science",
    status: "applied",
    isActive: true,
  }).returning({ id: applicationsTable.id });
  cleanupAppIds.push(app.id);

  return { studentId: student.id, appId: app.id, uniKey };
}

async function createTestPortalUniversity(): Promise<{ id: number; universityKey: string; adapterKey: string }> {
  const key = `tpa_portal_${RUN}`;
  const adapterKey = `tpa_adapter_${RUN}`;
  const [uni] = await db.insert(portalUniversitiesTable).values({
    universityKey: key,
    universityName: "TPA Portal University",
    adapterKey,
    isActive: true,
  }).returning({ id: portalUniversitiesTable.id, universityKey: portalUniversitiesTable.universityKey, adapterKey: portalUniversitiesTable.adapterKey });
  cleanupUniIds.push(uni.id);
  cleanupCredKeys.push(adapterKey);
  return uni;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
let srv: http.Server;
let testAppId: number;
let portalUniId: number;
let portalUniKey: string;
let portalAdapterKey: string;

test("setup", async () => {
  const [user] = await db.insert(usersTable).values({
    email: `${RUN}.admin@example.test`,
    firstName: "Portal",
    lastName: "API Admin",
    role: "super_admin",
    isActive: true,
    emailVerified: true,
  }).returning({ id: usersTable.id });
  cleanupUserId = user.id;
  currentUser.id = user.id;

  srv = await listen(buildApp());
  const fixture = await createTestStudentAndApp();
  testAppId = fixture.appId;

  const portalUni = await createTestPortalUniversity();
  portalUniId = portalUni.id;
  portalUniKey = portalUni.universityKey;
  portalAdapterKey = portalUni.adapterKey;

  await seedVerifiedPortalPartnerFixture({
    portalUniversityId: portalUniId,
    universityKey: portalUniKey,
    universityName: "TPA Portal University",
    adapterKey: portalAdapterKey,
  });

  currentUser = { id: user.id, role: "super_admin", isActive: true, emailVerified: true };
});

// TPA1 — enqueue dry → 201
test("TPA1: enqueue dry-mode → 201 with status=queued", async () => {
  const r = await req(srv, "POST", `/api/applications/${testAppId}/portal-submissions`, {
    universityKey: portalAdapterKey,
    mode: "dry",
  });
  if (r.status === 201) {
    const b = r.body as { id: number };
    cleanupSubmissionIds.push(b.id);
  }
  assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  const body = r.body as { mode: string; status: string; universityKey: string; adapterKey: string };
  assert.equal(body.mode, "dry");
  assert.equal(body.status, "queued");
  assert.equal(body.universityKey, portalUniKey, "adapter alias must be stored as the canonical portal key");
  assert.equal(body.adapterKey, portalAdapterKey);
});

// TPA2 — real mode without confirm → 422
test("TPA2: real mode without confirm → 422 CONFIRM_REQUIRED", async () => {
  const r = await req(srv, "POST", `/api/applications/${testAppId}/portal-submissions`, {
    universityKey: portalUniKey,
    mode: "real",
  });
  assert.equal(r.status, 422, `Expected 422, got ${r.status}: ${JSON.stringify(r.body)}`);
  const body = r.body as { error: string };
  assert.equal(body.error, "CONFIRM_REQUIRED");
});

// TPA3 — agent RBAC → 403
test("TPA3: agent role cannot enqueue → 403", async () => {
  const savedUser = { ...currentUser };
  currentUser = { id: 999, role: "agent", isActive: true, emailVerified: true };
  try {
    const r = await req(srv, "POST", `/api/applications/${testAppId}/portal-submissions`, {
      universityKey: portalUniKey,
      mode: "dry",
    });
    assert.equal(r.status, 403, `Expected 403 for agent role, got ${r.status}: ${JSON.stringify(r.body)}`);
  } finally {
    currentUser = savedUser;
  }
});

// TPA4 — credentials PUT → { ok: true }
test("TPA4: credential mutation succeeds without plaintext and invalidates execution state", async () => {
  const r = await req(srv, "PUT", `/api/portal-universities/${portalUniKey}/credentials`, {
    username: "portal_user",
    password: "portal_secret_pw",
  });
  assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  const body = r.body as Record<string, unknown>;
  assert.equal(body.ok, true);

  // Plaintext password MUST NOT appear in response
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("portal_secret_pw"), "Response must not leak password");
  assert.ok(!raw.includes("portal_user"), "Response must not leak username");

  const afterMutation = await req(srv, "GET", "/api/university-portals");
  assert.equal(afterMutation.status, 200);
  const hidden = (afterMutation.body as Array<{ key: string }>).find((p) => p.key === portalUniKey);
  assert.equal(hidden, undefined, "Credential changes must hide the partner until it is re-verified");
});

// TPA5 — current verification restores the canonical selectable portal.
test("TPA5: current verification restores a credential-ready portal", async () => {
  await seedCurrentPortalPartnerReceipts({
    portalUniversityId: portalUniId,
    universityKey: portalUniKey,
    universityName: "TPA Portal University",
    adapterKey: portalAdapterKey,
  });
  await db.update(portalUniversitiesTable)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(portalUniversitiesTable.id, portalUniId));

  const r = await req(srv, "GET", "/api/university-portals");
  assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  const portals = r.body as Array<{
    key: string;
    adapterKey: string;
    hasCredentials: boolean;
    dryRunReady: boolean;
    realRunReady: boolean;
  }>;
  assert.ok(Array.isArray(portals), "Should return array");

  const target = portals.find((p) => p.key === portalUniKey);
  assert.ok(target, `Portal with canonical key "${portalUniKey}" not found in list`);
  assert.equal(target!.adapterKey, portalAdapterKey);
  assert.equal(target!.hasCredentials, true, "hasCredentials should be true after PUT");
  assert.equal(target!.dryRunReady, true);
  assert.equal(target!.realRunReady, true);

  // No plaintext secrets in any portal entry
  const raw = JSON.stringify(portals);
  assert.ok(!raw.includes("portal_secret_pw"), "List must not leak password");
  assert.ok(!raw.includes("portal_user"), "List must not leak username");
  assert.ok(!("password" in target!), "Portal entry must not have 'password' key");
  assert.ok(!("username" in target!), "Portal entry must not have 'username' key");
});

// TPA6 — DELETE credentials → { ok: true }
test("TPA6: DELETE /portal-universities/:key/credentials → { ok: true }", async () => {
  const r = await req(srv, "DELETE", `/api/portal-universities/${portalUniKey}/credentials`);
  assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  const body = r.body as Record<string, unknown>;
  assert.equal(body.ok, true);
});

// TPA7 — GET /university-portals → portal absent after credential DELETE
// The endpoint only returns credential-ready portals (Submit dropdown intent).
// After DELETE, the portal should no longer appear in the list.
test("TPA7: GET /university-portals → portal absent from list after credential DELETE", async () => {
  const r = await req(srv, "GET", "/api/university-portals");
  assert.equal(r.status, 200);
  const portals = r.body as Array<{ key: string; hasCredentials: boolean }>;
  const target = portals.find((p) => p.key === portalUniKey);
  assert.equal(target, undefined, `Portal "${portalUniKey}" should not appear in list after DELETE (no credentials)`);
});

test("teardown", async () => {
  await close(srv);
});
