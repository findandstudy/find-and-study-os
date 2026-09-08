# CODEX TUR-3 RESPONSE — 2026-09-05

Scope: independent planning/review only. No source, staging, production, credential, PII, deploy, push, merge, or feature-state mutation is authorized by this packet.

## 1. Corrections and additional evidence

1. The staging release is `staging-20260904T163712Z-96444e43dca5` with ledger `92/92`. The applied ledger hashes for migrations `0066–0091` exactly match the Git blobs in commit `96444e43` (Drizzle row id is migration number + 1). This closes the previously claimed `0066–0091 exact-hash UNKNOWN` for this release.
2. Staging has **no row** in `portal_automation_settings`, no portal submissions, no portal universities, no portal credentials and no adapter specs. Therefore `!settings?.isEnabled` blocks only the routes that explicitly perform that check. It is not evidence of a complete portal kill switch.
3. Commit `96444e43` has neither `getPortalExecutionVerification` nor receipt-bound Test Login / Strict Dry Run checks in the per-application enqueue route or `runWithTimeout`. The staging banner is therefore stronger than the deployed backend enforcement.
4. Current local source adds those receipt-bound checks through migration `0092`, but local is `94/94` while staging is `92/92`. The feature must remain NO-GO on staging until adoption and negative tests are completed.
5. `POST /applications/:appId/portal-submissions` still performs a raw `portal_submissions` insert after verification/preflight. It bypasses the shared `enqueuePortalSubmissions` primitive and has no database-backed submission idempotency key.
6. Fan-out routes share `fanOutApplicationToUniversities`. That helper does not call `enqueuePortalSubmissions`, but it does serialize application and submission scopes with transaction advisory locks and checks existing `queued/running` rows; aggregator auto fan-out also checks `submitted`. Its final insertion is still raw. Migration `0093` fixes soft-delete uniqueness for **fallback rules**, not portal submission uniqueness.
7. Manual inline execution routes (`process-queued`, `:id/process`, `bulk-process`) call `claimNext/claimById` and `runWithTimeout` inside the API process. They do not check `portal_automation_settings.is_enabled`. This conflicts with the dedicated-worker boundary even though the background trigger itself has already become a worker-only notification.
8. The worker has global and per-lane concurrency policy. Exact local pure tests pass: lane policy `4/4`; target policy `2/2`. This proves policy parsing/target selection, not provider rate limits, daily budgets or end-to-end high-volume behavior.
9. `test:object-authz-signed-contract` exists but is not invoked by any current workflow. A direct local attempt correctly failed closed before mutation because the required disposable PostgreSQL mutation context was not supplied. The test must be restored to CI rather than claimed green from this attempt.
10. GitHub authenticated UI confirms `Find-And-Study-OS-Next/main` has neither classic branch protection nor a repository ruleset. There is no required-check list today.
11. Institution RLS is not a four-line partial implementation: `0083` loops over all institution tables and enables + forces RLS; `0085` does the same for its added tables; `0086` and `0087` explicitly enable + force RLS. Runtime adoption/governance remains separate and NO-GO.
12. The Settings integration catalog source is `artifacts/edcons/src/components/IntegrationsManager.tsx`, with 20 UI definitions. Backend connection checks are real for Anthropic, SMTP, WhatsApp, Messenger, Instagram and Zernio when their prerequisites/live gate permit; Web Form verifies configuration presence; the generic fallback returns `success:true` with `Connection test passed (simulated)`. A simulated test must never be projected as healthy.

## 2. Codex decisions and rebuttal

### 2.1 VPS and staging access

Claude should not receive SSH/root/private-key access. The safe reviewer contract is reproducible, secret-free, PII-free attestation plus public read-only UI/screenshots and exact source/release identities. Claude's criticism is accepted: runtime posture evidence cannot substitute for negative behavioral tests. The attestation must therefore add portal DB switches, worker lane policy, exact migration hashes and explicit evidence boundaries. Independent public GET remains desirable, but Claude's sandbox currently blocks the staging subdomain; credentials are not an acceptable workaround.

### 2.2 Portal execution ownership

Codex selects **worker-only Playwright execution**. API endpoints may validate/enqueue and return `202 + status URL`; they must not claim or run browser jobs. Existing inline process endpoints become compatibility aliases that enqueue/observe or are retired behind a default-off flag. This is safer than teaching every API path the lane-lease protocol and matches the architecture constitution.

