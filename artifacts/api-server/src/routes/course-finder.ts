import { Router, type IRouter } from "express";
import { db, programsTable, programTranslationsTable, universitiesTable, wishlistsTable, applicationsTable, commissionsTable, serviceFeesTable, studentsTable, pipelineStagesTable, settingsTable, documentsTable } from "@workspace/db";
import { eq, ilike, sql, and, inArray, isNull, desc, or, notInArray } from "drizzle-orm";
import { requireAuth, requireRole, requireAgentStaffPermission, logAudit } from "../lib/auth";
import { STAFF_ROLES, AGENT_ROLES, ADMIN_ROLES, isAgentRole } from "../lib/roles";
import { usersTable } from "@workspace/db";
import { resolveAgentCommission } from "../lib/agentCommission";
import { getCurrentSeason } from "../lib/season";
import { checkMandatoryDocsForStudent } from "../lib/mandatoryDocs.js";
import { enqueueOnStageChange, maybeEnqueuePortalSubmission } from "../lib/portalAutoTrigger.js";
import {
  buildPortalDraftPreflightError,
  prepareRoutedPortalDraftPreflight,
} from "../lib/portalDraftPreflight.js";
import { getAgentVisibleIds } from "../lib/agentVisibility";
import { getVisibleBranchIds } from "../lib/branchScope";
import { getDocLabel } from "../lib/docNaming";
import {
  courseFinderUniversityLogoUrl,
  sanitizeCourseFinderProgram,
} from "../lib/courseFinderVisibility";
import { courseFinderFilterCacheKey } from "../lib/courseFinderFilterCache";
import {
  courseFinderListCacheKey,
  courseFinderVisibilityCacheKey,
} from "../lib/courseFinderListCache";
import { parseCourseFinderPagination } from "../lib/courseFinderPagination";
import {
  canonicalCourseFinderStudyLevels,
  courseFinderStudyLevelSearchValues,
} from "../lib/courseFinderStudyLevels";
import {
  normaliseCountryRules,
  normaliseStringList,
  publicCatalogPolicyCacheKey,
  type PublicCatalogPolicy,
} from "../lib/publicCatalogPolicy";
import { resolveResidenceAddress } from "../lib/studentAddressDefaults";
import { coalesceRead } from "../lib/readPathCoalescing";
import { normalizeProgramLocale } from "../lib/programTranslationContract";

const router: IRouter = Router();

const COURSE_FINDER_FILTER_CACHE_TTL_MS = 45_000;
const COURSE_FINDER_FILTER_CACHE_MAX = 100;
const COURSE_FINDER_LIST_CACHE_TTL_MS = 15_000;
const COURSE_FINDER_LIST_CACHE_MAX = 200;
const courseFinderFilterCache = new Map<
  string,
  { expiresAt: number; value: CourseFinderFilterPayload }
>();
type CourseFinderListPayload = {
  data: any[];
  meta: { total: number; page: number; limit: number; totalPages: number };
};
const courseFinderListCache = new Map<
  string,
  { expiresAt: number; value: CourseFinderListPayload }
>();
let publicCatalogPolicyCache:
  | { expiresAt: number; value: PublicCatalogPolicy }
  | undefined;

async function getPublicCatalogPolicy(): Promise<PublicCatalogPolicy> {
  if (publicCatalogPolicyCache && publicCatalogPolicyCache.expiresAt > Date.now()) {
    return publicCatalogPolicyCache.value;
  }
  const [row] = await db
    .select({
      allowedCountries: settingsTable.publicCatalogAllowedCountries,
      allowedUniversityTypes: settingsTable.publicCatalogAllowedUniversityTypes,
      countryRules: settingsTable.publicCatalogCountryRules,
    })
    .from(settingsTable)
    .limit(1);
  const value = {
    allowedCountries: normaliseStringList(row?.allowedCountries),
    allowedUniversityTypes: normaliseStringList(row?.allowedUniversityTypes),
    countryRules: normaliseCountryRules(row?.countryRules),
  };
  // Fail closed to the requested public default if an old/malformed settings
  // row somehow contains no university-type policy.
  if (value.allowedUniversityTypes.length === 0) {
    value.allowedUniversityTypes = ["Private"];
  }
  publicCatalogPolicyCache = { expiresAt: Date.now() + 30_000, value };
  return value;
}

function isInternalCourseFinderRequest(req: any): boolean {
  const role = req.user?.role;
  return Boolean(role && ([...STAFF_ROLES, ...AGENT_ROLES] as string[]).includes(role));
}

async function resolveCourseFinderPolicy(req: any): Promise<PublicCatalogPolicy | null> {
  const explicitlyPublic = String(req.query?.scope || "").toLowerCase() === "public";
  if (!explicitlyPublic && isInternalCourseFinderRequest(req)) return null;
  return getPublicCatalogPolicy();
}

function universityTypeCondition(values: string[]): any | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) {
    return ilike(universitiesTable.universityType, values[0]);
  }
  return or(...values.map((value) =>
    ilike(universitiesTable.universityType, value)
  ))!;
}

function addPublicCatalogConditions(conditions: any[], policy: PublicCatalogPolicy | null): void {
  if (!policy) return;
  conditions.push(eq(universitiesTable.isActive, true));

  const countryRuleEntries = Object.entries(policy.countryRules);
  if (countryRuleEntries.length === 0) {
    // Backwards-compatible path for policies saved by the original global UI.
    if (policy.allowedCountries.length === 1) {
      conditions.push(eq(universitiesTable.country, policy.allowedCountries[0]));
    } else if (policy.allowedCountries.length > 1) {
      conditions.push(inArray(universitiesTable.country, policy.allowedCountries));
    }
    conditions.push(universityTypeCondition(policy.allowedUniversityTypes) || sql`false`);
    return;
  }

  const explicitCountries = countryRuleEntries.map(([country]) => country);
  const visibilityClauses: any[] = [];
  const defaultTypeCondition = universityTypeCondition(policy.allowedUniversityTypes);
  if (defaultTypeCondition) {
    const eligibleDefaultCountries = policy.allowedCountries
      .filter((country) => !explicitCountries.includes(country));
    if (policy.allowedCountries.length === 0 || eligibleDefaultCountries.length > 0) {
      const defaultCountryCondition = policy.allowedCountries.length > 0
        ? inArray(universitiesTable.country, eligibleDefaultCountries)
        : notInArray(universitiesTable.country, explicitCountries);
      visibilityClauses.push(and(defaultCountryCondition, defaultTypeCondition));
    }
  }
  for (const [country, universityTypes] of countryRuleEntries) {
    const typeCondition = universityTypeCondition(universityTypes);
    if (!typeCondition) continue; // [] means the country is hidden.
    visibilityClauses.push(and(
      eq(universitiesTable.country, country),
      typeCondition,
    ));
  }
  conditions.push(visibilityClauses.length > 0 ? or(...visibilityClauses)! : sql`false`);
}

