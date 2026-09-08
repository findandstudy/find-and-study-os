# Portal Automation Closed-Loop v1 — Implementation Record

Date: 4 September 2026
Branch: `codex/reporting-intelligence-center-20260903`
State: exact-head staging deployment and read-only UAT complete; production not deployed

## Delivered scope

1. Dynamic trigger stages
   - The admin surface reads the current application pipeline catalog.
   - Newly discovered stages are visible but default to unselected.
   - Terminal, won and lost stages cannot trigger an external submission.
   - Saved keys that no longer exist fail closed instead of being invented.

2. No-code adapter onboarding
   - Admins can upload a bounded JSON adapter specification without editing the
     application source.
   - Unknown properties and malformed or oversized payloads are rejected.
   - Every canonical spec version has a stable SHA-256 identity.
   - Dry-run and fixture evidence is required before activation.
   - Privileged operations and JavaScript hooks require separate approvals
     bound to the exact immutable version.
   - Version 2 packages can also declare a bounded, read-only `statusCheck`;
     only navigation, waiting, capture, assertion, variable assignment and
     non-mutating HTTP GET steps are accepted.
   - Status, missing-document data and the official application number can be
     mapped from captured/structured values without adding application code.
     Identity proof and the official number are emitted only when the captured
     application identity exactly equals the requested external reference.
   - The same package can map offer, deposit, acceptance, final-acceptance and
     student-card download controls. Collection is a separate second phase and
     runs only when that status needs a file which is not already present.

3. Evidence-bound lifecycle monitoring
   - Adapter status results can carry semantic application identity proof,
     structured missing-document items and a verified official application
     number.
   - Observations are redacted, bounded, hashed, append-only and deduplicated.
   - The submission/application composite foreign key prevents cross-case
     attachment.
   - Raw provider errors are collapsed to fixed PII-free failure codes.
   - The official application number is written only with complete semantic
     proof; a conflicting existing value is never overwritten.

4. Safe lifecycle actions
   - Portal statuses normalize to a canonical disposition vocabulary.
   - Missing documents, fee requests, offers, payment receipts, final letters
     and enrolment signals create deterministic, idempotent review proposals.
   - Artifact-bearing stages cannot be proposed until the exact artifact exists
     in the OS.
   - Proposal creation is durable and precedes a terminal submission update.
   - Proposals remain human-approval-only and never authorize portal mutation,
     payment, external messaging or direct CRM stage mutation.

5. Safe portal artifact intake
   - Authenticated downloads are restricted to the adapter's exact origin;
     redirects are denied and the final response origin is checked again.
   - A declared positive content length, a 15 MiB hard ceiling, an allowlisted
     MIME type and matching PDF/JPEG/PNG magic bytes are all required.
   - Application-scoped content-addressed keys and a database unique index
     prevent retry or concurrency from creating duplicate files or rows.
   - The document is bound to the exact observation, submission and application
     by a composite foreign key and appears in the existing Application document
     area with a Portal Automation badge.
   - Automation is a distinct non-human source; it never impersonates a staff
     uploader, and portal-collected evidence cannot be deleted through the
     stage-document API.

6. High-volume queue isolation
   - Row ownership uses PostgreSQL `FOR UPDATE SKIP LOCKED` leases.
   - Adapter+university lanes use a session advisory lease, guaranteeing one
     active browser session per portal account across API instances.
   - Different lanes run in parallel; a slow or broken institution does not
     block another institution.
   - Per-lane sessions, 60-second operation timeouts, bounded batch sizes,
     deterministic exponential backoff and eight-failure quarantine are used.
   - Successful polling uses disposition-aware 2–24 hour cadence plus stable
     jitter instead of a fixed 15-minute global loop.
   - Offers and final acceptance remain monitored for later enrolment/card
     evidence; only closed-loop terminal outcomes stop the lane item.

