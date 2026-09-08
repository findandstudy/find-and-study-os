/**
 * fallback.ts — rule-based program-fallback (supersession) orchestrator.
 *
 * When a portal submission ends in status='program_full' ("Kontenjan Dolu") the
 * worker can fall back to an ordered list of alternative CRM programmes instead
 * of leaving the application stuck. This module:
 *
 *   1. Resolves the fallback rule for (portal university, source programme).
 *   2. Picks the FIRST fallback candidate whose resolved portal <option> value
 *      is OPEN (present + enabled) in the submission's meta.openPrograms.
 *   3. In a single transaction: cancels the old application, creates a NEW
 *      application on the fallback programme (fees/level/language copied from the
 *      fallback CATALOG, never from the old app), links them via
 *      superseded_from/by, and enqueues a portal submission for the new app.
 *   4. Writes an audit log and notifies the assigned consultant.
 *
 * Guards: kill-switch (portal_automation_settings.fallback_enabled), mode=real
 * only, idempotency (no duplicate supersession), loop-depth (max 2). When no
 * rule matches or every fallback is full/closed the submission is left in
 * program_full for a human to handle.
 *
 * IMPORTANT: lib/portal-runner cannot import from artifacts/api-server, so audit
 * + notification are written DIRECTLY via @workspace/db.
 */

import {
  db,
  applicationsTable,
  programsTable,
  portalSubmissionsTable,
  portalProgramFallbacksTable,
  portalAutomationSettingsTable,
  portalUniversitiesTable,
  auditLogsTable,
  notificationsTable,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  matchProgram,
  fold,
  parseTrack,
  levelGroup,
  type ProgramCandidate,
} from "@workspace/portal-adapters";
import { loadProgramMapping } from "./programMappingLoader.js";
import { createPortalSubmissionIntentFromSnapshot } from "./submissionIntent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Single portal <option> as persisted in portal_submissions.meta.openPrograms. */
export interface OpenProgram {
  value: string;
  name: string;
  enabled: boolean;
}

/**
 * Where a fallback candidate came from / its position in the ordered chain.
 *   - `rule`            : an admin fallback rule (portal_program_fallbacks).
 *   - `same_lang_fuzzy` : nearest same-language (L) fuzzy match (chain step 2).
 *   - `opposite_lang`   : the applied programme in the opposite language ¬L (step 3).
 */
export type FallbackRole = "rule" | "same_lang_fuzzy" | "opposite_lang";

/** A fallback CRM programme considered for selection. */
export interface FallbackCandidate {
  /** CRM programs.id */
  programId: number;
  /** CRM catalog programme name (used for fuzzy matching). */
  name: string;
  /** Chain role (undefined for the legacy rule path — treated as "rule"). */
  role?: FallbackRole;
}

export interface SelectedFallback {
  programId: number;
  /** The portal <option> value the candidate resolved to. */
  portalValue: string;
  /** The matched open-program entry. */
  open: OpenProgram;
  /** Chain role of the selected candidate (undefined for the rule path). */
  role?: FallbackRole;
}

/** Maximum supersession chain depth (loop guard). */
export const MAX_FALLBACK_DEPTH = 2;

// ---------------------------------------------------------------------------
// Pure candidate resolver (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Walk the ordered fallback candidates and return the first one whose resolved
 * portal value is OPEN (present + enabled) in `openPrograms`. Returns null when
 * none are open/closed-resolvable.
 *
 * Resolution per candidate is fully NAME-based (CRM program IDs are never
 * consulted): matchProgram applies University name map → General name map →
 * fuzzy against the portal options. The candidate is SELECTED only when the
 * resolved value's openPrograms entry has enabled=true. Order is preserved —
 * the first eligible candidate wins.
 */
export function selectFallbackCandidate(
  candidates: FallbackCandidate[],
  openPrograms: OpenProgram[],
  opts?: {
    nameMap?: Record<string, string>;
    nameMapGeneral?: Record<string, string>;
    synonyms?: string[][];
  },
): SelectedFallback | null {
  // Matcher candidates use the portal value as the id so a match resolves
  // straight to the <option> value.
  const matchCandidates: ProgramCandidate[] = openPrograms.map((o) => ({
    id:   o.value,
    name: o.name,
  }));

  for (const cand of candidates) {
    const portalValue = resolvePortalValue(cand, matchCandidates, opts);
    if (!portalValue) continue;

    const open = openPrograms.find((o) => o.value === portalValue);
    if (open && open.enabled) {
      return { programId: cand.programId, portalValue, open, role: cand.role };
    }
    // Resolved but full/closed → skip, try the next candidate.
  }
  return null;
}

