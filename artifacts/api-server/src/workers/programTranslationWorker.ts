import { pool } from "@workspace/db";
import {
  programTranslationWorkerEnabled,
  startProgramTranslationWorker,
} from "../lib/programTranslationWorker";

if (!programTranslationWorkerEnabled()) {
  throw new Error("PROGRAM_TRANSLATION_WORKER_DISABLED");
}

const stop = startProgramTranslationWorker();
let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  stop();
  // A claimed provider request is bounded to 60 seconds. The database commit
  // itself is source-hash guarded, so an interrupted request can safely be
  // reclaimed when its lease expires.
  await pool.end();
}

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
