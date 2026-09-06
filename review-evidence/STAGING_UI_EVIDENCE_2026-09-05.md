# Staging UI evidence — 5 September 2026

This packet records authenticated, read-only visual inspection of the isolated synthetic-data staging environment. No mutating control was used. Screenshots exclude the signed-in account footer and contain no credential, session token, real student record, message or document content.

## Reporting & Analysis

- Route: `https://staging.findandstudy.com/admin/reports`
- Page loads inside the standard admin shell.
- Visible tabs: Management Summary, Lead Funnel, Applications, Finance and Data Quality.
- Visible filters: start date, end date, season and branch.
- Metric version: `2026-09-03.v1`.
- Aggregate synthetic values at observation: leads `2`, students `5`, applications `0`, active applications `0`, stale applications `0`.
- The screen still exposes English metric-definition copy inside the Turkish locale; this corroborates the i18n gap found in source review.
- Screenshot: `staging-reports-2026-09-05.png`.

## Portal Automation

- Route: `https://staging.findandstudy.com/admin/portal-automation`
- Page loads inside the standard admin shell.
- Visible tabs: Partner Setup, Automation Rules, Operations Center, Universities, Program Mapping, Adapter Management, Submission Board and Audit Log.
- Partner Setup is the selected landing tab.
- Safety banner states that test login and strict dry-run are required before real submission.
- Aggregate empty state: total partners `0`, incomplete setups `0`, manual pilots `0`, automation-ready `0`.
- Screenshot: `staging-portal-automation-2026-09-05.png`.

## Institution portal limitation

- A fresh unauthenticated request to `/institution` redirects to the public Turkish landing page.
- The current Super Admin browser session cannot be reused as evidence of Institution-role behavior; that portal requires a dedicated synthetic Institution principal/session.
- No Institution credential is included in this packet. A separate read-only Institution UAT session should be created or supplied under explicit approval if visual evidence is required.

## Review boundary

The screenshots prove current visual behavior only. They do not prove authorization isolation, database RLS, queue behavior, idempotency, maker-checker enforcement, external portal compatibility or production readiness.
