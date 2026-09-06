# Operations & Growth Foundation — Local Implementation Record

## 6 September 2026 reliability addendum

This addendum supersedes the first-slice publication limitations below without
changing the external-provider activation gate.

- Managed-provider account verification, publication execution and performance
  collection now use allowlisted HTTPS endpoints, bounded responses,
  idempotency keys, leases, exponential retry, dead-letter states and hashed
  provider receipts.
- Migration `0101_social_worker_heartbeats.sql` adds release-bound publication
  and performance worker liveness evidence under tenant/organization FORCE RLS.
- Dedicated publication and performance services are defined under the explicit
  `social-external` staging compose profile. The profile and all provider kill
  switches remain off by default.
- Both worker loops contain transient infrastructure failures, publish only
  redacted error codes, refresh bounded heartbeats and close their PostgreSQL
  pools during controlled shutdown.
- `/admin/social` now distinguishes disabled workers from a missing or
  release-mismatched heartbeat instead of inferring health from configuration.
- The OpenAPI contract includes every implemented social account, media,
  publication and performance route together with provider gates,
  worker-health projection and required idempotency request keys.
- Migration `0102_social_media_assets.sql` and the Social UI add uploader-bound
  JPG/PNG/WebP/MP4 intake, server-side signature and size verification,
  tenant-scoped immutable content-addressed assets, private streaming and brief
  attachment selection. Arbitrary URLs and another user's upload key are never
  accepted as publication media.
- Reel and Video require exactly one verified MP4; Story and Ad Creative enforce
  their media prerequisites at brief creation, review submission, publication
  creation and worker execution. This prevents legacy or malformed jobs from
  reaching a provider.
- Migration `0103_social_attribution_read_model.sql` assigns every brief an
  immutable system tracking key, projects first-touch lead/application outcomes
  without granting social readers access to the legacy CRM tables, and keeps
  provider metrics distinct from CRM-attributed outcomes. Ad spend is grouped
  by account currency and is never summed across currencies.
- Migration `0104_social_creative_orchestration.sql` adds approval-gated caption,
  image and video generation requests, immutable definitions, explicit
  per-request cost caps, provider-lane isolation, leases, async polling,
  bounded retry/dead-letter handling and append-only attempt evidence.
- The creative gateway is exact-host HTTPS pinned, schema/budget strict and
  receives no tenant identity or worker lease secret. Generated media must pass
  MIME, length and SHA-256 checks before content-addressed private storage.
  Outputs may only update a still-DRAFT brief and still require the existing
  content and publication maker-checker approvals.
- Disposable PostgreSQL verification passes with `105/105` migrations, `17/17`
  social tables under FORCE RLS, immutable tenant-isolated media, isolated
  heartbeats, attribution forgery rejection and isolated publication/creative
  queue claims. Provider traffic is still not authorized by these checks.

Production and `Find-And-Study-OS-Next` remain outside this change. Real
publishing still requires an approved provider account, sandbox/canary evidence,
quota policy and explicit activation of every external gate.

Date: 5 September 2026
Environment changed: local review worktree and `127.0.0.1:5433/fasos_apply_local` only
Production, staging, GitHub and external providers: unchanged

## Delivered slice

### Unified Work & Exception Center

- `/admin/operations` and `/staff/work` use the existing application, task,
  document, pipeline, portal-observation, lifecycle-proposal and offer-deadline
  sources.
- The deterministic projection identifies overdue/due-soon work, recorded
  application deadlines, unassigned/stale cases, document review/rejection,
  quarantined portal lanes, unverified portal identities, pending maker-checker
  proposals and expiring offers.
- The projection is read-only. It does not mutate workflow state, invent an SLA
  breach or bypass an existing route's data visibility.
- Evidence, Integration, Offer/Visa/Enrolment and Communication/Consent are
  grouped as tabs in the same operations workspace instead of being rebuilt as
  duplicate systems.

### Truthful integration state

- Non-live integration probes now report `simulated` or `not_supported`, never
  verified success.
- The Integrations UI renders simulated/not-supported outcomes as neutral
  warnings rather than healthy connections.

### Social Media Operations foundation

- Migration `0097_social_operations_foundation.sql` adds tenant and
  organization scoped account registry, content briefs, append-only reviews,
  publication intents and append-only performance snapshots.
- All five tables use FORCE RLS. Brief transitions are constrained; reviewed
  content is immutable; review decisions require maker-checker and an
  idempotency key.
- `/api/social/*` exposes context, overview, account registration, brief
  creation, review submission and independent approval/rejection.
- Raw external account references are not returned or stored; only SHA-256 is
  retained. Secrets remain in the existing Integrations control plane.
- `/admin/social` provides content calendar, brief/review queue, multi-account
  registry and honest performance placeholders.
- Provider publishing remains hard-disabled. `APPROVED` means content approval,
  not publication success. No ad-spend, auto-publish or external AI/video call
  is made by this slice.

## Authorization and rollout

- Legacy transition permissions are `social.view`, `social.manage` and
  `social.approve`.
- Manager receives view/manage but not approve; Admin and Super Admin may
  approve. Maker-checker still forbids the brief creator from reviewing the
  same version.
- `SOCIAL_OPERATIONS_V1_MODE` is `off|read|manage` and defaults to `off` in
  production.
- Tenant and organization UUIDv7 values must be explicit. Production also
  requires the exact configured non-superuser, non-BYPASSRLS executor identity.
- The local database intentionally has no tenant/organization seed, so the UI
  fails closed with a configuration notice instead of assuming a tenant.

## Verification

- Local PostgreSQL 16.15 migration ledger: `97 → 98`.
- Social tables: `5/5` FORCE RLS; policies: `13`.
- Migration catalog: `98/98` files and journal entries.
- Social pure contract tests: `3/3`.
- Operations queue tests: `4/4`.
- Workspace library, API and Edcons TypeScript checks: PASS.
- OpenAPI generation for React Query and Zod clients: PASS.
- Ten-language i18n parity: PASS.
- API production build and Edcons production build: PASS.
- Local route/auth-guard browser smoke: PASS; no authenticated mutation was
  attempted.

## Explicit remaining gates

- Operations aggregation must move to a server-side, paginated/read-model query
  before high-volume certification; the first slice is intentionally bounded.
- Active signed-context selection must replace explicit environment scope before
  multi-tenant production rollout of social writes.
- Guardian/sponsor relationship and consent creation remain behind
  Privacy/Legal, purpose, expiry, revocation and maker-checker design gates.
- Institution issuer/step-up/runtime adoption remains separate from these UI
  projections.
- External provider activation and ad-spend mutation remain separate
  BUY/integrate gates. The internal publication and AI creative orchestration
  engines are implemented, but real provider traffic still requires account
  verification, provider contracts, sandbox/canary evidence, quota/rate-limit
  policy, rollback evidence and explicit activation of every kill switch.
- No deploy, commit, push or merge is included in this record.
