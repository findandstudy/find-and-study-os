/**
 * portal-dry.ts — LOCAL dry-test CLI for portal submissions.
 *
 * Runs the SAME production adapter (lib/portal-adapters) the worker uses, via
 * the SAME runner orchestration (lib/portal-runner runSubmission) — but forces:
 *   - doSubmit = FALSE  (mode="dry": never performs the real final submit)
 *   - headless = FALSE  (visible browser, so it can be driven from a Mac on a
 *                        residential IP without Cloudflare / bot blocking)
 *
 * It pulls the student + documents from the DB/CRM exactly like the worker
 * (buildProfileFromApplication reuses the worker's profile-building core) and
 * resolves portal credentials DB-first with .env fallback (resolvePortalCreds).
 *
 * Usage:
 *   pnpm portal:dry <universityKey> <applicationId>
 *   pnpm portal:dry sabanci 2054
 *
 * Output: the full SubmitResult JSON + run meta + step logs. Expected terminal
 * states for a healthy dry run are `alreadyExists` or `dryReachedFinal`.
 *
 * Exit codes:
 *   0  — dry run completed (any SubmitResult)
 *   1  — bad args / no adapter / profile build / credential / run error
 */

import {
  resolveAdapterByKey,
  resolveAdapterForUniversity,
} from "@workspace/portal-adapters";
import {
  runSubmission,
  buildProfileFromApplication,
  resolveAdapterKey,
  getPortalExecutionVerification,
} from "@workspace/portal-runner";
import { resolvePortalCreds } from "../src/credResolver.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const [universityKey, appIdRaw] = process.argv.slice(2);

if (!universityKey || !appIdRaw) {
  console.error("Usage: pnpm portal:dry <universityKey> <applicationId>");
  console.error("Example: pnpm portal:dry sabanci 2054");
  process.exit(1);
}

const applicationId = parseInt(appIdRaw, 10);
if (Number.isNaN(applicationId)) {
  console.error(`Invalid applicationId: "${appIdRaw}" (must be a number)`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `[portal:dry] universityKey=${universityKey} applicationId=${applicationId}` +
    ` — DRY (doSubmit=false), VISIBLE browser (headless=false)`,
  );

  // ----- 1. Resolve adapter (mirrors the production runner semantics) -------
  // The runner resolves the adapter via portal_universities.adapter_key
  // (resolveAdapterKey), so aggregator keys map to their registered adapters
  // (study_in_turkey → sit, united_education → united). Mirror that here so the
  // CLI accepts an aggregator key, logs the real adapter, and loads creds under
  // it. Raw-key / name lookups remain as fallbacks for standalone portals.
  const { adapterKey, routedVia } = await resolveAdapterKey(universityKey);
  const adapter =
    (await resolveAdapterByKey(adapterKey)) ??
    (await resolveAdapterByKey(universityKey)) ??
    (await resolveAdapterForUniversity(universityKey));
  if (!adapter) {
    console.error(
      `[portal:dry] No adapter found for "${universityKey}". ` +
      `Check the universityKey spelling / portal_universities mapping.`,
    );
    process.exit(1);
  }
  console.log(`[portal:dry] adapter=${adapter.key} (${adapter.label})`);
  const verification = await getPortalExecutionVerification({
    universityKey: routedVia ?? universityKey,
    adapterKey,
  });
  if (
    verification?.testLoginPassed !== true ||
    verification.binding?.strictDryRunCapable !== true
  ) {
    console.error(
      "[portal:dry] Current Test Login evidence and a strict dry-run adapter are required.",
    );
    process.exit(1);
  }

  // ----- 2. Build profile + documents from the application (CRM/DB) ---------
  let profileResult: Awaited<ReturnType<typeof buildProfileFromApplication>>;
  try {
    profileResult = await buildProfileFromApplication(applicationId);
  } catch (err) {
    console.error(`[portal:dry] Profile build failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(
    `[portal:dry] profile — email=${profileResult.profile.email}` +
    ` program="${profileResult.profile.programName}"` +
    ` level="${profileResult.profile.level}"`,
  );
  console.log(
    `[portal:dry] docs — filled=[${profileResult.filledSlots.join(", ")}]` +
    ` missing=[${profileResult.missingSlots.join(", ")}]`,
  );

  // ----- 3. Resolve credentials (DB-first, .env fallback) ------------------
  let creds: Awaited<ReturnType<typeof resolvePortalCreds>>;
  try {
    creds = await resolvePortalCreds(routedVia ?? universityKey, adapter.key);
  } catch (err) {
    console.error(`[portal:dry] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(`[portal:dry] credentials resolved for user=${creds.user}`);

  // ----- 4. Run via the SAME runner orchestration, forced dry + visible ----
  let runResult: Awaited<ReturnType<typeof runSubmission>>;
  try {
    runResult = await runSubmission(
      {
        id: Date.now(), // synthetic id — used only for screenshot path naming
        universityKey,
        universityName: profileResult.profile.universityName ?? universityKey,
        mode: "dry", // forces doSubmit=false inside runSubmission
      },
      profileResult.profile,
      profileResult.files,
      profileResult.tempDir,
      creds,
      { headless: false }, // visible browser for local residential-IP testing
    );
  } catch (err) {
    console.error(`[portal:dry] Run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ----- 5. Print SubmitResult JSON + meta ---------------------------------
  console.log("\n=== SubmitResult ===");
  console.log(JSON.stringify(runResult.result, null, 2));
  console.log("\n=== meta ===");
  console.log(JSON.stringify(runResult.meta, null, 2));

  const r = runResult.result;
  console.log(
    `\n[portal:dry] DONE — submitted=${r.submitted}` +
    ` alreadyExists=${r.alreadyExists}` +
    ` programMissing=${r.programMissing}` +
    (r.detail ? ` detail="${r.detail}"` : ""),
  );

  // Always 0 on a completed dry run — the SubmitResult itself carries outcome.
  process.exit(0);
}

main().catch((err) => {
  console.error("[portal:dry] Fatal:", err);
  process.exit(1);
});