7. Operations console
   - The Portal Automation page now includes an Operations tab consistent with
     the existing admin shell.
   - It shows aggregate health, per-lane backlog, retry/quarantine counts,
     redacted recent observations and pending approval counts.
   - Manual bounded sweep and quarantine resume commands are admin-only;
     resume is audited and only succeeds for a currently suspended row.
   - Responses are `private, no-store` and do not expose raw status text,
     credentials, student PII or official application numbers.

8. Code-free partner onboarding control plane
   - Portal Automation opens on a shell-consistent **Partner Setup** workspace
     that brings configuration, safety state and partner readiness into one
     operational view instead of relying on scattered toggles.
   - The secret-free projection evaluates adapter registration, credential-free
     HTTPS URL safety, encrypted credential presence, CRM catalog linkage,
     active-program coverage and version-bound graduation evidence.
   - A newly added partner is always inert. Activation, auto-process and
     manual/automatic fan-out are denied server-side until their respective
     readiness gates pass; the UI reflects the same authoritative decision.
   - Credential, adapter-version and routing changes atomically deactivate all
     affected partners, disable auto-process/fan-out and cancel queued work for
     review. A running submission blocks the change and rolls the transaction
     back, preventing split-brain execution with stale configuration.
   - Custom/declarative adapter graduation only counts durable successes after
     the currently enabled spec version's activation epoch. Proof from an old
     behavior version cannot silently graduate a replacement version.

## Schema and compatibility

`0090_portal_lifecycle_observations.sql` and
`0091_portal_application_artifact_intake.sql` are additive. They add status-check
lease, retry and quarantine columns to `portal_submissions`, an idempotency key
to `ai_action_queue`, the append-only observation table and evidence-source
binding on `application_stage_documents`.
Existing rows receive safe defaults; no table or populated column is dropped,
renamed or rewritten. The canonical local ledger is `92/92`.

The deployment must still follow the repository production preflight. In
particular, the index/constraint lock impact must be checked on the current
production schema and row counts before any production migration approval.

## Verification evidence

- Exact deployed code-bearing commit:
  `4f4ce4df3e01b0e71e84a64c02424847a1e6056f`.
- Exact-head GitHub Actions: Institution Admissions Gate
  `33882911515`, Portal Automation Gate `33882911634` and Live-first
  Convergence Gate `33882911333`; all completed successfully.
- Migration validation: `92 files / 92 journal entries`.
- Fresh disposable PostgreSQL apply: `0 → 92`; clean replay: `92 → 92`.
- Portal pure contracts: `26/26`.
- Dynamic trigger policy: `4/4`.
- Partner readiness policy: `8/8`.
- Adapter registry behavior: `15/15`.
- Adapter graduation, including version-epoch reset: `10/10`.
- Portal Management API: `9/9`; Portal Universities credential boundary:
  `9/9`; adapter-spec admin transaction boundary: `1/1`.
- PostgreSQL observation, lane, Guardian, operations and artifact tests: `7/7`.
- Migration authority: `31 PASS`, `1` Bash-unavailable Windows skip.
- Package-manager guard: `6/6`, exact pnpm `10.33.2`.
- Workspace and targeted API/portal-worker typechecks: PASS.
- Ten-language i18n synchronization: PASS.
- API and Edcons production builds: PASS.
- `git diff --check`: PASS.

## Staging adoption evidence

- Canonical URL: `https://staging.findandstudy.com/admin/portal-automation`.
- Release: `staging-20260904T143054Z-4f4ce4df3e01` using runtime image
  `sha256:7c4de1e8c79c16ab94423529e2a9f939d3882a573fcbeb5a14469dd479db601d`.
- The immediate pre-adoption dump is
  `staging-backup-20260904T140614Z-852b03b671e1` (`4,566,372` bytes,
  SHA-256 `e01c0727ac10d8b04c17fad51eb0a76188633ccc9ba6adb44b2d77386ab1487f`,
  `0640 root:findandstudy-staging`). Its network-isolated PostgreSQL 16.15
  restore reproduced ledger `90`, 13 synthetic users, zero applications and
  zero portal submissions; the disposable restore container was removed.
