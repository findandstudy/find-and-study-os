# Operations & Growth Foundation — Local Implementation Record

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
- Social publishing, ad management and video generation remain BUY/integrate
  work behind the two-paid-tenant demand gate, provider contract, approval,
  receipt, rate-limit and rollback evidence.
- No deploy, commit, push or merge is included in this record.
