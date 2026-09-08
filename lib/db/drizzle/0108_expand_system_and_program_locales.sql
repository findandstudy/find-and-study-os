-- Add seven new UI/programme locales without rewriting the canonical English
-- programme rows. Historical catalogues remain on the bounded reconciliation
-- path; the migration itself must never enqueue an unbounded data set.
ALTER TABLE "program_translations" DROP CONSTRAINT "program_translations_locale_chk";
--> statement-breakpoint
ALTER TABLE "program_translations" ADD CONSTRAINT "program_translations_locale_chk"
CHECK ("locale" IN ('tr','ar','fr','ru','fa','zh','hi','es','id','ur','tk','ky','kk','uz','tg','bn','pt','ne','vi','ko','uk','it'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fas_queue_program_translations"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	v_source_hash text;
BEGIN
	v_source_hash := "fas_program_content_source_hash"(
		NEW."name", NEW."description", NEW."field", NEW."duration", NEW."intakes", NEW."requirements"
	);

	INSERT INTO "program_translations" (
		"program_id", "locale", "source_hash", "status", "next_attempt_at", "updated_at"
	)
	SELECT NEW."id", locale, v_source_hash, 'queued', now(), now()
	FROM unnest(ARRAY['tr','ar','fr','ru','fa','zh','hi','es','id','ur','tk','ky','kk','uz','tg','bn','pt','ne','vi','ko','uk','it']::text[]) AS locale
	ON CONFLICT ("program_id", "locale") DO UPDATE
	SET "source_hash" = EXCLUDED."source_hash",
		"status" = CASE
			WHEN "program_translations"."is_manual" THEN 'stale_manual'
			ELSE 'queued'
		END,
		"attempts" = CASE WHEN "program_translations"."is_manual" THEN "program_translations"."attempts" ELSE 0 END,
		"error_code" = NULL,
		"next_attempt_at" = now(),
		"leased_at" = NULL,
		"lease_expires_at" = NULL,
		"worker_id" = NULL,
		"updated_at" = now()
	WHERE "program_translations"."source_hash" IS DISTINCT FROM EXCLUDED."source_hash";

	RETURN NEW;
END
$$;
--> statement-breakpoint
-- Keep historical data changes explicit and bounded. The authenticated
-- reconciliation endpoint creates missing locale rows in resumable batches.
ALTER TABLE "settings" ALTER COLUMN "supported_languages" SET DEFAULT 'en,tr,ar,fr,ru,fa,zh,hi,es,id,ur,tk,ky,kk,uz,tg,bn,pt,ne,vi,ko,uk,it';
--> statement-breakpoint
UPDATE "settings"
SET "supported_languages" = 'en,tr,ar,fr,ru,fa,zh,hi,es,id,ur,tk,ky,kk,uz,tg,bn,pt,ne,vi,ko,uk,it'
WHERE "supported_languages" IS DISTINCT FROM 'en,tr,ar,fr,ru,fa,zh,hi,es,id,ur,tk,ky,kk,uz,tg,bn,pt,ne,vi,ko,uk,it';