- The first restore assertion expected the earlier 12-user baseline and also
  queried the not-yet-created lifecycle table. It failed closed after the
  backup had completed. The accepted rerun used the measured 13-user baseline,
  treated absence of the pre-`0090` table as the expected value, and passed.
- The least-privilege reviewed migration runner advanced only staging from
  ledger `90/90` to `92/92`. Post-adoption counts remained 13 users, zero
  applications, zero portal submissions and zero lifecycle observations.
- Only `findandstudy-staging-app-1` was recreated. It runs as UID/GID `10042`,
  with a read-only root filesystem, all capabilities dropped,
  `no-new-privileges`, health `healthy` and restart count `0`.
- Public `/api/healthz` and `/api/health` returned HTTP `200`, the exact release
  ID and `dbConnected=true`; HSTS is active. Six further samples at five-second
  intervals all returned the same exact result. App logs contained zero
  fatal/unhandled/uncaught matches.
- `ALLOW_LIVE_INTEGRATIONS=false`, `EMAIL_DELIVERY_DISABLED=true`,
  `BACKGROUND_JOBS_ENABLED=false` and
  `AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH=true` remained effective. Portal worker
  count was zero, and no portal, email, WhatsApp, payment or notification call
  was made.
- Authenticated read-only browser UAT opened Rules, Operations, Adapter
  Management, Submission Board and Audit Log. Dynamic stages came from the
  Application Pipeline; terminal Enrolled/Rejected stages were disabled. No
  submit, status sweep, adapter upload, setting save or other mutation ran.
- Final root filesystem use was `80%`, with `21,072,498,688` bytes available.
  No Docker prune or unrelated container restart was performed.

### No-outbound synthetic adapter gate

- The exact deployed build image `findandstudy-staging-build:4f4ce4df3e01`
  ran the v2 adapter production slice with a read-only root filesystem and
  `--network none`. All `26/26` checks passed, including canonical spec hashing,
  version-bound privileged approval, read-only status mapping, exact
  application-reference proof, verified official application number, bounded
  artifact collection, MIME/magic validation, content-addressed idempotency,
  lifecycle proposals, adaptive polling and fixed error redaction.
- A separate PostgreSQL 16.15 container used tmpfs storage, `--network none`
  and port `5433`; test processes shared only that network namespace. The
  reviewed runner applied ledger `0 → 92`, then adapter admin/version workflow,
  observation binding, distributed lane lease, fair claims, poison-row
  quarantine, concurrent Guardian idempotency, operations authorization and
  artifact persistence passed `8/8`.
- The disposable database reconciled to `92/92` with zero users, applications,
  submissions, lifecycle observations and adapter specs, then its container was
  removed. An initial attempt on port `5432` was rejected by the runner's hard
  `127.0.0.1:5433` target pin and cleaned up before the accepted run.
- Live staging was queried only for aggregate state. It contained zero active
  portal credentials, zero configured portal universities, zero adapter specs,
  zero submission lanes and zero applications/documents/observations. Messages,
  broadcasts, portal submissions, finance mutation requests and Journey outbox
  events were all `0` before and after the gate.
- Post-gate browser regression kept Rules in Test Mode with automation,
  fallback, fan-out and scheduled processing off. Operations remained all-zero;
  dynamic pipeline stages and disabled terminal stages were unchanged. Public
  health, ledger `92/92`, restart count `0` and zero fatal log matches passed;
  no test container remained.
- Because there is no active credential, university or adapter configuration,
  enabling a portal worker would be both ineffective and outside the approved
  boundary. The first real partner must be onboarded as one explicit staging
  pilot with its exact domain/origin, encrypted credential reference, immutable
  adapter version and separate dry-run/activation approvals.

## Explicitly not performed

- No pull-request merge, branch protection change or production deployment.
- No production migration, service restart, worker restart or credential read.
- No real portal submission, polling, email, WhatsApp, payment or notification.
- No local database or storage copy was sent to a remote environment.

## Required next gate

