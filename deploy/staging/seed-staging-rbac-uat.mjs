#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const apiRequire = createRequire(
  new URL("../../artifacts/api-server/package.json", import.meta.url),
);
const bcrypt = apiRequire("bcryptjs");
const pg = apiRequire("pg");

const BASE_ADMIN_EMAIL = "staging-admin@findandstudy.com";
const ALL_AGENT_PERMISSIONS = [
  "leads",
  "students",
  "applications",
  "documents",
  "course_finder",
  "messages",
  "commissions",
];
const UAT_USERS = [
  ["audit-superadmin@audit.test", "super_admin", "SuperAdmin"],
  ["audit-admin@audit.test", "admin", "Admin"],
  ["audit-manager@audit.test", "manager", "Manager"],
  ["audit-staff@audit.test", "staff", "Staff"],
  ["audit-consultant@audit.test", "consultant", "Consultant"],
  ["audit-editor@audit.test", "editor", "Editor"],
  ["audit-accountant@audit.test", "accountant", "Accountant"],
  ["audit-agent@audit.test", "agent", "Agent"],
  ["audit-subagent@audit.test", "sub_agent", "SubAgent"],
  ["audit-agentstaff@audit.test", "agent_staff", "AgentStaff"],
  ["audit-student@audit.test", "student", "Student"],
];

function fail(message) {
  throw new Error(`[staging-rbac-uat-seed] BLOCKED: ${message}`);
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
    target.port !== "5432" ||
    target.pathname !== "/fasos_staging" ||
    target.username !== "fas_migrator" ||
    [...target.searchParams.keys()].length > 0 ||
    target.hash
  ) {
    fail(
      "fixture target must be fas_migrator on exact loopback:5432/fasos_staging",
    );
  }
  return target;
}

function exactExpectedUserCount(rawValue) {
  if (!/^(1|12)$/.test(rawValue ?? "")) {
    fail("STAGING_UAT_EXPECTED_PRE_USER_COUNT must be exact 1 or 12");
  }
  return Number(rawValue);
}

