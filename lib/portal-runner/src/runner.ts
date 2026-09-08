/**
 * runner.ts — orchestrates the adapter login + submit flow for a single
 * portal submission.
 *
 * Dry mode  — skips the final portal submit click (doSubmit=false) but still
 *             performs a real browser login and fills every form step.
 *             Credentials are therefore required for dry mode as well.
 *
 * Real mode — caller resolves credentials (DB-first, env fallback) and
 *             passes them as `creds`. The runner injects them into the
 *             adapter via setCredsOverride() before calling adapter.login(),
 *             then clears the override in finally.
 *
 * Screenshot flow:
 *   Adapters capture per-step screenshots and return local /tmp paths in
 *   result.screenshots.  The runner reads each file, uploads it to Object
 *   Storage (PRIVATE_OBJECT_DIR), and stores the persistent /objects/…
 *   reference in RunResult.screenshotUrls.  Upload failures are non-fatal
 *   (e.g. when PRIVATE_OBJECT_DIR is not configured in dev environments).
 *   Local /tmp screenshot files are cleaned up in the finally block.
 *
 * Memory discipline:
 *   - Screenshots are written directly to /tmp by the adapter (no PNG buffer
 *     held in the JS heap during submission). The runner reads one at a time
 *     for upload, then deletes the local file.
 *   - session.close() closes page → context → browser in order.
 *   - tempDir (containing downloaded document files) is deleted in finally.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveAdapterByKey,
  resolveAdapterForUniversity,
  setCredsOverride,
  clearCredsOverride,
  isSitMember,
  assertSubmitResultContract,
  evaluatePortalPreflight,
  evaluateSitSubmissionIdentityGate,
} from "@workspace/portal-adapters";
import type {
  SubmitResult,
  SubmitProfile,
  SubmitFiles,
} from "@workspace/portal-adapters";
import {
  uploadBufferToGcs,
  resolveObjectPaths,
} from "@workspace/object-storage";
import type { ClaimedSubmission } from "./queue.js";
import { loadProgramMapping } from "./programMappingLoader.js";
import { resolveNationalityExclusion } from "./exclusions.js";
import {
  resolveAdapterKey,
  loadAggregatorMemberNames,
} from "./resolveAdapter.js";
import {
  capturePortalRunEvidence,
  PortalRunError,
  type PortalRunEvidence,
} from "./portalEvidence.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedCreds {
  user: string;
  password: string;
}

export interface RunResult {
  result: SubmitResult;
  screenshotUrls: string[];
  /** PII-safe structural snapshot captured for an unproved terminal outcome. */
  portalEvidence?: PortalRunEvidence;
  /** Extra metadata (dryRun flag, adapter key used, etc.) */
  meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// runSubmission
// ---------------------------------------------------------------------------

/**
 * Runs the adapter flow for a claimed submission.
 *
 * @param submission  Claimed submission row (id, universityKey, mode …)
 * @param profile     Built student profile
 * @param files       Downloaded document paths
 * @param tempDir     Temp directory to clean up in finally
 * @param creds       Resolved portal credentials.  Required for BOTH real and
 *                    dry mode — dry mode still performs a full browser login
 *                    and form-fill smoke test; only the final submit click is
 *                    skipped.
 * @param opts        Optional run options. `headless` defaults to true so the
 *                    production worker behaviour is unchanged; the local
 *                    dry-test CLI passes `headless:false` to drive a visible
 *                    browser (residential IP, no Cloudflare/bot block).
 */
