/**
 * portalMgmt.ts — Portal Otomasyon Yönetim Route'ları
 *
 * Kapsam:
 *   GET  /portal-automation/settings                  — ayarları getir
 *   PUT  /portal-automation/settings                  — ayarları kaydet (upsert)
 *   GET  /portal-universities                         — üniversite listesi (filtre + paginasyon)
 *   POST /portal-universities                         — üniversite ekle
 *   PATCH /portal-universities/:id                    — üniversite güncelle
 *   DELETE /portal-universities/:id                   — üniversite sil (soft)
 *   PATCH /portal-universities/:id/active             — isActive toggle
 *   PATCH /portal-universities/:id/auto-process       — autoProcess toggle
 *
 * Kurallar: validate+getValidated (ASLA req.body), zod, logAudit,
 *           requireRole(STAFF|ADMIN), izolasyon: yok (yönetim-only).
 *           Kimlik bilgileri (şifre/token) ASLA response'a girmez.
 */

import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  portalAutomationSettingsTable,
  portalUniversitiesTable,
  portalAdaptersTable,
  portalProgramMappingTable,
  portalCredentialsTable,
  portalSubmissionsTable,
  portalWorkerJobsTable,
  pipelineStagesTable,
  universitiesTable,
  programsTable,
  GENERAL_MAPPING_KEY,
} from "@workspace/db";
import {
  resolveAdapterByKey,
  resolveAdapterForUniversity,
  adapterMetadata,
  isExperimentalAdapterKey,
  invalidateDeclarativeAdapterCache,
} from "@workspace/portal-adapters";
import { getSuccessCounts, isExperimentalDynamic, GRADUATION_THRESHOLD } from "../lib/adapterGraduation.js";
import { buildPageMeta, parsePaginationParams } from "@workspace/pagination";
import { logAudit, requireAuth, requireRole } from "../lib/auth";
import { ADMIN_ROLES, STAFF_ROLES } from "../lib/roles";
import { getValidated, validate } from "../middlewares/validate";
import { batchPortalCredentialKeys } from "../lib/portalCreds";
import { setPortalCredentials } from "../lib/portalCredentials.js";
import { buildPortalTriggerStageSnapshot } from "../lib/portalTriggerStagePolicy.js";
import { loadPortalPartnerOnboardingSnapshot } from "../lib/portalPartnerOnboarding.js";
import {
  enqueuePortalWorkerJob,
  PortalWorkerJobIdempotencyConflictError,
  PortalWorkerUnavailableError,
} from "@workspace/portal-runner";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Shared id param schema
// ---------------------------------------------------------------------------
const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
type IdSchemas = { params: typeof idParamsSchema };

const portalKeyParamsSchema = z.object({ portalKey: z.string().min(1) });
type PortalKeySchemas = { params: typeof portalKeyParamsSchema };

class PortalCredentialsInFlightError extends Error {
  constructor(readonly runningCount: number) {
    super("Portal credentials cannot be removed while submissions are running");
    this.name = "PortalCredentialsInFlightError";
  }
}

class PortalPartnerRoutingInFlightError extends Error {
  constructor(readonly runningCount: number) {
    super("Portal partner routing cannot change while submissions are running");
    this.name = "PortalPartnerRoutingInFlightError";
  }
}

type PortalMgmtTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function resetPortalAdapterExecutionStateTx(
  tx: PortalMgmtTx,
  storageKey: string,
  queueError: string,
): Promise<{ partners: number; pendingSubmissions: number }> {
  // Lock and quarantine queued work before credentials can change. A claim
  // racing this update either observes canceled after commit or becomes
  // visible to the running check, which aborts and rolls the transaction back.
  const pending = await tx
    .update(portalSubmissionsTable)
    .set({
      status: "canceled",
      error: queueError,
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(portalSubmissionsTable.adapterKey, storageKey),
      eq(portalSubmissionsTable.status, "queued"),
      isNull(portalSubmissionsTable.deletedAt),
    ))
    .returning({ id: portalSubmissionsTable.id });

  const [inFlight] = await tx
    .select({ total: count(portalSubmissionsTable.id) })
    .from(portalSubmissionsTable)
    .where(and(
      eq(portalSubmissionsTable.adapterKey, storageKey),
      eq(portalSubmissionsTable.status, "running"),
      isNull(portalSubmissionsTable.deletedAt),
    ));
  const runningCount = Number(inFlight?.total ?? 0);
  if (runningCount > 0) throw new PortalCredentialsInFlightError(runningCount);

  const partners = await tx
    .update(portalUniversitiesTable)
    .set({
      isActive: false,
      autoProcess: false,
      fanOutMode: "off",
      verificationGeneration: sql`${portalUniversitiesTable.verificationGeneration} + 1`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(portalUniversitiesTable.adapterKey, storageKey),
      isNull(portalUniversitiesTable.deletedAt),
    ))
    .returning({ id: portalUniversitiesTable.id });

  return { partners: partners.length, pendingSubmissions: pending.length };
}

async function resetPortalCredentialExecutionStateTx(
  tx: PortalMgmtTx,
  storageKey: string,
): Promise<{ partners: number; pendingSubmissions: number }> {
  return resetPortalAdapterExecutionStateTx(
    tx,
    storageKey,
    "PORTAL_CREDENTIALS_CHANGED_REVIEW_REQUIRED",
  );
}

async function quarantinePortalPartnerRoutingWorkTx(
  tx: PortalMgmtTx,
  universityKey: string,
): Promise<{ pendingSubmissions: number }> {
  // Route identity, adapter selection, defaults and catalog linkage are part
  // of the execution binding. Quarantine the exact partner queue before a
  // binding change and reject the mutation when a browser run is in flight.
  const pending = await tx
    .update(portalSubmissionsTable)
    .set({
      status: "canceled",
      error: "PORTAL_PARTNER_ROUTING_CHANGED_REVIEW_REQUIRED",
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(portalSubmissionsTable.universityKey, universityKey),
      eq(portalSubmissionsTable.status, "queued"),
      isNull(portalSubmissionsTable.deletedAt),
    ))
    .returning({ id: portalSubmissionsTable.id });

  const [inFlight] = await tx
    .select({ total: count(portalSubmissionsTable.id) })
    .from(portalSubmissionsTable)
    .where(and(
      eq(portalSubmissionsTable.universityKey, universityKey),
      eq(portalSubmissionsTable.status, "running"),
      isNull(portalSubmissionsTable.deletedAt),
    ));
  const runningCount = Number(inFlight?.total ?? 0);
  if (runningCount > 0) throw new PortalPartnerRoutingInFlightError(runningCount);

  return { pendingSubmissions: pending.length };
}

// ===========================================================================
// SETTINGS
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /portal-automation/settings
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/settings",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const [row] = await db
      .select()
      .from(portalAutomationSettingsTable)
      .orderBy(asc(portalAutomationSettingsTable.id))
      .limit(1);

    if (!row) {
      // Return default values when table is empty (no row yet)
      res.json({
        id: null,
        isEnabled: false,
        triggerStages: [],
        mode: "dry",
        scope: "only_applied",
        selectedUniversityKeys: [],
        autoProcessEnabled: false,
        autoProcessIntervalMinutes: 20,
        fallbackEnabled: false,
        fanOutMode: "off",
        lastAutoDrainAt: null,
        createdAt: null,
        updatedAt: null,
      });
      return;
    }

    res.json(row);
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/stage-options
// Authoritative Application Pipeline projection for automation configuration.
// Terminal stages remain visible but are explicitly ineligible.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/stage-options",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const [stages, settingsRows] = await Promise.all([
      db
        .select({
          key: pipelineStagesTable.key,
          label: pipelineStagesTable.label,
          sortOrder: pipelineStagesTable.sortOrder,
          variant: pipelineStagesTable.variant,
          isCaseClose: pipelineStagesTable.isCaseClose,
        })
        .from(pipelineStagesTable)
        .where(eq(pipelineStagesTable.entityType, "application"))
        .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id)),
      db
        .select({ triggerStages: portalAutomationSettingsTable.triggerStages })
        .from(portalAutomationSettingsTable)
        .orderBy(asc(portalAutomationSettingsTable.id))
        .limit(1),
    ]);
    const configured = Array.isArray(settingsRows[0]?.triggerStages)
      ? settingsRows[0].triggerStages as string[]
      : [];
    const snapshot = buildPortalTriggerStageSnapshot(stages, configured);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ ...snapshot, syncedAt: new Date().toISOString() });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/onboarding-readiness
