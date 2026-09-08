/**
 * test-portal-mgmt-b.ts — SUB-STEP B regression tests (TBB1–TBB7)
 *
 * TBB1: GET /portal-program-mapping/:key returns empty mappings when no row
 * TBB2: PUT /portal-program-mapping/:key upsert → GET returns updated map
 * TBB3: GET /portal-adapters returns { registry, db } shape
 * TBB4: POST /portal-adapters creates a DB adapter row → 201
 * TBB5: PATCH /portal-adapters/:id updates fields
 * TBB6: DELETE /portal-adapters/:id soft-deletes; not in db list
 * TBB7: POST /portal-universities/:id/test-login — no worker → fail-closed 503
 *
 * Run:
 *   pnpm --filter @workspace/api-server test:portal-mgmt-b
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  portalProgramMappingTable,
  portalAdaptersTable,
  portalUniversitiesTable,
  usersTable,
} from "@workspace/db";
import portalMgmtRouter from "../src/routes/portalMgmt.js";

// ---------------------------------------------------------------------------
// Run-specific tag
// ---------------------------------------------------------------------------
const RUN = `tbb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
const UNI_KEY = `uni_tbb_${RUN}`;
const ADP_KEY = `adp_${RUN}`;

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------
const cleanupMappingKeys: string[] = [];
const cleanupAdapterIds:  number[] = [];
const cleanupUniIds:      number[] = [];
let cleanupUserId: number | null = null;

before(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `${RUN}.admin@example.test`,
      firstName: "Portal",
      lastName: "Management Admin",
      role: "super_admin",
      isActive: true,
      emailVerified: true,
    })
    .returning({ id: usersTable.id });
  cleanupUserId = user.id;
  MOCK_USER.id = user.id;
});

after(async () => {
  for (const key of cleanupMappingKeys) {
    await db
      .delete(portalProgramMappingTable)
      .where(eq(portalProgramMappingTable.universityKey, key))
      .catch(() => {});
  }
  for (const id of cleanupAdapterIds) {
    await db
      .update(portalAdaptersTable)
      .set({ deletedAt: new Date() })
      .where(eq(portalAdaptersTable.id, id))
      .catch(() => {});
  }
  for (const id of cleanupUniIds) {
    await db
      .update(portalUniversitiesTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(portalUniversitiesTable.id, id), isNull(portalUniversitiesTable.deletedAt)))
      .catch(() => {});
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (cleanupUserId !== null) {
    await db.delete(usersTable).where(eq(usersTable.id, cleanupUserId)).catch(() => {});
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Auth stub
// ---------------------------------------------------------------------------
const MOCK_USER = { id: 0, role: "super_admin", isActive: true, emailVerified: true };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { ...MOCK_USER };
    if (!("cookies" in req)) (req as any).cookies = {};
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
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
  return new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
}
function close(s: http.Server): Promise<void> {
  return new Promise((r) => s.close(() => r()));
}

// ---------------------------------------------------------------------------
// TBB1 — GET /portal-program-mapping/:key returns empty when no row
// ---------------------------------------------------------------------------
test("TBB1: GET /portal-program-mapping/:key returns empty mappings when no row exists", async () => {
  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "GET", `/api/portal-program-mapping/${UNI_KEY}_miss`);
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.universityKey, `${UNI_KEY}_miss`);
    assert.deepEqual(res.body.mappings, {});
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TBB2 — PUT /portal-program-mapping/:key upsert → GET returns updated
// ---------------------------------------------------------------------------
test("TBB2: PUT /portal-program-mapping/:key upsert + GET roundtrip", async () => {
  cleanupMappingKeys.push(UNI_KEY);
  const mappings = { "Bilgisayar Mühendisliği": "Computer Engineering", "Psikoloji": "Psychology" };

  const app    = buildApp();
  const server = await listen(app);
  try {
    const put = await sendReq(server, "PUT", `/api/portal-program-mapping/${UNI_KEY}`, { mappings });
    assert.equal(put.status, 200, `PUT failed: ${JSON.stringify(put.body)}`);
    assert.deepEqual(put.body.mappings, mappings);

    const get = await sendReq(server, "GET", `/api/portal-program-mapping/${UNI_KEY}`);
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.mappings, mappings);

    // Second PUT updates same row
    const mappings2 = { "İktisad": "Economics" };
    const put2 = await sendReq(server, "PUT", `/api/portal-program-mapping/${UNI_KEY}`, { mappings: mappings2 });
    assert.equal(put2.status, 200);
    assert.equal(put2.body.id, put.body.id, "Should update same row");
    assert.deepEqual(put2.body.mappings, mappings2);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TBB3 — GET /portal-adapters returns { registry, db } shape
// ---------------------------------------------------------------------------
test("TBB3: GET /portal-adapters returns registry and db arrays", async () => {
  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "GET", "/api/portal-adapters");
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(Array.isArray(res.body.registry), "registry should be array");
    assert.ok(Array.isArray(res.body.db),       "db should be array");
    // Registry should include at least the code adapters
    assert.ok(res.body.registry.length > 0, "registry should not be empty");
    // Registry entries must have key, label, kind — no credential values
    for (const r of res.body.registry) {
      assert.ok("key"   in r, "registry entry needs key");
      assert.ok("label" in r, "registry entry needs label");
      assert.ok("kind"  in r, "registry entry needs kind");
      const keys = Object.keys(r);
      assert.ok(!keys.some((k) => k.toLowerCase().includes("password")), "no password in registry");
    }
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TBB4 — POST /portal-adapters creates a DB adapter → 201
// ---------------------------------------------------------------------------
test("TBB4: POST /portal-adapters creates DB adapter row", async () => {
  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", "/api/portal-adapters", {
      key:        ADP_KEY,
      label:      `TBB Test Adapter ${RUN}`,
      baseUrl:    "https://example-portal.test",
      matchNames: `test_${RUN}`,
      kind:       "declarative",
      configJson: { loginUrl: "https://example-portal.test/login", steps: [] },
      isActive:   true,
    });
    assert.equal(res.status, 201, `Expected 201 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.key, ADP_KEY);
    assert.equal(res.body.kind, "declarative");
    assert.ok(res.body.id, "Should return id");
    cleanupAdapterIds.push(res.body.id);

    // Duplicate key → 409
    const dup = await sendReq(server, "POST", "/api/portal-adapters", {
      key:        ADP_KEY,
      label:      "Dup",
      baseUrl:    "https://x.test",
      matchNames: "x",
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "DUPLICATE_KEY");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TBB5 — PATCH /portal-adapters/:id updates fields
// ---------------------------------------------------------------------------
test("TBB5: PATCH /portal-adapters/:id updates label and configJson", async () => {
  const adpId = cleanupAdapterIds[0];
  assert.ok(adpId, "Needs adapter from TBB4");

  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "PATCH", `/api/portal-adapters/${adpId}`, {
      label:     `TBB Updated ${RUN}`,
      configJson: { loginUrl: "https://example-portal.test/login2", steps: [{ type: "navigate" }] },
    });
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.label, `TBB Updated ${RUN}`);
    assert.deepEqual(res.body.configJson, { loginUrl: "https://example-portal.test/login2", steps: [{ type: "navigate" }] });
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TBB6 — DELETE /portal-adapters/:id soft-deletes; not in db list
// ---------------------------------------------------------------------------
test("TBB6: DELETE /portal-adapters/:id soft-deletes; not returned in db list", async () => {
  // Create a dedicated adapter for delete
  const delKey = `${ADP_KEY}_del`;
  const [created] = await db
    .insert(portalAdaptersTable)
    .values({
      key:        delKey,
      label:      `TBB Del ${RUN}`,
      baseUrl:    "https://del.test",
      matchNames: `del_${RUN}`,
      kind:       "declarative",
    })
    .returning({ id: portalAdaptersTable.id });

  const app    = buildApp();
  const server = await listen(app);
  try {
    const del = await sendReq(server, "DELETE", `/api/portal-adapters/${created.id}`);
    assert.equal(del.status, 200, `Expected 200 got ${del.status}: ${JSON.stringify(del.body)}`);
    assert.equal(del.body.ok, true);

    // Verify not in db list
    const list = await sendReq(server, "GET", "/api/portal-adapters");
    assert.ok(
      !list.body.db.some((r: any) => r.id === created.id),
      "Soft-deleted adapter must not appear in db list",
    );

    // Second DELETE → 404
    const del2 = await sendReq(server, "DELETE", `/api/portal-adapters/${created.id}`);
    assert.equal(del2.status, 404);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TBB7 — POST /portal-universities/:id/test-login — no worker → 503
// ---------------------------------------------------------------------------
test("TBB7: test-login without a release-matched worker fails closed without leaking creds", async () => {
  // Create a test university with an adapter key that has NO env credentials
  const [uni] = await db
    .insert(portalUniversitiesTable)
    .values({
      universityKey:  `${UNI_KEY}_tl`,
      universityName: `TBB TL Test ${RUN}`,
      adapterKey:     `nonexistent_adapter_${RUN}`,
      isActive:       true,
    })
    .returning({ id: portalUniversitiesTable.id });
  cleanupUniIds.push(uni.id);

  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", `/api/portal-universities/${uni.id}/test-login`);
    assert.equal(res.status, 503, `Expected 503 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.accepted, false);
    assert.ok(
      ["PORTAL_WORKER_UNAVAILABLE", "PORTAL_WORKER_RELEASE_MISMATCH"].includes(res.body.error),
      `Unexpected worker error: ${String(res.body.error)}`,
    );
    // Ensure no actual credential VALUES appear in the response.
    // (The message may mention env-var NAME patterns like "_EMAIL" as guidance —
    //  what must never appear is an actual secret/password value.)
    const bodyStr = JSON.stringify(res.body);
    // No base64-ish or long opaque tokens in the message (heuristic: no 40+ char alnum strings)
    assert.ok(!/[A-Za-z0-9+/]{40,}/.test(bodyStr), "No long opaque token in response");
    // The word "password" must not appear as a key in the JSON body (only allowed in the error message as guidance text)
    const parsed = res.body as Record<string, unknown>;
    assert.ok(!("password" in parsed), "No password key in response body");
  } finally {
    await close(server);
  }
});
