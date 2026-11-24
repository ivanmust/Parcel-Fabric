import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { logger } from "../logging/logger.js";

export const lais = Router();

const TransactionInput = z.object({
  UPI: z.string().trim().min(1).max(100),
  Transaction_ID: z.string().trim().min(1).max(150),
  Transaction_Status: z.string().trim().min(1).max(80),
  Transaction_Date: z.string().trim().min(1).max(64),
}).strict();

type ArcGisJson = {
  error?: { code?: number; message?: string; details?: string[] };
  token?: string;
  expires?: number;
  features?: Array<{ attributes?: Record<string, unknown> }>;
  addResults?: Array<{ success?: boolean; objectId?: number; error?: { description?: string } }>;
  count?: number;
};

let tokenCache: { value: string; expiresAt: number } | null = null;

function sameSecret(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Dedicated LAIS authentication; never accepts or reuses a browser Portal token. */
lais.use((req, _res, next) => {
  if (config.LAIS_API_KEY.length < 32 || !sameSecret(req.header("x-api-key"), config.LAIS_API_KEY)) {
    throw new HttpError(401, "Valid LAIS API credentials are required", "lais_unauthorized");
  }
  next();
});

async function arcgisPost(url: string, params: Record<string, string>): Promise<ArcGisJson> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as ArcGisJson;
  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? `ArcGIS request failed (HTTP ${response.status})`);
  }
  return body;
}

/** Short-lived Portal token for a dedicated, least-privilege GIS integration account. */
async function arcgisToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  if (!config.LAIS_ARCGIS_USERNAME || !config.LAIS_ARCGIS_PASSWORD) {
    throw new Error("LAIS ArcGIS integration account is not configured");
  }
  const body = await arcgisPost(`${config.PORTAL_URL}/sharing/rest/generateToken`, {
    f: "json",
    username: config.LAIS_ARCGIS_USERNAME,
    password: config.LAIS_ARCGIS_PASSWORD,
    client: "referer",
    referer: config.LAIS_ARCGIS_REFERER,
    expiration: "30",
  });
  if (!body.token) throw new Error("ArcGIS did not issue an integration token");
  tokenCache = { value: body.token, expiresAt: body.expires ?? Date.now() + 25 * 60_000 };
  return body.token;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function queryCount(url: string, where: string, token: string): Promise<number> {
  const body = await arcgisPost(`${url}/query`, {
    f: "json", token, where, returnCountOnly: "true",
  });
  if (typeof body.count !== "number") throw new Error("ArcGIS query did not return a count");
  return body.count;
}

const UPI_PATTERN = /^\d\/\d{2}\/\d{2}\/\d{2}\/\d+$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidTransactionDate(value: string): boolean {
  if (!ISO_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value))) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi, sec = "0", fraction = "0", zone, zoneHour = "0", zoneMinute = "0"] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(sec);
  const millis = Number(fraction.padEnd(3, "0"));
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  if (
    local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day ||
    hour > 23 || minute > 59 || second > 59
  ) return false;
  if (zone !== "Z") {
    const offsetHour = Number(zoneHour), offsetMinute = Number(zoneMinute);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return true;
}

/**
 * LAIS transaction intake.
 *
 * case is API-owned: LAIS cannot supply it. Failed submissions return case=No
 * and are not written to the GIS transaction table. Only fully validated
 * records are written with case=Yes and version_status=Pending.
 */