type CourseFinderFilterPayload = {
  countries: string[];
  cities: string[];
  universityTypes: string[];
  universities: Array<{ id: number; name: string }>;
  degrees: string[];
  languages: string[];
  fields: string[];
  feeRange: { min: number; max: number };
};

function cacheCourseFinderFilters(
  key: string,
  value: CourseFinderFilterPayload,
): void {
  const now = Date.now();
  for (const [candidate, entry] of courseFinderFilterCache) {
    if (entry.expiresAt <= now) courseFinderFilterCache.delete(candidate);
  }
  if (courseFinderFilterCache.size >= COURSE_FINDER_FILTER_CACHE_MAX) {
    const oldest = courseFinderFilterCache.keys().next().value;
    if (oldest !== undefined) courseFinderFilterCache.delete(oldest);
  }
  courseFinderFilterCache.set(key, {
    expiresAt: now + COURSE_FINDER_FILTER_CACHE_TTL_MS,
    value,
  });
}

function cacheCourseFinderList(
  key: string,
  value: CourseFinderListPayload,
): void {
  const now = Date.now();
  for (const [candidate, entry] of courseFinderListCache) {
    if (entry.expiresAt <= now) courseFinderListCache.delete(candidate);
  }
  if (courseFinderListCache.size >= COURSE_FINDER_LIST_CACHE_MAX) {
    const oldest = courseFinderListCache.keys().next().value;
    if (oldest !== undefined) courseFinderListCache.delete(oldest);
  }
  courseFinderListCache.set(key, {
    expiresAt: now + COURSE_FINDER_LIST_CACHE_TTL_MS,
    value,
  });
}

/**
 * Escape PostgreSQL LIKE/ILIKE pattern metacharacters so user-supplied
 * search input is matched literally. Without this, characters like `%`
 * and `_` are interpreted as wildcards (e.g. searching `50%` would match
 * everything starting with "50").
 */
function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Parse a query-string number safely. Returns null for NaN, Infinity, or
 * negative values so the caller can skip the filter instead of injecting
 * `NaN` into the SQL (which Postgres rejects with a 500).
 */
function parseNonNegativeInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

