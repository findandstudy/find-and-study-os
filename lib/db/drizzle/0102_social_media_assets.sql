-- Immutable, tenant-scoped media evidence used by social content briefs.
-- Browser uploads first land under social-media/staging; the API verifies the
-- bytes and copies them to the content-addressed object_path recorded here.

CREATE TABLE "social_media_assets" (
  "id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "object_path" text NOT NULL,
  "content_sha256" text NOT NULL,
  "media_kind" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "original_file_name" text NOT NULL,
  "created_by_legacy_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_media_assets_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "social_media_assets_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "social_media_assets_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_media_assets_content_uq"
    UNIQUE ("tenant_id", "organization_id", "content_sha256"),
  CONSTRAINT "social_media_assets_object_uq" UNIQUE ("object_path"),
  CONSTRAINT "social_media_assets_id_v7_chk"
    CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "social_media_assets_hash_chk"
    CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "social_media_assets_kind_chk"
    CHECK ("media_kind" IN ('image', 'video')),
  CONSTRAINT "social_media_assets_mime_chk"
    CHECK (
      ("media_kind" = 'image' AND "mime_type" IN ('image/jpeg', 'image/png', 'image/webp'))
      OR ("media_kind" = 'video' AND "mime_type" = 'video/mp4')
    ),
  CONSTRAINT "social_media_assets_size_chk"
    CHECK (
      ("media_kind" = 'image' AND "size_bytes" BETWEEN 1 AND 15728640)
      OR ("media_kind" = 'video' AND "size_bytes" BETWEEN 1 AND 26214400)
    ),
  CONSTRAINT "social_media_assets_name_chk"
    CHECK (length("original_file_name") BETWEEN 1 AND 240),
  CONSTRAINT "social_media_assets_path_chk"
    CHECK (
      "object_path" ~ ('^/objects/social-media/assets/' || "tenant_id"::text || '/' || "organization_id"::text || '/[0-9a-f]{64}\.(jpg|png|webp|mp4)$')
    )
);

CREATE INDEX "social_media_assets_scope_created_idx"
  ON "social_media_assets" ("tenant_id", "organization_id", "created_at" DESC, "id");

CREATE OR REPLACE FUNCTION "protect_social_media_asset"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'social media assets are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "social_media_assets_append_only"
  BEFORE UPDATE OR DELETE ON "social_media_assets"
  FOR EACH ROW EXECUTE FUNCTION "protect_social_media_asset"();

ALTER TABLE "social_media_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_media_assets" FORCE ROW LEVEL SECURITY;

CREATE POLICY "social_media_assets_scope_select"
  ON "social_media_assets" FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );

CREATE POLICY "social_media_assets_scope_insert"
  ON "social_media_assets" FOR INSERT
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );
