import { Router } from "express";
import { requireAuth } from "../middleware/authenticate.js";
import { HttpError } from "../utils/httpError.js";

/**
 * Retired editor workflow (mounted at /api/lais-workflow).
 *
 * The LAIS API now creates each transaction's public version and records the
 * transaction on the Plot inside it (see lais/laisService.ts), so editors no longer
 * generate versions. They review them under Version Manager ▸ LAIS transactions instead.
 * These routes stay only to give old clients a clear answer.
 */
export const laisWorkflow = Router();

const gone = () => {
  throw new HttpError(410, "LAIS versions are now created automatically. Review them under Version Manager ▸ LAIS transactions.", "lais_workflow_retired");
};

laisWorkflow.get("/pending", requireAuth, gone);
laisWorkflow.post("/:objectId/version", requireAuth, gone);
