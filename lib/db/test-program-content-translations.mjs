#!/usr/bin/env node
import assert from "node:assert/strict";
import pg from "pg";

const { Client } = pg;

if (process.env.ALLOW_PROGRAM_TRANSLATION_DB_TEST !== "true") {
  throw new Error(
    "[program-translation-db] BLOCKED: ALLOW_PROGRAM_TRANSLATION_DB_TEST=true is required",
  );
}

const connectionString = process.env.DATABASE_URL ?? "";
let target;
try {
  target = new URL(connectionString);
} catch {
  throw new Error("[program-translation-db] BLOCKED: DATABASE_URL is malformed");
}
if (
  target.protocol !== "postgresql:" ||
  target.hostname !== "127.0.0.1" ||
  target.port !== "5433" ||
  target.pathname !== "/fasos_apply_local" ||
  target.username !== "fas_migrator" ||
  target.search !== "" ||
  target.hash !== ""
) {
  throw new Error(
    "[program-translation-db] BLOCKED: only the disposable local migration database is allowed",
  );
}

const expectedLocales = [
  "ar", "es", "fa", "fr", "hi", "id", "kk", "ky", "ru", "tg", "tk", "tr", "ur", "uz", "zh",
];
const client = new Client({
  connectionString,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  application_name: "fasos-program-translation-db-test",
});

await client.connect();
try {
  await client.query("BEGIN");
  const identity = await client.query(
    "SELECT current_database() AS database_name, current_user AS user_name, host(inet_server_addr()) AS server_address, inet_server_port() AS server_port",
  );
  assert.deepEqual(identity.rows[0], {
    database_name: "fasos_apply_local",
    user_name: "fas_migrator",
    server_address: "127.0.0.1",
    server_port: 5433,
  });

  const university = await client.query(
    "INSERT INTO universities (name, country) VALUES ($1, $2) RETURNING id",
    ["Translation Queue Test University", "Test Country"],
  );
  const program = await client.query(
    `INSERT INTO programs
      (university_id, name, description, degree, field, language, duration, intakes, requirements)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      university.rows[0].id,
      "Computer Science BSc",
      "Canonical English programme description.",
      "Bachelor",
      "Computer Science",
      "English",
      "4 years",
      "September",
      "High school diploma",
    ],
  );
  const programId = program.rows[0].id;

  const queued = await client.query(
    `SELECT locale, status, attempts, source_hash
     FROM program_translations
     WHERE program_id = $1
     ORDER BY locale`,
    [programId],
  );
  assert.equal(queued.rowCount, 15);
  assert.deepEqual(queued.rows.map((row) => row.locale), expectedLocales);
  assert.ok(queued.rows.every((row) => row.status === "queued" && row.attempts === 0));
  assert.ok(queued.rows.every((row) => /^[0-9a-f]{64}$/.test(row.source_hash)));
  assert.equal(new Set(queued.rows.map((row) => row.source_hash)).size, 1);
  const originalHash = queued.rows[0].source_hash;

  await client.query(
    `UPDATE program_translations
     SET status = 'processing', attempts = 2, leased_at = now(),
         lease_expires_at = now() + interval '2 minutes', worker_id = 'stale-worker'
     WHERE program_id = $1 AND locale = 'fr'`,
    [programId],
  );
  await client.query(
    `UPDATE program_translations
     SET status = 'published', is_manual = true, name = 'Manuel başlık',
         translated_at = now()
     WHERE program_id = $1 AND locale = 'tr'`,
    [programId],
  );

  await client.query(
    "UPDATE programs SET description = $2 WHERE id = $1",
    [programId, "Updated canonical English description."],
  );
  const refreshed = await client.query(
    `SELECT locale, status, attempts, source_hash, leased_at, lease_expires_at, worker_id
     FROM program_translations
     WHERE program_id = $1
     ORDER BY locale`,
    [programId],
  );
  assert.equal(refreshed.rowCount, 15);
  assert.ok(refreshed.rows.every((row) => row.source_hash !== originalHash));
  const manual = refreshed.rows.find((row) => row.locale === "tr");
  assert.equal(manual.status, "stale_manual");
  assert.equal(manual.attempts, 0);
  const reclaimed = refreshed.rows.find((row) => row.locale === "fr");
  assert.equal(reclaimed.status, "queued");
  assert.equal(reclaimed.attempts, 0);
  assert.equal(reclaimed.leased_at, null);
  assert.equal(reclaimed.lease_expires_at, null);
  assert.equal(reclaimed.worker_id, null);

  await client.query("DELETE FROM programs WHERE id = $1", [programId]);
  const cascaded = await client.query(
    "SELECT count(*)::int AS count FROM program_translations WHERE program_id = $1",
    [programId],
  );
  assert.equal(cascaded.rows[0].count, 0);

  await client.query("ROLLBACK");
  console.log(
    "[program-translation-db] PASS: insert queues 15 locales; source edits invalidate leases; manual rows require review; cascade is clean",
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
