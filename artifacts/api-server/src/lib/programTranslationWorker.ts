import crypto from "node:crypto";
import {
  ProgramTranslationValidationError,
} from "./programTranslationContract";
import {
  claimProgramTranslation,
  completeProgramTranslation,
  failProgramTranslation,
} from "./programTranslationQueue";
import {
  ProgramTranslationProviderError,
  translateProgramContent,
} from "./programTranslationProvider";

const POLL_MS = 500;
let started = false;
let inFlight = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export function programTranslationWorkerEnabled(
  raw = process.env.PROGRAM_TRANSLATION_WORKER_ENABLED,
): boolean {
  if (raw === "true") return true;
  if (raw === undefined || raw === "false") return false;
  console.warn(`[program-translations] Invalid PROGRAM_TRANSLATION_WORKER_ENABLED=${JSON.stringify(raw)}; disabled`);
  return false;
}

export function programTranslationConcurrency(
  raw = process.env.PROGRAM_TRANSLATION_CONCURRENCY,
): number {
  if (raw === undefined || raw === "") return 2;
  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 8) return parsed;
  console.warn(`[program-translations] Invalid PROGRAM_TRANSLATION_CONCURRENCY=${JSON.stringify(raw)}; using 1`);
  return 1;
}

function classifyError(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof ProgramTranslationProviderError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (error instanceof ProgramTranslationValidationError) {
    const providerOutputError = error.code.startsWith("provider_");
    return { code: error.code, retryable: providerOutputError };
  }
  return { code: "translation_unexpected_error", retryable: true };
}

async function runOnce(workerId: string): Promise<void> {
  const job = await claimProgramTranslation(workerId);
  if (!job) return;
  try {
    const result = await translateProgramContent(job.locale, job.source);
    const committed = await completeProgramTranslation(job, workerId, result.content, result.provider);
    if (!committed) {
      console.info("[program-translations] stale result discarded", {
        programId: job.programId,
        locale: job.locale,
      });
    }
  } catch (error) {
    const failure = classifyError(error);
    await failProgramTranslation(job, workerId, failure.code, failure.retryable);
    console.warn("[program-translations] job failed", {
      programId: job.programId,
      locale: job.locale,
      attempt: job.attempts,
      code: failure.code,
    });
  }
}

export function startProgramTranslationWorker(): () => void {
  if (started || !programTranslationWorkerEnabled()) return () => {};
  started = true;
  const concurrency = programTranslationConcurrency();
  const workerId = `program-translation-${process.pid}-${crypto.randomUUID()}`;
  const tick = () => {
    while (inFlight < concurrency) {
      inFlight += 1;
      void runOnce(workerId).finally(() => { inFlight -= 1; });
    }
  };
  timer = setInterval(tick, POLL_MS);
  tick();
  console.log(`[program-translations] worker started concurrency=${concurrency}`);
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
    console.log("[program-translations] worker stopped");
  };
}
