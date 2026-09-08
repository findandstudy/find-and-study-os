-- Tenant-scoped social attribution read model and account classification.
-- Tracking is deterministic and PII-free. Legacy lead/application identifiers
-- are projected by database triggers so social readers never receive broad
-- SELECT access to the legacy CRM tables.

ALTER TABLE "social_accounts"
  ADD COLUMN "account_kind" text NOT NULL DEFAULT 'PROFILE',
  ADD COLUMN "currency_code" text,
  ADD CONSTRAINT "social_accounts_kind_chk"
    CHECK ("account_kind" IN ('PROFILE', 'PAGE', 'CHANNEL', 'AD_ACCOUNT')),
  ADD CONSTRAINT "social_accounts_currency_chk"
    CHECK (
      ("account_kind" = 'AD_ACCOUNT' AND "currency_code" ~ '^[A-Z]{3}$')
      OR ("account_kind" <> 'AD_ACCOUNT' AND "currency_code" IS NULL)
    );

ALTER TABLE "social_content_briefs"
  ADD COLUMN "tracking_key" text;

UPDATE "social_content_briefs"
SET "tracking_key" = 'fas_' || replace("id"::text, '-', '')
WHERE "tracking_key" IS NULL;

ALTER TABLE "social_content_briefs"
  ALTER COLUMN "tracking_key" SET NOT NULL,
  ADD CONSTRAINT "social_content_briefs_tracking_key_uq" UNIQUE ("tracking_key"),
  ADD CONSTRAINT "social_content_briefs_tracking_key_chk"
    CHECK ("tracking_key" ~ '^fas_[0-9a-f]{32}$');

CREATE INDEX "social_content_briefs_tracking_scope_idx"
  ON "social_content_briefs" ("tenant_id", "organization_id", "tracking_key");

CREATE OR REPLACE FUNCTION "protect_social_brief_tracking_key"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."tracking_key" IS DISTINCT FROM NEW."tracking_key" THEN
    RAISE EXCEPTION 'social brief tracking key is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "social_content_briefs_protect_tracking_key"
  BEFORE UPDATE OF "tracking_key" ON "social_content_briefs"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_brief_tracking_key"();

CREATE TABLE "social_attributed_leads" (
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "tracking_key" text NOT NULL,
  "lead_id" integer NOT NULL REFERENCES "leads"("id") ON DELETE RESTRICT,
  "lead_status" text NOT NULL,
  "converted_student_id" integer REFERENCES "students"("id") ON DELETE SET NULL,
  "lead_deleted_at" timestamptz,
  "first_touch_at" timestamptz NOT NULL,
  "last_observed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_attributed_leads_pk" PRIMARY KEY ("tenant_id", "lead_id"),
  CONSTRAINT "social_attributed_leads_one_touch_uq" UNIQUE ("lead_id"),
  CONSTRAINT "social_attributed_leads_brief_fk"
    FOREIGN KEY ("tenant_id", "brief_id")
    REFERENCES "social_content_briefs"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_attributed_leads_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_attributed_leads_tracking_chk"
    CHECK ("tracking_key" ~ '^fas_[0-9a-f]{32}$'),
  CONSTRAINT "social_attributed_leads_time_chk"
    CHECK ("last_observed_at" >= "first_touch_at")
);

CREATE INDEX "social_attributed_leads_scope_touch_idx"
  ON "social_attributed_leads"
    ("tenant_id", "organization_id", "first_touch_at" DESC, "lead_id");
CREATE INDEX "social_attributed_leads_brief_idx"
  ON "social_attributed_leads"
    ("tenant_id", "organization_id", "brief_id", "first_touch_at" DESC);

