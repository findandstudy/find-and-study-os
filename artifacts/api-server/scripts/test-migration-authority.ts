import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateMigrationLedger } from "../../../lib/db/validate-migrations.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const indexSource = readFileSync(
  path.join(root, "artifacts/api-server/src/index.ts"),
  "utf8",
);
const pipelineSource = readFileSync(
  path.join(root, "artifacts/api-server/src/routes/pipeline.ts"),
  "utf8",
);

test("all legacy boot DDL, seed and backfill calls are unreachable during API boot", () => {
  const bootStart = indexSource.indexOf("(async () => {");
  const disabledStart = indexSource.indexOf("if (false) {", bootStart);
  const backgroundStart = indexSource.indexOf(
    "const { BackgroundJobCoordinator",
    disabledStart,
  );
  assert(
    bootStart > 0 &&
      disabledStart > bootStart &&
      backgroundStart > disabledStart,
  );
  assert.match(
    indexSource.slice(disabledStart, backgroundStart),
    /CREATE\s+TABLE|ALTER\s+TABLE/i,
  );
  const executableBoot =
    indexSource.slice(bootStart, disabledStart) +
    indexSource.slice(backgroundStart);
  assert.doesNotMatch(
    executableBoot,
    /CREATE\s+(?:TABLE|INDEX|TYPE)|ALTER\s+TABLE/i,
  );
  assert.doesNotMatch(
    executableBoot,
    /await\s+(?:runSeedSQL|seedDocumentTypes|seedCurrencies|backfill[A-Z])/,
  );
  assert.doesNotMatch(
    executableBoot,
    /ensureRateLimitsTable|runDataCleanupOnce/,
  );
});

test("route imports do not invoke the legacy pipeline DDL/backfill block", () => {
  assert.match(
    pipelineSource,
    /async function legacyPipelineBootMigration\(\): Promise<void>/,
  );
  assert.doesNotMatch(
    pipelineSource,
    /(?:await|void)\s+legacyPipelineBootMigration\(\)|legacyPipelineBootMigration\(\);/,
  );
});

test("PostgreSQL rate limiters use the migration-owned table without boot DDL", () => {
  const routeSources = ["auth.ts", "agentOnboarding.ts", "inbox.ts"]
    .map((file) =>
      readFileSync(
        path.join(root, "artifacts/api-server/src/routes", file),
        "utf8",
      ),
    )
    .join("\n");
  assert.equal(routeSources.match(/new RateLimiterPostgres\s*\(/g)?.length, 4);
  assert.equal(routeSources.match(/tableCreated:\s*true/g)?.length, 4);
  assert.match(
    readFileSync(
      path.join(root, "lib/db/drizzle/0001_silly_patriot.sql"),
      "utf8",
    ),
    /CREATE TABLE "rate_limits"/,
  );
});

test("migration validator accepts a coherent disposable ledger fixture", () => {
  const fixture = mkdtempSync(
    path.join(os.tmpdir(), "fasos-migration-ledger-"),
  );
  try {
    const meta = path.join(fixture, "meta");
    mkdirSync(meta);
    const fixtureSqlPath = path.join(fixture, "0000_fixture.sql");
    writeFileSync(fixtureSqlPath, "SELECT 1;\r\n");
    writeFileSync(
      path.join(meta, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: 1,
            tag: "0000_fixture",
            breakpoints: true,
          },
        ],
      }),
    );
    writeFileSync(
      path.join(meta, "production-prefix.json"),
      JSON.stringify({
        schemaVersion: 1,
        sourceRepository: "example/disposable-fixture",
        sourceCommit: "a".repeat(40),
        authoritativeThrough: 0,
        entries: [
          {
            idx: 0,
            tag: "0000_fixture",
            when: 1,
            sha256Lf: createHash("sha256")
              .update("SELECT 1;\n", "utf8")
              .digest("hex"),
          },
        ],
      }),
    );
    assert.deepEqual(
      validateMigrationLedger({
        migrationsDir: fixture,
        journalPath: path.join(meta, "_journal.json"),
      }),
      { files: 1, journalEntries: 1 },
    );
    writeFileSync(fixtureSqlPath, "SELECT 2;\n");
    assert.throws(
      () =>
        validateMigrationLedger({
          migrationsDir: fixture,
          journalPath: path.join(meta, "_journal.json"),
        }),
      /production migration hash drift: 0000_fixture/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("repository migration history is complete, ordered and duplicate-free", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "lib/db/validate-migrations.mjs")],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK: (\d+) files, \1 journal entries/);
});