Before any staging worker or integration is enabled, run a synthetic
allowlisted adapter fixture for the exact approved version and re-attest that
lane ownership, credential references and external-write denominators remain
bounded. Production remains NO-GO until the repository production preflight,
current production row/lock impact review, rollback plan and separate user
approval are complete for an exact release.

## Custom adapter graduation hardening and first-partner gate

The no-code onboarding boundary was re-audited after the no-outbound gate. An
unknown or newly uploaded adapter key was not present in the static
experimental-key set and could therefore be interpreted as non-experimental by
callers that used only `isExperimentalAdapterKey`. This was corrected
fail-closed:

- every unknown/declarative adapter now starts experimental and manual-only;
- graduation is calculated server-side from durable, distinct successful
  submission proofs with an exact threshold of three;
- the Portal Universities API returns row-level `experimental`,
  `staticExperimental`, `successCount`, `graduationThreshold` and `graduated`
  values;
- the admin UI consumes that authoritative row state and conservatively
  disables auto-process for a key absent from the registry response;
- a custom adapter cannot inherit production-ready status merely because its
  key is absent from the built-in list.

The three code commits are `86c15011a82541778201c6d2767c0e7c50dd105d`,
`2b0dbb861f4453278efdefb1c8d0a5fa7f92c447` and
`575763b13e6a3833e0646f3f44ca3fd1f8b2359f`. Exact-head GitHub Actions on
`575763b13e6a3833e0646f3f44ca3fd1f8b2359f` all succeeded: Portal Automation
Gate `33888388971`, Live-first Convergence Gate `33888388995` and Institution
Admissions Gate `33888389135`. The convergence route registry was refreshed
from an exact re-audit of 73 route files and 804 registrations: 720
`requireAuth`, 480 `requireRole`, 47 `requirePermission`, 29 direct-role checks,
72 legacy-quarantine files and one corridor-migrated file, with zero errors.

The reviewed adapter image passed the complete production slice `434 + 101 =
535/535` with network disabled. Registry behavior passed `15/15`. A separate
network-isolated PostgreSQL 16.15 run applied `0 → 92`, then passed adapter
graduation `9/9`, including manual-only custom-key start and exact three-proof
graduation. A second disposable `0 → 92` database passed Portal Management
API projection `9/9`, including the row-level custom adapter state. API and
Edcons direct TypeScript checks passed. All disposable containers were removed.

### Staging release re-attestation

- Immediate pre-deploy backup:
  `staging-backup-20260904T151905Z-4f4ce4df3e01` (`4,684,775` bytes,
  SHA-256 `abc53f4b6c0ce35cd2fa43f04f63bb93de4c22114433685c48056ee69272ae8e`,
  `0640 root:findandstudy-staging`). A network-isolated PostgreSQL 16.15 restore
  reproduced ledger `92`, 13 synthetic users, zero applications and zero
  portal submissions; the restore container was removed.
- Exact release:
  `staging-20260904T152458Z-575763b13e6a`, runtime image
  `sha256:ed82bb6320f0bfec30e0794f0249128a65a376885b90ece7655f0a9dc3e140fa`
  and build image
  `sha256:67868f39599f6709f3e30682a5cf5f8bee27daccb936a798fe4b78bf665f14b2`.
- Only the staging app container was recreated. It is healthy with restart
  count `0`, UID/GID `10042`, read-only root filesystem, cap-drop `ALL` and
  `no-new-privileges:true`.
- `/api/healthz` and `/api/health` returned HTTP `200`, HSTS, the exact release
  and `dbConnected=true`. Six additional samples were exact; observed latency
  was `0.031386–0.090830` seconds.
- Ledger and aggregate read-only counters were
  `92|0|0|0|0|0|0|0|0|0|0|0`: ledger, active portal universities, active
  credentials, adapter specs, portal submissions, lifecycle observations,
  messages, broadcasts, finance mutation requests, Journey outbox events,
  applications and documents.