router.get("/course-finder", async (req, res): Promise<void> => {
  const { country, city, universityType, universityId, programId, level, language, locale, field, search, intake, feeMin, feeMax, sort, page = "1", limit = "24" } = req.query as Record<string, string>;
  const contentLocale = normalizeProgramLocale(locale);
  const localizedProgramName = sql<string>`COALESCE(${programTranslationsTable.name}, ${programsTable.name})`;
  // Cap at 500 (was 1000). Lowering further requires StudentDetail.tsx:319
  // to be paginated — currently it requests `limit=500` for a single
  // university's program list. Invalid values fall back safely instead of
  // passing NaN to LIMIT/OFFSET and destabilising the API process.
  const { page: pageNum, limit: limitNum, offset } =
    parseCourseFinderPagination(page, limit);

  const conditions = [eq(programsTable.isActive, true)];
  const publicPolicy = await resolveCourseFinderPolicy(req);
  addPublicCatalogConditions(conditions, publicPolicy);
  if (programId) {
    const pid = parseInt(programId, 10);
    if (!isNaN(pid)) conditions.push(eq(programsTable.id, pid));
  }
  if (country) {
    const vals = country.split(",").map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) conditions.push(eq(universitiesTable.country, vals[0]));
    else if (vals.length > 1) conditions.push(inArray(universitiesTable.country, vals));
  }
  if (city) {
    const vals = city.split(",").map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) conditions.push(eq(universitiesTable.city, vals[0]));
    else if (vals.length > 1) conditions.push(inArray(universitiesTable.city, vals));
  }
  if (universityType) {
    const vals = universityType.split(",").map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) conditions.push(eq(universitiesTable.universityType, vals[0]));
    else if (vals.length > 1) conditions.push(inArray(universitiesTable.universityType, vals));
  }
  if (universityId) {
    const vals = universityId.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (vals.length === 1) conditions.push(eq(programsTable.universityId, vals[0]));
    else if (vals.length > 1) conditions.push(inArray(programsTable.universityId, vals));
  }
  if (level) {
    const vals = courseFinderStudyLevelSearchValues(
      level.split(",").map(s => s.trim()).filter(Boolean),
    );
    if (vals.length === 1) conditions.push(ilike(programsTable.degree, `%${vals[0]}%`));
    else if (vals.length > 1) conditions.push(or(...vals.map(v => ilike(programsTable.degree, `%${v}%`)))!);
  }
  if (language) {
    const vals = language.split(",").map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) conditions.push(ilike(programsTable.language, vals[0]));
    else if (vals.length > 1) conditions.push(inArray(programsTable.language, vals));
  }
  if (field) {
    const vals = field.split(",").map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) conditions.push(ilike(programsTable.field, vals[0]));
    else if (vals.length > 1) conditions.push(or(...vals.map(v => ilike(programsTable.field, v)))!);
  }
  if (intake) conditions.push(ilike(programsTable.intakes, `%${escapeLikePattern(intake)}%`));
  const feeMinNum = parseNonNegativeInt(feeMin);
  if (feeMinNum !== null) conditions.push(sql`COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}) >= ${feeMinNum}`);
  const feeMaxNum = parseNonNegativeInt(feeMax);
  if (feeMaxNum !== null) conditions.push(sql`COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}) <= ${feeMaxNum}`);
  if (search) {
    const escaped = escapeLikePattern(search);
    conditions.push(
      sql`(${ilike(programsTable.name, `%${escaped}%`)} OR ${ilike(programTranslationsTable.name, `%${escaped}%`)} OR ${ilike(programsTable.field, `%${escaped}%`)} OR ${ilike(programTranslationsTable.field, `%${escaped}%`)} OR ${ilike(universitiesTable.name, `%${escaped}%`)})`
    );
  }

  const where = and(...conditions);
  const effectiveFee = sql`COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee})`;
  const orderBy = sort === "price_asc"
    ? [sql`${effectiveFee} ASC NULLS LAST`, universitiesTable.name, programsTable.name]
    : sort === "price_desc"
      ? [sql`${effectiveFee} DESC NULLS LAST`, universitiesTable.name, programsTable.name]
      : [universitiesTable.name, localizedProgramName];

  const user = (req as any).user;
  const canSeeContacts = user && ([...STAFF_ROLES, ...AGENT_ROLES] as string[]).includes(user.role);
  let canSeeInternalFees = !!user && ["super_admin", "agent", "sub_agent"].includes(user.role);
  let canSeeServiceFee = canSeeInternalFees;
  if (user?.role === "agent_staff") {
    const [staffUser] = await db
      .select({ agentStaffPermissions: usersTable.agentStaffPermissions })
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    const permissions = (staffUser?.agentStaffPermissions as string[] | null) || [];
    canSeeInternalFees = permissions.includes("view_commission_amount");
    canSeeServiceFee = permissions.includes("view_service_fee");
  }

  const policyKey = publicPolicy
    ? `public:${publicCatalogPolicyCacheKey(publicPolicy)}`
    : "internal";
  const visibilityKey = courseFinderVisibilityCacheKey({
    contacts: Boolean(canSeeContacts),
    internalFees: canSeeInternalFees,
    serviceFee: canSeeServiceFee,
  });
  const requestKey = courseFinderListCacheKey({
    programId,
    country,
    city,
    universityType,
    universityId,
    level,
    language,
    field,
    intake,
    feeMin,
    feeMax,
    search,
    sort,
    page: String(pageNum),
    limit: String(limitNum),
  });
  const cacheKey = `${policyKey}:${visibilityKey}:locale=${contentLocale}:${requestKey}`;
  const cached = courseFinderListCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader("Cache-Control", "private, max-age=10, stale-while-revalidate=30");
    res.setHeader("X-Course-Finder-List-Cache", "HIT");
    res.json(cached.value);
    return;
  }

  const { value: payload, coalesced: wasCoalesced } = await coalesceRead({
    namespace: "course-finder-list",
    key: cacheKey,
    enabled: true,
    execute: async (): Promise<CourseFinderListPayload> => {
      const countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(programsTable)
        .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
        .leftJoin(programTranslationsTable, and(
          eq(programTranslationsTable.programId, programsTable.id),
          eq(programTranslationsTable.locale, contentLocale),
          eq(programTranslationsTable.status, "published"),
        ))
        .where(where);
      const rowsQuery = db
        .select({
          id: programsTable.id,
          name: localizedProgramName,
          description: sql<string | null>`COALESCE(${programTranslationsTable.description}, ${programsTable.description})`,
          degree: programsTable.degree,
          field: sql<string | null>`COALESCE(${programTranslationsTable.field}, ${programsTable.field})`,
          language: programsTable.language,
          duration: sql<string | null>`COALESCE(${programTranslationsTable.duration}, ${programsTable.duration})`,
          tuitionFee: programsTable.tuitionFee,
          currency: programsTable.currency,
          scholarship: programsTable.scholarship,
          intakes: sql<string | null>`COALESCE(${programTranslationsTable.intakes}, ${programsTable.intakes})`,
          requirements: sql<string | null>`COALESCE(${programTranslationsTable.requirements}, ${programsTable.requirements})`,
          translatedLocale: programTranslationsTable.locale,
          commissionRate: programsTable.commissionRate,
          applicationFee: programsTable.applicationFee,
          advancedFee: programsTable.advancedFee,
          depositFee: programsTable.depositFee,
          serviceFeeAmount: programsTable.serviceFeeAmount,
          discountedFee: programsTable.discountedFee,
          languageFee: programsTable.languageFee,
          feeType: programsTable.feeType,
          quota: programsTable.quota,
          isActive: programsTable.isActive,
          universityId: programsTable.universityId,
          universityName: universitiesTable.name,
          universityHasLogo: sql<boolean>`${universitiesTable.logoUrl} IS NOT NULL
            AND length(trim(${universitiesTable.logoUrl})) > 0`.as("university_has_logo"),
          universityCountry: universitiesTable.country,
          universityCity: universitiesTable.city,
          universityStatus: universitiesTable.status,
          universityType: universitiesTable.universityType,
          universityWebsite: universitiesTable.website,
          universityDescription: universitiesTable.description,
          universityQsRanking: universitiesTable.qsRanking,
          universityTimesRanking: universitiesTable.timesRanking,
          universityShanghaiRanking: universitiesTable.shanghaiRanking,
          universityCwtsLeidenRanking: universitiesTable.cwtsLeidenRanking,
          universityAddress: universitiesTable.address,
          universityTaxType: universitiesTable.taxType,
          universityContactName: universitiesTable.contactPersonName,
          universityContactPhone: universitiesTable.contactPersonPhone,
          universityContactEmail: universitiesTable.contactPersonEmail,
        })
        .from(programsTable)
        .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
        .leftJoin(programTranslationsTable, and(
          eq(programTranslationsTable.programId, programsTable.id),
          eq(programTranslationsTable.locale, contentLocale),
          eq(programTranslationsTable.status, "published"),
        ))
        .where(where)
        .orderBy(...orderBy)
        .limit(limitNum)
        .offset(offset);

      // The total and current page are independent read-only queries. Running
      // them concurrently removes one full DB round trip from every listing load.
      const [[{ count }], rows] = await Promise.all([countQuery, rowsQuery]);
      const sanitizedRows = rows.map(({ universityHasLogo, ...row }) =>
        sanitizeCourseFinderProgram({
          ...row,
          contentLocale,
          fallbackUsed: contentLocale !== "en" && row.translatedLocale !== contentLocale,
          translatedLocale: undefined,
          universityLogoUrl: courseFinderUniversityLogoUrl(
            row.universityId,
            universityHasLogo,
          ),
        }, {
          contacts: Boolean(canSeeContacts),
          internalFees: canSeeInternalFees,
          serviceFee: canSeeServiceFee,
        })
      );
      const nextPayload: CourseFinderListPayload = {
        data: sanitizedRows,
        meta: {
          total: Number(count),
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(Number(count) / limitNum),
        },
      };
      cacheCourseFinderList(cacheKey, nextPayload);
      return nextPayload;
    },
  });
  res.setHeader("Cache-Control", "private, max-age=10, stale-while-revalidate=30");
  res.setHeader(
    "X-Course-Finder-List-Cache",
    wasCoalesced ? "COALESCED" : "MISS",
  );
  res.json(payload);
});