test("production prefix and canonical additive migration tail are pinned", () => {
  const journal = JSON.parse(
    readFileSync(path.join(root, "lib/db/drizzle/meta/_journal.json"), "utf8"),
  );
  assert.deepEqual(
    journal.entries.slice(54, 66).map((entry: { tag: string }) => entry.tag),
    [
      "0054_agent_applications",
      "0055_agent_application_review_then_sign",
      "0056_contract_email_verification_evidence",
      "0057_agent_application_provisional_portal",
      "0058_pipeline_stage_auto_messages",
      "0059_fas_agency_codes",
      "0060_scoped_record_assignments",
      "0061_pipeline_stage_audiences",
      "0062_agent_tenant_capabilities",
      "0063_finance_mutation_integrity",
      "0064_agent_application_token_expiry",
      "0065_invoice_integrity",
    ],
  );
  assert.deepEqual(
    journal.entries.slice(66).map((entry: { tag: string }) => entry.tag),
    [
      "0066_authorization_corridor_foundation",
      "0067_change_set_control_plane_foundation",
      "0068_change_set_command_idempotency",
      "0069_authorization_control_plane_db_hardening",
      "0070_change_set_evidence_identity_audit_foundation",
      "0071_change_set_postgres_command_adapter",
      "0072_change_set_durable_audit_adapter",
      "0073_change_set_commit_reconciliation",
      "0074_change_set_scheduled_reconciliation",
      "0075_active_context_authoritative_resolver",
      "0076_active_context_session_gateway",
      "0077_active_context_selection_lifecycle",
      "0078_active_context_selection_binding",
      "0079_active_context_selection_consumption",
      "0080_active_context_selection_consumption_attempts",
      "0081_active_context_selection_consumption_repair",
      "0082_student_journey_g45_foundation",
      "0083_institution_admissions_foundation",
      "0084_institution_admissions_authority_hardening",
      "0085_institution_active_context_step_up",
      "0086_institution_case_intake_receipts",
      "0087_institution_evidence_share_receipts",
      "0088_institution_enrolment_evidence_binding",
      "0089_reporting_center_permissions",
      "0090_portal_lifecycle_observations",
      "0091_portal_application_artifact_intake",
      "0092_portal_partner_verification_receipts",
      "0093_portal_program_fallback_active_uniqueness",
      "0094_portal_worker_jobs",
      "0095_portal_submission_intents",
      "0096_portal_lifecycle_proposals",
      "0097_social_operations_foundation",
      "0098_operations_work_read_model_indexes",
      "0099_social_publication_orchestration",
      "0100_social_provider_observability",
      "0101_social_worker_heartbeats",
      "0102_social_media_assets",
      "0103_social_attribution_read_model",
      "0104_social_creative_orchestration",
      "0105_social_ad_control",
      "0106_activity_read_path_indexes",
      "0107_program_content_translations",
      "0108_expand_system_and_program_locales",
    ],
  );

  const portalArtifactMigration = readFileSync(
    path.join(root, "lib/db/drizzle/0091_portal_application_artifact_intake.sql"),
    "utf8",
  );
  assert.match(
    portalArtifactMigration,
    /FOREIGN KEY \(\s*"source_portal_observation_id",\s*"source_portal_submission_id",\s*"application_id"\s*\)/,
  );

  const partnerVerificationMigration = readFileSync(
    path.join(root, "lib/db/drizzle/0092_portal_partner_verification_receipts.sql"),
    "utf8",
  );
  assert.match(partnerVerificationMigration, /"verification_generation" integer NOT NULL DEFAULT 1/);
  assert.match(partnerVerificationMigration, /"verification_type" IN \('TEST_LOGIN', 'STRICT_DRY_RUN'\)/);
  assert.match(partnerVerificationMigration, /portal_partner_verification_receipts_append_only/);
  assert.match(partnerVerificationMigration, /BEFORE UPDATE OR DELETE/);
  assert.doesNotMatch(partnerVerificationMigration, /\b(?:TRUNCATE|DELETE FROM)\b/i);

  const fallbackActiveUniquenessMigration = readFileSync(
    path.join(
      root,
      "lib/db/drizzle/0093_portal_program_fallback_active_uniqueness.sql",
    ),
    "utf8",
  );
  assert.match(
    fallbackActiveUniquenessMigration,
    /CREATE UNIQUE INDEX "portal_prog_fallback_key_source_uniq"[\s\S]*WHERE "deleted_at" IS NULL/,
  );
  assert.doesNotMatch(
    fallbackActiveUniquenessMigration,
    /\b(?:TRUNCATE|DELETE FROM)\b/i,
  );
  assert.match(
    portalArtifactMigration,
    /"source_type" = 'portal_automation'[\s\S]*"uploaded_by" IS NULL[\s\S]*"file_url" LIKE '\/objects\/portal-artifacts\/%'/,
  );

  const attemptMigration = readFileSync(
    path.join(
      root,
      "lib/db/drizzle/0080_active_context_selection_consumption_attempts.sql",
    ),
    "utf8",
  );
  assert.match(
    attemptMigration,
    /CONSTRAINT active_context_selection_consumption_attempts_tenant_id_uq\s+UNIQUE \(tenant_id, id\)/,
  );
  assert.match(
    attemptMigration,
    /FOREIGN KEY \(tenant_id, attempt_id\)\s+REFERENCES public\.active_context_selection_consumption_attempts\(tenant_id, id\)/,
  );

  const socialOperationsMigration = readFileSync(
    path.join(root, "lib/db/drizzle/0097_social_operations_foundation.sql"),
    "utf8",
  );
  assert.match(socialOperationsMigration, /ALTER TABLE public\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(socialOperationsMigration, /social_content_reviews_append_only/);
  assert.match(socialOperationsMigration, /social_performance_snapshots_append_only/);
  assert.match(socialOperationsMigration, /"provider_mode" text NOT NULL DEFAULT 'MANAGED_PROVIDER'/);
  assert.doesNotMatch(socialOperationsMigration, /https:\/\/graph\.facebook\.com|api\.linkedin\.com|open\.tiktokapis\.com/);

  const socialAttributionMigration = readFileSync(
    path.join(root, "lib/db/drizzle/0103_social_attribution_read_model.sql"),
    "utf8",
  );
  assert.match(socialAttributionMigration, /ALTER TABLE "social_attributed_leads" FORCE ROW LEVEL SECURITY/);
  assert.match(socialAttributionMigration, /sync_social_attribution_from_lead/);
  assert.match(socialAttributionMigration, /sync_social_attribution_from_application/);
  assert.match(socialAttributionMigration, /social_attributed_leads_one_touch_uq/);
  assert.doesNotMatch(socialAttributionMigration, /\b(?:TRUNCATE|DELETE FROM)\b/i);

  const socialCreativeMigration = readFileSync(
    path.join(root, "lib/db/drizzle/0104_social_creative_orchestration.sql"),
    "utf8",
  );
  assert.match(socialCreativeMigration, /social_creative_requests_checker_chk/);
  assert.match(socialCreativeMigration, /social_creative_requests_approval_chk/);
  assert.match(socialCreativeMigration, /social_creative_requests_definition_immutable/);
  assert.match(socialCreativeMigration, /social_creative_requests_budget_chk/);
  assert.match(socialCreativeMigration, /social_creative_attempts_append_only/);
  assert.match(socialCreativeMigration, /ALTER TABLE public\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(socialCreativeMigration, /BEFORE UPDATE OR DELETE/);
  assert.doesNotMatch(socialCreativeMigration, /\b(?:TRUNCATE|DELETE FROM)\b/i);

  const socialAdvertisingMigration = readFileSync(
    path.join(root, "lib/db/drizzle/0105_social_ad_control.sql"),
    "utf8",
  );
  assert.match(
    socialAdvertisingMigration,
    /social_ad_campaigns_definition_immutable/,
  );
  assert.match(
    socialAdvertisingMigration,
    /social_ad_operations_one_inflight_campaign_idx/,
  );
  assert.match(
    socialAdvertisingMigration,
    /social_ad_operation_reviews_append_only/,
  );
  assert.match(
    socialAdvertisingMigration,
    /social_ad_operation_attempts_append_only/,
  );
  assert.match(socialAdvertisingMigration, /social_ad_campaigns_approval_chk/);
  assert.match(socialAdvertisingMigration, /social_ad_operations_approval_chk/);
  assert.match(
    socialAdvertisingMigration,
    /ALTER TABLE public\.%I FORCE ROW LEVEL SECURITY/,
  );
  assert.match(socialAdvertisingMigration, /'advertising'/);
  assert.doesNotMatch(
    socialAdvertisingMigration,
    /\b(?:TRUNCATE|DELETE FROM)\b/i,
  );

  const activityReadPathMigration = readFileSync(
    path.join(root, "lib/db/drizzle/0106_activity_read_path_indexes.sql"),
    "utf8",
  );
  for (const indexName of [
    "user_sessions_activity_user_started_idx",
    "user_sessions_activity_overlap_idx",
    "user_sessions_activity_active_last_seen_idx",
    "user_page_visits_user_entered_idx",
    "user_page_visits_module_entered_idx",
    "user_activity_events_user_created_idx",
    "user_presence_status_last_active_idx",
  ]) {
    assert.match(activityReadPathMigration, new RegExp(indexName));
  }
  assert.doesNotMatch(
    activityReadPathMigration,
    /\b(?:TRUNCATE|DELETE FROM|UPDATE)\b/i,
  );
});

test("Student Journey G45 migration remains additive, tenant-forced and default-off", () => {
  const migration = readFileSync(
    path.join(root, "lib/db/drizzle/0082_student_journey_g45_foundation.sql"),
    "utf8",
  );
  assert.match(migration, /'student\.journey\.read'/);
  assert.match(migration, /'student\.document_request\.respond'/);
  assert.match(migration, /'student\.dossier\.verify'/);
  assert.doesNotMatch(migration, /INSERT INTO\s+role_package_capabilities/i);
  assert.match(migration, /ALTER TABLE public\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /journey_notification_intents_default_off_chk/);
  assert.match(migration, /consent_evidence_kind" = 'VERIFIED_EVIDENCE'/);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET row_security TO on/);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION "fas_journey_v1"\."revalidate_document_request_response_authority"/,
  );
  assert.doesNotMatch(migration, /https?:\/\//);
});

test("migration validator rejects duplicate ids and non-monotonic journal timestamps", () => {
  const fixture = mkdtempSync(
    path.join(os.tmpdir(), "fasos-invalid-migration-ledger-"),
  );
  try {
    const meta = path.join(fixture, "meta");
    mkdirSync(meta);
    writeFileSync(path.join(fixture, "0000_first.sql"), "SELECT 1;\n");
    writeFileSync(path.join(fixture, "0000_second.sql"), "SELECT 2;\n");
    writeFileSync(
      path.join(meta, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: 2,
            tag: "0000_first",
            breakpoints: true,
          },
          {
            idx: 1,
            version: "7",
            when: 1,
            tag: "0000_second",
            breakpoints: true,
          },
        ],
      }),
    );
    assert.throws(
      () =>
        validateMigrationLedger({
          migrationsDir: fixture,
          journalPath: path.join(meta, "_journal.json"),
        }),
      /duplicate ids: 0000=.*journal timestamps must increase/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("all drizzle push entrypoints reject production, staging and unclassified targets before DB access", () => {
  for (const entrypoint of ["guard-push.mjs", "retry-push.mjs"]) {
    for (const target of ["production", "staging", ""]) {
      const result = spawnSync(
        process.execPath,
        [path.join(root, "lib/db", entrypoint)],
        {
          cwd: path.join(root, "lib/db"),
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_ENV: "",
            MIGRATION_TARGET_ENV: target,
            ALLOW_LOCAL_DRIZZLE_PUSH: "true",
          },
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /unclassified targets are forbidden/);
    }
  }
});

test("legacy pre-migration cleanup is explicit and local-only", () => {
  for (const target of ["production", "staging", ""]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "lib/db/pre-migrate.mjs")],
      {
        cwd: path.join(root, "lib/db"),
        encoding: "utf8",
        env: {
          ...process.env,
          MIGRATION_TARGET_ENV: target,
          ALLOW_PRE_MIGRATION_CLEANUP: "true",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must explicitly be local/);
  }
});

test("db restore helper rejects unclassified and production-like targets before commands", (t) => {
  const bashProbe = spawnSync("bash", ["-c", "exit 0"], {
    encoding: "utf8",
  });
  if (bashProbe.error || bashProbe.status !== 0) {
    t.skip("a working bash runtime is unavailable on this host");
    return;
  }
  const script = path.join(root, "scripts/db-migrate.sh");
  const unclassified = spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(unclassified.status, 1);
  assert.match(unclassified.stderr, /MIGRATION_TARGET_ENV/);
  const production = spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MIGRATION_TARGET_ENV: "production",
      ALLOW_LOCAL_DB_MIGRATION: "true",
    },
  });
  assert.equal(production.status, 1);
  assert.match(production.stderr, /forbidden for production\/staging targets/);
});

