import { customFetch } from "@workspace/api-client-react";

type PortalWorkerJobSnapshot = {
  status: "queued" | "running" | "succeeded" | "failed" | "dead_letter" | "canceled";
  lastErrorCode: string | null;
  result: { verificationOutcome?: "PASSED" | "FAILED" } | null;
};

type AcceptedPortalWorkerJob = {
  accepted: true;
  jobId: number;
  requestKey: string;
  replay: boolean;
  statusUrl: string;
};

const TERMINAL_FAILURES = new Set(["failed", "dead_letter", "canceled"]);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPortalTestLoginJob(
  portalUniversityId: number,
  requestKey = crypto.randomUUID(),
): Promise<"PASSED" | "FAILED"> {
  const accepted = await customFetch<AcceptedPortalWorkerJob>(
    `/api/portal-universities/${portalUniversityId}/test-login`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestKey }),
    },
  );

  // A browser login is capped at 30 seconds. Keep a bounded poll window while
  // allowing a short queue wait, and never retry the command with a new key.
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const job = await customFetch<PortalWorkerJobSnapshot>(accepted.statusUrl);
    if (job.status === "succeeded") {
      return job.result?.verificationOutcome === "PASSED" ? "PASSED" : "FAILED";
    }
    if (TERMINAL_FAILURES.has(job.status)) {
      throw new Error(job.lastErrorCode ?? "PORTAL_WORKER_JOB_FAILED");
    }
    await wait(1_000);
  }
  throw new Error("PORTAL_WORKER_JOB_TIMEOUT");
}
