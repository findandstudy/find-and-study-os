import express from "express";
import app from "./app";
import { db, pool, usersTable, integrationsTable, applicationsTable, commissionsTable, serviceFeesTable, studentsTable, agentsTable, pipelineStagesTable } from "@workspace/db";
import { eq, isNull, and, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { getCsrfCookieOptions } from "./lib/cookieOptions";
import { getCurrentSeason } from "./lib/season";
import { seedDocumentTypes } from "./scripts/seedDocumentTypes";
import { seedCurrencies } from "./scripts/seedCurrencies";
import { HARDCODED_EXTRACTOR_FIELDS, HARDCODED_EXTRACTOR_RULES } from "./lib/aiDefaultConfigs";
import { seedAiAgentConfig } from "./lib/inbox/aiAgentConfig";
import { seedProgramScopeSource } from "./lib/inbox/knowledgeSources";
import { renderLlmsText } from "@workspace/corporate-facts";

const isProd = process.env.NODE_ENV === "production";

const llmsText = renderLlmsText();
app.get(["/llms.txt", "/.well-known/llms.txt"], (_req, res) => {
  res
    .type("text/plain; charset=utf-8")
    .set("Cache-Control", "public, max-age=3600")
    .send(llmsText);
});

type FatalShutdown = (reason: string, exitCode: number) => Promise<void>;
let fatalShutdown: FatalShutdown | null = null;

function handleFatalProcessError(reason: string, error: unknown): void {
  console.error(`[fatal] ${reason}:`, error);
  if (fatalShutdown) {
    void fatalShutdown(reason, 1);
    return;
  }
  // Failure before HTTP/bootstrap completion cannot be drained safely.
  process.exit(1);
}

process.once("unhandledRejection", (reason) => {
  handleFatalProcessError("Unhandled promise rejection", reason);
});
process.once("uncaughtException", (err) => {
  handleFatalProcessError("Uncaught exception", err);
});

function getSeedDir(): string {
  try {
    if (typeof __dirname !== "undefined") return __dirname;
  } catch {}
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {}
  return process.cwd();
}
const seedDir = getSeedDir();

async function ensurePgEnumValue(typeName: string, value: string): Promise<void> {
  // Both values are internal constants, but keep the dynamic DDL construction
  // fail-closed so this helper can never become an injection primitive.
  if (!/^[a-z][a-z0-9_]*$/.test(typeName) || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error("Invalid PostgreSQL enum identifier");
  }
  const existing = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typname = $1 AND e.enumlabel = $2
     ) AS exists`,
    [typeName, value],
  );
  if (existing.rows[0]?.exists) return;
  try {
    await pool.query(`ALTER TYPE "public"."${typeName}" ADD VALUE IF NOT EXISTS '${value}'`);
  } catch (err: any) {
    // Production commonly connects with a restricted app role while the enum
    // is owned by the migration role. Do not abort the rest of the idempotent
    // startup migration block; emit one precise warning for operator action.
    if (err?.code === "42501") {
      console.warn(`[migrate] enum value requires owner: ${typeName}.${value}`);
      return;
    }
    throw err;
  }
}

async function ensureSuperAdmin() {
  if (isProd) return;
  const seedPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!seedPassword) return;
  try {
    const email = "en@findandstudy.com";
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
    if (!existing) {
      const hash = await bcrypt.hash(seedPassword, 10);
      await db.insert(usersTable).values({
        replitId: "local-admin",
        email,
        firstName: "Find",
        lastName: "Study",
        role: "super_admin",
        passwordHash: hash,
        isActive: true,
        language: "en",
      });
      console.log("[seed] Super admin created");
    }
  } catch (err) {
    console.error("[seed] ensureSuperAdmin error:", err);
  }
}

async function ensureAgentUser() {
  if (isProd) return;
  const seedPassword = process.env.SEED_AGENT_PASSWORD;
  if (!seedPassword) return;
  try {
    const email = "omar@agent.com";
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
    if (!existing) {
      const hash = await bcrypt.hash(seedPassword, 10);
      await db.insert(usersTable).values({
        replitId: "local-agent",
        email,
        firstName: "Omar",
        lastName: "Hassan",
        role: "agent",
        passwordHash: hash,
        isActive: true,
        language: "en",
      });
      console.log("[seed] Agent user created");
    }
  } catch (err) {
    console.error("[seed] ensureAgentUser error:", err);
  }
}

async function runSeedSQL() {
  if (isProd) return;
  try {
    const seedPath = path.join(seedDir, "seed.sql");
    if (!fs.existsSync(seedPath)) {
      console.log("[seed] No seed.sql found, skipping");
      return;
    }
    const sql = fs.readFileSync(seedPath, "utf8");
    const statements = sql.split(";").map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith("--"));
    let inserted = 0;
    for (const stmt of statements) {
      try {
        const res = await pool.query(stmt);
        if (res.rowCount && res.rowCount > 0) inserted++;
      } catch (err: any) {
        if (!err.message?.includes("duplicate") && !err.message?.includes("already exists")) {
          console.error("[seed] SQL error:", err.message, "stmt:", stmt.substring(0, 80));
        }
      }
    }
    if (inserted > 0) console.log(`[seed] Inserted ${inserted} records from seed.sql`);
  } catch (err) {
    console.error("[seed] runSeedSQL error:", err);
  }
}

async function linkAgentUser() {
  if (isProd) return;
  try {
    const [agentUser] = await db.select().from(usersTable).where(eq(usersTable.email, "omar@agent.com"));
    if (agentUser) {
      await pool.query(
        `UPDATE agents SET user_id = $1 WHERE email = 'omar@agent.com' AND (user_id IS NULL OR user_id != $1)`,
        [agentUser.id]
      );
    }
  } catch (err) {
    console.error("[seed] linkAgentUser error:", err);
  }
}

function serveStaticFrontend() {
  if (!isProd) return;

  const distPath = process.env.FRONTEND_DIST_PATH
    || path.resolve(getSeedDir(), "..", "..", "edcons", "dist", "public");

  if (!fs.existsSync(distPath)) {
    console.warn(`[static] Frontend dist not found at ${distPath}, skipping static serving`);
    return;
  }

  app.use(
    "/assets",
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      next();
    },
    express.static(path.join(distPath, "assets"))
  );

  app.use(express.static(distPath, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  }));

  app.get("/{*splat}", (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith("/api")) return next();
    // Guarantee the SPA always carries a CSRF cookie before it issues ANY
    // unsafe (POST/PUT/PATCH/DELETE) request. Otherwise a freshly-loaded
    // client that hasn't yet made a cookie-setting /api GET — e.g. an agent
    // landing straight on the contract-signing screen from a cached session —
    // would POST without the double-submit token and get a silent 403. The
    // client (customFetch / csrfSetup) only attaches x-csrf-token when this
    // cookie is readable, so it must exist by the time the page renders.
    if (
      !(req as any).cookies?.csrf_token &&
      !(req as express.Request & { csrfCookieIssued?: boolean }).csrfCookieIssued
    ) {
      const token = crypto.randomBytes(32).toString("hex");
      res.cookie("csrf_token", token, getCsrfCookieOptions(req, 7 * 24 * 60 * 60 * 1000));
    }
    const indexPath = path.join(distPath, "index.html");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(indexPath);
  });

  console.log(`[static] Serving frontend from ${distPath}`);
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function backfillConversationChannel() {
  try {
    const result = await pool.query(
      `UPDATE conversations SET channel = 'internal' WHERE channel IS NULL`
    );
    const count = result.rowCount || 0;
    if (count > 0) {
      console.log(`[backfill] Set channel='internal' on ${count} conversations with NULL channel`);
    }
  } catch (err) {
    console.error("[backfill] backfillConversationChannel error:", err);
  }
}

async function backfillMissingCommissions() {
  try {
    const { resolveAgentCommission } = await import("./lib/agentCommission");
    const { getCommissionFinanceStatus, getServiceFeeFinanceStatus } = await import("./lib/stageFinance");

    const appsWithoutComm = await db
      .select({
        id: applicationsTable.id,
        studentId: applicationsTable.studentId,
        agentId: applicationsTable.agentId,
        stage: applicationsTable.stage,
        tuitionFee: applicationsTable.tuitionFee,
        discountedFee: applicationsTable.discountedFee,
        commissionRate: applicationsTable.commissionRate,
        serviceFeeAmount: applicationsTable.serviceFeeAmount,
        universityName: applicationsTable.universityName,
        programName: applicationsTable.programName,
        season: applicationsTable.season,
        currency: applicationsTable.currency,
      })
      .from(applicationsTable)
      .where(
        and(
          isNull(applicationsTable.deletedAt),
          sql`NOT EXISTS (SELECT 1 FROM commissions WHERE commissions.application_id = ${applicationsTable.id})`
        )
      );

    let created = 0;
    for (const app of appsWithoutComm) {
      const commStatus = await getCommissionFinanceStatus(app.stage);
      if (commStatus === "excluded") continue;

      const baseFee = (app.discountedFee != null && !isNaN(app.discountedFee))
        ? app.discountedFee : app.tuitionFee;
      const uCommAmt = baseFee && app.commissionRate
        ? (baseFee * app.commissionRate) / 100 : 0;

      const [studentRec] = await db.select({ firstName: studentsTable.firstName, lastName: studentsTable.lastName })
        .from(studentsTable).where(eq(studentsTable.id, app.studentId));
      const sName = studentRec ? `${studentRec.firstName || ""} ${studentRec.lastName || ""}`.trim() : null;

      const agentComm = await resolveAgentCommission(app.agentId, uCommAmt);

      await db.insert(commissionsTable).values({
        applicationId: app.id,
        studentId: app.studentId,
        agentId: agentComm.agentId,
        studentName: sName,
        universityName: app.universityName || null,
        programName: app.programName || null,
        season: app.season || (await getCurrentSeason()),
        currency: app.currency || "USD",
        status: commStatus,
        programFee: baseFee ? String(baseFee) : null,
        universityCommissionRate: app.commissionRate ? String(app.commissionRate) : null,
        universityCommissionAmount: uCommAmt > 0 ? String(uCommAmt) : null,
        agentCommissionRate: agentComm.agentCommissionRate,
        agentCommissionAmount: agentComm.agentCommissionAmount,
        subAgentId: agentComm.subAgentId,
        subAgentCommissionRate: agentComm.subAgentCommissionRate,
        subAgentCommissionAmount: agentComm.subAgentCommissionAmount,
      });
      created++;
    }

    const commsWithoutAgent = await db.select().from(commissionsTable)
      .where(
        and(
          sql`${commissionsTable.agentId} IS NOT NULL`,
          sql`(${commissionsTable.agentCommissionRate} IS NULL OR CAST(${commissionsTable.agentCommissionRate} AS numeric) = 0 OR ${commissionsTable.agentCommissionAmount} IS NULL OR CAST(${commissionsTable.agentCommissionAmount} AS numeric) = 0)`,
          sql`${commissionsTable.universityCommissionAmount} IS NOT NULL`,
          sql`CAST(${commissionsTable.universityCommissionAmount} AS numeric) > 0`
        )
      );

    let updated = 0;
    for (const comm of commsWithoutAgent) {
      const uAmount = parseFloat(String(comm.universityCommissionAmount ?? "0")) || 0;
      if (uAmount <= 0) continue;
      const agentComm = await resolveAgentCommission(comm.agentId, uAmount);
      await db.update(commissionsTable).set({
        agentId: agentComm.agentId,
        agentCommissionRate: agentComm.agentCommissionRate,
        agentCommissionAmount: agentComm.agentCommissionAmount,
        subAgentId: agentComm.subAgentId,
        subAgentCommissionRate: agentComm.subAgentCommissionRate,
        subAgentCommissionAmount: agentComm.subAgentCommissionAmount,
      }).where(eq(commissionsTable.id, comm.id));
      updated++;
    }

    if (created > 0 || updated > 0) {
      console.log(`[backfill] Created ${created} missing commission records, updated ${updated} existing records with agent rates`);
    }
  } catch (err) {
    console.error("[backfill] backfillMissingCommissions error:", err);
  }
}

async function backfillStudentAppStatus() {
  try {
    const [appMadeStage] = await db.select({ key: pipelineStagesTable.key })
      .from(pipelineStagesTable)
      .where(and(eq(pipelineStagesTable.entityType, "student"), eq(pipelineStagesTable.variant, "won")));
    if (!appMadeStage) return;

    const result = await db.execute(sql`
      UPDATE students SET status = ${appMadeStage.key}
      WHERE id IN (
        SELECT DISTINCT s.id FROM students s
        JOIN applications a ON a.student_id = s.id
        WHERE s.status IN ('active', 'inactive')
      )
    `);
    const count = (result as any)?.rowCount || 0;
    if (count > 0) {
      console.log(`[backfill] Updated ${count} student(s) with applications to '${appMadeStage.key}' status`);
    }
  } catch (err) {
    console.error("[backfill] backfillStudentAppStatus error:", err);
  }
}

async function backfillLeadConversion() {
  // Past public-form / embed flows didn't always promote a lead when the
  // applicant later completed full apply. Reconcile retroactively: any lead
  // whose email matches a student that already has at least one application
  // should be marked converted and linked. Idempotent — only touches rows
  // that are still in a pre-converted state OR missing the link.
  try {
    const result = await db.execute(sql`
      UPDATE leads l
      SET status = 'converted',
          converted_student_id = sub.student_id,
          updated_at = NOW()
      FROM (
        SELECT DISTINCT ON (LOWER(s.email)) LOWER(s.email) AS email_key, s.id AS student_id
        FROM students s
        WHERE s.email IS NOT NULL
          AND s.email <> ''
          AND s.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM applications a WHERE a.student_id = s.id AND a.deleted_at IS NULL)
        ORDER BY LOWER(s.email), s.created_at ASC
      ) sub
      WHERE LOWER(l.email) = sub.email_key
        AND (l.status <> 'converted' OR l.converted_student_id IS NULL)
    `);
    const count = (result as any)?.rowCount || 0;
    if (count > 0) {
      console.log(`[backfill] Linked ${count} historical lead(s) to existing students with applications (status=converted)`);
    }
  } catch (err) {
    console.error("[backfill] backfillLeadConversion error:", err);
  }
}

async function backfillStudentPhotoFlags() {
  // Repair the denormalized students.has_photo + photo_url from the actual
  // photo/photograph documents. The flag previously drifted false for photos
  // that carried only fileData (legacy uploads, public-apply, embed widget),
  // which hid the avatar on every list/kanban/Student Detail surface that gates
  // on the flag. has_photo must mirror EXACTLY what GET /api/students/:id/photo
  // would serve: it takes the LATEST photo/photograph doc and serves it only
  // when that doc has a file_key, file_data, or an http(s) file_url (a data:/
  // file: url is rejected 422 by the SSRF guard). Runs on every boot (outside
  // the bootstrap lock) so it heals existing/prod data; WHERE-guarded so only
  // drifted rows are written.
  try {
    const result = await db.execute(sql`
      UPDATE students s
      SET has_photo = sub.hp,
          photo_url = CASE WHEN sub.hp THEN '/api/students/' || s.id || '/photo' ELSE NULL END
      FROM (
        SELECT s2.id,
          COALESCE((
            SELECT (
              (d.file_key IS NOT NULL AND d.file_key <> '')
              OR (d.file_data IS NOT NULL AND d.file_data <> '')
              OR (d.file_url ~* '^https?://')
            )
            FROM documents d
            WHERE d.student_id = s2.id
              AND d.type IN ('photo', 'photograph')
              AND d.deleted_at IS NULL
            ORDER BY d.created_at DESC
            LIMIT 1
          ), false) AS hp
        FROM students s2
        WHERE s2.deleted_at IS NULL
      ) sub
      WHERE sub.id = s.id
        AND (
          s.has_photo IS DISTINCT FROM sub.hp
          OR (sub.hp AND s.photo_url IS DISTINCT FROM '/api/students/' || s.id || '/photo')
          OR (NOT sub.hp AND s.photo_url IS NOT NULL)
        )
    `);
    const count = (result as any)?.rowCount || 0;
    if (count > 0) {
      console.log(`[backfill] Resynced has_photo/photo_url for ${count} student(s)`);
    }
  } catch (err) {
    console.error("[backfill] backfillStudentPhotoFlags error:", err);
  }
}

async function backfillWaOutExternalContacts() {
  // Merge placeholder "wa_out:<digits>" external_contacts with their real
  // counterparts that were created when the student actually replied via
  // WhatsApp.  Without this, the CRM-initiated conversation and the real inbound
  // conversation sit in two separate rows and the right-panel tabs (STUDENT /
  // APPLICATION / DOCUMENTS) show "No student linked" for the real conversation.
  //
  // Runs on EVERY boot (idempotent — once the wa_out rows are gone there's
  // nothing left to merge).
  try {
    // Step 1: find all (wa_out contact, real contact) pairs for the same
    // channel + phone_e164.
    const { rows } = await pool.query(`
      SELECT
        wo.id           AS wa_out_id,
        rc.id           AS real_id,
        wo.lead_id      AS wa_lead_id,
        wo.student_id   AS wa_student_id,
        wo.agent_id     AS wa_agent_id,
        rc.lead_id      AS real_lead_id,
        rc.student_id   AS real_student_id,
        rc.agent_id     AS real_agent_id
      FROM external_contacts wo
      JOIN external_contacts rc
        ON  rc.channel    = wo.channel
        AND rc.phone_e164 = wo.phone_e164
        AND rc.id        <> wo.id
        AND rc.external_id NOT LIKE 'wa\\_out:%'
      WHERE wo.external_id LIKE 'wa\\_out:%'
        AND wo.phone_e164 IS NOT NULL
      ORDER BY wo.id
    `);

    let mergedCount = 0;
    for (const pair of rows as Array<{
      wa_out_id: number; real_id: number;
      wa_lead_id: number | null; wa_student_id: number | null; wa_agent_id: number | null;
      real_lead_id: number | null; real_student_id: number | null; real_agent_id: number | null;
    }>) {
      try {
        // Step 2: copy entity links to the real contact if it's missing them.
        const setFields: string[] = [];
        if (!pair.real_lead_id    && pair.wa_lead_id)    setFields.push(`lead_id    = ${pair.wa_lead_id}`);
        if (!pair.real_student_id && pair.wa_student_id) setFields.push(`student_id = ${pair.wa_student_id}`);
        if (!pair.real_agent_id   && pair.wa_agent_id)   setFields.push(`agent_id   = ${pair.wa_agent_id}`);
        if (setFields.length > 0) {
          await pool.query(`UPDATE external_contacts SET ${setFields.join(", ")} WHERE id = $1`, [pair.real_id]);
        }

        // Step 3: For each conversation that belongs to the wa_out contact,
        // find the best matching real conversation and merge messages into it.
        const { rows: waConvs } = await pool.query<{ id: number; channel_account_id: number | null }>(
          `SELECT id, channel_account_id FROM conversations WHERE external_contact_id = $1`,
          [pair.wa_out_id]
        );
        for (const waConv of waConvs) {
          const caFilter = waConv.channel_account_id != null
            ? `AND channel_account_id = ${waConv.channel_account_id}`
            : `AND channel_account_id IS NULL`;
          const { rows: realConvs } = await pool.query<{ id: number }>(
            `SELECT id FROM conversations
             WHERE external_contact_id = $1 ${caFilter}
             ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
            [pair.real_id]
          );
          if (realConvs.length > 0) {
            const realConvId = realConvs[0].id;
            // Move messages from the wa_out conversation into the real one.
            await pool.query(
              `UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2`,
              [realConvId, waConv.id]
            );
            // Move conversation_participants (ignore conflicts with real conv participants).
            // Use only the universally-present columns to stay schema-agnostic.
            await pool.query(
              `INSERT INTO conversation_participants (conversation_id, user_id, last_read_at)
               SELECT $1, user_id, last_read_at
               FROM   conversation_participants
               WHERE  conversation_id = $2
               ON CONFLICT (conversation_id, user_id) DO NOTHING`,
              [realConvId, waConv.id]
            );
          }
          // Delete participants then the wa_out conversation (FK safe now).
          await pool.query(`DELETE FROM conversation_participants WHERE conversation_id = $1`, [waConv.id]);
          await pool.query(`DELETE FROM conversations WHERE id = $1`, [waConv.id]);
        }

        // Step 4: delete the now-orphaned wa_out external_contact.
        await pool.query(`DELETE FROM external_contacts WHERE id = $1`, [pair.wa_out_id]);
        mergedCount++;
      } catch (pairErr) {
        console.error(
          `[backfill] wa_out merge failed for pair (wa_out=${pair.wa_out_id} → real=${pair.real_id}):`,
          pairErr
        );
      }
    }
    if (mergedCount > 0) {
      console.log(`[backfill] Merged ${mergedCount} wa_out: duplicate external_contact pair(s) into their real counterparts`);
    }
  } catch (err) {
    console.error("[backfill] backfillWaOutExternalContacts error:", err);
  }
}

