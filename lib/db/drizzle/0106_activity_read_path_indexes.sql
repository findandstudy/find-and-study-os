-- Bounded activity/read-path indexes. These support stale-session cleanup,
-- overlap reporting and per-user timelines without changing application data.

CREATE INDEX "user_sessions_activity_user_started_idx"
  ON "user_sessions_activity" ("user_id", "started_at" DESC);

CREATE INDEX "user_sessions_activity_overlap_idx"
  ON "user_sessions_activity" (
    (COALESCE("ended_at", "last_seen_at")), "started_at", "user_id"
  );

CREATE INDEX "user_sessions_activity_active_last_seen_idx"
  ON "user_sessions_activity" ("last_seen_at", "id")
  WHERE "is_active" = true;

CREATE INDEX "user_page_visits_user_entered_idx"
  ON "user_page_visits" ("user_id", "entered_at" DESC);

CREATE INDEX "user_page_visits_module_entered_idx"
  ON "user_page_visits" ("module_name", "entered_at" DESC);

CREATE INDEX "user_activity_events_user_created_idx"
  ON "user_activity_events" ("user_id", "created_at" DESC);

CREATE INDEX "user_presence_status_last_active_idx"
  ON "user_presence" ("status", "last_active_at" DESC)
  WHERE "status" <> 'offline';
