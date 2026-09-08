import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { requireAuth, requireRole } from "../lib/auth";
import { STAFF_ROLES } from "../lib/roles";
import { getVisibleBranchIds } from "../lib/branchScope";
import {
  OPERATIONS_WORK_STATEMENT_TIMEOUT_MS,
  OperationsWorkQueryError,
  parseOperationsWorkQuery,
  readOperationsWorkPage,
} from "../lib/operationsWorkReadModel";

const router: IRouter = Router();
const GLOBAL_APPLICATION_ROLES = new Set(["super_admin", "admin"]);

router.get(
  "/operations/work-items",
  requireAuth,
  requireRole(...STAFF_ROLES),
  async (req, res): Promise<void> => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    let query;
    try {
      query = parseOperationsWorkQuery(req.query as Record<string, unknown>);
    } catch (error) {
      if (error instanceof OperationsWorkQueryError) {
        res.status(400).json({
          error: error.message,
          code: "OPERATIONS_QUERY_INVALID",
        });
        return;
      }
      throw error;
    }

    const user = req.user!;
    let visibleBranchIds: number[] | null = null;
    try {
      if (!GLOBAL_APPLICATION_ROLES.has(user.role)) {
        visibleBranchIds = await getVisibleBranchIds(user.id, user.role, user);
      }
    } catch (error) {
      console.error("[operations-work] scope resolution failed", {
        code: (error as { code?: string } | null)?.code,
      });
      res.status(503).json({
        error: "Operations scope is temporarily unavailable",
        code: "OPERATIONS_SCOPE_UNAVAILABLE",
      });
      return;
    }

    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      await client.query(
        `SET LOCAL statement_timeout = '${OPERATIONS_WORK_STATEMENT_TIMEOUT_MS}ms'`,
      );
      const page = await readOperationsWorkPage(
        client,
        {
          actorUserId: user.id,
          actorRole: user.role,
          visibleBranchIds,
        },
        query,
      );
      await client.query("COMMIT");
      res.json(page);
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      if (error instanceof OperationsWorkQueryError) {
        res.status(400).json({
          error: error.message,
          code: "OPERATIONS_QUERY_INVALID",
        });
        return;
      }
      const code = (error as { code?: string } | null)?.code;
      console.error("[operations-work] read failed", {
        code,
        message: error instanceof Error ? error.message : "unknown",
      });
      if (code === "57014") {
        res.status(503).json({
          error: "Operations query exceeded its safe execution budget",
          code: "OPERATIONS_TIMEOUT",
        });
        return;
      }
      res.status(503).json({
        error: "Operations data is temporarily unavailable",
        code: "OPERATIONS_UNAVAILABLE",
      });
    } finally {
      client?.release();
    }
  },
);

export default router;