async function seedClaudeIntegration() {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (!envKey) return;
  try {
    const [existing] = await db.select().from(integrationsTable).where(eq(integrationsTable.key, "claude"));
    if (!existing) {
      await db.insert(integrationsTable).values({
        key: "claude",
        name: "Anthropic Claude",
        category: "ai",
        isEnabled: true,
        config: { apiKey: envKey },
      });
      console.log("[seed] Anthropic Claude integration seeded from ANTHROPIC_API_KEY env var");
    }
  } catch (err) {
    console.error("[seed] seedClaudeIntegration error:", err);
  }
}

(async () => {
  // Retained temporarily for migration archaeology only. Normal API boot must
  // never mutate schema, seed data or run backfills. Reviewed SQL under
  // lib/db/drizzle is the sole migration authority.
  if (false) {
  // Step 1: Create system_flags table — runs on all processes, idempotent.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_flags (
      key TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Step 1c: General-purpose key-value store for persisting system state across
  // restarts (e.g. assignment consistency checker last-known count for delta
  // alerting). Runs unconditionally on all processes so the table always exists
  // before any worker that reads from it starts.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Step 2: Create rate-limits table — runs on all processes, idempotent.
  const { ensureRateLimitsTable } = await import("./lib/pgRateLimiter");
  await ensureRateLimitsTable();

  // Step 1b: Object ownership bindings for storage access control (Task #314).
  // Records who uploaded each object so the generic download endpoint can
  // authorize access without trusting self-writable reference fields (IDOR fix).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS object_owners (
        object_key TEXT PRIMARY KEY,
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        source_priority INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Resumable backfill marker: a single completion row written only after the
    // whole backfill finishes. Using a marker (instead of "table is empty")
    // makes the backfill safe to resume — a run interrupted after partial
    // inserts simply re-runs on the next boot (inserts are idempotent via
    // ON CONFLICT DO NOTHING), so a partial run can never leave permanent gaps.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS object_owners_backfill (
        id INTEGER PRIMARY KEY DEFAULT 1,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Upgrade path: when source_priority is being added to a PRE-EXISTING table,
    // its legacy rows have unknown provenance. Marking them with DEFAULT 0 would
    // (wrongly) make them look like authoritative upload-time bindings that
    // neither a backfill retry nor a real upload could ever correct. Instead,
    // tag legacy rows as the weakest priority (INT_MAX) and clear the completion
    // marker so the backfill re-runs once and supersedes them with properly
    // ranked bindings. A fresh CREATE already has the column, so this DO block is
    // a no-op there. Idempotent: the guard skips entirely once the column exists.
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'object_owners' AND column_name = 'source_priority'
        ) THEN
          ALTER TABLE object_owners ADD COLUMN source_priority INTEGER;
          UPDATE object_owners SET source_priority = 2147483647 WHERE source_priority IS NULL;
          ALTER TABLE object_owners ALTER COLUMN source_priority SET DEFAULT 0;
          ALTER TABLE object_owners ALTER COLUMN source_priority SET NOT NULL;
          DELETE FROM object_owners_backfill;
        END IF;
      END $$;
    `);

    // Backfill from authoritative references so EXISTING objects are protected
    // too — the download endpoint denies self-writable references that lack a
    // matching uploader binding, so every legitimately-referenced object must be
    // bound. Highest-authority source wins per key. Runs until the completion
    // marker is present.
    const { rows: doneRows } = await pool.query(`SELECT 1 FROM object_owners_backfill LIMIT 1`);
    if (doneRows.length === 0) {
      const { canonicalizeKey } = await import("./lib/objectAuthz");
      const owners = new Map<string, { owner: number | null; priority: number }>();
      const add = (raw: string | null | undefined, ownerId: number | null, priority: number): void => {
        if (!raw) return;
        const key = canonicalizeKey(raw);
        if (!key) return;
        // First (highest-authority) source seen for a key wins within a run.
        const cur = owners.get(key);
        if (!cur || priority < cur.priority) owners.set(key, { owner: ownerId, priority });
      };
      // Priority order: trustworthy/sensitive references first.
      const sources: Array<{ sql: string; owner: (r: any) => number | null; val: (r: any) => string | null }> = [
        { sql: `SELECT object_path AS v, user_id AS o FROM staff_documents WHERE object_path IS NOT NULL AND deleted_at IS NULL`, val: (r) => r.v, owner: (r) => r.o },
        { sql: `SELECT contract_url AS v, user_id AS o FROM agents WHERE contract_url IS NOT NULL`, val: (r) => r.v, owner: (r) => r.o },
        { sql: `SELECT agent_id_proof_url AS v, user_id AS o FROM agents WHERE agent_id_proof_url IS NOT NULL`, val: (r) => r.v, owner: (r) => r.o },
        { sql: `SELECT file_url AS v FROM financial_transactions WHERE file_url IS NOT NULL`, val: (r) => r.v, owner: () => null },
        { sql: `SELECT metadata->'attachment'->>'fileUrl' AS v, sender_id AS o FROM messages WHERE metadata->'attachment'->>'fileUrl' IS NOT NULL`, val: (r) => r.v, owner: (r) => r.o },
        { sql: `SELECT contract_url AS v, id AS o FROM users WHERE contract_url IS NOT NULL`, val: (r) => r.v, owner: (r) => r.o },
        { sql: `SELECT passport_url AS v, id AS o FROM users WHERE passport_url IS NOT NULL`, val: (r) => r.v, owner: (r) => r.o },
        { sql: `SELECT business_cert_url AS v, user_id AS o FROM agents WHERE business_cert_url IS NOT NULL`, val: (r) => r.v, owner: (r) => r.o },
        { sql: `SELECT logo_url AS v, user_id AS o FROM agents WHERE logo_url IS NOT NULL`, val: (r) => r.v, owner: (r) => r.o },
        { sql: `SELECT avatar_url AS v, id AS o FROM users WHERE avatar_url IS NOT NULL`, val: (r) => r.v, owner: (r) => r.o },
        { sql: `SELECT logo_url AS v FROM branches WHERE logo_url IS NOT NULL`, val: (r) => r.v, owner: () => null },
        { sql: `SELECT logo_url AS v FROM universities WHERE logo_url IS NOT NULL`, val: (r) => r.v, owner: () => null },
        { sql: `SELECT logo_url AS v, logo_dark_url AS v2, logo_square_url AS v3, email_logo_url AS v4, pdf_logo_url AS v5 FROM settings`, val: (r) => r.v, owner: () => null },
      ];
      let hadSourceFailure = false;
      // Source priority: index + 1 so every backfill binding is strictly less
      // authoritative than an upload-time binding (sourcePriority 0). Lower =
      // more authoritative; earlier sources in the array win.
      for (let p = 0; p < sources.length; p++) {
        const src = sources[p];
        const priority = p + 1;
        try {
          const { rows } = await pool.query(src.sql);
          for (const r of rows) {
            add(src.val(r), src.owner(r), priority);
            // settings row carries multiple logo variants.
            if (r.v2 !== undefined) {
              add(r.v2, null, priority); add(r.v3, null, priority);
              add(r.v4, null, priority); add(r.v5, null, priority);
            }
          }
        } catch (e) {
          hadSourceFailure = true;
          console.error("[migrate] object_owners backfill source failed:", e);
        }
      }
      if (owners.size > 0) {
        const entries = Array.from(owners.entries());
        const CHUNK = 500;
        for (let i = 0; i < entries.length; i += CHUNK) {
          const slice = entries.slice(i, i + CHUNK);
          const values: string[] = [];
          const params: any[] = [];
          slice.forEach(([k, v], idx) => {
            values.push(`($${idx * 3 + 1}, $${idx * 3 + 2}, $${idx * 3 + 3})`);
            params.push(k, v.owner, v.priority);
          });
          // Precedence-aware upsert: overwrite only when the incoming binding is
          // strictly more authoritative. This lets a retried backfill correct a
          // weaker binding that a prior partial run inserted, while never
          // clobbering an upload-time (priority 0) binding.
          await pool.query(
            `INSERT INTO object_owners (object_key, uploaded_by, source_priority) VALUES ${values.join(", ")}
             ON CONFLICT (object_key) DO UPDATE
               SET uploaded_by = EXCLUDED.uploaded_by, source_priority = EXCLUDED.source_priority
               WHERE EXCLUDED.source_priority < object_owners.source_priority`,
            params,
          );
        }
        console.log(`[migrate] object_owners backfilled ${owners.size} object bindings`);
      }
      // Mark complete ONLY when every source query succeeded, so a transient
      // source failure leaves the marker absent and the backfill resumes (and
      // converges) on the next boot rather than locking in a permanent gap.
      if (hadSourceFailure) {
        console.error("[migrate] object_owners backfill incomplete (a source failed); will retry next boot");
      } else {
        await pool.query(`INSERT INTO object_owners_backfill (id) VALUES (1) ON CONFLICT DO NOTHING`);
        console.log(`[migrate] object_owners backfill complete`);
      }
    }
  } catch (err) {
    console.error("[migrate] object_owners table/backfill:", err);
  }

  // Step 2b: Idempotent migrations for offer-letter expiry feature.
  try {
    await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS read_receipts_enabled BOOLEAN NOT NULL DEFAULT true`);
    await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS needs_human BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_last_handled_message_id INTEGER`);
    await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_reply_count INTEGER NOT NULL DEFAULT 0`);
    // Task #554 — multi-account-per-channel: per-account active/default flags.
    // Mirrors migration 0021 (not journaled; boot DDL is the prod migration path).
    await pool.query(`ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`);
    await pool.query(`ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false`);
    // Seed channel_accounts from the legacy integrations rows so the existing
    // single connected account becomes the first (default) per-channel account.
    // integrations.config is an already-encrypted JSON object; channel_accounts
    // .config_encrypted is TEXT, so store the JSON as text. Guarded so we only
    // seed when no account exists yet for the channel (idempotent, no cred loss).
    await pool.query(`
      INSERT INTO channel_accounts (channel, display_name, external_account_id, config_encrypted, status, is_active, is_default, created_at, updated_at)
      SELECT 'whatsapp', COALESCE(NULLIF(i.name, ''), 'WhatsApp Business'), NULLIF(i.config->>'phoneNumberId', ''), i.config::text,
             CASE WHEN i.is_enabled THEN 'active' ELSE 'inactive' END, COALESCE(i.is_enabled, false), true, now(), now()
      FROM integrations i
      WHERE i.key = 'whatsapp' AND NOT EXISTS (SELECT 1 FROM channel_accounts ca WHERE ca.channel = 'whatsapp')
    `);
    await pool.query(`
      INSERT INTO channel_accounts (channel, display_name, external_account_id, config_encrypted, status, is_active, is_default, created_at, updated_at)
      SELECT 'messenger', COALESCE(NULLIF(i.name, ''), 'Facebook Messenger'), NULLIF(i.config->>'pageId', ''), i.config::text,
             CASE WHEN i.is_enabled THEN 'active' ELSE 'inactive' END, COALESCE(i.is_enabled, false), true, now(), now()
      FROM integrations i
      WHERE i.key = 'facebook_messenger' AND NOT EXISTS (SELECT 1 FROM channel_accounts ca WHERE ca.channel = 'messenger')
    `);
    await pool.query(`
      INSERT INTO channel_accounts (channel, display_name, external_account_id, config_encrypted, status, is_active, is_default, created_at, updated_at)
      SELECT 'instagram', COALESCE(NULLIF(i.name, ''), 'Instagram'), COALESCE(NULLIF(i.config->>'igBusinessAccountId', ''), NULLIF(i.config->>'pageId', '')), i.config::text,
             CASE WHEN i.is_enabled THEN 'active' ELSE 'inactive' END, COALESCE(i.is_enabled, false), true, now(), now()
      FROM integrations i
      WHERE i.key = 'instagram' AND NOT EXISTS (SELECT 1 FROM channel_accounts ca WHERE ca.channel = 'instagram')
    `);
    await pool.query(`ALTER TABLE application_stage_documents ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE application_stage_documents ADD COLUMN IF NOT EXISTS expiry_notified_thresholds TEXT`);
    // FAZ 3 (AI agent lead capture): qualifying fields the intake bot collects
    // that lack a native leads column. budget→estimated_value, program→
    // interested_program, country→interested_country already exist.
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS interested_level TEXT`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS preferred_language TEXT`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS education_data jsonb`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS mother_name TEXT`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS father_name TEXT`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS offer_expiry_warning_days TEXT DEFAULT '30,14,7,1'`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS contract_expiry_reminder_days TEXT DEFAULT '30,14,7,1'`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS pdf_accent_color TEXT`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS agent_can_change_lead_stage BOOLEAN NOT NULL DEFAULT true`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS agent_can_change_student_app_stage BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS direct_student_enrollment_bonus_rate TEXT NOT NULL DEFAULT '0'`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS suppress_automation_app_notifications BOOLEAN NOT NULL DEFAULT true`);
    // Faz 2 (staff auto-assign): opt-in toggle for the periodic assignStuckConversation sweep.
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_assign_stuck_conversations_enabled BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS stuck_assign_consider_working_hours BOOLEAN NOT NULL DEFAULT true`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS stuck_assign_consider_country_match BOOLEAN NOT NULL DEFAULT true`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS stuck_assign_off_hours_behavior TEXT NOT NULL DEFAULT 'assign_anyway'`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS date_format TEXT NOT NULL DEFAULT 'DD.MM.YYYY'`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS public_catalog_allowed_countries JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS public_catalog_allowed_university_types JSONB NOT NULL DEFAULT '["Private"]'::jsonb`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS public_catalog_country_rules JSONB NOT NULL DEFAULT '{}'::jsonb`);
    // Zernio omnichannel provider — per-account provider tagging.
    await pool.query(`ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'direct'`);
    await pool.query(`ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`CREATE INDEX IF NOT EXISTS cp_user_starred_idx ON conversation_participants(user_id, is_starred)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS cp_conv_user_uniq ON conversation_participants(conversation_id, user_id)`);
    // Seed the Zernio integration config row so admin can enter apiKey/webhookSecret.
    await pool.query(`
      INSERT INTO integrations (key, name, category, is_enabled, config)
      SELECT 'zernio', 'Zernio', 'communication', false, '{}'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM integrations WHERE key = 'zernio')
    `);
    // Faz J — stage-doc mirror link: documents rows created by mirroring a
    // stage upload now carry a back-reference so the mirror can be removed
    // when the stage doc is deleted.
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_stage_document_id INTEGER`);
  } catch (err) {
    console.error("[migrate] offer-expiry columns:", err);
  }

  // Step 2b2: Idempotent migrations for the contract signing system (Task #110).
  try {
    await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'company'`);
    await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS tax_number TEXT`);
    await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS preferred_contract_language TEXT NOT NULL DEFAULT 'en'`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS contract_templates (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'en',
        entity_type TEXT NOT NULL DEFAULT 'company',
        version INTEGER NOT NULL DEFAULT 1,
        body_html TEXT NOT NULL DEFAULT '',
        intake_schema JSONB,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE contract_templates ADD COLUMN IF NOT EXISTS signing_page_config JSONB`);
    await pool.query(`ALTER TABLE contract_templates ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''`);
    await pool.query(`CREATE INDEX IF NOT EXISTS contract_templates_language_idx ON contract_templates(language)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS contract_templates_entity_type_idx ON contract_templates(entity_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS contract_templates_active_idx ON contract_templates(is_active)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS signing_sessions (
        id SERIAL PRIMARY KEY,
        template_id INTEGER NOT NULL,
        agent_id INTEGER,
        token_hash TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'admin_driven',
        status TEXT NOT NULL DEFAULT 'review_pending',
        intake_data JSONB,
        signer_email TEXT NOT NULL,
        signer_name TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        opened_at TIMESTAMPTZ,
        signed_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS signing_sessions_token_hash_idx ON signing_sessions(token_hash)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS signing_sessions_status_idx ON signing_sessions(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS signing_sessions_agent_id_idx ON signing_sessions(agent_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS signing_sessions_template_id_idx ON signing_sessions(template_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS signed_contracts (
        id SERIAL PRIMARY KEY,
        signing_session_id INTEGER NOT NULL,
        agent_id INTEGER,
        template_id INTEGER NOT NULL,
        pdf_object_key TEXT NOT NULL,
        signature_image_object_key TEXT,
        evidence_hash TEXT NOT NULL,
        signer_email TEXT NOT NULL,
        signer_name TEXT,
        signer_ip TEXT,
        signer_user_agent TEXT,
        signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        emailed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Unique on signing_session_id prevents duplicate signed records (race protection).
    await pool.query(`DROP INDEX IF EXISTS signed_contracts_session_id_idx`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS signed_contracts_session_id_unique ON signed_contracts(signing_session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS signed_contracts_agent_id_idx ON signed_contracts(agent_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS signed_contracts_template_id_idx ON signed_contracts(template_id)`);
    // The signed-contract PDF is now generated lazily on first download instead of
    // synchronously during signing (heavy headless-Chromium render was crashing the
    // autoscale instance mid-request). The sign step therefore inserts NULL for
    // these columns and they are backfilled on first PDF access. Idempotent.
    await pool.query(`ALTER TABLE signed_contracts ALTER COLUMN pdf_object_key DROP NOT NULL`);
    await pool.query(`ALTER TABLE signed_contracts ALTER COLUMN evidence_hash DROP NOT NULL`);
    // Lease column used by the signed-contract delivery worker to claim a row
    // for processing without two instances double-sending. Distinct from
    // emailed_at (which marks successful delivery), so a crash after claiming
    // does not permanently lose the delivery — the lease expires and the row
    // is reclaimed. Idempotent.
    await pool.query(`ALTER TABLE signed_contracts ADD COLUMN IF NOT EXISTS delivery_claimed_at TIMESTAMPTZ`);
    // Signature base64 column: new sign attempts store the signature PNG as
    // a base64 TEXT string directly in the DB row, eliminating the GCS upload
    // from the sign hot path. The GCS upload (up to 30 s) was OOM-killing the
    // autoscale instance mid-request, causing the edge proxy to return an opaque
    // HTML "403 Forbidden" page. The GCS upload now happens lazily inside
    // ensureSignedContractPdf() on the first PDF download. Idempotent.
    await pool.query(`ALTER TABLE signed_contracts ADD COLUMN IF NOT EXISTS signature_image_base64 TEXT`);
    // C1 fix: self-fill email rebind lock. Locks the signer email at session
    // creation so send-code/verify-code cannot redirect a code to an arbitrary
    // inbox after the link has been issued. Idempotent.
    await pool.query(`ALTER TABLE signing_sessions ADD COLUMN IF NOT EXISTS expected_email TEXT`);
    // Company Contracts: externally-signed agreements with company
    // counterparties. Mirrors university_contracts but the counterparty is
    // stored inline (company_name NOT NULL, country nullable) since there is no
    // company master entity. This boot DDL is the prod migration path (deploys
    // run no Drizzle migrate step). Idempotent.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS company_contracts (
        id SERIAL PRIMARY KEY,
        company_name TEXT NOT NULL,
        country TEXT,
        year INTEGER,
        effective_date TIMESTAMPTZ,
        expiry_date TIMESTAMPTZ,
        file_object_key TEXT,
        file_name TEXT,
        file_mime TEXT,
        file_size INTEGER,
        notes TEXT,
        last_warning_30_sent_at TIMESTAMPTZ,
        last_warning_14_sent_at TIMESTAMPTZ,
        last_warning_7_sent_at TIMESTAMPTZ,
        last_warning_1_sent_at TIMESTAMPTZ,
        expiry_notice_sent_at TIMESTAMPTZ,
        uploaded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        assigned_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS company_contracts_company_name_idx ON company_contracts(company_name)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS company_contracts_country_idx ON company_contracts(country)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS company_contracts_expiry_date_idx ON company_contracts(expiry_date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS company_contracts_deleted_at_idx ON company_contracts(deleted_at)`);

    // Backfill the full contract permission set for admin/super_admin roles.
    // Other roles get scoped grants in the dedicated loops below.
    const newPerms = [
      "contract_templates.view", "contract_templates.manage",
      "contracts.view", "contracts.manage",
      "self_fill_links.view", "self_fill_links.manage",
      "company_contracts.view", "company_contracts.manage",
      "university_contracts.view", "university_contracts.manage",
    ];
    const adminRoleRes = await pool.query(`SELECT id, permissions FROM roles WHERE name IN ('admin', 'super_admin')`);
    for (const row of adminRoleRes.rows) {
      const existing: string[] = Array.isArray(row.permissions) ? row.permissions : [];
      const merged = Array.from(new Set([...existing, ...newPerms]));
      if (merged.length !== existing.length) {
        await pool.query(`UPDATE roles SET permissions = $1::jsonb WHERE id = $2`, [JSON.stringify(merged), row.id]);
      }
    }

    // Contract menus default access = ADMIN + MANAGER + FINANCE (accountant).
    // Manager: full view+manage across all five contract areas (mirrors the
    // DEFAULT_ROLE_PERMISSIONS manager filter which includes them all).
    // Accountant: view-only across the five areas.
    const managerContractPerms = [...newPerms];
    const managerRoleRes = await pool.query(`SELECT id, permissions FROM roles WHERE name = 'manager'`);
    for (const row of managerRoleRes.rows) {
      const existing: string[] = Array.isArray(row.permissions) ? row.permissions : [];
      const merged = Array.from(new Set([...existing, ...managerContractPerms]));
      if (merged.length !== existing.length) {
        await pool.query(`UPDATE roles SET permissions = $1::jsonb WHERE id = $2`, [JSON.stringify(merged), row.id]);
      }
    }
    const accountantContractPerms = [
      "contract_templates.view", "contracts.view", "self_fill_links.view",
      "company_contracts.view", "university_contracts.view",
    ];
    const accountantRoleRes = await pool.query(`SELECT id, permissions FROM roles WHERE name = 'accountant'`);
    for (const row of accountantRoleRes.rows) {
      const existing: string[] = Array.isArray(row.permissions) ? row.permissions : [];
      const merged = Array.from(new Set([...existing, ...accountantContractPerms]));
      if (merged.length !== existing.length) {
        await pool.query(`UPDATE roles SET permissions = $1::jsonb WHERE id = $2`, [JSON.stringify(merged), row.id]);
      }
    }
  } catch (err) {
    console.error("[migrate] contract-signing tables:", err);
  }

  // Step 2b2b: Persistent API tokens (Bearer auth for programmatic access).
  // Mirrors lib/db migration 0013_api_tokens. Idempotent (IF NOT EXISTS) — this
  // is the prod migration path (deploys run no Drizzle migrate step).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        scopes TEXT[] NOT NULL DEFAULT '{}',
        last_used_at TIMESTAMP WITH TIME ZONE,
        expires_at TIMESTAMP WITH TIME ZONE,
        revoked_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_token_hash_unique ON api_tokens(token_hash)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS api_tokens_token_prefix_idx ON api_tokens(token_prefix)`);
  } catch (err) {
    console.error("[migrate] api_tokens table:", err);
  }

  // Step 2b2b2: Versioned DB-backed declarative adapter SPECs (opt-in parallel
  // system to portal_adapters). Mirrors lib/db migration 0024. Idempotent —
  // this is the prod migration path (deploys run no Drizzle migrate step).
  try {
    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE "portal_adapter_spec_source" AS ENUM ('builtin', 'uploaded');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_adapter_specs (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        spec JSONB NOT NULL,
        version INTEGER NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT false,
        source portal_adapter_spec_source NOT NULL DEFAULT 'uploaded',
        js_hook_approved BOOLEAN NOT NULL DEFAULT false,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_adapter_specs_key_version_uniq ON portal_adapter_specs(key, version)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS portal_adapter_specs_key_idx ON portal_adapter_specs(key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS portal_adapter_specs_enabled_idx ON portal_adapter_specs(enabled)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_adapter_specs_one_enabled_per_key ON portal_adapter_specs(key) WHERE enabled`);
  } catch (err) {
    console.error("[migrate] portal_adapter_specs table:", err);
  }

  // Step 2b2b2c: Conversation quality scoring (Faz 1). One row per
  // (conversation, staff user). Mirrors lib/db schema
  // conversationQualityScoresTable. Idempotent — boot DDL is the only prod
  // migration path (deploys run no Drizzle migrate step).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_quality_scores (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        accuracy INTEGER NOT NULL,
        completeness INTEGER NOT NULL,
        speed INTEGER NOT NULL,
        tone INTEGER NOT NULL,
        outcome INTEGER NOT NULL,
        overall INTEGER NOT NULL,
        rationales JSONB NOT NULL DEFAULT '{}',
        topic TEXT,
        language TEXT,
        staff_message_count INTEGER NOT NULL DEFAULT 0,
        avg_reply_seconds INTEGER,
        content_hash TEXT NOT NULL,
        model TEXT,
        scored_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS conv_quality_conv_user_idx ON conversation_quality_scores(conversation_id, user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS conv_quality_user_id_idx ON conversation_quality_scores(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS conv_quality_scored_at_idx ON conversation_quality_scores(scored_at)`);
  } catch (err) {
    console.error("[migrate] conversation_quality_scores table:", err);
  }

  // Step 2b2b3: Phase 3 multi-portal membership. Junction
  // portal_account_universities (catalog university ↔ multi-portal account) +
  // member dimension on portal_program_mapping. Mirrors lib/db migration 0025.
  // Idempotent — this is the prod migration path (no Drizzle migrate on deploy).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_account_universities (
        id SERIAL PRIMARY KEY,
        portal_key TEXT NOT NULL,
        catalog_university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_acct_uni_catalog_uniq ON portal_account_universities(catalog_university_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS portal_acct_uni_portal_key_idx ON portal_account_universities(portal_key)`);

    await pool.query(`ALTER TABLE portal_program_mapping ADD COLUMN IF NOT EXISTS member_university_id INTEGER REFERENCES universities(id) ON DELETE CASCADE`);
    // Replace the old single UNIQUE(university_key) with two partial uniques so a
    // company key can hold one 1:1 row (member NULL) plus N member-scoped rows.
    await pool.query(`DROP INDEX IF EXISTS portal_prog_map_key_uniq`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_prog_map_key_nomem_uniq ON portal_program_mapping(university_key) WHERE member_university_id IS NULL`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_prog_map_key_mem_uniq ON portal_program_mapping(university_key, member_university_id) WHERE member_university_id IS NOT NULL`);

    // Migrate Phase 2 routes_via members → junction (idempotent). Only members
    // with a catalog id can be expressed in the catalog-keyed junction.
    await pool.query(`
      INSERT INTO portal_account_universities (portal_key, catalog_university_id, enabled)
      SELECT routes_via, crm_university_id, true
        FROM portal_universities
       WHERE routes_via IS NOT NULL
         AND crm_university_id IS NOT NULL
         AND deleted_at IS NULL
      ON CONFLICT (catalog_university_id) DO NOTHING
    `);
  } catch (err) {
    console.error("[migrate] portal_account_universities table:", err);
  }

  // Staff Faz 1: "İlgilendiği Ülkeler" (handled countries) — additive table,
  // mirrors staff_languages exactly. Foundation for Faz 2 conversation
  // auto-assignment (country-priority matching); no behavior change yet.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff_countries (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        country TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS staff_countries_user_country_idx ON staff_countries(user_id, country)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS staff_countries_user_idx ON staff_countries(user_id)`);
  } catch (err) {
    console.error("[migrate] staff_countries table:", err);
  }

  // Step 2b2d: Finance Sprint Phase 1 — staff commission fields on commissions +
  // new staff_commission_payouts table.
  // Mirrors lib/db migration 0014_finance_staff_columns. Idempotent (IF NOT EXISTS /
  // ADD COLUMN IF NOT EXISTS) — prod migration path.
  try {
    await pool.query(`ALTER TABLE commissions ADD COLUMN IF NOT EXISTS staff_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE commissions ADD COLUMN IF NOT EXISTS staff_commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE commissions ADD COLUMN IF NOT EXISTS staff_commission_currency TEXT`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff_commission_payouts (
        id SERIAL PRIMARY KEY,
        commission_id INTEGER REFERENCES commissions(id) ON DELETE SET NULL,
        staff_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        amount NUMERIC(12,2) NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        paid_at TIMESTAMP WITH TIME ZONE,
        reference TEXT,
        attachment_url TEXT,
        notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        deleted_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS staff_commission_payouts_commission_id_idx ON staff_commission_payouts(commission_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS staff_commission_payouts_staff_user_id_idx ON staff_commission_payouts(staff_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS staff_commission_payouts_deleted_at_idx ON staff_commission_payouts(deleted_at) WHERE deleted_at IS NULL`);
  } catch (err) {
    console.error("[migrate] finance staff commission tables:", err);
  }

  // Step 2b2c: email_queue retry backoff columns.
  // retry_count — how many delivery attempts have been made so far.
  // max_retries — maximum attempts before the row is marked 'failed'.
  // next_retry_at — when the next attempt may be made (exponential backoff).
  // 'processing' status is used transiently during the UPDATE-based cluster-safe claim.
  // All steps are idempotent (ADD COLUMN IF NOT EXISTS).
  try {
    await pool.query(`ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3`);
    await pool.query(`ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ`);
    await pool.query(`CREATE INDEX IF NOT EXISTS email_queue_retry_idx ON email_queue (status, next_retry_at)`);
    // Recover any rows stuck in 'processing' from a previous crashed worker.
    await pool.query(`UPDATE email_queue SET status = 'pending' WHERE status = 'processing'`);
  } catch (err) {
    console.error("[migrate] email_queue retry columns:", err);
  }

  // Step 2b2c2: countries.dial_code (Task #518).
  // Adds an OPTIONAL editable dial code (e.g. "+90") to the country catalog so
  // every phone-code dropdown across the product can source codes from the DB
  // instead of hardcoded arrays. Deploy runs NO migrations, so this idempotent
  // boot DDL is the only prod migration path. The backfill is WHERE dial_code
  // IS NULL guarded — it seeds an initial value from the canonical ISO map on
  // first boot but NEVER overwrites a value an admin has edited afterwards.
  try {
    await pool.query(`ALTER TABLE countries ADD COLUMN IF NOT EXISTS dial_code TEXT`);
    const { ISO_DIAL_CODES } = await import("./lib/dialCodes.js");
    const isoList = Object.keys(ISO_DIAL_CODES);
    const codeList = isoList.map((iso) => ISO_DIAL_CODES[iso]);
    // Single set-based UPDATE keyed on ISO code; only fills NULL dial_code rows.
    await pool.query(
      `UPDATE countries AS c
         SET dial_code = m.dial
         FROM (SELECT UNNEST($1::text[]) AS iso, UNNEST($2::text[]) AS dial) AS m
        WHERE c.dial_code IS NULL AND UPPER(c.code) = m.iso`,
      [isoList, codeList],
    );
  } catch (err) {
    console.error("[migrate] countries.dial_code:", err);
  }

  // Step 2b2d: Website CMS collections tables.
  // These mirror the Drizzle schema definitions in lib/db/src/schema/website.ts.
  // All steps are idempotent (CREATE TABLE IF NOT EXISTS).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS website_collections_offices (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        city TEXT,
        country TEXT,
        address TEXT,
        phone TEXT,
        email TEXT,
        map_embed_url TEXT,
        image_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        translations_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE website_collections_offices ADD COLUMN IF NOT EXISTS translations_json JSONB NOT NULL DEFAULT '{}'`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS website_collections_team_members (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        title TEXT,
        bio TEXT,
        photo_url TEXT,
        email TEXT,
        linkedin_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        translations_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE website_collections_team_members ADD COLUMN IF NOT EXISTS translations_json JSONB NOT NULL DEFAULT '{}'`);
    // One-shot seed: populate with defaults sourced from the en.json i18n file
    // (about.team* and contact.office* keys). Uses a system_flags marker so
    // re-deploys don't overwrite edits made in the admin panel.
    const seedFlag = await pool.query(
      `INSERT INTO system_flags (key) VALUES ('cms_collections_seeded_v1') ON CONFLICT DO NOTHING RETURNING key`
    );
    if (seedFlag.rows.length > 0) {
      // Load i18n defaults from the frontend translations file so seed values
      // stay in sync with the static text that was previously shown on the page.
      let i18nEn: Record<string, Record<string, string>> = { about: {}, contact: {} };
      try {
        const enJsonPath = path.join(process.cwd(), "../edcons/src/lib/i18n/translations/en.json");
        const raw = fs.readFileSync(enJsonPath, "utf-8");
        i18nEn = JSON.parse(raw);
      } catch {
        console.warn("[migrate] Could not load en.json for CMS seed — using built-in defaults");
      }
      const a = i18nEn.about ?? {};
      const c = i18nEn.contact ?? {};
      const { rowCount: officeCount } = await pool.query(`SELECT 1 FROM website_collections_offices LIMIT 1`);
      if ((officeCount ?? 0) === 0) {
        const offices = [
          { name: a["office0City"] ?? c["office0City"] ?? "Istanbul Office", city: c["office0City"] ?? "Istanbul", country: "Türkiye", address: c["office0Address"] ?? "Levent Mahallesi, Buyukdere Cad. No:45, 34394 Istanbul, Turkiye", order: 0 },
          { name: a["office1City"] ?? c["office1City"] ?? "London Office",   city: c["office1City"] ?? "London",   country: "UK",       address: c["office1Address"] ?? "30 St Mary Axe, London EC3A 8BF, UK",                             order: 1 },
          { name: a["office2City"] ?? c["office2City"] ?? "Dubai Office",    city: c["office2City"] ?? "Dubai",    country: "UAE",      address: c["office2Address"] ?? "Dubai Internet City, Building 4, Office 220",                     order: 2 },
        ];
        for (const o of offices) {
          await pool.query(
            `INSERT INTO website_collections_offices (name, city, country, address, sort_order, is_active) VALUES ($1, $2, $3, $4, $5, TRUE)`,
            [o.name, o.city, o.country, o.address, o.order]
          );
        }
        console.log(`[migrate] website_collections_offices seeded with ${offices.length} offices from en.json`);
      }
      const { rowCount: memberCount } = await pool.query(`SELECT 1 FROM website_collections_team_members LIMIT 1`);
      if ((memberCount ?? 0) === 0) {
        const members = [
          { name: a["team0Name"] ?? "Dr. Ayse Yildiz",   title: a["team0Role"] ?? "Founder & CEO",                 bio: a["team0Bio"] ?? "15+ years in international education consulting.", order: 0 },
          { name: a["team1Name"] ?? "Marcus Chen",        title: a["team1Role"] ?? "Head of Admissions",            bio: a["team1Bio"] ?? "Guided 2,000+ students to their dream universities across 30 countries.", order: 1 },
          { name: a["team2Name"] ?? "Fatima Al-Hassan",   title: a["team2Role"] ?? "Visa & Immigration Specialist", bio: a["team2Bio"] ?? "Expert in student visa processes for UK, USA, Canada, Australia, and Europe.", order: 2 },
          { name: a["team3Name"] ?? "Olena Kovalenko",    title: a["team3Role"] ?? "Regional Manager - Europe",     bio: a["team3Bio"] ?? "Specializes in European university placements and scholarship programs.", order: 3 },
        ];
        for (const m of members) {
          await pool.query(
            `INSERT INTO website_collections_team_members (name, title, bio, sort_order, is_active) VALUES ($1, $2, $3, $4, TRUE)`,
            [m.name, m.title, m.bio, m.order]
          );
        }
        console.log(`[migrate] website_collections_team_members seeded with ${members.length} members from en.json`);
      }
    }
  } catch (err) {
    console.error("[migrate] website CMS collections tables:", err);
  }

  // Step 2b3: Performance quick-wins (Task #141) — pg_trgm trigram GIN
  // indexes for ILIKE '%term%' searches, partial index for unread
  // notifications, and the students.has_photo denormalized flag with
  // one-time backfill. All steps are idempotent (IF NOT EXISTS).
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    // Trigram indexes — Postgres can use these for ILIKE '%term%' planning,
    // turning O(n) sequential scans on 50K+ rows into index lookups.
    await pool.query(`CREATE INDEX IF NOT EXISTS students_first_name_trgm_idx ON students USING GIN (first_name gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS students_last_name_trgm_idx ON students USING GIN (last_name gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS students_email_trgm_idx ON students USING GIN (email gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS leads_first_name_trgm_idx ON leads USING GIN (first_name gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS leads_last_name_trgm_idx ON leads USING GIN (last_name gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS leads_email_trgm_idx ON leads USING GIN (email gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS programs_name_trgm_idx ON programs USING GIN (name gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS universities_name_trgm_idx ON universities USING GIN (name gin_trgm_ops)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS leads_list_scope_idx ON leads (season, assigned_to_id, updated_at DESC) WHERE deleted_at IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS students_list_scope_idx ON students (season, assigned_to_id, updated_at DESC) WHERE deleted_at IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS follow_ups_open_lead_schedule_idx ON follow_ups (lead_id, scheduled_at) WHERE completed = false`);

    // Partial index — every notification fetch reads only is_read=false rows;
    // a partial index is small (only unread rows) and dramatically speeds
    // up the unread-count queries used by the badge / SSE flow.
    await pool.query(`CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications (user_id) WHERE is_read = false`);

    // Full index on user_id — the FK to users is ON DELETE CASCADE, and
    // without a full index the cascade does a sequential scan per deleted
    // user, which made user deletions time out on large notification tables.
    await pool.query(`CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications (user_id)`);

    // students.has_photo: denormalize the photo-presence check so the
    // listing query no longer needs an extra SELECT against documents.
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS has_photo BOOLEAN NOT NULL DEFAULT FALSE`);
    // Perpetual idempotent sync — runs every boot to fix any drift between
    // the documents table and the denormalized has_photo flag (e.g. photos
    // uploaded via fileUrl-only path, or records created before the flag
    // was introduced). Both directions are covered: set TRUE where a photo
    // doc exists, clear FALSE where it no longer does.
    // The one-time system_flags guard is removed — this UPDATE only touches
    // rows where has_photo is already wrong, so it is always safe to run.
    const { rowCount: photoSet } = await pool.query(`
      UPDATE students s
      SET has_photo = TRUE
      WHERE has_photo = FALSE
        AND EXISTS (
          SELECT 1 FROM documents d
          WHERE d.student_id = s.id
            AND d.type IN ('photo', 'photograph')
            AND d.deleted_at IS NULL
        )
    `);
    const { rowCount: photoCleared } = await pool.query(`
      UPDATE students s
      SET has_photo = FALSE
      WHERE has_photo = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM documents d
          WHERE d.student_id = s.id
            AND d.type IN ('photo', 'photograph')
            AND d.deleted_at IS NULL
        )
    `);
    if ((photoSet ?? 0) > 0 || (photoCleared ?? 0) > 0) {
      console.log(`[migrate] students.has_photo synced: +${photoSet ?? 0} set, -${photoCleared ?? 0} cleared`);
    }
  } catch (err) {
    console.error("[migrate] perf quick-win indexes:", err);
  }

  // Step 2b3a: Transactional provenance for application-driven lifecycle cascades.
  // Lifecycle cascade provenance. Additive and empty on first deploy: legacy
  // LOST statuses are intentionally not treated as automation-owned.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lifecycle_cascade_state (
        id SERIAL PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        previous_status TEXT NOT NULL,
        cascaded_status TEXT NOT NULL,
        source_application_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_cascade_state_entity_idx ON lifecycle_cascade_state(entity_type, entity_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS lifecycle_cascade_state_source_app_idx ON lifecycle_cascade_state(source_application_id)`);
  } catch (err) {
    console.error("[migrate] lifecycle cascade state:", err);
  }

  // Step 2c: Idempotent migrations for the Branch system.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        country TEXT,
        city TEXT,
        contact_name TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        logo_url TEXT,
        notes TEXT,
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS branches_name_idx ON branches(name)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS branches_archived_idx ON branches(archived_at)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_branches (
        agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_id, branch_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS agent_branches_branch_id_idx ON agent_branches(branch_id)`);

    // Per-user permission overrides (tri-state map on top of role perms).
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_overrides jsonb`);

    // Add branch_id to other major tables.
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS users_branch_id_idx ON users(branch_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS leads_branch_id_idx ON leads(branch_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS students_branch_id_idx ON students(branch_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS applications_branch_id_idx ON applications(branch_id)`);

    // Phase 1/3: automatic backup-programme (supersession) links on applications.
    // When a full programme is superseded by an auto-created fallback the original
    // points to the new one (superseded_by) and the new one points back
    // (superseded_from). Idempotent — required in prod for the fallback orchestrator.
    await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS superseded_by_application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS superseded_from_application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS supersede_reason TEXT`);

    // Root/main application link for automatic fallback chains. Set on
    // portal-automation fan-out children AND supersession children so any hop can
    // recover the originally-applied programme + language + level and detect
    // same-university (X) vs different-university (Y). Additive & nullable —
    // required in prod for the ordered program+language fallback chain.
    await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS main_application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS applications_main_application_id_idx ON applications(main_application_id)`);

    // created_source: WHO created the application (student self-service / staff
    // panel / portal-automation fan-out), for the 3-group split on the student
    // profile. Additive & nullable; distinct from origin_type (acquisition
    // channel). null is treated as "student" by the UI (safe default).
    await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS created_source TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS applications_created_source_idx ON applications(created_source)`);
    // One-time backfill: automation-created applications are (a) auto-created
    // supersession/fallback apps (superseded_from_application_id set) and (b) the
    // best-available proxy for fan-out apps — those that have a portal submission
    // attached. Only rows still NULL are touched, so this is idempotent and never
    // overwrites a value set by the creation code. Note: a manually-enqueued
    // portal submission on a human-created app is an accepted best-effort false
    // positive (there is no created_by history to distinguish it pre-migration).
    await pool.query(`
      UPDATE applications a
      SET created_source = 'automation'
      WHERE a.created_source IS NULL
        AND (
          a.superseded_from_application_id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM portal_submissions ps WHERE ps.application_id = a.id
          )
        )
    `);
    // Everything else still NULL is safest treated as student self-service.
    await pool.query(`UPDATE applications SET created_source = 'student' WHERE created_source IS NULL`);

    // Seed a default branch on first run, then backfill orphan rows once.
    const seedRes = await pool.query(
      `INSERT INTO branches (name) VALUES ('Genel Şube') ON CONFLICT (name) DO NOTHING RETURNING id`
    );
    if (seedRes.rows.length > 0) {
      const defaultId = seedRes.rows[0].id;
      await pool.query(`UPDATE users SET branch_id = $1 WHERE branch_id IS NULL`, [defaultId]);
      await pool.query(`UPDATE leads SET branch_id = $1 WHERE branch_id IS NULL`, [defaultId]);
      await pool.query(`UPDATE students SET branch_id = $1 WHERE branch_id IS NULL`, [defaultId]);
      await pool.query(`UPDATE applications SET branch_id = $1 WHERE branch_id IS NULL`, [defaultId]);
      await pool.query(
        `INSERT INTO agent_branches (agent_id, branch_id)
         SELECT a.id, $1 FROM agents a
         ON CONFLICT DO NOTHING`,
        [defaultId]
      );
      console.log("[migrate] Branches: seeded default 'Genel Şube' (id=" + defaultId + ") and backfilled existing rows");
    }
  } catch (err) {
    console.error("[migrate] branches columns:", err);
  }

  try {
    await pool.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS contact_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  } catch (err) {
    console.error("[migrate] branches contact_user_id:", err);
  }

  // Idempotent fix: agent_staff and sub_agent users provisioned before this
  // change had emailVerified left at false (DB default). Because they are
  // added by a trusted agent (not via public self-registration) they should
  // never be blocked by the 6-digit verification screen. Set emailVerified=true
  // for all such users who are still stuck on false.
  try {
    const fixRes = await pool.query(`
      UPDATE users
      SET email_verified = TRUE
      WHERE role IN ('agent_staff', 'sub_agent')
        AND email_verified = FALSE
    `);
    const fixed = fixRes.rowCount || 0;
    if (fixed > 0) {
      console.log(`[migrate] Set email_verified=true for ${fixed} agent_staff/sub_agent user(s) blocked on verification screen`);
    }
  } catch (err) {
    console.error("[migrate] agent_staff/sub_agent emailVerified fix:", err);
  }

  // Idempotent normalization: unify universities.university_type terminology
  // and casing to "Public" / "Private" (legacy data had "State", "state",
  // "public", "private", etc). Also normalize the catalog_options rows,
  // deleting stray-cased duplicates first to respect the (category, value)
  // unique constraint.
  try {
    const pubRes = await pool.query(`
      UPDATE universities SET university_type='Public'
      WHERE university_type IS NOT NULL
        AND lower(university_type) IN ('public','state','devlet')
        AND university_type <> 'Public'
    `);
    const privRes = await pool.query(`
      UPDATE universities SET university_type='Private'
      WHERE university_type IS NOT NULL
        AND lower(university_type) IN ('private','özel','ozel')
        AND university_type <> 'Private'
    `);
    await pool.query(`
      DELETE FROM catalog_options co
      WHERE co.category='university_type'
        AND lower(co.value) IN ('public','state','devlet')
        AND co.value <> 'Public'
        AND EXISTS (SELECT 1 FROM catalog_options c2 WHERE c2.category='university_type' AND c2.value='Public')
    `);
    await pool.query(`
      UPDATE catalog_options SET value='Public'
      WHERE category='university_type'
        AND lower(value) IN ('public','state','devlet')
        AND value <> 'Public'
    `);
    await pool.query(`
      DELETE FROM catalog_options co
      WHERE co.category='university_type'
        AND lower(co.value) IN ('private','özel','ozel')
        AND co.value <> 'Private'
        AND EXISTS (SELECT 1 FROM catalog_options c2 WHERE c2.category='university_type' AND c2.value='Private')
    `);
    await pool.query(`
      UPDATE catalog_options SET value='Private'
      WHERE category='university_type'
        AND lower(value) IN ('private','özel','ozel')
        AND value <> 'Private'
    `);
    const changed = (pubRes.rowCount || 0) + (privRes.rowCount || 0);
    if (changed > 0) {
      console.log(`[migrate] Normalized university_type on ${changed} universit(ies) to Public/Private`);
    }
  } catch (err) {
    console.error("[migrate] university_type normalization:", err);
  }

  // Idempotent fix: revoke any admin_driven signing sessions that were mistakenly
  // assigned to agent_staff or sub_agent users. These roles should never sign
  // individual agency contracts — only the primary agent (role='agent') does.
  try {
    const revokeRes = await pool.query(`
      UPDATE signing_sessions ss
      SET status = 'revoked'
      FROM agents a
      JOIN users u ON u.id = a.user_id
      WHERE ss.agent_id = a.id
        AND ss.mode = 'admin_driven'
        AND ss.status NOT IN ('signed', 'revoked')
        AND u.role IN ('agent_staff', 'sub_agent')
    `);
    const revoked = revokeRes.rowCount || 0;
    if (revoked > 0) {
      console.log(`[migrate] Revoked ${revoked} admin_driven signing session(s) belonging to agent_staff/sub_agent users`);
    }
  } catch (err) {
    console.error("[migrate] revoke agent_staff/sub_agent sessions:", err);
  }

  // Step 2b4: Dashboard FAZ 1 — entity_view_events table for per-entity view
  // tracking (leadsViewed/studentsViewed/applicationsViewed/messagesViewed).
  // Indexes: (userId, viewedAt) and (entityType, viewedAt).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS entity_view_events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        deleted_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS entity_view_events_user_viewed_at_idx ON entity_view_events(user_id, viewed_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS entity_view_events_entity_type_viewed_at_idx ON entity_view_events(entity_type, viewed_at)`);
  } catch (err) {
    console.error("[migrate] entity_view_events:", err);
  }

  // Step 2b5: ai_default_configs — editable built-in defaults for AI extractors
  // and personas. Admin can override via the UI; DELETE reverts to hardcoded.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_default_configs (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.error("[migrate] ai_default_configs:", err);
  }

  // Step 2b6: Seed 4 example AI personas (idempotent via ON CONFLICT DO NOTHING
  // on slug). All are seeded inactive so admins activate after review.
  try {
    await pool.query(`
      INSERT INTO ai_personas
        (name, slug, persona_type, description, provider, model, system_prompt,
         guidelines, negative_prompt, allowed_data_scopes, tools_enabled,
         trigger_mode, schedule_cron, event_subscriptions, output_targets, is_active)
      VALUES
        (
          'System Audit',
          'system-audit',
          'advisor',
          'Read-only system auditor — analyses audit logs, finance and HR data and produces structured reports.',
          'anthropic', 'claude-sonnet-4-6',
          'You are an expert system auditor for an international education consultancy. Analyse the provided system data and produce a concise, structured audit report. Do not take any actions — advisory only.',
          E'- Present findings in a structured format with clear sections\n- Highlight anomalies, suspicious patterns or data inconsistencies\n- Include counts and timestamps where relevant\n- Keep the report objective and factual',
          '',
          '["audit","finance","hr"]'::jsonb,
          '[]'::jsonb,
          'manual', NULL, NULL, '[]'::jsonb, false
        ),
        (
          'Blog Yazarı Zeynep',
          'blog-yazar-zeynep',
          'advisor',
          'Creative blog writer persona — drafts SEO-friendly education content in Turkish and English.',
          'anthropic', 'claude-sonnet-4-6',
          'Zeynep, uluslararası eğitim danışmanlığı şirketimiz için blog içerikleri yazan yaratıcı bir yazarsın. Hem Türkçe hem İngilizce içerik üretebilirsin. Hedef kitleye uygun, SEO dostu ve bilgilendirici yazılar hazırlarsın.',
          E'- Her yazıda net bir başlık, giriş, ana bölümler ve sonuç bulunmalı\n- Yurt dışı eğitim fırsatlarına odaklan\n- SEO anahtar kelimelerini doğal şekilde kullan\n- Akademik ama ulaşılabilir bir dil kullan',
          'Clickbait başlık, yanıltıcı bilgi veya garanti vaat etme.',
          '["blog"]'::jsonb,
          '["blog_draft"]'::jsonb,
          'manual', NULL, NULL, '[]'::jsonb, false
        ),
        (
          'Lead Özetleyici',
          'lead-summarizer',
          'advisor',
          'Summarises lead records — highlights key info, conversion likelihood and recommended next steps.',
          'anthropic', 'claude-sonnet-4-6',
          'You are a lead analysis specialist for an international education consultancy. Given lead data provided as context, produce concise summaries highlighting the most important information, conversion likelihood indicators, and recommended next actions for the sales team.',
          E'- Summarise in 3-5 bullet points maximum\n- Highlight urgency indicators (deadline, hot lead, stalled)\n- End with one clear recommended next action\n- Use plain, direct language',
          'Do not invent data not present in the context. Do not make promises on behalf of the company.',
          '[]'::jsonb,
          '[]'::jsonb,
          'manual', NULL, NULL, '[]'::jsonb, false
        ),
        (
          'Takip Hatırlatıcı',
          'followup-reminder',
          'operator',
          'Scheduled operator — composes a weekly follow-up reminder notification for the team. Actions go to Approval Queue.',
          'anthropic', 'claude-sonnet-4-6',
          'You are a follow-up reminder operator for an international education consultancy. Every week, compose a brief, actionable notification message reminding the team of pending leads and follow-up priorities. Be concise, professional, and motivating.',
          E'- Keep the message under 150 words\n- Mention the day/week context\n- Include a call-to-action\n- Use a friendly but professional tone',
          'Do not include specific student names or confidential data in the notification body.',
          '[]'::jsonb,
          '["notification"]'::jsonb,
          'scheduled', '0 9 * * MON', NULL, '[]'::jsonb, false
        )
      ON CONFLICT (slug) DO NOTHING
    `);
  } catch (err) {
    console.error("[migrate] example ai_personas seed:", err);
  }

  // Step 2b6a: fail-closed Portal Automation Guardian. It is deliberately
  // inactive on install; an admin must review its scope, event trigger and cost
  // cap before activation. It may create a disabled staged spec and a separate
  // deploy proposal, but never activates or deploys either one automatically.
  // Conflict never overwrites admin configuration.
  try {
    await pool.query(`
      INSERT INTO ai_personas
        (name, slug, persona_type, description, provider, model, system_prompt,
         guidelines, negative_prompt, allowed_data_scopes, tools_enabled,
         trigger_mode, schedule_cron, event_subscriptions, output_targets,
         monthly_cost_cap_usd, is_active)
      VALUES
        (
          'Portal Automation Guardian',
          'portal-automation-guardian',
          'operator',
          'Diagnoses Playwright portal failures, stages selector-only spec patches, runs offline safety checks and creates non-executing deploy proposals after two human approvals.',
          'anthropic', 'claude-sonnet-4-6',
          E'You are the Portal Automation Guardian for an international education platform. Diagnose deterministic Playwright failures using only supplied evidence. Return exactly one JSON object matching the requested contract. Your output may be validated as a disabled staging artifact, but it is never an executed production change.',
          E'- Be evidence-bound and fail closed when uncertain\n- Prefer reusable adapter/spec fixes over student-specific workarounds\n- Set retrySafe=false when deduplication or remote portal state is unknown\n- Proposed JSON patches must use explicit JSON Pointer paths\n- Never include student PII, credentials, cookies, tokens, or signed URLs',
          E'Do not operate the browser. Do not retry submissions. Do not claim a submission succeeded. Do not edit code or activate a spec. Do not invent selectors, portal responses, student data, or validation rules.',
          '["portal_automation"]'::jsonb,
          '["portal_fix_proposal"]'::jsonb,
          'event_driven', NULL,
          '["portal_submission.failed","portal_status.changed"]'::jsonb,
          '["portal_diagnosis","staging_patch","deploy_proposal","portal_lifecycle","approval_queue"]'::jsonb,
          25.00,
          false
        )
      ON CONFLICT (slug) DO NOTHING
    `);
    // Upgrade only the original built-in configuration. Admin-customized tool
    // lists are left untouched. Lifecycle proposals are generated by the
    // deterministic monitor rather than by adding another LLM-dispatched tool.
    await pool.query(`
      UPDATE ai_personas
      SET
        description = 'Diagnoses Playwright portal failures, stages selector-only spec patches, runs offline safety checks and creates non-executing deploy proposals after two human approvals.',
        event_subscriptions = '["portal_submission.failed","portal_status.changed"]'::jsonb,
        output_targets = '["portal_diagnosis","staging_patch","deploy_proposal","portal_lifecycle","approval_queue"]'::jsonb,
        updated_at = now()
      WHERE slug = 'portal-automation-guardian'
        AND tools_enabled = '["portal_fix_proposal"]'::jsonb
    `);
  } catch (err) {
    console.error("[migrate] portal automation guardian seed:", err);
  }

  // Step 2b7: Seed built-in Passport / Transcript extractor (idempotent via ON CONFLICT slug).
  // Uses the shared HARDCODED_EXTRACTOR_FIELDS and HARDCODED_EXTRACTOR_RULES from aiDefaultConfigs.
  try {
    await pool.query(
      `INSERT INTO ai_extractors
         (name, slug, description, provider, model, system_prompt,
          fields, rules, scopes, document_types,
          temperature, max_tokens, is_active, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14)
       ON CONFLICT (slug) DO UPDATE SET
         fields        = EXCLUDED.fields,
         rules         = EXCLUDED.rules,
         model         = EXCLUDED.model,
         temperature   = EXCLUDED.temperature,
         max_tokens    = EXCLUDED.max_tokens,
         is_active     = EXCLUDED.is_active,
         is_default    = EXCLUDED.is_default`,
      [
        "Passport / Transcript",
        "builtin-passport-transcript",
        "Built-in extractor for passport and academic documents. Uses the shared field schema and global extraction rules.",
        "anthropic",
        "claude-sonnet-4-6",
        "",
        JSON.stringify(HARDCODED_EXTRACTOR_FIELDS),
        JSON.stringify({ globalRules: HARDCODED_EXTRACTOR_RULES }),
        JSON.stringify(["public_apply", "embed", "staff", "agent"]),
        JSON.stringify(["passport", "diploma", "transcript"]),
        0.20,
        4096,
        true,
        true,
      ]
    );
  } catch (err) {
    console.error("[migrate] builtin extractor seed:", err);
  }

  // Step 2b8: One-shot data fix — move Tayma (2716) and Sarah (2717) from the
  // accidental "Genel Şube" branch (1373) back to the main "Find And Study"
  // branch (1). Also moves any leads or students stuck in branch 1373 to
  // branch 1 so their assignments remain visible in the main branch UI.
  try {
    const branchFix = await pool.query(
      `INSERT INTO system_flags (key) VALUES ('staff_branch_fix_v1') ON CONFLICT DO NOTHING RETURNING key`
    );
    if (branchFix.rows.length > 0) {
      const uResult = await pool.query(
        `UPDATE users SET branch_id = 1, updated_at = NOW()
         WHERE id IN (2716, 2717) AND branch_id = 1373`
      );
      const lResult = await pool.query(
        `UPDATE leads SET branch_id = NULL, updated_at = NOW()
         WHERE branch_id = 1373`
      );
      const sResult = await pool.query(
        `UPDATE students SET branch_id = NULL, updated_at = NOW()
         WHERE branch_id = 1373`
      );
      console.log(
        `[migrate] staff branch fix: ${uResult.rowCount} user(s), ` +
        `${lResult.rowCount} lead(s), ${sResult.rowCount} student(s) moved from branch 1373 → main`
      );
    }
  } catch (err) {
    console.error("[migrate] staff branch fix:", err);
  }

  // Step 2b9: One-shot cleanup — soft-delete the "PLAY WRITE" Playwright test
  // staff account (id=2803, apply@findandstudy.com) from production so it no
  // longer appears in the Users list.
  try {
    const playwrightFix = await pool.query(
      `INSERT INTO system_flags (key) VALUES ('cleanup_playwright_staff_v1') ON CONFLICT DO NOTHING RETURNING key`
    );
    if (playwrightFix.rows.length > 0) {
      const result = await pool.query(
        `UPDATE users SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = 2803 AND role = 'staff' AND deleted_at IS NULL`
      );
      console.log(`[migrate] playwright staff cleanup: ${result.rowCount} user(s) soft-deleted`);
    }
  } catch (err) {
    console.error("[migrate] playwright staff cleanup:", err);
  }

  // Step 2b10: Restore apply@findandstudy.com (PLAY WRITE, id=2803) — was
  // accidentally soft-deleted by step 2b9; user is intentionally kept.
  try {
    await pool.query(
      `UPDATE users SET deleted_at = NULL, updated_at = NOW()
       WHERE id = 2803 AND email = 'apply@findandstudy.com' AND deleted_at IS NOT NULL`
    );
  } catch (err) {
    console.error("[migrate] restore apply@findandstudy.com:", err);
  }

  // Step 2b11: Portal Automation — portal_submissions table + enums (idempotent).
  try {
    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."portal_submission_mode" AS ENUM('dry', 'real');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."portal_submission_status" AS ENUM('queued', 'running', 'submitted', 'already_exists', 'program_missing', 'failed', 'canceled');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    await ensurePgEnumValue("portal_submission_status", "dry_run");
    await ensurePgEnumValue("portal_submission_status", "program_full");
    await ensurePgEnumValue("portal_submission_status", "exclusive_region");
    await ensurePgEnumValue("portal_submission_status", "accepted");
    await ensurePgEnumValue("portal_submission_status", "rejected");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_submissions (
        id SERIAL PRIMARY KEY,
        application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        university_key TEXT NOT NULL,
        university_name TEXT NOT NULL,
        mode portal_submission_mode NOT NULL DEFAULT 'dry',
        status portal_submission_status NOT NULL DEFAULT 'queued',
        external_ref TEXT,
        result_json JSONB,
        screenshot_urls JSONB,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        locked_at TIMESTAMPTZ,
        locked_by TEXT,
        enqueued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS portal_submissions_application_id_idx ON portal_submissions USING btree (application_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS portal_submissions_status_idx ON portal_submissions USING btree (status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS portal_submissions_locked_at_idx ON portal_submissions USING btree (locked_at)`);
    // Free-form metadata jsonb (supersession context / structured "Kontenjan
    // Dolu" program_full payload: requestedProgram + openPrograms). Idempotent.
    await pool.query(`ALTER TABLE portal_submissions ADD COLUMN IF NOT EXISTS meta JSONB`);
    // Adapter auto-graduation: adapter key stamped at enqueue + success-count
    // index + one-off NULL backfill from portal_universities. Idempotent.
    await pool.query(`ALTER TABLE portal_submissions ADD COLUMN IF NOT EXISTS adapter_key TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS portal_submissions_adapter_key_status_idx ON portal_submissions USING btree (adapter_key, status)`);
    await pool.query(`
      UPDATE portal_submissions ps
      SET adapter_key = pu.adapter_key
      FROM portal_universities pu
      WHERE ps.adapter_key IS NULL
        AND pu.university_key = ps.university_key
        AND pu.deleted_at IS NULL
    `);
  } catch (err) {
    console.error("[migrate] portal_submissions:", err);
  }

  // Step 2b12: Portal Automation — portal_automation_settings + portal_universities (idempotent).
  try {
    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."portal_automation_mode" AS ENUM('dry', 'real');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."portal_automation_scope" AS ENUM('only_applied', 'selected', 'all');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_automation_settings (
        id SERIAL PRIMARY KEY,
        is_enabled BOOLEAN NOT NULL DEFAULT false,
        trigger_stages JSONB NOT NULL DEFAULT '[]',
        mode portal_automation_mode NOT NULL DEFAULT 'dry',
        scope portal_automation_scope NOT NULL DEFAULT 'only_applied',
        selected_university_keys JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_universities (
        id SERIAL PRIMARY KEY,
        university_key TEXT NOT NULL,
        university_name TEXT NOT NULL,
        adapter_key TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        crm_university_id INTEGER,
        defaults JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_uni_university_key_uniq ON portal_universities (university_key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS portal_uni_adapter_key_idx ON portal_universities (adapter_key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS portal_uni_is_active_idx ON portal_universities (is_active)`);
    // Idempotent migrations for new scheduled auto-process columns
    await pool.query(`ALTER TABLE portal_automation_settings ADD COLUMN IF NOT EXISTS auto_process_enabled BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE portal_automation_settings ADD COLUMN IF NOT EXISTS auto_process_interval_minutes INTEGER NOT NULL DEFAULT 20`);
    await pool.query(`ALTER TABLE portal_automation_settings ADD COLUMN IF NOT EXISTS last_auto_drain_at TIMESTAMPTZ`);
    // Phase 3: program-fallback orchestrator kill-switch (opt-in, default off).
    await pool.query(`ALTER TABLE portal_automation_settings ADD COLUMN IF NOT EXISTS fallback_enabled BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE portal_universities ADD COLUMN IF NOT EXISTS auto_process BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE portal_universities ADD COLUMN IF NOT EXISTS is_multi_portal BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE portal_universities ADD COLUMN IF NOT EXISTS routes_via TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS portal_uni_routes_via_idx ON portal_universities (routes_via)`);
    // Fan-out 3-mode: global default on settings + per-university override (null = inherit).
    await pool.query(`ALTER TABLE portal_automation_settings ADD COLUMN IF NOT EXISTS fan_out_mode TEXT NOT NULL DEFAULT 'off'`);
    await pool.query(`ALTER TABLE portal_universities ADD COLUMN IF NOT EXISTS fan_out_mode TEXT`);
    // Phase 3: program-fallback (supersession) rules. Maps a SOURCE CRM programme
    // (the full one) to an ordered list of fallback CRM program ids, scoped to a
    // portal university. Idempotent — required in prod for the fallback orchestrator.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_program_fallbacks (
        id SERIAL PRIMARY KEY,
        university_key TEXT NOT NULL,
        source_program_id INTEGER NOT NULL,
        fallback_program_ids JSONB NOT NULL DEFAULT '[]',
        auto_submit BOOLEAN NOT NULL DEFAULT true,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    // Partial unique: only one ACTIVE rule per (university_key, source_program_id),
    // so a soft-deleted rule can be recreated. Drop any non-partial legacy index first.
    await pool.query(`DROP INDEX IF EXISTS portal_prog_fallback_key_source_uniq`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_prog_fallback_key_source_uniq ON portal_program_fallbacks (university_key, source_program_id) WHERE deleted_at IS NULL`);
    // University-based nationality exclusions ("exclusive region"). When a
    // student's nationality is on the exclusive list for a portal university the
    // worker skips the portal entirely and marks status='exclusive_region'.
    // Idempotent — required in prod for the preventive exclusion check.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_university_exclusions (
        id SERIAL PRIMARY KEY,
        university_key TEXT NOT NULL,
        nationality TEXT NOT NULL,
        agency_name TEXT,
        note TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    // Partial unique: only one ACTIVE rule per (university_key, nationality),
    // so a soft-deleted rule can be recreated.
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_uni_exclusion_key_nat_uniq ON portal_university_exclusions (university_key, nationality) WHERE deleted_at IS NULL`);
  } catch (err) {
    console.error("[migrate] portal_automation_settings/portal_universities:", err);
  }

  // Step 2b13: Portal Adapters table + Program Mapping table (idempotent).
  try {
    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."portal_adapter_kind" AS ENUM('code', 'declarative');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_adapters (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        match_names TEXT NOT NULL DEFAULT '',
        kind portal_adapter_kind NOT NULL DEFAULT 'code',
        config_json JSONB,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_adp_key_uniq ON portal_adapters (key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS portal_adp_is_active_idx ON portal_adapters (is_active)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_program_mapping (
        id SERIAL PRIMARY KEY,
        university_key TEXT NOT NULL,
        mappings JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_prog_map_key_uniq ON portal_program_mapping (university_key)`);
    // Panel-managed matching data (single-source). Additive, idempotent — the
    // matcher reads these MERGED OVER the adapter's built-in defaults (DB wins).
    await pool.query(`ALTER TABLE portal_program_mapping ADD COLUMN IF NOT EXISTS program_overrides JSONB NOT NULL DEFAULT '{}'`);
    await pool.query(`ALTER TABLE portal_program_mapping ADD COLUMN IF NOT EXISTS synonyms JSONB NOT NULL DEFAULT '[]'`);
    await pool.query(`ALTER TABLE portal_program_mapping ADD COLUMN IF NOT EXISTS country_overrides JSONB NOT NULL DEFAULT '{}'`);
  } catch (err) {
    console.error("[migrate] portal_adapters/portal_program_mapping:", err);
  }

  // Step 2b13b: Portal Automation — portal_program_cache (LIVE program option
  // lists cached per (university_key, level); TTL refresh handled in the API).
  // `level` is NOT NULL DEFAULT '' so the unique key + ON CONFLICT upsert work
  // (PostgreSQL treats NULLs as distinct, which would break both).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_program_cache (
        id SERIAL PRIMARY KEY,
        university_key TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT '',
        options JSONB NOT NULL DEFAULT '[]',
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_prog_cache_key_level_uniq ON portal_program_cache (university_key, level)`);
  } catch (err) {
    console.error("[migrate] portal_program_cache:", err);
  }

  // Step 2b12: portal_credentials — encrypted per-portal username/password (AES-256-GCM).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portal_credentials (
        id SERIAL PRIMARY KEY,
        portal_key TEXT NOT NULL,
        username_enc TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        extra_enc TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS portal_creds_portal_key_uniq ON portal_credentials (portal_key)`);
  } catch (err) {
    console.error("[migrate] portal_credentials:", err);
  }

  // Step 2b12b: Backfill portal_credentials stored under universityKey → adapterKey (canonical).
  // Idempotent: only updates rows where portal_key differs from the university's adapter_key.
  try {
    await pool.query(`
      UPDATE portal_credentials pc
      SET portal_key = pu.adapter_key, updated_at = NOW()
      FROM portal_universities pu
      WHERE pc.portal_key = pu.university_key
        AND pc.portal_key != pu.adapter_key
        AND pc.deleted_at IS NULL
    `);
  } catch (err) {
    console.error("[migrate] portal_credentials backfill universityKey→adapterKey:", err);
  }

  // Step 2b12c: Multico portal_universities + portal_university_exclusions seed.
  //
  // Multico (https://www.multico.com.tr/crm/) is the exclusive submission
  // channel for Topkapı University for students whose nationality is one of 7
  // Central Asian / Mongolian countries. Two idempotent inserts:
  //
  //   1. portal_universities row for `multico` (adapter_key=multico).
  //      auto_process=false: stays experimental until manually graduated.
  //   2. portal_university_exclusions: one row per nationality for `topkapi`,
  //      so the fan-out worker skips direct Topkapı for these students.
  //      agency_name='Multico' is used by the UI to show a redirect hint.
  try {
    await pool.query(`
      INSERT INTO portal_universities
        (university_key, university_name, adapter_key, is_active, auto_process, is_multi_portal)
      VALUES
        ('multico', 'Multico (Topkapı CAS)', 'multico', true, false, false)
      ON CONFLICT (university_key) DO NOTHING
    `);
    // Ensure university_name is up-to-date in case the row already exists.
    await pool.query(`
      UPDATE portal_universities
         SET university_name = 'Multico (Topkapı CAS)', adapter_key = 'multico', updated_at = NOW()
       WHERE university_key = 'multico'
         AND (university_name IS DISTINCT FROM 'Multico (Topkapı CAS)'
              OR adapter_key IS DISTINCT FROM 'multico')
    `);
    // Seed topkapi exclusions for the 7 Central Asian / Mongolian nationalities.
    // ON CONFLICT DO NOTHING — idempotent even if rows already exist.
    const exclusionNationalities = [
      'Azerbaijan',
      'Kazakhstan',
      'Uzbekistan',
      'Kyrgyzstan',
      'Tajikistan',
      'Turkmenistan',
      'Mongolia',
    ];
    for (const nat of exclusionNationalities) {
      await pool.query(`
        INSERT INTO portal_university_exclusions
          (university_key, nationality, agency_name, note, enabled)
        VALUES
          ('topkapi', $1, 'Multico', 'Exclusive CAS channel — submit via Multico adapter', true)
        ON CONFLICT (university_key, nationality)
          WHERE deleted_at IS NULL
        DO UPDATE SET
          agency_name = EXCLUDED.agency_name,
          enabled     = true,
          note        = EXCLUDED.note,
          updated_at  = NOW()
      `, [nat]);
    }
    // Seed a placeholder portal_credentials row for `multico` so the
    // credentials management UI shows a slot to configure it.
    // is_active=false → resolvePortalCreds skips it until real creds are saved.
    await pool.query(`
      INSERT INTO portal_credentials (portal_key, username_enc, password_enc, is_active)
      VALUES ('multico', '', '', false)
      ON CONFLICT (portal_key) DO NOTHING
    `);
    console.log('[migrate] Multico portal_universities + topkapi exclusions seeded');
  } catch (err) {
    console.error('[migrate] Multico portal_universities seed:', err);
  }

  // Step 2b12d: Register the existing Piri Reis adapter as a disabled portal
  // school. The code adapter was already present, but without this row the
  // school could not be configured in Portal Automation. It deliberately
  // remains inactive and auto_process=false until credentials and the current
  // live form/readback contract are calibrated.
  try {
    await pool.query(`
      INSERT INTO portal_universities
        (university_key, university_name, adapter_key, is_active, auto_process,
         is_multi_portal, crm_university_id)
      VALUES
        (
          'piri_reis_university',
          'Piri Reis University',
          'pirireis',
          false,
          false,
          false,
          (
            SELECT id
              FROM universities
             WHERE name ILIKE '%Piri Reis%'
             ORDER BY is_active DESC, id ASC
             LIMIT 1
          )
        )
      ON CONFLICT (university_key) DO NOTHING
    `);
    // Expose a credentials slot without inventing or persisting any secret.
    // Empty inactive values are intentionally ignored by resolvePortalCreds.
    await pool.query(`
      INSERT INTO portal_credentials
        (portal_key, username_enc, password_enc, is_active)
      VALUES ('pirireis', '', '', false)
      ON CONFLICT (portal_key) DO NOTHING
    `);
    console.log('[migrate] Piri Reis portal school registered (inactive)');
  } catch (err) {
    console.error('[migrate] Piri Reis portal school seed:', err);
  }

  // Step 2b14: Backfill assignedToId consistency across Lead → Student → Application.
  // Runs on every boot; both UPDATEs are idempotent (IS DISTINCT FROM guard ensures
  // only genuinely out-of-sync rows are touched). Logs affected counts so each
  // deploy can confirm convergence.
  try {
    // Before counts — helps diagnose residual drift after the first run.
    const { rows: preRows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM students s
           JOIN leads l ON l.id = s.origin_lead_id
          WHERE l.assigned_to_id IS NOT NULL
            AND s.assigned_to_id IS DISTINCT FROM l.assigned_to_id
            AND s.deleted_at IS NULL
            AND l.deleted_at IS NULL) AS student_drift,
        (SELECT COUNT(*) FROM applications a
           JOIN students s ON s.id = a.student_id
          WHERE s.assigned_to_id IS NOT NULL
            AND a.assigned_to_id IS DISTINCT FROM s.assigned_to_id
            AND a.deleted_at IS NULL
            AND s.deleted_at IS NULL) AS app_drift
    `);
    const preStudentDrift = parseInt(preRows[0]?.student_drift ?? "0", 10);
    const preAppDrift     = parseInt(preRows[0]?.app_drift     ?? "0", 10);

    // Pass 1: propagate lead's assignedToId → student (only when lead has one).
    const { rowCount: studentFixed } = await pool.query(`
      UPDATE students s
         SET assigned_to_id = l.assigned_to_id,
             updated_at     = NOW()
        FROM leads l
       WHERE s.origin_lead_id              = l.id
         AND l.assigned_to_id             IS NOT NULL
         AND s.assigned_to_id             IS DISTINCT FROM l.assigned_to_id
         AND s.deleted_at                 IS NULL
         AND l.deleted_at                 IS NULL
    `);

    // Pass 2: propagate student's (now-updated) assignedToId → application.
    const { rowCount: appFixed } = await pool.query(`
      UPDATE applications a
         SET assigned_to_id = s.assigned_to_id,
             updated_at     = NOW()
        FROM students s
       WHERE a.student_id                  = s.id
         AND s.assigned_to_id             IS NOT NULL
         AND a.assigned_to_id             IS DISTINCT FROM s.assigned_to_id
         AND a.deleted_at                 IS NULL
         AND s.deleted_at                 IS NULL
    `);

    if ((studentFixed ?? 0) > 0 || (appFixed ?? 0) > 0 || preStudentDrift > 0 || preAppDrift > 0) {
      console.log(
        `[migrate] assignedToId backfill: ` +
        `students ${studentFixed ?? 0} fixed (was ${preStudentDrift} drifted), ` +
        `applications ${appFixed ?? 0} fixed (was ${preAppDrift} drifted)`
      );
    }
  } catch (err) {
    console.error("[migrate] assignedToId backfill:", err);
  }

  // Step 2b15: message_templates.approval_status — tracks Zernio/Meta WhatsApp
  // template review state (pending/approved/rejected) for templates synced
  // from the Zernio WhatsApp Template Management API. Idempotent.
  try {
    await pool.query(`ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS approval_status TEXT`);
  } catch (err) {
    console.error("[migrate] message_templates.approval_status:", err);
  }

  // Step 2b16: knowledge_sources — AI Agent Faz 1 scaffold registry (a single
  // program_scope row today; Faz 2/3 add url/file/webhook/conversation rows
  // to the same table). Idempotent CREATE TABLE IF NOT EXISTS.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        config JSONB NOT NULL DEFAULT '{}',
        is_active BOOLEAN NOT NULL DEFAULT true,
        status TEXT,
        last_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  } catch (err) {
    console.error("[migrate] knowledge_sources:", err);
  }

  // Step 2b17: knowledge_chunks — AI Agent Faz 2 RAG pipeline.
  //
  // NOTE (Faz 2b): does NOT use the Postgres `vector` type or the pgvector
  // extension — production (Hostinger Postgres) does not have pgvector
  // available at all (`CREATE EXTENSION vector` fails; not even listed in
  // pg_available_extensions), which silently prevented this table from ever
  // being created. `embedding` is stored as plain JSONB (a JSON array of
  // floats); similarity search is brute-force cosine computed in Node
  // (see knowledgeRetrieval.ts) — fast enough for a knowledge base of a few
  // thousand chunks and portable to any Postgres. Idempotent CREATE TABLE.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id SERIAL PRIMARY KEY,
        source_id INTEGER NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        embedding JSONB NOT NULL DEFAULT '[]',
        token_count INTEGER NOT NULL DEFAULT 0,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS knowledge_chunks_source_id_idx ON knowledge_chunks (source_id)`);
  } catch (err) {
    console.error("[migrate] knowledge_chunks:", err);
  }

  // Step 2b18: "Add as Document" — source-tracking columns on documents (Task #627).
  try {
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS source TEXT`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_conversation_id INTEGER`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_message_id INTEGER`);
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_attachment_id TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS documents_source_attachment_idx ON documents(source_attachment_id) WHERE source_attachment_id IS NOT NULL`);
  } catch (err) {
    console.error("[migrate] documents source columns:", err);
  }

  // Step 2b19: message_reactions — CRM-side emoji reactions on inbox messages.
  // Also ensures reply_to_id column exists on messages (present in schema since
  // day-one but may be absent on older prod DBs that predate the column).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        id SERIAL PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS message_reactions_msg_user_emoji_idx ON message_reactions(message_id, user_id, emoji)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS message_reactions_message_id_idx ON message_reactions(message_id)`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER`);
  } catch (err) {
    console.error("[migrate] message_reactions:", err);
  }

  // Step 2b20: academy_access — per-user Academy SSO toggle.
  // agent/sub_agent: preserve existing open access (true).
  // agent_staff: add 'academy' to existing agentStaffPermissions so no one loses access.
  // internal staff: default NULL = no access (new feature; admin must explicitly enable).
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS academy_access BOOLEAN`);
    await pool.query(`UPDATE users SET academy_access = true WHERE role IN ('agent', 'sub_agent') AND academy_access IS NULL`);
    await pool.query(`
      UPDATE users
      SET agent_staff_permissions = COALESCE(agent_staff_permissions, '[]'::jsonb) || '["academy"]'::jsonb
      WHERE role = 'agent_staff'
        AND NOT (COALESCE(agent_staff_permissions, '[]'::jsonb) @> '["academy"]'::jsonb)
    `);
  } catch (err) {
    console.error("[migrate] academy_access:", err);
  }

  // Step 2b21: Migrate academy_access=false users to permissionOverrides.
  // agent/sub_agent have academy.access=true by default; only explicitly
  // disabled users need an override entry.
  try {
    await pool.query(`
      UPDATE users
      SET permission_overrides = COALESCE(permission_overrides, '{}'::jsonb) || '{"academy.access": false}'::jsonb
      WHERE academy_access = false
        AND role IN ('agent', 'sub_agent')
        AND (permission_overrides IS NULL OR NOT (permission_overrides ? 'academy.access'))
    `);
  } catch (err) {
    console.error("[migrate] academy_access_to_overrides:", err);
  }

  // Step 2b22: education_records — structured education history per student.
  // Replaces the flat high_school / university_bachelor / university_master
  // columns on the students table with a normalised child table.
  // The flat columns remain on students (no DROP) for backward compatibility.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS education_records (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        level TEXT NOT NULL CHECK (level IN ('high_school', 'bachelor', 'master')),
        school_name TEXT,
        country TEXT,
        field_of_study TEXT,
        start_month TEXT,
        start_year INTEGER,
        end_month TEXT,
        end_year INTEGER,
        gpa TEXT,
        gpa_type TEXT,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai_extracted', 'migrated')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (student_id, level)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS education_records_student_id_idx ON education_records (student_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS education_records_student_level_uniq ON education_records (student_id, level)`);
    // FIX-17 İŞ 2: add city + language_score columns (idempotent).
    await pool.query(`ALTER TABLE education_records ADD COLUMN IF NOT EXISTS city TEXT`);
    await pool.query(`ALTER TABLE education_records ADD COLUMN IF NOT EXISTS language_score TEXT`);
    // Migrate flat columns → education_records (source=migrated, skip if already present).
    await pool.query(`
      INSERT INTO education_records (student_id, level, school_name, source)
      SELECT id, 'high_school', high_school, 'migrated'
      FROM students
      WHERE high_school IS NOT NULL AND high_school <> ''
      ON CONFLICT (student_id, level) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO education_records (student_id, level, school_name, end_year, source)
      SELECT id, 'bachelor', university_bachelor,
             CASE WHEN graduation_year > 0 THEN graduation_year ELSE NULL END,
             'migrated'
      FROM students
      WHERE university_bachelor IS NOT NULL AND university_bachelor <> ''
      ON CONFLICT (student_id, level) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO education_records (student_id, level, school_name, source)
      SELECT id, 'master', university_master, 'migrated'
      FROM students
      WHERE university_master IS NOT NULL AND university_master <> ''
      ON CONFLICT (student_id, level) DO NOTHING
    `);
  } catch (err) {
    console.error("[migrate] education_records:", err);
  }

  // Step 2b23: student_education_records + SIT toggles (FAZ 1).
  // Mirrors migration 0033 (not journaled; boot DDL is the prod migration path).
  // Normalised per-level academic records; flat students columns stay (deprecated).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_education_records (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        level TEXT NOT NULL CHECK (level IN ('high_school', 'bachelor', 'master')),
        institution TEXT,
        program TEXT,
        graduation_year INTEGER,
        gpa TEXT,
        gpa_raw TEXT,
        gpa_scale INTEGER,
        language_score TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS student_education_records_student_id_idx ON student_education_records (student_id)`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS student_education_records_student_level_uniq
      ON student_education_records (student_id, level)
      WHERE deleted_at IS NULL
    `);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS transfer_student BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS has_tc_id BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS has_blue_card BOOLEAN NOT NULL DEFAULT FALSE`);
    // Idempotent backfill from flat students columns (NOT EXISTS guard per level).
    await pool.query(`
      INSERT INTO student_education_records (student_id, level, institution, graduation_year, gpa, language_score)
      SELECT s.id, 'high_school', s.high_school,
             CASE WHEN s.university_bachelor IS NULL AND s.university_master IS NULL
                       AND s.graduation_year > 0 THEN s.graduation_year ELSE NULL END,
             CASE WHEN s.university_bachelor IS NULL AND s.university_master IS NULL THEN s.gpa ELSE NULL END,
             CASE WHEN s.university_bachelor IS NULL AND s.university_master IS NULL THEN s.language_score ELSE NULL END
      FROM students s
      WHERE s.high_school IS NOT NULL AND s.high_school <> ''
        AND NOT EXISTS (
          SELECT 1 FROM student_education_records r
          WHERE r.student_id = s.id AND r.level = 'high_school' AND r.deleted_at IS NULL
        )
    `);
    await pool.query(`
      INSERT INTO student_education_records (student_id, level, institution, graduation_year, gpa, language_score)
      SELECT s.id, 'bachelor', s.university_bachelor,
             CASE WHEN s.university_master IS NULL AND s.graduation_year > 0 THEN s.graduation_year ELSE NULL END,
             CASE WHEN s.university_master IS NULL THEN s.gpa ELSE NULL END,
             CASE WHEN s.university_master IS NULL THEN s.language_score ELSE NULL END
      FROM students s
      WHERE s.university_bachelor IS NOT NULL AND s.university_bachelor <> ''
        AND NOT EXISTS (
          SELECT 1 FROM student_education_records r
          WHERE r.student_id = s.id AND r.level = 'bachelor' AND r.deleted_at IS NULL
        )
    `);
    await pool.query(`
      INSERT INTO student_education_records (student_id, level, institution, graduation_year, gpa, language_score)
      SELECT s.id, 'master', s.university_master,
             CASE WHEN s.graduation_year > 0 THEN s.graduation_year ELSE NULL END,
             s.gpa, s.language_score
      FROM students s
      WHERE s.university_master IS NOT NULL AND s.university_master <> ''
        AND NOT EXISTS (
          SELECT 1 FROM student_education_records r
          WHERE r.student_id = s.id AND r.level = 'master' AND r.deleted_at IS NULL
        )
    `);
  } catch (err) {
    console.error("[migrate] student_education_records:", err);
  }

  // Step 2b24: structured Altınbaş address/questionnaire data.
  // Mirrors migration 0034; additive and safe for every other adapter.
  try {
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS city_of_birth TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS address_city TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS postal_code TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS needs_visa_support BOOLEAN`);
  } catch (err) {
    console.error("[migrate] altinbas structured student fields:", err);
  }

  // Step 2b25: stable task completion timestamps for Activity performance
  // metrics. The one-time backfill is the best available historical truth;
  // every new status transition is recorded exactly by routes/tasks.ts.
  try {
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
    await pool.query(`
      UPDATE tasks
      SET completed_at = updated_at
      WHERE status = 'done'
        AND completed_at IS NULL
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS tasks_completed_at_idx ON tasks (completed_at)`);
  } catch (err) {
    console.error("[migrate] task completion metrics:", err);
  }

  // Step 2b26: auditable outbound CRM message campaigns.
  // Mirrors migration 0036. Production deploys do not run Drizzle migrations,
  // so this idempotent startup DDL is also the production migration path.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_campaigns (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'whatsapp',
        source_entity_type TEXT NOT NULL,
        template_id INTEGER NOT NULL REFERENCES message_templates(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'queued',
        created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        total_count INTEGER NOT NULL DEFAULT 0,
        queued_count INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT message_campaigns_entity_type_chk CHECK (source_entity_type IN ('lead', 'student', 'application')),
        CONSTRAINT message_campaigns_channel_chk CHECK (channel IN ('whatsapp')),
        CONSTRAINT message_campaigns_status_chk CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled'))
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_campaign_recipients (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL REFERENCES message_campaigns(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        recipient_key TEXT NOT NULL,
        lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
        application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
        display_name TEXT,
        phone_e164 TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ,
        channel_account_id INTEGER REFERENCES channel_accounts(id) ON DELETE SET NULL,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        rendered_content TEXT,
        external_message_id TEXT,
        provider_broadcast_id TEXT,
        error_code TEXT,
        error_detail TEXT,
        variables_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT message_campaign_recipients_entity_type_chk CHECK (entity_type IN ('lead', 'student', 'application')),
        CONSTRAINT message_campaign_recipients_status_chk CHECK (status IN ('queued', 'processing', 'retrying', 'sent', 'failed', 'skipped', 'cancelled')),
        CONSTRAINT message_campaign_recipients_campaign_key_uidx UNIQUE (campaign_id, recipient_key)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS message_campaigns_status_scheduled_idx
        ON message_campaigns(status, scheduled_at)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS message_campaigns_created_by_idx
        ON message_campaigns(created_by_id, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS message_campaign_recipients_claim_idx
        ON message_campaign_recipients(status, next_attempt_at, id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS message_campaign_recipients_campaign_status_idx
        ON message_campaign_recipients(campaign_id, status)
    `);
  } catch (err) {
    console.error("[migrate] message campaigns:", err);
  }

  // Steps 3–5: Only instance 0 runs seeds, backfills, and background workers.
  const isWorkerZero = !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === "0";
  if (isWorkerZero) {
    // DB-based lock: only one process wins the INSERT; others skip seeds.
    const lockResult = await pool.query(
      `INSERT INTO system_flags (key) VALUES ('bootstrap_done') ON CONFLICT DO NOTHING RETURNING key`
    );
    if (lockResult.rows.length > 0) {
      await ensureSuperAdmin();
      await ensureAgentUser();
      await runSeedSQL();
      await linkAgentUser();
      await seedClaudeIntegration();
      await backfillConversationChannel();
      await backfillMissingCommissions();
      await backfillStudentAppStatus();
      await backfillLeadConversion();
    }

    // Runs on EVERY boot (outside the bootstrap_done lock) so existing/prod
    // environments that were already bootstrapped still materialize the
    // ai_agent config row. Idempotent — only inserts when the row is absent.
    await seedAiAgentConfig();
    await seedProgramScopeSource();

    // Runs on EVERY boot (outside the bootstrap_done lock) so it heals
    // existing/prod data, not just freshly seeded environments. Idempotent and
    // WHERE-guarded — only writes the handful of students whose flag has drifted.
    await backfillStudentPhotoFlags();

    // Merge placeholder "wa_out:<digits>" external_contacts with real contacts
    // that were created when the student replied via WhatsApp.  Idempotent —
    // once all wa_out: rows are merged away this becomes a no-op on each boot.
    await backfillWaOutExternalContacts();

    // Documents catalog: add metadata jsonb column if missing, then seed.
    // Runs on every boot (idempotent per-row), outside the bootstrap_done
    // lock so it backfills existing environments too.
    try {
      await pool.query(`ALTER TABLE catalog_options ADD COLUMN IF NOT EXISTS metadata jsonb`);
    } catch (err) {
      console.error("[migrate] catalog_options.metadata:", err);
    }
    try {
      await pool.query(`ALTER TABLE embed_widgets ADD COLUMN IF NOT EXISTS embed_api_key TEXT`);
    } catch (err) {
      console.error("[migrate] embed_widgets.embed_api_key:", err);
    }
    try {
      await pool.query(`ALTER TABLE follow_ups ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ`);
    } catch (err) {
      console.error("[migrate] follow_ups.notified_at:", err);
    }
    await seedDocumentTypes(pool);
    await seedCurrencies(pool);

    // Idempotent: ensure the assignment.inconsistency notification rule exists
    // for environments seeded before this event was introduced.
    try {
      await pool.query(`
        INSERT INTO notification_rules (event, name, description, category, channels, recipient_type, recipient_roles, is_active, template)
        VALUES (
          'assignment.inconsistency',
          'Assignment Inconsistency Detected',
          'Fired by the periodic consistency checker when a lead or application assignedToId does not match its student',
          'system',
          '["in_app", "email"]'::jsonb,
          'role',
          '["super_admin", "admin"]'::jsonb,
          true,
          '{}'::jsonb
        )
        ON CONFLICT (event) DO NOTHING
      `);
    } catch (err) {
      console.error("[migrate] assignment.inconsistency notification rule:", err);
    }

    // Idempotent: upgrade message.new to include email channel (was in_app only),
    // and ensure note.created rule exists for environments seeded before it was added.
    try {
      await pool.query(`
        UPDATE notification_rules
        SET channels = '["in_app","email"]'::jsonb
        WHERE event = 'message.new'
          AND NOT (channels @> '["email"]'::jsonb)
      `);
      await pool.query(`
        INSERT INTO notification_rules (event, name, description, category, channels, recipient_type, recipient_roles, is_active, template)
        VALUES (
          'note.created',
          'Note Added',
          'When a note is added to an application, student, or lead record',
          'notes',
          '["in_app","email"]'::jsonb,
          'specific',
          '[]'::jsonb,
          true,
          '{}'::jsonb
        )
        ON CONFLICT (event) DO NOTHING
      `);
    } catch (err) {
      console.error("[migrate] notification_rules channel upgrades:", err);
    }

    // Idempotent + additive: the "unmatched inbound message" notification
    // became a UI-managed rule under the new event key inbox.message_unmatched
    // with email OFF by default (the legacy inbox.unmatched rule had email
    // enabled and flooded staff mailboxes). Seed the new rule if missing and
    // neutralize the legacy row (deactivate + strip email) without deleting
    // it — its event is never dispatched anymore, so it stays inert.
    try {
      await pool.query(`
        INSERT INTO notification_rules (event, name, description, category, channels, recipient_type, recipient_roles, is_active, template)
        VALUES (
          'inbox.message_unmatched',
          'Unmatched message — needs review',
          'When an inbound message (web form, WhatsApp, Instagram…) cannot be linked to a known contact',
          'inbox',
          '["in_app"]'::jsonb,
          'role',
          '["super_admin", "admin", "manager"]'::jsonb,
          true,
          '{}'::jsonb
        )
        ON CONFLICT (event) DO NOTHING
      `);
      await pool.query(`
        UPDATE notification_rules
        SET is_active = false, channels = '["in_app"]'::jsonb
        WHERE event = 'inbox.unmatched'
          AND (is_active = true OR channels @> '["email"]'::jsonb)
      `);
    } catch (err) {
      console.error("[migrate] inbox.message_unmatched notification rule:", err);
    }

    // Faz 2 (staff auto-assign): notification fired when the periodic
    // assignStuckConversation sweep assigns a stuck conversation to a staff
    // member. In-app only by design — this is a high-frequency operational
    // signal, not something that should flood email/WhatsApp.
    try {
      await pool.query(`
        INSERT INTO notification_rules (event, name, description, category, channels, recipient_type, recipient_roles, is_active, template)
        VALUES (
          'conversation.stuck_assigned',
          'Stuck Conversation Auto-Assigned',
          'When the auto-assign sweep assigns an unattended inbox conversation to a staff member',
          'inbox',
          '["in_app"]'::jsonb,
          'specific',
          '[]'::jsonb,
          true,
          '{}'::jsonb
        )
        ON CONFLICT (event) DO NOTHING
      `);
    } catch (err) {
      console.error("[migrate] conversation.stuck_assigned notification rule:", err);
    }

    // Idempotent: seed the three contract notification rules introduced in this
    // release (contract.sent, contract.verification_code, contract.signed).
    // All three use ON CONFLICT DO NOTHING so re-running on existing envs is safe.
    try {
      const contractNotificationRules = [
        {
          event: "contract.sent",
          name: "Contract Sent to Signer",
          description: "When a contract signing link is sent or resent to a signer",
          channels: ["in_app", "email"],
          recipientType: "role",
          recipientRoles: ["super_admin", "admin"],
          template: {
            subject: "Contract Sent to Signer",
            body: "The contract <strong>{{contractName}}</strong> has been sent to <strong>{{signerName}}</strong> ({{signerEmail}}) for signing.<br><br><a href=\"{{contractLink}}\">View Contracts</a>",
            translations: {
              tr: {
                subject: "Sözleşme İmzaya Gönderildi",
                body: "<strong>{{contractName}}</strong> sözleşmesi, <strong>{{signerName}}</strong> ({{signerEmail}}) kişisine imzalanmak üzere gönderildi.<br><br><a href=\"{{contractLink}}\">Sözleşmeleri Görüntüle</a>",
              },
            },
          },
        },
        {
          event: "contract.verification_code",
          name: "Email Verification Code",
          description: "The verification code email sent to the signer before signing (customizable template)",
          channels: ["email"],
          recipientType: "specific",
          recipientRoles: [] as string[],
          template: {
            subject: "Your Verification Code for {{contractName}}",
            body: "Your verification code for signing <strong>{{contractName}}</strong>:<br><br><strong style=\"font-size:24px;letter-spacing:4px\">{{verificationCode}}</strong><br><br>This code expires in 15 minutes.",
            translations: {
              tr: {
                subject: "{{contractName}} İçin Doğrulama Kodunuz",
                body: "<strong>{{contractName}}</strong> sözleşmesini imzalamak için doğrulama kodunuz:<br><br><strong style=\"font-size:24px;letter-spacing:4px\">{{verificationCode}}</strong><br><br>Bu kod 15 dakika içinde geçersiz olacaktır.",
              },
            },
          },
        },
        {
          event: "contract.signed",
          name: "Contract Signed",
          description: "When a signer successfully completes contract signing",
          channels: ["in_app", "email"],
          recipientType: "role",
          recipientRoles: ["super_admin", "admin"],
          template: {
            subject: "{{signerName}} Signed {{contractName}}",
            body: "<strong>{{signerName}}</strong> ({{signerEmail}}) has successfully signed the contract <strong>{{contractName}}</strong>.<br><br><a href=\"{{contractLink}}\">View Signed Contracts</a>",
            translations: {
              tr: {
                subject: "{{signerName}}, {{contractName}} Sözleşmesini İmzaladı",
                body: "<strong>{{signerName}}</strong> ({{signerEmail}}), <strong>{{contractName}}</strong> sözleşmesini başarıyla imzaladı.<br><br><a href=\"{{contractLink}}\">İmzalanan Sözleşmeleri Görüntüle</a>",
              },
            },
          },
        },
      ];
      for (const rule of contractNotificationRules) {
        await pool.query(
          `INSERT INTO notification_rules
             (event, name, description, category, channels, recipient_type, recipient_roles, is_active, template)
           VALUES ($1, $2, $3, 'contracts', $4::jsonb, $5, $6::jsonb, true, $7::jsonb)
           ON CONFLICT (event) DO UPDATE SET template = EXCLUDED.template
           WHERE notification_rules.template = '{}'::jsonb`,
          [
            rule.event,
            rule.name,
            rule.description,
            JSON.stringify(rule.channels),
            rule.recipientType,
            JSON.stringify(rule.recipientRoles),
            JSON.stringify(rule.template),
          ]
        );
      }
    } catch (err) {
      console.error("[migrate] contract notification rules:", err);
    }

    // One-shot data fix: sync leads and applications whose assigned_to_id does
    // not match their student's assigned_to_id. These accumulated over time
    // because assignment cascades are permission-gated and many historical
    // reassignments pre-date the cascade feature. The student is the canonical
    // record; leads and applications inherit from it.
    // Gated by system_flags so it runs exactly once per environment, not on
    // every boot. A future manual change via the UI will continue to cascade
    // normally through the existing cascade helpers.
    try {
      const assignFix = await pool.query(
        `INSERT INTO system_flags (key) VALUES ('assignment_consistency_backfill_v1') ON CONFLICT DO NOTHING RETURNING key`
      );
      if (assignFix.rows.length > 0) {
        const leadResult = await pool.query(`
          UPDATE leads l
          SET assigned_to_id = s.assigned_to_id
          FROM students s
          WHERE l.converted_student_id = s.id
            AND l.assigned_to_id IS DISTINCT FROM s.assigned_to_id
            AND l.deleted_at IS NULL
            AND s.deleted_at IS NULL
        `);
        const appResult = await pool.query(`
          UPDATE applications a
          SET assigned_to_id = s.assigned_to_id
          FROM students s
          WHERE a.student_id = s.id
            AND a.assigned_to_id IS DISTINCT FROM s.assigned_to_id
            AND a.deleted_at IS NULL
            AND s.deleted_at IS NULL
        `);
        const leadsFixed = leadResult.rowCount ?? 0;
        const appsFixed = appResult.rowCount ?? 0;
        console.log(`[migrate] assignment consistency backfill: fixed ${leadsFixed} lead(s), ${appsFixed} application(s)`);
        // Reset the stored delta-alerting baseline so the checker doesn't
        // immediately alert with the (now-lower) fresh count on next run.
        await pool.query(
          `INSERT INTO system_kv (key, value, updated_at) VALUES ('assignment_inconsistency_last_count', '0', NOW())
           ON CONFLICT (key) DO UPDATE SET value = '0', updated_at = NOW()`
        );
      }
    } catch (err) {
      console.error("[migrate] assignment consistency backfill:", err);
    }

    // One-shot backfill: grant the three *.view_commission permission keys to
    // the roles that should see commission/earnings figures by default, for
    // environments that were seeded before these keys existed. Gated by a
    // system_flags marker so it runs exactly once — that way an admin who later
    // turns a toggle OFF in the Roles & Permissions editor won't have it
    // silently re-added on the next boot. Staff/consultant/editor are
    // intentionally excluded so commission stays hidden for them by default.
    try {
      const permBackfill = await pool.query(
        `INSERT INTO system_flags (key) VALUES ('role_commission_perms_backfilled') ON CONFLICT DO NOTHING RETURNING key`
      );
      if (permBackfill.rows.length > 0) {
        await pool.query(`
          UPDATE roles
          SET permissions = (
            SELECT jsonb_agg(DISTINCT elem)
            FROM jsonb_array_elements_text(
              permissions || '["leads.view_commission","applications.view_commission","students.view_commission"]'::jsonb
            ) AS elem
          )
          WHERE name IN ('super_admin', 'admin', 'manager', 'accountant')
        `);
        console.log("[migrate] Backfilled *.view_commission permissions for default earnings roles");
      }
    } catch (err) {
      console.error("[migrate] role commission permissions backfill:", err);
    }

    // One-shot backfill: grant the new stage/card-move/assignment permission
    // keys to the roles that should have them by default, for environments
    // seeded before these keys existed. Gated by a system_flags marker so it
    // runs exactly once — an admin who later turns a toggle OFF in the Roles &
    // Permissions editor won't have it silently re-added on the next boot.
    // super_admin/admin/manager get the full action set; staff/consultant get
    // the operational subset (stage changes + view_unassigned + move_cards).
    try {
      const stagePermBackfill = await pool.query(
        `INSERT INTO system_flags (key) VALUES ('role_stage_perms_backfilled') ON CONFLICT DO NOTHING RETURNING key`
      );
      if (stagePermBackfill.rows.length > 0) {
        await pool.query(`
          UPDATE roles
          SET permissions = (
            SELECT jsonb_agg(DISTINCT elem)
            FROM jsonb_array_elements_text(
              permissions || '["leads.change_stage","applications.change_stage","students.change_stage","records.change_assigned","records.view_others","records.view_unassigned","records.assign_button","records.move_cards"]'::jsonb
            ) AS elem
          )
          WHERE name IN ('super_admin', 'admin', 'manager')
        `);
        await pool.query(`
          UPDATE roles
          SET permissions = (
            SELECT jsonb_agg(DISTINCT elem)
            FROM jsonb_array_elements_text(
              permissions || '["leads.change_stage","applications.change_stage","students.change_stage","records.view_unassigned","records.move_cards"]'::jsonb
            ) AS elem
          )
          WHERE name IN ('staff', 'consultant')
        `);
        console.log("[migrate] Backfilled stage/card-move/assignment permissions for default roles");
      }
    } catch (err) {
      console.error("[migrate] role stage permissions backfill:", err);
    }

    // One-shot migration (Task #564): fold the two legacy agent stage Settings
    // toggles (agentCanChangeLeadStage / agentCanChangeStudentAppStage) into the
    // normal Roles & Permissions system. Gated by a system_flags marker so it
    // runs exactly ONCE per environment — after it runs, admins manage these
    // through the Roles editor and a re-run must never clobber their choices.
    //   - leads.change_stage → mirrors the old agentCanChangeLeadStage toggle
    //     onto the agent-family roles (agent / sub_agent / agent_staff).
    //   - applications.change_student_app_stage → NEW combined key mirroring the
    //     old agentCanChangeStudentAppStage toggle onto the agent-family roles,
    //     and granted to the non-agent stage-changing roles by default so the
    //     new permission is present (staff paths keep their existing keys, so
    //     it is inert for them — staff/admin behavior is unchanged).
    try {
      const agentStageMig = await pool.query(
        `INSERT INTO system_flags (key) VALUES ('agent_stage_perms_migrated_v1') ON CONFLICT DO NOTHING RETURNING key`
      );
      if (agentStageMig.rows.length > 0) {
        // Grant the new combined key to the non-agent stage-changing roles.
        await pool.query(`
          UPDATE roles
          SET permissions = (
            SELECT jsonb_agg(DISTINCT elem)
            FROM jsonb_array_elements_text(
              permissions || '["applications.change_student_app_stage"]'::jsonb
            ) AS elem
          )
          WHERE name IN ('super_admin', 'admin', 'manager', 'staff', 'consultant')
        `);
        // Read the live legacy toggle values (defaults: lead=true, student/app=false).
        const settingsRes = await pool.query(
          `SELECT agent_can_change_lead_stage AS lead, agent_can_change_student_app_stage AS sap FROM settings LIMIT 1`
        );
        const leadOn = settingsRes.rows.length === 0 ? true : settingsRes.rows[0].lead !== false;
        const sapOn = settingsRes.rows.length === 0 ? false : settingsRes.rows[0].sap === true;
        if (leadOn) {
          await pool.query(`
            UPDATE roles
            SET permissions = (
              SELECT jsonb_agg(DISTINCT elem)
              FROM jsonb_array_elements_text(
                permissions || '["leads.change_stage"]'::jsonb
              ) AS elem
            )
            WHERE name IN ('agent', 'sub_agent', 'agent_staff')
          `);
        }
        if (sapOn) {
          await pool.query(`
            UPDATE roles
            SET permissions = (
              SELECT jsonb_agg(DISTINCT elem)
              FROM jsonb_array_elements_text(
                permissions || '["applications.change_student_app_stage"]'::jsonb
              ) AS elem
            )
            WHERE name IN ('agent', 'sub_agent', 'agent_staff')
          `);
        }
        console.log(`[migrate] Migrated agent stage Settings toggles into role permissions (lead=${leadOn}, studentApp=${sapOn})`);
      }
    } catch (err) {
      console.error("[migrate] agent stage perms migration:", err);
    }

    // Backfill records.assign_button for staff/consultant roles (prod migration).
    try {
      const assignBtnBackfill = await pool.query(
        `INSERT INTO system_flags (key) VALUES ('role_assign_button_staff_backfilled') ON CONFLICT DO NOTHING RETURNING key`
      );
      if (assignBtnBackfill.rows.length > 0) {
        await pool.query(`
          UPDATE roles
          SET permissions = (
            SELECT jsonb_agg(DISTINCT elem)
            FROM jsonb_array_elements_text(
              permissions || '["records.assign_button"]'::jsonb
            ) AS elem
          )
          WHERE name IN ('staff', 'consultant')
            AND NOT (permissions @> '["records.assign_button"]'::jsonb)
        `);
        console.log("[migrate] Backfilled records.assign_button for staff/consultant roles");
      }
    } catch (err) {
      console.error("[migrate] role assign_button backfill:", err);
    }

  }
  }

  const { BackgroundJobCoordinator, backgroundJobsEnabled } = await import("./lib/backgroundJobs");
  const backgroundJobs = new BackgroundJobCoordinator(pool, [
    { name: "emailWorker", offsetMs: 1_000, start: async () => {
      const { startEmailWorker } = await import("./lib/email");
      return startEmailWorker();
    } },
    { name: "contractChecker", offsetMs: 4_000, start: async () => {
      const { startContractChecker } = await import("./lib/contractChecker");
      return startContractChecker();
    } },
    { name: "offerExpiryChecker", offsetMs: 7_000, start: async () => {
      const { startOfferExpiryChecker } = await import("./lib/offerExpiryChecker");
      return startOfferExpiryChecker();
    } },
    { name: "universityContractChecker", offsetMs: 10_000, start: async () => {
      const { startUniversityContractChecker } = await import("./lib/universityContractChecker");
      return startUniversityContractChecker();
    } },
    { name: "companyContractChecker", offsetMs: 13_000, start: async () => {
      const { startCompanyContractChecker } = await import("./lib/companyContractChecker");
      return startCompanyContractChecker();
    } },
    { name: "signedContractDelivery", offsetMs: 16_000, start: async () => {
      const { startSignedContractDeliveryWorker } = await import("./lib/signedContractDelivery");
      return startSignedContractDeliveryWorker();
    } },
    { name: "assignmentConsistencyChecker", offsetMs: 19_000, start: async () => {
      const { startAssignmentConsistencyChecker } = await import("./lib/assignmentConsistencyChecker");
      return startAssignmentConsistencyChecker();
    } },
    { name: "followUpChecker", offsetMs: 25_000, start: async () => {
      const { startFollowUpChecker } = await import("./lib/followUpChecker");
      return startFollowUpChecker();
    } },
    { name: "portalUniversityLinker", offsetMs: 31_000, start: async () => {
      const { startPortalUniversityLinker } = await import("./lib/portalUniversityLinker");
      return startPortalUniversityLinker();
    } },
    { name: "stuckConversationSweep", offsetMs: 34_000, start: async () => {
      const { startStuckConversationSweep } = await import("./lib/stuckConversationAssigner");
      return startStuckConversationSweep();
    } },
    { name: "qualityScoringWorker", offsetMs: 37_000, start: async () => {
      const { startQualityScoringWorker } = await import("./lib/inbox/qualityScoring");
      return startQualityScoringWorker();
    } },
    { name: "portalAiGuardian", offsetMs: 40_000, start: async () => {
      const { startPortalAiGuardianScanner } = await import("./lib/portalAiGuardian");
      return startPortalAiGuardianScanner();
    } },
    { name: "academyKnowledgeSync", offsetMs: 43_000, start: async () => {
      const { startAcademyKnowledgeSync } = await import("./lib/inbox/academyKnowledgeSync");
      return startAcademyKnowledgeSync();
    } },
    { name: "dormBookingKnowledgeSync", offsetMs: 44_500, start: async () => {
      const { startDormBookingKnowledgeSync } = await import("./lib/inbox/dormBookingKnowledgeSync");
      return startDormBookingKnowledgeSync();
    } },
    { name: "dormBooking23hFollowup", offsetMs: 45_000, start: async () => {
      const { startDormBookingFollowupWorker } = await import("./lib/inbox/dormBookingFollowupWorker");
      return startDormBookingFollowupWorker();
    } },
    { name: "messageCampaignWorker", offsetMs: 46_000, start: async () => {
      const { startMessageCampaignWorker } = await import("./lib/inbox/messageCampaignWorker");
      return startMessageCampaignWorker();
    } },
    { name: "activityStaleSessionCleanup", offsetMs: 47_000, start: async () => {
      const { startActivityStaleSessionCleanup } = await import("./routes/activity");
      return startActivityStaleSessionCleanup();
    } },
  ]);
  const backgroundJobsRequested = backgroundJobsEnabled();
  await backgroundJobs.start(backgroundJobsRequested);
  let stopLocalSignedContractPdfWorker: (() => Promise<void>) | null = null;
  if (!backgroundJobsRequested) {
    const {
      signedContractPdfWorkerEnabled,
      startSignedContractPdfWorker,
    } = await import("./lib/signedContractDelivery");
    if (signedContractPdfWorkerEnabled()) {
      stopLocalSignedContractPdfWorker = startSignedContractPdfWorker();
    }
  }

  serveStaticFrontend();

  const { feedBus } = await import("./lib/feedBus");
  let shuttingDown = false;
  let httpServer: ReturnType<typeof app.listen> | null = null;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — stopping background jobs and feedBus`);
    if (httpServer) {
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          new Promise<void>((resolve) => httpServer!.close(() => resolve())),
          new Promise<void>((resolve) => {
            drainTimer = setTimeout(() => {
              console.error("[shutdown] HTTP drain timed out after 10 seconds");
              exitCode = 1;
              resolve();
            }, 10_000);
            drainTimer.unref?.();
          }),
        ]);
      } finally {
        if (drainTimer) clearTimeout(drainTimer);
      }
    }
    try { await backgroundJobs.shutdown(); } catch (error) {
      console.error("[shutdown] Background-job shutdown failed:", error);
      exitCode = 1;
    }
    if (stopLocalSignedContractPdfWorker) {
      try { await stopLocalSignedContractPdfWorker(); } catch (error) {
        console.error("[shutdown] Local signed-contract PDF worker shutdown failed:", error);
        exitCode = 1;
      }
    }
    try { await feedBus.shutdown(); } catch (error) {
      console.error("[shutdown] feedBus shutdown failed:", error);
      exitCode = 1;
    }
    process.exit(exitCode);
  };
  fatalShutdown = shutdown;
  process.once("SIGTERM", () => { void shutdown("SIGTERM", 0); });
  process.once("SIGINT",  () => { void shutdown("SIGINT", 0); });

  httpServer = app.listen(port, () => {
    console.log(`Server listening on port ${port} (${isProd ? "production" : "development"})`);
    if (typeof process.send === "function") {
      process.send("ready");
    }
  });
})();
