/**
 * portalProgramFallbacks.ts — Yedek Program (supersession) Kuralları CRUD
 *
 * Kapsam:
 *   GET    /portal-program-fallbacks?universityKey=...   — liste (soft-delete hariç)
 *   POST   /portal-program-fallbacks                     — kural ekle (kaynak başına tek)
 *   PATCH  /portal-program-fallbacks/:id                 — güncelle (sıra/enable/autoSubmit)
 *   DELETE /portal-program-fallbacks/:id                 — soft delete (deletedAt)
 *
 * Kurallar: validate+getValidated (ASLA req.body), zod, logAudit,
 *           requireRole(...ADMIN_ROLES), soft-delete, unique (universityKey,sourceProgramId).
 *           Program adları display için programs tablosundan çözülür.
 */

import { Router, type IRouter } from "express";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  portalProgramFallbacksTable,
  programsTable,
} from "@workspace/db";
import { logAudit, requireAuth, requireRole } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import { getValidated, validate } from "../middlewares/validate";

const router: IRouter = Router();

class DuplicatePortalProgramFallbackError extends Error {
  constructor() {
    super("An active fallback rule already exists for this portal programme");
    this.name = "DuplicatePortalProgramFallbackError";
  }
}

function isFallbackUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (
      candidate.code === "23505" &&
      candidate.constraint === "portal_prog_fallback_key_source_uniq"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
type IdSchemas = { params: typeof idParamsSchema };

// ---------------------------------------------------------------------------
// Helper — resolve CRM program ids → { id: name } map for display
// ---------------------------------------------------------------------------
async function resolveProgramNames(
  ids: number[],
): Promise<Record<number, string>> {
  const unique = [...new Set(ids)].filter((n) => Number.isInteger(n));
  if (unique.length === 0) return {};
  const rows = await db
    .select({ id: programsTable.id, name: programsTable.name })
    .from(programsTable)
    .where(inArray(programsTable.id, unique));
  const map: Record<number, string> = {};
  for (const r of rows) map[r.id] = r.name;
  return map;
}

type FallbackRow = typeof portalProgramFallbacksTable.$inferSelect;

function serialize(row: FallbackRow, names: Record<number, string>) {
  return {
    id: row.id,
    universityKey: row.universityKey,
    sourceProgramId: row.sourceProgramId,
    sourceProgramName: names[row.sourceProgramId] ?? null,
    fallbackProgramIds: row.fallbackProgramIds,
    fallbackPrograms: row.fallbackProgramIds.map((id) => ({
      id,
      name: names[id] ?? null,
    })),
    autoSubmit: row.autoSubmit,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /portal-program-fallbacks?universityKey=...
// ---------------------------------------------------------------------------
const listQuerySchema = z.object({
  universityKey: z.string().min(1).optional(),
});
type ListSchemas = { query: typeof listQuerySchema };

router.get(
  "/portal-program-fallbacks",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ query: listQuerySchema }),
  async (req, res): Promise<void> => {
    const { universityKey } = getValidated<ListSchemas>(req).query;

    const rows = await db
      .select()
      .from(portalProgramFallbacksTable)
      .where(
        and(
          isNull(portalProgramFallbacksTable.deletedAt),
          universityKey
            ? eq(portalProgramFallbacksTable.universityKey, universityKey)
            : undefined,
        ),
      )
      .orderBy(asc(portalProgramFallbacksTable.id));

    const allIds = rows.flatMap((r) => [
      r.sourceProgramId,
      ...r.fallbackProgramIds,
    ]);
    const names = await resolveProgramNames(allIds);

    res.json(rows.map((r) => serialize(r, names)));
  },
);

// ---------------------------------------------------------------------------
// POST /portal-program-fallbacks
// ---------------------------------------------------------------------------
const createBodySchema = z.object({
  universityKey: z.string().min(1),
  sourceProgramId: z.number().int().positive(),
  fallbackProgramIds: z.array(z.number().int().positive()).default([]),
  autoSubmit: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
type CreateSchemas = { body: typeof createBodySchema };

router.post(
  "/portal-program-fallbacks",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: createBodySchema }),
  async (req, res): Promise<void> => {
    const body = getValidated<CreateSchemas>(req).body;
    const user = req.user!;

    let row: FallbackRow;
    try {
      row = await db.transaction(async (tx) => {
        // Serialize same-key creates before the active-row check. The partial
        // unique index remains the database-level final guard for writers that
        // do not use this route.
        const businessKey = `portal-program-fallback:${body.universityKey}:${body.sourceProgramId}`;
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${businessKey}, 0))`,
        );

        const [existing] = await tx
          .select({ id: portalProgramFallbacksTable.id })
          .from(portalProgramFallbacksTable)
          .where(
            and(
              eq(portalProgramFallbacksTable.universityKey, body.universityKey),
              eq(portalProgramFallbacksTable.sourceProgramId, body.sourceProgramId),
              isNull(portalProgramFallbacksTable.deletedAt),
            ),
          )
          .limit(1);

        if (existing) {
          throw new DuplicatePortalProgramFallbackError();
        }

        const [created] = await tx
          .insert(portalProgramFallbacksTable)
          .values({
            universityKey: body.universityKey,
            sourceProgramId: body.sourceProgramId,
            fallbackProgramIds: body.fallbackProgramIds,
            autoSubmit: body.autoSubmit ?? true,
            enabled: body.enabled ?? true,
          })
          .returning();

        if (!created) {
          throw new Error("Portal program fallback insert returned no row");
        }
        return created;
      });
    } catch (error) {
      if (
        error instanceof DuplicatePortalProgramFallbackError ||
        isFallbackUniqueViolation(error)
      ) {
        res.status(409).json({
          error: "DUPLICATE_SOURCE",
          message: `A fallback rule for source program ${body.sourceProgramId} already exists for '${body.universityKey}'`,
        });
        return;
      }
      throw error;
    }

    logAudit(
      user.id,
      "create_portal_program_fallback",
      "portal_program_fallback",
      row.id,
      {
        universityKey: row.universityKey,
        sourceProgramId: row.sourceProgramId,
        fallbackCount: row.fallbackProgramIds.length,
      },
      req.ip,
    );

    const names = await resolveProgramNames([
      row.sourceProgramId,
      ...row.fallbackProgramIds,
    ]);
    res.status(201).json(serialize(row, names));
  },
);

// ---------------------------------------------------------------------------
// PATCH /portal-program-fallbacks/:id
// ---------------------------------------------------------------------------
const updateBodySchema = z
  .object({
    fallbackProgramIds: z.array(z.number().int().positive()).optional(),
    autoSubmit: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "At least one field is required",
  });
type UpdateSchemas = { params: typeof idParamsSchema; body: typeof updateBodySchema };

router.patch(
  "/portal-program-fallbacks/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: idParamsSchema, body: updateBodySchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<UpdateSchemas>(req).params;
    const body = getValidated<UpdateSchemas>(req).body;
    const user = req.user!;

    const [existing] = await db
      .select({ id: portalProgramFallbacksTable.id })
      .from(portalProgramFallbacksTable)
      .where(
        and(
          eq(portalProgramFallbacksTable.id, id),
          isNull(portalProgramFallbacksTable.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    const [row] = await db
      .update(portalProgramFallbacksTable)
      .set({
        ...(body.fallbackProgramIds !== undefined && {
          fallbackProgramIds: body.fallbackProgramIds,
        }),
        ...(body.autoSubmit !== undefined && { autoSubmit: body.autoSubmit }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        updatedAt: new Date(),
      })
      .where(eq(portalProgramFallbacksTable.id, id))
      .returning();

    logAudit(
      user.id,
      "update_portal_program_fallback",
      "portal_program_fallback",
      id,
      {
        ...(body.fallbackProgramIds !== undefined && {
          fallbackCount: body.fallbackProgramIds.length,
        }),
        ...(body.autoSubmit !== undefined && { autoSubmit: body.autoSubmit }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
      },
      req.ip,
    );

    const names = await resolveProgramNames([
      row.sourceProgramId,
      ...row.fallbackProgramIds,
    ]);
    res.json(serialize(row, names));
  },
);

// ---------------------------------------------------------------------------
// DELETE /portal-program-fallbacks/:id  — soft delete
// ---------------------------------------------------------------------------
router.delete(
  "/portal-program-fallbacks/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<IdSchemas>(req).params;
    const user = req.user!;

    const [existing] = await db
      .select({ id: portalProgramFallbacksTable.id })
      .from(portalProgramFallbacksTable)
      .where(
        and(
          eq(portalProgramFallbacksTable.id, id),
          isNull(portalProgramFallbacksTable.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    await db
      .update(portalProgramFallbacksTable)
      .set({ deletedAt: new Date() })
      .where(eq(portalProgramFallbacksTable.id, id));

    logAudit(
      user.id,
      "delete_portal_program_fallback",
      "portal_program_fallback",
      id,
      {},
      req.ip,
    );

    res.json({ ok: true });
  },
);

export default router;