test("migration command requires explicit approval and has no push fallback", () => {
  const runner = spawnSync(
    process.execPath,
    [path.join(root, "lib/db/run-migrations.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(runner.status, 1);
  assert.match(runner.stderr, /ALLOW_REVIEWED_MIGRATIONS=true/);
  const dbMigrate = readFileSync(
    path.join(root, "scripts/db-migrate.sh"),
    "utf8",
  );
  assert.doesNotMatch(dbMigrate, /drizzle-kit\s+push|run push|push-force/);
  assert.match(dbMigrate, /set -eo pipefail/);
  assert.match(
    dbMigrate,
    /Refusing to run migrations against a partial or unverified restore/,
  );
});

test("reviewed migration runner pins target identity and package manager", () => {
  const runner = path.join(root, "lib/db/run-migrations.mjs");
  const remote = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_REVIEWED_MIGRATIONS: "true",
      MIGRATION_TARGET_ENV: "development",
      DATABASE_URL:
        "postgresql://fas_migrator:blocked@db.example.test:5433/fas_dev_blocked",
      MIGRATION_CONFIRMED_HOST: "db.example.test",
      MIGRATION_CONFIRMED_PORT: "5433",
      MIGRATION_CONFIRMED_DATABASE: "fas_dev_blocked",
      MIGRATION_CONFIRMED_USER: "fas_migrator",
    },
  });
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /local\/development migrations require loopback/);

  const production = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_REVIEWED_MIGRATIONS: "true",
      MIGRATION_TARGET_ENV: "production",
      DATABASE_URL:
        "postgresql://fas_migrator:blocked@db.example.test:5432/fasos",
    },
  });
  assert.equal(production.status, 1);
  assert.match(production.stderr, /dedicated long-lived adoption runner/);

  const malformed = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_REVIEWED_MIGRATIONS: "true",
      MIGRATION_TARGET_ENV: "test",
      DATABASE_URL: "postgresql://do-not-print-this@[",
    },
  });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /DATABASE_URL is malformed/);
  assert.doesNotMatch(malformed.stderr, /do-not-print-this/);

  const source = readFileSync(runner, "utf8");
  assert.match(source, /identityClient\.connectionParameters/);
  assert.match(source, /current_database\(\) AS database_name/);
  assert.match(source, /pg_auth_members/);
  assert.match(source, /MIGRATION_CONFIRMED_DATABASE/);
  assert.match(source, /EXPECTED_PNPM_VERSION = "10\.33\.2"/);
  assert.match(source, /FAS_REVIEWED_PNPM_CLI/);
  assert.match(source, /process\.platform === "win32"/);
});

