import { createHash } from "crypto";
import type { PoolClient } from "pg";

export const OPERATIONS_WORK_SCHEMA_VERSION = 1;
export const OPERATIONS_WORK_DEFAULT_LIMIT = 50;
export const OPERATIONS_WORK_MAX_LIMIT = 100;
export const OPERATIONS_WORK_STATEMENT_TIMEOUT_MS = 5_000;

export const OPERATIONS_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
] as const;
export const OPERATIONS_SOURCES = [
  "task",
  "application",
  "document",
  "portal",
  "offer",
] as const;

export type OperationsSeverity = (typeof OPERATIONS_SEVERITIES)[number];
export type OperationsSource = (typeof OPERATIONS_SOURCES)[number];
export type OperationsScope = "all" | "mine";

export type OperationsWorkQuery = {
  limit: number;
  search: string | null;
  severity: OperationsSeverity | null;
  source: OperationsSource | null;
  scope: OperationsScope;
  cursor: string | null;
};

export type OperationsWorkCursor = {
  asOf: string;
  score: number;
  itemKey: string;
};

export type OperationsWorkScope = {
  actorUserId: number;
  actorRole: string;
  visibleBranchIds: number[] | null;
};

export type OperationsWorkItem = {
  id: string;
  source: OperationsSource;
  severity: OperationsSeverity;
  reasonCode: string;
  identity: string;
  state: string;
  nextAction: string;
  owner: string;
  dueAt: string | null;
  blocker: string;
  lastActivityAt: string | null;
  href: string;
  applicationId?: number;
  score: number;
  isMine: boolean;
};

export type OperationsWorkSummary = {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  mine: number;
  tasks: number;
  applications: number;
  documents: number;
  portal: number;
  offers: number;
};

export type OperationsWorkPage = {
  schemaVersion: number;
  asOf: string;
  generatedAt: string;
  items: OperationsWorkItem[];
  summary: OperationsWorkSummary;
  meta: {
    limit: number;
    total: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export class OperationsWorkQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationsWorkQueryError";
  }
}

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value))
    return value[0] == null ? undefined : String(value[0]);
  return value == null ? undefined : String(value);
}

function parseEnum<T extends string>(
  name: string,
  value: unknown,
  allowed: readonly T[],
): T | null {
  const raw = firstQueryValue(value)?.trim().toLowerCase();
  if (!raw || raw === "all") return null;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new OperationsWorkQueryError(`${name} is invalid`);
  }
  return raw as T;
}

export function parseOperationsWorkQuery(
  query: Record<string, unknown>,
): OperationsWorkQuery {
  const rawLimit = firstQueryValue(query.limit);
  const parsedLimit =
    rawLimit == null ? OPERATIONS_WORK_DEFAULT_LIMIT : Number(rawLimit);
  if (
    !Number.isInteger(parsedLimit) ||
    parsedLimit < 1 ||
    parsedLimit > OPERATIONS_WORK_MAX_LIMIT
  ) {
    throw new OperationsWorkQueryError(
      `limit must be an integer between 1 and ${OPERATIONS_WORK_MAX_LIMIT}`,
    );
  }

  const rawSearch = firstQueryValue(query.search)?.trim() ?? "";
  if (rawSearch.length > 120) {
    throw new OperationsWorkQueryError(
      "search must be 120 characters or fewer",
    );
  }

  const rawScope = firstQueryValue(query.scope)?.trim().toLowerCase() ?? "all";
  if (rawScope !== "all" && rawScope !== "mine") {
    throw new OperationsWorkQueryError("scope is invalid");
  }

  const rawCursor = firstQueryValue(query.cursor)?.trim() ?? "";
  if (rawCursor.length > 1_024) {
    throw new OperationsWorkQueryError("cursor is invalid");
  }

  return {
    limit: parsedLimit,
    search: rawSearch || null,
    severity: parseEnum("severity", query.severity, OPERATIONS_SEVERITIES),
    source: parseEnum("source", query.source, OPERATIONS_SOURCES),
    scope: rawScope,
    cursor: rawCursor || null,
  };
}