/**
 * Build a WHERE-conditions array from URL query params, optionally
 * skipping a single facet key. Used by the cascading /filters endpoint:
 * each facet's options are computed with all OTHER selected filters
 * applied, so e.g. selecting Country=Turkey narrows the City and
 * University dropdowns but keeps the Country dropdown showing every
 * country (so the user can still switch).
 */
export function buildProgramFacetConditions(
  params: Record<string, string | undefined>,
  excludeKey?:
    | "country" | "city" | "universityType" | "universityId"
    | "level" | "language" | "field" | "fee" | "search",
  opts?: { fuzzyField?: boolean; publicPolicy?: PublicCatalogPolicy | null },
) {
  const conditions = [eq(programsTable.isActive, true)];
  addPublicCatalogConditions(conditions, opts?.publicPolicy ?? null);
  if (excludeKey !== "country" && params.country) {
    const vals = params.country.split(",").map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) conditions.push(ilike(universitiesTable.country, vals[0]));
    else if (vals.length > 1) conditions.push(or(...vals.map(v => ilike(universitiesTable.country, v)))!);
  }
  if (excludeKey !== "city" && params.city) {
    const vals = params.city.split(",").map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) conditions.push(ilike(universitiesTable.city, vals[0]));
    else if (vals.length > 1) conditions.push(or(...vals.map(v => ilike(universitiesTable.city, v)))!);
  }
  if (excludeKey !== "universityType" && params.universityType) {
    const vals = params.universityType.split(",").map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) conditions.push(ilike(universitiesTable.universityType, vals[0]));
    else if (vals.length > 1) conditions.push(or(...vals.map(v => ilike(universitiesTable.universityType, v)))!);
  }
  if (excludeKey !== "universityId" && params.universityId) {
    const vals = params.universityId.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (vals.length === 1) conditions.push(eq(programsTable.universityId, vals[0]));
    else if (vals.length > 1) conditions.push(inArray(programsTable.universityId, vals));
  }
  if (excludeKey !== "level" && params.level) {
    const vals = courseFinderStudyLevelSearchValues(
      params.level.split(",").map(s => s.trim()).filter(Boolean),
    );
    if (vals.length === 1) conditions.push(ilike(programsTable.degree, `%${vals[0]}%`));
    else if (vals.length > 1) conditions.push(or(...vals.map(v => ilike(programsTable.degree, `%${v}%`)))!);
  }
  if (excludeKey !== "language" && params.language) {
    const vals = params.language.split(",").map(s => s.trim()).filter(Boolean);
    if (vals.length === 1) conditions.push(ilike(programsTable.language, vals[0]));
    else if (vals.length > 1) conditions.push(inArray(programsTable.language, vals));
  }
  if (excludeKey !== "field" && params.field) {
    const vals = params.field.split(",").map(s => s.trim()).filter(Boolean);
    if (opts?.fuzzyField) {
      // AI tool: free-text — match loosely against field taxonomy, program name and degree.
      conditions.push(
        or(...vals.flatMap(v => {
          const esc = escapeLikePattern(v);
          return [
            ilike(programsTable.field,  `%${esc}%`),
            ilike(programsTable.name,   `%${esc}%`),
            ilike(programsTable.degree, `%${esc}%`),
          ];
        }))!
      );
    } else {
      // Course Finder facet: exact taxonomy match (unchanged).
      if (vals.length === 1) conditions.push(ilike(programsTable.field, vals[0]));
      else if (vals.length > 1) conditions.push(or(...vals.map(v => ilike(programsTable.field, v)))!);
    }
  }
  if (excludeKey !== "fee") {
    const feeMinNum = parseNonNegativeInt(params.feeMin);
    if (feeMinNum !== null) conditions.push(sql`COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}) >= ${feeMinNum}`);
    const feeMaxNum = parseNonNegativeInt(params.feeMax);
    if (feeMaxNum !== null) conditions.push(sql`COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}) <= ${feeMaxNum}`);
  }
  if (excludeKey !== "search" && params.search) {
    const escaped = escapeLikePattern(params.search);
    conditions.push(
      sql`(${ilike(programsTable.name, `%${escaped}%`)} OR ${ilike(universitiesTable.name, `%${escaped}%`)})`
    );
  }
  return and(...conditions);
}

