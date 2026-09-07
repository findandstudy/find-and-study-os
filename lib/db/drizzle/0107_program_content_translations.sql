-- Canonical programme content remains English in programs. These localized
-- projections are generated automatically and never replace the source row.
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
CREATE TABLE "program_translations" (
	"program_id" integer NOT NULL,
	"locale" text NOT NULL,
	"name" text,
	"description" text,
	"field" text,
	"duration" text,
	"intakes" text,
	"requirements" text,
	"source_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"provider" text,
	"model" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"worker_id" text,
	"translated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_translations_pk" PRIMARY KEY("program_id", "locale"),
	CONSTRAINT "program_translations_program_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade,
	CONSTRAINT "program_translations_locale_chk" CHECK ("locale" IN ('tr','ar','fr','ru','fa','zh','hi','es','id','ur','tk','ky','kk','uz','tg')),
	CONSTRAINT "program_translations_status_chk" CHECK ("status" IN ('queued','processing','retrying','published','failed','stale_manual')),
	CONSTRAINT "program_translations_source_hash_chk" CHECK ("source_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "program_translations_attempts_chk" CHECK ("attempts" >= 0 AND "attempts" <= 20),
	CONSTRAINT "program_translations_published_name_chk" CHECK ("status" <> 'published' OR ("name" IS NOT NULL AND length(trim("name")) > 0)),
	CONSTRAINT "program_translations_lease_chk" CHECK (
		("status" = 'processing' AND "leased_at" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "worker_id" IS NOT NULL)
		OR
		("status" <> 'processing' AND "leased_at" IS NULL AND "lease_expires_at" IS NULL AND "worker_id" IS NULL)
	)
);
--> statement-breakpoint
CREATE INDEX "program_translations_queue_idx" ON "program_translations" USING btree ("status", "next_attempt_at", "program_id");
--> statement-breakpoint
CREATE INDEX "program_translations_program_status_idx" ON "program_translations" USING btree ("program_id", "status");
--> statement-breakpoint
CREATE INDEX "program_translations_locale_name_idx" ON "program_translations" USING btree ("locale", "name");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fas_program_content_source_hash"(
	p_name text,
	p_description text,
	p_field text,
	p_duration text,
	p_intakes text,
	p_requirements text
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
	SELECT encode(sha256(convert_to(jsonb_build_object(
		'description', coalesce(p_description, ''),
		'duration', coalesce(p_duration, ''),
		'field', coalesce(p_field, ''),
		'intakes', coalesce(p_intakes, ''),
		'name', coalesce(p_name, ''),
		'requirements', coalesce(p_requirements, '')
	)::text, 'UTF8')), 'hex')
$$;
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
	FROM unnest(ARRAY['tr','ar','fr','ru','fa','zh','hi','es','id','ur','tk','ky','kk','uz','tg']::text[]) AS locale
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
CREATE TRIGGER "programs_queue_translations_trg"
AFTER INSERT OR UPDATE OF "name", "description", "field", "duration", "intakes", "requirements"
ON "programs"
FOR EACH ROW
EXECUTE FUNCTION "fas_queue_program_translations"();
--> statement-breakpoint
-- Existing programmes enter the same durable queue at low operational risk;
-- no external request occurs until the explicitly enabled worker is running.
INSERT INTO "program_translations" ("program_id", "locale", "source_hash", "status", "next_attempt_at")
SELECT p."id", locale,
	"fas_program_content_source_hash"(p."name", p."description", p."field", p."duration", p."intakes", p."requirements"),
	'queued', now()
FROM "programs" p
CROSS JOIN unnest(ARRAY['tr','ar','fr','ru','fa','zh','hi','es','id','ur','tk','ky','kk','uz','tg']::text[]) AS locale
ON CONFLICT ("program_id", "locale") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "supported_languages" SET DEFAULT 'en,tr,ar,fr,ru,fa,zh,hi,es,id,ur,tk,ky,kk,uz,tg';
--> statement-breakpoint
UPDATE "settings"
SET "supported_languages" = 'en,tr,ar,fr,ru,fa,zh,hi,es,id,ur,tk,ky,kk,uz,tg'
WHERE "supported_languages" IS DISTINCT FROM 'en,tr,ar,fr,ru,fa,zh,hi,es,id,ur,tk,ky,kk,uz,tg';
