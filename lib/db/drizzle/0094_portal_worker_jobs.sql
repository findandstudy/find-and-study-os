-- Worker-only browser execution control plane.
-- API processes may enqueue and observe these jobs, but may not execute any
-- adapter/browser action. Every accepted job is pinned to one immutable
-- runtime release and every terminal attempt produces an append-only receipt.

CREATE TABLE IF NOT EXISTS "portal_worker_heartbeats" (
  "worker_kind" text NOT NULL,
  "worker_id" text NOT NULL,
  "runtime_release_id" text NOT NULL,
  "execution_modes" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "portal_worker_heartbeats_pk" PRIMARY KEY ("worker_kind", "worker_id"),
  CONSTRAINT "portal_worker_heartbeats_kind_chk"
    CHECK ("worker_kind" IN ('portal_execution')),
  CONSTRAINT "portal_worker_heartbeats_worker_id_chk"
    CHECK (length("worker_id") BETWEEN 1 AND 160),
  CONSTRAINT "portal_worker_heartbeats_release_chk"
    CHECK ("runtime_release_id" ~ '^[A-Za-z0-9._:-]{1,80}$'),
  CONSTRAINT "portal_worker_heartbeats_modes_chk"
    CHECK ("execution_modes" <@ ARRAY['test_login', 'dry', 'real', 'status_check', 'artifact', 'program_catalog_sync', 'lifecycle_execute']::text[])
);

