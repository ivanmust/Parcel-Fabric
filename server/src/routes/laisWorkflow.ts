import { Router } from "express";
import { z } from "zod";
import { config } from "../config/env.js";
import { requireAuth, requirePermission } from "../middleware/authenticate.js";
import { HttpError } from "../utils/httpError.js";

export const laisWorkflow = Router();

type ArcGisFeature = { attributes?: Record<string, unknown> };
type ArcGisResponse = {
  error?: { code?: number; message?: string; details?: string[] };
  objectIdFieldName?: string;
  features?: ArcGisFeature[];
  updateResults?: Array<{ success?: boolean; error?: { description?: string } }>;
};

function portalReferer(origin?: string): string {
  return origin && config.APP_ORIGINS.includes(origin) ? origin : config.APP_ORIGINS[0] ?? "";
}

async function arcgisPost(url: string, params: Record<string, string>, token: string, referer?: string): Promise<ArcGisResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(referer ? { Referer: `${referer}/` } : {}),
    },
    body: new URLSearchParams({ ...params, token, f: "json" }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as ArcGisResponse;
  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? `ArcGIS request failed (HTTP ${response.status})`);
  }
  return body;
}

function tableUrl(): string {
  if (!config.LAIS_TRANSACTION_TABLE_URL) {
    throw new HttpError(503, "The LAIS transaction table is not configured.", "lais_table_not_configured");
  }
  return config.LAIS_TRANSACTION_TABLE_URL;
}

/** List validated LAIS transactions that have not yet had a version created. */
laisWorkflow.get("/pending", requireAuth, requirePermission("versions:manage"), async (req, res) => {
  try {
    const body = await arcgisPost(
      `${tableUrl()}/query`,
      {
        where: "case = 'Yes' AND version_status = 'Pending'",
        outFields: "*",
        returnGeometry: "false",
        orderByFields: "Transaction_Date ASC",
      },
      req.portalToken!,
      portalReferer(req.header("x-client-origin") ?? req.header("origin")),
    );
    res.json({
      transactions: (body.features ?? []).map((feature) => ({
        objectId: feature.attributes?.[body.objectIdFieldName ?? "OBJECTID"],
        attributes: feature.attributes ?? {},
      })),
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not load pending LAIS transactions from GIS.", "lais_workflow_unavailable");
  }
});

const CompleteVersionBody = z.object({
  versionName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,61}$/),
}).strict();

/**
 * Record a named version after the signed-in editor has created it with the
 * existing VersionManagementService. This endpoint never creates versions.
 */
laisWorkflow.post("/:objectId/version", requireAuth, requirePermission("versions:manage"), async (req, res) => {
  const objectId = z.coerce.number().int().positive().safeParse(req.params.objectId);
  const body = CompleteVersionBody.safeParse(req.body);
  if (!objectId.success || !body.success) {
    throw new HttpError(400, "A valid transaction object ID and versionName are required.", "invalid_lais_version_update");
  }

  try {
    const url = tableUrl();
    const referer = portalReferer(req.header("x-client-origin") ?? req.header("origin"));
    const query = await arcgisPost(
      `${url}/query`,
      {
        objectIds: String(objectId.data),
        outFields: "*",
        returnGeometry: "false",
      },
      req.portalToken!,
      referer,
    );
    const feature = query.features?.[0];
    const attributes = feature?.attributes;
    if (!attributes) throw new HttpError(404, "LAIS transaction was not found.", "lais_transaction_not_found");
    if (attributes.case !== "Yes") throw new HttpError(409, "Only validated transactions (case = Yes) can be linked to a version.", "lais_transaction_not_validated");
    if (attributes.version_status === "Created") {
      if (attributes.version_name !== body.data.versionName) {
        throw new HttpError(409, "This transaction is already linked to a different version.", "lais_transaction_already_linked");
      }
      res.json({ success: true, versionName: body.data.versionName, alreadyRecorded: true });
      return;
    }
    if (attributes.version_status !== "Pending") {
      throw new HttpError(409, "This transaction is not pending version generation.", "lais_transaction_not_pending");
    }

    const objectIdField = query.objectIdFieldName ?? "OBJECTID";
    const update = await arcgisPost(
      `${url}/applyEdits`,
      {
        rollbackOnFailure: "true",
        updates: JSON.stringify([{
          attributes: {
            [objectIdField]: objectId.data,
            version_name: body.data.versionName,
            version_status: "Created",
          },
        }]),
      },
      req.portalToken!,
      referer,
    );
    const result = update.updateResults?.[0];
    if (!result?.success) throw new Error(result?.error?.description ?? "ArcGIS did not confirm the transaction update");
    res.json({ success: true, versionName: body.data.versionName, alreadyRecorded: false });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not save the generated version reference to the GIS transaction table.", "lais_version_record_failed");
  }
});