lais.post("/transactions", async (req, res) => {
  const parsed = TransactionInput.safeParse(req.body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      code: issue.code === "invalid_type" ? "INVALID_TYPE" : "REQUIRED_OR_INVALID",
      message: issue.message,
    }));
    res.status(422).json({ success: false, case: "No", message: "Validation failed", errors });
    return;
  }

  const input = parsed.data;
  const errors: Array<{ field: string; code: string; message: string }> = [];
  if (!UPI_PATTERN.test(input.UPI)) {
    errors.push({ field: "UPI", code: "INVALID_UPI_FORMAT", message: "UPI must follow province/district/sector/cell/number, for example 1/02/13/02/1001." });
  }
  if (!isValidTransactionDate(input.Transaction_Date)) {
    errors.push({ field: "Transaction_Date", code: "INVALID_DATE", message: "Use an ISO 8601 date-time with an explicit timezone, for example 2026-11-24T08:30:00+02:00." });
  }
  if (config.LAIS_ALLOWED_STATUSES.length && !config.LAIS_ALLOWED_STATUSES.includes(input.Transaction_Status)) {
    errors.push({ field: "Transaction_Status", code: "INVALID_STATUS", message: `Allowed statuses: ${config.LAIS_ALLOWED_STATUSES.join(", ")}.` });
  }
  if (errors.length) {
    res.status(422).json({ success: false, case: "No", message: "Validation failed", errors });
    return;
  }

  if (!config.LAIS_PARCEL_LAYER_URL || !config.LAIS_TRANSACTION_TABLE_URL) {
    throw new HttpError(503, "LAIS GIS integration is not configured. Configure the parcel layer and transaction table URLs before accepting transactions.", "lais_integration_not_configured");
  }

  try {
    const token = await arcgisToken();
    const parcelCount = await queryCount(
      config.LAIS_PARCEL_LAYER_URL,
      `name = ${sqlString(input.UPI)}`,
      token,
    );
    if (parcelCount !== 1) {
      res.status(422).json({
        success: false, case: "No", message: "Validation failed",
        errors: [{
          field: "UPI",
          code: parcelCount === 0 ? "PARCEL_NOT_FOUND" : "UPI_NOT_UNIQUE",
          message: parcelCount === 0 ? "No parcel with this UPI exists in GIS." : "More than one parcel has this UPI in GIS. Resolve the duplicate before submitting.",
        }],
      });
      return;
    }

    const existing = await arcgisPost(`${config.LAIS_TRANSACTION_TABLE_URL}/query`, {
      f: "json",
      token,
      where: `Transaction_ID = ${sqlString(input.Transaction_ID)}`,
      outFields: "UPI,Transaction_ID,Transaction_Status,Transaction_Date,case,version_status",
      returnGeometry: "false",
    });
    const existingRecord = existing.features?.[0]?.attributes;
    if (existingRecord) {
      const samePayload =
        existingRecord.UPI === input.UPI &&
        existingRecord.Transaction_Status === input.Transaction_Status &&
        Number(existingRecord.Transaction_Date) === Date.parse(input.Transaction_Date);
      if (samePayload && existingRecord.case === "Yes") {
        res.status(200).json({
          success: true,
          case: "Yes",
          message: "This transaction was already validated and recorded.",
          data: {
            ...input,
            Transaction_Date: new Date(Date.parse(input.Transaction_Date)).toISOString(),
            case: "Yes",
            version_status: String(existingRecord.version_status ?? "Pending"),
            duplicate: true,
          },
        });
        return;
      }
      res.status(409).json({
        success: false, case: "No", message: "Transaction_ID has already been used for a different payload.",
        errors: [{ field: "Transaction_ID", code: "DUPLICATE_TRANSACTION_ID", message: "Use a new Transaction_ID. Existing records are not overwritten." }],
      });
      return;
    }

    const add = await arcgisPost(`${config.LAIS_TRANSACTION_TABLE_URL}/applyEdits`, {
      f: "json",
      token,
      rollbackOnFailure: "true",
      adds: JSON.stringify([{
        attributes: {
          UPI: input.UPI,
          Transaction_ID: input.Transaction_ID,
          Transaction_Status: input.Transaction_Status,
          Transaction_Date: Date.parse(input.Transaction_Date),
          case: "Yes",
          validation_message: "Validated",
          created_at: Date.now(),
          version_status: "Pending",
        },
      }]),
    });
    const result = add.addResults?.[0];
    if (!result?.success) {
      throw new Error(result?.error?.description ?? "ArcGIS did not confirm the transaction table insert");
    }

    res.status(201).json({
      success: true,
      case: "Yes",
      message: "Transaction validated and recorded.",
      data: {
        ...input,
        Transaction_Date: new Date(Date.parse(input.Transaction_Date)).toISOString(),
        case: "Yes",
        version_status: "Pending",
        objectId: result.objectId,
      },
    });
  } catch (error) {
    // Keep detailed causes in server logs only; never disclose Portal/service internals to LAIS.
    logger.error({ err: error, transactionId: input.Transaction_ID }, "LAIS transaction GIS operation failed");
    throw new HttpError(502, "GIS could not validate or record the transaction. Contact the GIS integration administrator.", "lais_gis_unavailable");
  }
});
