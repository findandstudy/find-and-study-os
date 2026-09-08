-- Tenant-scoped Social Operations v1 foundation.
-- This migration adds planning, approval, provider-intent and metrics records.
-- It does not call a social provider and does not enable automatic publishing.

CREATE TABLE "social_accounts" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE RESTRICT,
  "organization_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "account_key" text NOT NULL,
  "display_name" text NOT NULL,
  "integration_key" text,
  "external_account_ref_hash" text,
  "status" text NOT NULL DEFAULT 'DISCONNECTED',
  "created_by_legacy_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_accounts_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "social_accounts_scope_key_uq" UNIQUE ("tenant_id", "organization_id", "account_key"),
  CONSTRAINT "social_accounts_organization_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_accounts_id_v7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_accounts_provider_chk" CHECK ("provider" ~ '^[a-z][a-z0-9._-]{1,63}$'),
  CONSTRAINT "social_accounts_key_chk" CHECK ("account_key" ~ '^[a-z][a-z0-9._:-]{1,95}$'),
  CONSTRAINT "social_accounts_hash_chk" CHECK ("external_account_ref_hash" IS NULL OR "external_account_ref_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "social_accounts_status_chk" CHECK ("status" IN ('DISCONNECTED', 'CONNECTED_UNVERIFIED', 'VERIFIED', 'REAUTH_REQUIRED', 'DISABLED'))
);
CREATE INDEX "social_accounts_scope_status_idx" ON "social_accounts" ("tenant_id", "organization_id", "status");

CREATE TABLE "social_content_briefs" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE RESTRICT,
  "organization_id" uuid NOT NULL,
  "title" text NOT NULL,
  "objective" text NOT NULL,
  "audience" text NOT NULL,
  "content_kind" text NOT NULL,
  "locales" text[] NOT NULL DEFAULT '{}',
  "channels" text[] NOT NULL DEFAULT '{}',
  "campaign_key" text,
  "caption" text,
  "media_refs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "utm" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "scheduled_for" timestamptz,
  "status" text NOT NULL DEFAULT 'DRAFT',
  "version" bigint NOT NULL DEFAULT 1,
  "created_by_legacy_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "reviewed_by_legacy_user_id" integer REFERENCES "users"("id") ON DELETE RESTRICT,
  "reviewed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_content_briefs_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "social_content_briefs_organization_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_content_briefs_id_v7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_content_briefs_status_chk" CHECK ("status" IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED')),
  CONSTRAINT "social_content_briefs_kind_chk" CHECK ("content_kind" IN ('POST', 'STORY', 'REEL', 'VIDEO', 'ARTICLE', 'AD_CREATIVE')),
  CONSTRAINT "social_content_briefs_payload_chk" CHECK (jsonb_typeof("media_refs") = 'array' AND jsonb_array_length("media_refs") <= 50 AND jsonb_typeof("utm") = 'object'),
  CONSTRAINT "social_content_briefs_scope_chk" CHECK (cardinality("locales") BETWEEN 1 AND 20 AND cardinality("channels") BETWEEN 1 AND 20),
  CONSTRAINT "social_content_briefs_version_chk" CHECK ("version" > 0),
  CONSTRAINT "social_content_briefs_review_pair_chk" CHECK (("reviewed_by_legacy_user_id" IS NULL) = ("reviewed_at" IS NULL)),
  CONSTRAINT "social_content_briefs_maker_checker_chk" CHECK ("reviewed_by_legacy_user_id" IS NULL OR "reviewed_by_legacy_user_id" <> "created_by_legacy_user_id")
);
CREATE INDEX "social_content_briefs_calendar_idx" ON "social_content_briefs" ("tenant_id", "organization_id", "scheduled_for", "status");
CREATE INDEX "social_content_briefs_review_idx" ON "social_content_briefs" ("tenant_id", "organization_id", "created_at") WHERE "status" = 'IN_REVIEW';

CREATE TABLE "social_content_reviews" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "brief_version" bigint NOT NULL,
  "reviewer_legacy_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "decision" text NOT NULL,
  "reason" text,
  "request_key" text NOT NULL,
  "evidence_sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_content_reviews_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "social_content_reviews_brief_fk" FOREIGN KEY ("tenant_id", "brief_id") REFERENCES "social_content_briefs"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_content_reviews_organization_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_content_reviews_once_uq" UNIQUE ("tenant_id", "brief_id", "brief_version"),
  CONSTRAINT "social_content_reviews_request_uq" UNIQUE ("tenant_id", "request_key"),
  CONSTRAINT "social_content_reviews_id_v7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_content_reviews_decision_chk" CHECK ("decision" IN ('APPROVE', 'REJECT')),
  CONSTRAINT "social_content_reviews_hash_chk" CHECK ("evidence_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "social_content_reviews_reason_chk" CHECK ("reason" IS NULL OR length("reason") <= 2000)
);

