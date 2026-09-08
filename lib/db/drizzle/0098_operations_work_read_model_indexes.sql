-- Additive indexes for the server-side Operations Work read model.
-- No workflow state or existing row is changed by this migration.

CREATE INDEX IF NOT EXISTS "tasks_operations_open_due_idx"
  ON "tasks" ("due_date", "id")
  WHERE "archived_at" IS NULL
    AND "status" <> 'done'
    AND "due_date" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "applications_operations_deadline_idx"
  ON "applications" ("deadline", "id")
  WHERE "deleted_at" IS NULL
    AND "deadline" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "applications_operations_updated_idx"
  ON "applications" ("updated_at", "id")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "documents_operations_review_idx"
  ON "documents" ("status", "updated_at", "id")
  WHERE "deleted_at" IS NULL
    AND "status" IN (
      'rejected',
      'quarantined',
      'pending',
      'review_required',
      'needs_review',
      'scanning'
    );

CREATE INDEX IF NOT EXISTS "portal_lifecycle_observations_submission_latest_idx"
  ON "portal_lifecycle_observations" (
    "submission_id",
    "observed_at" DESC,
    "id" DESC
  );

CREATE INDEX IF NOT EXISTS "application_stage_documents_offer_expiry_idx"
  ON "application_stage_documents" ("valid_until", "application_id", "id")
  WHERE "valid_until" IS NOT NULL;