// Read-only, secret-free control-plane projection for code-free partner setup.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/onboarding-readiness",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const snapshot = await loadPortalPartnerOnboardingSnapshot();
    res.setHeader("Cache-Control", "private, no-store");
    res.json(snapshot);
  },
);

// ---------------------------------------------------------------------------
// PUT /portal-automation/settings
// ---------------------------------------------------------------------------
const putSettingsBodySchema = z.object({
  isEnabled: z.boolean(),
  triggerStages: z.array(z.string().trim().min(1).max(128)).max(100),
  mode: z.enum(["dry", "real"]),
  scope: z.enum(["only_applied", "selected", "all"]),
  selectedUniversityKeys: z.array(z.string().trim().min(1).max(128)).max(1_000),
  autoProcessEnabled: z.boolean().optional(),
  autoProcessIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  fallbackEnabled: z.boolean().optional(),
  fanOutMode: z.enum(["off", "manual", "auto"]).optional(),
});
type PutSettingsSchemas = { body: typeof putSettingsBodySchema };

router.put(
  "/portal-automation/settings",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: putSettingsBodySchema }),
  async (req, res): Promise<void> => {
    const body = getValidated<PutSettingsSchemas>(req).body;
    const user = req.user!;

    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('portal_automation_trigger_stages_v1'))`);

      const stages = await tx
        .select({
          key: pipelineStagesTable.key,
          label: pipelineStagesTable.label,
          sortOrder: pipelineStagesTable.sortOrder,
          variant: pipelineStagesTable.variant,
          isCaseClose: pipelineStagesTable.isCaseClose,
        })
        .from(pipelineStagesTable)
        .where(eq(pipelineStagesTable.entityType, "application"))
        .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id));
      const snapshot = buildPortalTriggerStageSnapshot(stages, body.triggerStages);

      if (snapshot.staleConfiguredKeys.length > 0) {
        const error = new Error("Unknown Application Pipeline trigger stage") as Error & { code?: string; details?: string[] };
        error.code = "UNKNOWN_TRIGGER_STAGE";
        error.details = snapshot.staleConfiguredKeys;
        throw error;
      }
      if (snapshot.ineligibleConfiguredKeys.length > 0) {
        const error = new Error("Terminal Application Pipeline stages cannot trigger portal submission") as Error & { code?: string; details?: string[] };
        error.code = "INELIGIBLE_TRIGGER_STAGE";
        error.details = snapshot.ineligibleConfiguredKeys;
        throw error;
      }
      if ((body.isEnabled || body.autoProcessEnabled === true) && snapshot.validConfiguredKeys.length === 0) {
        const error = new Error("At least one eligible Application Pipeline stage is required") as Error & { code?: string; details?: string[] };
        error.code = "TRIGGER_STAGE_REQUIRED";
        error.details = [];
        throw error;
      }

      const [existing] = await tx
        .select({ id: portalAutomationSettingsTable.id })
        .from(portalAutomationSettingsTable)
        .orderBy(asc(portalAutomationSettingsTable.id))
        .limit(1);

      if (existing) {
        const [updated] = await tx
          .update(portalAutomationSettingsTable)
          .set({
            isEnabled:                   body.isEnabled,
            triggerStages:               snapshot.validConfiguredKeys,
            mode:                        body.mode,
            scope:                       body.scope,
            selectedUniversityKeys:      body.selectedUniversityKeys,
            ...(body.autoProcessEnabled !== undefined && { autoProcessEnabled: body.autoProcessEnabled }),
            ...(body.autoProcessIntervalMinutes !== undefined && { autoProcessIntervalMinutes: body.autoProcessIntervalMinutes }),
            ...(body.fallbackEnabled !== undefined && { fallbackEnabled: body.fallbackEnabled }),
            ...(body.fanOutMode     !== undefined && { fanOutMode:     body.fanOutMode }),
            updatedAt:                   new Date(),
          })
          .where(eq(portalAutomationSettingsTable.id, existing.id))
          .returning();
        return updated;
      }

      const [inserted] = await tx
        .insert(portalAutomationSettingsTable)
        .values({
          isEnabled:                   body.isEnabled,
          triggerStages:               snapshot.validConfiguredKeys,
          mode:                        body.mode,
          scope:                       body.scope,
          selectedUniversityKeys:      body.selectedUniversityKeys,
          autoProcessEnabled:          body.autoProcessEnabled ?? false,
          autoProcessIntervalMinutes:  body.autoProcessIntervalMinutes ?? 20,
          fallbackEnabled:             body.fallbackEnabled ?? false,
          fanOutMode:                  body.fanOutMode ?? "off",
        })
        .returning();
      return inserted;
    }).catch((error: Error & { code?: string; details?: string[] }) => {
      if (error.code === "UNKNOWN_TRIGGER_STAGE" || error.code === "INELIGIBLE_TRIGGER_STAGE" || error.code === "TRIGGER_STAGE_REQUIRED") {
        res.status(400).json({
          error: error.code,
          message: error.message,
          triggerStages: error.details ?? [],
        });
        return null;
      }
      throw error;
    });
    if (!row) return;

    logAudit(
      user.id,
      "update_portal_automation_settings",
      "portal_automation_settings",
      row.id,
      {
        isEnabled: body.isEnabled,
        mode: body.mode,
        scope: body.scope,
        triggerStagesCount: row.triggerStages.length,
        autoProcessEnabled: body.autoProcessEnabled,
        autoProcessIntervalMinutes: body.autoProcessIntervalMinutes,
        fallbackEnabled: body.fallbackEnabled,
        fanOutMode: body.fanOutMode,
      },
      req.ip,
    );

    res.json(row);
  },
);

// ===========================================================================
// PORTAL UNIVERSITIES
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /portal-universities
// ---------------------------------------------------------------------------
const listUniversitiesQuerySchema = z.object({
  search:   z.string().optional(),
  isActive: z
    .string()
    .transform((v) => v === "true" ? true : v === "false" ? false : undefined)
    .optional(),
  sortField: z.enum(["universityName", "universityKey", "adapterKey", "createdAt"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});
type ListUnisSchemas = { query: typeof listUniversitiesQuerySchema };

function safePortalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

router.get(
  "/portal-universities",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ query: listUniversitiesQuerySchema }),
  async (req, res): Promise<void> => {
    const { search, isActive, sortField, sortDir } = getValidated<ListUnisSchemas>(req).query;
    const pageParams = parsePaginationParams(req, { defaultLimit: 50, maxLimit: "large" });

    const uniSortColumnMap = {
      universityName: portalUniversitiesTable.universityName,
      universityKey: portalUniversitiesTable.universityKey,
      adapterKey: portalUniversitiesTable.adapterKey,
      createdAt: portalUniversitiesTable.createdAt,
    } as const;
    const uniSortColumn = uniSortColumnMap[sortField ?? "universityName"];
    const uniSortDirFn = sortDir === "desc" ? desc : asc;

    const conditions: (SQL | undefined)[] = [isNull(portalUniversitiesTable.deletedAt)];

    if (search && search.trim()) {
      const pattern = `%${search.trim()}%`;
      conditions.push(
        or(
          ilike(portalUniversitiesTable.universityName, pattern),
          ilike(portalUniversitiesTable.universityKey, pattern),
          ilike(portalUniversitiesTable.adapterKey, pattern),
        ),
      );
    }

    if (isActive !== undefined) {
      conditions.push(eq(portalUniversitiesTable.isActive, isActive));
    }

    const where = and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(portalUniversitiesTable)
      .where(where);

    const rows = await db
      .select()
      .from(portalUniversitiesTable)
      .where(where)
      .orderBy(uniSortDirFn(uniSortColumn), asc(portalUniversitiesTable.id))
      .limit(pageParams.limit)
      .offset(pageParams.offset);

    const adapterUrls = new Map(
      adapterMetadata()
        .map((adapter) => [adapter.key, safePortalUrl(adapter.portalUrl)] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== null),
    );

    const unresolvedAdapterKeys = Array.from(
      new Set(rows.map((row) => row.adapterKey).filter((key) => !adapterUrls.has(key))),
    );
    if (unresolvedAdapterKeys.length > 0) {
      const dbAdapterUrls = await db
        .select({ key: portalAdaptersTable.key, baseUrl: portalAdaptersTable.baseUrl })
        .from(portalAdaptersTable)
        .where(and(
          inArray(portalAdaptersTable.key, unresolvedAdapterKeys),
          isNull(portalAdaptersTable.deletedAt),
        ));
      for (const adapter of dbAdapterUrls) {
        const url = safePortalUrl(adapter.baseUrl);
        if (url) adapterUrls.set(adapter.key, url);
      }
    }

    // CRM link status — resolve the linked CRM university name + active program
    // count for the crm_university_id column (drives the frontend Linked/Stale
    // badge). Batched by the collected ids (no paginated join).
    const crmIds = Array.from(
      new Set(rows.map((r) => r.crmUniversityId).filter((x): x is number => x != null)),
    );
    const crmInfo = new Map<number, { name: string; programCount: number }>();
    if (crmIds.length > 0) {
      const info = await db
        .select({
          id: universitiesTable.id,
          name: universitiesTable.name,
          programCount: count(programsTable.id),
        })
        .from(universitiesTable)
        .leftJoin(
          programsTable,
          and(
            eq(programsTable.universityId, universitiesTable.id),
            eq(programsTable.isActive, true),
          ),
        )
        .where(inArray(universitiesTable.id, crmIds))
        .groupBy(universitiesTable.id, universitiesTable.name);
      for (const i of info) {
        crmInfo.set(i.id, { name: i.name, programCount: Number(i.programCount) || 0 });
      }
    }

    // Attach hasCredentials boolean — DB-first by adapterKey (canonical), then universityKey
    // as fallback, then env. NEVER expose actual credential values.
    const dbCredKeys = await batchPortalCredentialKeys();
    const graduationRequiredKeys = Array.from(
      new Set(rows.map((row) => row.adapterKey).filter(isExperimentalAdapterKey)),
    );
    const adapterSuccessCounts = await getSuccessCounts(graduationRequiredKeys);
    const onboardingSnapshot = await loadPortalPartnerOnboardingSnapshot(
      rows.map((row) => row.id),
    );
    const onboardingById = new Map(
      onboardingSnapshot.partners.map((partner) => [partner.id, partner] as const),
    );
    const rowsWithCreds = rows.map((row) => {
      const K = row.adapterKey.toUpperCase().replace(/-/g, "_");
      const envHas = !!(
        (process.env[`${K}_EMAIL`] || process.env[`${K}_USER`]) &&
        process.env[`${K}_PASSWORD`]
      );
      const hasCredentials = dbCredKeys.has(row.adapterKey) || dbCredKeys.has(row.universityKey) || envHas;
      const crm = row.crmUniversityId != null ? crmInfo.get(row.crmUniversityId) : undefined;
      const programCount = crm?.programCount ?? 0;
      // linkStatus mirrors the reconciler: a link is "stale" when the CRM row is
      // gone (missing) or carries no active programs (gives fan-out nothing);
      // "linked" only when it resolves to a CRM university with programs.
      const linkStatus: "linked" | "stale" | "unlinked" =
        row.crmUniversityId == null
          ? "unlinked"
          : !crm || programCount === 0
            ? "stale"
            : "linked";
      const staticExperimental = isExperimentalAdapterKey(row.adapterKey);
      const successCount = staticExperimental
        ? (adapterSuccessCounts.get(row.adapterKey) ?? 0)
        : null;
      const graduated = staticExperimental
        ? successCount! >= GRADUATION_THRESHOLD
        : null;
      return {
        ...row,
        portalUrl: adapterUrls.get(row.adapterKey) ?? null,
        hasCredentials,
        crmUniversityName: crm?.name ?? null,
        programCount,
        linkStatus,
        // Return the decision on the row that owns the toggle. Custom DB/spec
        // adapters are not necessarily present in the static registry list,
        // so deriving this only in the browser can briefly render a fail-open
        // auto-process control even though the mutation endpoint rejects it.
        experimental: staticExperimental && !graduated,
        staticExperimental,
        successCount,
        graduationThreshold: staticExperimental ? GRADUATION_THRESHOLD : null,
        graduated,
        readiness: onboardingById.get(row.id)?.readiness ?? null,
      };
    });

    res.json({ data: rowsWithCreds, ...buildPageMeta(total, pageParams) });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-universities
// ---------------------------------------------------------------------------
const createUniversityBodySchema = z.object({
  universityKey:    z.string().min(1).regex(/^[a-z0-9_-]+$/, "Only lowercase letters, digits, underscores and hyphens").refine((k) => k !== GENERAL_MAPPING_KEY, `'${GENERAL_MAPPING_KEY}' is reserved for the General mapping tier`),
  universityName:   z.string().min(1),
  // Normally omitted: the canonical resolver selects the adapter from the
  // university name. Kept optional for backwards-compatible operational API
  // clients that intentionally pin a specific registered adapter.
  adapterKey:       z.string().min(1).optional(),
  crmUniversityId:  z.coerce.number().int().positive().optional(),
  // New partners always start inert. Activation is a separate readiness-bound
  // operation so a stale client cannot skip credentials/catalog checks.
  isActive:         z.literal(false).optional(),
  defaults:         z.record(z.unknown()).optional(),
});
type CreateUniSchemas = { body: typeof createUniversityBodySchema };

router.post(
  "/portal-universities",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: createUniversityBodySchema }),
  async (req, res): Promise<void> => {
    const body = getValidated<CreateUniSchemas>(req).body;
    const user = req.user!;

    // Uniqueness check on universityKey
    const [existing] = await db
      .select({ id: portalUniversitiesTable.id })
      .from(portalUniversitiesTable)
      .where(eq(portalUniversitiesTable.universityKey, body.universityKey))
      .limit(1);

    if (existing) {
      res.status(409).json({
        error: "DUPLICATE_KEY",
        message: `universityKey '${body.universityKey}' already exists`,
      });
      return;
    }

    const adapter = body.adapterKey
      ? await resolveAdapterByKey(body.adapterKey)
      : await resolveAdapterForUniversity(body.universityName);

    if (!adapter) {
      res.status(422).json({
        error: body.adapterKey ? "ADAPTER_NOT_FOUND" : "NO_MATCHING_ADAPTER",
        message: body.adapterKey
          ? `Registered adapter '${body.adapterKey}' was not found.`
          : `No registered adapter matches '${body.universityName}'. Create or register the adapter first.`,
      });
      return;
    }

    const [row] = await db
      .insert(portalUniversitiesTable)
      .values({
        universityKey:   body.universityKey,
        universityName:  body.universityName,
        adapterKey:      adapter.key,
        crmUniversityId: body.crmUniversityId ?? null,
        // A newly discovered portal must complete credentials, login testing
        // and program mapping before it participates in routing.
        isActive:        false,
        defaults:        body.defaults ?? null,
      })
      .returning();

    logAudit(
      user.id,
      "create_portal_university",
      "portal_university",
      row.id,
      { universityKey: row.universityKey, adapterKey: row.adapterKey },
      req.ip,
    );

    res.status(201).json({
      ...row,
      portalUrl: safePortalUrl(adapter.portalUrl),
    });
  },
);

// ---------------------------------------------------------------------------
// PATCH /portal-universities/:id/auto-process  — toggle (must be BEFORE /:id)
// ---------------------------------------------------------------------------
const toggleAutoProcessBodySchema = z.object({
  autoProcess: z.boolean(),
});
type ToggleAutoProcessSchemas = { params: typeof idParamsSchema; body: typeof toggleAutoProcessBodySchema };

router.patch(
  "/portal-universities/:id/auto-process",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema, body: toggleAutoProcessBodySchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<ToggleAutoProcessSchemas>(req).params;
    const { autoProcess } = getValidated<ToggleAutoProcessSchemas>(req).body;
    const user = req.user!;

    const [row] = await db
      .select({
        id: portalUniversitiesTable.id,
        adapterKey: portalUniversitiesTable.adapterKey,
      })
      .from(portalUniversitiesTable)
      .where(and(
        eq(portalUniversitiesTable.id, id),
        isNull(portalUniversitiesTable.deletedAt),
      ));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    // Auto-graduation guard: an experimental adapter that has NOT yet reached
    // GRADUATION_THRESHOLD verified successes may not enable auto-process.
    // (Manual single-submission remains allowed regardless.)
    if (autoProcess && await isExperimentalDynamic(row.adapterKey)) {
      res.status(409).json({
        error: "EXPERIMENTAL_ADAPTER",
        message: `Adapter '${row.adapterKey}' is experimental and has not yet graduated (${GRADUATION_THRESHOLD} successful submissions required).`,
      });
      return;
    }

    if (autoProcess) {
      const readiness = (await loadPortalPartnerOnboardingSnapshot([id])).partners[0];
      if (!readiness?.isActive || !readiness.readiness.automaticEligible) {
        res.status(409).json({
          error: "AUTOMATION_NOT_READY",
          message: "Portal partner is not ready for automatic processing.",
          blockers: readiness?.readiness.blockers ?? ["PARTNER_NOT_FOUND"],
          successProofsRemaining: readiness?.readiness.successProofsRemaining ?? GRADUATION_THRESHOLD,
        });
        return;
      }
    }

    const [updated] = await db
      .update(portalUniversitiesTable)
      .set({ autoProcess, updatedAt: new Date() })
      .where(eq(portalUniversitiesTable.id, id))
      .returning();

    logAudit(
      user.id,
      autoProcess ? "enable_portal_auto_process" : "disable_portal_auto_process",
      "portal_university",
      id,
      { autoProcess },
      req.ip,
    );

    res.json(updated);
  },
);

// ---------------------------------------------------------------------------
// PATCH /portal-universities/:id/fan-out-mode  — toggle (must be BEFORE /:id)
// ---------------------------------------------------------------------------
const toggleFanOutModeBodySchema = z.object({
  fanOutMode: z.enum(["off", "manual", "auto"]).nullable(),
});
type ToggleFanOutModeSchemas = { params: typeof idParamsSchema; body: typeof toggleFanOutModeBodySchema };

router.patch(
  "/portal-universities/:id/fan-out-mode",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema, body: toggleFanOutModeBodySchema }),
  async (req, res): Promise<void> => {
    const { id }        = getValidated<ToggleFanOutModeSchemas>(req).params;
    const { fanOutMode } = getValidated<ToggleFanOutModeSchemas>(req).body;
    const user          = req.user!;

    const [row] = await db
      .select({ id: portalUniversitiesTable.id })
      .from(portalUniversitiesTable)
      .where(and(
        eq(portalUniversitiesTable.id, id),
        isNull(portalUniversitiesTable.deletedAt),
      ));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    if (fanOutMode !== null && fanOutMode !== "off") {
      const readiness = (await loadPortalPartnerOnboardingSnapshot([id])).partners[0];
      const eligible = fanOutMode === "auto"
        ? readiness?.readiness.automaticEligible
        : readiness?.readiness.manualPilotEligible;
      if (!readiness?.isActive || !eligible) {
        res.status(409).json({
          error: "FAN_OUT_NOT_READY",
          message: "Portal partner is not ready for this fan-out mode.",
          blockers: readiness?.readiness.blockers ?? ["PARTNER_NOT_FOUND"],
          successProofsRemaining: readiness?.readiness.successProofsRemaining ?? GRADUATION_THRESHOLD,
        });
        return;
      }
    }

    const [updated] = await db
      .update(portalUniversitiesTable)
      .set({ fanOutMode: fanOutMode ?? null, updatedAt: new Date() })
      .where(eq(portalUniversitiesTable.id, id))
      .returning();

    logAudit(
      user.id,
      "set_portal_fan_out_mode",
      "portal_university",
      id,
      { fanOutMode },
      req.ip,
    );

    res.json(updated);
  },
);

// ---------------------------------------------------------------------------
// PATCH /portal-universities/:id/active  — toggle (must be BEFORE /:id)
// ---------------------------------------------------------------------------
const toggleActiveBodySchema = z.object({
  isActive: z.boolean(),
});
type ToggleSchemas = { params: typeof idParamsSchema; body: typeof toggleActiveBodySchema };

router.patch(
  "/portal-universities/:id/active",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema, body: toggleActiveBodySchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<ToggleSchemas>(req).params;
    const { isActive } = getValidated<ToggleSchemas>(req).body;
    const user = req.user!;

    const [row] = await db
      .select({ id: portalUniversitiesTable.id })
      .from(portalUniversitiesTable)
      .where(and(
        eq(portalUniversitiesTable.id, id),
        isNull(portalUniversitiesTable.deletedAt),
      ));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    if (isActive) {
      const readiness = (await loadPortalPartnerOnboardingSnapshot([id])).partners[0];
      if (!readiness?.readiness.activationEligible) {
        res.status(409).json({
          error: "ONBOARDING_NOT_READY",
          message: "Complete the partner configuration before activation.",
          blockers: readiness?.readiness.activationBlockers ?? ["PARTNER_NOT_FOUND"],
        });
        return;
      }
    }

    const [updated] = await db
      .update(portalUniversitiesTable)
      .set({
        isActive,
        // Deactivation is a kill switch, not a cosmetic flag. A later
        // reactivation must never silently resurrect automatic fan-out.
        ...(!isActive ? { autoProcess: false, fanOutMode: "off" as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(portalUniversitiesTable.id, id))
      .returning();

    logAudit(
      user.id,
      isActive ? "activate_portal_university" : "deactivate_portal_university",
      "portal_university",
      id,
      { isActive },
      req.ip,
    );

    res.json(updated);
  },
);

// ---------------------------------------------------------------------------
// PATCH /portal-universities/:id
// ---------------------------------------------------------------------------
const updateUniversityBodySchema = z.object({
  universityKey:   z.string().min(1).regex(/^[a-z0-9_-]+$/).refine((k) => k !== GENERAL_MAPPING_KEY, `'${GENERAL_MAPPING_KEY}' is reserved for the General mapping tier`).optional(),
  universityName:  z.string().min(1).optional(),
  adapterKey:      z.string().min(1).optional(),
  crmUniversityId: z.coerce.number().int().positive().nullable().optional(),
  defaults:        z.record(z.unknown()).nullable().optional(),
  isMultiPortal:   z.boolean().optional(),
  fanOutMode:      z.enum(["off", "manual", "auto"]).nullable().optional(),
}).strict();
type UpdateUniSchemas = { params: typeof idParamsSchema; body: typeof updateUniversityBodySchema };

router.patch(
  "/portal-universities/:id",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema, body: updateUniversityBodySchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<UpdateUniSchemas>(req).params;
    const body   = getValidated<UpdateUniSchemas>(req).body;
    const user   = req.user!;

    const [row] = await db
      .select()
      .from(portalUniversitiesTable)
      .where(and(
        eq(portalUniversitiesTable.id, id),
        isNull(portalUniversitiesTable.deletedAt),
      ));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    // Check key uniqueness if changing it
    if (body.universityKey && body.universityKey !== row.universityKey) {
      const [dup] = await db
        .select({ id: portalUniversitiesTable.id })
        .from(portalUniversitiesTable)
        .where(eq(portalUniversitiesTable.universityKey, body.universityKey))
        .limit(1);
      if (dup) {
        res.status(409).json({
          error: "DUPLICATE_KEY",
          message: `universityKey '${body.universityKey}' already exists`,
        });
        return;
      }
    }

    const patch: Partial<typeof portalUniversitiesTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.universityKey   !== undefined) patch.universityKey   = body.universityKey;
    if (body.universityName  !== undefined) patch.universityName  = body.universityName;
    if (body.adapterKey      !== undefined) patch.adapterKey      = body.adapterKey;
    if ("crmUniversityId" in body)          patch.crmUniversityId = body.crmUniversityId ?? null;
    if ("defaults"        in body)          patch.defaults        = body.defaults ?? null;
    if (body.isMultiPortal !== undefined)   patch.isMultiPortal   = body.isMultiPortal;
    if ("fanOutMode"      in body)          patch.fanOutMode      = body.fanOutMode ?? null;

    const keyRenamed =
      body.universityKey !== undefined && body.universityKey !== row.universityKey;
    const disabledMultiPortal = body.isMultiPortal === false;
    const routingChanged =
      keyRenamed ||
      (body.universityName !== undefined && body.universityName !== row.universityName) ||
      (body.adapterKey !== undefined && body.adapterKey !== row.adapterKey) ||
      ("crmUniversityId" in body && body.crmUniversityId !== row.crmUniversityId) ||
      "defaults" in body ||
      (body.isMultiPortal !== undefined && body.isMultiPortal !== row.isMultiPortal);
    if (!routingChanged && body.fanOutMode && body.fanOutMode !== "off") {
      const readiness = (await loadPortalPartnerOnboardingSnapshot([id])).partners[0];
      const eligible = body.fanOutMode === "auto"
        ? readiness?.readiness.automaticEligible
        : readiness?.readiness.manualPilotEligible;
      if (!readiness?.isActive || !eligible) {
        res.status(409).json({
          error: "FAN_OUT_NOT_READY",
          message: "Portal partner is not ready for this fan-out mode.",
          blockers: readiness?.readiness.blockers ?? ["PARTNER_NOT_FOUND"],
          successProofsRemaining: readiness?.readiness.successProofsRemaining ?? GRADUATION_THRESHOLD,
        });
        return;
      }
    }
    if (routingChanged) {
      patch.isActive = false;
      patch.autoProcess = false;
      patch.fanOutMode = "off";
    }

    let safetyReset: { pendingSubmissions: number } | null = null;
    let updated;
    try {
      updated = await db.transaction(async (tx) => {
        if (routingChanged) {
          safetyReset = await quarantinePortalPartnerRoutingWorkTx(
            tx,
            row.universityKey,
          );
        }
        const [u] = await tx
          .update(portalUniversitiesTable)
          .set({
            ...patch,
            ...(routingChanged
              ? {
                  verificationGeneration:
                    sql`${portalUniversitiesTable.verificationGeneration} + 1`,
                }
              : {}),
          })
          .where(eq(portalUniversitiesTable.id, id))
          .returning();

        // If the multi-portal flag was turned OFF, detach its members so their
        // routes_via no longer dangles on a non-portal company. The edited
        // partner itself was already returned to inert mode by the safety reset.
        if (disabledMultiPortal) {
          await tx
            .update(portalUniversitiesTable)
            .set({ routesVia: null, updatedAt: new Date() })
            .where(and(
              eq(portalUniversitiesTable.routesVia, row.universityKey),
              isNull(portalUniversitiesTable.deletedAt),
            ));
        } else if (keyRenamed) {
          // Renaming the company's key would orphan members whose routes_via
          // still points at the OLD key (resolveAdapterKey would fall back to
          // their own adapter). Propagate the rename so routing continuity holds.
          await tx
            .update(portalUniversitiesTable)
            .set({ routesVia: body.universityKey!, updatedAt: new Date() })
            .where(and(
              eq(portalUniversitiesTable.routesVia, row.universityKey),
              isNull(portalUniversitiesTable.deletedAt),
            ));
        }

        return u;
      });
    } catch (error) {
      if (error instanceof PortalPartnerRoutingInFlightError) {
        res.status(409).json({
          error: "ROUTING_CHANGE_IN_FLIGHT",
          message: "Wait for running submissions to finish before changing partner routing.",
          runningCount: error.runningCount,
        });
        return;
      }
      throw error;
    }

    logAudit(
      user.id,
      "update_portal_university",
      "portal_university",
      id,
      { ...body, safetyReset },
      req.ip,
    );

    res.json(updated);
  },
);

// ---------------------------------------------------------------------------
// DELETE /portal-universities/:id  (soft-delete)
// ---------------------------------------------------------------------------
router.delete(
  "/portal-universities/:id",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<IdSchemas>(req).params;
    const user   = req.user!;

    const [row] = await db
      .select({ id: portalUniversitiesTable.id })
      .from(portalUniversitiesTable)
      .where(and(
        eq(portalUniversitiesTable.id, id),
        isNull(portalUniversitiesTable.deletedAt),
      ));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    await db
      .update(portalUniversitiesTable)
      .set({ deletedAt: new Date() })
      .where(eq(portalUniversitiesTable.id, id));

    logAudit(
      user.id,
      "delete_portal_university",
      "portal_university",
      id,
      {},
      req.ip,
    );

    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-universities/bulk-active — activate/deactivate many rows at once.
// ---------------------------------------------------------------------------
const bulkUniIdsBodySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
});

const bulkActiveBodySchema = bulkUniIdsBodySchema.extend({
  isActive: z.boolean(),
});
type BulkActiveSchemas = { body: typeof bulkActiveBodySchema };

router.post(
  "/portal-universities/bulk-active",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: bulkActiveBodySchema }),
  async (req, res): Promise<void> => {
    const { ids, isActive } = getValidated<BulkActiveSchemas>(req).body;
    const user = req.user!;

    const eligible = await db
      .select({ id: portalUniversitiesTable.id })
      .from(portalUniversitiesTable)
      .where(and(inArray(portalUniversitiesTable.id, ids), isNull(portalUniversitiesTable.deletedAt)));
    let eligibleIds = eligible.map((r) => r.id);

    if (isActive && eligibleIds.length > 0) {
      const snapshot = await loadPortalPartnerOnboardingSnapshot(eligibleIds);
      const readyIds = new Set(
        snapshot.partners
          .filter((partner) => partner.readiness.activationEligible)
          .map((partner) => partner.id),
      );
      eligibleIds = eligibleIds.filter((id) => readyIds.has(id));
    }

    if (eligibleIds.length > 0) {
      await db
        .update(portalUniversitiesTable)
        .set({
          isActive,
          ...(!isActive ? { autoProcess: false, fanOutMode: "off" as const } : {}),
          updatedAt: new Date(),
        })
        .where(inArray(portalUniversitiesTable.id, eligibleIds));
    }

    logAudit(
      user.id,
      isActive ? "bulk_activate_portal_university" : "bulk_deactivate_portal_university",
      "portal_university",
      undefined,
      { requested: ids, updated: eligibleIds },
      req.ip,
    );

    res.json({
      updated: eligibleIds.length,
      ids: eligibleIds,
      skipped: ids.filter((id) => !eligibleIds.includes(id)),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-universities/bulk-auto-process — toggle autoProcess for many.
// ---------------------------------------------------------------------------
const bulkAutoProcessBodySchema = bulkUniIdsBodySchema.extend({
  autoProcess: z.boolean(),
});
type BulkAutoProcessSchemas = { body: typeof bulkAutoProcessBodySchema };

router.post(
  "/portal-universities/bulk-auto-process",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: bulkAutoProcessBodySchema }),
  async (req, res): Promise<void> => {
    const { ids, autoProcess } = getValidated<BulkAutoProcessSchemas>(req).body;
    const user = req.user!;

    const eligible = await db
      .select({
        id: portalUniversitiesTable.id,
        adapterKey: portalUniversitiesTable.adapterKey,
      })
      .from(portalUniversitiesTable)
      .where(and(inArray(portalUniversitiesTable.id, ids), isNull(portalUniversitiesTable.deletedAt)));

    // Readiness guard (enable only): silently skip inactive, incomplete or
    // non-graduated partners while keeping partial-success bulk semantics.
    let eligibleRows = eligible;
    if (autoProcess) {
      const readiness = await loadPortalPartnerOnboardingSnapshot(
        eligible.map((row) => row.id),
      );
      const readyIds = new Set(
        readiness.partners
          .filter((partner) => partner.isActive && partner.readiness.automaticEligible)
          .map((partner) => partner.id),
      );
      eligibleRows = eligible.filter((row) => readyIds.has(row.id));
    }
    const eligibleIds = eligibleRows.map((r) => r.id);

    if (eligibleIds.length > 0) {
      await db
        .update(portalUniversitiesTable)
        .set({ autoProcess, updatedAt: new Date() })
        .where(inArray(portalUniversitiesTable.id, eligibleIds));
    }

    logAudit(
      user.id,
      autoProcess ? "bulk_enable_portal_auto_process" : "bulk_disable_portal_auto_process",
      "portal_university",
      undefined,
      { requested: ids, updated: eligibleIds },
      req.ip,
    );

    res.json({
      updated: eligibleIds.length,
      ids: eligibleIds,
      skipped: ids.filter((id) => !eligibleIds.includes(id)),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-universities/bulk-delete — soft-delete many rows at once.
// ---------------------------------------------------------------------------
type BulkUniIdsSchemas = { body: typeof bulkUniIdsBodySchema };

router.post(
  "/portal-universities/bulk-delete",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: bulkUniIdsBodySchema }),
  async (req, res): Promise<void> => {
    const { ids } = getValidated<BulkUniIdsSchemas>(req).body;
    const user = req.user!;

    const eligible = await db
      .select({ id: portalUniversitiesTable.id })
      .from(portalUniversitiesTable)
      .where(and(inArray(portalUniversitiesTable.id, ids), isNull(portalUniversitiesTable.deletedAt)));
    const eligibleIds = eligible.map((r) => r.id);

    if (eligibleIds.length > 0) {
      await db
        .update(portalUniversitiesTable)
        .set({ deletedAt: new Date() })
        .where(inArray(portalUniversitiesTable.id, eligibleIds));
    }

    logAudit(
      user.id,
      "bulk_delete_portal_university",
      "portal_university",
      undefined,
      { requested: ids, deleted: eligibleIds },
      req.ip,
    );

    res.json({
      deleted: eligibleIds.length,
      ids: eligibleIds,
      skipped: ids.filter((id) => !eligibleIds.includes(id)),
    });
  },
);

// ===========================================================================
// TEST LOGIN
// ===========================================================================

const testLoginBodySchema = z.object({
  requestKey: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/).optional(),
}).strict().default({});
type TestLoginSchemas = { params: typeof idParamsSchema; body: typeof testLoginBodySchema };

// ---------------------------------------------------------------------------
// POST /portal-universities/:id/test-login
// ---------------------------------------------------------------------------
router.post(
  "/portal-universities/:id/test-login",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema, body: testLoginBodySchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<TestLoginSchemas>(req).params;
    const { requestKey: suppliedRequestKey } = getValidated<TestLoginSchemas>(req).body;
    const requestKey = suppliedRequestKey ?? randomUUID();

    const [uni] = await db
      .select()
      .from(portalUniversitiesTable)
      .where(and(eq(portalUniversitiesTable.id, id), isNull(portalUniversitiesTable.deletedAt)));

    if (!uni) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    try {
      const job = await enqueuePortalWorkerJob({
        kind: "test_login",
        portalUniversityId: id,
        requestKey,
        requestedBy: req.user!.id,
      });
      logAudit(req.user!.id, "queue_portal_test_login", "portal_university", id, {
        adapterKey: uni.adapterKey,
        requestKey,
        workerJobId: job.id,
        replay: job.replay,
      }, req.ip);
      res.status(202).json({
        accepted: true,
        jobId: job.id,
        requestKey,
        replay: job.replay,
        statusUrl: job.statusUrl,
      });
    } catch (error) {
      if (error instanceof PortalWorkerJobIdempotencyConflictError) {
        res.status(409).json({
          accepted: false,
          error: "PORTAL_WORKER_JOB_IDEMPOTENCY_CONFLICT",
        });
        return;
      }
      if (error instanceof PortalWorkerUnavailableError) {
        res.status(503).json({
          accepted: false,
          error: error.code,
        });
        return;
      }
      throw error;
    }
  },
);

// API clients poll this safe projection. Payloads, credentials and provider
// page content are intentionally absent from the response.
router.get(
  "/portal-worker-jobs/:id",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<IdSchemas>(req).params;
    const [job] = await db
      .select({
        id: portalWorkerJobsTable.id,
        jobKind: portalWorkerJobsTable.jobKind,
        portalUniversityId: portalWorkerJobsTable.portalUniversityId,
        requestKey: portalWorkerJobsTable.requestKey,
        status: portalWorkerJobsTable.status,
        attempts: portalWorkerJobsTable.attempts,
        maxAttempts: portalWorkerJobsTable.maxAttempts,
        lastErrorCode: portalWorkerJobsTable.lastErrorCode,
        result: portalWorkerJobsTable.result,
        createdAt: portalWorkerJobsTable.createdAt,
        updatedAt: portalWorkerJobsTable.updatedAt,
        finishedAt: portalWorkerJobsTable.finishedAt,
      })
      .from(portalWorkerJobsTable)
      .where(eq(portalWorkerJobsTable.id, id))
      .limit(1);
    if (!job) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.json(job);
  },
);

// ===========================================================================
// PROGRAM MAPPING
// ===========================================================================

const uniKeyParamsSchema = z.object({ universityKey: z.string().min(1) });
type UniKeySchemas = { params: typeof uniKeyParamsSchema };

// ---------------------------------------------------------------------------
// GET /portal-program-mapping/:universityKey
// ---------------------------------------------------------------------------
router.get(
  "/portal-program-mapping/:universityKey",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema }),
  async (req, res): Promise<void> => {
    const { universityKey } = getValidated<UniKeySchemas>(req).params;

    const [row] = await db
      .select()
      .from(portalProgramMappingTable)
      .where(eq(portalProgramMappingTable.universityKey, universityKey));

    if (!row) {
      res.json({
        universityKey,
        mappings:         {},
        programOverrides: {},
        synonyms:         [],
        countryOverrides: {},
        id: null, createdAt: null, updatedAt: null,
      });
      return;
    }

    res.json(row);
  },
);

// ---------------------------------------------------------------------------
// PUT /portal-program-mapping/:universityKey
//
// Write access is TIGHTER than read: only super_admin / admin / manager
// (ADMIN_ROLES) may edit the matching data — it directly affects automated
// portal submissions. Read stays STAFF+ADMIN for visibility.
//
// All matching-data fields are optional; the matcher merges whatever is stored
// OVER the adapter's built-in code defaults (DB wins). Empty = no change.
// ---------------------------------------------------------------------------
const putMappingBodySchema = z.object({
  mappings:         z.record(z.string()).optional(),
  programOverrides: z.record(z.string()).optional(),
  synonyms:         z.array(z.array(z.string().min(1)).min(2)).optional(),
  countryOverrides: z.record(z.string()).optional(),
});
type PutMappingSchemas = { params: typeof uniKeyParamsSchema; body: typeof putMappingBodySchema };

router.put(
  "/portal-program-mapping/:universityKey",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema, body: putMappingBodySchema }),
  async (req, res): Promise<void> => {
    const { universityKey } = getValidated<PutMappingSchemas>(req).params;
    const body              = getValidated<PutMappingSchemas>(req).body;
    const user = req.user!;

    const [existing] = await db
      .select()
      .from(portalProgramMappingTable)
      .where(eq(portalProgramMappingTable.universityKey, universityKey));

    // Only overwrite the fields actually present in the request body so a
    // partial PUT (e.g. just synonyms) never wipes the other columns.
    const next = {
      mappings:         body.mappings         ?? existing?.mappings         ?? {},
      programOverrides: body.programOverrides ?? existing?.programOverrides ?? {},
      synonyms:         body.synonyms         ?? existing?.synonyms         ?? [],
      countryOverrides: body.countryOverrides ?? existing?.countryOverrides ?? {},
    };

    const row = await db.transaction(async (tx) => {
      const affected = await tx
        .select({ adapterKey: portalUniversitiesTable.adapterKey })
        .from(portalUniversitiesTable)
        .where(
          universityKey === GENERAL_MAPPING_KEY
            ? isNull(portalUniversitiesTable.deletedAt)
            : and(
                or(
                  eq(portalUniversitiesTable.universityKey, universityKey),
                  eq(portalUniversitiesTable.adapterKey, universityKey),
                ),
                isNull(portalUniversitiesTable.deletedAt),
              ),
        );
      for (const adapterKey of new Set(affected.map((partner) => partner.adapterKey))) {
        await resetPortalAdapterExecutionStateTx(
          tx,
          adapterKey,
          "PORTAL_PROGRAM_MAPPING_CHANGED_REVIEW_REQUIRED",
        );
      }

      if (existing) {
        return (await tx
          .update(portalProgramMappingTable)
          .set({ ...next, updatedAt: new Date() })
          .where(eq(portalProgramMappingTable.id, existing.id))
          .returning())[0];
      }
      return (await tx
        .insert(portalProgramMappingTable)
        .values({ universityKey, ...next })
        .returning())[0];
    });

    logAudit(
      user.id,
      "update_portal_program_mapping",
      "portal_program_mapping",
      row.id,
      {
        universityKey,
        mappings:         Object.keys(next.mappings).length,
        programOverrides: Object.keys(next.programOverrides).length,
        synonyms:         next.synonyms.length,
        countryOverrides: Object.keys(next.countryOverrides).length,
      },
      req.ip,
    );

    res.json(row);
  },
);

// ---------------------------------------------------------------------------
// POST /portal-program-mapping/migrate-ids-to-names
//
// One-shot, IDEMPOTENT backfill: converts every row's legacy
// programOverrides { crmProgramId → portalValue } into name-based
// mappings { portalValue → crmProgramName } by looking up the CRM program name.
//
//   - Never clobbers an existing mappings[portalValue] entry (panel edits win).
//   - Never deletes programOverrides (kept as a historical column / rollback).
//   - Skips overrides whose crmProgramId no longer exists in the programs table
//     (reported in `missingProgramIds`).
//
// Safe to run repeatedly: a second run adds nothing (all keys already present).
// ADMIN-only, mirrors the PUT write gate.
// ---------------------------------------------------------------------------
router.post(
  "/portal-program-mapping/migrate-ids-to-names",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const user = req.user!;

    const rows = await db.select().from(portalProgramMappingTable);

    // Gather every distinct crmProgramId referenced by any programOverrides map.
    const allIds = new Set<number>();
    for (const r of rows) {
      for (const idStr of Object.keys(r.programOverrides ?? {})) {
        const n = Number(idStr);
        if (Number.isInteger(n) && n > 0) allIds.add(n);
      }
    }

    // Resolve CRM program id → program name in one query.
    const idToName = new Map<number, string>();
    if (allIds.size > 0) {
      const progs = await db
        .select({ id: programsTable.id, name: programsTable.name })
        .from(programsTable)
        .where(inArray(programsTable.id, [...allIds]));
      for (const p of progs) idToName.set(p.id, p.name);
    }

    let rowsScanned = 0;
    let rowsUpdated = 0;
    let mappingsAdded = 0;
    const missingProgramIds = new Set<number>();

    for (const r of rows) {
      rowsScanned++;
      const overrides = r.programOverrides ?? {};
      if (Object.keys(overrides).length === 0) continue;

      const nextMappings: Record<string, string> = { ...(r.mappings ?? {}) };
      let changed = false;

      for (const [idStr, portalValue] of Object.entries(overrides)) {
        if (!portalValue) continue;
        const n = Number(idStr);
        const crmName = Number.isInteger(n) ? idToName.get(n) : undefined;
        if (!crmName) {
          if (Number.isInteger(n)) missingProgramIds.add(n);
          continue;
        }
        // Portal option value/label is the key of the name map; do not clobber
        // an existing (panel-authored) entry.
        if (nextMappings[portalValue] === undefined) {
          nextMappings[portalValue] = crmName;
          mappingsAdded++;
          changed = true;
        }
      }

      if (changed) {
        await db
          .update(portalProgramMappingTable)
          .set({ mappings: nextMappings, updatedAt: new Date() })
          .where(eq(portalProgramMappingTable.id, r.id));
        rowsUpdated++;
      }
    }

    logAudit(
      user.id,
      "migrate_portal_program_mapping_ids_to_names",
      "portal_program_mapping",
      undefined,
      { rowsScanned, rowsUpdated, mappingsAdded, missingProgramIds: missingProgramIds.size },
      req.ip,
    );

    res.json({
      rowsScanned,
      rowsUpdated,
      mappingsAdded,
      missingProgramIds: [...missingProgramIds],
    });
  },
);

// ===========================================================================
// PORTAL ADAPTERS (DB-stored declarative configs)
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /portal-adapters — registry metadata + DB-stored adapters
// ---------------------------------------------------------------------------
router.get(
  "/portal-adapters",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    // Registry (code + declarative from declarativeConfigs.ts) — read-only
    // hasCredentials: DB-first by adapterKey (canonical), then env fallback.
    const dbCredKeys = await batchPortalCredentialKeys();
    // Auto-graduation: live success counts for statically-experimental keys —
    // an adapter with >= GRADUATION_THRESHOLD durable success proofs is no
    // longer experimental (one GROUP BY query, no N+1).
    const staticMeta = adapterMetadata();
    const staticExperimentalKeys = staticMeta
      .filter((m) => m.experimental)
      .map((m) => m.key);
    const successCounts = await getSuccessCounts(staticExperimentalKeys);

    const registry = staticMeta.map(({ key, label, family, experimental, portalUrl }) => {
      const K = key.toUpperCase().replace(/-/g, "_");
      const envHas = !!(
        (process.env[`${K}_EMAIL`] || process.env[`${K}_USER`]) &&
        process.env[`${K}_PASSWORD`]
      );
      const hasCredentials = dbCredKeys.has(key) || envHas;
      const kind: "declarative" | "code" = family === "declarative" ? "declarative" : "code";
      const successCount = experimental ? (successCounts.get(key) ?? 0) : null;
      const graduated = experimental ? successCount! >= GRADUATION_THRESHOLD : null;
      return {
        key,
        label,
        family,
        kind,
        // Dynamic: static family flag AND not yet graduated by live successes.
        experimental: experimental && !graduated,
        staticExperimental: experimental,
        successCount,
        graduationThreshold: experimental ? GRADUATION_THRESHOLD : null,
        graduated,
        portalUrl: safePortalUrl(portalUrl),
        hasCredentials,
      };
    });

    // DB-stored adapters — manageable via UI
    const dbAdapters = await db
      .select()
      .from(portalAdaptersTable)
      .where(isNull(portalAdaptersTable.deletedAt))
      .orderBy(asc(portalAdaptersTable.key));

    res.json({ registry, db: dbAdapters });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-adapters
// ---------------------------------------------------------------------------
const createAdapterBodySchema = z.object({
  key:        z.string().min(1).regex(/^[a-z0-9_-]+$/, "Only lowercase letters, digits, underscores and hyphens"),
  label:      z.string().min(1),
  baseUrl:    z.string().min(1),
  matchNames: z.string().min(1),
  kind:       z.enum(["declarative", "code"]).optional(),
  configJson: z.record(z.unknown()).optional(),
  isActive:   z.boolean().optional(),
});
type CreateAdapterSchemas = { body: typeof createAdapterBodySchema };

router.post(
  "/portal-adapters",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: createAdapterBodySchema }),
  async (req, res): Promise<void> => {
    const body = getValidated<CreateAdapterSchemas>(req).body;
    const user = req.user!;

    const [dup] = await db
      .select({ id: portalAdaptersTable.id })
      .from(portalAdaptersTable)
      .where(eq(portalAdaptersTable.key, body.key))
      .limit(1);

    if (dup) {
      res.status(409).json({
        error: "DUPLICATE_KEY",
        message: `Adapter key '${body.key}' already exists`,
      });
      return;
    }

    const [row] = await db
      .insert(portalAdaptersTable)
      .values({
        key:        body.key,
        label:      body.label,
        baseUrl:    body.baseUrl,
        matchNames: body.matchNames,
        kind:       body.kind ?? "declarative",
        configJson: body.configJson ?? null,
        isActive:   body.isActive ?? true,
      })
      .returning();

    logAudit(user.id, "create_portal_adapter", "portal_adapter", row.id, { key: row.key }, req.ip);

    // Refresh the declarative-adapter resolution cache so the new adapter is
    // usable immediately (without waiting for the TTL or a process restart).
    invalidateDeclarativeAdapterCache();

    res.status(201).json(row);
  },
);

// ---------------------------------------------------------------------------
// PATCH /portal-adapters/:id
// ---------------------------------------------------------------------------
const updateAdapterBodySchema = z.object({
  label:      z.string().min(1).optional(),
  baseUrl:    z.string().min(1).optional(),
  matchNames: z.string().min(1).optional(),
  kind:       z.enum(["declarative", "code"]).optional(),
  configJson: z.record(z.unknown()).nullable().optional(),
  isActive:   z.boolean().optional(),
}).strict();
type UpdateAdapterSchemas = { params: typeof idParamsSchema; body: typeof updateAdapterBodySchema };

router.patch(
  "/portal-adapters/:id",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema, body: updateAdapterBodySchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<UpdateAdapterSchemas>(req).params;
    const body   = getValidated<UpdateAdapterSchemas>(req).body;
    const user   = req.user!;

    const [row] = await db
      .select({ id: portalAdaptersTable.id, key: portalAdaptersTable.key })
      .from(portalAdaptersTable)
      .where(and(eq(portalAdaptersTable.id, id), isNull(portalAdaptersTable.deletedAt)));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    const patch: Partial<typeof portalAdaptersTable.$inferInsert> = { updatedAt: new Date() };
    if (body.label      !== undefined) patch.label      = body.label;
    if (body.baseUrl    !== undefined) patch.baseUrl    = body.baseUrl;
    if (body.matchNames !== undefined) patch.matchNames = body.matchNames;
    if (body.kind       !== undefined) patch.kind       = body.kind;
    if ("configJson" in body)          patch.configJson = body.configJson ?? null;
    if (body.isActive   !== undefined) patch.isActive   = body.isActive;

    const updated = await db.transaction(async (tx) => {
      await resetPortalAdapterExecutionStateTx(
        tx,
        row.key,
        "ADAPTER_CONFIGURATION_CHANGED_REVIEW_REQUIRED",
      );
      return (await tx
        .update(portalAdaptersTable)
        .set(patch)
        .where(eq(portalAdaptersTable.id, id))
        .returning())[0];
    });

    logAudit(user.id, "update_portal_adapter", "portal_adapter", id, body, req.ip);

    invalidateDeclarativeAdapterCache();

    res.json(updated);
  },
);

// ---------------------------------------------------------------------------
// DELETE /portal-adapters/:id  (soft-delete)
// ---------------------------------------------------------------------------
router.delete(
  "/portal-adapters/:id",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<IdSchemas>(req).params;
    const user   = req.user!;

    const [row] = await db
      .select({ id: portalAdaptersTable.id, key: portalAdaptersTable.key })
      .from(portalAdaptersTable)
      .where(and(eq(portalAdaptersTable.id, id), isNull(portalAdaptersTable.deletedAt)));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    await db.transaction(async (tx) => {
      await resetPortalAdapterExecutionStateTx(
        tx,
        row.key,
        "ADAPTER_CONFIGURATION_CHANGED_REVIEW_REQUIRED",
      );
      await tx
        .update(portalAdaptersTable)
        .set({ deletedAt: new Date() })
        .where(eq(portalAdaptersTable.id, id));
    });

    logAudit(user.id, "delete_portal_adapter", "portal_adapter", id, {}, req.ip);

    invalidateDeclarativeAdapterCache();

    res.json({ ok: true });
  },
);

// ===========================================================================
// PORTAL CREDENTIALS  (admin / super_admin only — NEVER expose plaintext)
// ===========================================================================

const credentialsBodySchema = z.object({
  username: z.string().min(1, "username required"),
  password: z.string().min(1, "password required"),
  extra: z.record(z.unknown()).optional(),
});
type CredentialsBodySchemas = { body: typeof credentialsBodySchema };

// ---------------------------------------------------------------------------
// PUT /portal-universities/:portalKey/credentials
// Upsert encrypted credentials for a portal university.
// Response: { ok: true } — plaintext is NEVER returned.
// ---------------------------------------------------------------------------
router.put(
  "/portal-universities/:portalKey/credentials",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: portalKeyParamsSchema, body: credentialsBodySchema }),
  async (req, res): Promise<void> => {
    const { portalKey } = getValidated<PortalKeySchemas>(req).params;
    const { username, password, extra } = getValidated<CredentialsBodySchemas>(req).body;

    // Verify the portalKey belongs to a configured portal_universities row.
    // New partners are intentionally inactive while credentials are entered.
    // Select adapterKey too — credentials are stored under adapterKey (canonical).
    const [uni] = await db
      .select({ id: portalUniversitiesTable.id, adapterKey: portalUniversitiesTable.adapterKey })
      .from(portalUniversitiesTable)
      .where(
        and(
          eq(portalUniversitiesTable.universityKey, portalKey),
          isNull(portalUniversitiesTable.deletedAt),
        ),
      )
      .limit(1);

    if (!uni) {
      res.status(404).json({ error: "NOT_FOUND", message: `Portal university "${portalKey}" not found` });
      return;
    }

    // Store under adapterKey (canonical) so all adapter surfaces resolve correctly.
    const storageKey = uni.adapterKey;

    // setPortalCredentials handles encryption + manual upsert.
    // The unique index is (organizationId, portalKey); since orgId is null for
    // management-plane credentials, onConflictDoUpdate can't be used directly
    // (PostgreSQL won't raise a conflict when a composite key contains NULL).
    let safetyReset;
    try {
      safetyReset = await db.transaction(async (tx) => {
        const reset = await resetPortalCredentialExecutionStateTx(tx, storageKey);
        await setPortalCredentials(null, storageKey, { username, password, extra }, tx);
        return reset;
      });
    } catch (error) {
      if (error instanceof PortalCredentialsInFlightError) {
        res.status(409).json({
          error: "CREDENTIAL_CHANGE_IN_FLIGHT",
          message: "Wait for running submissions to finish before changing credentials.",
          runningCount: error.runningCount,
        });
        return;
      }
      throw error;
    }

    logAudit(
      req.user!.id,
      "upsert_portal_credentials",
      "portal_credentials",
      uni.id,
      { portalKey, storageKey, safetyReset },
      req.ip,
    );

    res.json({ ok: true, safetyReset });
  },
);

// ---------------------------------------------------------------------------
// DELETE /portal-universities/:portalKey/credentials
// Soft-deletes the stored credentials for a portal university.
// ---------------------------------------------------------------------------
router.delete(
  "/portal-universities/:portalKey/credentials",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: portalKeyParamsSchema }),
  async (req, res): Promise<void> => {
    const { portalKey } = getValidated<PortalKeySchemas>(req).params;

    // Look up the university to get its adapterKey (canonical storage key).
    const [uni] = await db
      .select({ id: portalUniversitiesTable.id, adapterKey: portalUniversitiesTable.adapterKey })
      .from(portalUniversitiesTable)
      .where(and(eq(portalUniversitiesTable.universityKey, portalKey), isNull(portalUniversitiesTable.deletedAt)))
      .limit(1);

    const storageKey = uni?.adapterKey ?? portalKey;

    let mutation;
    try {
      mutation = await db.transaction(async (tx) => {
        // Delete by adapterKey (canonical) OR universityKey (backward compat).
        const result = await tx
          .update(portalCredentialsTable)
          .set({ deletedAt: new Date() })
          .where(
            and(
              or(
                eq(portalCredentialsTable.portalKey, storageKey),
                eq(portalCredentialsTable.portalKey, portalKey),
              ),
              isNull(portalCredentialsTable.deletedAt),
            ),
          )
          .returning({ id: portalCredentialsTable.id });

        if (!result.length) return { ok: false as const };

        const safetyReset = await resetPortalCredentialExecutionStateTx(tx, storageKey);

        return {
          ok: true as const,
          credentialId: result[0].id,
          safetyReset,
        };
      });
    } catch (error) {
      if (error instanceof PortalCredentialsInFlightError) {
        res.status(409).json({
          error: "CREDENTIAL_CHANGE_IN_FLIGHT",
          message: "Wait for running submissions to finish before removing credentials.",
          runningCount: error.runningCount,
        });
        return;
      }
      throw error;
    }

    if (!mutation.ok) {
      res.status(404).json({ error: "NOT_FOUND", message: "No active credentials found for this portal key" });
      return;
    }

    logAudit(
      req.user!.id,
      "delete_portal_credentials",
      "portal_credentials",
      mutation.credentialId,
      { portalKey, storageKey, safetyReset: mutation.safetyReset },
      req.ip,
    );

    res.json({ ok: true, safetyReset: mutation.safetyReset });
  },
);

export default router;
