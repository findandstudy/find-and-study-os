import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { requireAuth, requirePermission } from "../lib/auth";
import { getVisibleBranchIds } from "../lib/branchScope";
import {
  REPORTING_METRICS,
  REPORTING_METRIC_VERSION,
  REPORTING_SCHEMA_VERSION,
  ReportingQueryError,
  ReportingScopeError,
  buildReportingMeta,
  parseReportingFilters,
  resolveReportingBranchScope,
  safeChange,
  safeRate,
  type ReportingFilters,
} from "../lib/reportingContract";
import { duplicateCandidatesCte } from "../lib/reportingDuplicateSemantics";
import {
  reportingScopeWarnings,
  reportingSmallCohortWarnings,
} from "../lib/reportingWarnings";

const router: IRouter = Router();
const REPORTING_STATEMENT_TIMEOUT_MS = 8_000;

type QueryRow = Record<string, unknown>;
type ScopedReportingFilters = ReportingFilters & {
  allowedBranchIds: number[] | null;
};

function numberValue(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function moneyValue(value: unknown): number {
  return Math.round(numberValue(value) * 100) / 100;
}

function responseFilters(filters: ScopedReportingFilters): unknown[] {
  return [
    filters.fromInclusive.toISOString(),
    filters.toExclusive.toISOString(),
    filters.season,
    filters.allowedBranchIds,
    filters.previousFromInclusive.toISOString(),
  ];
}

async function withReadOnlyReporting<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(
      `SET LOCAL statement_timeout = '${REPORTING_STATEMENT_TIMEOUT_MS}ms'`,
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function readFilters(req: Request, res: Response): ReportingFilters | null {
  try {
    return parseReportingFilters(req.query as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ReportingQueryError) {
      res
        .status(400)
        .json({ error: error.message, code: "REPORTING_FILTER_INVALID" });
      return null;
    }
    throw error;
  }
}

async function readScopedFilters(
  req: Request,
  res: Response,
): Promise<ScopedReportingFilters | null> {
  const filters = readFilters(req, res);
  if (!filters) return null;

  let visibleBranchIds: number[] | null;
  try {
    visibleBranchIds = await getVisibleBranchIds(
      req.user!.id,
      req.user!.role,
      req.user!,
    );
  } catch (error) {
    reportFailure(res, error);
    return null;
  }
  try {
    return {
      ...filters,
      allowedBranchIds: resolveReportingBranchScope(
        filters.branchId,
        visibleBranchIds,
      ),
    };
  } catch (error) {
    if (error instanceof ReportingScopeError) {
      res.status(403).json({
        error: error.message,
        code: "REPORTING_BRANCH_FORBIDDEN",
      });
      return null;
    }
    throw error;
  }
}

function setReportingHeaders(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function reportFailure(res: Response, error: unknown): void {
  const code = (error as { code?: string } | null)?.code;
  console.error("[reporting] read failed", {
    code,
    message: error instanceof Error ? error.message : "unknown",
  });
  if (code === "57014") {
    res.status(503).json({
      error: "Report query exceeded its safe execution budget",
      code: "REPORTING_TIMEOUT",
    });
    return;
  }
  res.status(503).json({
    error: "Reporting data is temporarily unavailable",
    code: "REPORTING_UNAVAILABLE",
  });
}

router.get(
  "/reporting/meta",
  requireAuth,
  requirePermission("reporting.view"),
  async (req, res): Promise<void> => {
    setReportingHeaders(res);
    try {
      const visibleBranchIds = await getVisibleBranchIds(
        req.user!.id,
        req.user!.role,
        req.user!,
      );
      const branches = await withReadOnlyReporting(async (client) => {
        const result = await client.query<QueryRow>(
          `
          SELECT id, name, country, city
          FROM branches
          WHERE archived_at IS NULL
            AND ($1::int[] IS NULL OR id = ANY($1::int[]))
          ORDER BY name ASC
          LIMIT 500
        `,
          [visibleBranchIds],
        );
        return result.rows.map((row) => ({
          id: numberValue(row.id),
          name: String(row.name ?? ""),
          country: row.country ? String(row.country) : null,
          city: row.city ? String(row.city) : null,
        }));
      });
      res.json({
        schemaVersion: REPORTING_SCHEMA_VERSION,
        metricVersion: REPORTING_METRIC_VERSION,
        generatedAt: new Date().toISOString(),
        timezone: "UTC",
        maximumRangeDays: 366,
        currencyPolicy: "original_currency_only_no_cross_currency_sum",
        exportPolicy:
          "disabled_in_v1_until_audited_field_level_export_is_approved",
        metrics: REPORTING_METRICS,
        branches,
      });
    } catch (error) {
      reportFailure(res, error);
    }
  },
);

router.get(
  "/reporting/command-center",
  requireAuth,
  requirePermission("reporting.view"),
  async (req, res): Promise<void> => {
    setReportingHeaders(res);
    const filters = await readScopedFilters(req, res);
    if (!filters) return;
    const startedAt = Date.now();
    try {
      const data = await withReadOnlyReporting(async (client) => {
        const params = responseFilters(filters);
        const summary = await client.query<QueryRow>(
          `
          WITH lead_counts AS (
            SELECT
              count(*) FILTER (WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz)::int AS current_count,
              count(*) FILTER (WHERE created_at >= $5::timestamptz AND created_at < $1::timestamptz)::int AS previous_count,
              count(*) FILTER (
                WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
                  AND converted_student_id IS NOT NULL
              )::int AS converted_count
            FROM leads
            WHERE deleted_at IS NULL
              AND ($3::text IS NULL OR season = $3::text)
              AND ($4::int[] IS NULL OR branch_id = ANY($4::int[]))
          ), student_counts AS (
            SELECT
              count(*) FILTER (WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz)::int AS current_count,
              count(*) FILTER (WHERE created_at >= $5::timestamptz AND created_at < $1::timestamptz)::int AS previous_count
            FROM students
            WHERE deleted_at IS NULL
              AND ($3::text IS NULL OR season = $3::text)
              AND ($4::int[] IS NULL OR branch_id = ANY($4::int[]))
          ), application_counts AS (
            SELECT
              count(*) FILTER (WHERE a.created_at >= $1::timestamptz AND a.created_at < $2::timestamptz)::int AS current_count,
              count(*) FILTER (WHERE a.created_at >= $5::timestamptz AND a.created_at < $1::timestamptz)::int AS previous_count,
              count(*) FILTER (
                WHERE a.created_at >= $1::timestamptz AND a.created_at < $2::timestamptz
                  AND ps.variant = 'won'
              )::int AS won_count
            FROM applications a
            LEFT JOIN pipeline_stages ps ON ps.entity_type = 'application' AND ps.key = a.stage
            WHERE a.deleted_at IS NULL
              AND ($3::text IS NULL OR a.season = $3::text)
              AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
          ), inventory AS (
            SELECT
              count(*) FILTER (WHERE coalesce(ps.variant, '') NOT IN ('won', 'lost'))::int AS active_count,
              count(*) FILTER (
                WHERE coalesce(ps.variant, '') NOT IN ('won', 'lost')
                  AND a.updated_at < now() - interval '14 days'
              )::int AS stale_count
            FROM applications a
            LEFT JOIN pipeline_stages ps ON ps.entity_type = 'application' AND ps.key = a.stage
            WHERE a.deleted_at IS NULL
              AND ($3::text IS NULL OR a.season = $3::text)
              AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
          )
          SELECT lc.current_count AS leads_current, lc.previous_count AS leads_previous,
                 lc.converted_count AS leads_converted,
                 sc.current_count AS students_current, sc.previous_count AS students_previous,
                 ac.current_count AS applications_current, ac.previous_count AS applications_previous,
                 ac.won_count AS applications_won,
                 i.active_count AS applications_active, i.stale_count AS applications_stale
          FROM lead_counts lc CROSS JOIN student_counts sc CROSS JOIN application_counts ac CROSS JOIN inventory i
        `,
          params,
        );
        const row = summary.rows[0] ?? {};

        const trendResult = await client.query<QueryRow>(
          `
          WITH series AS (
            SELECT date_trunc($5::text, created_at) AS bucket, count(*)::int AS value, 'leads'::text AS metric
            FROM leads
            WHERE deleted_at IS NULL AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
              AND ($3::text IS NULL OR season = $3::text) AND ($4::int[] IS NULL OR branch_id = ANY($4::int[]))
            GROUP BY 1
            UNION ALL
            SELECT date_trunc($5::text, created_at), count(*)::int, 'students'
            FROM students
            WHERE deleted_at IS NULL AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
              AND ($3::text IS NULL OR season = $3::text) AND ($4::int[] IS NULL OR branch_id = ANY($4::int[]))
            GROUP BY 1
            UNION ALL
            SELECT date_trunc($5::text, created_at), count(*)::int, 'applications'
            FROM applications
            WHERE deleted_at IS NULL AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
              AND ($3::text IS NULL OR season = $3::text) AND ($4::int[] IS NULL OR branch_id = ANY($4::int[]))
            GROUP BY 1
          )
          SELECT bucket, metric, value FROM series ORDER BY bucket, metric
        `,
          [...params.slice(0, 4), filters.bucket],
        );

        const byBucket = new Map<
          string,
          {
            bucket: string;
            leads: number;
            students: number;
            applications: number;
          }
        >();
        for (const trend of trendResult.rows) {
          const bucket = new Date(String(trend.bucket)).toISOString();
          const entry = byBucket.get(bucket) ?? {
            bucket,
            leads: 0,
            students: 0,
            applications: 0,
          };
          const metric = String(trend.metric) as
            | "leads"
            | "students"
            | "applications";
          if (metric in entry) entry[metric] = numberValue(trend.value);
          byBucket.set(bucket, entry);
        }

        const leadsCurrent = numberValue(row.leads_current);
        const applicationsCurrent = numberValue(row.applications_current);
        return {
          cards: {
            leadsCreated: leadsCurrent,
            leadsChangePercent: safeChange(
              leadsCurrent,
              numberValue(row.leads_previous),
            ),
            leadConversionRate: safeRate(
              numberValue(row.leads_converted),
              leadsCurrent,
            ),
            studentsCreated: numberValue(row.students_current),
            studentsChangePercent: safeChange(
              numberValue(row.students_current),
              numberValue(row.students_previous),
            ),
            applicationsCreated: applicationsCurrent,
            applicationsChangePercent: safeChange(
              applicationsCurrent,
              numberValue(row.applications_previous),
            ),
            applicationWinRate: safeRate(
              numberValue(row.applications_won),
              applicationsCurrent,
            ),
            activeApplications: numberValue(row.applications_active),
            staleApplications: numberValue(row.applications_stale),
          },
          trendBucket: filters.bucket,
          trend: Array.from(byBucket.values()),
        };
      });
      res.json({
        meta: buildReportingMeta(filters, startedAt, [
          ...reportingScopeWarnings(filters.allowedBranchIds),
          ...reportingSmallCohortWarnings([
            { label: "lead cohort", value: data.cards.leadsCreated },
            {
              label: "application cohort",
              value: data.cards.applicationsCreated,
            },
          ]),
          "Conversion and win rates describe the selected creation cohort's current outcome, not event-time conversion throughput.",
          "Stale application inventory uses last record update as a stage-age proxy until canonical stage-transition events are fully wired.",
        ]),
        data,
      });
    } catch (error) {
      reportFailure(res, error);
    }
  },
);

router.get(
  "/reporting/funnel",
  requireAuth,
  requirePermission("reporting.view", "reporting.operations"),
  async (req, res): Promise<void> => {
    setReportingHeaders(res);
    const filters = await readScopedFilters(req, res);
    if (!filters) return;
    const startedAt = Date.now();
    try {
      const data = await withReadOnlyReporting(async (client) => {
        const params = responseFilters(filters).slice(0, 4);
        const totalResult = await client.query<QueryRow>(
          `
          WITH lead_cohort AS (
            SELECT id, converted_student_id
            FROM leads
            WHERE deleted_at IS NULL AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
              AND ($3::text IS NULL OR season = $3::text)
              AND ($4::int[] IS NULL OR branch_id = ANY($4::int[]))
          ), cohort_apps AS (
            SELECT DISTINCT a.id, a.stage, ps.variant, ps.sort_order
            FROM applications a
            JOIN lead_cohort l ON l.id = a.lead_id
            LEFT JOIN pipeline_stages ps ON ps.entity_type = 'application' AND ps.key = a.stage
            WHERE a.deleted_at IS NULL
              AND ($3::text IS NULL OR a.season = $3::text)
              AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
          ), submitted_stage AS (
            SELECT coalesce(max(sort_order), 2)::int AS sort_order
            FROM pipeline_stages WHERE entity_type = 'application' AND key = 'submitted'
          )
          SELECT
            (SELECT count(*)::int FROM lead_cohort) AS leads,
            (SELECT count(*)::int FROM lead_cohort WHERE converted_student_id IS NOT NULL) AS converted,
            (SELECT count(DISTINCT converted_student_id)::int FROM lead_cohort WHERE converted_student_id IS NOT NULL) AS students,
            (SELECT count(*)::int FROM cohort_apps) AS applications,
            (SELECT count(*)::int FROM cohort_apps, submitted_stage
              WHERE coalesce(cohort_apps.variant, '') <> 'lost'
                AND cohort_apps.sort_order >= submitted_stage.sort_order) AS submitted,
            (SELECT count(*)::int FROM cohort_apps WHERE variant = 'won') AS won,
            (SELECT count(*)::int FROM cohort_apps WHERE variant = 'lost') AS lost
        `,
          params,
        );
        const row = totalResult.rows[0] ?? {};

        const sourceResult = await client.query<QueryRow>(
          `
          WITH lead_cohort AS (
            SELECT id, converted_student_id,
                   coalesce(nullif(trim(utm_source), ''), nullif(trim(source), ''), nullif(trim(origin_type), ''), 'Unknown') AS source_name
            FROM leads
            WHERE deleted_at IS NULL AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
              AND ($3::text IS NULL OR season = $3::text)
              AND ($4::int[] IS NULL OR branch_id = ANY($4::int[]))
          ), source_apps AS (
            SELECT l.source_name, count(DISTINCT a.id)::int AS applications,
                   count(DISTINCT a.id) FILTER (WHERE ps.variant = 'won')::int AS won
            FROM lead_cohort l
            LEFT JOIN applications a ON a.lead_id = l.id AND a.deleted_at IS NULL
              AND ($3::text IS NULL OR a.season = $3::text)
              AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
            LEFT JOIN pipeline_stages ps ON ps.entity_type = 'application' AND ps.key = a.stage
            GROUP BY l.source_name
          )
          SELECT l.source_name,
                 count(*)::int AS leads,
                 count(*) FILTER (WHERE l.converted_student_id IS NOT NULL)::int AS converted,
                 coalesce(sa.applications, 0)::int AS applications,
                 coalesce(sa.won, 0)::int AS won
          FROM lead_cohort l
          LEFT JOIN source_apps sa ON sa.source_name = l.source_name
          GROUP BY l.source_name, sa.applications, sa.won
          ORDER BY leads DESC, l.source_name ASC
          LIMIT 20
        `,
          params,
        );
        const leads = numberValue(row.leads);
        const applications = numberValue(row.applications);
        return {
          stages: [
            { key: "leads", value: leads, rateFromPrevious: null },
            {
              key: "converted",
              value: numberValue(row.converted),
              rateFromPrevious: safeRate(numberValue(row.converted), leads),
            },
            {
              key: "students",
              value: numberValue(row.students),
              rateFromPrevious: safeRate(
                numberValue(row.students),
                numberValue(row.converted),
              ),
            },
            {
              key: "applications",
              value: applications,
              rateFromPrevious: safeRate(
                applications,
                numberValue(row.students),
              ),
            },
            {
              key: "submitted",
              value: numberValue(row.submitted),
              rateFromPrevious: safeRate(
                numberValue(row.submitted),
                applications,
              ),
            },
            {
              key: "won",
              value: numberValue(row.won),
              rateFromPrevious: safeRate(
                numberValue(row.won),
                numberValue(row.submitted),
              ),
            },
          ],
          lost: numberValue(row.lost),
          sources: sourceResult.rows.map((source) => ({
            source: String(source.source_name ?? "Unknown"),
            leads: numberValue(source.leads),
            converted: numberValue(source.converted),
            applications: numberValue(source.applications),
            won: numberValue(source.won),
            leadConversionRate: safeRate(
              numberValue(source.converted),
              numberValue(source.leads),
            ),
            applicationWinRate: safeRate(
              numberValue(source.won),
              numberValue(source.applications),
            ),
          })),
        };
      });
      res.json({
        meta: buildReportingMeta(filters, startedAt, [
          ...reportingScopeWarnings(filters.allowedBranchIds),
          ...reportingSmallCohortWarnings([
            {
              label: "lead cohort",
              value: data.stages.find((stage) => stage.key === "leads")?.value ?? 0,
            },
          ]),
          "Funnel membership is fixed by lead creation date; later student and application outcomes are current-state observations.",
          "Source uses UTM source first, then lead source and origin type; unattributed records remain visible as Unknown.",
        ]),
        data,
      });
    } catch (error) {
      reportFailure(res, error);
    }
  },
);

router.get(
  "/reporting/applications",
  requireAuth,
  requirePermission("reporting.view", "reporting.operations"),
  async (req, res): Promise<void> => {
    setReportingHeaders(res);
    const filters = await readScopedFilters(req, res);
    if (!filters) return;
    const startedAt = Date.now();
    try {
      const data = await withReadOnlyReporting(async (client) => {
        const params = responseFilters(filters).slice(0, 4);
        const stages = await client.query<QueryRow>(
          `
          SELECT a.stage AS stage_key, coalesce(ps.label, a.stage) AS stage_label,
                 coalesce(ps.variant, 'open') AS variant, coalesce(ps.sort_order, 9999)::int AS sort_order,
                 count(*)::int AS inventory_count,
                 count(*) FILTER (WHERE a.created_at >= $1::timestamptz AND a.created_at < $2::timestamptz)::int AS cohort_count
          FROM applications a
          LEFT JOIN pipeline_stages ps ON ps.entity_type = 'application' AND ps.key = a.stage
          WHERE a.deleted_at IS NULL
            AND ($3::text IS NULL OR a.season = $3::text)
            AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
          GROUP BY a.stage, ps.label, ps.variant, ps.sort_order
          ORDER BY sort_order, stage_label
        `,
          params,
        );
        const aging = await client.query<QueryRow>(
          `
          SELECT CASE
              WHEN now() - a.updated_at < interval '3 days' THEN '0-2d'
              WHEN now() - a.updated_at < interval '8 days' THEN '3-7d'
              WHEN now() - a.updated_at < interval '15 days' THEN '8-14d'
              WHEN now() - a.updated_at < interval '31 days' THEN '15-30d'
              ELSE '31d+'
            END AS bucket,
            count(*)::int AS value
          FROM applications a
          LEFT JOIN pipeline_stages ps ON ps.entity_type = 'application' AND ps.key = a.stage
          WHERE a.deleted_at IS NULL AND coalesce(ps.variant, '') NOT IN ('won', 'lost')
            AND $1::timestamptz < $2::timestamptz
            AND ($3::text IS NULL OR a.season = $3::text)
            AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
          GROUP BY 1
        `,
          params,
        );
        const destinations = await client.query<QueryRow>(
          `
          SELECT coalesce(nullif(trim(country), ''), 'Unknown') AS destination,
                 count(*)::int AS applications,
                 count(*) FILTER (WHERE ps.variant = 'won')::int AS won
          FROM applications a
          LEFT JOIN pipeline_stages ps ON ps.entity_type = 'application' AND ps.key = a.stage
          WHERE a.deleted_at IS NULL AND a.created_at >= $1::timestamptz AND a.created_at < $2::timestamptz
            AND ($3::text IS NULL OR a.season = $3::text)
            AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
          GROUP BY 1 ORDER BY applications DESC, destination ASC LIMIT 20
        `,
          params,
        );
        const inventoryTotal = stages.rows.reduce(
          (sum, row) => sum + numberValue(row.inventory_count),
          0,
        );
        const cohortTotal = stages.rows.reduce(
          (sum, row) => sum + numberValue(row.cohort_count),
          0,
        );
        return {
          totals: { inventory: inventoryTotal, createdCohort: cohortTotal },
          stages: stages.rows.map((row) => ({
            key: String(row.stage_key),
            label: String(row.stage_label),
            variant: String(row.variant),
            inventory: numberValue(row.inventory_count),
            cohort: numberValue(row.cohort_count),
          })),
          lastUpdatedAging: aging.rows.map((row) => ({
            bucket: String(row.bucket),
            value: numberValue(row.value),
          })),
          destinations: destinations.rows.map((row) => ({
            destination: String(row.destination),
            applications: numberValue(row.applications),
            won: numberValue(row.won),
            winRate: safeRate(
              numberValue(row.won),
              numberValue(row.applications),
            ),
          })),
        };
      });
      res.json({
        meta: buildReportingMeta(filters, startedAt, [
          ...reportingScopeWarnings(filters.allowedBranchIds),
          ...reportingSmallCohortWarnings([
            {
              label: "application cohort",
              value: data.totals.createdCohort,
            },
          ]),
          "Inventory counts are current-state totals; cohort counts use application creation date.",
          "Aging uses applications.updated_at as a temporary stage-age proxy and must not be interpreted as an SLA clock.",
        ]),
        data,
      });
    } catch (error) {
      reportFailure(res, error);
    }
  },
);

router.get(
  "/reporting/finance",
  requireAuth,
  requirePermission("reporting.view", "reporting.finance", "finance.view"),
  async (req, res): Promise<void> => {
    setReportingHeaders(res);
    const filters = await readScopedFilters(req, res);
    if (!filters) return;
    const startedAt = Date.now();
    try {
      const data = await withReadOnlyReporting(async (client) => {
        const params = responseFilters(filters).slice(0, 4);
        const commissions = await client.query<QueryRow>(
          `
          SELECT upper(coalesce(nullif(trim(c.currency), ''), 'USD')) AS currency,
                 count(*)::int AS records,
                 coalesce(sum(c.university_commission_amount), 0) AS gross_commission,
                 coalesce(sum(c.agent_commission_amount), 0) AS agent_liability,
                 coalesce(sum(c.university_commission_amount - coalesce(c.agent_commission_amount, 0)), 0) AS net_commission,
                 coalesce(sum(c.university_collected), 0) AS collected,
                 coalesce(sum(greatest(coalesce(c.university_commission_amount, 0) - coalesce(c.university_collected, 0), 0)), 0) AS outstanding
          FROM commissions c
          LEFT JOIN applications a ON a.id = c.application_id
          WHERE c.confirmed_at >= $1::timestamptz AND c.confirmed_at < $2::timestamptz
            AND c.status IN ('confirmed', 'collected_partial', 'collected_full', 'settled')
            AND ($3::text IS NULL OR c.season = $3::text)
            AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
          GROUP BY 1 ORDER BY 1
        `,
          params,
        );
        const serviceFees = await client.query<QueryRow>(
          `
          SELECT upper(coalesce(nullif(trim(sf.currency), ''), 'USD')) AS currency,
                 count(*)::int AS records,
                 coalesce(sum(sf.total_amount), 0) AS billed,
                 coalesce(sum(
                   CASE WHEN sf.first_installment_paid_at IS NOT NULL THEN coalesce(sf.first_installment_amount, 0) ELSE 0 END
                   + CASE WHEN sf.second_installment_paid_at IS NOT NULL THEN coalesce(sf.second_installment_amount, 0) ELSE 0 END
                 ), 0) AS collected
          FROM service_fees sf
          LEFT JOIN applications a ON a.id = sf.application_id
          WHERE sf.created_at >= $1::timestamptz AND sf.created_at < $2::timestamptz
            AND sf.finance_status <> 'excluded'
            AND ($3::text IS NULL OR sf.season = $3::text)
            AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
          GROUP BY 1 ORDER BY 1
        `,
          params,
        );
        const transactions = await client.query<QueryRow>(
          `
          SELECT upper(coalesce(nullif(trim(ft.currency), ''), 'USD')) AS currency,
                 ft.type, count(*)::int AS records, coalesce(sum(ft.amount), 0) AS amount
          FROM financial_transactions ft
          LEFT JOIN commissions c ON c.id = ft.commission_id
          LEFT JOIN applications a ON a.id = c.application_id
          WHERE coalesce(ft.transaction_date, ft.created_at) >= $1::timestamptz
            AND coalesce(ft.transaction_date, ft.created_at) < $2::timestamptz
            AND ($3::text IS NULL OR c.season = $3::text)
            AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
          GROUP BY 1, ft.type ORDER BY 1, ft.type
        `,
          params,
        );
        return {
          currencyPolicy: "original_currency_only_no_cross_currency_sum",
          commissions: commissions.rows.map((row) => ({
            currency: String(row.currency),
            records: numberValue(row.records),
            grossCommission: moneyValue(row.gross_commission),
            agentLiability: moneyValue(row.agent_liability),
            netCommission: moneyValue(row.net_commission),
            collected: moneyValue(row.collected),
            outstanding: moneyValue(row.outstanding),
          })),
          serviceFees: serviceFees.rows.map((row) => ({
            currency: String(row.currency),
            records: numberValue(row.records),
            billed: moneyValue(row.billed),
            collected: moneyValue(row.collected),
            outstanding: moneyValue(
              numberValue(row.billed) - numberValue(row.collected),
            ),
          })),
          transactions: transactions.rows.map((row) => ({
            currency: String(row.currency),
            type: String(row.type),
            records: numberValue(row.records),
            amount: moneyValue(row.amount),
          })),
        };
      });
      res.json({
        meta: buildReportingMeta(filters, startedAt, [
          ...reportingScopeWarnings(filters.allowedBranchIds),
          "Amounts remain in their original currency; the API never produces a mixed-currency grand total.",
          "Commission metrics use confirmed_at; service-fee metrics describe records created in the selected interval.",
        ]),
        data,
      });
    } catch (error) {
      reportFailure(res, error);
    }
  },
);

router.get(
  "/reporting/data-quality",
  requireAuth,
  requirePermission("reporting.view", "reporting.operations"),
  async (req, res): Promise<void> => {
    setReportingHeaders(res);
    const filters = await readScopedFilters(req, res);
    if (!filters) return;
    const startedAt = Date.now();
    try {
      const data = await withReadOnlyReporting(async (client) => {
        const params = responseFilters(filters).slice(0, 4);
        const result = await client.query<QueryRow>(
          `
          WITH lead_cohort AS (
            SELECT id, utm_source, source, origin_type, assigned_to_id
            FROM leads
            WHERE deleted_at IS NULL AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
              AND ($3::text IS NULL OR season = $3::text)
              AND ($4::int[] IS NULL OR branch_id = ANY($4::int[]))
          ), app_cohort AS (
            SELECT id, lead_id, university_id, program_id, assigned_to_id
            FROM applications
            WHERE deleted_at IS NULL AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
              AND ($3::text IS NULL OR season = $3::text)
              AND ($4::int[] IS NULL OR branch_id = ANY($4::int[]))
          ), ${duplicateCandidatesCte("reporting")}, duplicate_groups AS (
            SELECT count(*)::int AS groups,
                   coalesce(sum(record_count), 0)::int AS affected
            FROM duplicate_candidates
          )
          SELECT
            (SELECT count(*)::int FROM lead_cohort) AS lead_total,
            (SELECT count(*)::int FROM lead_cohort
              WHERE coalesce(nullif(trim(utm_source), ''), nullif(trim(source), ''), nullif(trim(origin_type), '')) IS NULL) AS leads_missing_source,
            (SELECT count(*)::int FROM lead_cohort WHERE assigned_to_id IS NULL) AS leads_unassigned,
            (SELECT count(*)::int FROM app_cohort) AS application_total,
            (SELECT count(*)::int FROM app_cohort WHERE lead_id IS NULL) AS applications_missing_lead,
            (SELECT count(*)::int FROM app_cohort WHERE university_id IS NULL) AS applications_missing_university,
            (SELECT count(*)::int FROM app_cohort WHERE program_id IS NULL) AS applications_missing_program,
            (SELECT count(*)::int FROM app_cohort WHERE university_id IS NULL OR program_id IS NULL) AS applications_missing_catalog_link,
            (SELECT count(*)::int FROM app_cohort WHERE assigned_to_id IS NULL) AS applications_unassigned,
            (SELECT count(*)::int FROM applications a LEFT JOIN students s ON s.id = a.student_id
              WHERE a.deleted_at IS NULL
                AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
                AND (s.id IS NULL OR s.deleted_at IS NOT NULL)) AS orphan_applications,
            (SELECT count(*)::int FROM applications a JOIN students s ON s.id = a.student_id AND s.deleted_at IS NULL
              WHERE a.deleted_at IS NULL
                AND ($4::int[] IS NULL OR a.branch_id = ANY($4::int[]))
                AND a.branch_id IS NOT NULL AND s.branch_id IS NOT NULL AND a.branch_id IS DISTINCT FROM s.branch_id) AS branch_conflicts,
            (SELECT groups FROM duplicate_groups) AS duplicate_groups,
            (SELECT affected FROM duplicate_groups) AS duplicate_records
        `,
          params,
        );
        const row = result.rows[0] ?? {};
        const leadTotal = numberValue(row.lead_total);
        const applicationTotal = numberValue(row.application_total);
        const checks = [
          {
            key: "leads_missing_source",
            label: "Leads without acquisition source",
            severity: "warning",
            count: numberValue(row.leads_missing_source),
            scope: "selected_cohort",
          },
          {
            key: "leads_unassigned",
            label: "Unassigned leads",
            severity: "warning",
            count: numberValue(row.leads_unassigned),
            scope: "selected_cohort",
          },
          {
            key: "applications_missing_lead",
            label: "Applications without explicit lead lineage",
            severity: "warning",
            count: numberValue(row.applications_missing_lead),
            scope: "selected_cohort",
          },
          {
            key: "applications_missing_university",
            label: "Applications without university link",
            severity: "warning",
            count: numberValue(row.applications_missing_university),
            scope: "selected_cohort",
          },
          {
            key: "applications_missing_program",
            label: "Applications without program link",
            severity: "warning",
            count: numberValue(row.applications_missing_program),
            scope: "selected_cohort",
          },
          {
            key: "applications_unassigned",
            label: "Unassigned applications",
            severity: "warning",
            count: numberValue(row.applications_unassigned),
            scope: "selected_cohort",
          },
          {
            key: "orphan_applications",
            label: "Active applications without an active student",
            severity: "critical",
            count: numberValue(row.orphan_applications),
            scope:
              filters.allowedBranchIds === null
                ? "global_snapshot"
                : "branch_snapshot",
          },
          {
            key: "branch_conflicts",
            label: "Application/student branch conflicts",
            severity: "critical",
            count: numberValue(row.branch_conflicts),
            scope:
              filters.allowedBranchIds === null
                ? "global_snapshot"
                : "branch_snapshot",
          },
          {
            key: "duplicate_groups",
            label: "Potential duplicate identity groups",
            severity: "warning",
            count: numberValue(row.duplicate_groups),
            affectedRecords: numberValue(row.duplicate_records),
            scope:
              filters.allowedBranchIds === null
                ? "global_snapshot"
                : "branch_snapshot",
          },
        ];
        return {
          coverage: {
            leadSourcePercent: safeRate(
              leadTotal - numberValue(row.leads_missing_source),
              leadTotal,
            ),
            applicationLeadLineagePercent: safeRate(
              applicationTotal - numberValue(row.applications_missing_lead),
              applicationTotal,
            ),
            applicationCatalogLinkPercent: safeRate(
              applicationTotal -
                numberValue(row.applications_missing_catalog_link),
              applicationTotal,
            ),
          },
          summary: {
            critical: checks
              .filter((check) => check.severity === "critical")
              .reduce((sum, check) => sum + check.count, 0),
            warning: checks
              .filter((check) => check.severity === "warning")
              .reduce((sum, check) => sum + check.count, 0),
          },
          checks,
          mutationAvailable: false,
        };
      });
      res.json({
        meta: buildReportingMeta(filters, startedAt, [
          ...reportingScopeWarnings(filters.allowedBranchIds),
          "Checks are read-only and aggregate-only; this endpoint never returns email, phone, passport or record identifiers.",
          "Snapshot integrity and duplicate checks are intentionally independent of the selected date range.",
        ]),
        data,
      });
    } catch (error) {
      reportFailure(res, error);
    }
  },
);

export default router;
