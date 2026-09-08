# Isolated VPS staging

This topology is only for the fresh, synthetic-data staging environment. It
does not copy production data, enable external delivery or run the portal
automation worker.

Hard boundaries:

- Use the dedicated `findandstudy-staging` Unix account and a clean exact Git
  commit.
- Keep PostgreSQL published only on the configured `127.0.0.1` port.
- Keep `ALLOW_LIVE_INTEGRATIONS=false`, `EMAIL_DELIVERY_DISABLED=true`,
  `BACKGROUND_JOBS_ENABLED=false` and `STUDENT_JOURNEY_V1_MODE=off`.
- Join only the app container to the existing external `root_default` Traefik
  network. The database remains on the internal backend network.
- Never prune Docker images, containers, volumes or application data as part of
  this deployment. Build-cache retention is a separate approved operation.
- Apply schema only with `lib/db/run-staging-migrations.mjs`; never reclassify
  staging as development and never use `drizzle push`.

The checked-in compose file contains no credentials. Host-only configuration,
database passwords, application secrets and the generated initial login remain
under `/opt/findandstudy-staging/secrets` with restrictive permissions.

On this Docker Compose file-provider topology, the three PostgreSQL secret files
are bind-mounted rather than copied into a Swarm secret. They must therefore be
owned by the pinned PostgreSQL container uid/gid (`999:999`) with mode `0400`;
the parent host directory remains `root:findandstudy-staging 0750`, so unrelated
host users cannot traverse it. Application env and initial-login files remain
`root:findandstudy-staging 0640`.

## Canonical host layout

The staging host uses these paths. Do not substitute a production path or copy
production credentials/data into them.

```text
/opt/findandstudy-staging/source      exact clean staging Git checkout
/opt/findandstudy-staging/secrets     host-only configuration and credentials
/opt/findandstudy-staging/data        synthetic staging storage
/opt/findandstudy-staging/backups     checksum-attested staging-only backups
```

The canonical public hostname is `staging.findandstudy.com`. The original
`staging.srv1110168.hstgr.cloud` hostname remains a temporary rollback route;
it is not the accepted UAT origin. Production and the
`Find-And-Study-OS-Next` repository are outside this deployment path.

## Preflight and image build

Run source checks before every build and record the full lowercase commit. The
tracked worktree must be clean and the branch must be synchronized with its
remote before it is treated as reviewed staging source.

```bash
cd /opt/findandstudy-staging/source
git rev-parse --verify HEAD
git status --porcelain=v1 --untracked-files=no
git rev-list --left-right --count HEAD...@{upstream}

docker build \
  --file deploy/staging/Dockerfile \
  --target build \
  --build-arg FASOS_SOURCE_COMMIT=<exact-40-character-commit> \
  --tag findandstudy-staging-build:<commit12> \
  .

docker build \
  --file deploy/staging/Dockerfile \
  --build-arg FASOS_SOURCE_COMMIT=<exact-40-character-commit> \
  --tag findandstudy-staging-app:<commit12> \
  .
```

Keep `compose.env`, `app.env`, database password files, the initial-login file
and the admin-password file under the host-only secrets directory. Never print
their contents, add them to shell history, or copy them into Git. Validate the
core delivery gates and every social execution gate before starting the app.

```bash
grep -x 'ALLOW_LIVE_INTEGRATIONS=false' /opt/findandstudy-staging/secrets/app.env
grep -x 'EMAIL_DELIVERY_DISABLED=true' /opt/findandstudy-staging/secrets/app.env
grep -x 'BACKGROUND_JOBS_ENABLED=false' /opt/findandstudy-staging/secrets/app.env
grep -x 'AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH=true' /opt/findandstudy-staging/secrets/app.env
grep -x 'SOCIAL_PUBLICATION_WORKER_ENABLED=false' /opt/findandstudy-staging/secrets/app.env
grep -x 'SOCIAL_PERFORMANCE_WORKER_ENABLED=false' /opt/findandstudy-staging/secrets/app.env
grep -x 'SOCIAL_CREATIVE_WORKER_ENABLED=false' /opt/findandstudy-staging/secrets/app.env
grep -x 'SOCIAL_AD_WORKER_ENABLED=false' /opt/findandstudy-staging/secrets/app.env
grep -x 'SOCIAL_PROVIDER_CONNECTIVITY_ENABLED=false' /opt/findandstudy-staging/secrets/app.env
grep -x 'SOCIAL_PROVIDER_PUBLISHING_ENABLED=false' /opt/findandstudy-staging/secrets/app.env
grep -x 'SOCIAL_PROVIDER_ADVERTISING_ENABLED=false' /opt/findandstudy-staging/secrets/app.env
grep -x 'SOCIAL_CREATIVE_GENERATION_ENABLED=false' /opt/findandstudy-staging/secrets/app.env
```

## Database adoption and seed

Start only the database first. The application does not own schema creation.

```bash
cd /opt/findandstudy-staging/source/deploy/staging
docker compose \
  --env-file /opt/findandstudy-staging/secrets/compose.env \
  -f compose.yml up -d db
```

Run `lib/db/run-staging-migrations.mjs` from the exact build image, using a
temporary loopback TCP forwarder inside the internal backend network. Supply
all runner confirmations through a restricted host-only env file; do not put a
database URL/password on the command line. The runner requires:

- exact clean source commit and pnpm `10.33.2`;
- `fas_migrator` through `127.0.0.1` to exact database `fasos_staging`;
- exact pre-ledger count and, when non-zero, the exact backup attestation ID;
- PostgreSQL-reported server address/port and a timestamped change ID;
- the dedicated `ALLOW_STAGING_MIGRATIONS=true` and
  `MIGRATION_TARGET_ENV=staging` opt-ins.