test("staging adoption runner is explicit, exact-source and loopback-only", () => {
  const runner = path.join(root, "lib/db/run-staging-migrations.mjs");
  const unapproved = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stderr, /ALLOW_STAGING_MIGRATIONS=true is required/);

  const remote = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_STAGING_MIGRATIONS: "true",
      MIGRATION_TARGET_ENV: "staging",
      MIGRATION_STAGING_CHANGE_ID: "stg-20260901T120000Z-68447daeae79",
      MIGRATION_EXPECTED_SOURCE_COMMIT:
        "68447daeae79fdc186db7b1b4e9901ba5bf5c83a",
      DATABASE_URL:
        "postgresql://fas_migrator:blocked@db.example.test:55432/fasos_staging",
    },
  });
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /127\.0\.0\.1/);
  assert.doesNotMatch(remote.stderr, /blocked/);

  const source = readFileSync(runner, "utf8");
  assert.match(source, /MIGRATION_EXPECTED_SOURCE_COMMIT/);
  assert.match(source, /endsWith\(expectedCommit\.slice\(0, 12\)\)/);
  assert.match(source, /--untracked-files=no/);
  assert.match(source, /MIGRATION_EXPECTED_APPLIED_COUNT/);
  assert.match(source, /MIGRATION_STAGING_BACKUP_ID/);
  assert.match(source, /pg_try_advisory_lock/);
  assert.match(source, /MIGRATION_CONFIRMED_SERVER_ADDRESS/);
  assert.match(source, /MIGRATION_CONFIRMED_SERVER_PORT/);
  assert.match(source, /after\.applied !== expectedMigrations\.length/);
  assert.match(source, /EXPECTED_PNPM_VERSION = "10\.33\.2"/);
  assert.doesNotMatch(source, /drizzle-kit", "push/);
});

test("staging seed is synthetic, explicit and pinned to the fresh 109/109 database", () => {
  const seed = path.join(root, "deploy/staging/seed-staging.mjs");
  const unapproved = spawnSync(process.execPath, [seed], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stderr, /ALLOW_STAGING_SEED=true is required/);

  const source = readFileSync(seed, "utf8");
  assert.match(source, /target\.hostname !== "127\.0\.0\.1"/);
  assert.match(source, /target\.pathname !== "\/fasos_staging"/);
  assert.match(source, /row\?\.migration_count !== 109/);
  assert.match(source, /row\?\.user_count !== 0/);
  assert.match(source, /staging-admin@findandstudy\.com/);
  assert.match(source, /await client\.query\("BEGIN"\)/);
  assert.match(source, /await client\.query\("ROLLBACK"\)/);
});