function resolvePortalValue(
  cand: FallbackCandidate,
  matchCandidates: ProgramCandidate[],
  opts?: {
    nameMap?: Record<string, string>;
    nameMapGeneral?: Record<string, string>;
    synonyms?: string[][];
  },
): string | null {
  // Fully name-based: matchProgram resolves the CRM catalog name against the
  // portal options via University name map → General name map → fuzzy. CRM
  // program IDs are never used to pick a portal option.
  const m = matchProgram(cand.name, matchCandidates, {
    nameMap:        opts?.nameMap,
    nameMapGeneral: opts?.nameMapGeneral,
    synonyms:       opts?.synonyms,
  });
  return m ? m.match.id : null;
}

// ---------------------------------------------------------------------------
// generateProgramChain — pure ordered program+language fallback generator
// ---------------------------------------------------------------------------

/** One CRM catalog programme the generator ranks over. */
export interface CatalogEntry {
  programId: number;
  name: string;
  degree: string | null;
}

/**
 * Remove an explicit English/Turkish language marker from a programme name so
 * `parseTrack` on the result returns null. Used to build the STEP-3 query
 * (applied programme in the OPPOSITE language): matchProgram's own language
 * hard-filter drops opposite-track options when the QUERY declares a track, so
 * the applied name must be stripped before searching the opposite-language pool.
 * Turkish-aware (matches türkçe/turkce, ingilizce/i̇ngilizce).
 */
