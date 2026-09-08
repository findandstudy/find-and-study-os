/**
 * Portal Program Fallbacks API — regression tests (Phase 4).
 *
 * F1  POST create → 201, returns serialized shape (defaults autoSubmit/enabled true)
 * F2  GET list by universityKey → includes the created rule
 * F3  POST duplicate (same universityKey + sourceProgramId) → 409 DUPLICATE_SOURCE
 * F4  PATCH reorder + toggle → 200, reflects new fallbackProgramIds/enabled
 * F5  RBAC — non-admin role (agent) → 403 on GET/POST/PATCH/DELETE
 * F6  DELETE soft-delete → 200, then GET no longer lists the rule
 * F7  Concurrent same-key POSTs → exactly one 201 and one controlled 409
 *
 * Program-name resolution hits the catalog `programs` table; ids without a
 * matching program simply resolve to null names (covered, not asserted).
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx scripts/test-portal-fallbacks.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  portalProgramFallbacksTable,
  usersTable,
} from "@workspace/db";
import fallbacksRouter from "../src/routes/portalProgramFallbacks.js";

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------
const RUN_ID = `pf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const TEST_UNI_KEY = `test_uni_${RUN_ID}`;
const SOURCE_ID = 900000 + Math.floor(Math.random() * 90000);
let testUserId: number | null = null;

before(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_ID}.admin@example.test`,
      firstName: "Portal",
      lastName: "Fallback Admin",
      role: "super_admin",
      isActive: true,
      emailVerified: true,
    })
    .returning({ id: usersTable.id });
  testUserId = user.id;
  currentUser.id = user.id;
});

after(async () => {
  await db
    .delete(portalProgramFallbacksTable)
    .where(eq(portalProgramFallbacksTable.universityKey, TEST_UNI_KEY))
    .catch(() => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (testUserId !== null) {
    await db
      .delete(auditLogsTable)
      .where(eq(auditLogsTable.userId, testUserId))
      .catch(() => {});
    await db.delete(usersTable).where(eq(usersTable.id, testUserId)).catch(() => {});
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Auth stub — role is swapped per test via currentUser
// ---------------------------------------------------------------------------
let currentUser: {
  id: number;
  role: string;
  isActive: boolean;
  emailVerified?: boolean;
} = { id: 0, role: "super_admin", isActive: true, emailVerified: true };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { ...currentUser };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", fallbacksRouter);
  return app;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function sendReq(
  server: http.Server,
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
          ...(json !== undefined
            ? { "Content-Length": Buffer.byteLength(json) }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
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

const admin = () => {
  currentUser = {
    id: testUserId ?? 0,
    role: "super_admin",
    isActive: true,
    emailVerified: true,
  };
};
const agent = () => {
  currentUser = { id: 2, role: "agent", isActive: true, emailVerified: true };
};

let createdId = 0;

// ---------------------------------------------------------------------------
// F1 — POST create
// ---------------------------------------------------------------------------
test("F1: POST create returns 201 with default flags", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-program-fallbacks", {
      universityKey: TEST_UNI_KEY,
      sourceProgramId: SOURCE_ID,
      fallbackProgramIds: [111, 222],
    });
    assert.equal(res.status, 201, `Expected 201 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.universityKey, TEST_UNI_KEY);
    assert.equal(res.body.sourceProgramId, SOURCE_ID);
    assert.deepEqual(res.body.fallbackProgramIds, [111, 222]);
    assert.equal(res.body.autoSubmit, true);
    assert.equal(res.body.enabled, true);
    assert.ok(Array.isArray(res.body.fallbackPrograms), "fallbackPrograms must be an array");
    assert.equal(res.body.fallbackPrograms.length, 2);
    createdId = res.body.id;
    assert.ok(createdId > 0, "created id must be positive");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// F2 — GET list
// ---------------------------------------------------------------------------
test("F2: GET list by universityKey includes the rule", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "GET",
      `/api/portal-program-fallbacks?universityKey=${TEST_UNI_KEY}`,
    );
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(Array.isArray(res.body), "list response must be an array");
    const found = res.body.find((r: any) => r.id === createdId);
    assert.ok(found, "created rule must appear in the list");
    assert.equal(found.sourceProgramId, SOURCE_ID);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// F3 — duplicate source → 409
// ---------------------------------------------------------------------------
test("F3: POST duplicate source returns 409 DUPLICATE_SOURCE", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-program-fallbacks", {
      universityKey: TEST_UNI_KEY,
      sourceProgramId: SOURCE_ID,
      fallbackProgramIds: [333],
    });
    assert.equal(res.status, 409, `Expected 409 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "DUPLICATE_SOURCE");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// F4 — PATCH reorder + toggle
// ---------------------------------------------------------------------------
test("F4: PATCH reorders fallbacks and toggles flags", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "PATCH",
      `/api/portal-program-fallbacks/${createdId}`,
      { fallbackProgramIds: [222, 111], enabled: false, autoSubmit: false },
    );
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body.fallbackProgramIds, [222, 111]);
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.autoSubmit, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// F5 — RBAC: non-admin → 403
// ---------------------------------------------------------------------------
test("F5: non-admin role is denied on every verb", async () => {
  agent();
  const server = await listen(buildApp());
  try {
    const get = await sendReq(
      server,
      "GET",
      `/api/portal-program-fallbacks?universityKey=${TEST_UNI_KEY}`,
    );
    assert.equal(get.status, 403, `GET expected 403 got ${get.status}`);

    const post = await sendReq(server, "POST", "/api/portal-program-fallbacks", {
      universityKey: TEST_UNI_KEY,
      sourceProgramId: SOURCE_ID + 1,
      fallbackProgramIds: [],
    });
    assert.equal(post.status, 403, `POST expected 403 got ${post.status}`);

    const patch = await sendReq(
      server,
      "PATCH",
      `/api/portal-program-fallbacks/${createdId}`,
      { enabled: true },
    );
    assert.equal(patch.status, 403, `PATCH expected 403 got ${patch.status}`);

    const del = await sendReq(
      server,
      "DELETE",
      `/api/portal-program-fallbacks/${createdId}`,
    );
    assert.equal(del.status, 403, `DELETE expected 403 got ${del.status}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// F6 — soft delete then list omits it
// ---------------------------------------------------------------------------
test("F6: DELETE soft-deletes and GET omits the rule", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const del = await sendReq(
      server,
      "DELETE",
      `/api/portal-program-fallbacks/${createdId}`,
    );
    assert.equal(del.status, 200, `Expected 200 got ${del.status}: ${JSON.stringify(del.body)}`);
    assert.equal(del.body.ok, true);

    const list = await sendReq(
      server,
      "GET",
      `/api/portal-program-fallbacks?universityKey=${TEST_UNI_KEY}`,
    );
    assert.equal(list.status, 200);
    const found = list.body.find((r: any) => r.id === createdId);
    assert.equal(found, undefined, "soft-deleted rule must not appear in the list");

    // Partial unique index frees up (universityKey, sourceProgramId) once soft-deleted,
    // so the same source can be recreated → 201 (not a 500 unique violation).
    const recreate = await sendReq(server, "POST", "/api/portal-program-fallbacks", {
      universityKey: TEST_UNI_KEY,
      sourceProgramId: SOURCE_ID,
      fallbackProgramIds: [],
    });
    assert.equal(recreate.status, 201, `Re-create expected 201 got ${recreate.status}: ${JSON.stringify(recreate.body)}`);
    assert.notEqual(recreate.body.id, createdId, "recreate must produce a new row id");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// F7 — concurrent same-key create is serialized and never leaks a DB 500
// ---------------------------------------------------------------------------
test("F7: concurrent same-key POSTs return one 201 and one 409", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const sourceProgramId = SOURCE_ID + 2;
    const payload = {
      universityKey: TEST_UNI_KEY,
      sourceProgramId,
      fallbackProgramIds: [444],
    };
    const results = await Promise.all([
      sendReq(server, "POST", "/api/portal-program-fallbacks", payload),
      sendReq(server, "POST", "/api/portal-program-fallbacks", payload),
    ]);

    assert.deepEqual(
      results.map((result) => result.status).sort(),
      [201, 409],
    );
    const duplicate = results.find((result) => result.status === 409);
    assert.equal(duplicate?.body.error, "DUPLICATE_SOURCE");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
