-- Correct the original fallback-rule uniqueness contract from 0026.
--
-- The domain uses soft deletion, so historical rows must not reserve the
-- business key forever. The previous non-partial unique index contradicted the
-- canonical Drizzle schema and caused a re-create after DELETE to fail with a
-- database unique violation.
DROP INDEX IF EXISTS "portal_prog_fallback_key_source_uniq";

CREATE UNIQUE INDEX "portal_prog_fallback_key_source_uniq"
  ON "portal_program_fallbacks" ("university_key", "source_program_id")
  WHERE "deleted_at" IS NULL;
