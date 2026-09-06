import assert from "node:assert/strict";
import pg from "pg";
import {
  parseOperationsWorkQuery,
  readOperationsWorkPage,
} from "../src/lib/operationsWorkReadModel";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const parsedUrl = new URL(databaseUrl);
if (
  !["127.0.0.1", "::1", "[::1]"].includes(parsedUrl.hostname) ||
  parsedUrl.port !== "5433" ||
  parsedUrl.pathname !== "/fasos_apply_local"
) {
  throw new Error(
    "PostgreSQL operations test requires 127.0.0.1:5433/fasos_apply_local",
  );
}

const client = new pg.Client({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  application_name: "fasos-operations-read-model-test",
});

await client.connect();
try {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  const identity = await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  );
  assert.equal(identity.rows[0]?.database_name, "fasos_apply_local");
  assert.equal(Number(identity.rows[0]?.server_port), 5433);

  const ledger = await client.query(
    "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
  );
  assert.equal(ledger.rows[0]?.count, 105);

  const indexResult = await client.query<{ count: number }>(
    `
    SELECT count(*)::int AS count
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = ANY($1::text[])
  `,
    [
      [
        "tasks_operations_open_due_idx",
        "applications_operations_deadline_idx",
        "applications_operations_updated_idx",
        "documents_operations_review_idx",
        "portal_lifecycle_observations_submission_latest_idx",
        "application_stage_documents_offer_expiry_idx",
      ],
    ],
  );
  assert.equal(indexResult.rows[0]?.count, 6);

  const actorResult = await client.query<{ id: number; role: string }>(`
    SELECT id, role
    FROM users
    WHERE deleted_at IS NULL
      AND is_active = true
      AND role IN ('super_admin', 'admin', 'manager', 'staff', 'consultant', 'editor', 'accountant')
    ORDER BY CASE WHEN role = 'super_admin' THEN 0 ELSE 1 END, id
    LIMIT 1
  `);
  const actor = actorResult.rows[0];
  assert.ok(actor, "a synthetic staff actor is required");

  const firstQuery = parseOperationsWorkQuery({ limit: "10" });
  const first = await readOperationsWorkPage(
    client,
    {
      actorUserId: actor.id,
      actorRole: actor.role,
      visibleBranchIds:
        actor.role === "super_admin" || actor.role === "admin" ? null : [],
    },
    firstQuery,
  );
  assert.equal(first.schemaVersion, 1);
  assert.ok(first.items.length <= 10);
  assert.equal(first.summary.total >= first.items.length, true);
  for (let index = 1; index < first.items.length; index += 1) {
    const previous = first.items[index - 1]!;
    const current = first.items[index]!;
    assert.equal(
      previous.score > current.score ||
        (previous.score === current.score &&
          previous.id.localeCompare(current.id) < 0),
      true,
    );
  }

  if (first.meta.nextCursor) {
    const second = await readOperationsWorkPage(
      client,
      {
        actorUserId: actor.id,
        actorRole: actor.role,
        visibleBranchIds:
          actor.role === "super_admin" || actor.role === "admin" ? null : [],
      },
      parseOperationsWorkQuery({ limit: "10", cursor: first.meta.nextCursor }),
    );
    const firstIds = new Set(first.items.map((item) => item.id));
    assert.equal(
      second.items.some((item) => firstIds.has(item.id)),
      false,
    );
    assert.equal(second.asOf, first.asOf);
  }

  const staffScoped = await readOperationsWorkPage(
    client,
    {
      actorUserId: actor.id,
      actorRole: "staff",
      visibleBranchIds: [],
    },
    parseOperationsWorkQuery({ limit: "10", scope: "mine" }),
  );
  assert.equal(staffScoped.summary.portal, 0);
  assert.equal(
    staffScoped.items.every((item) => item.isMine && item.source !== "portal"),
    true,
  );

  await client.query("COMMIT");
  console.log(
    `[operations-read-model] PASS ledger=105 indexes=6 visible=${first.summary.total} page=${first.items.length}`,
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
