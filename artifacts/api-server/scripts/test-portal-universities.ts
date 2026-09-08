/**
 * Portal Universities Management API — regression tests.
 *
 * U1  POST create → 201; list GET shows the row with hasCredentials=false
 * U2  PATCH /:id updates universityName + adapterKey + defaults; GET reflects it
 * U3  Credentials lifecycle: PUT → hasCredentials=true → DELETE → false;
 *     GET never leaks a plaintext password field
 * U4  RBAC — non-staff role (student) → 403 on list/create/update/delete;
 *     credentials routes are ADMIN-only → staff role → 403
 * U5  unknown id → 404 on PATCH and DELETE
 * U6  duplicate universityKey → 409 DUPLICATE_KEY on POST
 * U7  soft DELETE → 200; the row disappears from the list
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:portal-universities
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  applicationsTable,
  portalUniversitiesTable,
  portalCredentialsTable,
  portalAdaptersTable,
  portalSubmissionsTable,
  studentsTable,
  usersTable,
} from "@workspace/db";
import { invalidateDeclarativeAdapterCache } from "@workspace/portal-adapters";
import portalMgmtRouter from "../src/routes/portalMgmt.js";

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------
const RUN_ID = `pu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const TEST_KEY = `test_uni_${RUN_ID}`;
const TEST_ADAPTER = `test_adapter_${RUN_ID}`;
const ALT_ADAPTER = `alt_adapter_${RUN_ID}`;
const createdKeys: string[] = [];
const credKeys: string[] = [TEST_KEY, TEST_ADAPTER, ALT_ADAPTER];
const cleanupSubmissionIds: number[] = [];
const cleanupApplicationIds: number[] = [];
const cleanupStudentIds: number[] = [];
let fixtureUserId = 0;

const ADMIN = { id: 0, role: "super_admin", isActive: true, emailVerified: true };

function adapterValues(key: string, matchName: string) {
  return {
    key,
    label: `${matchName} adapter`,
    baseUrl: "https://portal.example.com/login",
    matchNames: matchName,
    kind: "declarative" as const,
    configJson: {
      credentials: {
        userSelector: "#email",
        passSelector: "#password",
        submitSelector: "button[type=submit]",
      },
      steps: [{ type: "navigate", url: "https://portal.example.com/apply" }],
      submitCheck: { successText: "ok" },
    },
    isActive: true,
  };
}

before(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_ID}@portal-universities.test`,
      role: "super_admin",
      isActive: true,
      emailVerified: true,
    })
    .returning({ id: usersTable.id });
  fixtureUserId = user.id;
  ADMIN.id = user.id;
  currentUser = { ...ADMIN };

  await db.insert(portalAdaptersTable).values([
    adapterValues(TEST_ADAPTER, `portal test ${RUN_ID}`),
    adapterValues(ALT_ADAPTER, `alternate portal ${RUN_ID}`),
  ]);
  invalidateDeclarativeAdapterCache();
});

after(async () => {
  if (cleanupSubmissionIds.length) {
    await db.delete(portalSubmissionsTable).where(inArray(portalSubmissionsTable.id, cleanupSubmissionIds)).catch(() => {});
  }
  if (cleanupApplicationIds.length) {
    await db.delete(applicationsTable).where(inArray(applicationsTable.id, cleanupApplicationIds)).catch(() => {});
  }
  if (cleanupStudentIds.length) {
    await db.delete(studentsTable).where(inArray(studentsTable.id, cleanupStudentIds)).catch(() => {});
  }
  if (createdKeys.length) {
    await db
      .delete(portalUniversitiesTable)
      .where(inArray(portalUniversitiesTable.universityKey, createdKeys))
      .catch(() => {});
  }
  await db
    .delete(portalCredentialsTable)
    .where(inArray(portalCredentialsTable.portalKey, credKeys))
    .catch(() => {});
  await db
    .delete(portalAdaptersTable)
    .where(inArray(portalAdaptersTable.key, [TEST_ADAPTER, ALT_ADAPTER]))
    .catch(() => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (fixtureUserId) {
    await db.delete(usersTable).where(eq(usersTable.id, fixtureUserId)).catch(() => {});
  }
  invalidateDeclarativeAdapterCache();
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Auth stub — role is swapped per test via currentUser
// ---------------------------------------------------------------------------
let currentUser: { id: number; role: string; isActive: boolean; emailVerified?: boolean } = {
  ...ADMIN,
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof currentUser }).user = { ...currentUser };
    if (!("cookies" in req)) (req as unknown as { cookies: Record<string, string> }).cookies = {};
    next();
  });
  app.use("/api", portalMgmtRouter);
  return app;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function sendReq(
  server: http.Server,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
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

async function findInList(server: http.Server, key: string): Promise<any | undefined> {
  const res = await sendReq(server, "GET", `/api/portal-universities?search=${encodeURIComponent(key)}`);
  assert.equal(res.status, 200, `list expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body.data), "list response must contain a data array");
  return res.body.data.find((r: { universityKey: string }) => r.universityKey === key);
}

// A holder for the id created in U1 and reused by later tests.
let createdId = 0;

// ---------------------------------------------------------------------------
// U1 — POST create → 201; list reflects it with hasCredentials=false
// ---------------------------------------------------------------------------
test("U1: POST creates a university and it appears in the list", async () => {
  currentUser = { ...ADMIN };
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-universities", {
      universityKey: TEST_KEY,
      universityName: `Portal Test ${RUN_ID}`,
      isActive: false,
    });
    assert.equal(res.status, 201, `Expected 201 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.universityKey, TEST_KEY);
    assert.equal(res.body.adapterKey, TEST_ADAPTER, "adapter must be resolved from the university name");
    assert.ok(typeof res.body.id === "number", "created row must expose a numeric id");
    createdId = res.body.id;
    createdKeys.push(TEST_KEY);

    const row = await findInList(server, TEST_KEY);
    assert.ok(row, "created university must appear in the list");
    assert.equal(row.hasCredentials, false, "fresh university has no credentials");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("U1b: POST fails closed when no registered adapter matches", async () => {
  currentUser = { ...ADMIN };
  const server = await listen(buildApp());
  try {
    const missingKey = `no_adapter_${RUN_ID}`;
    const res = await sendReq(server, "POST", "/api/portal-universities", {
      universityKey: missingKey,
      universityName: `Unknown Portal ${RUN_ID}`,
      isActive: false,
    });
    assert.equal(res.status, 422, `Expected 422 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "NO_MATCHING_ADAPTER");
    assert.equal(await findInList(server, missingKey), undefined, "failed setup must not create a row");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// U2 — PATCH /:id updates name + adapter + defaults
// ---------------------------------------------------------------------------
test("U2: PATCH updates universityName, adapterKey and defaults", async () => {
  currentUser = { ...ADMIN };
  const server = await listen(buildApp());
  try {
    const newName = `Renamed University ${RUN_ID}`;
    const defaults = { intakeType: "fall", semester: "2026-fall", degreeLevel: "master" };
    const res = await sendReq(server, "PATCH", `/api/portal-universities/${createdId}`, {
      universityName: newName,
      adapterKey: ALT_ADAPTER,
      defaults,
    });
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.universityName, newName);
    assert.equal(res.body.adapterKey, ALT_ADAPTER);
    assert.deepEqual(res.body.defaults, defaults);

    const row = await findInList(server, TEST_KEY);
    assert.ok(row, "row must still be present after update");
    assert.equal(row.universityName, newName);
    assert.equal(row.adapterKey, ALT_ADAPTER);
    assert.deepEqual(row.defaults, defaults);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// U3 — Credentials lifecycle + no plaintext leak
// ---------------------------------------------------------------------------
test("U3: credentials set→hasCredentials→clear, never leaks plaintext", async () => {
  currentUser = { ...ADMIN };
  const server = await listen(buildApp());
  try {
    const put = await sendReq(server, "PUT", `/api/portal-universities/${TEST_KEY}/credentials`, {
      username: "portal-user@example.com",
      password: "s3cr3t-should-never-be-returned",
    });
    assert.equal(put.status, 200, `Expected 200 got ${put.status}: ${JSON.stringify(put.body)}`);
    assert.equal(put.body.ok, true);
    assert.equal(put.body.safetyReset.partners, 1);
    assert.ok(!("password" in put.body), "PUT response must not echo the password");

    const row = await findInList(server, TEST_KEY);
    assert.ok(row, "row must be present");
    assert.equal(row.hasCredentials, true, "credentials should be detected after PUT");
    // GET must never expose plaintext secrets anywhere in the row.
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes("s3cr3t-should-never-be-returned"), "list row must not leak the password");
    assert.ok(!("password" in row), "list row must not contain a password field");

    await db
      .update(portalUniversitiesTable)
      .set({ isActive: true, autoProcess: true, fanOutMode: "auto" })
      .where(eq(portalUniversitiesTable.id, createdId));

    const del = await sendReq(server, "DELETE", `/api/portal-universities/${TEST_KEY}/credentials`);
    assert.equal(del.status, 200, `Expected 200 got ${del.status}: ${JSON.stringify(del.body)}`);
    assert.equal(del.body.ok, true);
    assert.equal(del.body.safetyReset.partners, 1);

    const after2 = await findInList(server, TEST_KEY);
    assert.ok(after2, "row must remain after clearing credentials");
    assert.equal(after2.hasCredentials, false, "credentials should be gone after DELETE");
    assert.equal(after2.isActive, false, "credential removal must force the partner inactive");
    assert.equal(after2.autoProcess, false, "credential removal must force auto-process off");
    assert.equal(after2.fanOutMode, "off", "credential removal must force fan-out off");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("U3b: credential mutation is rejected while an adapter submission is running", async () => {
  currentUser = { ...ADMIN };
  const server = await listen(buildApp());
  try {
    const put = await sendReq(server, "PUT", `/api/portal-universities/${TEST_KEY}/credentials`, {
      username: "portal-user@example.com",
      password: "running-test-secret",
    });
    assert.equal(put.status, 200);

    const [student] = await db
      .insert(studentsTable)
      .values({ firstName: `Credential ${RUN_ID}`, lastName: "Safety" })
      .returning({ id: studentsTable.id });
    cleanupStudentIds.push(student.id);
    const [application] = await db
      .insert(applicationsTable)
      .values({ studentId: student.id })
      .returning({ id: applicationsTable.id });
    cleanupApplicationIds.push(application.id);
    const [submission] = await db
      .insert(portalSubmissionsTable)
      .values({
        applicationId: application.id,
        studentId: student.id,
        universityKey: TEST_KEY,
        universityName: `Credential Safety ${RUN_ID}`,
        adapterKey: ALT_ADAPTER,
        mode: "dry",
        status: "running",
        lockedAt: new Date(),
        lockedBy: `credential-test-${RUN_ID}`,
      })
      .returning({ id: portalSubmissionsTable.id });
    cleanupSubmissionIds.push(submission.id);

    const blocked = await sendReq(server, "DELETE", `/api/portal-universities/${TEST_KEY}/credentials`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "CREDENTIAL_CHANGE_IN_FLIGHT");
    const row = await findInList(server, TEST_KEY);
    assert.equal(row.hasCredentials, true, "rejected removal must preserve credentials");

    const blockedRouting = await sendReq(server, "PATCH", `/api/portal-universities/${createdId}`, {
      defaults: { intakeType: "spring" },
    });
    assert.equal(blockedRouting.status, 409);
    assert.equal(blockedRouting.body.error, "ROUTING_CHANGE_IN_FLIGHT");

    await db
      .update(portalSubmissionsTable)
      .set({ status: "canceled", lockedAt: null, lockedBy: null })
      .where(eq(portalSubmissionsTable.id, submission.id));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// U4 — RBAC
// ---------------------------------------------------------------------------
test("U4: non-staff is forbidden; credentials routes are admin-only", async () => {
  const server = await listen(buildApp());
  try {
    // student has neither STAFF nor ADMIN — blocked on every CRUD route.
    currentUser = { id: 9, role: "student", isActive: true, emailVerified: true };
    const list = await sendReq(server, "GET", "/api/portal-universities");
    assert.equal(list.status, 403, `list: expected 403 got ${list.status}`);

    const create = await sendReq(server, "POST", "/api/portal-universities", {
      universityKey: `rbac_${RUN_ID}`,
      universityName: "x",
      adapterKey: "y",
    });
    assert.equal(create.status, 403, `create: expected 403 got ${create.status}`);

    const patch = await sendReq(server, "PATCH", `/api/portal-universities/${createdId}`, {
      universityName: "x",
    });
    assert.equal(patch.status, 403, `patch: expected 403 got ${patch.status}`);

    const del = await sendReq(server, "DELETE", `/api/portal-universities/${createdId}`);
    assert.equal(del.status, 403, `delete: expected 403 got ${del.status}`);

    // staff CAN do CRUD but credentials are ADMIN-only → 403.
    currentUser = { id: 10, role: "staff", isActive: true, emailVerified: true };
    const credPut = await sendReq(server, "PUT", `/api/portal-universities/${TEST_KEY}/credentials`, {
      username: "u",
      password: "p",
    });
    assert.equal(credPut.status, 403, `cred PUT: expected 403 got ${credPut.status}`);

    const credDel = await sendReq(server, "DELETE", `/api/portal-universities/${TEST_KEY}/credentials`);
    assert.equal(credDel.status, 403, `cred DELETE: expected 403 got ${credDel.status}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// U5 — unknown id → 404
// ---------------------------------------------------------------------------
test("U5: unknown id returns 404 on PATCH and DELETE", async () => {
  currentUser = { ...ADMIN };
  const server = await listen(buildApp());
  try {
    const missing = 2147483000;
    const patch = await sendReq(server, "PATCH", `/api/portal-universities/${missing}`, {
      universityName: "x",
    });
    assert.equal(patch.status, 404, `patch: expected 404 got ${patch.status}`);
    assert.equal(patch.body.error, "NOT_FOUND");

    const del = await sendReq(server, "DELETE", `/api/portal-universities/${missing}`);
    assert.equal(del.status, 404, `delete: expected 404 got ${del.status}`);
    assert.equal(del.body.error, "NOT_FOUND");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// U6 — duplicate universityKey → 409 DUPLICATE_KEY
// ---------------------------------------------------------------------------
test("U6: duplicate universityKey is rejected with 409", async () => {
  currentUser = { ...ADMIN };
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-universities", {
      universityKey: TEST_KEY,
      universityName: "dupe",
      adapterKey: "whatever",
    });
    assert.equal(res.status, 409, `Expected 409 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "DUPLICATE_KEY");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// U7 — soft DELETE removes the row from the list
// ---------------------------------------------------------------------------
test("U7: soft DELETE removes the university from the list", async () => {
  currentUser = { ...ADMIN };
  const server = await listen(buildApp());
  try {
    const del = await sendReq(server, "DELETE", `/api/portal-universities/${createdId}`);
    assert.equal(del.status, 200, `Expected 200 got ${del.status}: ${JSON.stringify(del.body)}`);

    const row = await findInList(server, TEST_KEY);
    assert.equal(row, undefined, "soft-deleted university must not appear in the list");

    // Deleting again → 404 (already gone).
    const again = await sendReq(server, "DELETE", `/api/portal-universities/${createdId}`);
    assert.equal(again.status, 404, `re-delete: expected 404 got ${again.status}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