- The four integration kill switches remained exact, portal worker count was
  zero and fatal/unhandled/uncaught log matches were zero. Final root disk use
  was `81%`, with `20,331,143,168` bytes available; no prune ran.
- Authenticated read-only browser UAT rechecked Rules, Operations, Adapter
  Management and Universities. Rules remained Test Mode with automation,
  fallback, fan-out and scheduler off; dynamic stages were present and terminal
  stages disabled. Operations and Universities were empty, and experimental
  built-ins displayed their `0/3` graduation state. No mutating control ran.

The first-partner decision, onboarding sequence, application-number evidence
rule, stop conditions and production gate are frozen in
`PORTAL_AUTOMATION_FIRST_PARTNER_PILOT_RUNBOOK_2026-09-04.md`. A real pilot is
blocked only on the named partner, exact login origin, account/automation
permission and credential entry through the encrypted UI. Credentials must not
be sent through chat. Production, `Next`, merge, external delivery, fan-out and
fallback remain NO-GO.

## 5 September 2026 local execution-verification hardening

This section records uncommitted, local-only work on
`codex/reporting-intelligence-center-20260903`. It supersedes the local ledger
count in earlier sections but does not describe a staging or production
release.

- Additive migrations `0092_portal_partner_verification_receipts.sql` and
  `0093_portal_program_fallback_active_uniqueness.sql` raise the canonical
  local ledger to `94/94`. Test Login and Strict Dry Run results are
  append-only receipts bound to the exact portal partner generation, adapter
  key, enabled spec ID/version/SHA-256, encrypted credential row/update time and
  runtime release identity. Historical activity is not promoted into a pass.
- A newer failed receipt revokes an older pass. An idempotency key permits only
  an exact replay; reuse with different evidence is a hard conflict. Strict
  dry-run evidence must carry a database-enforced matching
  `(portal_submission_id, application_id)` pair.
- Manual enqueue, per-application enqueue, automatic trigger, inline drain,
  dedicated worker, fallback and status monitoring now re-check current
  execution evidence. Dry execution requires current Test Login plus a strict
  v2 adapter; real execution, fallback and polling additionally require a
  current Strict Dry Run receipt.
- Credential, enabled adapter version and partner routing changes cancel queued
  work, set a stable review-required reason, make affected partners inactive,
  disable auto-process and fan-out, and increment their verification
  generation. A change that overlaps a running browser submission is rejected
  with `409` and rolled back.
- The application Submit selector returns only active partners with current
  evidence and exposes explicit `dryRunReady`/`realRunReady` booleans without
  credentials. Environment-only credentials and orphan adapter registrations
  cannot make a new partner selectable.
- Partner Setup is now a server-authoritative guided workflow: configuration,
  Test Login, activation for strict verification, Strict Dry Run, manual pilot,
  automation rules and Operations are separate phases with direct next actions.
  Application trigger options continue to come from the live Application
  Pipeline catalog; new/drifted/terminal stages are never selected implicitly.
- Uploaded adapter specs are resolved by the common asynchronous runner in the
  inline and worker diagnostic paths. Legacy scripts whose name promises a dry
  run now force both dry-run flags, and the historical record-specific
  `complete-1959` command is no longer exposed as a package operation.

Local evidence after a clean disposable PostgreSQL 16 reset:

- `0 → 94` migration application, clean `94 → 94` replay and production-prefix
  `66 → 94 → 94` adoption: PASS;
- static package/migration/portal contracts: `6 + 31(+1 expected Bash skip) +
  61` PASS;
- PostgreSQL portal sequence covering receipt constraints, observation store,
  lane lease, lifecycle Guardian, graduation, adapter admin, management,
  manual/automatic enqueue, generic API, routing, Operations and artifact
  intake plus fallback API: `91/91` PASS;
- workspace TypeScript, ten-language i18n, API production build and Edcons
  production build: PASS;
- fallback API delete/re-create and concurrent same-key serialization is
  included in the database suite; worker lane/target/queue/writeback:
  `4/4 + 2/2 + 5/5 + 9/9` PASS;
  fallback runner: `31/31` PASS;