function filterFingerprint(query: OperationsWorkQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        search: query.search,
        severity: query.severity,
        source: query.source,
        scope: query.scope,
      }),
    )
    .digest("hex");
}

type CursorEnvelope = OperationsWorkCursor & {
  version: 1;
  filter: string;
};

export function encodeOperationsWorkCursor(
  cursor: OperationsWorkCursor,
  query: OperationsWorkQuery,
): string {
  const payload: CursorEnvelope = {
    version: 1,
    filter: filterFingerprint(query),
    ...cursor,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeOperationsWorkCursor(
  raw: string,
  query: OperationsWorkQuery,
  now = new Date(),
): OperationsWorkCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<CursorEnvelope>;
    if (
      parsed.version !== 1 ||
      parsed.filter !== filterFingerprint(query) ||
      typeof parsed.asOf !== "string" ||
      typeof parsed.score !== "number" ||
      !Number.isSafeInteger(parsed.score) ||
      parsed.score < 0 ||
      parsed.score > 5_000_000_000 ||
      typeof parsed.itemKey !== "string" ||
      parsed.itemKey.length < 3 ||
      parsed.itemKey.length > 240 ||
      !/^[A-Za-z0-9:._-]+$/.test(parsed.itemKey)
    ) {
      throw new Error("invalid cursor payload");
    }
    const asOf = new Date(parsed.asOf);
    const ageMs = now.getTime() - asOf.getTime();
    if (
      !Number.isFinite(asOf.getTime()) ||
      ageMs < -60_000 ||
      ageMs > 60 * 60_000
    ) {
      throw new Error("expired cursor");
    }
    return {
      asOf: asOf.toISOString(),
      score: parsed.score,
      itemKey: parsed.itemKey,
    };
  } catch {
    throw new OperationsWorkQueryError("cursor is invalid or expired");
  }
}

