-- Durable, tenant-scoped orchestration for reviewed social publications.
-- Provider delivery remains default-off and is never performed by this migration.

ALTER TABLE "social_publication_intents"
  DROP CONSTRAINT "social_publication_intents_status_chk";

ALTER TABLE "social_publication_intents"
  ADD COLUMN "attempt_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "max_attempts" integer NOT NULL DEFAULT 5,
  ADD COLUMN "next_attempt_at" timestamptz,
  ADD COLUMN "lease_token_hash" text,
  ADD COLUMN "leased_at" timestamptz,
  ADD COLUMN "lease_expires_at" timestamptz,
  ADD COLUMN "worker_id" text,
  ADD COLUMN "provider_post_ref_hash" text,
  ADD COLUMN "published_at" timestamptz,
  ADD COLUMN "last_error_at" timestamptz;

ALTER TABLE "social_publication_intents"
  ADD CONSTRAINT "social_publication_intents_status_chk"
    CHECK ("status" IN (
      'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'QUEUED',
      'RUNNING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER', 'CANCELED'
    )),
  ADD CONSTRAINT "social_publication_intents_attempt_chk"
    CHECK ("max_attempts" BETWEEN 1 AND 12 AND "attempt_count" BETWEEN 0 AND "max_attempts"),
  ADD CONSTRAINT "social_publication_intents_lease_chk"
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
  ADD CONSTRAINT "social_publication_intents_publish_evidence_chk"
    CHECK (
      ("status" = 'PUBLISHED'
        AND "published_at" IS NOT NULL
        AND "execution_receipt_hash" ~ '^[0-9a-f]{64}$'
        AND "provider_post_ref_hash" ~ '^[0-9a-f]{64}$')
      OR
      ("status" <> 'PUBLISHED' AND "published_at" IS NULL)
    ),
  ADD CONSTRAINT "social_publication_intents_retry_chk"
    CHECK (
      ("status" IN ('APPROVED', 'QUEUED', 'FAILED') AND "next_attempt_at" IS NOT NULL)
      OR
      ("status" NOT IN ('APPROVED', 'QUEUED', 'FAILED') AND "next_attempt_at" IS NULL)
    ),
  ADD CONSTRAINT "social_publication_intents_error_time_chk"
    CHECK (("last_error_code" IS NULL) = ("last_error_at" IS NULL)),
  ADD CONSTRAINT "social_publication_intents_provider_post_hash_chk"
    CHECK ("provider_post_ref_hash" IS NULL OR "provider_post_ref_hash" ~ '^[0-9a-f]{64}$');

CREATE INDEX "social_publication_intents_due_idx"
  ON "social_publication_intents" (
    "tenant_id", "organization_id", "next_attempt_at", "created_at", "id"
  )
  WHERE "status" IN ('APPROVED', 'QUEUED', 'FAILED');