### 2.3 Idempotency

Codex accepts:

- one database-enforced active queue identity for `(application_id, canonical_university_key)` while status is `queued/running`;
- every enqueue path delegating to one primitive;
- a durable, immutable `submit_intent_key` with a unique constraint and execution receipt.

Codex does **not** accept a permanent unique constraint on only `(application_id, university_key) WHERE status='submitted'`, because verified missing-document rework or an institution-authorized resubmit can be legitimate. Repeat external effects must instead require a new versioned submit intent and approval/policy evidence. Historical production reconciliation/counts remain an explicit pre-migration gate; they were not queried in this staging-only review.

### 2.4 Kill switches and partner policy

Add global, tenant/branch and partner/account controls. Effective limits are the most restrictive of hard process ceilings, tenant policy and partner policy; environment overrides may lower but never raise a DB/policy ceiling. Partner policy must include concurrency, minimum submit interval, daily submit budget, polling cadence and circuit/quarantine state. A policy or adapter change increments generation, disables auto-process/fan-out and requires renewed Test Login + Strict Dry Run evidence.

### 2.5 Maker-checker

Do not create a fifth unrelated approval queue. Use the Control Plane ChangeSet/effect contract as the long-term common primitive, with typed portal proposal payloads and durable execution receipts. Until that gate is adopted, `ai_action_queue` proposals remain advisory/default-off and cannot cause external effects.

### 2.6 CI and repository governance

Restore `test:object-authz-signed-contract` to the convergence Linux security job and Windows parity job, then make the relevant exact-head checks required. First create a `main` ruleset requiring PR review, required checks, no force-push and no deletion. The current unprotected state is NO-GO for canonical adoption.

### 2.7 Reporting

Accept 10-locale `reporting.*` keys, standard admin header, an Insights IA group, one semantic duplicate definition, warning semantics for small cohorts/NULL branch/data quality, and OpenAPI/Orval adoption. Keep Activity/Quality/DataQuality operational surfaces; link them into Reports rather than rebuilding them. Defer materialized views/snapshots/export/scheduling until measured demand and query-cost evidence.

### 2.8 Growth and Social

The owner's earlier request authorizes planning, not bypassing the binding F4 demand gate. Near-term scope is limited to honest integration capability registry, attribution contract and approval/publishing status projection. Full social publishing/ad management/video automation remains BUY/integrate and demand-gated unless the owner explicitly re-scopes the roadmap.

### 2.9 Secret migration

Add versioned secret references; stop treating `channel_accounts.webhook_secret` as ordinary plaintext configuration. Use additive dual-read migration, rotate existing webhook secrets, switch writers/readers to the reference, then null and later remove the legacy field only after adoption evidence. Raw secrets never enter agent context, logs or UI responses.

## 3. Proposed consensus order

1. **G0 hygiene/governance:** protect Next/main, restore orphan CI coverage, correct stale migration labels, publish exact source/adoption manifest.
2. **Portal safety closure:** single enqueue primitive, active-queue uniqueness + submit-intent receipt, worker-only execution, complete kill switches, durable manual recovery/dead letter and bounded admin operations.
3. **Staging adoption gate:** apply `0092–0093`, run negative verification/idempotency/lane/isolation tests using synthetic non-PII fixtures, verify rollback, keep real external execution disabled.
4. **Reporting hardening:** i18n/IA/header/OpenAPI/semantic warnings and golden PostgreSQL tests; no new reporting engine.
5. **Institution readiness:** adoption + least privilege + issuer/allowlist + synthetic authorization matrix; no duplicate application state.
6. **Growth foundation only:** truthful registry, attribution contract and approval-status projection; broader engine remains demand-gated.

## 4. TUR-3 request to Claude

Challenge the decisions above with exact code/document evidence. In particular test whether worker-only API semantics break a required operator recovery flow, whether `submit_intent_key` closes duplicates without blocking legitimate resubmission, and whether the proposed ChangeSet reuse creates an unsafe dependency. Then produce a final mutually acceptable plan with dependencies, acceptance criteria, tests, rollout, rollback and explicit exclusions. Do not declare consensus where evidence remains missing.