CREATE TABLE IF NOT EXISTS "portal_worker_jobs" (
  "id" bigserial PRIMARY KEY,
  "job_kind" text NOT NULL,
  "portal_university_id" integer REFERENCES "portal_universities"("id") ON DELETE RESTRICT,
  "request_key" text NOT NULL,
  "requested_release_id" text NOT NULL,
  "payload_sha256" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "locked_at" timestamptz,
  "locked_by" text,
  "last_error_code" text,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "result" jsonb,
  "requested_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  CONSTRAINT "portal_worker_jobs_kind_chk"
    CHECK ("job_kind" IN ('test_login', 'status_sweep', 'program_catalog_sync', 'lifecycle_execute')),
  CONSTRAINT "portal_worker_jobs_partner_chk"
    CHECK (("job_kind" IN ('status_sweep', 'lifecycle_execute')) = ("portal_university_id" IS NULL)),
  CONSTRAINT "portal_worker_jobs_request_key_chk"
    CHECK (length("request_key") BETWEEN 1 AND 100 AND "request_key" ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT "portal_worker_jobs_release_chk"
    CHECK ("requested_release_id" ~ '^[A-Za-z0-9._:-]{1,80}$'),
  CONSTRAINT "portal_worker_jobs_payload_hash_chk"
    CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$' AND jsonb_typeof("payload") = 'object'),
  CONSTRAINT "portal_worker_jobs_status_chk"
    CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter', 'canceled')),
  CONSTRAINT "portal_worker_jobs_attempts_chk"
    CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 10 AND "attempts" <= "max_attempts"),
  CONSTRAINT "portal_worker_jobs_lock_pair_chk"
    CHECK (("locked_at" IS NULL) = ("locked_by" IS NULL)),
  CONSTRAINT "portal_worker_jobs_terminal_chk"
    CHECK (
      ("status" IN ('succeeded', 'failed', 'dead_letter', 'canceled')) = ("finished_at" IS NOT NULL)
    ),
  CONSTRAINT "portal_worker_jobs_result_chk"
    CHECK ("result" IS NULL OR jsonb_typeof("result") = 'object'),
  CONSTRAINT "portal_worker_jobs_error_chk"
    CHECK ("last_error_code" IS NULL OR (length("last_error_code") BETWEEN 1 AND 80 AND "last_error_code" ~ '^[A-Z0-9_:-]+$'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "portal_worker_jobs_request_uq"
  ON "portal_worker_jobs" (
    "job_kind",
    coalesce("portal_university_id", 0),
    "request_key"
  );

CREATE INDEX IF NOT EXISTS "portal_worker_jobs_claim_idx"
  ON "portal_worker_jobs" ("status", "next_attempt_at", "created_at", "id")
  WHERE "status" = 'queued';

CREATE INDEX IF NOT EXISTS "portal_worker_jobs_partner_idx"
  ON "portal_worker_jobs" ("portal_university_id", "created_at" DESC);

CREATE OR REPLACE FUNCTION "protect_portal_worker_job_command"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."job_kind" IS DISTINCT FROM NEW."job_kind"
     OR OLD."portal_university_id" IS DISTINCT FROM NEW."portal_university_id"
     OR OLD."request_key" IS DISTINCT FROM NEW."request_key"
     OR OLD."requested_release_id" IS DISTINCT FROM NEW."requested_release_id"
     OR OLD."payload_sha256" IS DISTINCT FROM NEW."payload_sha256"
     OR OLD."payload" IS DISTINCT FROM NEW."payload"
     OR OLD."max_attempts" IS DISTINCT FROM NEW."max_attempts"
     OR OLD."requested_by" IS DISTINCT FROM NEW."requested_by"
     OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'portal worker job command is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "portal_worker_jobs_immutable_command"
  BEFORE UPDATE ON "portal_worker_jobs"
  FOR EACH ROW EXECUTE FUNCTION "protect_portal_worker_job_command"();

CREATE OR REPLACE FUNCTION "enforce_portal_worker_job_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;
  IF (OLD."status" = 'queued' AND NEW."status" IN ('running', 'canceled'))
     OR (OLD."status" = 'running' AND NEW."status" IN ('queued', 'succeeded', 'failed', 'dead_letter')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid portal worker job status transition: % -> %', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "portal_worker_jobs_status_transition"
  BEFORE UPDATE OF "status" ON "portal_worker_jobs"
  FOR EACH ROW EXECUTE FUNCTION "enforce_portal_worker_job_transition"();

CREATE TABLE IF NOT EXISTS "portal_worker_job_receipts" (
  "id" bigserial PRIMARY KEY,
  "job_id" bigint NOT NULL REFERENCES "portal_worker_jobs"("id") ON DELETE RESTRICT,
  "attempt" integer NOT NULL,
  "outcome" text NOT NULL,
  "worker_id" text NOT NULL,
  "runtime_release_id" text NOT NULL,
  "evidence_sha256" text NOT NULL,
  "error_code" text,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "portal_worker_job_receipts_attempt_uq" UNIQUE ("job_id", "attempt"),
  CONSTRAINT "portal_worker_job_receipts_attempt_chk" CHECK ("attempt" > 0),
  CONSTRAINT "portal_worker_job_receipts_outcome_chk" CHECK ("outcome" IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTER')),
  CONSTRAINT "portal_worker_job_receipts_worker_id_chk" CHECK (length("worker_id") BETWEEN 1 AND 160),
  CONSTRAINT "portal_worker_job_receipts_release_chk" CHECK ("runtime_release_id" ~ '^[A-Za-z0-9._:-]{1,80}$'),
  CONSTRAINT "portal_worker_job_receipts_hash_chk" CHECK ("evidence_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "portal_worker_job_receipts_error_chk" CHECK (
    ("outcome" = 'SUCCEEDED' AND "error_code" IS NULL)
    OR
    ("outcome" <> 'SUCCEEDED' AND length("error_code") BETWEEN 1 AND 80 AND "error_code" ~ '^[A-Z0-9_:-]+$')
  ),
  CONSTRAINT "portal_worker_job_receipts_evidence_chk" CHECK (jsonb_typeof("evidence") = 'object')
);

CREATE OR REPLACE FUNCTION "prevent_portal_worker_job_receipt_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'portal worker job receipts are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "portal_worker_job_receipts_append_only"
  BEFORE UPDATE OR DELETE ON "portal_worker_job_receipts"
  FOR EACH ROW EXECUTE FUNCTION "prevent_portal_worker_job_receipt_mutation"();
