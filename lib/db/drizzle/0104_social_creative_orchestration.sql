-- Approval-gated AI creative generation for Social Operations.
-- Provider credentials remain behind a managed gateway. Generated media is
-- registered through the existing immutable, content-addressed asset store and
-- never becomes publishable until the parent brief passes maker-checker review.

ALTER TABLE "social_worker_heartbeats"
  DROP CONSTRAINT "social_worker_heartbeats_kind_chk",
  ADD CONSTRAINT "social_worker_heartbeats_kind_chk"
    CHECK ("worker_kind" IN ('publication', 'performance', 'creative'));

CREATE TABLE "social_creative_requests" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "output_kind" text NOT NULL,
  "provider" text NOT NULL,
  "integration_key" text NOT NULL,
  "model" text,
  "locale" text NOT NULL,
  "prompt" text NOT NULL,
  "negative_prompt" text,
  "aspect_ratio" text,
  "duration_seconds" integer,
  "max_cost_minor" integer NOT NULL,
  "currency_code" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING_APPROVAL',
  "request_key" text NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "failure_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "next_attempt_at" timestamptz,
  "lease_token_hash" text,
  "leased_at" timestamptz,
  "lease_expires_at" timestamptz,
  "worker_id" text,
  "provider_request_hash" text,
  "provider_job_ref" text,
  "provider_job_ref_hash" text,
  "provider_receipt_hash" text,
  "result_caption" text,
  "generated_asset_id" uuid,
  "resolved_model" text,
  "usage" jsonb,
  "applied_at" timestamptz,
  "last_error_code" text,
  "last_error_at" timestamptz,
  "created_by_legacy_user_id" integer NOT NULL
    REFERENCES "users"("id") ON DELETE RESTRICT,
  "approved_by_legacy_user_id" integer
    REFERENCES "users"("id") ON DELETE RESTRICT,
  "approved_at" timestamptz,
  "rejection_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_creative_requests_tenant_id_id_uq"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "social_creative_requests_scope_key_uq"
    UNIQUE ("tenant_id", "organization_id", "request_key"),
  CONSTRAINT "social_creative_requests_brief_fk"
    FOREIGN KEY ("tenant_id", "brief_id")
    REFERENCES "social_content_briefs"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_creative_requests_asset_fk"
    FOREIGN KEY ("tenant_id", "generated_asset_id")
    REFERENCES "social_media_assets"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_creative_requests_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_creative_requests_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_creative_requests_kind_chk"
    CHECK ("output_kind" IN ('CAPTION', 'IMAGE', 'VIDEO')),
  CONSTRAINT "social_creative_requests_status_chk"
    CHECK ("status" IN (
      'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'QUEUED', 'RUNNING',
      'GENERATED', 'DEAD_LETTER', 'CANCELED'
    )),
  CONSTRAINT "social_creative_requests_provider_chk"
    CHECK ("provider" ~ '^[a-z][a-z0-9._-]{1,63}$'),
  CONSTRAINT "social_creative_requests_integration_chk"
    CHECK ("integration_key" ~ '^[a-z][a-z0-9._:-]{1,95}$'),
  CONSTRAINT "social_creative_requests_model_chk"
    CHECK ("model" IS NULL OR (length("model") BETWEEN 1 AND 128
      AND "model" ~ '^[A-Za-z0-9._:/-]+$')),
  CONSTRAINT "social_creative_requests_locale_chk"
    CHECK ("locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  CONSTRAINT "social_creative_requests_prompt_chk"
    CHECK (length("prompt") BETWEEN 1 AND 12000
      AND ("negative_prompt" IS NULL OR length("negative_prompt") <= 4000)),
  CONSTRAINT "social_creative_requests_format_chk"
    CHECK (
      ("output_kind" = 'CAPTION' AND "aspect_ratio" IS NULL AND "duration_seconds" IS NULL)
      OR ("output_kind" = 'IMAGE' AND "aspect_ratio" IN ('1:1', '4:5', '9:16', '16:9') AND "duration_seconds" IS NULL)
      OR ("output_kind" = 'VIDEO' AND "aspect_ratio" IN ('1:1', '4:5', '9:16', '16:9') AND "duration_seconds" BETWEEN 1 AND 60)
    ),
  CONSTRAINT "social_creative_requests_request_key_chk"
    CHECK (length("request_key") BETWEEN 8 AND 160
      AND "request_key" ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT "social_creative_requests_attempt_chk"
    CHECK ("attempt_count" BETWEEN 0 AND 120
      AND "failure_count" BETWEEN 0 AND "max_attempts"
      AND "max_attempts" BETWEEN 1 AND 5),
  CONSTRAINT "social_creative_requests_budget_chk"
    CHECK ("max_cost_minor" BETWEEN 1 AND 100000000
      AND "currency_code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "social_creative_requests_hash_chk"
    CHECK (
      ("lease_token_hash" IS NULL OR "lease_token_hash" ~ '^[0-9a-f]{64}$')
      AND ("provider_request_hash" IS NULL OR "provider_request_hash" ~ '^[0-9a-f]{64}$')
      AND ("provider_job_ref_hash" IS NULL OR "provider_job_ref_hash" ~ '^[0-9a-f]{64}$')
      AND ("provider_receipt_hash" IS NULL OR "provider_receipt_hash" ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT "social_creative_requests_job_ref_chk"
    CHECK (("provider_job_ref" IS NULL) = ("provider_job_ref_hash" IS NULL)
      AND ("provider_job_ref" IS NULL OR length("provider_job_ref") BETWEEN 1 AND 512)),
  CONSTRAINT "social_creative_requests_lease_chk"
    CHECK (
      ("status" = 'RUNNING' AND "lease_token_hash" IS NOT NULL
        AND "leased_at" IS NOT NULL AND "lease_expires_at" > "leased_at"
        AND "worker_id" IS NOT NULL)
      OR ("status" <> 'RUNNING' AND "lease_token_hash" IS NULL
        AND "leased_at" IS NULL AND "lease_expires_at" IS NULL
        AND "worker_id" IS NULL)
    ),
  CONSTRAINT "social_creative_requests_checker_chk"
    CHECK ("approved_by_legacy_user_id" IS NULL
      OR "approved_by_legacy_user_id" <> "created_by_legacy_user_id"),
  CONSTRAINT "social_creative_requests_approval_chk"
    CHECK (("approved_by_legacy_user_id" IS NULL) = ("approved_at" IS NULL)
      AND (("status" = 'PENDING_APPROVAL' AND "approved_by_legacy_user_id" IS NULL)
        OR ("status" <> 'PENDING_APPROVAL' AND "status" <> 'CANCELED'
          AND "approved_by_legacy_user_id" IS NOT NULL)
        OR ("status" = 'CANCELED'))),
  CONSTRAINT "social_creative_requests_rejection_chk"
    CHECK (("status" = 'REJECTED') = ("rejection_reason" IS NOT NULL)
      AND ("rejection_reason" IS NULL OR length("rejection_reason") BETWEEN 1 AND 2000)),
  CONSTRAINT "social_creative_requests_result_chk"
    CHECK (
      ("status" = 'GENERATED' AND "provider_receipt_hash" IS NOT NULL
        AND "usage" IS NOT NULL
        AND "usage" ? 'estimatedCostMinor'
        AND "usage" ? 'currencyCode' AND (
        ("output_kind" = 'CAPTION' AND "result_caption" IS NOT NULL
          AND "generated_asset_id" IS NULL)
        OR ("output_kind" IN ('IMAGE', 'VIDEO') AND "result_caption" IS NULL
          AND "generated_asset_id" IS NOT NULL)
      ))
      OR ("status" <> 'GENERATED' AND "result_caption" IS NULL
        AND "generated_asset_id" IS NULL AND "applied_at" IS NULL)
    ),
  CONSTRAINT "social_creative_requests_usage_chk"
    CHECK ("usage" IS NULL OR (
      jsonb_typeof("usage") = 'object'
      AND pg_column_size("usage") <= 2048
      AND ("usage" - ARRAY['inputUnits','outputUnits','estimatedCostMinor','currencyCode']) = '{}'::jsonb
      AND NOT ("usage" ? 'estimatedCostMinor') = NOT ("usage" ? 'currencyCode')
      AND (NOT ("usage" ? 'inputUnits') OR (
        jsonb_typeof("usage"->'inputUnits') = 'number'
        AND ("usage"->>'inputUnits')::numeric = trunc(("usage"->>'inputUnits')::numeric)
        AND ("usage"->>'inputUnits')::numeric BETWEEN 0 AND 9007199254740991
      ))
      AND (NOT ("usage" ? 'outputUnits') OR (
        jsonb_typeof("usage"->'outputUnits') = 'number'
        AND ("usage"->>'outputUnits')::numeric = trunc(("usage"->>'outputUnits')::numeric)
        AND ("usage"->>'outputUnits')::numeric BETWEEN 0 AND 9007199254740991
      ))
      AND (NOT ("usage" ? 'estimatedCostMinor') OR (
        jsonb_typeof("usage"->'estimatedCostMinor') = 'number'
        AND ("usage"->>'estimatedCostMinor')::numeric = trunc(("usage"->>'estimatedCostMinor')::numeric)
        AND ("usage"->>'estimatedCostMinor')::numeric BETWEEN 0 AND "max_cost_minor"
        AND jsonb_typeof("usage"->'currencyCode') = 'string'
        AND "usage"->>'currencyCode' = "currency_code"
      ))
    )),
  CONSTRAINT "social_creative_requests_runtime_metadata_chk"
    CHECK (("resolved_model" IS NULL OR (length("resolved_model") BETWEEN 1 AND 128
      AND "resolved_model" ~ '^[A-Za-z0-9._:/-]+$'))
      AND (("last_error_code" IS NULL) = ("last_error_at" IS NULL))),
  CONSTRAINT "social_creative_requests_error_chk"
    CHECK ("last_error_code" IS NULL
      OR "last_error_code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

CREATE INDEX "social_creative_requests_queue_idx"
  ON "social_creative_requests"
    ("tenant_id", "organization_id", "status", "next_attempt_at", "created_at");
CREATE INDEX "social_creative_requests_brief_idx"
  ON "social_creative_requests"
    ("tenant_id", "organization_id", "brief_id", "created_at" DESC);

CREATE TABLE "social_creative_attempts" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "creative_request_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "worker_id" text NOT NULL,
  "runtime_release_id" text NOT NULL,
  "outcome" text NOT NULL,
  "provider_request_hash" text NOT NULL,
  "provider_receipt_hash" text,
  "generated_asset_sha256" text,
  "resolved_model" text,
  "usage" jsonb,
  "error_code" text,
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_creative_attempts_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "social_creative_attempts_request_fk"
    FOREIGN KEY ("tenant_id", "creative_request_id")
    REFERENCES "social_creative_requests"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_creative_attempts_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_creative_attempts_once_uq"
    UNIQUE ("tenant_id", "creative_request_id", "attempt_number"),
  CONSTRAINT "social_creative_attempts_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_creative_attempts_attempt_chk"
    CHECK ("attempt_number" BETWEEN 1 AND 120),
  CONSTRAINT "social_creative_attempts_outcome_chk"
    CHECK ("outcome" IN ('PENDING', 'GENERATED', 'RETRY', 'DEAD_LETTER', 'LEASE_EXPIRED')),
  CONSTRAINT "social_creative_attempts_hash_chk"
    CHECK (
      "provider_request_hash" ~ '^[0-9a-f]{64}$'
      AND ("provider_receipt_hash" IS NULL OR "provider_receipt_hash" ~ '^[0-9a-f]{64}$')
      AND ("generated_asset_sha256" IS NULL OR "generated_asset_sha256" ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT "social_creative_attempts_usage_chk"
    CHECK ("usage" IS NULL OR (
      jsonb_typeof("usage") = 'object'
      AND pg_column_size("usage") <= 2048
      AND ("usage" - ARRAY['inputUnits','outputUnits','estimatedCostMinor','currencyCode']) = '{}'::jsonb
      AND NOT ("usage" ? 'estimatedCostMinor') = NOT ("usage" ? 'currencyCode')
      AND (NOT ("usage" ? 'inputUnits') OR (
        jsonb_typeof("usage"->'inputUnits') = 'number'
        AND ("usage"->>'inputUnits')::numeric = trunc(("usage"->>'inputUnits')::numeric)
        AND ("usage"->>'inputUnits')::numeric BETWEEN 0 AND 9007199254740991
      ))
      AND (NOT ("usage" ? 'outputUnits') OR (
        jsonb_typeof("usage"->'outputUnits') = 'number'
        AND ("usage"->>'outputUnits')::numeric = trunc(("usage"->>'outputUnits')::numeric)
        AND ("usage"->>'outputUnits')::numeric BETWEEN 0 AND 9007199254740991
      ))
      AND (NOT ("usage" ? 'estimatedCostMinor') OR (
        jsonb_typeof("usage"->'estimatedCostMinor') = 'number'
        AND ("usage"->>'estimatedCostMinor')::numeric = trunc(("usage"->>'estimatedCostMinor')::numeric)
        AND ("usage"->>'estimatedCostMinor')::numeric BETWEEN 0 AND 100000000
      ))
      AND (NOT ("usage" ? 'currencyCode') OR (
        jsonb_typeof("usage"->'currencyCode') = 'string'
        AND "usage"->>'currencyCode' ~ '^[A-Z]{3}$'
      ))
    )),
  CONSTRAINT "social_creative_attempts_evidence_chk"
    CHECK (
      ("outcome" = 'PENDING'
        AND "provider_receipt_hash" IS NOT NULL AND "error_code" IS NULL)
      OR ("outcome" = 'GENERATED'
        AND "provider_receipt_hash" IS NOT NULL AND "error_code" IS NULL
        AND "usage" IS NOT NULL
        AND "usage" ? 'estimatedCostMinor'
        AND "usage" ? 'currencyCode')
      OR ("outcome" IN ('RETRY','LEASE_EXPIRED')
        AND "provider_receipt_hash" IS NULL AND "error_code" IS NOT NULL)
      OR ("outcome" = 'DEAD_LETTER' AND "error_code" IS NOT NULL)
    ),
  CONSTRAINT "social_creative_attempts_error_chk"
    CHECK ("error_code" IS NULL OR "error_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT "social_creative_attempts_time_chk"
    CHECK ("completed_at" >= "started_at")
);

CREATE INDEX "social_creative_attempts_request_idx"
  ON "social_creative_attempts"
    ("tenant_id", "organization_id", "creative_request_id", "attempt_number");

CREATE OR REPLACE FUNCTION "protect_social_creative_attempt"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'social creative attempts are append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "social_creative_attempts_append_only"
  BEFORE UPDATE OR DELETE ON "social_creative_attempts"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_creative_attempt"();

CREATE OR REPLACE FUNCTION "enforce_social_creative_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = NEW."status" THEN RETURN NEW; END IF;
  IF (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELED'))
     OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('QUEUED', 'CANCELED'))
     OR (OLD."status" = 'QUEUED' AND NEW."status" IN ('RUNNING', 'CANCELED'))
     OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('QUEUED', 'GENERATED', 'DEAD_LETTER')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid social creative transition: % -> %', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "social_creative_requests_status_transition"
  BEFORE UPDATE OF "status" ON "social_creative_requests"
  FOR EACH ROW EXECUTE FUNCTION "enforce_social_creative_transition"();

CREATE OR REPLACE FUNCTION "protect_social_creative_request_definition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    OLD."id", OLD."tenant_id", OLD."organization_id", OLD."brief_id",
    OLD."output_kind", OLD."provider", OLD."integration_key", OLD."model",
    OLD."locale", OLD."prompt", OLD."negative_prompt", OLD."aspect_ratio",
    OLD."duration_seconds", OLD."max_cost_minor", OLD."currency_code",
    OLD."request_key", OLD."max_attempts", OLD."created_by_legacy_user_id",
    OLD."created_at"
  ) IS DISTINCT FROM ROW(
    NEW."id", NEW."tenant_id", NEW."organization_id", NEW."brief_id",
    NEW."output_kind", NEW."provider", NEW."integration_key", NEW."model",
    NEW."locale", NEW."prompt", NEW."negative_prompt", NEW."aspect_ratio",
    NEW."duration_seconds", NEW."max_cost_minor", NEW."currency_code",
    NEW."request_key", NEW."max_attempts", NEW."created_by_legacy_user_id",
    NEW."created_at"
  ) THEN
    RAISE EXCEPTION 'social creative request definition is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "social_creative_requests_definition_immutable"
  BEFORE UPDATE ON "social_creative_requests"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_creative_request_definition"();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'social_creative_requests', 'social_creative_attempts'
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

CREATE POLICY "social_creative_requests_scope_update"
  ON "social_creative_requests" FOR UPDATE
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );
