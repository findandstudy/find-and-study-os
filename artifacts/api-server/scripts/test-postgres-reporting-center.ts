import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { duplicateCandidatesCte } from "../src/lib/reportingDuplicateSemantics";

const rawUrl = process.env.DATABASE_URL ?? "";
let target: URL;
try {
  target = new URL(rawUrl);
} catch {
  throw new Error("[reporting-postgres] DATABASE_URL is required");
}

const dedicatedTarget = /^\/fas_dev_reporting_[a-z0-9_]+$/.test(
  target.pathname,
);
const ciDisposableTarget =
  process.env.CI === "true" &&
  process.env.ALLOW_DISPOSABLE_REPORTING_TEST === "true" &&
  target.pathname === "/fasos_apply_local";
const localDisposableTarget =
  process.env.REPORTING_TEST_TARGET_MODE === "local-existing" &&
  process.env.ALLOW_DISPOSABLE_REPORTING_TEST === "true" &&
  target.pathname === "/fasos_apply_local";

if (
  target.protocol !== "postgresql:" ||
  target.hostname !== "127.0.0.1" ||
  target.port !== "5433" ||
  (!dedicatedTarget && !ciDisposableTarget && !localDisposableTarget) ||
  target.username !== "fas_migrator"
) {
  throw new Error(
    "[reporting-postgres] only the dedicated loopback reporting fixture is allowed",
  );
}

const routePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/routes/reporting.ts",
);
const source = fs
  .readFileSync(routePath, "utf8")
  .replace(
    '${duplicateCandidatesCte("reporting")}',
    duplicateCandidatesCte("reporting"),
  );
const queries = Array.from(
  source.matchAll(/client\.query<QueryRow>\(\s*`([\s\S]*?)`(?:\s*,|\s*\))/g),
  (match) => match[1],
);
assert.ok(
  queries.length >= 10,
  "expected every Reporting Center SQL projection",
);

const client = new pg.Client({
  connectionString: rawUrl,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 10_000,
  application_name: "fasos-reporting-postgres-contract",
});

