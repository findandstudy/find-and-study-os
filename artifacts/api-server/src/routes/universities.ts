import { Router, type IRouter } from "express";
import { db, pool, universitiesTable, programsTable, programTranslationsTable, applicationsTable, pipelineStagesTable, programDocumentRequirementsTable } from "@workspace/db";
import { eq, ilike, sql, and, or, inArray, isNull, getTableColumns } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { MANAGER_ROLES, STAFF_ROLES } from "../lib/roles";
import { getCurrentSeason } from "../lib/season";
import { sanitizeCourseFinderProgram } from "../lib/courseFinderVisibility";
import {
  PROGRAM_TARGET_LOCALES,
  isProgramTargetLocale,
  normalizeProgramLocale,
  normalizeProgramSourceContent,
  parseProgramTranslation,
} from "../lib/programTranslationContract";
import {
  requeueAllFailedProgramTranslations,
  requeueProgramTranslations,
} from "../lib/programTranslationQueue";

const router: IRouter = Router();

const UNI_PATCH_FIELDS = [
  "name", "country", "city", "website", "logoUrl", "description", "ranking", "isActive",
  "universityType", "taxType", "taxPercent", "qsRanking", "timesRanking", "shanghaiRanking",
  "cwtsLeidenRanking", "address", "onlinePaymentUrl", "cricosLink", "documentsLink",
  "currentFeeListLink", "initialDepositOptions", "admissionProcess",
  "contactPersonName", "contactPersonPhone", "contactPersonEmail", "status",
  "assignedStaffIds",
];

const CONTACT_FIELDS = ["contactPersonName", "contactPersonPhone", "contactPersonEmail"];
// Internal fields that must never leak through unauthenticated /universities
// endpoints. assignedStaffIds is the per-university notification recipient
// list — exposing it would reveal internal user-id assignments publicly.
const INTERNAL_FIELDS = ["assignedStaffIds"];
const PROG_PATCH_FIELDS = [
  "universityId", "name", "description", "degree", "field", "language", "duration",
  "tuitionFee", "currency", "scholarship", "intakes", "requirements",
  "commissionRate", "applicationFee", "advancedFee", "depositFee",
  "serviceFeeAmount", "discountedFee", "languageFee", "feeType",
  "minGpa", "minLanguageScore", "quota", "isActive",
];

/* ─── UNIVERSITIES ───────────────────────────────────────────── */

function maskContacts(uni: Record<string, any>, userRole?: string): Record<string, any> {
  // Always strip internal fields from any response that flows through
  // maskContacts (the public /universities + /universities/:id endpoints
  // call this). Authenticated callers that need the field must read it
  // directly from the row inside protected handlers.
  const masked = { ...uni };
  for (const f of INTERNAL_FIELDS) {
    delete masked[f];
  }
  if (userRole === "super_admin") return masked;
  for (const f of CONTACT_FIELDS) {
    delete masked[f];
  }
  return masked;
}

router.get("/universities/countries", async (_req, res): Promise<void> => {
  const rows = await db
    .selectDistinct({ country: universitiesTable.country })
    .from(universitiesTable)
    .orderBy(universitiesTable.country);
  res.json(rows.map(r => r.country).filter(Boolean));
});

router.get("/universities/cities", async (_req, res): Promise<void> => {
  const rows = await db
    .selectDistinct({ city: universitiesTable.city })
    .from(universitiesTable)
    .orderBy(universitiesTable.city);
  res.json(rows.map(r => r.city).filter(Boolean));
});