router.get("/course-finder/filters", async (req, res): Promise<void> => {
  try {
    const params = req.query as Record<string, string | undefined>;
    const publicPolicy = await resolveCourseFinderPolicy(req);
    const policyKey = publicPolicy
      ? `public:${publicCatalogPolicyCacheKey(publicPolicy)}`
      : "internal";
    const cacheKey = `${policyKey}:${courseFinderFilterCacheKey(params)}`;
    const cached = courseFinderFilterCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader("Cache-Control", "private, max-age=30, stale-while-revalidate=120");
      res.setHeader("X-Course-Finder-Filter-Cache", "HIT");
      res.json(cached.value);
      return;
    }

    const { value: payload, coalesced: wasCoalesced } = await coalesceRead({
      namespace: "course-finder-filters",
      key: cacheKey,
      // Preserve the endpoint's pre-existing unconditional coalescing. The
      // environment flag governs new opt-in call sites, not this established
      // protection.
      enabled: true,
      execute: async (): Promise<CourseFinderFilterPayload> => {
        const join = eq(programsTable.universityId, universitiesTable.id);
        const policyOpts = { publicPolicy };
        const wCountry = buildProgramFacetConditions(params, "country", policyOpts);
        const wCity = buildProgramFacetConditions(params, "city", policyOpts);
        const wType = buildProgramFacetConditions(params, "universityType", policyOpts);
        const wUni = buildProgramFacetConditions(params, "universityId", policyOpts);
        const wLevel = buildProgramFacetConditions(params, "level", policyOpts);
        const wLang = buildProgramFacetConditions(params, "language", policyOpts);
        const wField = buildProgramFacetConditions(params, "field", policyOpts);
        const wFee = buildProgramFacetConditions(params, "fee", policyOpts);

        const [
          countries,
          cities,
          universityTypes,
          universities,
          degrees,
          languages,
          fields,
          feeRange,
        ] = await Promise.all([
          db.selectDistinct({ country: universitiesTable.country }).from(universitiesTable).innerJoin(programsTable, join)
            .where(and(wCountry, sql`${universitiesTable.country} IS NOT NULL`)).orderBy(universitiesTable.country),
          db.selectDistinct({ city: universitiesTable.city }).from(universitiesTable).innerJoin(programsTable, join)
            .where(and(wCity, sql`${universitiesTable.city} IS NOT NULL`)).orderBy(universitiesTable.city),
          db.selectDistinct({ type: universitiesTable.universityType }).from(universitiesTable).innerJoin(programsTable, join)
            .where(and(wType, sql`${universitiesTable.universityType} IS NOT NULL`)).orderBy(universitiesTable.universityType),
          db.selectDistinct({ id: universitiesTable.id, name: universitiesTable.name }).from(universitiesTable).innerJoin(programsTable, join)
            .where(wUni).orderBy(universitiesTable.name),
          db.selectDistinct({ degree: programsTable.degree }).from(programsTable).innerJoin(universitiesTable, join)
            .where(and(wLevel, sql`${programsTable.degree} IS NOT NULL`)).orderBy(programsTable.degree),
          db.selectDistinct({ language: programsTable.language }).from(programsTable).innerJoin(universitiesTable, join)
            .where(and(wLang, sql`${programsTable.language} IS NOT NULL`)).orderBy(programsTable.language),
          db.selectDistinct({ field: programsTable.field }).from(programsTable).innerJoin(universitiesTable, join)
            .where(and(wField, sql`${programsTable.field} IS NOT NULL AND ${programsTable.field} != ''`)).orderBy(programsTable.field),
          db.select({
            min: sql<number>`MIN(COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}))`,
            max: sql<number>`MAX(COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}))`,
          }).from(programsTable).innerJoin(universitiesTable, join)
            .where(and(wFee, sql`COALESCE(${programsTable.discountedFee}, ${programsTable.tuitionFee}) IS NOT NULL`)),
        ]);

        const payload: CourseFinderFilterPayload = {
          countries: countries
            .map(r => r.country)
            .filter((value): value is string => Boolean(value)),
          cities: cities
            .map(r => r.city)
            .filter((value): value is string => Boolean(value)),
          universityTypes: universityTypes
            .map(r => r.type)
            .filter((value): value is string => Boolean(value)),
          universities: universities.map(r => ({ id: r.id, name: r.name })),
          degrees: canonicalCourseFinderStudyLevels(
            degrees
              .map(r => r.degree)
              .filter((value): value is string => Boolean(value)),
          ),
          languages: languages
            .map(r => r.language)
            .filter((value): value is string => Boolean(value)),
          fields: fields
            .map(r => r.field)
            .filter((value): value is string => Boolean(value)),
          feeRange: {
            min: feeRange[0]?.min ?? 0,
            max: feeRange[0]?.max ?? 100000,
          },
        };
        cacheCourseFinderFilters(cacheKey, payload);
        return payload;
      },
    });
    res.setHeader("Cache-Control", "private, max-age=30, stale-while-revalidate=120");
    res.setHeader(
      "X-Course-Finder-Filter-Cache",
      wasCoalesced ? "COALESCED" : "MISS",
    );
    res.json(payload);
  } catch (err: any) {
    console.error("[course-finder/filters] failed:", err?.message || err);
    res.status(500).json({ error: "Failed to load filters" });
  }
});

router.get(
  "/course-finder/public-settings",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const policy = await getPublicCatalogPolicy();
    const join = eq(programsTable.universityId, universitiesTable.id);
    const [countries, universityTypes] = await Promise.all([
      db
        .selectDistinct({ value: universitiesTable.country })
        .from(universitiesTable)
        .innerJoin(programsTable, join)
        .where(and(eq(programsTable.isActive, true), sql`${universitiesTable.country} IS NOT NULL`))
        .orderBy(universitiesTable.country),
      db
        .selectDistinct({ value: universitiesTable.universityType })
        .from(universitiesTable)
        .innerJoin(programsTable, join)
        .where(and(eq(programsTable.isActive, true), sql`${universitiesTable.universityType} IS NOT NULL`))
        .orderBy(universitiesTable.universityType),
    ]);
    res.json({
      ...policy,
      availableCountries: countries.map((row) => row.value).filter(Boolean),
      availableUniversityTypes: universityTypes.map((row) => row.value).filter(Boolean),
    });
  },
);