await client.connect();
try {
  const identity = await client.query(
    "SELECT current_database() AS database_name, current_user AS user_name, inet_server_port() AS server_port",
  );
  if (dedicatedTarget) {
    assert.match(identity.rows[0]?.database_name ?? "", /^fas_dev_reporting_/);
  } else {
    assert.equal(identity.rows[0]?.database_name, "fasos_apply_local");
  }
  assert.equal(identity.rows[0]?.user_name, "fas_migrator");
  assert.equal(
    Number(identity.rows[0]?.server_port),
    ciDisposableTarget ? 5432 : 5433,
  );

  await client.query("BEGIN READ ONLY");
  for (const [index, query] of queries.entries()) {
    const placeholders = Array.from(query.matchAll(/\$(\d+)/g), (match) =>
      Number(match[1]),
    );
    const maximum = placeholders.length ? Math.max(...placeholders) : 0;
    const values: unknown[] = [
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      null,
      null,
      "2026-07-01T00:00:00.000Z",
      "day",
    ].slice(0, maximum);
    if (maximum === 1 && query.includes("$1::int[]")) values[0] = null;
    if (query.includes("date_trunc($5::text")) values[4] = "day";
    try {
      await client.query(query, values);
    } catch (error) {
      throw new Error(
        `[reporting-postgres] query ${index + 1}/${queries.length} with ${maximum} parameters failed`,
        { cause: error },
      );
    }
  }
  await client.query("ROLLBACK");

  const queryContaining = (fragment: string): string => {
    const matches = queries.filter((query) => query.includes(fragment));
    assert.equal(
      matches.length,
      1,
      `expected one reporting query containing ${fragment}`,
    );
    return matches[0]!;
  };
  const commandSummaryQuery = queryContaining(
    "lc.current_count AS leads_current",
  );
  const funnelQuery = queryContaining(
    "(SELECT count(*)::int FROM cohort_apps WHERE variant = 'won') AS won",
  );
  const applicationStagesQuery = queryContaining(
    "count(*)::int AS inventory_count",
  );
  const commissionQuery = queryContaining("AS gross_commission");
  const reportingQualityQuery = queryContaining(
    "AS applications_missing_catalog_link",
  );

  await client.query("BEGIN");
  try {
    const branchA = 910001;
    const branchB = 910002;
    const studentA = -910001;
    const studentB = -910002;
    const inventoryStudent = -910003;
    const otherBranchStudent = -910004;
    const nullBranchStudentA = -910005;
    const nullBranchStudentB = -910006;
    const leadA = -920001;
    const leadB = -920002;
    const otherBranchLead = -920003;
    const wonApplication = -930001;
    const inventoryApplication = -930002;
    const otherBranchApplication = -930003;
    const rangeParams = [
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      "2026",
      [branchA],
      "2026-07-01T00:00:00.000Z",
    ];

    await client.query(`
      INSERT INTO pipeline_stages (id, entity_type, key, label, sort_order, variant)
      VALUES
        (-940001, 'application', 'reporting_fixture_open', 'Fixture Open', 1, 'open'),
        (-940002, 'application', 'reporting_fixture_submitted', 'Fixture Submitted', 2, 'open'),
        (-940003, 'application', 'reporting_fixture_success', 'Fixture Success', 3, 'won')
      ON CONFLICT (entity_type, key) DO UPDATE
      SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order, variant = EXCLUDED.variant
    `);

    await client.query(`
      INSERT INTO students
        (id, first_name, last_name, email, phone, phone_e164, passport_number, branch_id, season, created_at, updated_at)
      VALUES
        (${studentA}, 'Ada', 'One', 'duplicate.student@example.test', '+90 555 000 0001', '+905550000001', 'AB-123', ${branchA}, '2026', '2026-08-04T10:00:00Z', '2026-08-04T10:00:00Z'),
        (${studentB}, 'Ada', 'Two', ' DUPLICATE.STUDENT@example.test ', '0555 000 0001', '+905550000001', 'AB 123', ${branchA}, '2026', '2026-08-05T10:00:00Z', '2026-08-05T10:00:00Z'),
        (${inventoryStudent}, 'Inventory', 'Only', 'inventory@example.test', NULL, NULL, 'INV-1', ${branchA}, '2026', '2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z'),
        (${otherBranchStudent}, 'Other', 'Branch', 'other@example.test', NULL, NULL, 'OTH-1', ${branchB}, '2026', '2026-08-06T10:00:00Z', '2026-08-06T10:00:00Z'),
        (${nullBranchStudentA}, 'Null', 'One', 'null.branch.duplicate@example.test', NULL, NULL, 'NULL-1', NULL, '2026', '2026-08-07T10:00:00Z', '2026-08-07T10:00:00Z'),
        (${nullBranchStudentB}, 'Null', 'Two', 'NULL.BRANCH.DUPLICATE@example.test', NULL, NULL, 'NULL-2', NULL, '2026', '2026-08-08T10:00:00Z', '2026-08-08T10:00:00Z')
    `);

    await client.query(`
      INSERT INTO leads
        (id, first_name, last_name, email, phone, phone_e164, source, branch_id, season, converted_student_id, created_at, updated_at)
      VALUES
        (${leadA}, 'Lead', 'One', 'duplicate.lead@example.test', '0555 100 0001', '+905551000001', 'web', ${branchA}, '2026', ${studentA}, '2026-08-10T10:00:00Z', '2026-08-10T10:00:00Z'),
        (${leadB}, 'Lead', 'Two', ' DUPLICATE.LEAD@example.test ', '+90 555 100 0001', '+905551000001', NULL, ${branchA}, '2026', NULL, '2026-08-11T10:00:00Z', '2026-08-11T10:00:00Z'),
        (${otherBranchLead}, 'Lead', 'Other', 'other.lead@example.test', NULL, NULL, 'partner', ${branchB}, '2026', ${otherBranchStudent}, '2026-08-12T10:00:00Z', '2026-08-12T10:00:00Z')
    `);

    await client.query(`
      INSERT INTO applications
        (id, student_id, lead_id, season, stage, branch_id, country, created_at, updated_at)
      VALUES
        (${wonApplication}, ${studentA}, ${leadA}, '2026', 'reporting_fixture_success', ${branchA}, 'TR', '2026-08-15T10:00:00Z', '2026-08-15T10:00:00Z'),
        (${inventoryApplication}, ${inventoryStudent}, NULL, '2026', 'reporting_fixture_open', ${branchA}, 'GB', '2026-06-15T10:00:00Z', '2026-06-15T10:00:00Z'),
        (${otherBranchApplication}, ${otherBranchStudent}, NULL, '2026', 'reporting_fixture_open', ${branchB}, 'DE', '2026-08-16T10:00:00Z', '2026-08-16T10:00:00Z')
    `);

    await client.query(`
      INSERT INTO commissions
        (id, application_id, season, currency, university_commission_amount, agent_commission_amount, university_collected, status, confirmed_at)
      VALUES
        (-950001, ${wonApplication}, '2026', 'USD', 1000, 200, 400, 'confirmed', '2026-08-20T10:00:00Z'),
        (-950002, ${wonApplication}, '2026', 'EUR', 500, 100, 500, 'confirmed', '2026-08-21T10:00:00Z')
    `);

    const command = await client.query(commandSummaryQuery, rangeParams);
    assert.equal(Number(command.rows[0]?.applications_current), 1);
    assert.equal(Number(command.rows[0]?.applications_active), 1);
    assert.equal(Number(command.rows[0]?.applications_won), 1);

    const funnel = await client.query(funnelQuery, rangeParams.slice(0, 4));
    assert.equal(Number(funnel.rows[0]?.won), 1);
    assert.equal(Number(funnel.rows[0]?.applications), 1);

    const stages = await client.query(
      applicationStagesQuery,
      rangeParams.slice(0, 4),
    );
    assert.equal(
      stages.rows.reduce((sum, row) => sum + Number(row.inventory_count), 0),
      2,
    );
    assert.equal(
      stages.rows.reduce((sum, row) => sum + Number(row.cohort_count), 0),
      1,
    );

    const currencies = await client.query(
      commissionQuery,
      rangeParams.slice(0, 4),
    );
    assert.deepEqual(
      currencies.rows.map((row) => row.currency),
      ["EUR", "USD"],
    );
    assert.equal(currencies.rows.some((row) => row.currency === null), false);

    const scopedQuality = await client.query(
      reportingQualityQuery,
      rangeParams.slice(0, 4),
    );
    assert.equal(Number(scopedQuality.rows[0]?.duplicate_groups), 5);
    assert.equal(Number(scopedQuality.rows[0]?.duplicate_records), 10);

    const globalQuality = await client.query(reportingQualityQuery, [
      ...rangeParams.slice(0, 3),
      null,
    ]);
    assert.equal(Number(globalQuality.rows[0]?.duplicate_groups), 6);
    assert.equal(Number(globalQuality.rows[0]?.duplicate_records), 12);

    const detailDuplicates = await client.query(`
      WITH ${duplicateCandidatesCte("global")}
      SELECT count(*)::int AS groups, coalesce(sum(record_count), 0)::int AS affected
      FROM duplicate_candidates
    `);
    assert.equal(
      Number(detailDuplicates.rows[0]?.groups),
      Number(globalQuality.rows[0]?.duplicate_groups),
    );
    assert.equal(
      Number(detailDuplicates.rows[0]?.affected),
      Number(globalQuality.rows[0]?.duplicate_records),
    );
  } finally {
    await client.query("ROLLBACK");
  }

  const residue = await client.query(`
    SELECT
      (SELECT count(*) FROM students WHERE id BETWEEN -950999 AND -910000)
      + (SELECT count(*) FROM leads WHERE id BETWEEN -950999 AND -910000)
      + (SELECT count(*) FROM applications WHERE id BETWEEN -950999 AND -910000)
      + (SELECT count(*) FROM commissions WHERE id BETWEEN -950999 AND -910000)
      + (SELECT count(*) FROM pipeline_stages WHERE id BETWEEN -950999 AND -910000)
      AS fixture_rows
  `);
  assert.equal(Number(residue.rows[0]?.fixture_rows), 0);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

console.log(
  `[reporting-postgres] PASS: ${queries.length} bounded projections compiled; 6 semantic golden scenarios passed`,
);
