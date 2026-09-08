-- Release-bound liveness evidence for the dedicated social publication and
-- performance workers. Rows contain operational metadata only; provider
-- credentials, content and external account identifiers are never stored.

CREATE TABLE "social_worker_heartbeats" (
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "worker_kind" text NOT NULL,
  "worker_id" text NOT NULL,
  "runtime_release_id" text NOT NULL,
  "started_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "social_worker_heartbeats_pk"
    PRIMARY KEY ("tenant_id", "organization_id", "worker_kind", "worker_id"),
  CONSTRAINT "social_worker_heartbeats_organization_fk"
    FOREIGN KEY ("tenant_id", "organization_id")
    REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "social_worker_heartbeats_kind_chk"
    CHECK ("worker_kind" IN ('publication', 'performance')),
  CONSTRAINT "social_worker_heartbeats_worker_id_chk"
    CHECK ("worker_id" ~ '^[A-Za-z0-9._:-]{1,96}$'),
  CONSTRAINT "social_worker_heartbeats_release_chk"
    CHECK ("runtime_release_id" ~ '^[A-Za-z0-9._:-]{1,96}$'),
  CONSTRAINT "social_worker_heartbeats_time_chk"
    CHECK ("last_seen_at" >= "started_at")
);

CREATE INDEX "social_worker_heartbeats_liveness_idx"
  ON "social_worker_heartbeats"
    ("tenant_id", "organization_id", "worker_kind", "last_seen_at" DESC);

ALTER TABLE "social_worker_heartbeats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_worker_heartbeats" FORCE ROW LEVEL SECURITY;

CREATE POLICY "social_worker_heartbeats_scope_select"
  ON "social_worker_heartbeats" FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );

CREATE POLICY "social_worker_heartbeats_scope_insert"
  ON "social_worker_heartbeats" FOR INSERT
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );

CREATE POLICY "social_worker_heartbeats_scope_update"
  ON "social_worker_heartbeats" FOR UPDATE
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );
