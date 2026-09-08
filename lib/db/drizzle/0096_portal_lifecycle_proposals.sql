-- Typed application-plane lifecycle proposals. Generic ai_action_queue remains
-- an optional UI projection; it is no longer the authoritative workflow row.

CREATE TABLE IF NOT EXISTS "portal_lifecycle_proposals" (
  "id" bigserial PRIMARY KEY,
  "submission_id" integer NOT NULL,
  "application_id" integer NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "observation_id" integer NOT NULL REFERENCES "portal_lifecycle_observations"("id") ON DELETE RESTRICT,
  "proposal_key" text NOT NULL UNIQUE,
  "observation_hash" text NOT NULL,
  "raw_status" text NOT NULL,
  "current_stage" text NOT NULL,
  "decision" jsonb NOT NULL,
  "artifacts" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "missing_documents" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "application_reference_sync" text,
  "status" text NOT NULL DEFAULT 'pending_review',
  "proposed_by_service" text NOT NULL DEFAULT 'portal-status-worker',
  "proposed_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_by" integer REFERENCES "users"("id") ON DELETE RESTRICT,
  "reviewed_at" timestamptz,
  "executed_at" timestamptz,
  "last_error_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "portal_lifecycle_proposals_submission_application_fk"
    FOREIGN KEY ("submission_id", "application_id")
    REFERENCES "portal_submissions"("id", "application_id") ON DELETE CASCADE,
  CONSTRAINT "portal_lifecycle_proposals_key_chk"
    CHECK ("proposal_key" ~ '^portal_lifecycle:[0-9a-f]{64}$'),
  CONSTRAINT "portal_lifecycle_proposals_observation_hash_chk"
    CHECK ("observation_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "portal_lifecycle_proposals_payload_chk"
    CHECK (
      jsonb_typeof("decision") = 'object'
      AND jsonb_typeof("artifacts") = 'array'
      AND jsonb_typeof("missing_documents") = 'array'
      AND jsonb_array_length("missing_documents") <= 50
    ),
  CONSTRAINT "portal_lifecycle_proposals_status_chk"
    CHECK ("status" IN ('pending_review', 'approved', 'rejected', 'executing', 'executed', 'failed', 'canceled')),
  CONSTRAINT "portal_lifecycle_proposals_review_pair_chk"
    CHECK (("reviewed_by" IS NULL) = ("reviewed_at" IS NULL)),
  CONSTRAINT "portal_lifecycle_proposals_maker_checker_chk"
    CHECK ("proposed_by_user_id" IS NULL OR "reviewed_by" IS NULL OR "proposed_by_user_id" <> "reviewed_by"),
  CONSTRAINT "portal_lifecycle_proposals_error_chk"
    CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[A-Z0-9_:-]{1,80}$')
);

CREATE INDEX IF NOT EXISTS "portal_lifecycle_proposals_review_queue_idx"
  ON "portal_lifecycle_proposals" ("created_at", "id")
  WHERE "status" = 'pending_review';
CREATE INDEX IF NOT EXISTS "portal_lifecycle_proposals_application_idx"
  ON "portal_lifecycle_proposals" ("application_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "portal_lifecycle_proposal_reviews" (
  "id" bigserial PRIMARY KEY,
  "proposal_id" bigint NOT NULL REFERENCES "portal_lifecycle_proposals"("id") ON DELETE RESTRICT,
  "reviewer_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "decision" text NOT NULL,
  "reason" text,
  "request_key" text NOT NULL,
  "evidence_sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "portal_lifecycle_proposal_reviews_once_uq" UNIQUE ("proposal_id"),
  CONSTRAINT "portal_lifecycle_proposal_reviews_request_uq" UNIQUE ("request_key"),
  CONSTRAINT "portal_lifecycle_proposal_reviews_decision_chk" CHECK ("decision" IN ('approve', 'reject')),
  CONSTRAINT "portal_lifecycle_proposal_reviews_reason_chk" CHECK ("reason" IS NULL OR length("reason") <= 1000),
  CONSTRAINT "portal_lifecycle_proposal_reviews_request_chk" CHECK (length("request_key") BETWEEN 1 AND 100 AND "request_key" ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT "portal_lifecycle_proposal_reviews_hash_chk" CHECK ("evidence_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE OR REPLACE FUNCTION "protect_portal_lifecycle_proposal_core"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."submission_id" IS DISTINCT FROM NEW."submission_id"
     OR OLD."application_id" IS DISTINCT FROM NEW."application_id"
     OR OLD."observation_id" IS DISTINCT FROM NEW."observation_id"
     OR OLD."proposal_key" IS DISTINCT FROM NEW."proposal_key"
     OR OLD."observation_hash" IS DISTINCT FROM NEW."observation_hash"
     OR OLD."raw_status" IS DISTINCT FROM NEW."raw_status"
     OR OLD."current_stage" IS DISTINCT FROM NEW."current_stage"
     OR OLD."decision" IS DISTINCT FROM NEW."decision"
     OR OLD."artifacts" IS DISTINCT FROM NEW."artifacts"
     OR OLD."missing_documents" IS DISTINCT FROM NEW."missing_documents"
     OR OLD."application_reference_sync" IS DISTINCT FROM NEW."application_reference_sync"
     OR OLD."proposed_by_service" IS DISTINCT FROM NEW."proposed_by_service"
     OR OLD."proposed_by_user_id" IS DISTINCT FROM NEW."proposed_by_user_id" THEN
    RAISE EXCEPTION 'portal lifecycle proposal core is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "portal_lifecycle_proposals_immutable_core"
  BEFORE UPDATE ON "portal_lifecycle_proposals"
  FOR EACH ROW EXECUTE FUNCTION "protect_portal_lifecycle_proposal_core"();

CREATE OR REPLACE FUNCTION "enforce_portal_lifecycle_proposal_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;
  IF (OLD."status" = 'pending_review' AND NEW."status" IN ('approved', 'rejected', 'canceled'))
     OR (OLD."status" = 'approved' AND NEW."status" IN ('executing', 'executed', 'failed', 'canceled'))
     OR (OLD."status" = 'executing' AND NEW."status" IN ('executed', 'failed')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid portal lifecycle proposal status transition: % -> %', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "portal_lifecycle_proposals_status_transition"
  BEFORE UPDATE OF "status" ON "portal_lifecycle_proposals"
  FOR EACH ROW EXECUTE FUNCTION "enforce_portal_lifecycle_proposal_transition"();

CREATE OR REPLACE FUNCTION "prevent_portal_lifecycle_proposal_review_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'portal lifecycle proposal reviews are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "portal_lifecycle_proposal_reviews_append_only"
  BEFORE UPDATE OR DELETE ON "portal_lifecycle_proposal_reviews"
  FOR EACH ROW EXECUTE FUNCTION "prevent_portal_lifecycle_proposal_review_mutation"();
