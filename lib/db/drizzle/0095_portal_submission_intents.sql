-- Immutable submission intent and canonical target identity.
-- Existing rows remain readable with NULL intent fields. Every migrated
-- enqueue path writes them; a later gate may tighten them to NOT NULL after
-- the legacy/import writers have been removed or backfilled.

ALTER TABLE "portal_submissions"
  ADD COLUMN IF NOT EXISTS "submit_intent_key" text,
  ADD COLUMN IF NOT EXISTS "target_identity_sha256" text,
  ADD COLUMN IF NOT EXISTS "target_identity" jsonb,
  ADD COLUMN IF NOT EXISTS "submission_action" text NOT NULL DEFAULT 'submit',
  ADD COLUMN IF NOT EXISTS "supersedes_submission_id" integer REFERENCES "portal_submissions"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "provider_committed_at" timestamptz;

ALTER TABLE "portal_submissions"
  ADD CONSTRAINT "portal_submissions_intent_key_chk"
    CHECK (
      "submit_intent_key" IS NULL
      OR (length("submit_intent_key") BETWEEN 1 AND 160 AND "submit_intent_key" ~ '^[A-Za-z0-9._:-]+$')
    ),
  ADD CONSTRAINT "portal_submissions_target_hash_chk"
    CHECK (
      ("target_identity_sha256" IS NULL AND "target_identity" IS NULL)
      OR
      ("target_identity_sha256" ~ '^[0-9a-f]{64}$' AND jsonb_typeof("target_identity") = 'object')
    ),
  ADD CONSTRAINT "portal_submissions_action_chk"
    CHECK ("submission_action" IN ('submit', 'amend', 'withdraw')),
  ADD CONSTRAINT "portal_submissions_supersede_chk"
    CHECK (
      ("submission_action" = 'submit' AND "supersedes_submission_id" IS NULL)
      OR
      ("submission_action" IN ('amend', 'withdraw') AND "supersedes_submission_id" IS NOT NULL)
    ),
  ADD CONSTRAINT "portal_submissions_provider_commit_chk"
    CHECK (
      "provider_committed_at" IS NULL
      OR ("mode" = 'real' AND "submission_action" = 'submit')
    );

CREATE UNIQUE INDEX IF NOT EXISTS "portal_submissions_intent_key_uq"
  ON "portal_submissions" (coalesce("organization_id", 0), "submit_intent_key")
  WHERE "submit_intent_key" IS NOT NULL AND "deleted_at" IS NULL;

-- A dry run is evidence, not a provider submission. The success identity gate
-- therefore applies only to real submit actions.
CREATE UNIQUE INDEX IF NOT EXISTS "portal_submissions_real_target_success_uq"
  ON "portal_submissions" ("application_id", "target_identity_sha256")
  WHERE "mode" = 'real'
    AND "submission_action" = 'submit'
    AND "target_identity_sha256" IS NOT NULL
    AND "provider_committed_at" IS NOT NULL
    AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "portal_submissions_target_identity_idx"
  ON "portal_submissions" ("target_identity_sha256", "created_at" DESC)
  WHERE "target_identity_sha256" IS NOT NULL AND "deleted_at" IS NULL;

CREATE OR REPLACE FUNCTION "protect_portal_submission_intent"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."submit_intent_key" IS DISTINCT FROM NEW."submit_intent_key"
     OR OLD."target_identity_sha256" IS DISTINCT FROM NEW."target_identity_sha256"
     OR OLD."target_identity" IS DISTINCT FROM NEW."target_identity"
     OR OLD."submission_action" IS DISTINCT FROM NEW."submission_action"
     OR OLD."supersedes_submission_id" IS DISTINCT FROM NEW."supersedes_submission_id"
     OR (
       OLD."provider_committed_at" IS NOT NULL
       AND OLD."provider_committed_at" IS DISTINCT FROM NEW."provider_committed_at"
     ) THEN
    RAISE EXCEPTION 'portal submission intent is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "portal_submissions_immutable_intent"
  BEFORE UPDATE ON "portal_submissions"
  FOR EACH ROW EXECUTE FUNCTION "protect_portal_submission_intent"();
