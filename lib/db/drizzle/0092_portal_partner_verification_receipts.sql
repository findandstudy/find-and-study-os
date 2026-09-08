-- Version-bound, append-only partner onboarding verification evidence.
-- Additive only: existing portal rows receive generation 1 and no receipt is
-- inferred from historical activity. Production adoption must therefore keep
-- automatic execution disabled until explicit current receipts exist.

ALTER TABLE "portal_universities"
  ADD COLUMN IF NOT EXISTS "verification_generation" integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'portal_universities_verification_generation_chk'
      AND conrelid = 'portal_universities'::regclass
  ) THEN
    ALTER TABLE "portal_universities"
      ADD CONSTRAINT "portal_universities_verification_generation_chk"
      CHECK ("verification_generation" > 0);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "portal_partner_verification_receipts" (
  "id" serial PRIMARY KEY,
  "portal_university_id" integer NOT NULL REFERENCES "portal_universities"("id") ON DELETE RESTRICT,
  "verification_generation" integer NOT NULL,
  "verification_type" text NOT NULL,
  "outcome" text NOT NULL,
  "adapter_key" text NOT NULL,
  "adapter_spec_id" integer REFERENCES "portal_adapter_specs"("id") ON DELETE RESTRICT,
  "adapter_spec_version" integer,
  "adapter_spec_sha256" text,
  "credential_id" integer REFERENCES "portal_credentials"("id") ON DELETE RESTRICT,
  "credential_updated_at" timestamptz,
  "runtime_release_id" text NOT NULL,
  "binding_sha256" text NOT NULL,
  "evidence_sha256" text NOT NULL,
  "request_key" text NOT NULL,
  "application_id" integer REFERENCES "applications"("id") ON DELETE RESTRICT,
  "portal_submission_id" integer,
  "performed_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "failure_code" text,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "portal_partner_verification_submission_application_fk"
    FOREIGN KEY ("portal_submission_id", "application_id")
    REFERENCES "portal_submissions"("id", "application_id") ON DELETE RESTRICT,
  CONSTRAINT "portal_partner_verification_generation_chk" CHECK ("verification_generation" > 0),
  CONSTRAINT "portal_partner_verification_type_chk" CHECK ("verification_type" IN ('TEST_LOGIN', 'STRICT_DRY_RUN')),
  CONSTRAINT "portal_partner_verification_outcome_chk" CHECK ("outcome" IN ('PASSED', 'FAILED')),
  CONSTRAINT "portal_partner_verification_adapter_key_chk" CHECK (length("adapter_key") BETWEEN 1 AND 100),
  CONSTRAINT "portal_partner_verification_spec_binding_chk" CHECK (
    ("adapter_spec_id" IS NULL AND "adapter_spec_version" IS NULL AND "adapter_spec_sha256" IS NULL)
    OR
    ("adapter_spec_id" IS NOT NULL AND "adapter_spec_version" > 0 AND "adapter_spec_sha256" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "portal_partner_verification_credential_binding_chk" CHECK (
    ("credential_id" IS NULL AND "credential_updated_at" IS NULL)
    OR
    ("credential_id" IS NOT NULL AND "credential_updated_at" IS NOT NULL)
  ),
  CONSTRAINT "portal_partner_verification_runtime_release_chk" CHECK ("runtime_release_id" ~ '^[A-Za-z0-9._:-]{1,80}$'),
  CONSTRAINT "portal_partner_verification_hashes_chk" CHECK (
    "binding_sha256" ~ '^[0-9a-f]{64}$' AND "evidence_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "portal_partner_verification_request_key_chk" CHECK (
    length("request_key") BETWEEN 1 AND 100 AND "request_key" ~ '^[A-Za-z0-9._:-]+$'
  ),
  CONSTRAINT "portal_partner_verification_failure_chk" CHECK (
    ("outcome" = 'PASSED' AND "failure_code" IS NULL)
    OR
    ("outcome" = 'FAILED' AND length("failure_code") BETWEEN 1 AND 80)
  ),
  CONSTRAINT "portal_partner_verification_strict_dry_run_chk" CHECK (
    "verification_type" <> 'STRICT_DRY_RUN'
    OR ("application_id" IS NOT NULL AND "portal_submission_id" IS NOT NULL)
  ),
  CONSTRAINT "portal_partner_verification_evidence_chk" CHECK (jsonb_typeof("evidence") = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS "portal_partner_verification_request_uq"
  ON "portal_partner_verification_receipts" (
    "portal_university_id",
    "verification_generation",
    "verification_type",
    "request_key"
  );

CREATE INDEX IF NOT EXISTS "portal_partner_verification_current_idx"
  ON "portal_partner_verification_receipts" (
    "portal_university_id",
    "verification_generation",
    "verification_type",
    "outcome",
    "created_at" DESC
  );

CREATE INDEX IF NOT EXISTS "portal_partner_verification_submission_idx"
  ON "portal_partner_verification_receipts" ("portal_submission_id");

CREATE OR REPLACE FUNCTION "prevent_portal_partner_verification_receipt_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'portal partner verification receipts are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "portal_partner_verification_receipts_append_only"
  BEFORE UPDATE OR DELETE ON "portal_partner_verification_receipts"
  FOR EACH ROW EXECUTE FUNCTION "prevent_portal_partner_verification_receipt_mutation"();