router.patch(
  "/course-finder/public-settings",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const allowedCountries = normaliseStringList(req.body?.allowedCountries);
    const allowedUniversityTypes = normaliseStringList(req.body?.allowedUniversityTypes);
    const countryRules = normaliseCountryRules(req.body?.countryRules);
    if (allowedUniversityTypes.length === 0) {
      res.status(400).json({ error: "At least one university type must be selected" });
      return;
    }

    const join = eq(programsTable.universityId, universitiesTable.id);
    const [countryRows, typeRows] = await Promise.all([
      db.selectDistinct({ value: universitiesTable.country }).from(universitiesTable).innerJoin(programsTable, join)
        .where(eq(programsTable.isActive, true)),
      db.selectDistinct({ value: universitiesTable.universityType }).from(universitiesTable).innerJoin(programsTable, join)
        .where(eq(programsTable.isActive, true)),
    ]);
    const availableCountries = new Set(countryRows.map((row) => row.value).filter(Boolean));
    const availableTypes = new Set(typeRows.map((row) => row.value).filter(Boolean));
    if (allowedCountries.some((value) => !availableCountries.has(value))) {
      res.status(400).json({ error: "Invalid public catalogue country" });
      return;
    }
    if (allowedUniversityTypes.some((value) => !availableTypes.has(value))) {
      res.status(400).json({ error: "Invalid public catalogue university type" });
      return;
    }
    if (Object.keys(countryRules).some((country) => !availableCountries.has(country))) {
      res.status(400).json({ error: "Invalid public catalogue country rule" });
      return;
    }
    if (Object.values(countryRules).some((types) =>
      types.some((value) => !availableTypes.has(value))
    )) {
      res.status(400).json({ error: "Invalid university type in public catalogue country rule" });
      return;
    }

    const [existing] = await db.select({ id: settingsTable.id }).from(settingsTable).limit(1);
    const update = {
      // New saves are represented entirely by a default rule plus per-country
      // overrides. Clearing the legacy allow-list avoids two competing sources.
      publicCatalogAllowedCountries: Object.keys(countryRules).length > 0 ? [] : allowedCountries,
      publicCatalogAllowedUniversityTypes: allowedUniversityTypes,
      publicCatalogCountryRules: countryRules,
      updatedAt: new Date(),
    };
    if (existing) {
      await db.update(settingsTable).set(update).where(eq(settingsTable.id, existing.id));
    } else {
      await db.insert(settingsTable).values(update);
    }
    publicCatalogPolicyCache = undefined;
    courseFinderFilterCache.clear();
    const value = await getPublicCatalogPolicy();
    logAudit(req.user!.id, "update_public_catalog_settings", "settings", existing?.id, value, req.ip);
    res.json(value);
  },
);

router.get("/course-finder/students", requireAuth, requireAgentStaffPermission("course_finder"), async (req, res): Promise<void> => {
  const user = req.user!;
  const { search, limit = "10" } = req.query as Record<string, string>;
  const limitNum = Math.min(20, Math.max(1, parseInt(limit, 10)));

  // Always exclude soft-deleted students.
  const conditions: any[] = [isNull(studentsTable.deletedAt)];

  // Ownership scoping — mirrors GET /api/students so agents only see their
  // own students (and their sub-agents'/agent_staff's), and non-admin staff
  // see assigned-or-unassigned students. Admins see everything.
  if (isAgentRole(user.role)) {
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    if (visibleIds.length === 0) { res.json([]); return; }
    conditions.push(inArray(studentsTable.agentId, visibleIds));
  } else if (user.role === "student") {
    conditions.push(eq(studentsTable.userId, user.id));
  } else if (!(ADMIN_ROLES as readonly string[]).includes(user.role)) {
    conditions.push(
      or(
        eq(studentsTable.assignedToId, user.id),
        isNull(studentsTable.assignedToId),
      )
    );
  }

  // Branch scoping for staff and agents (super_admin → null = all).
  if (user.role !== "student") {
    const visibleBranchIds = await getVisibleBranchIds(user.id, user.role, user);
    if (visibleBranchIds !== null) {
      if (visibleBranchIds.length === 0) {
        conditions.push(isNull(studentsTable.branchId));
      } else {
        conditions.push(or(inArray(studentsTable.branchId, visibleBranchIds), isNull(studentsTable.branchId))!);
      }
    }
  }

  if (search && search.trim()) {
    const s = `%${escapeLikePattern(search.trim())}%`;
    conditions.push(
      or(
        ilike(studentsTable.firstName, s),
        ilike(studentsTable.lastName, s),
        ilike(studentsTable.email, s),
        ilike(studentsTable.phone, s),
        sql`CONCAT(${studentsTable.firstName}, ' ', ${studentsTable.lastName}) ILIKE ${s}`,
      )
    );
  }

  const where = and(...conditions);
  const rows = await db
    .select({
      id: studentsTable.id,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      email: studentsTable.email,
      phone: studentsTable.phone,
      nationality: studentsTable.nationality,
      agentId: studentsTable.agentId,
      createdAt: studentsTable.createdAt,
    })
    .from(studentsTable)
    .where(where)
    .orderBy(desc(studentsTable.createdAt))
    .limit(limitNum);

  res.json(rows);
});

