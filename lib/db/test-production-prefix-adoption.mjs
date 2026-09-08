#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { validateMigrationLedger } from "./validate-migrations.mjs";

const { Client, Pool } = pg;
const sourceFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "drizzle",
);

if (process.env.ALLOW_DISPOSABLE_PREFIX_ADOPTION !== "true") {
  throw new Error(
    "[prefix-adoption] BLOCKED: ALLOW_DISPOSABLE_PREFIX_ADOPTION=true is required",
  );
}
if (!process.env.DATABASE_URL) {
  throw new Error("[prefix-adoption] BLOCKED: DATABASE_URL is required");
}

const target = new URL(process.env.DATABASE_URL);
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
    "[prefix-adoption] BLOCKED: only postgresql://fas_migrator@127.0.0.1:5433/fasos_apply_local is allowed",
  );
}

validateMigrationLedger();

const identityClient = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  application_name: "fasos-production-prefix-adoption",
});
await identityClient.connect();
try {
  const identity = await identityClient.query(
    "SELECT current_database() AS database_name, current_user AS user_name, host(inet_server_addr()) AS server_address, inet_server_port() AS server_port, role_row.rolsuper, role_row.rolcreatedb, role_row.rolcreaterole, role_row.rolinherit, role_row.rolreplication, role_row.rolbypassrls, role_row.rolcanlogin, EXISTS (SELECT 1 FROM pg_auth_members AS role_membership WHERE role_membership.member = role_row.oid) AS has_role_membership FROM pg_roles AS role_row WHERE role_row.rolname = current_user",
  );
  assert.equal(identity.rows[0]?.database_name, "fasos_apply_local");
  assert.equal(identity.rows[0]?.user_name, "fas_migrator");
  assert.equal(typeof identity.rows[0]?.server_address, "string");
  assert.ok(identity.rows[0].server_address.length > 0);
  assert.ok(Number.isSafeInteger(Number(identity.rows[0]?.server_port)));
  assert.equal(identity.rows[0]?.rolsuper, false);
  assert.equal(identity.rows[0]?.rolcreatedb, false);
  assert.equal(identity.rows[0]?.rolcreaterole, false);
  assert.equal(identity.rows[0]?.rolinherit, false);
  assert.equal(identity.rows[0]?.rolreplication, false);
  assert.equal(identity.rows[0]?.rolbypassrls, false);
  assert.equal(identity.rows[0]?.rolcanlogin, true);
  assert.equal(identity.rows[0]?.has_role_membership, false);
  const existingLedger = await identityClient.query(
    "SELECT to_regclass('drizzle.__drizzle_migrations') AS ledger",
  );
  assert.equal(
    existingLedger.rows[0]?.ledger,
    null,
    "prefix adoption requires a fresh disposable database",
  );
} finally {
  await identityClient.end();
}

const journal = JSON.parse(
  await readFile(path.join(sourceFolder, "meta", "_journal.json"), "utf8"),
);
const canonicalMigrationCount = journal.entries.length;
const manifest = JSON.parse(
  await readFile(
    path.join(sourceFolder, "meta", "production-prefix.json"),
    "utf8",
  ),
);
assert.equal(manifest.authoritativeThrough, 65);
const productionEntries = journal.entries.filter(
  (entry) => entry.idx <= manifest.authoritativeThrough,
);
assert.equal(productionEntries.length, 66);
assert.deepEqual(
  productionEntries.map((entry) => entry.idx),
  Array.from({ length: 66 }, (_, index) => index),
);

const fixtureFolder = await mkdtemp(
  path.join(os.tmpdir(), "fasos-production-prefix-"),
);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
});

try {
  await mkdir(path.join(fixtureFolder, "meta"));
  await writeFile(
    path.join(fixtureFolder, "meta", "_journal.json"),
    `${JSON.stringify({ ...journal, entries: productionEntries }, null, 2)}\n`,
    "utf8",
  );
  for (const entry of productionEntries) {
    await copyFile(
      path.join(sourceFolder, `${entry.tag}.sql`),
      path.join(fixtureFolder, `${entry.tag}.sql`),
    );
  }

  const database = drizzle(pool);
  await migrate(database, { migrationsFolder: fixtureFolder });
  const prefixState = await pool.query(
    "SELECT count(*)::integer AS count, max(created_at)::bigint AS latest FROM drizzle.__drizzle_migrations",
  );
  assert.deepEqual(prefixState.rows[0], {
    count: 66,
    latest: String(productionEntries.at(-1).when),
  });

  await migrate(database, { migrationsFolder: sourceFolder });
  const canonicalState = await pool.query(
    "SELECT count(*)::integer AS count, max(created_at)::bigint AS latest FROM drizzle.__drizzle_migrations",
  );
  assert.deepEqual(canonicalState.rows[0], {
    count: canonicalMigrationCount,
    latest: String(journal.entries.at(-1).when),
  });

  await migrate(database, { migrationsFolder: sourceFolder });
  const replayState = await pool.query(
    "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
  );
  assert.equal(replayState.rows[0]?.count, canonicalMigrationCount);
  console.log(
    `[prefix-adoption] PASS: production 66/66 -> canonical ${canonicalMigrationCount}/${canonicalMigrationCount} -> clean replay`,
  );
} finally {
  await pool.end();
  await rm(fixtureFolder, { recursive: true, force: true });
}