CREATE TABLE "social_attributed_applications" (
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "brief_id" uuid NOT NULL,
  "lead_id" integer NOT NULL REFERENCES "leads"("id") ON DELETE RESTRICT,
  "application_id" integer NOT NULL REFERENCES "applications"("id") ON DELETE RESTRICT,
  "application_stage" text NOT NULL,
  "application_deleted_at" timestamptz,
  "application_created_at" timestamptz NOT NULL,
  "last_observed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_attributed_applications_pk"
    PRIMARY KEY ("tenant_id", "application_id"),
  CONSTRAINT "social_attributed_applications_one_touch_uq"
    UNIQUE ("application_id"),
  CONSTRAINT "social_attributed_applications_lead_fk"
    FOREIGN KEY ("tenant_id", "lead_id")
    REFERENCES "social_attributed_leads"("tenant_id", "lead_id") ON DELETE RESTRICT,
  CONSTRAINT "social_attributed_applications_brief_fk"
    FOREIGN KEY ("tenant_id", "brief_id")
    REFERENCES "social_content_briefs"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_attributed_applications_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_attributed_applications_stage_chk"
    CHECK (length("application_stage") BETWEEN 1 AND 128),
  CONSTRAINT "social_attributed_applications_time_chk"
    CHECK ("last_observed_at" >= "application_created_at")
);

CREATE INDEX "social_attributed_applications_scope_created_idx"
  ON "social_attributed_applications"
    ("tenant_id", "organization_id", "application_created_at" DESC, "application_id");
CREATE INDEX "social_attributed_applications_brief_stage_idx"
  ON "social_attributed_applications"
    ("tenant_id", "organization_id", "brief_id", "application_stage");

ALTER TABLE "social_attributed_leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_attributed_leads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "social_attributed_applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_attributed_applications" FORCE ROW LEVEL SECURITY;

CREATE POLICY "social_attributed_leads_scope_select"
  ON "social_attributed_leads" FOR SELECT
  USING (
    (
      tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    )
    OR pg_trigger_depth() > 0
  );
CREATE POLICY "social_attributed_leads_trigger_insert"
  ON "social_attributed_leads" FOR INSERT
  WITH CHECK (pg_trigger_depth() > 0);
CREATE POLICY "social_attributed_leads_trigger_update"
  ON "social_attributed_leads" FOR UPDATE
  USING (pg_trigger_depth() > 0)
  WITH CHECK (pg_trigger_depth() > 0);

CREATE POLICY "social_attributed_applications_scope_select"
  ON "social_attributed_applications" FOR SELECT
  USING (
    (
      tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    )
    OR pg_trigger_depth() > 0
  );
CREATE POLICY "social_attributed_applications_trigger_insert"
  ON "social_attributed_applications" FOR INSERT
  WITH CHECK (pg_trigger_depth() > 0);
CREATE POLICY "social_attributed_applications_trigger_update"
  ON "social_attributed_applications" FOR UPDATE
  USING (pg_trigger_depth() > 0)
  WITH CHECK (pg_trigger_depth() > 0);

-- FORCE RLS also protects the brief registry. This narrowly-scoped policy lets
-- the lead trigger resolve only the unguessable system tracking key while the
-- trigger is executing; it does not open a direct reader path.
CREATE POLICY "social_content_briefs_attribution_trigger_select"
  ON "social_content_briefs" FOR SELECT
  USING (pg_trigger_depth() > 0);

CREATE OR REPLACE FUNCTION "sync_social_attribution_from_lead"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  brief_row record;
  attributed_row record;
