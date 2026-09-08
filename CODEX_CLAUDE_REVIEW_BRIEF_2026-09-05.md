# Codex ↔ Claude Joint Review Brief — 5 September 2026

## Snapshot identity

- Canonical target repository: `https://github.com/findandstudy/Find-And-Study-OS-Next`
- Target default branch: `main`
- Target baseline commit: `32c84a928ab28d6350e539a267f3bbfb60524608`
- Source worktree: `C:\Yeni WEBSİTESİ\Find-And-Study-OS-Reporting`
- Review worktree: `C:\Yeni WEBSİTESİ\Find-And-Study-OS-Claude-Review`
- Branch context: `codex/reporting-intelligence-center-20260903`
- Base/source HEAD: `ca0fa114498914540045e36a6bff1fc52530e33b`
- The review worktree includes the source HEAD plus the source worktree's current modified and untracked files.
- At snapshot time: 64 changed/untracked paths were overlaid. This is a review snapshot, not a deployable or reviewed release.
- `NEXT_MAIN_TO_CURRENT_FULL_DELTA_2026-09-05.patch` is the canonical bridge from the target repo's `main` commit to this exact local review snapshot. Do not use the legacy repository's `master` branch as the current-state baseline.

## Product-owner request

Codex and Claude must independently inspect the project from end to end, prepare plans for the recent discussion, act as adversarial reviewers for each other, debate material differences, and agree on one implementation plan. Codex alone implements. Existing capabilities must be reused and grouped coherently; new work must improve rather than duplicate the system.

## Recent discussion scope

### 1. Reporting Intelligence Center

- Consolidate operational, funnel, application, finance and data-quality reporting in a coherent `/admin/reports` experience.
- Match the established admin visual language instead of introducing a unique page header or isolated design system.
- Verify metric definitions, frozen denominators, tenant/branch/date filters, drill-downs, freshness and auditability.
- Determine what is already implemented locally and what remains evidence-gated.

### 2. Portal Automation closed loop

- Submit applications to institution/partner portals where API/webhook access is unavailable.
- Each institution/partner must have an isolated queue and concurrency/rate-limit policy so one congested portal cannot block others.
- Support bounded fallback and fan-out without queue explosion, duplicate applications or uncontrolled cost.
- Admin-driven onboarding must avoid product-code changes for each new partner: versioned mapping/adapter packages, validation, dry-run, canary, activation and rollback.
- Trigger stages must come from the canonical application workflow rather than a duplicated static list.
- Correctly capture the institution-issued application/reference number from corroborated portal evidence, not arbitrary URL fragments.
- Poll and reconcile statuses such as missing document, under review, conditional/unconditional offer, rejection and final acceptance.
- Download and verify evidence documents, attach them to the correct application, move pipeline state safely and trigger permitted notifications.
- Preserve idempotency, receipts, evidence, audit, maker-checker, manual recovery and no-secret-in-code rules.
- Inspect current 0092/0093 migration work, partner verification receipts, fallback uniqueness and worker/route/UI changes before proposing more.

### 3. Institution Admissions

- The `/institution` portal is a separate capability projection of the same product and canonical application/evidence/state core, not a second codebase.
- Review queue, requirements/evidence verification, decisions, maker-checker, offer/final acceptance, enrolment, SLA and analytics must remain tenant- and relationship-scoped.
- Identify existing v1 implementation versus remaining production-readiness gaps.

### 4. Growth & Social Media OS

- A single module should support multi-account social connections, content/image/video production, content calendar, approvals, publishing, ad management, monitoring and reporting.
- Reuse `/admin/settings → Integrations` as the connection/credential control plane. Do not create a second connection vault.
- Existing catalog includes SMTP, WhatsApp, Messenger, Instagram, Meta Ads, X, TikTok, YouTube, VK, HeyGen, AI providers, webhook and custom API.
- Distinguish genuine adapters from configuration cards or simulated tests. Current source shows real paths for a subset while several social providers are largely configuration scaffolds.
- Extend the existing multi-account/channel-account pattern for pages, profiles, ad accounts and channels; do not force one credential per provider.
- Content and campaign outcomes should reconcile to CRM leads, qualified applications, enrolments, revenue and VOTE rather than vanity metrics alone.
- AI may draft and transform content; public publishing and material ad-spend changes require policy/approval until explicitly authorized.

### 5. Cross-cutting architecture

- Inventory current modules and avoid rebuilding capabilities already present in CRM, campaigns, messages, website/CMS, AI, settings/integrations, reporting, institution and portal automation.
- Prefer a modular monolith plus workers; service extraction requires measured need.
- Every external action follows `preflight → policy/approval → idempotent execution → receipt → audit → monitoring → exception/manual recovery`.
- Define clear bounded contexts and shared primitives: connection registry, work queue, evidence/document store, workflow/state engine, notifications, analytics and Control Plane.
- No production/VPS deployment, merge or remote push is implied by this review.

## Review method

1. Build a route, schema, worker, integration and UI inventory.
2. Map each requested capability to an existing implementation, partial scaffold or genuine gap.
3. Produce a phased plan with dependencies and measurable acceptance criteria.
4. Claude critiques Codex's plan; Codex critiques Claude's plan.
5. Exchange rebuttals until material conflicts are resolved.
6. Freeze the joint plan before Codex changes product source.

## Required caution

Do not read or request live credentials, tokens, PII, uploaded student documents or production database contents. Treat examples and fixtures as untrusted until verified synthetic.
