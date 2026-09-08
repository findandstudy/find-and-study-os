# ADR — Portal Execution, Idempotency and Approval Planes

Date: 5 September 2026
Status: Accepted for local implementation; runtime adoption remains gated

## Context

Portal automation has no dependable provider API or webhook. Browser execution
must therefore tolerate partner-specific changes, retries and high fan-out
without letting one partner block another or allowing duplicate external
applications. Configuration approval and individual application decisions also
have different risk and lifecycle semantics.

## Decision 1 — browser execution is worker-only

The API validates and enqueues work, then returns `202` with a status URL. It
never calls adapter login, submission, status polling or artifact collection.
The dedicated worker owns these job kinds:

- `test_login`
- `dry`
- `real` (`submit`, `amend` or `withdraw`)
- `status_check`
- `artifact`

`WORKER_EXECUTION_MODES` is an allowlist. Local and verification environments
default to `test_login,dry`; `real` is separately approved and remains off.
Manual work may receive bounded priority, but priority scheduling must preserve
tenant/partner fairness and prevent starvation.

API and worker must run the same immutable release and the same `RELEASE_ID`.
Every verification and execution receipt binds that release identity. A missing
or different identity fails closed.

## Decision 2 — one enqueue primitive and durable submit intent

Every manual, automatic, fan-out and fallback path uses one enqueue primitive.
The immutable `submit_intent_key` is the SHA-256 of canonical JSON containing:

```text
application_id
target_catalog_university_id
program/intake target
dossier_revision_hash
adapter_key
adapter spec id/hash
partner/account generation
action: submit | amend | withdraw
approval_receipt_id | null
intent_version
```

The canonical target is the versioned catalog target plus partner/account
generation; a mutable routing label is not an identity.

The database enforces at most one non-deleted `queued`/`running` submission for
an application and canonical target. It also enforces at most one current
successful submission (`status='submitted'` and no `superseded_by_submission_id`)
for that target.

When the provider already has an `external_ref`, a new `submit` does not run;
it becomes `RECONCILIATION_REQUIRED`. Missing-document rework on the same
provider case is an `amend` operation.

A legitimate replacement is created as a queued intent with
`supersedes_submission_id` and a maker-checker approval receipt. In the success
transaction the worker row-locks the old success, verifies it is still current,
sets its `superseded_by_submission_id` to the new row, then marks the new row
submitted. A second concurrent supersede fails. Triggers verify the reciprocal
chain, action, tenant/target identity and approval receipt.

Production adoption of the partial unique indexes is blocked until a bounded
historical reconciliation classifies duplicate and stale queue rows.

## Decision 3 — policy hierarchy and generation invalidation

Execution policy is evaluated at global, tenant/branch and partner/account
levels. The effective value is always the most restrictive value, bounded by
the hard process ceiling; environment variables may lower limits but never
raise them. Policy includes concurrency, minimum submit interval, daily budget,
status cadence and circuit/quarantine state.

Changing an adapter/spec, credential, route, mapping or policy increments the
partner generation, disables auto-process/fan-out and invalidates prior
test-login/dry-run receipts. Renewed verification is mandatory.

## Decision 4 — configuration and application approvals are separate

Configuration-plane changes use the Control Plane ChangeSet contract: adapter
version activation/rollback, privileged hook approval, partner activation,
quota/policy changes and credential-generation changes.

Application-plane decisions use a typed `portal_lifecycle_proposals` aggregate:

```text
proposal
→ maker-checker approval receipt
→ idempotent effect
→ execution receipt
```

It has composite tenant/application/submission/observation bindings.
`ai_action_queue` is not its source of truth; it remains only an AI-persona work
queue/advisory inbox. Until the application-plane aggregate is adopted, every
lifecycle proposal is default-off, advisory and incapable of external effect.
Portal safety implementation is not blocked on Control Plane issuer adoption.

## Consequences and gates

- API-side inline Playwright paths and API schedulers are removed or retained
  only as default-off compatibility enqueue aliases.
- Worker execution, receipts, dead-letter recovery and partner isolation become
  observable and independently rate-limited.
- G-A: bounded production reconciliation before idempotency indexes.
- G-B: protected `main` ruleset and required CI checks before canonical adoption.
- G-C: same-release verification worker topology before staging worker adoption.
- Real partner traffic, fan-out, fallback and scheduling remain off until their
  explicit pilot gates pass.

## Alternatives rejected

- Inline API Playwright: couples request capacity to brittle browser work.
- Permanent one-success-ever uniqueness: blocks legitimate approved amendments
  and replacement submissions.
- One ChangeSet lifecycle for individual application decisions: configuration
  canary/observation semantics do not fit per-case admissions decisions.
