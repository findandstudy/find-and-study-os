-- Tenant-scoped, approval-gated advertising control plane.
-- Campaigns are provisioned PAUSED. Spending can begin only after a separate,
-- maker-checker-approved RESUME operation and every external runtime gate.

ALTER TABLE "social_worker_heartbeats"
  DROP CONSTRAINT "social_worker_heartbeats_kind_chk";
ALTER TABLE "social_worker_heartbeats"
  ADD CONSTRAINT "social_worker_heartbeats_kind_chk"
    CHECK ("worker_kind" IN ('publication', 'performance', 'creative', 'advertising'));

CREATE TABLE "social_ad_campaigns" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE RESTRICT,
  "organization_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "name" text NOT NULL,
  "objective" text NOT NULL,
  "destination_url" text NOT NULL,
  "country_codes" text[] NOT NULL,
  "language_codes" text[] NOT NULL DEFAULT '{}',
  "age_min" integer NOT NULL,
  "age_max" integer NOT NULL,
  "currency_code" text NOT NULL,
  "requested_daily_budget_minor" bigint NOT NULL,
  "requested_lifetime_budget_minor" bigint NOT NULL,
  "current_daily_budget_minor" bigint NOT NULL,
  "current_lifetime_budget_minor" bigint NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING_APPROVAL',
  "definition_sha256" text NOT NULL,
  "provider_campaign_ref_hash" text,
  "provider_receipt_hash" text,
  "last_error_code" text,
  "created_by_legacy_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "approved_by_legacy_user_id" integer REFERENCES "users"("id") ON DELETE RESTRICT,
  "approved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_ad_campaigns_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "social_ad_campaigns_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_ad_campaigns_account_fk"
    FOREIGN KEY ("tenant_id", "account_id")
    REFERENCES "social_accounts"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_ad_campaigns_brief_fk"
    FOREIGN KEY ("tenant_id", "brief_id")
    REFERENCES "social_content_briefs"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_ad_campaigns_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_ad_campaigns_provider_chk"
    CHECK ("provider" ~ '^[a-z][a-z0-9._-]{1,63}$'),
  CONSTRAINT "social_ad_campaigns_objective_chk"
    CHECK ("objective" IN ('AWARENESS','TRAFFIC','LEADS','CONVERSIONS','VIDEO_VIEWS')),
  CONSTRAINT "social_ad_campaigns_destination_chk"
    CHECK (length("destination_url") BETWEEN 10 AND 2048 AND "destination_url" ~ '^https://'),
  CONSTRAINT "social_ad_campaigns_targeting_chk"
    CHECK (
      cardinality("country_codes") BETWEEN 1 AND 25
      AND cardinality("language_codes") BETWEEN 0 AND 20
      AND "age_min" BETWEEN 18 AND 65
      AND "age_max" BETWEEN "age_min" AND 65
    ),
  CONSTRAINT "social_ad_campaigns_currency_chk"
    CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "social_ad_campaigns_budget_chk"
    CHECK (
      "requested_daily_budget_minor" BETWEEN 1 AND 1000000000000
      AND "requested_lifetime_budget_minor" BETWEEN "requested_daily_budget_minor" AND 1000000000000
      AND "current_daily_budget_minor" BETWEEN 1 AND 1000000000000
      AND "current_lifetime_budget_minor" BETWEEN "current_daily_budget_minor" AND 1000000000000
    ),
  CONSTRAINT "social_ad_campaigns_schedule_chk"
    CHECK ("ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '180 days'),
  CONSTRAINT "social_ad_campaigns_status_chk"
    CHECK ("status" IN (
      'PENDING_APPROVAL','APPROVED','PROVISIONING','PAUSED','ACTIVE',
      'COMPLETED','REJECTED','FAILED','CANCELED'
    )),
  CONSTRAINT "social_ad_campaigns_hash_chk"
    CHECK (
      "definition_sha256" ~ '^[0-9a-f]{64}$'
      AND ("provider_campaign_ref_hash" IS NULL OR "provider_campaign_ref_hash" ~ '^[0-9a-f]{64}$')
      AND ("provider_receipt_hash" IS NULL OR "provider_receipt_hash" ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT "social_ad_campaigns_approval_chk"
    CHECK (
      (("approved_by_legacy_user_id" IS NULL) = ("approved_at" IS NULL))
      AND ("approved_by_legacy_user_id" IS NULL OR "approved_by_legacy_user_id" <> "created_by_legacy_user_id")
    ),
  CONSTRAINT "social_ad_campaigns_provider_evidence_chk"
    CHECK (
      "status" IN ('PENDING_APPROVAL','APPROVED','PROVISIONING','REJECTED','FAILED','CANCELED')
      OR ("provider_campaign_ref_hash" IS NOT NULL AND "provider_receipt_hash" IS NOT NULL)
    ),
  CONSTRAINT "social_ad_campaigns_error_chk"
    CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[A-Z][A-Z0-9_]{2,95}$')
);

CREATE INDEX "social_ad_campaigns_scope_status_idx"
  ON "social_ad_campaigns" ("tenant_id", "organization_id", "status", "starts_at", "id");
CREATE INDEX "social_ad_campaigns_account_idx"
  ON "social_ad_campaigns" ("tenant_id", "organization_id", "account_id", "status");

CREATE TABLE "social_ad_operations" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "campaign_id" uuid NOT NULL,
  "operation_type" text NOT NULL,
  "requested_daily_budget_minor" bigint,
  "requested_lifetime_budget_minor" bigint,
  "status" text NOT NULL DEFAULT 'PENDING_APPROVAL',
  "request_key" text NOT NULL,
  "payload_sha256" text NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "next_attempt_at" timestamptz,
  "lease_token_hash" text,
  "leased_at" timestamptz,
  "lease_expires_at" timestamptz,
  "worker_id" text,
  "provider_request_hash" text,
  "provider_receipt_hash" text,
  "provider_campaign_ref_hash" text,
  "provider_state" text,
  "last_error_code" text,
  "last_error_at" timestamptz,
  "created_by_legacy_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "approved_by_legacy_user_id" integer REFERENCES "users"("id") ON DELETE RESTRICT,
  "approved_at" timestamptz,
  "rejection_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_ad_operations_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "social_ad_operations_campaign_fk"
    FOREIGN KEY ("tenant_id", "campaign_id")
    REFERENCES "social_ad_campaigns"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_ad_operations_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_ad_operations_request_uq"
    UNIQUE ("tenant_id", "organization_id", "request_key"),
  CONSTRAINT "social_ad_operations_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_ad_operations_type_chk"
    CHECK ("operation_type" IN ('CREATE','PAUSE','RESUME','UPDATE_BUDGET','END')),
  CONSTRAINT "social_ad_operations_budget_chk"
    CHECK (
      ("operation_type" IN ('CREATE','UPDATE_BUDGET')
        AND "requested_daily_budget_minor" BETWEEN 1 AND 1000000000000
        AND "requested_lifetime_budget_minor" BETWEEN "requested_daily_budget_minor" AND 1000000000000)
      OR
      ("operation_type" IN ('PAUSE','RESUME','END')
        AND "requested_daily_budget_minor" IS NULL
        AND "requested_lifetime_budget_minor" IS NULL)
    ),
  CONSTRAINT "social_ad_operations_status_chk"
    CHECK ("status" IN (
      'PENDING_APPROVAL','APPROVED','QUEUED','RUNNING','APPLIED',
      'REJECTED','FAILED','DEAD_LETTER','CANCELED'
    )),
  CONSTRAINT "social_ad_operations_key_chk"
    CHECK (length("request_key") BETWEEN 8 AND 160 AND "request_key" ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT "social_ad_operations_hash_chk"
    CHECK (
      "payload_sha256" ~ '^[0-9a-f]{64}$'
      AND ("provider_request_hash" IS NULL OR "provider_request_hash" ~ '^[0-9a-f]{64}$')
      AND ("provider_receipt_hash" IS NULL OR "provider_receipt_hash" ~ '^[0-9a-f]{64}$')
      AND ("provider_campaign_ref_hash" IS NULL OR "provider_campaign_ref_hash" ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT "social_ad_operations_attempt_chk"
    CHECK ("max_attempts" BETWEEN 1 AND 8 AND "attempt_count" BETWEEN 0 AND "max_attempts"),
  CONSTRAINT "social_ad_operations_due_chk"
    CHECK (
      ("status" IN ('APPROVED','QUEUED','FAILED') AND "next_attempt_at" IS NOT NULL)
      OR ("status" NOT IN ('APPROVED','QUEUED','FAILED') AND "next_attempt_at" IS NULL)
    ),
  CONSTRAINT "social_ad_operations_lease_chk"
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
  CONSTRAINT "social_ad_operations_approval_chk"
    CHECK (
      (("approved_by_legacy_user_id" IS NULL) = ("approved_at" IS NULL))
      AND ("approved_by_legacy_user_id" IS NULL OR "approved_by_legacy_user_id" <> "created_by_legacy_user_id")
    ),
  CONSTRAINT "social_ad_operations_result_chk"
    CHECK (
      ("status" = 'APPLIED'
        AND "provider_request_hash" IS NOT NULL
        AND "provider_receipt_hash" IS NOT NULL
        AND "provider_campaign_ref_hash" IS NOT NULL
        AND "provider_state" IN ('PAUSED','ACTIVE','COMPLETED')
        AND "last_error_code" IS NULL)
      OR "status" <> 'APPLIED'
    ),
  CONSTRAINT "social_ad_operations_error_chk"
    CHECK (
      (("last_error_code" IS NULL) = ("last_error_at" IS NULL))
      AND ("last_error_code" IS NULL OR "last_error_code" ~ '^[A-Z][A-Z0-9_]{2,95}$')
    ),
  CONSTRAINT "social_ad_operations_reason_chk"
    CHECK ("rejection_reason" IS NULL OR length("rejection_reason") <= 2000)
);

ALTER TABLE "social_ad_campaigns"
  ADD COLUMN "last_applied_operation_id" uuid,
  ADD CONSTRAINT "social_ad_campaigns_last_operation_fk"
    FOREIGN KEY ("tenant_id", "last_applied_operation_id")
    REFERENCES "social_ad_operations"("tenant_id", "id") ON DELETE RESTRICT;

CREATE INDEX "social_ad_operations_due_idx"
  ON "social_ad_operations" (
    "tenant_id", "organization_id", "next_attempt_at", "created_at", "id"
  ) WHERE "status" IN ('APPROVED','QUEUED','FAILED');
CREATE UNIQUE INDEX "social_ad_operations_one_inflight_campaign_idx"
  ON "social_ad_operations" ("tenant_id", "campaign_id")
  WHERE "status" IN ('PENDING_APPROVAL','APPROVED','QUEUED','RUNNING','FAILED');

CREATE TABLE "social_ad_operation_reviews" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "reviewer_legacy_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "decision" text NOT NULL,
  "reason" text,
  "request_key" text NOT NULL,
  "evidence_sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_ad_operation_reviews_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "social_ad_operation_reviews_operation_fk"
    FOREIGN KEY ("tenant_id", "operation_id")
    REFERENCES "social_ad_operations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_ad_operation_reviews_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_ad_operation_reviews_once_uq" UNIQUE ("tenant_id", "operation_id"),
  CONSTRAINT "social_ad_operation_reviews_request_uq" UNIQUE ("tenant_id", "request_key"),
  CONSTRAINT "social_ad_operation_reviews_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_ad_operation_reviews_decision_chk"
    CHECK ("decision" IN ('APPROVE','REJECT')),
  CONSTRAINT "social_ad_operation_reviews_reason_chk"
    CHECK (("decision" = 'APPROVE' AND "reason" IS NULL) OR ("decision" = 'REJECT' AND length("reason") BETWEEN 1 AND 2000)),
  CONSTRAINT "social_ad_operation_reviews_hash_chk"
    CHECK ("evidence_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "social_ad_operation_reviews_key_chk"
    CHECK (length("request_key") BETWEEN 8 AND 160 AND "request_key" ~ '^[A-Za-z0-9._:-]+$')
);

CREATE TABLE "social_ad_operation_attempts" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "worker_id" text NOT NULL,
  "runtime_release_id" text NOT NULL,
  "outcome" text NOT NULL,
  "provider_request_hash" text NOT NULL,
  "provider_receipt_hash" text,
  "provider_campaign_ref_hash" text,
  "provider_state" text,
  "error_code" text,
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_ad_operation_attempts_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "social_ad_operation_attempts_operation_fk"
    FOREIGN KEY ("tenant_id", "operation_id")
    REFERENCES "social_ad_operations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_ad_operation_attempts_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_ad_operation_attempts_once_uq"
    UNIQUE ("tenant_id", "operation_id", "attempt_number"),
  CONSTRAINT "social_ad_operation_attempts_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_ad_operation_attempts_attempt_chk"
    CHECK ("attempt_number" BETWEEN 1 AND 8),
  CONSTRAINT "social_ad_operation_attempts_runtime_chk"
    CHECK ("worker_id" ~ '^[A-Za-z0-9._:-]{1,96}$' AND "runtime_release_id" ~ '^[A-Za-z0-9._:-]{1,96}$'),
  CONSTRAINT "social_ad_operation_attempts_outcome_chk"
    CHECK ("outcome" IN ('APPLIED','RETRY','DEAD_LETTER','LEASE_EXPIRED')),
  CONSTRAINT "social_ad_operation_attempts_hash_chk"
    CHECK (
      "provider_request_hash" ~ '^[0-9a-f]{64}$'
      AND ("provider_receipt_hash" IS NULL OR "provider_receipt_hash" ~ '^[0-9a-f]{64}$')
      AND ("provider_campaign_ref_hash" IS NULL OR "provider_campaign_ref_hash" ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT "social_ad_operation_attempts_time_chk" CHECK ("completed_at" >= "started_at"),
  CONSTRAINT "social_ad_operation_attempts_result_chk"
    CHECK (
      ("outcome" = 'APPLIED'
        AND "provider_receipt_hash" IS NOT NULL
        AND "provider_campaign_ref_hash" IS NOT NULL
        AND "provider_state" IN ('PAUSED','ACTIVE','COMPLETED')
        AND "error_code" IS NULL)
      OR
      ("outcome" <> 'APPLIED'
        AND "provider_receipt_hash" IS NULL
        AND "provider_campaign_ref_hash" IS NULL
        AND "provider_state" IS NULL
        AND "error_code" ~ '^[A-Z][A-Z0-9_]{2,95}$')
    )
);

CREATE OR REPLACE FUNCTION "protect_social_ad_evidence"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'social advertising evidence is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "social_ad_operation_reviews_append_only"
  BEFORE UPDATE OR DELETE ON "social_ad_operation_reviews"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_ad_evidence"();
CREATE TRIGGER "social_ad_operation_attempts_append_only"
  BEFORE UPDATE OR DELETE ON "social_ad_operation_attempts"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_ad_evidence"();

CREATE OR REPLACE FUNCTION "enforce_social_ad_campaign_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = NEW."status" THEN RETURN NEW; END IF;
  IF (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED','REJECTED','CANCELED'))
     OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('PROVISIONING','CANCELED'))
     OR (OLD."status" = 'PROVISIONING' AND NEW."status" IN ('APPROVED','PAUSED','FAILED'))
     OR (OLD."status" = 'PAUSED' AND NEW."status" IN ('ACTIVE','COMPLETED'))
     OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('PAUSED','COMPLETED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid social ad campaign transition: % -> %', OLD."status", NEW."status" USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "social_ad_campaigns_status_transition"
  BEFORE UPDATE OF "status" ON "social_ad_campaigns"
  FOR EACH ROW EXECUTE FUNCTION "enforce_social_ad_campaign_transition"();

CREATE OR REPLACE FUNCTION "protect_social_ad_campaign_definition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."account_id" IS DISTINCT FROM NEW."account_id"
     OR OLD."brief_id" IS DISTINCT FROM NEW."brief_id"
     OR OLD."provider" IS DISTINCT FROM NEW."provider"
     OR OLD."name" IS DISTINCT FROM NEW."name"
     OR OLD."objective" IS DISTINCT FROM NEW."objective"
     OR OLD."destination_url" IS DISTINCT FROM NEW."destination_url"
     OR OLD."country_codes" IS DISTINCT FROM NEW."country_codes"
     OR OLD."language_codes" IS DISTINCT FROM NEW."language_codes"
     OR OLD."age_min" IS DISTINCT FROM NEW."age_min"
     OR OLD."age_max" IS DISTINCT FROM NEW."age_max"
     OR OLD."currency_code" IS DISTINCT FROM NEW."currency_code"
     OR OLD."requested_daily_budget_minor" IS DISTINCT FROM NEW."requested_daily_budget_minor"
     OR OLD."requested_lifetime_budget_minor" IS DISTINCT FROM NEW."requested_lifetime_budget_minor"
     OR OLD."starts_at" IS DISTINCT FROM NEW."starts_at"
     OR OLD."ends_at" IS DISTINCT FROM NEW."ends_at"
     OR OLD."definition_sha256" IS DISTINCT FROM NEW."definition_sha256"
     OR OLD."created_by_legacy_user_id" IS DISTINCT FROM NEW."created_by_legacy_user_id" THEN
    RAISE EXCEPTION 'social ad campaign definition is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "social_ad_campaigns_definition_immutable"
  BEFORE UPDATE ON "social_ad_campaigns"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_ad_campaign_definition"();

CREATE OR REPLACE FUNCTION "enforce_social_ad_operation_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = NEW."status" THEN RETURN NEW; END IF;
  IF (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED','REJECTED','CANCELED'))
     OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('QUEUED','CANCELED'))
     OR (OLD."status" = 'QUEUED' AND NEW."status" IN ('RUNNING','CANCELED'))
     OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('APPLIED','QUEUED','FAILED','DEAD_LETTER'))
     OR (OLD."status" = 'FAILED' AND NEW."status" IN ('QUEUED','DEAD_LETTER','CANCELED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid social ad operation transition: % -> %', OLD."status", NEW."status" USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "social_ad_operations_status_transition"
  BEFORE UPDATE OF "status" ON "social_ad_operations"
  FOR EACH ROW EXECUTE FUNCTION "enforce_social_ad_operation_transition"();

CREATE OR REPLACE FUNCTION "protect_social_ad_operation_definition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."campaign_id" IS DISTINCT FROM NEW."campaign_id"
     OR OLD."operation_type" IS DISTINCT FROM NEW."operation_type"
     OR OLD."requested_daily_budget_minor" IS DISTINCT FROM NEW."requested_daily_budget_minor"
     OR OLD."requested_lifetime_budget_minor" IS DISTINCT FROM NEW."requested_lifetime_budget_minor"
     OR OLD."request_key" IS DISTINCT FROM NEW."request_key"
     OR OLD."payload_sha256" IS DISTINCT FROM NEW."payload_sha256"
     OR OLD."max_attempts" IS DISTINCT FROM NEW."max_attempts"
     OR OLD."created_by_legacy_user_id" IS DISTINCT FROM NEW."created_by_legacy_user_id" THEN
    RAISE EXCEPTION 'social ad operation definition is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "social_ad_operations_definition_immutable"
  BEFORE UPDATE ON "social_ad_operations"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_ad_operation_definition"();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'social_ad_campaigns','social_ad_operations',
    'social_ad_operation_reviews','social_ad_operation_attempts'
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
    IF table_name IN ('social_ad_campaigns','social_ad_operations') THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid AND organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid AND organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)',
        table_name || '_scope_update', table_name
      );
    END IF;
  END LOOP;
END;
$$;