router.get("/universities", async (req, res): Promise<void> => {
  const { country, city, type, status, qs, search, name, page = "1", limit = "20", summary } = req.query as Record<string, string>;
  const safeInt = (v: string, fallback: number) => /^\d+$/.test(v) ? parseInt(v, 10) : fallback;
  const pageNum = Math.max(1, safeInt(page, 1));
  const limitNum = Math.min(100, Math.max(1, safeInt(limit, 20)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (country) conditions.push(ilike(universitiesTable.country, `%${country}%`));
  if (city) conditions.push(ilike(universitiesTable.city, `%${city}%`));
  if (type) conditions.push(ilike(universitiesTable.universityType, type));
  if (status) conditions.push(ilike(universitiesTable.status, status));
  if (search) conditions.push(ilike(universitiesTable.name, `%${search}%`));
  if (name) conditions.push(ilike(universitiesTable.name, `%${name}%`));
  if (qs && /^\d+$/.test(qs)) {
    conditions.push(eq(universitiesTable.qsRanking, parseInt(qs, 10)));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const countQuery = db.select({ count: sql<number>`count(*)` }).from(universitiesTable).where(where);
  const rowsQuery = summary === "1"
    ? db.select({
        id: universitiesTable.id,
        name: universitiesTable.name,
        country: universitiesTable.country,
        city: universitiesTable.city,
        website: universitiesTable.website,
        universityType: universitiesTable.universityType,
        qsRanking: universitiesTable.qsRanking,
        status: universitiesTable.status,
        isActive: universitiesTable.isActive,
        hasLogo: sql<boolean>`${universitiesTable.logoUrl} IS NOT NULL
          AND length(trim(${universitiesTable.logoUrl})) > 0`.as("has_logo"),
      }).from(universitiesTable).where(where).limit(limitNum).offset(offset).orderBy(universitiesTable.name)
    : db.select().from(universitiesTable).where(where).limit(limitNum).offset(offset).orderBy(universitiesTable.name);
  const [[{ count }], rows] = await Promise.all([countQuery, rowsQuery]);
  const userRole = (req as any).user?.role;
  const data = rows.map(u => {
    const masked = maskContacts(u as any, userRole);
    if (summary === "1") {
      masked.logoUrl = masked.hasLogo ? `/api/universities/${masked.id}/logo` : null;
      delete masked.hasLogo;
    }
    return masked;
  });

  res.json({ data, meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
});

router.get("/universities/options", requireAuth, async (_req, res): Promise<void> => {
  try {
    const data = await db
      .select({
        id: universitiesTable.id,
        name: universitiesTable.name,
      })
      .from(universitiesTable)
      .orderBy(universitiesTable.name);
    res.json({ data });
  } catch (error) {
    console.error("Get university options error:", error);
    res.status(500).json({ error: "Failed to get university options" });
  }
});

router.get("/universities/:id/logo", async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [uni] = await db.select({ logoUrl: universitiesTable.logoUrl })
    .from(universitiesTable)
    .where(eq(universitiesTable.id, id));
  const logoUrl = uni?.logoUrl?.trim();
  if (!logoUrl) { res.status(404).json({ error: "University logo not found" }); return; }

  const dataUrl = logoUrl.match(/^data:(image\/(?:png|jpe?g|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (dataUrl) {
    res.setHeader("Content-Type", dataUrl[1].toLowerCase());
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.send(Buffer.from(dataUrl[2].replace(/\s/g, ""), "base64"));
    return;
  }

  if (/^https?:\/\//i.test(logoUrl) || logoUrl.startsWith("/")) {
    res.redirect(302, logoUrl);
    return;
  }

  res.status(404).json({ error: "University logo is not available" });
});

router.post("/universities", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const {
    name, country, city, website, logoUrl, description, ranking, isActive = true,
    universityType, taxType, taxPercent, qsRanking, timesRanking, shanghaiRanking,
    cwtsLeidenRanking, address, onlinePaymentUrl, cricosLink, documentsLink,
    currentFeeListLink, initialDepositOptions, admissionProcess,
    contactPersonName, contactPersonPhone, contactPersonEmail, status = "open",
  } = req.body;
  if (!name || !country) { res.status(400).json({ error: "name and country are required" }); return; }
  const [uni] = await db.insert(universitiesTable).values({
    name, country, city: city || null, website: website || null, logoUrl: logoUrl || null,
    description: description || null, ranking: ranking ? Number(ranking) : null, isActive,
    universityType: universityType || null, taxType: taxType || null,
    taxPercent: taxPercent ? Number(taxPercent) : null,
    qsRanking: qsRanking ? Number(qsRanking) : null,
    timesRanking: timesRanking ? Number(timesRanking) : null,
    shanghaiRanking: shanghaiRanking ? Number(shanghaiRanking) : null,
    cwtsLeidenRanking: cwtsLeidenRanking ? Number(cwtsLeidenRanking) : null,
    address: address || null, onlinePaymentUrl: onlinePaymentUrl || null,
    cricosLink: cricosLink || null, documentsLink: documentsLink || null,
    currentFeeListLink: currentFeeListLink || null,
    initialDepositOptions: initialDepositOptions || null,
    admissionProcess: admissionProcess || null,
    contactPersonName: contactPersonName || null,
    contactPersonPhone: contactPersonPhone || null,
    contactPersonEmail: contactPersonEmail || null,
    status,
  }).returning();
  await logAudit(req.user!.id, "create_university", "university", uni.id, { name, country }, req.ip);
  res.status(201).json(uni);
});

router.get("/universities/:id", async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [uni] = await db.select().from(universitiesTable).where(eq(universitiesTable.id, id));
  if (!uni) { res.status(404).json({ error: "University not found" }); return; }
  const userRole = (req as any).user?.role;
  res.json(maskContacts(uni as any, userRole));
});

// Protected read of internal per-university assigned staff IDs.
// Public /universities responses mask this field, so admin UIs use
// this endpoint to prefill the assignment editor.
router.get("/universities/:id/assigned-staff", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [uni] = await db.select({ assignedStaffIds: universitiesTable.assignedStaffIds })
    .from(universitiesTable).where(eq(universitiesTable.id, id));
  if (!uni) { res.status(404).json({ error: "University not found" }); return; }
  res.json({ assignedStaffIds: Array.isArray(uni.assignedStaffIds) ? uni.assignedStaffIds : [] });
});

router.patch("/universities/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const updates: Record<string, unknown> = {};
  for (const key of UNI_PATCH_FIELDS) {
    if (req.body[key] === undefined) continue;
    if (key === "assignedStaffIds") {
      const raw = req.body[key];
      if (!Array.isArray(raw) || !raw.every((v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0)) {
        res.status(400).json({ error: "assignedStaffIds must be an array of positive integers" });
        return;
      }
      updates[key] = Array.from(new Set(raw as number[]));
    } else {
      updates[key] = req.body[key];
    }
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No valid fields" }); return; }
  const [uni] = await db.update(universitiesTable).set(updates).where(eq(universitiesTable.id, id)).returning();
  if (!uni) { res.status(404).json({ error: "University not found" }); return; }
  await logAudit(req.user!.id, "update_university", "university", id, updates, req.ip);
  res.json(uni);
});

router.delete("/universities/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(universitiesTable).where(eq(universitiesTable.id, id));
  await logAudit(req.user!.id, "delete_university", "university", id, {}, req.ip);
  res.sendStatus(204);
});

/* ─── PROGRAMS ───────────────────────────────────────────────── */

type TranslationSummaryRow = {
  program_id: number;
  total: number;
  published: number;
  pending: number;
  failed: number;
  manual: number;
};

async function loadTranslationSummaries(programIds: number[]): Promise<Map<number, {
  total: number;
  published: number;
  pending: number;
  failed: number;
  manual: number;
  target: number;
}>> {
  if (programIds.length === 0) return new Map();
  const result = await pool.query<TranslationSummaryRow>(`
    SELECT program_id,
           count(*)::int AS total,
           count(*) FILTER (WHERE status = 'published')::int AS published,
           count(*) FILTER (WHERE status IN ('queued','processing','retrying','stale_manual'))::int AS pending,
           count(*) FILTER (WHERE status = 'failed')::int AS failed,
           count(*) FILTER (WHERE is_manual)::int AS manual
      FROM program_translations
     WHERE program_id = ANY($1::int[])
     GROUP BY program_id
  `, [programIds]);
  return new Map(result.rows.map((row) => [row.program_id, {
    total: Number(row.total),
    published: Number(row.published),
    pending: Number(row.pending),
    failed: Number(row.failed),
    manual: Number(row.manual),
    target: PROGRAM_TARGET_LOCALES.length,
  }]));
}

router.get("/programs", async (req, res): Promise<void> => {
  const { universityId, language, search, name, degree, field, page = "1", limit = "20" } = req.query as Record<string, string>;
  const locale = normalizeProgramLocale(req.query.locale);
  const localized = locale !== "en";
  const safeInt = (v: string, fallback: number) => /^\d+$/.test(v) ? parseInt(v, 10) : fallback;
  const pageNum = Math.max(1, safeInt(page, 1));
  const limitNum = Math.min(100, Math.max(1, safeInt(limit, 20)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (universityId && /^\d+$/.test(universityId)) conditions.push(eq(programsTable.universityId, parseInt(universityId, 10)));
  if (language) conditions.push(ilike(programsTable.language, language));
  if (search) conditions.push(localized
    ? or(ilike(programsTable.name, `%${search}%`), ilike(programTranslationsTable.name, `%${search}%`))!
    : ilike(programsTable.name, `%${search}%`));
  if (name) conditions.push(localized
    ? or(ilike(programsTable.name, `%${name}%`), ilike(programTranslationsTable.name, `%${name}%`))!
    : ilike(programsTable.name, `%${name}%`));
  if (degree) conditions.push(ilike(programsTable.degree, degree));
  if (field) conditions.push(ilike(programsTable.field, field));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const translationJoin = and(
    eq(programTranslationsTable.programId, programsTable.id),
    eq(programTranslationsTable.locale, locale),
    eq(programTranslationsTable.status, "published"),
  );
  const [{ count }] = await db.select({ count: sql<number>`count(*)` })
    .from(programsTable)
    .leftJoin(programTranslationsTable, translationJoin)
    .where(where);
  const rows = await db
    .select({
      ...getTableColumns(programsTable),
      name: sql<string>`coalesce(${programTranslationsTable.name}, ${programsTable.name})`,
      description: sql<string | null>`coalesce(${programTranslationsTable.description}, ${programsTable.description})`,
      field: sql<string | null>`coalesce(${programTranslationsTable.field}, ${programsTable.field})`,
      duration: sql<string | null>`coalesce(${programTranslationsTable.duration}, ${programsTable.duration})`,
      intakes: sql<string | null>`coalesce(${programTranslationsTable.intakes}, ${programsTable.intakes})`,
      requirements: sql<string | null>`coalesce(${programTranslationsTable.requirements}, ${programsTable.requirements})`,
      translatedLocale: programTranslationsTable.locale,
      universityName: universitiesTable.name,
    })
    .from(programsTable)
    .leftJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .leftJoin(programTranslationsTable, translationJoin)
    .where(where)
    .limit(limitNum)
    .offset(offset)
    .orderBy(programsTable.name);

  // This legacy endpoint is used by both authenticated back-office screens and
  // anonymous catalogue consumers. Never expose commercial fields to callers
  // without an authenticated session; protected staff/agent screens retain the
  // existing response contract.
  const visibleRows: any[] = req.user
    ? rows
    : rows.map((row) => sanitizeCourseFinderProgram(row, {
        contacts: false,
        internalFees: false,
        serviceFee: false,
      }));

  let data: any[] = visibleRows.map((row) => ({
    ...row,
    contentLocale: row.translatedLocale || "en",
    fallbackUsed: localized && !row.translatedLocale,
    translatedLocale: undefined,
  }));
  if (rows.length > 0) {
    const ids = rows.map(r => r.id);
    const reqs = await db.select().from(programDocumentRequirementsTable)
      .where(inArray(programDocumentRequirementsTable.programId, ids))
      .orderBy(programDocumentRequirementsTable.sortOrder);
    const grouped = new Map<number, { documentType: string; mandatory: boolean; sortOrder: number }[]>();
    for (const r of reqs) {
      const arr = grouped.get(r.programId) || [];
      arr.push({ documentType: r.documentType, mandatory: r.mandatory, sortOrder: r.sortOrder });
      grouped.set(r.programId, arr);
    }
    data = data.map(r => ({ ...r, documentRequirements: grouped.get(r.id) || [] }));
  }

  if (req.user && rows.length > 0) {
    const summaries = await loadTranslationSummaries(rows.map((row) => row.id));
    data = data.map((row) => ({
      ...row,
      translationSummary: summaries.get(row.id) || {
        total: 0, published: 0, pending: 0, failed: 0, manual: 0,
        target: PROGRAM_TARGET_LOCALES.length,
      },
    }));
  }

  res.json({ data, meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
});

router.post("/programs", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const {
    universityId, name, description, degree, field, language, duration,
    tuitionFee, currency = "USD", scholarship, intakes, requirements, commissionRate,
    applicationFee, advancedFee, depositFee, serviceFeeAmount, discountedFee, languageFee,
    feeType, minGpa, minLanguageScore, quota, isActive = true,
  } = req.body;
  if (!universityId || !name) { res.status(400).json({ error: "universityId and name are required" }); return; }
  const n = (v: any) => (v !== undefined && v !== "" && v !== null ? Number(v) : null);
  let quotaVal: number | null = null;
  if (quota !== undefined && quota !== "" && quota !== null) {
    const qv = Math.round(Number(quota));
    if (isNaN(qv) || qv < 1) { res.status(400).json({ error: "quota must be a positive integer (>= 1) or empty" }); return; }
    quotaVal = qv;
  }
  const [prog] = await db.insert(programsTable).values({
    universityId: Number(universityId), name, description: description || null, degree: degree || null, field: field || null,
    language: language || null, duration: duration || null,
    tuitionFee: n(tuitionFee), currency,
    scholarship: n(scholarship),
    intakes: intakes || null, requirements: requirements || null,
    commissionRate: n(commissionRate),
    applicationFee: n(applicationFee),
    advancedFee: n(advancedFee),
    depositFee: n(depositFee),
    serviceFeeAmount: n(serviceFeeAmount),
    discountedFee: n(discountedFee),
    languageFee: n(languageFee),
    feeType: feeType || null,
    minGpa: n(minGpa),
    minLanguageScore: n(minLanguageScore),
    quota: quotaVal,
    isActive,
  }).returning();
  await logAudit(req.user!.id, "create_program", "program", prog.id, { universityId, name }, req.ip);
  res.status(201).json(prog);
});

router.get("/programs/enrolled-counts", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const seasonParam = typeof req.query.season === "string" && req.query.season ? req.query.season : null;
  const season = seasonParam ?? await getCurrentSeason();
  const wonStages = await db.select({ key: pipelineStagesTable.key })
    .from(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.entityType, "application"), eq(pipelineStagesTable.variant, "won")));
  const wonKeys = wonStages.map(s => s.key);
  if (wonKeys.length === 0) { res.json({}); return; }
  const rows = await db.select({
    programId: applicationsTable.programId,
    count: sql<number>`count(*)`,
  })
    .from(applicationsTable)
    .where(and(
      eq(applicationsTable.season, season),
      inArray(applicationsTable.stage, wonKeys),
      isNull(applicationsTable.deletedAt),
    ))
    .groupBy(applicationsTable.programId);
  const counts: Record<number, number> = {};
  for (const r of rows) {
    if (r.programId != null) counts[r.programId] = Number(r.count);
  }
  res.json(counts);
});

// Bulk status changes are intentionally handled in one database statement.
// Apart from being much faster than issuing one PATCH per row, this prevents a
// large selection from being left half-updated if the client disconnects.
// Keep this route above /programs/:id so "bulk-status" is never parsed as an id.
router.patch("/programs/bulk-status", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const rawIds = req.body?.ids;
  const isActive = req.body?.isActive;
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 5000) {
    res.status(400).json({ error: "ids must be a non-empty array with at most 5000 items" });
    return;
  }
  if (typeof isActive !== "boolean") {
    res.status(400).json({ error: "isActive must be a boolean" });
    return;
  }

  const ids = Array.from(new Set(rawIds));
  if (!ids.every((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) {
    res.status(400).json({ error: "ids must contain only positive integers" });
    return;
  }

  const updated = await db.update(programsTable)
    .set({ isActive })
    .where(inArray(programsTable.id, ids))
    .returning({ id: programsTable.id });

  await logAudit(
    req.user!.id,
    isActive ? "bulk_activate_programs" : "bulk_deactivate_programs",
    "program",
    undefined,
    {
      requestedCount: ids.length,
      updatedCount: updated.length,
      // Keep audit rows useful without storing thousands of ids.
      programIds: ids.slice(0, 100),
      truncated: ids.length > 100,
    },
    req.ip,
  );
  res.json({ updated: updated.length, ids: updated.map(row => row.id), isActive });
});

router.get("/programs/:id", async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const locale = normalizeProgramLocale(req.query.locale);
  const [prog] = await db.select({
    ...getTableColumns(programsTable),
    name: sql<string>`coalesce(${programTranslationsTable.name}, ${programsTable.name})`,
    description: sql<string | null>`coalesce(${programTranslationsTable.description}, ${programsTable.description})`,
    field: sql<string | null>`coalesce(${programTranslationsTable.field}, ${programsTable.field})`,
    duration: sql<string | null>`coalesce(${programTranslationsTable.duration}, ${programsTable.duration})`,
    intakes: sql<string | null>`coalesce(${programTranslationsTable.intakes}, ${programsTable.intakes})`,
    requirements: sql<string | null>`coalesce(${programTranslationsTable.requirements}, ${programsTable.requirements})`,
    translatedLocale: programTranslationsTable.locale,
  }).from(programsTable)
    .leftJoin(programTranslationsTable, and(
      eq(programTranslationsTable.programId, programsTable.id),
      eq(programTranslationsTable.locale, locale),
      eq(programTranslationsTable.status, "published"),
    ))
    .where(eq(programsTable.id, id));
  if (!prog) { res.status(404).json({ error: "Program not found" }); return; }
  const reqs = await db.select().from(programDocumentRequirementsTable)
    .where(eq(programDocumentRequirementsTable.programId, id))
    .orderBy(programDocumentRequirementsTable.sortOrder);
  const visibleProgram = req.user
    ? prog
    : sanitizeCourseFinderProgram(prog, {
        contacts: false,
        internalFees: false,
        serviceFee: false,
      });
  res.json({
    ...visibleProgram,
    contentLocale: prog.translatedLocale || "en",
    fallbackUsed: locale !== "en" && !prog.translatedLocale,
    translatedLocale: undefined,
    documentRequirements: reqs.map(r => ({ documentType: r.documentType, mandatory: r.mandatory, sortOrder: r.sortOrder })),
  });
});

router.get("/programs/:id/translations", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await db.select().from(programTranslationsTable)
    .where(eq(programTranslationsTable.programId, id))
    .orderBy(programTranslationsTable.locale);
  res.json({
    sourceLocale: "en",
    targetLocales: PROGRAM_TARGET_LOCALES,
    data: rows.map(({ workerId: _workerId, ...row }) => row),
  });
});

router.post("/programs/:id/translations/retry", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  const requested = Array.isArray(req.body?.locales) ? req.body.locales : undefined;
  if (requested && !requested.every(isProgramTargetLocale)) {
    res.status(400).json({ error: "Unsupported locale" });
    return;
  }
  const queued = await requeueProgramTranslations(id, requested);
  await logAudit(req.user!.id, "program_translations.requeue", "program", id, { queued, locales: requested || "all" }, req.ip);
  res.json({ queued });
});

router.post("/programs/translations/retry-failed", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const queued = await requeueAllFailedProgramTranslations();
  await logAudit(req.user!.id, "program_translations.requeue_failed", "program", undefined, { queued }, req.ip);
  res.json({ queued });
});