test("staging RBAC UAT fixtures are explicit, synthetic and denominator-bound", () => {
  const seed = path.join(root, "deploy/staging/seed-staging-rbac-uat.mjs");
  const unapproved = spawnSync(process.execPath, [seed], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(unapproved.status, 1);
  assert.match(
    unapproved.stderr,
    /ALLOW_STAGING_RBAC_UAT_SEED=true is required/,
  );

  const remote = spawnSync(process.execPath, [seed], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_STAGING_RBAC_UAT_SEED: "true",
      STAGING_TARGET_ENV: "staging",
      ALLOW_LIVE_INTEGRATIONS: "false",
      RBAC_E2E_PASSWORD: "Not-A-Real-Staging-Password-2026!",
      STAGING_EXPECTED_SOURCE_COMMIT:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      STAGING_UAT_CHANGE_ID: "stg-uat-20260902T120000Z-aaaaaaaaaaaa",
      STAGING_UAT_EXPECTED_PRE_USER_COUNT: "1",
      DATABASE_URL:
        "postgresql://fas_migrator:do-not-print-this@db.example.test:5432/fasos_staging",
    },
  });
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /exact loopback:5432\/fasos_staging/);
  assert.doesNotMatch(remote.stderr, /do-not-print-this/);

  const source = readFileSync(seed, "utf8");
  assert.match(source, /target\.hostname !== "127\.0\.0\.1"/);
  assert.match(source, /target\.port !== "5432"/);
  assert.match(source, /target\.pathname !== "\/fasos_staging"/);
  assert.match(source, /STAGING_TARGET_ENV !== "staging"/);
  assert.match(source, /ALLOW_LIVE_INTEGRATIONS !== "false"/);
  assert.match(source, /identityRow\?\.migration_count !== 109/);
  assert.match(source, /STAGING_UAT_EXPECTED_PRE_USER_COUNT/);
  assert.match(source, /a non-synthetic or unrecognized user exists/);
  assert.match(source, /created_from_source = 'staging_rbac_uat'/);
  assert.match(source, /fixture_users !== 11/);
  assert.match(source, /total_users !== 12/);
  assert.match(source, /await client\.query\("BEGIN"\)/);
  assert.match(source, /await client\.query\("ROLLBACK"\)/);
  assert.doesNotMatch(source, /TRUNCATE|DROP\s+(?:TABLE|DATABASE)/i);
});

test("staging RBAC browser gate targets only exact HTTPS staging and read surfaces", () => {
  const config = readFileSync(
    path.join(root, "playwright.staging.config.ts"),
    "utf8",
  );
  const spec = readFileSync(
    path.join(root, "artifacts/edcons/tests/e2e/rbac-functional.spec.ts"),
    "utf8",
  );
  assert.match(
    config,
    /EXACT_STAGING_ORIGIN = "https:\/\/staging\.findandstudy\.com"/,
  );
  assert.match(config, /ALLOW_STAGING_RBAC_UAT !== "true"/);
  assert.match(config, /ALLOW_LIVE_INTEGRATIONS !== "false"/);
  assert.match(config, /fullyParallel: false/);
  assert.match(config, /workers: 1/);
  assert.match(config, /trace: "off"/);
  assert.doesNotMatch(config, /globalSetup|globalTeardown|webServer/);
  assert.match(spec, /new URL\("\/api", BASE_URL\)/);
  assert.equal(
    spec.match(/request\.post\(/g)?.length,
    1,
    "only the synthetic login request may use POST",
  );
  assert.doesNotMatch(spec, /request\.(?:put|patch|delete)\(/);
});

test("staging RBAC API runner is release-bound and performs no business mutation", () => {
  const runner = path.join(root, "deploy/staging/run-staging-rbac-uat.mjs");
  const unapproved = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stderr, /ALLOW_STAGING_RBAC_UAT=true is required/);

  const source = readFileSync(runner, "utf8");
  assert.match(
    source,
    /EXACT_STAGING_ORIGIN = "https:\/\/staging\.findandstudy\.com"/,
  );
  assert.match(source, /ALLOW_LIVE_INTEGRATIONS !== "false"/);
  assert.match(source, /STAGING_EXPECTED_SOURCE_COMMIT/);
  assert.match(source, /STAGING_EXPECTED_RELEASE_ID/);
  assert.match(source, /healthBody\?\.dbConnected !== true/);
  assert.match(source, /healthBody\?\.releaseId !== expectedReleaseId/);
  assert.equal(
    source.match(/method: "POST"/g)?.length,
    2,
    "only synthetic login and logout may use POST",
  );
  assert.doesNotMatch(source, /method: "(?:PUT|PATCH|DELETE)"/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /AbortSignal\.timeout\(10_000\)/);
  assert.equal(
    source.match(/\["\/api\/agents\/me", \[403, 404\]\]/g)?.length,
    2,
    "non-agent profiles must remain denied without overfitting 403 versus 404",
  );
  assert.doesNotMatch(
    source,
    /console\.(?:log|error)\([^\n]*(?:password|cookie|sid)/i,
  );
});

test("staging database initialization creates only fixed least-privilege identities", () => {
  const init = readFileSync(
    path.join(root, "deploy/staging/init-staging-db.sh"),
    "utf8",
  );
  assert.match(init, /CREATE ROLE fas_migrator/);
  assert.match(init, /CREATE ROLE fas_app/);
  assert.match(init, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/);
  assert.match(init, /NOREPLICATION NOBYPASSRLS/);
  assert.match(init, /createdb .*--owner fas_migrator fasos_staging/);
  assert.match(init, /REVOKE ALL ON DATABASE fasos_staging FROM PUBLIC/);
  assert.match(init, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
  assert.match(init, /ALTER DEFAULT PRIVILEGES FOR ROLE fas_migrator/);
  assert.doesNotMatch(init, /DROP DATABASE|DROP ROLE|TRUNCATE/);
});

test("production-prefix adoption harness is explicit and loopback-only", () => {
  const harness = path.join(root, "lib/db/test-production-prefix-adoption.mjs");
  const unapproved = spawnSync(process.execPath, [harness], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stderr, /ALLOW_DISPOSABLE_PREFIX_ADOPTION=true/);

  const remote = spawnSync(process.execPath, [harness], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_DISPOSABLE_PREFIX_ADOPTION: "true",
      DATABASE_URL:
        "postgresql://fas_migrator:blocked@db.example.test:5433/fasos_apply_local",
    },
  });
  assert.equal(remote.status, 1);
  assert.match(
    remote.stderr,
    /only postgresql:\/\/fas_migrator@127\.0\.0\.1:5433/,
  );

  const source = readFileSync(harness, "utf8");
  assert.match(source, /prefix adoption requires a fresh disposable database/);
  assert.match(source, /productionEntries\.length, 66/);
  assert.match(source, /canonicalMigrationCount = journal\.entries\.length/);
  assert.match(source, /count: canonicalMigrationCount/);
});

test("disposable database reset is explicit and fixed to the local test identity", () => {
  const resetTool = path.join(
    root,
    "lib/db/prepare-disposable-migration-database.mjs",
  );
  const unapproved = spawnSync(process.execPath, [resetTool], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stderr, /ALLOW_DISPOSABLE_DATABASE_RESET=true/);

  const remote = spawnSync(process.execPath, [resetTool], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_DISPOSABLE_DATABASE_RESET: "true",
      PG_DISPOSABLE_ADMIN_URL:
        "postgresql://postgres:blocked@db.example.test:5433/postgres",
    },
  });
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /only postgresql:\/\/postgres@127\.0\.0\.1:5433/);

  const source = readFileSync(resetTool, "utf8");
  assert.match(source, /DROP DATABASE IF EXISTS fasos_apply_local/);
  assert.match(source, /CREATE DATABASE fasos_apply_local OWNER fas_migrator/);
  assert.match(source, /NOINHERIT NOREPLICATION NOBYPASSRLS/);
  assert.match(source, /pg_auth_members/);
  assert.match(source, /fas_cp_owner/);
  assert.match(source, /fas_cp_executor/);
  assert.match(source, /fas_evidence_owner/);
  assert.match(source, /fas_evidence_issuer/);
  assert.match(source, /fas_auth_context_owner/);
  assert.match(source, /fas_auth_context_resolver/);
  assert.match(source, /fas_app/);
  assert.match(source, /fas_audit_owner/);
  assert.match(source, /fas_audit_writer/);
  assert.match(source, /fas_repair_owner/);
  assert.match(source, /fas_repair_worker/);
  assert.match(source, /fas_session_owner/);
  assert.match(source, /fas_session_resolver/);
  assert.match(source, /fas_rate_limit_owner/);
  assert.match(source, /fas_rate_limit_executor/);
  assert.match(source, /fas_session_lifecycle_owner/);
  assert.match(source, /fas_session_lifecycle_executor/);
  assert.match(source, /fas_session_repair_owner/);
  assert.match(source, /fas_session_repair_executor/);
  assert.match(source, /fas_journey_owner/);
  assert.match(source, /fas_journey_executor/);
  assert.match(source, /fas_institution_executor/);
});