router.post("/course-finder/apply", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES, "student"), requireAgentStaffPermission("course_finder"), async (req, res): Promise<void> => {
  const { studentId, programId, notes, uploadedDocumentIds: requestedDocumentIds } = req.body;
  const isStudentRole = req.user!.role === "student";

  let resolvedStudentId = studentId;
  if (isStudentRole) {
    let [myStudent] = await db.select().from(studentsTable).where(eq(studentsTable.userId, req.user!.id));
    if (!myStudent) {
      const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id));
      if (!me) { res.status(404).json({ error: "User not found" }); return; }
      [myStudent] = await db.insert(studentsTable).values({
        userId: me.id,
        firstName: me.firstName || "",
        lastName: me.lastName || "",
        email: me.email || "",
        phone: me.phone || null,
        ...resolveResidenceAddress({}),
      }).returning();
    }
    resolvedStudentId = myStudent.id;
  }

  if (!resolvedStudentId || !programId) {
    res.status(400).json({ error: "studentId and programId are required" });
    return;
  }

  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, Number(resolvedStudentId)));
  if (!student) { res.status(404).json({ error: "Student not found" }); return; }

  if (requestedDocumentIds !== undefined && !Array.isArray(requestedDocumentIds)) {
    res.status(400).json({ error: "uploadedDocumentIds must be an array" });
    return;
  }
  const requestedDocumentIdCount = Array.isArray(requestedDocumentIds) ? requestedDocumentIds.length : 0;
  const uploadedDocumentIds = Array.from(new Set(
    (Array.isArray(requestedDocumentIds) ? requestedDocumentIds : [])
      .map((value: unknown) => Number(value))
      .filter((value: number) => Number.isInteger(value) && value > 0),
  ));
  if (uploadedDocumentIds.length > 50 || uploadedDocumentIds.length !== requestedDocumentIdCount) {
    res.status(400).json({ error: "uploadedDocumentIds contains invalid or duplicate document ids" });
    return;
  }

  // Authorization — verify the caller may act on this student. The student
  // self-apply branch above already guarantees ownership; admins are
  // unrestricted. Everyone else is checked against the same scoping rules
  // as GET /api/students.
  if (!isStudentRole && !(ADMIN_ROLES as readonly string[]).includes(req.user!.role)) {
    if (student.deletedAt) {
      res.status(403).json({ error: "You do not have access to this student" });
      return;
    }
    if (isAgentRole(req.user!.role)) {
      const visibleIds = await getAgentVisibleIds(req.user!.id, req.user!.role);
      if (!student.agentId || !visibleIds.includes(student.agentId)) {
        res.status(403).json({ error: "You do not have access to this student" });
        return;
      }
    } else {
      // Non-admin staff: assigned to caller (or unassigned).
      if (student.assignedToId != null && student.assignedToId !== req.user!.id) {
        res.status(403).json({ error: "You do not have access to this student" });
        return;
      }
    }
    // Branch scoping (applies to both staff and agents). Mirrors the
    // listing semantics in /course-finder/students and /students:
    //  - visibleBranchIds=null    → unrestricted (admin-equivalent)
    //  - visibleBranchIds=[ids]   → only those branches OR null-branch
    //  - visibleBranchIds=[]      → only null-branch students allowed
    // Returning a blanket 403 when the list is empty would deny legitimate
    // access to null-branch students that ARE visible in the picker,
    // breaking the listing/apply consistency contract.
    const visibleBranchIds = await getVisibleBranchIds(req.user!.id, req.user!.role, req.user!);
    if (visibleBranchIds !== null) {
      const studentBranchId = student.branchId;
      const allowed = studentBranchId == null
        ? true
        : visibleBranchIds.includes(studentBranchId);
      if (!allowed) {
        res.status(403).json({ error: "You do not have access to this student" });
        return;
      }
    }
  }

  // Only profile documents belonging to the resolved student may be bound to
  // this application. This prevents guessed cross-student document ids.
  const uploadedDocuments = uploadedDocumentIds.length > 0
    ? await db.select().from(documentsTable).where(and(
        inArray(documentsTable.id, uploadedDocumentIds),
        eq(documentsTable.studentId, student.id),
        isNull(documentsTable.applicationId),
        isNull(documentsTable.deletedAt),
      ))
    : [];
  if (uploadedDocuments.length !== uploadedDocumentIds.length) {
    res.status(400).json({ error: "One or more uploaded documents are invalid for this student" });
    return;
  }

  const [program] = await db
    .select({
      id: programsTable.id,
      name: programsTable.name,
      degree: programsTable.degree,
      language: programsTable.language,
      tuitionFee: programsTable.tuitionFee,
      discountedFee: programsTable.discountedFee,
      currency: programsTable.currency,
      scholarship: programsTable.scholarship,
      commissionRate: programsTable.commissionRate,
      serviceFeeAmount: programsTable.serviceFeeAmount,
      applicationFee: programsTable.applicationFee,
      depositFee: programsTable.depositFee,
      advancedFee: programsTable.advancedFee,
      languageFee: programsTable.languageFee,
      intakes: programsTable.intakes,
      universityId: programsTable.universityId,
      universityName: universitiesTable.name,
      universityCountry: universitiesTable.country,
      universityType: universitiesTable.universityType,
    })
    .from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(eq(programsTable.id, Number(programId)));

  if (!program) { res.status(404).json({ error: "Program not found" }); return; }

  const docStatus = await checkMandatoryDocsForStudent(
    program.id,
    student.id,
    program.degree,
  );
  if (docStatus.missing.length > 0) {
    const missingDocLabels = docStatus.missing.map(getDocLabel);
    res.status(422).json({
      error: `Mandatory student documents are missing: ${missingDocLabels.join(", ")}`,
      code: "STUDENT_DOCS_REQUIRED",
      missingDocTypes: docStatus.missing,
      missingDocLabels,
    });
    return;
  }

  // Portal-aware readiness runs before INSERT. It combines the destination
  // adapter's actual field/document contract with safe enrichment from the
  // student's existing files. This prevents an apparently-valid CRM
  // application from entering Inquiry only to fail silently in the worker.
  const routedPreflight = await prepareRoutedPortalDraftPreflight({
    universityId: program.universityId,
    universityName: program.universityName,
    draft: {
      studentId: student.id,
      programId: program.id,
      level: program.degree ?? null,
      programName: program.name,
      universityName: program.universityName,
    },
    actorUserId: req.user!.id,
    ip: req.ip,
  });
  if (
    routedPreflight?.preflight.supported &&
    !routedPreflight.preflight.ready
  ) {
    res.status(422).json(buildPortalDraftPreflightError(routedPreflight));
    return;
  }

  const effectiveFee = program.discountedFee ?? program.tuitionFee;
  const currentYear = await getCurrentSeason();
  const studentName = `${student.firstName || ""} ${student.lastName || ""}`.trim();

  const [application] = await db.insert(applicationsTable).values({
    studentId: student.id,
    programId: program.id,
    universityId: program.universityId,
    agentId: student.agentId || null,
    // Preserve the platform ownership lane when an agency-owned student
    // applies through Course Finder. Agency-internal assignment remains on
    // students.agency_assigned_to_id and is intentionally not copied here.
    assignedToId: student.assignedToId || null,
    season: currentYear,
    stage: "inquiry",
    // Authenticated panel Course Finder "apply" = staff/admin (also agents).
    createdSource: "staff",
    programName: program.name,
    universityName: program.universityName,
    country: program.universityCountry || null,
    level: program.degree || null,
    instructionLanguage: program.language || null,
    tuitionFee: program.tuitionFee ?? null,
    discountedFee: program.discountedFee ?? null,
    scholarship: program.scholarship ?? null,
    commissionRate: program.commissionRate ?? null,
    serviceFeeAmount: program.serviceFeeAmount ?? null,
    applicationFee: program.applicationFee ?? null,
    depositFee: program.depositFee ?? null,
    advancedFee: program.advancedFee ?? null,
    languageFee: program.languageFee ?? null,
    currency: program.currency || "USD",
    intake: program.intakes || null,
    notes: notes || null,
  }).returning();

  // Keep a reusable profile copy and bind only this request's newly uploaded
  // records to the application by referencing the same stored object.
  if (uploadedDocuments.length > 0) {
    await db.insert(documentsTable).values(uploadedDocuments.map((document) => ({
      studentId: student.id,
      applicationId: application.id,
      name: document.name,
      type: document.type,
      status: document.status,
      fileKey: document.fileKey,
      fileUrl: document.fileUrl,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      extractedData: document.extractedData,
      confidenceScore: document.confidenceScore,
      fileData: document.fileData,
      notes: document.notes,
      source: "course_finder",
    })));
  }

  // Portal automation auto-trigger (fire-and-forget — never blocks response).
  maybeEnqueuePortalSubmission({
    applicationId:  application.id,
    studentId:      application.studentId,
    newStage:       String(application.stage),
    universityName: application.universityName ?? null,
    universityId:   application.universityId ?? null,
    actorUserId:    req.user?.id ?? null,
  }).catch((err) =>
    console.error("[portal-auto] Trigger failed for new app", application.id, ":", err),
  );

  await logAudit(req.user!.id, "create_application", "application", application.id,
    { studentId: student.id, programId: program.id, source: "course_finder" }, req.ip);

  try {
    const [appMadeStage] = await db.select({ key: pipelineStagesTable.key })
      .from(pipelineStagesTable)
      .where(and(eq(pipelineStagesTable.entityType, "student"), eq(pipelineStagesTable.variant, "won")));
    if (appMadeStage && (student.status === "active" || student.status === "inactive")) {
      await db.update(studentsTable).set({ status: appMadeStage.key }).where(eq(studentsTable.id, student.id));
      // Event-driven portal enqueue: the new application was created at "inquiry"
      // but the student just entered a won stage — trigger immediately rather than
      // waiting for the next batch scan.
      void enqueueOnStageChange({
        applicationId:  application.id,
        studentId:      student.id,
        newStage:       appMadeStage.key,
        universityName: application.universityName ?? null,
        universityId:   application.universityId ?? null,
        actorUserId:    req.user!.id,
      });
    }
  } catch {}

  let commission = null;
  if (program.commissionRate && program.commissionRate > 0 && effectiveFee && effectiveFee > 0) {
    const universityCommAmount = Math.round((effectiveFee * program.commissionRate) / 100);
    const agentComm = await resolveAgentCommission(student.agentId, universityCommAmount);
    [commission] = await db.insert(commissionsTable).values({
      applicationId: application.id,
      studentId: student.id,
      agentId: agentComm.agentId,
      studentName,
      universityName: program.universityName,
      programName: program.name,
      isStateUniversity: ["public", "state"].includes((program.universityType ?? "").toLowerCase()),
      season: currentYear,
      currency: program.currency || "USD",
      programFee: String(effectiveFee),
      universityCommissionRate: String(program.commissionRate),
      universityCommissionAmount: String(universityCommAmount),
      universityCollected: "0",
      agentCommissionRate: agentComm.agentCommissionRate || "0",
      agentCommissionAmount: agentComm.agentCommissionAmount || "0",
      agentPaid: "0",
      subAgentId: agentComm.subAgentId,
      subAgentCommissionRate: agentComm.subAgentCommissionRate,
      subAgentCommissionAmount: agentComm.subAgentCommissionAmount,
      status: "potential",
      offsetAmount: "0",
    }).returning();
    await logAudit(req.user!.id, "create_commission", "commission", commission.id,
      { studentName, source: "course_finder_apply" }, req.ip);
  }

  let serviceFee = null;
  if (program.serviceFeeAmount && program.serviceFeeAmount > 0) {
    const total = program.serviceFeeAmount;
    const half = total / 2;
    [serviceFee] = await db.insert(serviceFeesTable).values({
      applicationId: application.id,
      studentId: student.id,
      agentId: student.agentId || null,
      studentName,
      universityName: program.universityName,
      isStateUniversity: ["public", "state"].includes((program.universityType ?? "").toLowerCase()),
      payerType: "student",
      season: currentYear,
      currency: program.currency || "USD",
      totalAmount: String(total),
      firstInstallmentAmount: String(half),
      firstInstallmentPaidAt: null,
      secondInstallmentAmount: String(half),
      secondInstallmentPaidAt: null,
      status: "pending",
    }).returning();
    await logAudit(req.user!.id, "create_service_fee", "service_fee", serviceFee.id,
      { studentName, source: "course_finder_apply" }, req.ip);
  }

  res.status(201).json({
    application,
    commission,
    serviceFee,
    status: "inquiry",
  });
});