export async function runSubmission(
  submission: Pick<
    ClaimedSubmission,
    "id" | "universityKey" | "universityName" | "mode"
  >,
  profile: SubmitProfile,
  files: SubmitFiles,
  tempDir: string,
  creds?: ResolvedCreds,
  opts?: {
    headless?: boolean;
    adapterKey?: string;
    /** Program-mapping key override (multi-portal account key when routed). */
    programMappingKey?: string;
    /** Member catalog university id for member-level program overrides. */
    memberUniversityId?: number | null;
  },
): Promise<RunResult> {
  // ----- 0. Preventive nationality-exclusion check ------------------------
  // If the student's nationality is on this university's exclusive-region list
  // the application must go through a specific agency — skip the portal ENTIRELY
  // (no login, no submit) and surface a permanent exclusive_region result. This
  // fires for BOTH dry and real mode; the writeback maps it ahead of dry_run.
  const exclusion = await resolveNationalityExclusion(
    submission.universityKey,
    profile.nationality,
  );
  if (exclusion.excluded) {
    await cleanup(tempDir);
    return {
      result: {
        submitted: false,
        alreadyExists: false,
        programMissing: false,
        exclusiveRegion: true,
        ...(exclusion.agencyName
          ? { exclusiveAgency: exclusion.agencyName }
          : {}),
        detail: exclusion.agencyName
          ? `Exclusive bölge — ${exclusion.agencyName} üzerinden başvurulmalı`
          : "Exclusive bölge — acenta üzerinden başvurulmalı",
      },
      screenshotUrls: [],
      meta: { exclusionSkipped: true },
    };
  }

  // ----- 1. Resolve adapter -----------------------------------------------
  // Priority:
  //   1. opts.adapterKey — explicit override from a routed caller (junction /
  //      routes_via). Passed only when a redirect actually applies.
  //   2. resolveAdapterKey(universityKey).adapterKey — maps the submission's
  //      universityKey to its registered adapter via portal_universities.
  //      adapter_key. This is what makes AGGREGATOR keys resolve to their
  //      adapters (study_in_turkey → sit, united_education → united) and keeps
  //      member→aggregator precedence at the adapter level: a member submission
  //      arrives with universityKey=study_in_turkey and MUST pick "sit", never
  //      the member's standalone adapter (e.g. salesforce:atlas).
  //   3. raw universityKey — legacy fallback for standalone portals where
  //      universityKey === adapter_key (e.g. topkapi); byte-for-byte unchanged.
  //   4. universityName — last-resort name match.
  // Always resolve via DB (cheap, try/catched) — even when opts.adapterKey is
  // supplied by a caller that already routed — so `resolved.routedVia` is
  // available below for the aggregator dynamic-membership lookup regardless
  // of caller. This does not change adapter SELECTION (still opts.adapterKey
  // first) — it only widens what we know about the routing that occurred.
  const resolved = await resolveAdapterKey(submission.universityKey);
  const resolvedAdapterKey = opts?.adapterKey ?? resolved.adapterKey;

  const adapter =
    (await resolveAdapterByKey(resolvedAdapterKey)) ??
    (await resolveAdapterByKey(submission.universityKey)) ??
    (await resolveAdapterForUniversity(submission.universityName));

  if (!adapter) {
    await cleanup(tempDir);
    throw new Error(
      `NO_ADAPTER: no adapter found for key="${submission.universityKey}" / name="${submission.universityName}"`,
    );
  }

  // ----- 1.5 SIT membership enforcement -----------------------------------
  // Being in the SIT CATALOG is NOT the same as being a real SIT member for
  // FAS. Non-member universities (applied to DIRECTLY via their own panels,
  // e.g. Altınbaş / İstanbul Okan / Üsküdar) must NEVER have anything created
  // in SIT. Skip the portal ENTIRELY (no login, no student, no application) and
  // route them to the direct channel. Gated by SIT_ENFORCE_MEMBERSHIP (default
  // ON); set it to "false" for a one-off test run that processes every uni.
  // Dynamic DB "Members" list for aggregator adapters (united/sit). Sourced
  // from portal_account_universities under the aggregator's OWN key so the
  // panel's Members tab is the live source of truth: adding a university
  // there makes it recognized as a member immediately, no code deploy needed.
  // UNION'd with each adapter's static allowlist (never shrinks it) — a
  // transient DB failure (loadAggregatorMemberNames fails safe to []) degrades
  // to the pre-existing static behaviour instead of blocking known members.
  // Note: removing a university from the panel already stops routing to this
  // adapter upstream (resolveAdapterKey no longer returns "united"/"sit" for
  // it), independent of this list.
  let memberUniversities: string[] | undefined;
  if (adapter.key === "united" || adapter.key === "sit") {
    const aggregatorPortalKey = resolved.routedVia ?? submission.universityKey;
    memberUniversities = await loadAggregatorMemberNames(aggregatorPortalKey);
  }

  if (adapter.key === "sit" && process.env.SIT_ENFORCE_MEMBERSHIP !== "false") {
    const targetName =
      profile.universityName ?? submission.universityName ?? "";
    const member = isSitMember(targetName, memberUniversities);
    console.log(
      `[sit] membership: ${targetName || "(unknown)"} → member=${member} (route=${member ? "sit" : "direct"})`,
    );
    if (!member) {
      await cleanup(tempDir);
      return {
        result: {
          submitted: false,
          alreadyExists: false,
          programMissing: false,
          skippedNotMember: true,
          routeTo: "direct",
          detail: `SIT üyesi değil — doğrudan üniversite panelinden başvurulmalı ("${targetName}")`,
        },
        screenshotUrls: [],
        meta: { sitMembershipSkipped: true },
      };
    }
  }

  // ----- 2. Final browser-free readiness gate ------------------------------
  // API enqueue paths run the same preflight and may recover missing values
  // from documents first. Re-evaluate inside the runner as a defense-in-depth
  // boundary so stale/legacy queued rows still cannot open a portal with an
  // incomplete profile.
  const preflight = evaluatePortalPreflight({
    adapterKey: adapter.key,
    profile,
    files,
  });
  if (preflight.supported && !preflight.ready) {
    await cleanup(tempDir);
    throw new Error(
      `PORTAL_PREFLIGHT_NOT_READY: adapter=${adapter.key}` +
        ` missing=${preflight.missingFields.join(",") || "-"}` +
        ` incompatible=${preflight.incompatibleFields.map((issue) => issue.field).join(",") || "-"}` +
        ` documents=${preflight.missingDocuments.join(",") || "-"}`,
    );
  }

  if (adapter.key === "sit") {
    const identity = evaluateSitSubmissionIdentityGate(
      profile,
      profile.passportIdentityProof,
    );
    if (!identity.allowed) {
      await cleanup(tempDir);
      throw new Error(
        `SIT_IDENTITY_PROOF_FAILED: fields=${identity.fields.join(",") || "passportIdentityProof"}`,
      );
    }
    if (identity.verification === "unavailable") {
      console.warn(
        `[portal-runner] SIT passport proof unavailable for submission #${submission.id}; ` +
          "continuing after deterministic identity and document validation",
      );
    }
  }

  // ----- 3. Creds required for real mode; optional for dry (browser dry run) --
  const isDry = submission.mode !== "real";

  if (!isDry && !creds) {
    await cleanup(tempDir);
    throw new Error(
      `MISSING_CREDS: real mode requires resolved credentials for key="${submission.universityKey}"`,
    );
  }

  // ----- 4. Login + submit -------------------------------------------------
  // doSubmit=true for real mode; doSubmit=false for dry mode (fill form, no click)
  const localScreenshots: string[] = [];
  let session: Awaited<ReturnType<typeof adapter.login>> | null = null;

  if (creds) {
    setCredsOverride(adapter.key, {
      user: creds.user,
      password: creds.password,
    });
  }

  try {
    session = await adapter.login({ headless: opts?.headless ?? true });

    // Inject panel-managed mapping (synonyms / program & country overrides)
    // keyed by universityKey. Empty/missing row → fields omitted → the adapter
    // falls back to its built-in code defaults (no behaviour change). The DB
    // values, when present, are merged OVER the built-ins by the adapter.
    const mapping = await loadProgramMapping(
      opts?.programMappingKey ?? submission.universityKey,
      opts?.memberUniversityId ?? null,
    );
    const enrichedProfile: SubmitProfile = {
      ...profile,
      ...mapping,
      ...(memberUniversities !== undefined ? { memberUniversities } : {}),
    };

    const result = await adapter.submit(
      session,
      enrichedProfile,
      files,
      !isDry,
    );
    assertSubmitResultContract(adapter.key, result);
    const adapterError =
      typeof (result as SubmitResult & { error?: unknown }).error === "string"
        ? (result as SubmitResult & { error: string }).error
        : "";
    const terminalOutcomeProved =
      result.submitted ||
      result.alreadyExists ||
      result.programMissing ||
      result.programFull ||
      result.exclusiveRegion ||
      result.skippedNotMember;
    const portalEvidence =
      adapterError || (!isDry && !terminalOutcomeProved)
        ? await capturePortalRunEvidence(session.page, adapter.key)
        : null;

    // ----- 4. Upload per-step screenshots to Object Storage ----------------
    // Adapters write screenshots to /tmp and return local paths in
    // result.screenshots.  We upload each one and store the /objects/…
    // reference.  Non-fatal: if PRIVATE_OBJECT_DIR is not set (dev
    // environments) or upload fails, screenshotUrls is simply empty.
    const rawShots = result.screenshots ?? [];
    const persistentUrls: string[] = [];

    for (let i = 0; i < rawShots.length; i++) {
      const shotPath = rawShots[i];
      if (!shotPath) continue;
      localScreenshots.push(shotPath);
      try {
        const buffer = await fs.readFile(shotPath);
        const basename = path.basename(shotPath);
        const { gcsPath, objectsRef } = resolveObjectPaths(
          `portal-submissions/${submission.id}/${i}-${basename}`,
        );
        await uploadBufferToGcs({ gcsPath, buffer, contentType: "image/png" });
        persistentUrls.push(objectsRef);
      } catch {
        // Non-fatal — PRIVATE_OBJECT_DIR not set, GCS unavailable, etc.
      }
    }

    return {
      result,
      screenshotUrls: persistentUrls,
      ...(portalEvidence ? { portalEvidence } : {}),
      meta: {
        adapterKey: adapter.key,
        preflight,
        ...(isDry ? { dryRun: true } : {}),
      },
    };
  } catch (error) {
    const portalEvidence = session
      ? await capturePortalRunEvidence(session.page, adapter.key)
      : null;
    const message = error instanceof Error ? error.message : String(error);
    throw new PortalRunError(message, portalEvidence);
  } finally {
    if (creds) clearCredsOverride(adapter.key);
    // Close page → context → browser in order (see browser.ts)
    await session?.close().catch(() => {});
    await cleanup(tempDir);
    // Clean up local /tmp screenshot files written by the adapter
    for (const p of localScreenshots) {
      await fs.unlink(p).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function cleanup(tempDir: string): Promise<void> {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
}