test("PostgreSQL adapter integration is explicit and fixed to the disposable target", () => {
  const adapterTest = path.join(
    root,
    "artifacts/api-server/scripts/test-postgres-change-set-adapter.ts",
  );
  const unapproved = spawnSync(
    process.execPath,
    ["--import", "tsx", adapterTest],
    {
      cwd: path.join(root, "artifacts/api-server"),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(unapproved.status, 1);
  assert.match(
    unapproved.stderr,
    /ALLOW_DISPOSABLE_ADAPTER_TEST=true is required/,
  );

  const source = readFileSync(adapterTest, "utf8");
  assert.match(source, /assert\.equal\(databaseName, "fasos_apply_local"\)/);
  assert.match(source, /assert\.equal\(parsed\.port, "5433"\)/);
  assert.match(source, /\[executorUrl, "fas_cp_executor"\]/);
  assert.match(source, /\[evidenceIssuerUrl, "fas_evidence_issuer"\]/);
  assert.match(source, /\[contextResolverUrl, "fas_auth_context_resolver"\]/);
});

test("comprehensive Control Plane gate is explicit and fixed to the disposable target", () => {
  const controlPlaneTest = path.join(
    root,
    "artifacts/api-server/scripts/test-postgres-control-plane-gate.ts",
  );
  const unapproved = spawnSync(
    process.execPath,
    ["--import", "tsx", controlPlaneTest],
    {
      cwd: path.join(root, "artifacts/api-server"),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(unapproved.status, 1);
  assert.match(
    unapproved.stderr,
    /ALLOW_DISPOSABLE_CONTROL_PLANE_GATE=true is required/,
  );

  const source = readFileSync(controlPlaneTest, "utf8");
  assert.match(
    source,
    /target\.pathname\.slice\(1\),[\s\S]*?isDynamicCiTarget \? dynamicCiDatabase : "fasos_apply_local"/,
  );
  assert.match(source, /target\.port, isDynamicCiTarget \? "5432" : "5433"/);
  assert.match(
    source,
    /assert\.equal\(migrationCount\.rows\[0\]\.count, 109\)/,
  );
  assert.match(
    source,
    /verifyAtomicDdlRollback[\s\S]*?SELECT count\(\*\)::int AS count FROM drizzle\.__drizzle_migrations[\s\S]*?109/,
  );
  assert.match(
    source,
    /if \(isDynamicCiTarget\) \{[\s\S]*CREATE ROLE \$\{role\.name\}[\s\S]*NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/,
  );
});

test("Student Journey G45 PostgreSQL integration is explicit and loopback-only", () => {
  const journeyTest = path.join(
    root,
    "artifacts/api-server/scripts/test-postgres-student-journey-g45.ts",
  );
  const unapproved = spawnSync(
    process.execPath,
    ["--import", "tsx", journeyTest],
    {
      cwd: path.join(root, "artifacts/api-server"),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(unapproved.status, 1);
  assert.match(
    unapproved.stderr,
    /ALLOW_DISPOSABLE_STUDENT_JOURNEY_G45_TEST=true is required/,
  );

  const source = readFileSync(journeyTest, "utf8");
  assert.match(source, /target\.hostname, "127\.0\.0\.1"/);
  assert.match(source, /target\.port, "5433"/);
  assert.match(source, /target\.pathname, "\/fasos_apply_local"/);
  assert.match(source, /safeTarget\(executorUrl, "fas_journey_executor"\)/);
  assert.match(source, /ALLOW_LIVE_INTEGRATIONS/);
  assert.match(source, /rows\[0\]\?\.count, 109/);
  assert.match(source, /journey_notification_intents_default_off_chk/);
  assert.match(
    source,
    /REVOKE ALL ON TABLE public\.\$\{table\} FROM fas_journey_executor/,
  );
});

test("Institution Admissions PostgreSQL integration is explicit and least-privilege", () => {
  const institutionTest = path.join(
    root,
    "artifacts/api-server/scripts/test-postgres-institution-admissions.ts",
  );
  const unapproved = spawnSync(
    process.execPath,
    ["--import", "tsx", institutionTest],
    {
      cwd: path.join(root, "artifacts/api-server"),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(unapproved.status, 1);
  assert.match(
    unapproved.stderr,
    /institution_postgres_test_requires_explicit_disposable_opt_in/,
  );

  const source = readFileSync(institutionTest, "utf8");
  assert.match(source, /ALLOW_DISPOSABLE_INSTITUTION_ADMISSIONS_TEST/);
  assert.match(
    source,
    /institution_postgres_test_requires_disposable_loopback_database/,
  );
  assert.match(
    source,
    /new URL\(actorUrl\)\.username !== "fas_institution_executor"/,
  );
  assert.match(
    source,
    /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS/,
  );
  assert.match(source, /migrationCount\.rows\[0\]\?\.count, 109/);
  assert.match(source, /GRANT SELECT ON TABLE institution_memberships/);
  assert.doesNotMatch(source, /GRANT SELECT, INSERT ON TABLE institution_memberships/);
  assert.match(source, /institution_step_up_receipts/);
});

test("Institution case intake integration is explicit and EXECUTE-only", () => {
  const intakeTest = path.join(
    root,
    "artifacts/api-server/scripts/test-postgres-institution-case-intake.ts",
  );
  const unapproved = spawnSync(
    process.execPath,
    ["--import", "tsx", intakeTest],
    {
      cwd: path.join(root, "artifacts/api-server"),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(unapproved.status, 1);
  assert.match(
    unapproved.stderr,
    /institution_case_intake_test_requires_explicit_disposable_opt_in/,
  );

  const source = readFileSync(intakeTest, "utf8");
  assert.match(source, /institution_case_intake_test_requires_disposable_loopback_database/);
  assert.match(source, /fas_institution_intake_executor/);
  assert.match(source, /fas_institution_intake_owner/);
  assert.match(source, /migrationCount\.rows\[0\]\?\.count, 109/);
  assert.match(source, /case_insert: false/);
  assert.match(source, /receipt_insert: false/);
  assert.match(source, /can_execute: true/);
  assert.match(source, /shared_profile/);
});

test("Institution evidence sharing integration is explicit and EXECUTE-only", () => {
  const evidenceTest = path.join(
    root,
    "artifacts/api-server/scripts/test-postgres-institution-evidence-share.ts",
  );
  const unapproved = spawnSync(
    process.execPath,
    ["--import", "tsx", evidenceTest],
    {
      cwd: path.join(root, "artifacts/api-server"),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(unapproved.status, 1);
  assert.match(
    unapproved.stderr,
    /institution_evidence_share_test_requires_explicit_disposable_opt_in/,
  );

  const source = readFileSync(evidenceTest, "utf8");
  assert.match(source, /institution_evidence_share_test_requires_disposable_loopback_database/);
  assert.match(source, /fas_institution_evidence_share_executor/);
  assert.match(source, /fas_institution_evidence_owner/);
  assert.match(source, /rows\[0\]\?\.count, 109/);
  assert.match(source, /evidence_select: false/);
  assert.match(source, /consent_select: false/);
  assert.match(source, /share_insert: false/);
  assert.match(source, /can_execute: true/);
  assert.match(source, /RAW_EVIDENCE_REF/);
  assert.match(source, /WITHDRAWN/);
});

test("durable audit integration is explicit and fixed to the disposable target", () => {
  const auditTest = path.join(
    root,
    "artifacts/api-server/scripts/test-postgres-change-set-audit.ts",
  );
  const unapproved = spawnSync(
    process.execPath,
    ["--import", "tsx", auditTest],
    {
      cwd: path.join(root, "artifacts/api-server"),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(unapproved.status, 1);
  assert.match(
    unapproved.stderr,
    /ALLOW_DISPOSABLE_AUDIT_TEST=true is required/,
  );

  const source = readFileSync(auditTest, "utf8");
  assert.match(source, /assert\.equal\(databaseName, "fasos_apply_local"\)/);
  assert.match(source, /assert\.equal\(parsed\.port, "5433"\)/);
  assert.match(source, /\[auditWriterUrl, "fas_audit_writer"\]/);
  assert.match(source, /\[repairWorkerUrl, "fas_repair_worker"\]/);
});

test("active-context PostgreSQL session integration is explicit and fixed to the disposable target", () => {
  const sessionTest = path.join(
    root,
    "artifacts/api-server/scripts/test-postgres-active-context-session-gateway.ts",
  );
  const unapproved = spawnSync(
    process.execPath,
    ["--import", "tsx", sessionTest],
    {
      cwd: path.join(root, "artifacts/api-server"),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(unapproved.status, 1);
  assert.match(
    unapproved.stderr,
    /ALLOW_DISPOSABLE_SESSION_GATEWAY_TEST=true is required/,
  );

  const source = readFileSync(sessionTest, "utf8");
  assert.match(source, /assert\.equal\(databaseName, "fasos_apply_local"\)/);
  assert.match(source, /assert\.equal\(parsed\.port, "5433"\)/);
  assert.match(source, /\[sessionResolverUrl, "fas_session_resolver"\]/);
  assert.match(source, /\[rateLimitUrl, "fas_rate_limit_executor"\]/);
  assert.match(source, /\[lifecycleUrl, "fas_session_lifecycle_executor"\]/);
  assert.match(source, /\[repairUrl, "fas_session_repair_executor"\]/);
});

test("live-first CI pins actions and PostgreSQL while replaying both adoption paths", () => {
  const workflow = readFileSync(
    path.join(root, ".github/workflows/live-first-convergence.yml"),
    "utf8",
  );
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(
    workflow,
    /postgres:16\.15@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5/,
  );
  assert.match(workflow, /prepare-disposable-migration-database\.mjs/);
  assert.equal(workflow.match(/node \.\/run-migrations\.mjs/g)?.length, 4);
  assert.equal(
    workflow.match(/test-production-prefix-adoption\.mjs/g)?.length,
    2,
    "foundation and adapter fixtures must use isolated prefix-adoption databases",
  );
  assert.match(workflow, /test:postgres-student-journey-g45/);
  assert.match(workflow, /ALLOW_DISPOSABLE_STUDENT_JOURNEY_G45_TEST/);
  assert.match(workflow, /ALLOW_LIVE_INTEGRATIONS: "false"/);
  assert.match(workflow, /test:postgres-institution-case-intake/);
  assert.match(workflow, /ALLOW_DISPOSABLE_INSTITUTION_CASE_INTAKE_TEST/);
  assert.match(workflow, /test:postgres-institution-evidence-share/);
  assert.match(workflow, /ALLOW_DISPOSABLE_INSTITUTION_EVIDENCE_SHARE_TEST/);
  assert.doesNotMatch(workflow, /uses:\s+[^\s@]+@(?![a-f0-9]{40}\b)/);
});

test("staging CI is isolated, exact-source and integration-disabled", () => {
  const workflow = readFileSync(
    path.join(root, ".github/workflows/staging-adoption.yml"),
    "utf8",
  );
  const compose = readFileSync(
    path.join(root, "deploy/staging/compose.yml"),
    "utf8",
  );
  const composeEnv = readFileSync(
    path.join(root, "deploy/staging/compose.env.example"),
    "utf8",
  );
  const appEnv = readFileSync(
    path.join(root, "deploy/staging/app.env.example"),
    "utf8",
  );
  const dockerfile = readFileSync(
    path.join(root, "deploy/staging/Dockerfile"),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /STAGING_BASE_COMMIT: 68447daeae79fdc186db7b1b4e9901ba5bf5c83a/,
  );
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /git diff --check/);
  assert.match(workflow, /ALLOW_LIVE_INTEGRATIONS: "false"/);
  assert.match(
    workflow,
    /docker compose -f deploy\/staging\/compose\.yml config --quiet/,
  );
  assert.match(workflow, /FASOS_SOURCE_COMMIT="\$\{GITHUB_SHA\}"/);
  assert.match(
    workflow,
    /test "\$\(pnpm --version\)" = "10\.33\.2"/,
  );
  assert.match(
    dockerfile,
    /FROM \$\{NODE_IMAGE\} AS runtime[\s\S]*ENV COREPACK_HOME=\/usr\/local\/share\/corepack[\s\S]*corepack prepare pnpm@10\.33\.2 --activate[\s\S]*test "\$\(pnpm --version\)" = "10\.33\.2"/,
  );
  assert.match(workflow, /docker run --rm --network none --read-only --tmpfs/);
  assert.match(workflow, /test:migration-authority/);
  assert.match(workflow, /test:rate-limit-ip-security/);
  assert.match(workflow, /test:login-accessibility/);
  assert.match(workflow, /FASOS_STAGING_LEGACY_HOST/);
  assert.match(
    workflow,
    /playwright test --config=playwright\.staging\.config\.ts --list/,
  );
  assert.match(compose, /Host\(`\$\{FASOS_STAGING_HOST:\?set FASOS_STAGING_HOST\}`\)/);
  assert.match(
    compose,
    /Host\(`\$\{FASOS_STAGING_LEGACY_HOST:\?set FASOS_STAGING_LEGACY_HOST\}`\)/,
  );
  assert.match(composeEnv, /^FASOS_STAGING_HOST=staging\.findandstudy\.com$/m);
  assert.match(
    composeEnv,
    /^FASOS_STAGING_LEGACY_HOST=staging\.srv1110168\.hstgr\.cloud$/m,
  );
  assert.match(
    appEnv,
    /^ALLOWED_ORIGINS=https:\/\/staging\.findandstudy\.com,https:\/\/staging\.srv1110168\.hstgr\.cloud$/m,
  );
  assert.match(workflow, /runs-on: windows-latest/);
  assert.doesNotMatch(workflow, /\b(?:ssh|scp|rsync|kubectl)\b/i);
  assert.doesNotMatch(workflow, /uses:\s+[^\s@]+@(?![a-f0-9]{40}\b)/);
});

test("ledger baseline requires explicit audit and exact database confirmation before DB access", () => {
  const baseline = spawnSync(
    process.execPath,
    [path.join(root, "lib/db/baseline-migrations.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: "postgresql://invalid.example/blocked",
        MIGRATION_TARGET_ENV: "test",
      },
    },
  );
  assert.equal(baseline.status, 1);
  assert.match(
    baseline.stderr,
    /ALLOW_MIGRATION_BASELINE=true and MIGRATION_SCHEMA_AUDIT_CONFIRMED=true/,
  );

  const source = readFileSync(
    path.join(root, "lib/db/baseline-migrations.mjs"),
    "utf8",
  );
  assert.match(source, /MIGRATION_BASELINE_CONFIRMED_DB/);
  assert.match(source, /MIGRATION_BASELINE_THROUGH_TAG/);
  assert.match(source, /unknown MIGRATION_BASELINE_THROUGH_TAG/);
  assert.match(source, /expectedMigrations\.slice\(0, throughIndex \+ 1\)/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.doesNotMatch(
    source,
    /(?:DELETE|UPDATE|TRUNCATE)\s+(?:FROM\s+)?(?:public\.)?(?:students|leads|applications|documents)/i,
  );
});