router.get("/wishlists", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const rows = await db.select().from(wishlistsTable).where(eq(wishlistsTable.userId, userId));
  res.json(rows.map(r => r.programId));
});

router.get("/wishlists/details", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const rows = await db.select().from(wishlistsTable).where(eq(wishlistsTable.userId, userId));
  if (rows.length === 0) { res.json([]); return; }
  const programIds = rows.map(r => r.programId);
  const programs = await db
    .select({
      id: programsTable.id,
      name: programsTable.name,
      degree: programsTable.degree,
      language: programsTable.language,
      duration: programsTable.duration,
      tuitionFee: programsTable.tuitionFee,
      discountedFee: programsTable.discountedFee,
      currency: programsTable.currency,
      scholarship: programsTable.scholarship,
      intakes: programsTable.intakes,
      universityId: programsTable.universityId,
      universityName: universitiesTable.name,
      universityCountry: universitiesTable.country,
      universityCity: universitiesTable.city,
      universityLogo: universitiesTable.logoUrl,
    })
    .from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(inArray(programsTable.id, programIds));
  res.json(programs);
});

router.post("/wishlists", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const { programId } = req.body;
  if (!programId) { res.status(400).json({ error: "programId required" }); return; }
  try {
    const [row] = await db.insert(wishlistsTable).values({ userId, programId }).returning();
    res.status(201).json(row);
  } catch {
    res.status(409).json({ error: "Already in wishlist" });
  }
});

router.delete("/wishlists/:programId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const programId = parseInt(String(req.params.programId), 10);
  if (isNaN(programId)) { res.status(400).json({ error: "Invalid programId" }); return; }
  await db.delete(wishlistsTable)
    .where(and(eq(wishlistsTable.userId, userId), eq(wishlistsTable.programId, programId)));
  res.sendStatus(204);
});

export default router;