// The read model deliberately reuses the existing application, task, document,
// portal and offer records. It does not create a second workflow or persist a
// competing state. All user-controlled values remain PostgreSQL parameters.
const READ_MODEL_CTE = `
WITH params AS (
  SELECT
    $1::int AS actor_id,
    $2::text AS actor_role,
    $3::int[] AS visible_branch_ids,
    $4::timestamptz AS as_of
),
visible_applications AS MATERIALIZED (
  SELECT
    application.id,
    application.student_id,
    application.stage,
    application.deadline,
    application.updated_at,
    application.university_name,
    application.program_name,
    application.branch_id,
    student.first_name AS student_first_name,
    student.last_name AS student_last_name,
    COALESCE(application.assigned_to_id, student.assigned_to_id) AS effective_owner_id,
    COALESCE(stage.is_case_close, false) AS is_case_close,
    COALESCE(
      NULLIF(BTRIM(CONCAT_WS(' ', owner.first_name, owner.last_name)), ''),
      NULLIF(BTRIM(owner.email), ''),
      CASE
        WHEN COALESCE(application.assigned_to_id, student.assigned_to_id) IS NOT NULL
          THEN 'User #' || COALESCE(application.assigned_to_id, student.assigned_to_id)::text
        ELSE 'Unassigned'
      END
    ) AS owner_name,
    COALESCE(
      NULLIF(BTRIM(CONCAT_WS(' ', student.first_name, student.last_name)), ''),
      'Application #' || application.id::text
    ) || CASE
      WHEN NULLIF(BTRIM(CONCAT_WS(' · ', application.university_name, application.program_name)), '') IS NOT NULL
        THEN ' — ' || BTRIM(CONCAT_WS(' · ', application.university_name, application.program_name))
      ELSE ''
    END AS identity
  FROM applications application
  LEFT JOIN students student ON student.id = application.student_id
  LEFT JOIN users owner ON owner.id = COALESCE(application.assigned_to_id, student.assigned_to_id)
  LEFT JOIN pipeline_stages stage
    ON stage.entity_type = 'application' AND stage.key = application.stage
  CROSS JOIN params scope
  WHERE application.deleted_at IS NULL
    AND (
      scope.visible_branch_ids IS NULL
      OR application.branch_id IS NULL
      OR application.branch_id = ANY(scope.visible_branch_ids)
      OR student.branch_id = ANY(scope.visible_branch_ids)
      OR EXISTS (
        SELECT 1
        FROM users application_assignee
        WHERE application_assignee.id = application.assigned_to_id
          AND application_assignee.branch_id = ANY(scope.visible_branch_ids)
      )
      OR EXISTS (
        SELECT 1
        FROM users student_assignee
        WHERE student_assignee.id = student.assigned_to_id
          AND student_assignee.branch_id = ANY(scope.visible_branch_ids)
      )
      OR (
        application.branch_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM users branch_staff
          WHERE branch_staff.branch_id = application.branch_id
            AND branch_staff.deleted_at IS NULL
            AND branch_staff.is_active = true
            AND branch_staff.role IN ('staff', 'consultant', 'manager', 'admin', 'editor', 'accountant')
        )
      )
    )
),
latest_portal_observations AS MATERIALIZED (
  SELECT DISTINCT ON (observation.submission_id)
    observation.id,
    observation.submission_id,
    observation.application_id,
    observation.disposition,
    observation.identity_verified,
    observation.observed_at
  FROM portal_lifecycle_observations observation
  ORDER BY observation.submission_id, observation.observed_at DESC, observation.id DESC
),
base_items AS (
  SELECT
    'task:' || task.id::text || CASE WHEN task.due_date < scope.as_of::date::text THEN ':overdue' ELSE ':due-soon' END AS item_key,
    'task'::text AS source,
    CASE
      WHEN task.due_date < scope.as_of::date::text THEN 'critical'
      WHEN task.priority = 'high' THEN 'high'
      ELSE 'medium'
    END AS severity,
    CASE WHEN task.due_date < scope.as_of::date::text THEN 4 WHEN task.priority = 'high' THEN 3 ELSE 2 END AS severity_rank,
    100000000::bigint - REPLACE(task.due_date, '-', '')::bigint AS urgency_rank,
    CASE WHEN task.due_date < scope.as_of::date::text THEN 'TASK_OVERDUE' ELSE 'TASK_DUE_SOON' END AS reason_code,
    task.title AS identity,
    task.status AS state,
    CASE WHEN task.due_date < scope.as_of::date::text THEN 'Complete or reschedule the task' ELSE 'Complete the scheduled task' END AS next_action,
    COALESCE(
      NULLIF(BTRIM(task.assigned_to_name), ''),
      CASE WHEN task.assigned_to IS NOT NULL THEN 'User #' || task.assigned_to::text ELSE 'Unassigned' END
    ) AS owner,
    task.due_date AS due_at,
    CASE
      WHEN task.due_date < scope.as_of::date::text
        THEN 'Task is past its recorded due date'
      WHEN task.due_date = scope.as_of::date::text THEN 'Due today'
      ELSE 'Task is due within three days'
    END AS blocker,
    task.updated_at::text AS last_activity_at,
    '/staff/tasks'::text AS href,
    NULL::int AS application_id,
    task.assigned_to = scope.actor_id AS is_mine
  FROM tasks task
  CROSS JOIN params scope
  WHERE task.archived_at IS NULL
    AND task.status <> 'done'
    AND task.due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND task.due_date <= (scope.as_of::date + 3)::text
    AND (
      scope.actor_role IN ('super_admin', 'admin', 'manager')
      OR task.assigned_to = scope.actor_id
      OR task.assigned_to IS NULL
    )

  UNION ALL

  SELECT
    'application:' || application.id::text || CASE WHEN application.deadline < scope.as_of::date::text THEN ':deadline-overdue' ELSE ':deadline-soon' END,
    'application',
    CASE
      WHEN application.deadline < scope.as_of::date::text THEN 'critical'
      WHEN application.deadline <= (scope.as_of::date + 3)::text THEN 'critical'
      ELSE 'high'
    END,
    CASE WHEN application.deadline <= (scope.as_of::date + 3)::text THEN 4 ELSE 3 END,
    100000000::bigint - REPLACE(application.deadline, '-', '')::bigint,
    CASE WHEN application.deadline < scope.as_of::date::text THEN 'APPLICATION_DEADLINE_OVERDUE' ELSE 'APPLICATION_DEADLINE_SOON' END,
    application.identity,
    application.stage,
    CASE WHEN application.deadline < scope.as_of::date::text THEN 'Review the application deadline and recovery path' ELSE 'Confirm readiness before the recorded deadline' END,
    application.owner_name,
    application.deadline,
    CASE
      WHEN application.deadline < scope.as_of::date::text THEN 'Application is past its recorded deadline'
      WHEN application.deadline = scope.as_of::date::text THEN 'Deadline is today'
      ELSE 'Application deadline is within fourteen days'
    END,
    application.updated_at::text,
    '/staff/applications/' || application.id::text,
    application.id,
    application.effective_owner_id = scope.actor_id
  FROM visible_applications application
  CROSS JOIN params scope
  WHERE NOT application.is_case_close
    AND application.deadline ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND application.deadline <= (scope.as_of::date + 14)::text

  UNION ALL

  SELECT
    'application:' || application.id::text || ':unassigned',
    'application',
    'high',
    3,
    LEAST(99999999, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (scope.as_of - application.updated_at)) / 60)))::bigint,
    'APPLICATION_UNASSIGNED',
    application.identity,
    application.stage,
    'Assign an accountable owner',
    'Unassigned',
    NULL,
    'No accountable owner is recorded',
    application.updated_at::text,
    '/staff/applications/' || application.id::text,
    application.id,
    false
  FROM visible_applications application
  CROSS JOIN params scope
  WHERE NOT application.is_case_close
    AND application.effective_owner_id IS NULL

  UNION ALL

  SELECT
    'application:' || application.id::text || ':stale',
    'application',
    CASE WHEN application.updated_at <= scope.as_of - interval '14 days' THEN 'high' ELSE 'medium' END,
    CASE WHEN application.updated_at <= scope.as_of - interval '14 days' THEN 3 ELSE 2 END,
    LEAST(99999999, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (scope.as_of - application.updated_at)) / 60)))::bigint,
    'APPLICATION_STALE',
    application.identity,
    application.stage,
    'Review the case and record the next meaningful action',
    application.owner_name,
    NULL,
    'The application has no recent record update',
    application.updated_at::text,
    '/staff/applications/' || application.id::text,
    application.id,
    application.effective_owner_id = scope.actor_id
  FROM visible_applications application
  CROSS JOIN params scope
  WHERE NOT application.is_case_close
    AND application.updated_at <= scope.as_of - interval '7 days'

  UNION ALL

  SELECT
    'document:' || document.id::text || CASE WHEN LOWER(document.status) IN ('rejected', 'quarantined') THEN ':rejected' ELSE ':review' END,
    'document',
    CASE WHEN LOWER(document.status) IN ('rejected', 'quarantined') THEN 'high' ELSE 'medium' END,
    CASE WHEN LOWER(document.status) IN ('rejected', 'quarantined') THEN 3 ELSE 2 END,
    LEAST(99999999, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (scope.as_of - COALESCE(document.updated_at, document.created_at))) / 60)))::bigint,
    CASE WHEN LOWER(document.status) IN ('rejected', 'quarantined') THEN 'DOCUMENT_REJECTED' ELSE 'DOCUMENT_REVIEW_REQUIRED' END,
    COALESCE(NULLIF(BTRIM(document.name), ''), NULLIF(BTRIM(document.type), ''), 'Document #' || document.id::text),
    LOWER(document.status),
    CASE WHEN LOWER(document.status) IN ('rejected', 'quarantined') THEN 'Resolve the document issue and obtain valid evidence' ELSE 'Review and verify the document evidence' END,
    COALESCE(application.owner_name, 'Unassigned'),
    NULL,
    CASE
      WHEN LOWER(document.status) = 'quarantined' THEN 'Document is quarantined'
      WHEN LOWER(document.status) = 'rejected' THEN 'Document was rejected'
      WHEN LOWER(document.status) = 'scanning' THEN 'Document scan is not complete'
      ELSE 'Verification is pending'
    END,
    COALESCE(document.updated_at, document.created_at)::text,
    CASE
      WHEN application.id IS NOT NULL THEN '/staff/applications/' || application.id::text
      WHEN document.student_id IS NOT NULL THEN '/staff/students/' || document.student_id::text
      ELSE '/staff/students'
    END,
    application.id,
    application.effective_owner_id = scope.actor_id
  FROM documents document
  LEFT JOIN students document_student ON document_student.id = document.student_id
  LEFT JOIN visible_applications application ON application.id = document.application_id
  CROSS JOIN params scope
  WHERE document.deleted_at IS NULL
    AND LOWER(document.status) IN ('rejected', 'quarantined', 'pending', 'review_required', 'needs_review', 'scanning')
    AND (
      scope.actor_role IN ('super_admin', 'admin', 'manager')
      OR (
        document.student_id IS NOT NULL
        AND document_student.deleted_at IS NULL
        AND document_student.assigned_to_id = scope.actor_id
      )
    )

  UNION ALL

  SELECT
    'portal:' || submission.id::text || ':suspended',
    'portal',
    'critical',
    4,
    LEAST(99999999, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (scope.as_of - submission.status_check_suspended_at)) / 60)))::bigint,
    'PORTAL_STATUS_SUSPENDED',
    application.identity || ' — ' || submission.university_key,
    'suspended',
    'Inspect the portal error before resuming the isolated lane',
    application.owner_name,
    NULL,
    CASE
      WHEN submission.status_check_error = 'STATUS_CHECK_UNSUPPORTED' THEN 'unsupported'
      WHEN submission.status_check_error = 'STATUS_CHECK_TIMEOUT' THEN 'timeout'
      WHEN submission.status_check_error = 'STATUS_CHECK_AUTHENTICATION' THEN 'authentication'
      WHEN submission.status_check_error = 'STATUS_CHECK_PORTAL_DRIFT' THEN 'portal_drift'
      WHEN submission.status_check_error = 'STATUS_CHECK_NETWORK' THEN 'network'
      WHEN submission.status_check_error = 'STATUS_CHECK_LEASE_LOST' THEN 'lease_lost'
      WHEN submission.status_check_error = 'STATUS_CHECK_ARTIFACT' THEN 'artifact'
      ELSE 'other'
    END,
    submission.status_check_suspended_at::text,
    '/admin/portal-automation',
    application.id,
    application.effective_owner_id = scope.actor_id
  FROM portal_submissions submission
  JOIN visible_applications application ON application.id = submission.application_id
  CROSS JOIN params scope
  WHERE scope.actor_role IN ('super_admin', 'admin', 'manager')
    AND submission.deleted_at IS NULL
    AND submission.status_check_suspended_at IS NOT NULL

  UNION ALL

  SELECT
    'portal:' || observation.submission_id::text || ':unverified',
    'portal',
    'critical',
    4,
    LEAST(99999999, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (scope.as_of - observation.observed_at)) / 60)))::bigint,
    'PORTAL_IDENTITY_UNVERIFIED',
    application.identity || ' — ' || submission.university_key,
    observation.disposition,
    'Verify the external application identity before any lifecycle update',
    'Operations queue',
    NULL,
    'Portal observation identity is not verified',
    observation.observed_at::text,
    '/admin/portal-automation',
    application.id,
    false
  FROM latest_portal_observations observation
  JOIN portal_submissions submission ON submission.id = observation.submission_id
  JOIN visible_applications application ON application.id = observation.application_id
  CROSS JOIN params scope
  WHERE scope.actor_role IN ('super_admin', 'admin', 'manager')
    AND NOT observation.identity_verified
    AND submission.deleted_at IS NULL

  UNION ALL

  SELECT
    'portal-proposal:' || proposal.id::text,
    'portal',
    'high',
    3,
    LEAST(99999999, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (scope.as_of - proposal.created_at)) / 60)))::bigint,
    'PORTAL_LIFECYCLE_REVIEW',
    application.identity,
    proposal.raw_status,
    'Maker-checker review is required before applying the lifecycle proposal',
    'Approval queue',
    NULL,
    'Lifecycle proposal is waiting for independent review',
    proposal.created_at::text,
    '/admin/portal-automation',
    application.id,
    false
  FROM portal_lifecycle_proposals proposal
  JOIN visible_applications application ON application.id = proposal.application_id
  CROSS JOIN params scope
  WHERE scope.actor_role IN ('super_admin', 'admin', 'manager')
    AND proposal.status = 'pending_review'

  UNION ALL

  SELECT
    'offer:' || stage_document.id::text,
    'offer',
    CASE WHEN stage_document.valid_until <= scope.as_of OR stage_document.valid_until <= scope.as_of + interval '7 days' THEN 'critical' ELSE 'high' END,
    CASE WHEN stage_document.valid_until <= scope.as_of OR stage_document.valid_until <= scope.as_of + interval '7 days' THEN 4 ELSE 3 END,
    100000000::bigint - TO_CHAR(stage_document.valid_until AT TIME ZONE 'UTC', 'YYYYMMDD')::bigint,
    CASE WHEN stage_document.valid_until <= scope.as_of THEN 'OFFER_EXPIRED' ELSE 'OFFER_EXPIRING' END,
    application.identity,
    CASE WHEN stage_document.valid_until <= scope.as_of THEN 'expired' ELSE 'expiring' END,
    CASE WHEN stage_document.valid_until <= scope.as_of THEN 'Review expiry recovery options' ELSE 'Complete offer acceptance actions' END,
    application.owner_name,
    stage_document.valid_until::text,
    CASE WHEN stage_document.valid_until <= scope.as_of THEN 'Offer validity has expired' ELSE 'Offer expires within thirty days' END,
    stage_document.created_at::text,
    '/staff/applications/' || application.id::text,
    application.id,
    application.effective_owner_id = scope.actor_id
  FROM application_stage_documents stage_document
  JOIN visible_applications application ON application.id = stage_document.application_id
  JOIN pipeline_stages stage
    ON stage.entity_type = 'application'
    AND stage.key = stage_document.stage
    AND stage.tracks_offer_expiry = true
  CROSS JOIN params scope
  WHERE stage_document.valid_until IS NOT NULL
    AND stage_document.valid_until > scope.as_of - interval '7 days'
    AND stage_document.valid_until <= scope.as_of + interval '30 days'
),
ranked_items AS MATERIALIZED (
  SELECT
    item_key,
    source,
    severity,
    reason_code,
    identity,
    state,
    next_action,
    owner,
    due_at,
    blocker,
    last_activity_at,
    href,
    application_id,
    is_mine,
    (severity_rank::bigint * 1000000000::bigint + urgency_rank)::bigint AS score
  FROM base_items
)
`;