BEGIN
  -- Once a lead has a first-touch owner, later UTM edits may refresh its CRM
  -- outcome but can never move it to another brief, organization, or tenant.
  SELECT "tenant_id", "organization_id", "brief_id", "lead_id"
    INTO attributed_row
  FROM public."social_attributed_leads"
  WHERE "lead_id" = NEW."id"
  LIMIT 1;

  IF FOUND THEN
    UPDATE public."social_attributed_leads"
    SET "lead_status" = NEW."status",
        "converted_student_id" = NEW."converted_student_id",
        "lead_deleted_at" = NEW."deleted_at",
        "last_observed_at" = now()
    WHERE "tenant_id" = attributed_row."tenant_id"
      AND "lead_id" = NEW."id";
  ELSE
  IF NEW."utm_content" IS NULL
     OR NEW."utm_content" !~ '^fas_[0-9a-f]{32}$' THEN
    RETURN NEW;
  END IF;

  SELECT "tenant_id", "organization_id", "id", "tracking_key"
    INTO brief_row
  FROM public."social_content_briefs"
  WHERE "tracking_key" = NEW."utm_content";
  IF NOT FOUND THEN RETURN NEW; END IF;

  INSERT INTO public."social_attributed_leads"
    ("tenant_id", "organization_id", "brief_id", "tracking_key", "lead_id",
     "lead_status", "converted_student_id", "lead_deleted_at", "first_touch_at",
     "last_observed_at")
  VALUES
    (brief_row."tenant_id", brief_row."organization_id", brief_row."id",
     brief_row."tracking_key", NEW."id", NEW."status", NEW."converted_student_id",
     NEW."deleted_at", NEW."created_at", now())
  ON CONFLICT ("lead_id") DO UPDATE SET
    "lead_status" = EXCLUDED."lead_status",
    "converted_student_id" = EXCLUDED."converted_student_id",
    "lead_deleted_at" = EXCLUDED."lead_deleted_at",
    "last_observed_at" = now()
  RETURNING "tenant_id", "organization_id", "brief_id", "lead_id"
    INTO attributed_row;
  END IF;

  INSERT INTO public."social_attributed_applications"
    ("tenant_id", "organization_id", "brief_id", "lead_id", "application_id",
     "application_stage", "application_deleted_at", "application_created_at",
     "last_observed_at")
  SELECT attributed_row."tenant_id", attributed_row."organization_id",
         attributed_row."brief_id", attributed_row."lead_id", app."id",
         app."stage", app."deleted_at", app."created_at", now()
  FROM public."applications" app
  WHERE app."lead_id" = NEW."id"
  ON CONFLICT ("application_id") DO UPDATE SET
    "application_stage" = EXCLUDED."application_stage",
    "application_deleted_at" = EXCLUDED."application_deleted_at",
    "last_observed_at" = now();

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "sync_social_attribution_from_application"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_row record;
  lead_row record;
BEGIN
  SELECT "tenant_id", "organization_id", "brief_id", "lead_id"
    INTO existing_row
  FROM public."social_attributed_applications"
  WHERE "application_id" = NEW."id"
  LIMIT 1;

  IF FOUND THEN
    UPDATE public."social_attributed_applications"
    SET "application_stage" = NEW."stage",
        "application_deleted_at" = NEW."deleted_at",
        "last_observed_at" = now()
    WHERE "tenant_id" = existing_row."tenant_id"
      AND "application_id" = NEW."id";
    RETURN NEW;
  END IF;

  IF NEW."lead_id" IS NULL THEN RETURN NEW; END IF;
  SELECT "tenant_id", "organization_id", "brief_id", "lead_id"
    INTO lead_row
  FROM public."social_attributed_leads"
  WHERE "lead_id" = NEW."lead_id"
  LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;

  INSERT INTO public."social_attributed_applications"
    ("tenant_id", "organization_id", "brief_id", "lead_id", "application_id",
     "application_stage", "application_deleted_at", "application_created_at",
     "last_observed_at")
  VALUES
    (lead_row."tenant_id", lead_row."organization_id", lead_row."brief_id",
     lead_row."lead_id", NEW."id", NEW."stage", NEW."deleted_at",
     NEW."created_at", now())
  ON CONFLICT ("application_id") DO UPDATE SET
    "application_stage" = EXCLUDED."application_stage",
    "application_deleted_at" = EXCLUDED."application_deleted_at",
    "last_observed_at" = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "sync_social_attribution_from_lead"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "sync_social_attribution_from_application"() FROM PUBLIC;

CREATE TRIGGER "leads_social_attribution_sync"
  AFTER INSERT OR UPDATE OF "utm_content", "status", "converted_student_id", "deleted_at"
  ON "leads"
  FOR EACH ROW EXECUTE FUNCTION "sync_social_attribution_from_lead"();

CREATE TRIGGER "applications_social_attribution_sync"
  AFTER INSERT OR UPDATE OF "lead_id", "stage", "deleted_at"
  ON "applications"
  FOR EACH ROW EXECUTE FUNCTION "sync_social_attribution_from_application"();