- `git diff --check`: PASS (line-ending conversion warnings only).

No browser contacted a partner portal during these tests. No staging,
production, GitHub, credential, worker or external-delivery state was changed.
Because adoption starts with no inferred receipt, every existing partner must
be moved through Test Login and Strict Dry Run deliberately before it can
execute on the new version.

## Code-free Partner Setup staging adoption

The fail-closed Partner Setup control plane was frozen in code-bearing commit
`813db5991c3e48801719432243d751cea2c11357`. A second review-infrastructure
commit, `96444e43dca5bc93241959aedfcd9ac9f2dfb7bf`, extended the tenant-writer
scanner to classify transaction-scoped `executor` writes; the resulting
inventory is 172 discovered/172 classified writer files with zero normal-mode
errors. Draft PR #32 remains unmerged.

Exact-head GitHub Actions on `96444e43…` all succeeded: Portal Automation Gate
`33895080885`, Live-first Convergence Gate `33895080860` and Institution
Admissions Gate `33895080950`. The earlier exact code commit correctly exposed
the missing scanner vocabulary through a failed convergence run; no staging
adoption was attempted until the scanner fix and all three replacement runs
were green.

Staging adoption evidence:

- Immediate pre-adoption backup:
  `staging-backup-20260904T162944Z-96444e43dca5.dump` (`4,581,742` bytes,
  SHA-256 `494feaccf40857c48f5fd5238235f0910062dd235e07c8f4ce1e244221e68e83`,
  `0640 root:findandstudy-staging`). Its network-isolated PostgreSQL 16.15
  restore reproduced `92|13|0|0|0`: ledger, synthetic users, applications,
  portal submissions and lifecycle observations. The disposable restore
  container was removed.
- Exact release: `staging-20260904T163712Z-96444e43dca5`; source
  `96444e43dca5bc93241959aedfcd9ac9f2dfb7bf`; build image
  `sha256:1bc1c4de2c35be431d95288e2362feb71cbb298ef47995d4fbc0c2f7202accde`;
  runtime image
  `sha256:fbdee9e7e41bebbeca1bb6dfe2bad44a1b248d9c5b5de60bff9f4efbd16ef2d3`.
- Only the staging app service was replaced. The database container identity
  remained stable, portal worker count stayed zero, app health was `healthy`,
  restart count was `0`, and the runtime retained UID/GID `10042`, read-only
  root filesystem, cap-drop `ALL` and `no-new-privileges:true`.
- Two initial app replacements reached healthy state but the remote operator
  script's final trap-cleanup line received a Windows carriage return. The
  fail-closed ERR handler restored both host-only env files and the previous
  `575763b1…` app each time. The LF-normalized third run completed successfully;
  no database, worker, schema or external integration changed during either
  rollback.
- Public `/api/healthz` and `/api/health` returned HTTP `200`, HSTS, the exact
  release and `dbConnected=true`. Six further samples were HTTP `200` at
  `0.026926–0.047372` seconds. Fatal/unhandled/uncaught log matches were zero.
- Ledger and aggregate external-effect counters were
  `92|0|0|0|0|0|0|0|0|0|0|0`: ledger, active portal partners, active portal
  credentials, adapter specs, submissions, lifecycle observations, messages,
  broadcasts, finance mutation requests, Journey outbox events, applications
  and application documents. The four external-integration kill switches
  remained exact.
- Authenticated read-only browser UAT verified the shell-consistent Partner
  Setup workspace, all-zero readiness cards and safe empty state. The Add
  University dialog had no activate-now control and explicitly stated that new
  partners start inactive. Application Pipeline supplied the trigger-stage
  options and terminal Enrolled/Rejected remained disabled. No save, add,
  upload, submit, sweep, fan-out or fallback mutation ran.
- Final root filesystem use was `81%`, with `20,275,982,336` bytes available.
  No Docker prune, unrelated restart, production access or `Next` update was
  performed.