type SummaryRow = {
  total: number | string;
  filteredTotal: number | string;
  critical: number | string;
  high: number | string;
  medium: number | string;
  low: number | string;
  mine: number | string;
  tasks: number | string;
  applications: number | string;
  documents: number | string;
  portal: number | string;
  offers: number | string;
};

type ItemRow = {
  itemKey: string;
  source: OperationsSource;
  severity: OperationsSeverity;
  reasonCode: string;
  identity: string;
  state: string;
  nextAction: string;
  owner: string;
  dueAt: string | null;
  blocker: string;
  lastActivityAt: string | null;
  href: string;
  applicationId: number | null;
  isMine: boolean;
  score: number | string;
};

const FILTER_SQL = `
  ($5::text IS NULL OR LOWER(identity || ' ' || state || ' ' || next_action || ' ' || owner || ' ' || blocker) LIKE '%' || LOWER($5::text) || '%')
  AND ($6::text IS NULL OR severity = $6::text)
  AND ($7::text IS NULL OR source = $7::text)
  AND ($8::text = 'all' OR is_mine)
`;

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function readOperationsWorkPage(
  client: PoolClient,
  scope: OperationsWorkScope,
  query: OperationsWorkQuery,
  now = new Date(),
): Promise<OperationsWorkPage> {
  const cursor = query.cursor
    ? decodeOperationsWorkCursor(query.cursor, query, now)
    : null;
  const asOf = cursor?.asOf ?? now.toISOString();
  const baseParams = [
    scope.actorUserId,
    scope.actorRole,
    scope.visibleBranchIds,
    asOf,
    query.search,
    query.severity,
    query.source,
    query.scope,
  ];

  const summaryResult = await client.query<SummaryRow>(
    `${READ_MODEL_CTE}
     SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE ${FILTER_SQL})::int AS "filteredTotal",
       COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical,
       COUNT(*) FILTER (WHERE severity = 'high')::int AS high,
       COUNT(*) FILTER (WHERE severity = 'medium')::int AS medium,
       COUNT(*) FILTER (WHERE severity = 'low')::int AS low,
       COUNT(*) FILTER (WHERE is_mine)::int AS mine,
       COUNT(*) FILTER (WHERE source = 'task')::int AS tasks,
       COUNT(*) FILTER (WHERE source = 'application')::int AS applications,
       COUNT(*) FILTER (WHERE source = 'document')::int AS documents,
       COUNT(*) FILTER (WHERE source = 'portal')::int AS portal,
       COUNT(*) FILTER (WHERE source = 'offer')::int AS offers
     FROM ranked_items`,
    baseParams,
  );

  const itemResult = await client.query<ItemRow>(
    `${READ_MODEL_CTE}
     SELECT
       item_key AS "itemKey",
       source,
       severity,
       reason_code AS "reasonCode",
       identity,
       state,
       next_action AS "nextAction",
       owner,
       due_at AS "dueAt",
       blocker,
       last_activity_at AS "lastActivityAt",
       href,
       application_id AS "applicationId",
       is_mine AS "isMine",
       score
     FROM ranked_items
     WHERE ${FILTER_SQL}
       AND (
         $9::bigint IS NULL
         OR score < $9::bigint
         OR (score = $9::bigint AND item_key > $10::text)
       )
     ORDER BY score DESC, item_key ASC
     LIMIT $11::int`,
    [
      ...baseParams,
      cursor?.score ?? null,
      cursor?.itemKey ?? null,
      query.limit + 1,
    ],
  );

  const hasMore = itemResult.rows.length > query.limit;
  const pageRows = hasMore
    ? itemResult.rows.slice(0, query.limit)
    : itemResult.rows;
  const items: OperationsWorkItem[] = pageRows.map((row) => ({
    id: row.itemKey,
    source: row.source,
    severity: row.severity,
    reasonCode: row.reasonCode,
    identity: row.identity,
    state: row.state,
    nextAction: row.nextAction,
    owner: row.owner,
    dueAt: row.dueAt,
    blocker: row.blocker,
    lastActivityAt: row.lastActivityAt,
    href: row.href,
    ...(row.applicationId == null
      ? {}
      : { applicationId: Number(row.applicationId) }),
    score: numberValue(row.score),
    isMine: row.isMine,
  }));
  const last = items.at(-1);
  const summaryRow = summaryResult.rows[0];

  return {
    schemaVersion: OPERATIONS_WORK_SCHEMA_VERSION,
    asOf,
    generatedAt: new Date().toISOString(),
    items,
    summary: {
      total: numberValue(summaryRow?.total),
      critical: numberValue(summaryRow?.critical),
      high: numberValue(summaryRow?.high),
      medium: numberValue(summaryRow?.medium),
      low: numberValue(summaryRow?.low),
      mine: numberValue(summaryRow?.mine),
      tasks: numberValue(summaryRow?.tasks),
      applications: numberValue(summaryRow?.applications),
      documents: numberValue(summaryRow?.documents),
      portal: numberValue(summaryRow?.portal),
      offers: numberValue(summaryRow?.offers),
    },
    meta: {
      limit: query.limit,
      total: numberValue(summaryRow?.filteredTotal),
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeOperationsWorkCursor(
              { asOf, score: last.score, itemKey: last.id },
              query,
            )
          : null,
    },
  };
}
