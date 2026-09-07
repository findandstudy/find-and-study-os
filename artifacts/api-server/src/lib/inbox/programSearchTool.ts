// AI Agent Faz 1 — live program-search tool. Gives the intake bot a
// `searchPrograms` Anthropic tool that queries the SAME program/university
// data the Course Finder page shows (reuses buildProgramFacetConditions from
// routes/course-finder.ts — no parallel query logic), scoped to whatever
// country/university-type restriction admins configured (knowledge_sources
// program_scope row, mirrored on AiAgentConfig.programScope).
//
// Security posture: this tool is READ-ONLY (SELECT only, no writes), the
// model can only pass filter values (never raw SQL), and every search is
// hard-intersected with the admin-configured scope server-side — the model
// cannot widen scope by asking for it. Results are capped and only expose
// student-safe fields (no internal commission/contact data — mirrors the
// non-staff sanitization already used by GET /course-finder).
import { db, programsTable, programTranslationsTable, universitiesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { buildProgramFacetConditions } from "../../routes/course-finder";
import { isProgramSearchToolEnabled } from "./knowledgeSources";
import type { ProgramScope } from "./aiAgentConfig";
import { normalizeProgramSearchInput } from "./programSearchIntent";
import { normalizeProgramLocale } from "../programTranslationContract";

export const SEARCH_PROGRAMS_TOOL_NAME = "searchPrograms";
const MAX_RESULTS = 8;

export const searchProgramsToolDefinition = {
  name: SEARCH_PROGRAMS_TOOL_NAME,
  description:
    "Search the live, currently-active university program catalog. Use this whenever the student asks about specific programs, universities, countries, tuition, discounted, deposit and language-course fees, intake dates, duration, or availability — never invent program names, prices, or availability from memory. Returns at most a handful of the best-matching real programs. If it returns no results, tell the student you could not find a matching program and ask a clarifying question instead of guessing.",
  input_schema: {
    type: "object" as const,
    properties: {
      country: {
        type: "string",
        description: "Country name to filter by (e.g. 'Turkey'). Omit to search all allowed countries.",
      },
      city: {
        type: "string",
        description: "City name to filter by (e.g. 'Istanbul'). Optional.",
      },
      universityType: {
        type: "string",
        description: "University type filter, e.g. 'state' or 'private'. Omit to search all allowed types.",
      },
      level: {
        type: "string",
        description: "Study level / degree the student wants, e.g. 'Bachelor', 'Master', 'PhD'. Optional.",
      },
      language: {
        type: "string",
        description: "Language of instruction, e.g. 'English' or 'Turkish'. Optional.",
      },
      field: {
        type: "string",
        description: "Field / department / program the student wants, e.g. 'Computer Engineering', 'Medicine', 'Business'. Matched loosely against program field, program name and degree — pass the program name the student uses; you do NOT need to know an exact taxonomy. Optional.",
      },
      feeMax: {
        type: "number",
        description: "Maximum yearly tuition fee the student can afford, in the program's listed currency. Optional.",
      },
      search: {
        type: "string",
        description: "Free-text search across program and university names. Optional.",
      },
    },
    required: [] as string[],
  },
};

export interface SearchProgramsToolInput {
  country?: string;
  city?: string;
  universityType?: string;
  level?: string;
  language?: string;
  field?: string;
  feeMax?: number;
  search?: string;
}

export interface EnforcedProgramFilters {
  country?: string;
  city?: string;
  universityType?: string;
  level?: string;
  language?: string;
  field?: string;
}

export interface SearchProgramsResultRow {
  id: number;
  name: string;
  description: string | null;
  degree: string | null;
  field: string | null;
  language: string | null;
  duration: string | null;
  tuitionFee: number | null;
  discountedFee: number | null;
  depositFee: number | null;
  languageFee: number | null;
  currency: string | null;
  scholarship: number | null;
  intakes: string | null;
  requirements: string | null;
  universityName: string;
  universityCountry: string | null;
  universityCity: string | null;
  universityType: string | null;
}

export interface SearchProgramsToolOutput {
  disabled: boolean;
  count: number;
  results: SearchProgramsResultRow[];
}

/**
 * Intersect the model-requested value(s) with the admin-configured scope for
 * one axis (country or universityType). "all" scope = no restriction. When the
 * request and scope share no overlap, returns an impossible sentinel so the
 * query yields zero rows rather than silently ignoring the scope.
 */
function intersectWithScope(requested: string | undefined, scope: string[] | "all"): string | undefined {
  if (scope === "all") return requested;
  if (!requested) return scope.join(",");
  const requestedVals = requested.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowed = scope.filter((s) => requestedVals.includes(s.toLowerCase()));
  return allowed.length ? allowed.join(",") : "__no_match__";
}

/**
 * Execute the searchPrograms tool call. Fails CLOSED: when the tool is
 * disabled (master toggle off, or the knowledge_sources row missing/inactive)
 * it returns `disabled: true` with zero results instead of throwing, so a
 * tool-use turn always has SOMETHING to hand back to the model.
 */
export async function executeSearchProgramsTool(
  input: SearchProgramsToolInput,
  enforcedUniversityIds?: number[],
  aiBotId?: number | null,
  enforcedFilters?: EnforcedProgramFilters,
  requestedLocale?: string,
): Promise<SearchProgramsToolOutput> {
  const { enabled, scope } = await isProgramSearchToolEnabled(aiBotId);
  if (!enabled) {
    return { disabled: true, count: 0, results: [] };
  }

  const normalizedInput = normalizeProgramSearchInput(input, enforcedUniversityIds);
  const requestedWhere = buildProgramFacetConditions(
    scopedParams(normalizedInput, scope),
    undefined,
    { fuzzyField: true },
  );
  const hardScopeParams = enforcedScopeParams(enforcedUniversityIds, enforcedFilters);
  const hardScopeWhere = hardScopeParams
    ? buildProgramFacetConditions(hardScopeParams)
    : undefined;
  const where = requestedWhere && hardScopeWhere
    ? and(requestedWhere, hardScopeWhere)
    : hardScopeWhere ?? requestedWhere;
  const contentLocale = normalizeProgramLocale(requestedLocale);

  const rows = await db
    .select({
      id: programsTable.id,
      name: sql<string>`COALESCE(${programTranslationsTable.name}, ${programsTable.name})`,
      description: sql<string | null>`COALESCE(${programTranslationsTable.description}, ${programsTable.description})`,
      degree: programsTable.degree,
      field: sql<string | null>`COALESCE(${programTranslationsTable.field}, ${programsTable.field})`,
      language: programsTable.language,
      duration: sql<string | null>`COALESCE(${programTranslationsTable.duration}, ${programsTable.duration})`,
      tuitionFee: programsTable.tuitionFee,
      discountedFee: programsTable.discountedFee,
      depositFee: programsTable.depositFee,
      languageFee: programsTable.languageFee,
      currency: programsTable.currency,
      scholarship: programsTable.scholarship,
      intakes: sql<string | null>`COALESCE(${programTranslationsTable.intakes}, ${programsTable.intakes})`,
      requirements: sql<string | null>`COALESCE(${programTranslationsTable.requirements}, ${programsTable.requirements})`,
      universityName: universitiesTable.name,
      universityCountry: universitiesTable.country,
      universityCity: universitiesTable.city,
      universityType: universitiesTable.universityType,
    })
    .from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .leftJoin(programTranslationsTable, and(
      eq(programTranslationsTable.programId, programsTable.id),
      eq(programTranslationsTable.locale, contentLocale),
      eq(programTranslationsTable.status, "published"),
    ))
    .where(where)
    .orderBy(universitiesTable.name, programsTable.name)
    .limit(MAX_RESULTS);

  return { disabled: false, count: rows.length, results: rows };
}

function scopedParams(
  input: SearchProgramsToolInput,
  scope: ProgramScope,
): Record<string, string | undefined> {
  const country = intersectWithScope(input.country, scope.countries);
  const universityType = intersectWithScope(input.universityType, scope.universityTypes);
  return {
    country,
    city: input.city,
    universityType,
    universityId: undefined,
    level: input.level,
    language: input.language,
    field: input.field,
    feeMin: undefined,
    feeMax: typeof input.feeMax === "number" && Number.isFinite(input.feeMax) ? String(input.feeMax) : undefined,
    search: input.search,
  };
}

function enforcedScopeParams(
  enforcedUniversityIds?: number[],
  enforcedFilters?: EnforcedProgramFilters,
): Record<string, string | undefined> | null {
  const universityIds = Array.from(new Set(
    (enforcedUniversityIds || []).filter((id) => Number.isInteger(id) && id > 0),
  ));
  const clean = (value: string | undefined) => {
    const normalized = value?.trim();
    return normalized || undefined;
  };
  const params = {
    country: clean(enforcedFilters?.country),
    city: clean(enforcedFilters?.city),
    universityType: clean(enforcedFilters?.universityType),
    universityId: universityIds.length ? universityIds.join(",") : undefined,
    level: clean(enforcedFilters?.level),
    language: clean(enforcedFilters?.language),
    field: clean(enforcedFilters?.field),
    feeMin: undefined,
    feeMax: undefined,
    search: undefined,
  };
  return Object.values(params).some(Boolean) ? params : null;
}