CREATE TABLE "social_publication_intents" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "scheduled_for" timestamptz NOT NULL,
  "provider_mode" text NOT NULL DEFAULT 'MANAGED_PROVIDER',
  "status" text NOT NULL DEFAULT 'DRAFT',
  "idempotency_key" text NOT NULL,
  "provider_job_ref_hash" text,
  "execution_receipt_hash" text,
  "last_error_code" text,
  "created_by_legacy_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "approved_by_legacy_user_id" integer REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_publication_intents_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "social_publication_intents_brief_fk" FOREIGN KEY ("tenant_id", "brief_id") REFERENCES "social_content_briefs"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_publication_intents_account_fk" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "social_accounts"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_publication_intents_organization_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_publication_intents_scope_key_uq" UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "social_publication_intents_id_v7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_publication_intents_provider_chk" CHECK ("provider_mode" = 'MANAGED_PROVIDER'),
  CONSTRAINT "social_publication_intents_status_chk" CHECK ("status" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'PUBLISHED', 'FAILED', 'CANCELED')),
  CONSTRAINT "social_publication_intents_key_chk" CHECK (length("idempotency_key") BETWEEN 8 AND 160 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT "social_publication_intents_hash_chk" CHECK (("provider_job_ref_hash" IS NULL OR "provider_job_ref_hash" ~ '^[0-9a-f]{64}$') AND ("execution_receipt_hash" IS NULL OR "execution_receipt_hash" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "social_publication_intents_checker_chk" CHECK ("approved_by_legacy_user_id" IS NULL OR "approved_by_legacy_user_id" <> "created_by_legacy_user_id")
);
CREATE INDEX "social_publication_intents_queue_idx" ON "social_publication_intents" ("tenant_id", "organization_id", "status", "scheduled_for");

CREATE TABLE "social_performance_snapshots" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "publication_intent_id" uuid NOT NULL,
  "metrics" jsonb NOT NULL,
  "provider_receipt_hash" text NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_performance_snapshots_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "social_performance_snapshots_intent_fk" FOREIGN KEY ("tenant_id", "publication_intent_id") REFERENCES "social_publication_intents"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_performance_snapshots_organization_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_performance_snapshots_id_v7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_performance_snapshots_metrics_chk" CHECK (jsonb_typeof("metrics") = 'object'),
  CONSTRAINT "social_performance_snapshots_hash_chk" CHECK ("provider_receipt_hash" ~ '^[0-9a-f]{64}$')
);

CREATE OR REPLACE FUNCTION "protect_social_content_review"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'social content reviews are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "social_content_reviews_append_only"
  BEFORE UPDATE OR DELETE ON "social_content_reviews"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_content_review"();

CREATE OR REPLACE FUNCTION "protect_social_performance_snapshot"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'social performance snapshots are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "social_performance_snapshots_append_only"
  BEFORE UPDATE OR DELETE ON "social_performance_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_performance_snapshot"();

CREATE OR REPLACE FUNCTION "enforce_social_brief_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = NEW."status" THEN RETURN NEW; END IF;
  IF (OLD."status" = 'DRAFT' AND NEW."status" IN ('IN_REVIEW', 'ARCHIVED'))
     OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('APPROVED', 'REJECTED'))
     OR (OLD."status" = 'REJECTED' AND NEW."status" IN ('DRAFT', 'ARCHIVED'))
     OR (OLD."status" = 'APPROVED' AND NEW."status" = 'ARCHIVED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid social brief transition: % -> %', OLD."status", NEW."status" USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "social_content_briefs_status_transition"
  BEFORE UPDATE OF "status" ON "social_content_briefs"
  FOR EACH ROW EXECUTE FUNCTION "enforce_social_brief_transition"();

CREATE OR REPLACE FUNCTION "protect_social_brief_content"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" NOT IN ('DRAFT', 'REJECTED') AND (
    OLD."title" IS DISTINCT FROM NEW."title"
    OR OLD."objective" IS DISTINCT FROM NEW."objective"
    OR OLD."audience" IS DISTINCT FROM NEW."audience"
    OR OLD."content_kind" IS DISTINCT FROM NEW."content_kind"
    OR OLD."locales" IS DISTINCT FROM NEW."locales"
    OR OLD."channels" IS DISTINCT FROM NEW."channels"
    OR OLD."campaign_key" IS DISTINCT FROM NEW."campaign_key"
    OR OLD."caption" IS DISTINCT FROM NEW."caption"
    OR OLD."media_refs" IS DISTINCT FROM NEW."media_refs"
    OR OLD."utm" IS DISTINCT FROM NEW."utm"
    OR OLD."scheduled_for" IS DISTINCT FROM NEW."scheduled_for"
    OR OLD."created_by_legacy_user_id" IS DISTINCT FROM NEW."created_by_legacy_user_id"
  ) THEN
    RAISE EXCEPTION 'reviewed social brief content is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "social_content_briefs_protect_content"
  BEFORE UPDATE ON "social_content_briefs"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_brief_content"();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'social_accounts', 'social_content_briefs', 'social_content_reviews',
    'social_publication_intents', 'social_performance_snapshots'
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
    IF table_name IN ('social_accounts', 'social_content_briefs', 'social_publication_intents') THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid AND organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid AND organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)',
        table_name || '_scope_update', table_name
      );
    END IF;
  END LOOP;
END;
$$;

-- Legacy role-package projection for the first local UI slice. Provider
-- execution remains unavailable even when these permissions are present.
UPDATE "roles" SET "permissions" = "permissions" || '["social.view"]'::jsonb, "updated_at" = now()
WHERE "name" IN ('super_admin', 'admin', 'manager') AND NOT "permissions" ? 'social.view';
UPDATE "roles" SET "permissions" = "permissions" || '["social.manage"]'::jsonb, "updated_at" = now()
WHERE "name" IN ('super_admin', 'admin', 'manager') AND NOT "permissions" ? 'social.manage';
UPDATE "roles" SET "permissions" = "permissions" || '["social.approve"]'::jsonb, "updated_at" = now()
WHERE "name" IN ('super_admin', 'admin') AND NOT "permissions" ? 'social.approve';
