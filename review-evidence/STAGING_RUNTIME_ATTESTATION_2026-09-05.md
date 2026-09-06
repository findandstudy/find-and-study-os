# Staging runtime attestation — 5 September 2026

This is a read-only, secret-free and PII-free evidence packet for independent architecture review. It describes only the isolated synthetic-data staging environment. It does not authorize a deployment, configuration change, worker activation, outbound integration, production access or credential disclosure.

## Scope and method

- Environment: `staging.findandstudy.com` on the dedicated staging VPS.
- Observation time: `2026-09-05T05:34:00Z`.
- Method: public HTTPS health probe plus read-only SSH/Docker/PostgreSQL commands.
- No file, database row, service, container, image, environment value or Hostinger setting was changed.
- No raw secret, session, credential, student record, message or document content was read or recorded.

## Current runtime

- Host uptime: 8 weeks, 3 days, 18 hours, 49 minutes.
- Root filesystem: ext4, 96 GiB total, 78 GiB used, 19 GiB available, 81% used.
- Application container: `findandstudy-staging-app-1`.
- Application image: `findandstudy-staging-app:96444e43dca5`.
- Application status: healthy, restart count `0`.
- Runtime identity: `10042:10042`.
- Runtime hardening: read-only root filesystem, Linux capability drop `ALL`, `no-new-privileges:true`.
- PostgreSQL container: `findandstudy-staging-db-1`.
- PostgreSQL image: `postgres:16.15`.
- PostgreSQL status: healthy.
- Neither staging application nor PostgreSQL publishes a host port; the application exposes container port `5000/tcp` only.

## Public health

- `GET https://staging.findandstudy.com/api/health` returned HTTP 200.
- Response status: `ok`.
- Database connectivity: `dbConnected=true`.
- Release ID: `staging-20260904T163712Z-96444e43dca5`.

## Database and external-effect denominators

- Drizzle migration ledger: `92/92` applied.
- Aggregate synthetic-data counts: users `13`; applications `0`; portal submissions `0`; portal lifecycle observations `0`; messages `0`; broadcasts `0`; finance mutation requests `0`; Journey outbox events `0`; documents `0`.
- Portal configuration counts: portal credentials `0`; portal universities `0`; adapter specs `0`.

## Safety switches

- `ALLOW_LIVE_INTEGRATIONS=false`
- `EMAIL_DELIVERY_DISABLED=true`
- `BACKGROUND_JOBS_ENABLED=false`
- `AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH=true`
- `STUDENT_JOURNEY_V1_MODE=off`
- Portal worker container count: `0`.

## Provider overview observations

- VPS state: running.
- Provider panel point-in-time utilization: CPU 13%, memory 43%, disk 77 GB / 100 GB.
- Backup count: 2; schedule: weekly.
- Provider firewall rules: 0.
- Provider malware scanner: not installed.

## Review implications

1. The staging runtime is healthy and fail-closed for outbound effects, but it is not a production-readiness certificate.
2. The deployed release is behind the current local review snapshot, including uncommitted migrations `0092` and `0093`; therefore code review and staging behavior must not be conflated.
3. Disk use remains an operational risk and needs bounded attribution/retention work before large builds or image accumulation.
4. Zero provider firewall rules and no provider malware scanner are defense-in-depth gaps; any change requires a separate approved operations plan.
5. Portal Automation is intentionally empty and disabled. A named-partner strict dry-run pilot, receipt-bound verification and separate activation approval remain mandatory before a worker can run.
