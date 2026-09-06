#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const apiRequire = createRequire(
  new URL("../../artifacts/api-server/package.json", import.meta.url),
);
const bcrypt = apiRequire("bcryptjs");
const pg = apiRequire("pg");

function fail(message) {
  throw new Error(`[staging-seed] BLOCKED: ${message}`);
}

function exactTarget(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    fail("DATABASE_URL is malformed");
  }
  if (
    !["postgres:", "postgresql:"].includes(target.protocol) ||
    target.hostname !== "127.0.0.1" ||
    target.pathname !== "/fasos_staging" ||
    target.username !== "fas_migrator" ||
    [...target.searchParams.keys()].length > 0
  ) {
    fail("seed target must be the loopback fasos_staging migrator identity");
  }
  return target;
}

async function run() {
  if (process.env.ALLOW_STAGING_SEED !== "true") {
    fail("ALLOW_STAGING_SEED=true is required");
  }
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is required");
  exactTarget(process.env.DATABASE_URL);
  const password = process.env.STAGING_ADMIN_PASSWORD ?? "";
  if (password.length < 20 || password.length > 128) {
    fail("STAGING_ADMIN_PASSWORD must contain 20-128 characters");
  }
  const expectedCommit = process.env.STAGING_EXPECTED_SOURCE_COMMIT ?? "";
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
    fail("STAGING_EXPECTED_SOURCE_COMMIT must be exact");
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const seedSql = fs.readFileSync(
    path.join(root, "artifacts/api-server/src/seed.sql"),
    "utf8",
  );
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: "fasos-staging-seed",
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const identity = await client.query(
      "SELECT current_database() AS database_name, current_user AS user_name, (SELECT count(*)::integer FROM drizzle.__drizzle_migrations) AS migration_count, (SELECT count(*)::integer FROM users) AS user_count",
    );
    const row = identity.rows[0];
    if (
      row?.database_name !== "fasos_staging" ||
      row?.user_name !== "fas_migrator" ||
      row?.migration_count !== 105 ||
      row?.user_count !== 0
    ) {
      fail("seed requires a fresh 105/105 staging database with zero users");
    }
    await client.query(seedSql);
    const passwordHash = await bcrypt.hash(password, 12);
    await client.query(
      `INSERT INTO users
        (replit_id, email, first_name, last_name, role, password_hash, is_active, language)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
      [
        `staging-admin-${expectedCommit.slice(0, 12)}`,
        "staging-admin@findandstudy.com",
        "Find & Study",
        "Staging",
        "super_admin",
        passwordHash,
        "tr",
      ],
    );
    await client.query("COMMIT");
    console.log(
      `[staging-seed] PASS: synthetic admin and reference data seeded for ${expectedCommit}`,
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { exactTarget, run };