export function stripTrackMarker(name: string): string {
  return (name ?? "")
    // "- English" / "(Turkish)" / "( İngilizce" style markers.
    .replace(/[-(]\s*(?:english|i̇ngilizce|ingilizce|turkish|türkçe|turkce)\b\s*\)?/gi, " ")
    // "English medium" / "Turkish Medium".
    .replace(/\b(?:english|i̇ngilizce|ingilizce|turkish|türkçe|turkce)\s+medium\b/gi, " ")
    // Trailing "... English" / "... Türkçe" (with optional close paren).
    .replace(/\b(?:english|i̇ngilizce|ingilizce|turkish|türkçe|turkce)\s*\)?\s*$/gi, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fuzzy-pick the nearest catalog entry to `query` (null when nothing matches). */
function pickNearest(
  query: string,
  pool: CatalogEntry[],
  synonyms?: string[][],
): CatalogEntry | null {
  if (pool.length === 0 || !query.trim()) return null;
  const cands: ProgramCandidate[] = pool.map((p) => ({
    id:   String(p.programId),
    name: p.name,
  }));
  const m = matchProgram(query, cands, { synonyms });
  if (!m) return null;
  const id = Number(m.match.id);
  return pool.find((p) => p.programId === id) ?? null;
}

/**
 * Build the ORDERED automatic program+language fallback chain (steps 2 & 3).
 *
 * Step 1 is ALWAYS the existing original / fan-out submission (X1 = the exact
 * applied programme same-school in language L; Y1 = the applied programme's
 * nearest language-L match at the automation university) and is NOT produced
 * here — the caller excludes it via `excludeProgramIds`. Steps 2 & 3 are
 * identical for X (same-university) and Y (different-university):
 *
 *   step 2  same_lang_fuzzy — same-school, language L, nearest fuzzy to applied.
 *   step 3  opposite_lang   — the applied programme in the OPPOSITE language ¬L.
 *
 * Invariants:
 *   - LEVEL always matches (levelGroup(applied.level)); enforced on the pool.
 *   - L = parseTrack(applied.name). When L is null (no language marker) there is
 *     no opposite, so step 3 is skipped and step 2 applies no language filter.
 *   - Already-tried programmes (the whole chain so far, incl. step 1) are
 *     excluded so a hop never repeats a programme.
 *
 * Pure & deterministic: no DB, no side effects. Feed it the target-university
 * catalog and it returns the ranked candidate list (may be empty).
 */
export function generateProgramChain(
  applied: { name: string; level: string | null },
  catalog: CatalogEntry[],
  opts: { excludeProgramIds?: Set<number>; synonyms?: string[][] } = {},
): FallbackCandidate[] {
  const appliedName = applied.name ?? "";
  if (!appliedName.trim()) return [];

  const exclude = opts.excludeProgramIds ?? new Set<number>();
  const appliedLevel = levelGroup(applied.level);
  const L = parseTrack(appliedName);
  const opposite = L === "en" ? "tr" : L === "tr" ? "en" : null;

  // LEVEL ALWAYS MATCHES: same-level pool minus already-tried programmes.
  const sameLevel = catalog.filter(
    (p) => !exclude.has(p.programId) && levelGroup(p.degree) === appliedLevel,
  );

  const chain: FallbackCandidate[] = [];
  const used = new Set<number>(exclude);

  // Step 2 — same-school, language L, nearest fuzzy to the applied programme.
  const langLPool = sameLevel.filter(
    (p) => !used.has(p.programId) && (L === null || parseTrack(p.name) === L),
  );
  const step2 = pickNearest(appliedName, langLPool, opts.synonyms);
  if (step2) {
    chain.push({ programId: step2.programId, name: step2.name, role: "same_lang_fuzzy" });
    used.add(step2.programId);
  }

  // Step 3 — the applied programme in the OPPOSITE language ¬L. Skipped when the
  // applied programme carries no language marker (opposite is null).
  if (opposite) {
    const oppositePool = sameLevel.filter(
      (p) => !used.has(p.programId) && parseTrack(p.name) === opposite,
    );
    const step3 = pickNearest(stripTrackMarker(appliedName), oppositePool, opts.synonyms);
    if (step3) {
      chain.push({ programId: step3.programId, name: step3.name, role: "opposite_lang" });
      used.add(step3.programId);
    }
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type FallbackOutcome =
  | { status: "disabled" }
  | { status: "not_real_mode" }
  | { status: "wrong_status" }
  | { status: "no_meta" }
  | { status: "no_rule" }
  | { status: "no_open_fallback" }
  | { status: "loop_guard" }
  | { status: "already_superseded"; newApplicationId: number }
  | {
      status: "superseded";
      sourceApplicationId: number;
      newApplicationId: number;
      newSubmissionId: number;
      fallbackProgramId: number;
      /** Ordered-chain step (e.g. "X2"/"Y3"); null for the admin-rule path. */
      fallbackStep: string | null;
    };

// ---------------------------------------------------------------------------
// handleNeedsFallback — orchestrator entry point (aka handleProgramFull alias)
// ---------------------------------------------------------------------------

/**
 * Process a submission that NEEDS a program fallback and, when a rule applies,
 * supersede the source programme with the first open/available fallback.
 *
 * Two triggering statuses are handled identically:
 *   - `program_full`     ("Kontenjan Dolu")     → candidates from meta.openPrograms
 *   - `program_missing`  (not found in dropdown) → candidates from meta.availablePrograms
 * In both cases a candidate is eligible only when it resolves to an option that
 * is present AND enabled in the option list.
 *
 * Safe to call for ANY submission id — it self-gates on kill-switch, mode and
 * status and returns a no-op outcome otherwise. Never throws for business
 * no-ops; it only throws on unexpected DB failures (caller logs).
 *
 * @param submissionId  portal_submissions.id of the submission needing fallback.
 */
export async function handleNeedsFallback(
  submissionId: number,
): Promise<FallbackOutcome> {
  // ----- Kill-switch ------------------------------------------------------
  const [settings] = await db
    .select({ fallbackEnabled: portalAutomationSettingsTable.fallbackEnabled })
    .from(portalAutomationSettingsTable)
    .limit(1);
  if (!settings?.fallbackEnabled) {
    console.log(
      `[fallback] Submission #${submissionId}: kill-switch off (fallback_enabled=false) — no-op`,
    );
    return { status: "disabled" };
  }

  // ----- Load submission --------------------------------------------------
  const [sub] = await db
    .select({
      id:             portalSubmissionsTable.id,
      applicationId:  portalSubmissionsTable.applicationId,
      studentId:      portalSubmissionsTable.studentId,
      universityKey:  portalSubmissionsTable.universityKey,
      universityName: portalSubmissionsTable.universityName,
      adapterKey:     portalSubmissionsTable.adapterKey,
      mode:           portalSubmissionsTable.mode,
      status:         portalSubmissionsTable.status,
      meta:           portalSubmissionsTable.meta,
    })
    .from(portalSubmissionsTable)
    .where(eq(portalSubmissionsTable.id, submissionId));

  if (!sub) {
    console.error(`[fallback] Submission #${submissionId} not found`);
    return { status: "no_rule" };
  }

  // ----- mode=real guard (dry runs never supersede — test safety) ---------
  if (sub.mode !== "real") {
    console.log(
      `[fallback] Submission #${submissionId}: mode=${sub.mode} (not real) — no-op`,
    );
    return { status: "not_real_mode" };
  }

  // ----- status guard: only program_full or program_missing may supersede --
  if (sub.status !== "program_full" && sub.status !== "program_missing") {
    console.log(
      `[fallback] Submission #${submissionId}: status=${sub.status} (not program_full/program_missing) — no-op`,
    );
    return { status: "wrong_status" };
  }

  // Candidate option list: quota-full uses meta.openPrograms, "not in dropdown"
  // uses meta.availablePrograms. Both share the OpenProgram shape and are treated
  // identically (present + enabled = eligible). When neither is present the
  // dropdown was never reached → we don't know the alternatives, so no-op and
  // leave the submission for a human (prevents sending a wrong programme).
  const meta = (sub.meta ?? {}) as {
    openPrograms?: OpenProgram[];
    availablePrograms?: OpenProgram[];
    resolution?: string;
  };
  // Defense in depth (must match worker + stageWriteback gating exactly): a
  // program_missing submission may only supersede when the dropdown was actually
  // reached (resolution="not_in_dropdown"). Any other program_missing cause means
  // the alternatives are unknown → never guess a fallback.
  if (sub.status === "program_missing" && meta.resolution !== "not_in_dropdown") {
    console.log(
      `[fallback] Submission #${submissionId}: program_missing resolution=${meta.resolution ?? "none"} (not not_in_dropdown) — no-op`,
    );
    return { status: "no_meta" };
  }
  const optionList = Array.isArray(meta.openPrograms)
    ? meta.openPrograms
    : Array.isArray(meta.availablePrograms)
      ? meta.availablePrograms
      : [];
  if (optionList.length === 0) {
    console.log(
      `[fallback] Submission #${submissionId}: no openPrograms/availablePrograms in meta — no-op`,
    );
    return { status: "no_meta" };
  }

  // ----- Load source application ------------------------------------------
  const [srcApp] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, sub.applicationId));

  if (!srcApp || srcApp.programId == null) {
    console.log(
      `[fallback] Submission #${submissionId}: source app missing / no programId — no-op`,
    );
    return { status: "no_rule" };
  }

  // ----- Loop guard: count supersession chain depth -----------------------
  const depth = await chainDepth(srcApp.id);
  if (depth >= MAX_FALLBACK_DEPTH) {
    console.log(
      `[fallback] Submission #${submissionId}: chain depth ${depth} >= ${MAX_FALLBACK_DEPTH} — loop guard, no-op`,
    );
    return { status: "loop_guard" };
  }

  // ----- Resolve the applied programme + same/different-university (X/Y) ----
  // The MAIN application carries the originally-applied programme: its name →
  // language L (parseTrack) and its level (levelGroup) drive the chain. For a
  // same-university (X) chain the main app IS the source; for a
  // different-university (Y) chain it is the original app at the applied
  // university, linked via main_application_id (legacy: superseded_from root).
  const mainApp = await resolveMainApplication(srcApp);
  const isSameUniversity = mainApp.universityId === srcApp.universityId;

  // Panel-managed name mappings + synonyms (University > General) — shared by
  // both the admin-rule and the automatic paths.
  const mapping = await loadProgramMapping(sub.universityKey);

  // ----- Resolve the fallback rule (admin rule WINS over automatic) --------
  const [rule] = await db
    .select({
      fallbackProgramIds: portalProgramFallbacksTable.fallbackProgramIds,
      autoSubmit:         portalProgramFallbacksTable.autoSubmit,
    })
    .from(portalProgramFallbacksTable)
    .where(
      and(
        eq(portalProgramFallbacksTable.universityKey, sub.universityKey),
        eq(portalProgramFallbacksTable.sourceProgramId, srcApp.programId),
        eq(portalProgramFallbacksTable.enabled, true),
        isNull(portalProgramFallbacksTable.deletedAt),
      ),
    );

  let candidates: FallbackCandidate[];
  let programsById: Map<number, CatalogProgram>;
  let matchSource: "rule" | "auto";
  let ruleAutoSubmit = false;

  if (rule && Array.isArray(rule.fallbackProgramIds) && rule.fallbackProgramIds.length > 0) {
    // --- Admin rule path (PRECEDENCE): ordered explicit fallback programmes.
    matchSource = "rule";
    ruleAutoSubmit = rule.autoSubmit;
    programsById = await loadProgramsOrdered(rule.fallbackProgramIds);
    candidates = rule.fallbackProgramIds
      .map((id) => {
        const p = programsById.get(id);
        return p ? { programId: id, name: p.name } : null;
      })
      .filter((c): c is FallbackCandidate => c !== null);
  } else {
    // --- Automatic ordered program+language chain (no admin rule). Only runs
    //     because the kill-switch (fallback_enabled) is ON — that IS the
    //     "Automatic program fallback" toggle. Steps 2 & 3 are generated from
    //     the applied programme; step 1 (the existing submission) is excluded so
    //     it is never re-attempted.
    matchSource = "auto";
    const catalog = await loadUniversityCatalog(srcApp.universityId);
    programsById = new Map(catalog.map((p) => [p.id, p]));

    // Programmes already tried at THIS university (walk superseded_from). The
    // root's programme is step 1; the whole set is filtered out below.
    const { tried, rootProgramId } = await collectTargetChain(srcApp);
    const genExclude = new Set<number>();
    if (rootProgramId != null) genExclude.add(rootProgramId);

    const fullChain = generateProgramChain(
      {
        name:  mainApp.programName ?? srcApp.programName ?? "",
        level: mainApp.level ?? srcApp.level ?? null,
      },
      catalog.map((p) => ({ programId: p.id, name: p.name, degree: p.degree })),
      { excludeProgramIds: genExclude, synonyms: mapping.programSynonyms },
    );
    // Never re-attempt a programme already tried anywhere in the chain.
    candidates = fullChain.filter((c) => !tried.has(c.programId));

    if (candidates.length === 0) {
      console.log(
        `[fallback] Submission #${submissionId}: automatic chain produced no untried candidate ` +
          `for uni=${sub.universityKey} (applied="${mainApp.programName ?? ""}") — kept`,
      );
      return { status: "no_rule" };
    }
  }

  const selected = selectFallbackCandidate(candidates, optionList, {
    nameMap:        mapping.programNameMap,
    nameMapGeneral: mapping.programNameMapGeneral,
    synonyms:       mapping.programSynonyms,
  });

  if (!selected) {
    console.log(
      `[fallback] Submission #${submissionId}: all ${matchSource} fallbacks full/closed/unresolvable — kept`,
    );
    return { status: "no_open_fallback" };
  }

  const fallbackProgram = programsById.get(selected.programId)!;

  // Chain step label for surfacing on the board (X/Y = same/different university,
  // 2/3 = same-language-fuzzy / opposite-language). Null for the admin-rule path.
  const stepLabel = selected.role
    ? `${isSameUniversity ? "X" : "Y"}${selected.role === "same_lang_fuzzy" ? "2" : "3"}`
    : null;

  // ----- Supersession transaction -----------------------------------------
  // Idempotency + concurrency safety: a tx-scoped advisory lock keyed on the
  // source application id serializes concurrent handlers for the same app, and
  // the "already superseded" recheck runs INSIDE the lock so a second caller
  // observes the first caller's committed child and no-ops instead of creating
  // a duplicate supersession.
  // Admin rule: dry unless autoSubmit. Automatic chain: always follow the source
  // mode (real) so each hop actually attempts submission — "stop on first fully-
  // successful" requires live attempts, not staged dry runs.
  const newMode = matchSource === "rule" ? (ruleAutoSubmit ? sub.mode : "dry") : sub.mode;
  const triggerReason =
    sub.status === "program_missing"
      ? "Program portalda bulunamadı"
      : "Kontenjan dolu";
  const reason = `${triggerReason} — ${srcApp.programName ?? srcApp.programId} → ${fallbackProgram.name}`;
  const [portalUniversity] = await db
    .select({
      id: portalUniversitiesTable.id,
      universityKey: portalUniversitiesTable.universityKey,
      adapterKey: portalUniversitiesTable.adapterKey,
      verificationGeneration: portalUniversitiesTable.verificationGeneration,
    })
    .from(portalUniversitiesTable)
    .where(and(
      eq(portalUniversitiesTable.universityKey, sub.universityKey),
      isNull(portalUniversitiesTable.deletedAt),
    ))
    .limit(1);
  if (!portalUniversity) return { status: "no_rule" };

  const txResult = await db.transaction(async (tx) => {
    const now = new Date();

    // Serialize on the source application id (xact lock auto-released on commit).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${srcApp.id})`);

    // Idempotency recheck under the lock: short-circuit if THIS source app has
    // already been superseded to ANY program (not only this fallback program).
    const [existing] = await tx
      .select({ id: applicationsTable.id })
      .from(applicationsTable)
      .where(eq(applicationsTable.supersededFromApplicationId, srcApp.id));
    if (existing) {
      console.log(
        `[fallback] Submission #${submissionId}: already superseded src #${srcApp.id} → app #${existing.id} — idempotent no-op`,
      );
      return { alreadySuperseded: true as const, newAppId: existing.id, newSubId: 0 };
    }

    // a. Cancel the old application.
    await tx
      .update(applicationsTable)
      .set({
        stage:          "cancelled",
        supersedeReason: reason,
        updatedAt:      now,
      })
      .where(eq(applicationsTable.id, srcApp.id));

    // b. Create the new application on the fallback programme. Fees / level /
    //    language come from the fallback CATALOG (never copied from the old app
    //    so a wrong fee can't carry over). Catalog gaps stay null.
    const [newApp] = await tx
      .insert(applicationsTable)
      .values({
        studentId:           srcApp.studentId,
        leadId:              srcApp.leadId,
        programId:           selected.programId,
        universityId:        srcApp.universityId,
        agentId:             srcApp.agentId,
        assignedToId:        srcApp.assignedToId,
        season:              srcApp.season,
        intake:              srcApp.intake,
        stage:               "inquiry",
        level:               fallbackProgram.degree ?? null,
        instructionLanguage: fallbackProgram.language ?? null,
        programName:         fallbackProgram.name,
        universityName:      srcApp.universityName,
        country:             srcApp.country,
        tuitionFee:          fallbackProgram.tuitionFee ?? null,
        discountedFee:       fallbackProgram.discountedFee ?? null,
        scholarship:         fallbackProgram.scholarship ?? null,
        commissionRate:      fallbackProgram.commissionRate ?? null,
        serviceFeeAmount:    fallbackProgram.serviceFeeAmount ?? null,
        applicationFee:      fallbackProgram.applicationFee ?? null,
        depositFee:          fallbackProgram.depositFee ?? null,
        advancedFee:         fallbackProgram.advancedFee ?? null,
        languageFee:         fallbackProgram.languageFee ?? null,
        currency:            fallbackProgram.currency ?? null,
        // Origin attribution copied verbatim from the source application.
        originType:          srcApp.originType,
        originEntityType:    srcApp.originEntityType,
        originEntityId:      srcApp.originEntityId,
        originDisplayName:   srcApp.originDisplayName,
        originLocked:        srcApp.originLocked,
        originStudentId:     srcApp.originStudentId,
        branchId:            srcApp.branchId,
        supersededFromApplicationId: srcApp.id,
        // Keep every hop pointing at the true chain root so the next hop can
        // recover the originally-applied programme/language/level and X-vs-Y.
        mainApplicationId:   srcApp.mainApplicationId ?? srcApp.id,
        // Auto-created supersession (backup-programme) fallback = automation.
        createdSource:       "automation",
        createdAt:           now,
        updatedAt:           now,
      })
      .returning({
        id: applicationsTable.id,
        universityId: applicationsTable.universityId,
        programId: applicationsTable.programId,
        intake: applicationsTable.intake,
        season: applicationsTable.season,
      });

    const intent = createPortalSubmissionIntentFromSnapshot({
      application: newApp,
      portalUniversity,
      targetCatalogUniversityId: srcApp.universityId,
      source: "fallback",
    });

    // c. Back-link the old application to the new one.
    await tx
      .update(applicationsTable)
      .set({ supersededByApplicationId: newApp.id, updatedAt: now })
      .where(eq(applicationsTable.id, srcApp.id));

    // d. Enqueue a portal submission for the new application.
    const [newSub] = await tx
      .insert(portalSubmissionsTable)
      .values({
        applicationId:  newApp.id,
        studentId:      srcApp.studentId,
        universityKey:  sub.universityKey,
        universityName: sub.universityName,
        // Same portal as the source submission → same adapter (graduation count).
        adapterKey:     sub.adapterKey ?? null,
        mode:           newMode,
        status:         "queued",
        submitIntentKey: intent.submitIntentKey,
        targetIdentitySha256: intent.targetIdentitySha256,
        targetIdentity: intent.targetIdentity,
        submissionAction: "submit",
        meta:           {
          note:          `auto-fallback from #${srcApp.id}`,
          fallbackSource: matchSource,
          // Ordered-chain surfacing (null for the admin-rule path).
          fallbackStep:  stepLabel,
          fallbackRole:  selected.role ?? null,
          sameUniversity: matchSource === "auto" ? isSameUniversity : null,
        },
      })
      .returning({ id: portalSubmissionsTable.id });

    // e. Audit.
    await tx.insert(auditLogsTable).values({
      userId:     null,
      action:     "program_fallback_supersede",
      resource:   "application",
      resourceId: srcApp.id,
      changes:    JSON.stringify({
        fromApplicationId:  srcApp.id,
        toApplicationId:    newApp.id,
        sourceProgramId:    srcApp.programId,
        fallbackProgramId:  selected.programId,
        portalValue:        selected.portalValue,
        newSubmissionId:    newSub.id,
        newSubmissionMode:  newMode,
        fallbackSource:     matchSource,
        fallbackStep:       stepLabel,
        fallbackRole:       selected.role ?? null,
        sameUniversity:     matchSource === "auto" ? isSameUniversity : null,
        mainApplicationId:  srcApp.mainApplicationId ?? srcApp.id,
        reason,
      }),
    });

    return { alreadySuperseded: false as const, newAppId: newApp.id, newSubId: newSub.id };
  });

  if (txResult.alreadySuperseded) {
    return { status: "already_superseded", newApplicationId: txResult.newAppId };
  }

  const { newAppId, newSubId } = txResult;

  console.log(
    `[fallback] Submission #${submissionId}: superseded app #${srcApp.id} → #${newAppId} ` +
      `(program ${selected.programId}, portal value ${selected.portalValue}); ` +
      `new submission #${newSubId} mode=${newMode} queued`,
  );

  // ----- Notify the assigned consultant (best-effort, after commit) -------
  if (srcApp.assignedToId) {
    try {
      await db.insert(notificationsTable).values({
        userId:    srcApp.assignedToId,
        type:      "program_fallback",
        title:     sub.status === "program_missing"
                     ? "Program portalda açık değil — otomatik yedeklendi"
                     : "Program kontenjanı dolu — otomatik yedeklendi",
        body:      sub.status === "program_missing"
                     ? `Öğrencinin programı portalda açık değil; ${fallbackProgram.name} programına otomatik taşındı ve gönderim kuyruğa alındı.`
                     : `Öğrencinin programı kontenjan dolu; ${fallbackProgram.name} programına otomatik taşındı ve gönderim kuyruğa alındı.`,
        icon:      "Repeat",
        actionUrl: `/applications/${newAppId}`,
        data:      {
          i18nKey:           "notifications.programFallback",
          fromApplicationId: srcApp.id,
          toApplicationId:   newAppId,
          fallbackProgram:   fallbackProgram.name,
          fallbackStep:      stepLabel,
        },
      });
    } catch (err) {
      console.error("[fallback] Notification insert failed (non-fatal):", err);
    }
  }

  return {
    status:              "superseded",
    sourceApplicationId: srcApp.id,
    newApplicationId:    newAppId,
    newSubmissionId:     newSubId,
    fallbackProgramId:   selected.programId,
    fallbackStep:        stepLabel,
  };
}

/**
 * Back-compat alias. The orchestrator entry point was originally named
 * `handleProgramFull` (quota-full only). It now also handles program_missing
 * ("not in dropdown"), so the canonical name is `handleNeedsFallback`. Existing
 * callers/tests may keep using `handleProgramFull`.
 */
export const handleProgramFull = handleNeedsFallback;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CatalogProgram = typeof programsTable.$inferSelect;

/** Load fallback catalog programmes keyed by id (order preserved by caller). */
async function loadProgramsOrdered(
  ids: number[],
): Promise<Map<number, CatalogProgram>> {
  const out = new Map<number, CatalogProgram>();
  if (ids.length === 0) return out;
  const rows = await db.select().from(programsTable);
  const want = new Set(ids);
  for (const r of rows) {
    if (want.has(r.id)) out.set(r.id, r);
  }
  return out;
}

type CatalogApp = typeof applicationsTable.$inferSelect;

/**
 * Resolve the MAIN application of `srcApp`'s fallback chain — the row carrying
 * the originally-applied programme (name → language L, level). The explicit
 * `main_application_id` link wins (set on fan-out + supersession children);
 * legacy rows without it fall back to walking `superseded_from` to the root.
 * Never returns null (worst case: `srcApp` itself for a standalone app).
 */
async function resolveMainApplication(srcApp: CatalogApp): Promise<CatalogApp> {
  if (srcApp.mainApplicationId != null && srcApp.mainApplicationId !== srcApp.id) {
    const [m] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, srcApp.mainApplicationId));
    if (m) return m;
  }
  // Legacy: walk superseded_from to the chain root.
  let cursor: CatalogApp = srcApp;
  const visited = new Set<number>([cursor.id]);
  let steps = 0;
  while (
    cursor.supersededFromApplicationId != null &&
    !visited.has(cursor.supersededFromApplicationId) &&
    steps <= MAX_FALLBACK_DEPTH + 2
  ) {
    const [parent] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, cursor.supersededFromApplicationId));
    if (!parent) break;
    visited.add(parent.id);
    cursor = parent;
    steps += 1;
  }
  return cursor;
}

