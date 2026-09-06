-- Provider account verification and bounded performance collection.
-- External calls remain default-off and are performed only by the API/worker
-- after the runtime allowlists and integration kill switches are satisfied.

ALTER TABLE "social_accounts"
  ADD COLUMN "verification_receipt_hash" text,
  ADD COLUMN "verified_at" timestamptz,
  ADD COLUMN "last_verification_at" timestamptz,
  ADD COLUMN "last_verification_error_code" text;

-- v1 could label an account VERIFIED without an immutable provider receipt.
-- Such rows are intentionally returned to the connection-test queue.
UPDATE "social_accounts"
SET "status" = 'CONNECTED_UNVERIFIED', "updated_at" = now()
WHERE "status" = 'VERIFIED';

ALTER TABLE "social_accounts"
  ADD CONSTRAINT "social_accounts_verification_hash_chk"
    CHECK ("verification_receipt_hash" IS NULL OR "verification_receipt_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "social_accounts_verified_evidence_chk"
    CHECK (
      "status" <> 'VERIFIED'
      OR
      ("status" = 'VERIFIED'
        AND "external_account_ref_hash" ~ '^[0-9a-f]{64}$'
        AND "verification_receipt_hash" ~ '^[0-9a-f]{64}$'
        AND "verified_at" IS NOT NULL
        AND "last_verification_at" IS NOT NULL)
    ),
  ADD CONSTRAINT "social_accounts_verification_error_chk"
    CHECK ("last_verification_error_code" IS NULL OR "last_verification_error_code" ~ '^[A-Z][A-Z0-9_]{2,95}$');

CREATE TABLE "social_account_verifications" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "actor_legacy_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "request_key" text NOT NULL,
  "outcome" text NOT NULL,
  "provider_request_hash" text NOT NULL,
  "provider_receipt_hash" text,
  "external_account_ref_hash" text,
  "error_code" text,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_account_verifications_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "social_account_verifications_account_fk"
    FOREIGN KEY ("tenant_id", "account_id")
    REFERENCES "social_accounts"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_account_verifications_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_account_verifications_request_uq" UNIQUE ("tenant_id", "request_key"),
  CONSTRAINT "social_account_verifications_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_account_verifications_key_chk"
    CHECK (length("request_key") BETWEEN 8 AND 160 AND "request_key" ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT "social_account_verifications_outcome_chk"
    CHECK ("outcome" IN ('VERIFIED', 'RETRYABLE_FAILURE', 'REAUTH_REQUIRED')),
  CONSTRAINT "social_account_verifications_hash_chk"
    CHECK (
      "provider_request_hash" ~ '^[0-9a-f]{64}$'
      AND ("provider_receipt_hash" IS NULL OR "provider_receipt_hash" ~ '^[0-9a-f]{64}$')
      AND ("external_account_ref_hash" IS NULL OR "external_account_ref_hash" ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT "social_account_verifications_result_chk"
    CHECK (
      ("outcome" = 'VERIFIED'
        AND "provider_receipt_hash" IS NOT NULL
        AND "external_account_ref_hash" IS NOT NULL
        AND "error_code" IS NULL)
      OR
      ("outcome" <> 'VERIFIED'
        AND "provider_receipt_hash" IS NULL
        AND "external_account_ref_hash" IS NULL
        AND "error_code" ~ '^[A-Z][A-Z0-9_]{2,95}$')
    )
);

CREATE INDEX "social_account_verifications_account_idx"
  ON "social_account_verifications" ("tenant_id", "organization_id", "account_id", "occurred_at" DESC);

CREATE TABLE "social_performance_sync_state" (
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "publication_intent_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "next_sync_at" timestamptz,
  "total_attempt_count" bigint NOT NULL DEFAULT 0,
  "consecutive_failure_count" integer NOT NULL DEFAULT 0,
  "maximum_consecutive_failures" integer NOT NULL DEFAULT 8,
  "lease_token_hash" text,
  "leased_at" timestamptz,
  "lease_expires_at" timestamptz,
  "worker_id" text,
  "last_error_code" text,
  "last_error_at" timestamptz,
  "last_success_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_performance_sync_state_pk" PRIMARY KEY ("tenant_id", "publication_intent_id"),
  CONSTRAINT "social_performance_sync_state_intent_fk"
    FOREIGN KEY ("tenant_id", "publication_intent_id")
    REFERENCES "social_publication_intents"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_performance_sync_state_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_performance_sync_state_status_chk"
    CHECK ("status" IN ('PENDING', 'RUNNING', 'ACTIVE', 'PAUSED', 'DEAD_LETTER')),
  CONSTRAINT "social_performance_sync_state_attempt_chk"
    CHECK (
      "total_attempt_count" >= 0
      AND "consecutive_failure_count" BETWEEN 0 AND "maximum_consecutive_failures"
      AND "maximum_consecutive_failures" BETWEEN 1 AND 20
    ),
  CONSTRAINT "social_performance_sync_state_due_chk"
    CHECK (
      ("status" IN ('PENDING', 'ACTIVE') AND "next_sync_at" IS NOT NULL)
      OR ("status" NOT IN ('PENDING', 'ACTIVE') AND "next_sync_at" IS NULL)
    ),
  CONSTRAINT "social_performance_sync_state_lease_chk"
    CHECK (
      ("status" = 'RUNNING'
        AND "lease_token_hash" ~ '^[0-9a-f]{64}$'
        AND "leased_at" IS NOT NULL
        AND "lease_expires_at" > "leased_at"
        AND "worker_id" ~ '^[A-Za-z0-9._:-]{1,96}$')
      OR
      ("status" <> 'RUNNING'
        AND "lease_token_hash" IS NULL
        AND "leased_at" IS NULL
        AND "lease_expires_at" IS NULL
        AND "worker_id" IS NULL)
    ),
  CONSTRAINT "social_performance_sync_state_error_chk"
    CHECK (
      ("last_error_code" IS NULL) = ("last_error_at" IS NULL)
      AND ("last_error_code" IS NULL OR "last_error_code" ~ '^[A-Z][A-Z0-9_]{2,95}$')
    )
);

CREATE INDEX "social_performance_sync_state_due_idx"
  ON "social_performance_sync_state" ("tenant_id", "organization_id", "next_sync_at", "publication_intent_id")
  WHERE "status" IN ('PENDING', 'ACTIVE');

CREATE TABLE "social_performance_attempts" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "publication_intent_id" uuid NOT NULL,
  "attempt_number" bigint NOT NULL,
  "worker_id" text NOT NULL,
  "runtime_release_id" text NOT NULL,
  "outcome" text NOT NULL,
  "provider_request_hash" text NOT NULL,
  "provider_receipt_hash" text,
  "error_code" text,
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_performance_attempts_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "social_performance_attempts_intent_fk"
    FOREIGN KEY ("tenant_id", "publication_intent_id")
    REFERENCES "social_publication_intents"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_performance_attempts_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_performance_attempts_once_uq"
    UNIQUE ("tenant_id", "publication_intent_id", "attempt_number"),
  CONSTRAINT "social_performance_attempts_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_performance_attempts_attempt_chk" CHECK ("attempt_number" > 0),
  CONSTRAINT "social_performance_attempts_runtime_chk"
    CHECK ("worker_id" ~ '^[A-Za-z0-9._:-]{1,96}$' AND "runtime_release_id" ~ '^[A-Za-z0-9._:-]{1,80}$'),
  CONSTRAINT "social_performance_attempts_outcome_chk"
    CHECK ("outcome" IN ('SNAPSHOT', 'RETRY', 'DEAD_LETTER', 'LEASE_EXPIRED')),
  CONSTRAINT "social_performance_attempts_hash_chk"
    CHECK (
      "provider_request_hash" ~ '^[0-9a-f]{64}$'
      AND ("provider_receipt_hash" IS NULL OR "provider_receipt_hash" ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT "social_performance_attempts_time_chk" CHECK ("completed_at" >= "started_at"),
  CONSTRAINT "social_performance_attempts_result_chk"
    CHECK (
      ("outcome" = 'SNAPSHOT' AND "provider_receipt_hash" IS NOT NULL AND "error_code" IS NULL)
      OR
      ("outcome" <> 'SNAPSHOT' AND "provider_receipt_hash" IS NULL AND "error_code" ~ '^[A-Z][A-Z0-9_]{2,95}$')
    )
);

CREATE OR REPLACE FUNCTION "social_metrics_payload_valid"(payload jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN jsonb_typeof(payload) <> 'object' THEN false ELSE
    (SELECT count(*) FROM jsonb_object_keys(payload)) BETWEEN 1 AND 32
      AND pg_column_size(payload) <= 8192
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_each(payload) item
        WHERE item.key <> ALL (ARRAY[
          'impressions','reach','views','engagements','reactions','comments','shares',
          'saves','clicks','linkClicks','videoViews','watchTimeSeconds',
          'followersGained','spendMinor','conversions','leads'
        ]::text[])
        OR jsonb_typeof(item.value) <> 'number'
        OR (item.value::text)::numeric < 0
        OR (item.value::text)::numeric > 9007199254740991
      )
  END;
$$;

ALTER TABLE "social_performance_snapshots"
  ADD CONSTRAINT "social_performance_snapshots_receipt_uq"
    UNIQUE ("tenant_id", "publication_intent_id", "provider_receipt_hash"),
  ADD CONSTRAINT "social_performance_snapshots_payload_v2_chk"
    CHECK ("social_metrics_payload_valid"("metrics"));

CREATE INDEX "social_performance_snapshots_observed_idx"
  ON "social_performance_snapshots" ("tenant_id", "organization_id", "observed_at" DESC, "publication_intent_id");

CREATE TRIGGER "social_account_verifications_append_only"
  BEFORE UPDATE OR DELETE ON "social_account_verifications"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_publication_append_only"();
CREATE TRIGGER "social_performance_attempts_append_only"
  BEFORE UPDATE OR DELETE ON "social_performance_attempts"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_publication_append_only"();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'social_account_verifications', 'social_performance_sync_state', 'social_performance_attempts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid AND organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)',
      table_name || '_scope_select', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid AND organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)',
      table_name || '_scope_insert', table_name
    );
  END LOOP;
  CREATE POLICY "social_performance_sync_state_scope_update"
    ON "social_performance_sync_state" FOR UPDATE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
END;
$$;

INSERT INTO "social_performance_sync_state"
  ("tenant_id", "organization_id", "publication_intent_id", "status", "next_sync_at")
SELECT "tenant_id", "organization_id", "id", 'PENDING', now()
FROM "social_publication_intents"
WHERE "status" = 'PUBLISHED'
ON CONFLICT ("tenant_id", "publication_intent_id") DO NOTHING;
