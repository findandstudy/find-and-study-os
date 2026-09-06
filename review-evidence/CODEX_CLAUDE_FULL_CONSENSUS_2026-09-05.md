# Codex + Claude Full Consensus

Date: 5 September 2026
Canonical repository: `findandstudy/Find-And-Study-OS-Next`
Decision: **FULL CONSENSUS**

## Evidence boundary

The review used the exact local source, binding architecture documents,
secret-free and PII-free staging runtime attestation, authenticated staging UI
screenshots and read-only GitHub governance evidence. Claude was not given SSH,
root access, private keys, credentials, cookies, tokens or person data.

The staging evidence proves release/runtime posture, migration identity and
zero-state aggregates. It does not prove end-to-end portal behavior. Real
partner traffic remains outside scope.

## Locked decisions

1. Every Playwright/browser action runs only in a dedicated worker. The API
   validates and enqueues, then returns `202` and a status URL.
2. Test login, dry run, real submit/amend/withdraw, status checks and artifact
   collection are separate worker job kinds with an execution-mode allowlist.
3. API and worker run the same immutable release and `RELEASE_ID`; mismatch
   fails closed.
4. Every enqueue path uses one primitive. Active queue and current successful
   target uniqueness are database-enforced.
5. Intent identity includes the versioned catalog target, program/intake,
   dossier revision, adapter/spec identity, partner generation, action, approval
   receipt and intent version.
6. Existing provider `external_ref` plus a new submit becomes
   `RECONCILIATION_REQUIRED`. Missing-document work on the same case is amend.
7. Approved replacement submissions use a row-locked supersede transaction and
   maker-checker receipt; concurrent second supersede is rejected.
8. Global, tenant/branch and partner policies compose by the most restrictive
   value. Environment variables can only lower limits.
9. Configuration changes use Control Plane ChangeSet. Individual application
   decisions use typed `portal_lifecycle_proposals` with approval and execution
   receipts. `ai_action_queue` is not the application lifecycle source of truth.
10. Reporting reuses Activity, Quality and Data Quality surfaces through an
    Insights information architecture; it does not rebuild them.
11. Growth work is limited to truthful integration status, secret references,
    attribution and approval/status foundations. Publishing/ad/video engines
    remain demand-gated BUY/integrate work.

## Locked phase order

0. CI, governance, runbook and ADR hygiene.
1. Reporting hardening, parallel to Phase 2 after Phase 0.
2. Portal safety closure: one enqueue primitive, idempotency schema, worker-only
   execution, policy hierarchy, DLQ/recovery and fail-closed onboarding gate.
2.5-A. Staging adoption of migrations `0092–0093`: ledger `92/92 → 94/94`,
   real-execution denominator remains zero.
2.5-B. Staging adoption of `0094+` and a verification-only worker after G-A and
   G-C; real execution remains off.
3. Institution runtime readiness: issuers, least-privilege executor, allowlist,
   negative authorization matrix and rollback evidence. No new feature module.
4. Growth foundation only.

## Open gates

- G-A: bounded production portal-submission reconciliation before unique index
  adoption.
- G-B: `Find-And-Study-OS-Next/main` ruleset requiring PRs, reviewed checks and
  no force-push/delete.
- G-C: same-release worker topology and operations approval.
- G-D: first partner identity, exact origin, account type and encrypted
  credential input.
- G-E: Institution issuers, staging runtime adoption and Privacy/Legal approval.
- G-F: two paid-tenant demand gate before a social publishing engine.
- G-G: disk headroom, provider firewall, malware scanner and restore/DR plan.

## Phase 0 CI correction

The initial proposal to run the signed-contract object-authorization integration
test in service-less Linux/Windows jobs was rejected after source inspection.
The test writes throwaway PostgreSQL rows and deliberately fails unless its
dynamic CI database identity is exact.

The accepted correction is a separate digest-pinned PostgreSQL 16.15 job on
literal loopback port 5432 with database
`fas_it_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}`. It prepares least-privilege
roles, applies all 94 migrations, proves replay, verifies the authority split and
runs the object-authorization test with mutation permission only for that step.
Linux and Windows service-less jobs retain the pure database-targeting safety
test; no Windows PostgreSQL parity claim is made.

## Explicit exclusions

No production deployment or migration, merge, push, real partner traffic,
fan-out/fallback/scheduler activation, reporting export/snapshot engine, second
vault or second application state machine is authorized by this consensus.

GitHub ruleset mutation, commit/push, staging adoption and production adoption
remain separate owner-controlled actions.

## Known governance blocker discovered during Phase 0

The imported `Next` head already fails the frozen convergence-manifest suite
before the new Phase 0 files are committed: the manifest expects workflow blob
`88246cf3…`, while the committed `Next` head contains `ae933fa0…`, and the
verifier reports a large post-review source set that is outside the historical
allowlist. Updating one blob SHA would create false assurance.

The manifest must therefore be fully regenerated only after the intended local
change set is committed to an exact reviewed head. Until that re-freeze passes,
canonical adoption remains NO-GO. The current working workflow blob is
`013b4aef9d52da53e095ceb3a44ae8d0e30da807`, but it is evidence only and is not
written into the frozen manifest before an exact commit exists.