/** Active catalog programmes for one university (empty when id is null). */
async function loadUniversityCatalog(
  universityId: number | null,
): Promise<CatalogProgram[]> {
  if (universityId == null) return [];
  return db
    .select()
    .from(programsTable)
    .where(
      and(
        eq(programsTable.universityId, universityId),
        eq(programsTable.isActive, true),
      ),
    );
}

/**
 * Walk the `superseded_from` chain up from `srcApp` (within the SAME target
 * university) and collect every programme id already attempted, plus the ROOT
 * programme id (step 1 at this university). Cycle-safe & depth-capped.
 */
async function collectTargetChain(
  srcApp: CatalogApp,
): Promise<{ tried: Set<number>; rootProgramId: number | null }> {
  const tried = new Set<number>();
  const visited = new Set<number>();
  let cursor: CatalogApp | null = srcApp;
  let rootProgramId: number | null = srcApp.programId ?? null;
  let steps = 0;
  while (cursor && !visited.has(cursor.id) && steps <= MAX_FALLBACK_DEPTH + 2) {
    visited.add(cursor.id);
    if (cursor.programId != null) tried.add(cursor.programId);
    rootProgramId = cursor.programId ?? rootProgramId;
    if (cursor.supersededFromApplicationId == null) break;
    const [parent]: CatalogApp[] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, cursor.supersededFromApplicationId));
    if (!parent) break;
    cursor = parent;
    steps += 1;
  }
  return { tried, rootProgramId };
}

/**
 * Count how many supersession hops led to `appId` by walking the
 * superseded_from_application_id chain upward. A fresh (non-superseded) app has
 * depth 0. Cycle-safe (visited set, capped iterations).
 */
async function chainDepth(appId: number): Promise<number> {
  let depth = 0;
  let cursor: number | null = appId;
  const visited = new Set<number>();
  while (cursor != null && !visited.has(cursor) && depth <= MAX_FALLBACK_DEPTH + 1) {
    visited.add(cursor);
    const [row]: { from: number | null }[] = await db
      .select({ from: applicationsTable.supersededFromApplicationId })
      .from(applicationsTable)
      .where(eq(applicationsTable.id, cursor));
    if (!row || row.from == null) break;
    depth += 1;
    cursor = row.from;
  }
  return depth;
}
