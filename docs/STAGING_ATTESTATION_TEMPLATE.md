# Staging Runtime Attestation Template

Date/time (UTC):
Environment: staging
Operator:
Source commit:
Runtime release ID:

This template is secret-free and PII-free. Record only bounded aggregate facts,
exact code/release identities and negative-test outcomes. Never include raw
credentials, cookies, tokens, application numbers, document contents or person
records.

## 1. Evidence boundary

State exactly what the evidence proves and does not prove. Runtime health,
screenshots and zero-row aggregates do not prove end-to-end behavior. A green
banner does not prove that a backend enforcement path ran. List every omitted
behavioral check and its reason.

## 2. Immutable source and runtime identity

- Git commit:
- Clean reviewed source: yes/no
- Container/image digest:
- API `RELEASE_ID`:
- Worker `RELEASE_ID`:
- API/worker release match: pass/fail/not deployed
- Public health HTTP status and `dbConnected`:

## 3. Migration ledger

Attach the exact, redacted output of:

```text
node lib/db/verify-migration-state.mjs
```

- Expected ledger count:
- Applied ledger count:
- Expected range:
- Exact hash comparison result:
- Replay result:

## 4. Portal automation controls

Report the bounded result of `portal_automation_settings`; if it has no row,
write `NO ROW` rather than inferring a default.

- Settings row present:
- `is_enabled`:
- execution/test mode:
- trigger stages source:
- automatic processing:
- fan-out:
- fallback:
- global stop reason:

Worker safe environment (values only; no secrets):

- `WORKER_EXECUTION_MODES`:
- global concurrency:
- default lane concurrency:
- lane overrides:
- polling interval:
- stale-lock threshold:
- heartbeat:
- background jobs:
- live integrations:

## 5. Real-execution denominators

Record aggregate counts only:

- portal accounts with credentials:
- configured portal universities:
- enabled adapter specs:
- queued:
- running:
- submitted:
- failed:
- dead-letter/review-required:
- status observations:
- artifacts accepted:
- external writes attempted:
- real executions completed:

If all counts are zero, write: `ZERO-STATE ONLY — enforcement not proven`.

## 6. Required negative checks

- automation disabled rejects manual processing:
- `real` absent from worker allowlist leaves real work unclaimed:
- API/worker release mismatch is rejected:
- duplicate active enqueue yields one success and one conflict:
- tenant/partner lane isolation:
- stale lease recovery does not double-claim:
- artifact origin/MIME/magic-byte/size rejection:
- lifecycle proposal cannot mutate without maker-checker receipt:

For each item record `PASS`, `FAIL` or `NOT RUN` plus the exact test/run identity.

## 7. Runtime and provider posture

- non-root UID/GID:
- read-only root filesystem:
- capabilities dropped/no-new-privileges:
- restart count:
- database version/health:
- disk total/used/free/percent:
- provider firewall posture:
- malware scanner posture:
- backup copies and restore drill status:

## 8. Decision

- GO/NO-GO:
- Scope of decision:
- Open gates:
- Rollback command/runbook reference:
- Approver(s):