CREATE TABLE "social_publication_reviews" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "publication_intent_id" uuid NOT NULL,
  "reviewer_legacy_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "decision" text NOT NULL,
  "reason" text,
  "request_key" text NOT NULL,
  "evidence_sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_publication_reviews_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "social_publication_reviews_intent_fk"
    FOREIGN KEY ("tenant_id", "publication_intent_id")
    REFERENCES "social_publication_intents"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_publication_reviews_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_publication_reviews_once_uq"
    UNIQUE ("tenant_id", "publication_intent_id"),
  CONSTRAINT "social_publication_reviews_request_uq"
    UNIQUE ("tenant_id", "request_key"),
  CONSTRAINT "social_publication_reviews_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_publication_reviews_decision_chk"
    CHECK ("decision" IN ('APPROVE', 'REJECT')),
  CONSTRAINT "social_publication_reviews_reason_chk"
    CHECK ("reason" IS NULL OR length("reason") <= 2000),
  CONSTRAINT "social_publication_reviews_hash_chk"
    CHECK ("evidence_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "social_publication_attempts" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "publication_intent_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "worker_id" text NOT NULL,
  "runtime_release_id" text NOT NULL,
  "outcome" text NOT NULL,
  "provider_request_hash" text NOT NULL,
  "provider_receipt_hash" text,
  "provider_post_ref_hash" text,
  "error_code" text,
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_publication_attempts_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "social_publication_attempts_intent_fk"
    FOREIGN KEY ("tenant_id", "publication_intent_id")
    REFERENCES "social_publication_intents"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_publication_attempts_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_publication_attempts_once_uq"
    UNIQUE ("tenant_id", "publication_intent_id", "attempt_number"),
  CONSTRAINT "social_publication_attempts_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_publication_attempts_attempt_chk"
    CHECK ("attempt_number" BETWEEN 1 AND 12),
  CONSTRAINT "social_publication_attempts_worker_chk"
    CHECK ("worker_id" ~ '^[A-Za-z0-9._:-]{1,96}$'),
  CONSTRAINT "social_publication_attempts_release_chk"
    CHECK ("runtime_release_id" ~ '^[A-Za-z0-9._:-]{1,80}$'),
  CONSTRAINT "social_publication_attempts_outcome_chk"
    CHECK ("outcome" IN ('PUBLISHED', 'RETRY', 'FAILED', 'DEAD_LETTER', 'CANCELED')),
  CONSTRAINT "social_publication_attempts_hash_chk"
    CHECK (
      "provider_request_hash" ~ '^[0-9a-f]{64}$'
      AND ("provider_receipt_hash" IS NULL OR "provider_receipt_hash" ~ '^[0-9a-f]{64}$')
      AND ("provider_post_ref_hash" IS NULL OR "provider_post_ref_hash" ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT "social_publication_attempts_time_chk"
    CHECK ("completed_at" >= "started_at"),
  CONSTRAINT "social_publication_attempts_result_chk"
    CHECK (
      ("outcome" = 'PUBLISHED'
        AND "provider_receipt_hash" IS NOT NULL
        AND "provider_post_ref_hash" IS NOT NULL
        AND "error_code" IS NULL)
      OR
      ("outcome" <> 'PUBLISHED' AND "error_code" IS NOT NULL)
    )
);

CREATE TABLE "social_operation_receipts" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "actor_legacy_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "operation" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "request_key" text NOT NULL,
  "payload_sha256" text NOT NULL,
  "result" jsonb NOT NULL,
  "result_sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_operation_receipts_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "social_operation_receipts_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_operation_receipts_request_uq" UNIQUE ("tenant_id", "request_key"),
  CONSTRAINT "social_operation_receipts_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_operation_receipts_operation_chk"
    CHECK ("operation" ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT "social_operation_receipts_entity_chk"
    CHECK ("entity_type" ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT "social_operation_receipts_key_chk"
    CHECK (length("request_key") BETWEEN 8 AND 160 AND "request_key" ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT "social_operation_receipts_hash_chk"
    CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$' AND "result_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "social_operation_receipts_result_chk"
    CHECK (jsonb_typeof("result") = 'object' AND pg_column_size("result") <= 32768)
);

CREATE INDEX "social_operation_receipts_entity_idx"
  ON "social_operation_receipts" ("tenant_id", "organization_id", "entity_type", "entity_id", "created_at");

CREATE OR REPLACE FUNCTION "protect_social_publication_append_only"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'social publication evidence is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "social_publication_reviews_append_only"
  BEFORE UPDATE OR DELETE ON "social_publication_reviews"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_publication_append_only"();
CREATE TRIGGER "social_publication_attempts_append_only"
  BEFORE UPDATE OR DELETE ON "social_publication_attempts"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_publication_append_only"();
CREATE TRIGGER "social_operation_receipts_append_only"
  BEFORE UPDATE OR DELETE ON "social_operation_receipts"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_publication_append_only"();

CREATE OR REPLACE FUNCTION "enforce_social_publication_intent_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = NEW."status" THEN RETURN NEW; END IF;
  IF (OLD."status" = 'DRAFT' AND NEW."status" IN ('PENDING_APPROVAL', 'CANCELED'))
     OR (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELED'))
     OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('QUEUED', 'CANCELED'))
     OR (OLD."status" = 'QUEUED' AND NEW."status" IN ('RUNNING', 'CANCELED'))
     OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('PUBLISHED', 'QUEUED', 'FAILED', 'DEAD_LETTER'))
     OR (OLD."status" = 'FAILED' AND NEW."status" IN ('QUEUED', 'DEAD_LETTER', 'CANCELED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid social publication transition: % -> %', OLD."status", NEW."status" USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "social_publication_intents_status_transition"
  BEFORE UPDATE OF "status" ON "social_publication_intents"
  FOR EACH ROW EXECUTE FUNCTION "enforce_social_publication_intent_transition"();

CREATE OR REPLACE FUNCTION "protect_social_publication_intent_content"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' AND (
    OLD."brief_id" IS DISTINCT FROM NEW."brief_id"
    OR OLD."account_id" IS DISTINCT FROM NEW."account_id"
    OR OLD."scheduled_for" IS DISTINCT FROM NEW."scheduled_for"
    OR OLD."provider_mode" IS DISTINCT FROM NEW."provider_mode"
    OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
    OR OLD."created_by_legacy_user_id" IS DISTINCT FROM NEW."created_by_legacy_user_id"
  ) THEN
    RAISE EXCEPTION 'submitted social publication intent is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "social_publication_intents_protect_content"
  BEFORE UPDATE ON "social_publication_intents"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_publication_intent_content"();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'social_publication_reviews', 'social_publication_attempts', 'social_operation_receipts'
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
END;
$$;
