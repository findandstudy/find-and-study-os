#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() {
  echo "[deploy:error] $*" >&2
  exit 1
}

for command_name in git node pnpm curl pm2 tar nginx; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done

# Runtime secrets must live outside both the Git checkout and immutable
# releases. The path is supplied by the operator; its contents are never
# printed or copied into a release.
RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-}"
[ -n "$RUNTIME_ENV_FILE" ] || fail "RUNTIME_ENV_FILE must point to an external runtime env file"
case "$RUNTIME_ENV_FILE" in /*) ;; *) fail "RUNTIME_ENV_FILE must be absolute" ;; esac
[ -f "$RUNTIME_ENV_FILE" ] || fail "RUNTIME_ENV_FILE does not exist"

set -a
# shellcheck disable=SC1090
source "$RUNTIME_ENV_FILE"
set +a

RELEASES_DIR="${RELEASES_DIR:-}"
CURRENT_RELEASE_LINK="${CURRENT_RELEASE_LINK:-}"
LOG_DIR="${LOG_DIR:-}"
PORT="${PORT:-5000}"
CANDIDATE_PORT="${CANDIDATE_PORT:-5057}"
NGINX_BACKUP_PORT="${NGINX_BACKUP_PORT:-$CANDIDATE_PORT}"

for path_name in RELEASES_DIR CURRENT_RELEASE_LINK LOG_DIR; do
  path_value="${!path_name:-}"
  [ -n "$path_value" ] || fail "$path_name is required"
  case "$path_value" in /*) ;; *) fail "$path_name must be absolute" ;; esac
done
[ "$PORT" != "$CANDIDATE_PORT" ] || fail "CANDIDATE_PORT must differ from PORT"
[ "$CANDIDATE_PORT" = "$NGINX_BACKUP_PORT" ] || \
  fail "CANDIDATE_PORT must match NGINX_BACKUP_PORT ($NGINX_BACKUP_PORT)"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || fail "PORT must be numeric"
[[ "$CANDIDATE_PORT" =~ ^[0-9]{2,5}$ ]] || fail "CANDIDATE_PORT must be numeric"

APP_BASE_URL="${APP_BASE_URL:-}"
[ -n "$APP_BASE_URL" ] || fail "APP_BASE_URL is required for Nginx route validation"
NGINX_APP_HOST="$(APP_BASE_URL="$APP_BASE_URL" node -e '
  try {
    const url = new URL(process.env.APP_BASE_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") process.exit(1);
    process.stdout.write(url.hostname);
  } catch { process.exit(1); }
')" || fail "APP_BASE_URL must be an absolute HTTP(S) URL"
[ -n "$NGINX_APP_HOST" ] || fail "APP_BASE_URL has no hostname"
export NGINX_APP_HOST

# Fail before release creation, dependency installation or any process action
# unless deployment and the owning PM2 daemon run under the dedicated service
# account and persistent private objects are not readable by other VPS users.
node "$SOURCE_ROOT/deploy/runtime-boundary-preflight.cjs"
node "$SOURCE_ROOT/deploy/disk-capacity-preflight.cjs"

cd "$SOURCE_ROOT"
git diff --quiet || fail "tracked working tree changes must be committed and reviewed before release"
git diff --cached --quiet || fail "staged changes must be committed and reviewed before release"
node deploy/nginx-preflight.cjs --host "$NGINX_APP_HOST"
SOURCE_COMMIT="$(git rev-parse --verify HEAD)"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${SOURCE_COMMIT:0:12}"
export RELEASE_ID
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
CANDIDATE_LOG="$LOG_DIR/candidate-$RELEASE_ID.log"

[ ! -e "$RELEASE_DIR" ] || fail "release directory already exists: $RELEASE_DIR"
[ -L "$CURRENT_RELEASE_LINK" ] || fail "CURRENT_RELEASE_LINK must already be a symlink managed by the release runbook"
PREVIOUS_RELEASE="$(readlink -f "$CURRENT_RELEASE_LINK")"
[ -d "$PREVIOUS_RELEASE" ] || fail "current release target is not a directory"

mkdir -p "$RELEASES_DIR" "$LOG_DIR"
mkdir "$RELEASE_DIR"

candidate_pid=""
cleanup_candidate() {
  if [ -n "$candidate_pid" ] && kill -0 "$candidate_pid" 2>/dev/null; then
    kill -TERM "$candidate_pid" 2>/dev/null || true
    wait "$candidate_pid" 2>/dev/null || true
  fi
}
trap cleanup_candidate EXIT INT TERM

release_health_ready() {
  health_port="$1"
  expected_release="$2"
  healthz_body="$(curl --fail --silent --show-error --max-time 3 \
    "http://127.0.0.1:$health_port/api/healthz")" || return 1
  curl --fail --silent --show-error --max-time 3 \
    "http://127.0.0.1:$health_port/api/health" >/dev/null || return 1
  EXPECTED_RELEASE_ID="$expected_release" node -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(raw);
        process.exit(payload.releaseId === process.env.EXPECTED_RELEASE_ID ? 0 : 1);
      } catch { process.exit(1); }
    });
  ' <<<"$healthz_body"
}

echo "[1/8] Nginx failover is active; exporting immutable release $RELEASE_ID"
git archive "$SOURCE_COMMIT" | tar -x -C "$RELEASE_DIR"

cd "$RELEASE_DIR"
export APP_RELEASE_DIR="$RELEASE_DIR"
node deploy/data-path-preflight.cjs

echo "[2/8] Installing locked dependencies and building release"
bash deploy/build-production.sh

echo "[3/8] Validating migration ledger without applying migrations"
node lib/db/validate-migrations.mjs

echo "[4/8] Starting isolated candidate API on port $CANDIDATE_PORT"
NODE_ENV=production \
PORT="$CANDIDATE_PORT" \
BACKGROUND_JOBS_ENABLED=false \
node artifacts/api-server/dist/index.cjs >"$CANDIDATE_LOG" 2>&1 &
candidate_pid="$!"

candidate_ready=0
for _attempt in $(seq 1 30); do
  if ! kill -0 "$candidate_pid" 2>/dev/null; then
    fail "candidate API exited before readiness; inspect the candidate log"
  fi
  if release_health_ready "$CANDIDATE_PORT" "$RELEASE_ID"; then
    candidate_ready=1
    break
  fi
  sleep 1
done
[ "$candidate_ready" = "1" ] || fail "candidate API did not become ready"

# Keep the validated candidate alive as Nginx's backup upstream throughout the
# canonical fork/1 restart. It runs with background jobs disabled, so it can
# safely serve read traffic without duplicating schedulers or workers. The EXIT
# trap (or the success cleanup below) always removes it.
kill -0 "$candidate_pid" 2>/dev/null || fail "candidate API exited after readiness"

# The backup port is intentionally empty between releases. Reload only after
# the candidate is healthy so every new Nginx worker starts with fresh upstream
# state and can use the candidate during the canonical restart. Existing
# client/SSE connections drain on old workers and reconnect through new ones.
echo "[4b/8] Reloading Nginx with the healthy candidate available"
nginx -t
nginx -s reload

echo "[5/8] Verifying canonical PM2 topology and release-link ownership"
node deploy/pm2-preflight.cjs --release-link "$CURRENT_RELEASE_LINK"
API_PROCESS_NAME="$(node -p "require('./deploy/ecosystem.config.cjs').processNames.api")"
PORTAL_WORKER_PROCESS_NAME="$(node -p "require('./deploy/ecosystem.config.cjs').processNames.portalWorker")"
PORTAL_STATUS_WORKER_PROCESS_NAME="$(node -p "require('./deploy/ecosystem.config.cjs').processNames.portalStatusWorker")"
PORTAL_LIFECYCLE_WORKER_PROCESS_NAME="$(node -p "require('./deploy/ecosystem.config.cjs').processNames.portalLifecycleWorker")"

switch_release_link() {
  target="$1"
  next_link="${CURRENT_RELEASE_LINK}.next.$$"
  ln -s "$target" "$next_link"
  mv -Tf "$next_link" "$CURRENT_RELEASE_LINK"
}

pm2_process_exists_once() {
  process_name="$1"
  PM2_EXPECTED_PROCESS_NAME="$process_name" pm2 jlist | node -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const processes = JSON.parse(raw);
        const matches = processes.filter(
          (processInfo) => processInfo?.name === process.env.PM2_EXPECTED_PROCESS_NAME,
        );
        process.exit(matches.length === 1 ? 0 : 1);
      } catch { process.exit(1); }
    });
  '
}

restart_pm2_process() {
  process_name="$1"
  clear_port="${2:-false}"

  for restart_attempt in 1 2 3; do
    if [ "$clear_port" = "true" ]; then
      if PORT="" pm2 restart "$process_name" --update-env; then
        return 0
      fi
    elif pm2 restart "$process_name" --update-env; then
      return 0
    fi

    # PM2 can transiently return "Process <id> not found" while a graceful
    # restart is still draining the exact named process. Retry only while the
    # canonical topology still contains exactly one matching process; never
    # create a replacement process from here.
    pm2_process_exists_once "$process_name" || return 1
    [ "$restart_attempt" -lt 3 ] || break
    echo "[deploy] PM2 restart retry $((restart_attempt + 1))/3 for $process_name"
    sleep 2
  done

  return 1
}

restart_optional_pm2_process() {
  process_name="$1"
  if ! pm2_process_exists_once "$process_name"; then
    echo "[deploy] Optional process $process_name is not adopted; leaving it disabled"
    return 0
  fi
  restart_pm2_process "$process_name" true
}

rollback_code() {
  echo "[rollback] Restoring previous code release"
  switch_release_link "$PREVIOUS_RELEASE"
  restart_optional_pm2_process "$PORTAL_LIFECYCLE_WORKER_PROCESS_NAME" || true
  restart_optional_pm2_process "$PORTAL_STATUS_WORKER_PROCESS_NAME" || true
  restart_pm2_process "$PORTAL_WORKER_PROCESS_NAME" true || true
  restart_pm2_process "$API_PROCESS_NAME" || true
  if curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:$PORT/api/healthz" >/dev/null; then
    echo "[rollback] Previous code release is healthy"
  else
    echo "[rollback:error] Previous code release health check failed" >&2
  fi
}

echo "[6/8] Rechecking Nginx failover immediately before cutover"
node deploy/nginx-preflight.cjs --host "$NGINX_APP_HOST"

echo "[7/8] Atomically switching code and draining canonical processes"
switch_release_link "$RELEASE_DIR"
kill -0 "$candidate_pid" 2>/dev/null || {
  rollback_code
  fail "candidate API exited before canonical restart; code rollback attempted"
}
if ! restart_pm2_process "$PORTAL_WORKER_PROCESS_NAME" true; then
  rollback_code
  fail "portal worker restart failed; code rollback attempted"
fi
if ! restart_optional_pm2_process "$PORTAL_STATUS_WORKER_PROCESS_NAME"; then
  rollback_code
  fail "portal status worker restart failed; code rollback attempted"
fi
if ! restart_optional_pm2_process "$PORTAL_LIFECYCLE_WORKER_PROCESS_NAME"; then
  rollback_code
  fail "portal lifecycle worker restart failed; code rollback attempted"
fi
if ! restart_pm2_process "$API_PROCESS_NAME"; then
  rollback_code
  fail "API restart failed; code rollback attempted"
fi

echo "[8/8] Verifying canonical API and saving PM2 state"
live_ready=0
for _attempt in $(seq 1 30); do
  if release_health_ready "$PORT" "$RELEASE_ID"; then
    live_ready=1
    break
  fi
  sleep 1
done
if [ "$live_ready" != "1" ]; then
  rollback_code
  fail "new release failed health checks; previous code release restored"
fi

pm2 save
cleanup_candidate
candidate_pid=""
trap - EXIT INT TERM
echo "[deploy] Release $RELEASE_ID is healthy on canonical port $PORT"
echo "[deploy] Database, runtime env and storage were not migrated, copied or rolled back"