router.put("/programs/:id/translations/:locale", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const locale = String(req.params.locale || "").toLowerCase();
  if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!isProgramTargetLocale(locale)) { res.status(400).json({ error: "Unsupported locale" }); return; }
  const [program] = await db.select().from(programsTable).where(eq(programsTable.id, id));
  if (!program) { res.status(404).json({ error: "Program not found" }); return; }
  try {
    const source = normalizeProgramSourceContent(program as unknown as Record<string, unknown>);
    const content = parseProgramTranslation(JSON.stringify({
      name: req.body?.name,
      description: req.body?.description,
      field: req.body?.field,
      duration: req.body?.duration,
      intakes: req.body?.intakes,
      requirements: req.body?.requirements,
    }), source);
    const result = await pool.query(`
      INSERT INTO program_translations (
        program_id, locale, name, description, field, duration, intakes,
        requirements, source_hash, status, is_manual, attempts, error_code,
        translated_at, next_attempt_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        fas_program_content_source_hash($9,$10,$11,$12,$13,$14),
        'published', true, 0, NULL, now(), now(), now()
      )
      ON CONFLICT (program_id, locale) DO UPDATE
      SET name=EXCLUDED.name, description=EXCLUDED.description, field=EXCLUDED.field,
          duration=EXCLUDED.duration, intakes=EXCLUDED.intakes,
          requirements=EXCLUDED.requirements, source_hash=EXCLUDED.source_hash,
          status='published', is_manual=true, attempts=0, error_code=NULL,
          provider='manual', model=NULL, translated_at=now(), next_attempt_at=now(),
          leased_at=NULL, lease_expires_at=NULL, worker_id=NULL, updated_at=now()
      WHERE program_translations.status <> 'processing'
      RETURNING program_id
    `, [
      id, locale, content.name, content.description, content.field, content.duration,
      content.intakes, content.requirements, source.name, source.description,
      source.field, source.duration, source.intakes, source.requirements,
    ]);
    if (result.rowCount !== 1) { res.status(409).json({ error: "Translation is currently processing" }); return; }
    await logAudit(req.user!.id, "program_translation.manual_publish", "program", id, { locale }, req.ip);
    res.json({ programId: id, locale, status: "published", isManual: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid translation" });
  }
});

router.patch("/programs/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const updates: Record<string, unknown> = {};
  for (const key of PROG_PATCH_FIELDS) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.quota !== undefined) {
    if (updates.quota === null || updates.quota === "") {
      updates.quota = null;
    } else {
      const qv = Math.round(Number(updates.quota));
      if (isNaN(qv) || qv < 1) { res.status(400).json({ error: "quota must be a positive integer (>= 1) or null" }); return; }
      updates.quota = qv;
    }
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No valid fields" }); return; }
  const [prog] = await db.update(programsTable).set(updates).where(eq(programsTable.id, id)).returning();
  if (!prog) { res.status(404).json({ error: "Program not found" }); return; }
  await logAudit(req.user!.id, "update_program", "program", id, updates, req.ip);
  res.json(prog);
});

router.delete("/programs/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(programsTable).where(eq(programsTable.id, id));
  await logAudit(req.user!.id, "delete_program", "program", id, {}, req.ip);
  res.sendStatus(204);
});

router.delete("/programs", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const result = await db.delete(programsTable).returning({ id: programsTable.id });
  await logAudit(req.user!.id, "delete_all_programs", "program", undefined, { count: result.length }, req.ip);
  res.json({ deleted: result.length });
});

export default router;