async function ensureAgent(
  client,
  { userId, email, companyName, lastName, parentAgentId },
) {
  const existing = await client.query(
    `SELECT id, email, deleted_at
       FROM agents
      WHERE user_id = $1
      ORDER BY id`,
    [userId],
  );
  if (existing.rowCount > 1) {
    fail(`multiple agent profiles exist for synthetic user ${email}`);
  }
  if (existing.rowCount === 1) {
    const row = existing.rows[0];
    if (row.email !== email) {
      fail(`agent profile identity drift for synthetic user ${email}`);
    }
    await client.query(
      `UPDATE agents
          SET company_name = $2,
              first_name = 'Audit',
              last_name = $3,
              parent_agent_id = $4,
              status = 'active',
              deleted_at = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, companyName, lastName, parentAgentId],
    );
    return row.id;
  }

  const inserted = await client.query(
    `INSERT INTO agents (
       user_id, company_name, first_name, last_name, email,
       parent_agent_id, status, created_at, updated_at
     )
     VALUES ($1, $2, 'Audit', $3, $4, $5, 'active', NOW(), NOW())
     RETURNING id`,
    [userId, companyName, lastName, email, parentAgentId],
  );
  return inserted.rows[0].id;
}

async function run() {
  if (process.env.ALLOW_STAGING_RBAC_UAT_SEED !== "true") {
    fail("ALLOW_STAGING_RBAC_UAT_SEED=true is required");
  }
  if (process.env.STAGING_TARGET_ENV !== "staging") {
    fail("STAGING_TARGET_ENV=staging is required");
  }
  if (process.env.ALLOW_LIVE_INTEGRATIONS !== "false") {
    fail("ALLOW_LIVE_INTEGRATIONS=false is required");
  }
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is required");
  exactTarget(process.env.DATABASE_URL);

  const password = process.env.RBAC_E2E_PASSWORD ?? "";
  if (password.length < 20 || password.length > 128) {
    fail("RBAC_E2E_PASSWORD must contain 20-128 characters");
  }
  const expectedCommit = process.env.STAGING_EXPECTED_SOURCE_COMMIT ?? "";
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
    fail("STAGING_EXPECTED_SOURCE_COMMIT must be exact");
  }
  const changeId = process.env.STAGING_UAT_CHANGE_ID ?? "";
  if (
    !/^stg-uat-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/.test(changeId) ||
    !changeId.endsWith(expectedCommit.slice(0, 12))
  ) {
    fail("STAGING_UAT_CHANGE_ID must bind the exact source commit");
  }
  const expectedPreUserCount = exactExpectedUserCount(
    process.env.STAGING_UAT_EXPECTED_PRE_USER_COUNT,
  );

  const passwordHash = await bcrypt.hash(password, 12);
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: "fasos-staging-rbac-uat-seed",
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const identity = await client.query(
      `SELECT current_database() AS database_name,
              current_user AS user_name,
              (SELECT count(*)::integer FROM drizzle.__drizzle_migrations) AS migration_count,
              (SELECT count(*)::integer FROM users) AS user_count`,
    );
    const identityRow = identity.rows[0];
    if (
      identityRow?.database_name !== "fasos_staging" ||
      identityRow?.user_name !== "fas_migrator" ||
      identityRow?.migration_count !== 107 ||
      identityRow?.user_count !== expectedPreUserCount
    ) {
      fail("database identity, ledger, or exact pre-user count does not match");
    }

    const baseAdmin = await client.query(
      `SELECT id
         FROM users
        WHERE email = $1
          AND role = 'super_admin'
          AND is_active = true
          AND replit_id LIKE 'staging-admin-%'`,
      [BASE_ADMIN_EMAIL],
    );
    if (baseAdmin.rowCount !== 1) {
      fail("the original synthetic staging admin is missing or drifted");
    }

    const fixtureEmails = UAT_USERS.map(([email]) => email);
    const unexpected = await client.query(
      `SELECT email
         FROM users
        WHERE email IS NOT NULL
          AND email <> $1
          AND NOT (email = ANY($2::text[]))
        ORDER BY email
        LIMIT 1`,
      [BASE_ADMIN_EMAIL, fixtureEmails],
    );
    if (unexpected.rowCount !== 0) {
      fail("a non-synthetic or unrecognized user exists in staging");
    }

    const userIds = new Map();
    for (const [email, role, lastName] of UAT_USERS) {
      const replitId = `staging-rbac-uat-${role}`;
      const conflictingIdentity = await client.query(
        `SELECT email
           FROM users
          WHERE replit_id = $1
            AND email IS DISTINCT FROM $2`,
        [replitId, email],
      );
      if (conflictingIdentity.rowCount !== 0) {
        fail(`synthetic identity conflict for ${role}`);
      }

      const result = await client.query(
        `INSERT INTO users (
           replit_id, email, password_hash, role, first_name, last_name,
           is_active, email_verified, language, created_from_source,
           agent_staff_permissions, deleted_at, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, 'Audit', $5, true, true, 'en',
                 'staging_rbac_uat', $6::jsonb, NULL, NOW(), NOW())
         ON CONFLICT (email) DO UPDATE SET
           replit_id = EXCLUDED.replit_id,
           password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           is_active = true,
           email_verified = true,
           language = 'en',
           created_from_source = 'staging_rbac_uat',
           agent_staff_permissions = EXCLUDED.agent_staff_permissions,
           deleted_at = NULL,
           updated_at = NOW()
         RETURNING id`,
        [
          replitId,
          email,
          passwordHash,
          role,
          lastName,
          role === "agent_staff" ? JSON.stringify(ALL_AGENT_PERMISSIONS) : null,
        ],
      );
      userIds.set(email, result.rows[0].id);
    }

    const agentId = await ensureAgent(client, {
      userId: userIds.get("audit-agent@audit.test"),
      email: "audit-agent@audit.test",
      companyName: "Audit Agency",
      lastName: "Agent",
      parentAgentId: null,
    });
    await ensureAgent(client, {
      userId: userIds.get("audit-subagent@audit.test"),
      email: "audit-subagent@audit.test",
      companyName: "Audit SubAgency",
      lastName: "SubAgent",
      parentAgentId: agentId,
    });
    await client.query(
      `UPDATE users
          SET managing_agent_id = $1,
              agent_staff_permissions = $2::jsonb,
              updated_at = NOW()
        WHERE id = $3`,
      [
        agentId,
        JSON.stringify(ALL_AGENT_PERMISSIONS),
        userIds.get("audit-agentstaff@audit.test"),
      ],
    );

    const studentUserId = userIds.get("audit-student@audit.test");
    const students = await client.query(
      `SELECT id, email
         FROM students
        WHERE user_id = $1
        ORDER BY id`,
      [studentUserId],
    );
    if (students.rowCount > 1) {
      fail("multiple student profiles exist for the synthetic student");
    }
    if (students.rowCount === 1) {
      if (students.rows[0].email !== "audit-student@audit.test") {
        fail("student profile identity drifted");
      }
      await client.query(
        `UPDATE students
            SET first_name = 'Audit',
                last_name = 'Student',
                status = 'active',
                deleted_at = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [students.rows[0].id],
      );
    } else {
      await client.query(
        `INSERT INTO students (
           user_id, first_name, last_name, email, status, season,
           origin_type, origin_display_name, origin_locked,
           created_at, updated_at
         )
         VALUES ($1, 'Audit', 'Student', 'audit-student@audit.test',
                 'active', '2026', 'direct', 'Synthetic staging UAT', true,
                 NOW(), NOW())`,
        [studentUserId],
      );
    }

    const finalState = await client.query(
      `SELECT
         (SELECT count(*)::integer
            FROM users
           WHERE email = ANY($1::text[])
             AND created_from_source = 'staging_rbac_uat'
             AND is_active = true) AS fixture_users,
         (SELECT count(*)::integer
            FROM agents
           WHERE email IN ('audit-agent@audit.test', 'audit-subagent@audit.test')
             AND deleted_at IS NULL) AS fixture_agents,
         (SELECT count(*)::integer
            FROM students
           WHERE email = 'audit-student@audit.test'
             AND deleted_at IS NULL) AS fixture_students,
         (SELECT count(*)::integer FROM users) AS total_users`,
      [fixtureEmails],
    );
    const finalRow = finalState.rows[0];
    if (
      finalRow?.fixture_users !== 11 ||
      finalRow?.fixture_agents !== 2 ||
      finalRow?.fixture_students !== 1 ||
      finalRow?.total_users !== 12
    ) {
      fail("final synthetic fixture denominator does not reconcile");
    }

    await client.query("COMMIT");
    console.log(
      `[staging-rbac-uat-seed] PASS: ${changeId}; users=11 agents=2 students=1 totalUsers=12`,
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

export { UAT_USERS, exactExpectedUserCount, exactTarget, run };
