import {
  normalizeSocialRuntimeId,
  resolveSocialProviderConnectionGate,
  socialPerformanceIntervalMs,
  socialPerformanceMaxAgeDays,
} from "../lib/socialOperationsContract";
import { withSocialOperationsContext } from "../lib/socialOperationsStore";
import {
  claimSocialPerformance,
  completeSocialPerformance,
  socialPerformanceIdempotencyKey,
} from "../lib/socialPerformanceQueue";
import {
  assertSocialPublisherConfiguration,
  fetchSocialPerformance,
  socialPublisherFailureFromThrown,
} from "../lib/socialPublisherAdapter";

const enabled =
  process.env.SOCIAL_PERFORMANCE_WORKER_ENABLED?.trim().toLowerCase() ===
  "true";
if (!enabled) throw new Error("SOCIAL_PERFORMANCE_WORKER_DISABLED");
const gate = resolveSocialProviderConnectionGate({
  connectivityEnabled: process.env.SOCIAL_PROVIDER_CONNECTIVITY_ENABLED,
  allowLiveIntegrations: process.env.ALLOW_LIVE_INTEGRATIONS,
  providerAllowlist: process.env.SOCIAL_PUBLICATION_PROVIDER_ALLOWLIST,
});
if (!gate.enabled)
  throw new Error(gate.reason ?? "SOCIAL_PROVIDER_CONNECTIVITY_DISABLED");
assertSocialPublisherConfiguration();
socialPerformanceIntervalMs(
  process.env.SOCIAL_PERFORMANCE_SYNC_INTERVAL_SECONDS,
);
socialPerformanceMaxAgeDays(
  process.env.SOCIAL_PERFORMANCE_MAX_PUBLICATION_AGE_DAYS,
);

const legacyUserId = Number(
  process.env.SOCIAL_PERFORMANCE_WORKER_LEGACY_USER_ID,
);
if (!Number.isSafeInteger(legacyUserId) || legacyUserId <= 0)
  throw new Error("SOCIAL_PERFORMANCE_WORKER_USER_INVALID");
const workerId = normalizeSocialRuntimeId(
  process.env.SOCIAL_PERFORMANCE_WORKER_ID ?? "",
);
const runtimeReleaseId = normalizeSocialRuntimeId(
  process.env.RELEASE_ID ?? process.env.GIT_COMMIT ?? "",
);
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

while (!stopping) {
  const claim = await withSocialOperationsContext(
    legacyUserId,
    "manage",
    (client, context) => claimSocialPerformance(client, context, workerId),
  );
  if (!claim) {
    await delay(5_000);
    continue;
  }
  const result = await fetchSocialPerformance({
    idempotencyKey: socialPerformanceIdempotencyKey(claim),
    publicationId: claim.publicationId,
    provider: claim.provider,
    accountKey: claim.accountKey,
    integrationKey: claim.integrationKey,
  }).catch(socialPublisherFailureFromThrown);
  await withSocialOperationsContext(legacyUserId, "manage", (client, context) =>
    completeSocialPerformance(
      client,
      context,
      claim,
      workerId,
      runtimeReleaseId,
      result,
    ),
  );
}