After migration, run `deploy/staging/seed-staging.mjs` only for a fresh `109/109`
database with zero users. It creates synthetic reference data and one synthetic
Super Admin; it refuses any other database or pre-populated user table. Keep
the generated password only in `/opt/findandstudy-staging/secrets/admin-password`.

## Start and attest

```bash
cd /opt/findandstudy-staging/source/deploy/staging
docker compose \
  --env-file /opt/findandstudy-staging/secrets/compose.env \
  -f compose.yml up -d app

docker compose \
  --env-file /opt/findandstudy-staging/secrets/compose.env \
  -f compose.yml ps
```

Required acceptance evidence:

- both staging containers are healthy;
- `GET /api/healthz` returns exact HTTP `200`;
- `GET /api/health` returns exact HTTP `200`, `dbConnected=true`, and the
  expected staging release ID;
- TLS verification succeeds and HTTPS sends HSTS;
- the migration ledger is exact `109/109`;
- a server-side login / `auth/me` / logout smoke succeeds with the synthetic
  account without logging its password or session cookie;
- the app runs as UID/GID `10042`, with read-only root filesystem, all Linux
  capabilities dropped and `no-new-privileges` enabled;
- no external delivery, background job or portal automation worker is active.

## Synthetic RBAC UAT

Run role UAT only after the base deployment is healthy and a fresh staging-only
backup has passed an isolated restore drill. Do not reuse the generic E2E setup:
that setup is intentionally restricted to disposable databases whose names
contain `e2e` or `test`.

`deploy/staging/seed-staging-rbac-uat.mjs` provisions the fixed `@audit.test`
matrix used by `rbac-functional.spec.ts`. The seed refuses every target except
`fas_migrator@127.0.0.1:5432/fasos_staging`, requires the exact `109/109` ledger,
accepts only the original staging admin plus its known fixture identities, and
reconciles to exactly 11 UAT users, two agent profiles, one student profile and
12 total users. Keep the UAT password and its complete runner env in
`/opt/findandstudy-staging/secrets` with `root:findandstudy-staging 0640`; never
put either value in Git or a command-line argument.

Run the seed from the exact reviewed staging image with the database container's
network namespace so its database target remains loopback. Required opt-ins are
`ALLOW_STAGING_RBAC_UAT_SEED=true`, `STAGING_TARGET_ENV=staging`,
`ALLOW_LIVE_INTEGRATIONS=false`, an exact source-bound
`STAGING_UAT_CHANGE_ID`, and the observed exact pre-user count (`1` initially,
`12` for an idempotent rerun).

The operator-side browser gate is:

```text
pnpm run test:e2e:staging-rbac
```

It requires exact `PLAYWRIGHT_BASE_URL=https://staging.findandstudy.com`,
`ALLOW_STAGING_RBAC_UAT=true`, `ALLOW_LIVE_INTEGRATIONS=false`, and the
host-only `RBAC_E2E_PASSWORD`. The dedicated Playwright config has no fixture
setup/teardown, no local web servers, no tracing or video, runs one worker, and
targets only the RBAC suite. The suite performs synthetic login/logout-style
session activity and GET authorization checks; it has no payment, message,
email, portal-submit, role-mutation or data-delete request.

When a human operator performs the visual gate directly, use
`STAGING_MANUAL_RBAC_UAT_CHECKLIST_2026-09-02.md`. It fixes the accepted
origin/release, all 11 synthetic identities, the 10 exact UI route checks,
responsive/accessibility spot checks, stop conditions and a secret-free
acceptance record. It never authorizes live delivery or mutating controls.

Run `deploy/staging/run-staging-rbac-uat.mjs` from the exact staging image before
the browser gate. It is pinned to the exact public HTTPS origin and expected
release ID, verifies the health release/database contract, then checks the 11
roles across finance, AI, notification, inbox, pipeline, student and agent
boundaries. It performs only GET requests plus synthetic login and CSRF-bound
logout, emits aggregate counts without credentials/session values, and rejects
redirects or non-JSON identity responses. Supply its password and release-bound
environment through the same restricted host-only env file, not command-line
arguments.

After the run, verify the ledger remains `109/109`, the ten core/social
delivery and worker gates remain off, app logs contain no fatal/unhandled error, and all
unrelated VPS containers retain their pre-run health. Create and restore-drill a
new checksum-attested backup for the accepted 12-user synthetic state.

## Backup and isolated restore drill

Create a custom-format dump with `pg_dump`, restrict it to
`root:findandstudy-staging 0640`, and store a SHA-256 sidecar/attestation. A
backup is not accepted until it opens in a disposable restore drill.

The restore drill must use the exact PostgreSQL digest from `compose.yml`, a
named disposable container, `--network none`, and tmpfs database/runtime
directories. Restore into a new database with `--no-owner --no-privileges`,
then verify at minimum:

- database name is the drill-only name;
- ledger count is exactly `109`;
- the attested synthetic denominator is exact: either the initial one-user
  state, or the accepted RBAC UAT state with 12 users, two active agent
  profiles and one active student profile;
- the public schema is non-empty.

Always remove the drill container through an EXIT trap, and confirm it is absent
afterward. Never mount or restore into `fasos_staging_postgres` during a drill.

## Update and rollback

An update repeats the exact-source build, backup, migration and attestation
sequence. `docker compose up -d app` may replace only the staging app container;
do not restart unrelated VPS projects. If application health fails, point
`FASOS_STAGING_APP_IMAGE` back to the previously attested image and replace only
the app service.

Never use `docker compose down -v`, `docker system prune`, broad container
restart commands, or a database restore as an application rollback. Database
rollback requires a separately reviewed forward fix or an explicitly approved,
staging-only recovery operation.
