import { createHash, randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import { arcgisPost, ArcGisError, type ArcGisJson } from "./arcgisClient.js";
import { clearLedgerForTests, getEntry, putEntry, type LedgerEntry } from "./ledger.js";

/**
 * LAIS transaction workflow on the branch-versioned Plot layer (FeatureServer/17).
 *
 *   1. find exactly one Plot in sde.DEFAULT whose `name` (UPI) matches
 *   2. reject a Transaction_ID that is already recorded (DEFAULT or its LAIS version)
 *   3. create a PUBLIC named version LAIS_<id>_<hash> owned by the integration account
 *   4. startReading → startEditing(sessionId) → applyEdits(gdbVersion, sessionID) → stopEditing(save)
 *
 * Edits are attribute-only UPDATES of that one Plot, always inside the named version.
 * Nothing is ever written to sde.DEFAULT; reconcile/post stay with authorised GIS editors.
 * The version name is derived from Transaction_ID, so it is also the idempotency key: a
 * retry finds the version and either returns the recorded result or finishes the edit.
 */

export const TRANSACTION_TYPES = ["Subdivision", "Merge", "CorrectBoundaries", "CreatePlot"] as const;
export const TRANSACTION_STATUSES = ["New", "InProgress", "Approved", "Rejected"] as const;
export const VERSION_PREFIX = "LAIS_";

export interface LaisSubmission {
  UPI: string;
  Transaction_ID: string;
  Transaction_Type: string;
  Transaction_Date: string;
  Transaction_Status?: string;
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface LaisRecord {
  UPI: string | null;
  Transaction_ID: string | null;
  Transaction_Type: string | null;
  Transaction_Status: string | null;
  Transaction_Date: string | null;
  case: string | null;
  validation_message: string | null;
  version_name: string | null;
  version_status: string | null;
  /**
   * InReview: its LAIS version exists and awaits GIS review.
   * Posted:   the transaction fields are in sde.DEFAULT.
   * Closed:   its version no longer exists (reconciled/posted or deleted by GIS).
   */
  stage: "InReview" | "Posted" | "Closed";
}

export type SubmitOutcome =
  | { kind: "created"; record: LaisRecord }
  | { kind: "duplicate"; record: LaisRecord }
  | { kind: "conflict"; errors: FieldError[] }
  | { kind: "invalid"; errors: FieldError[] };

/** Thrown when the deployed service does not look like what this API was built for. */
export class LaisConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaisConfigurationError";
  }
}

// ---------------------------------------------------------------- input validation

const UPI_PATTERN = /^\d\/\d{2}\/\d{2}\/\d{2}\/\d+$/;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/;
const ALLOWED_KEYS = new Set(["UPI", "Transaction_ID", "Transaction_Type", "Transaction_Date", "Transaction_Status"]);
const MAX = { UPI: 100, Transaction_ID: 50, Transaction_Type: 25, Transaction_Date: 64, Transaction_Status: 25 } as const;

export function isValidTransactionDate(value: string): boolean {
  const m = ISO_WITH_ZONE.exec(value);
  if (!m || Number.isNaN(Date.parse(value))) return false;
  const [, y, mo, d, h, mi, sec = "0", , zone, zh = "0", zm = "0"] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const local = new Date(Date.UTC(year, month - 1, day));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return false;
  if (zone !== "Z" && (Number(zh) > 14 || Number(zm) > 59 || (Number(zh) === 14 && Number(zm) !== 0))) return false;
  return true;
}

function matchCode<T extends string>(value: string, codes: readonly T[]): T | undefined {
  return codes.find((c) => c.toLowerCase() === value.toLowerCase());
}

/** Validate the LAIS request body. Field-specific errors; `case` and unknown keys are rejected. */
export function validateSubmission(body: unknown): { ok: true; value: LaisSubmission } | { ok: false; errors: FieldError[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", code: "INVALID_BODY", message: "Send a JSON object with Content-Type: application/json." }] };
  }
  const input = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push({ field: key, code: "UNKNOWN_FIELD", message: key === "case" ? "case is decided by the GIS API and must not be sent." : `Unknown field ${key}.` });
    }
  }

  const text = (field: keyof typeof MAX, required: boolean): string | undefined => {
    const raw = input[field];
    if (raw === undefined || raw === null) {
      if (required) errors.push({ field, code: "REQUIRED_FIELD", message: `${field} is required.` });
      return undefined;
    }
    if (typeof raw !== "string") {
      errors.push({ field, code: "INVALID_TYPE", message: `${field} must be a string.` });
      return undefined;
    }
    const value = raw.trim();
    if (!value) {
      if (required) errors.push({ field, code: "REQUIRED_FIELD", message: `${field} must not be empty.` });
      return undefined;
    }
    if (value.length > MAX[field]) {
      errors.push({ field, code: "TOO_LONG", message: `${field} must be at most ${MAX[field]} characters.` });
      return undefined;
    }
    return value;
  };

  const UPI = text("UPI", true);
  const Transaction_ID = text("Transaction_ID", true);
  const typeRaw = text("Transaction_Type", true);
  const Transaction_Date = text("Transaction_Date", true);
  const statusRaw = text("Transaction_Status", false);

  if (UPI && !UPI_PATTERN.test(UPI)) {
    errors.push({ field: "UPI", code: "INVALID_UPI_FORMAT", message: "UPI must follow province/district/sector/cell/number, for example 1/02/13/02/1001." });
  }
  if (Transaction_ID && !TRANSACTION_ID_PATTERN.test(Transaction_ID)) {
    errors.push({ field: "Transaction_ID", code: "INVALID_FORMAT", message: "Transaction_ID may contain letters, digits and . _ - : / and must start with a letter or digit." });
  }
  const Transaction_Type = typeRaw ? matchCode(typeRaw, TRANSACTION_TYPES) : undefined;
  if (typeRaw && !Transaction_Type) {
    errors.push({ field: "Transaction_Type", code: "INVALID_TRANSACTION_TYPE", message: `Allowed values: ${TRANSACTION_TYPES.join(", ")}.` });
  }
  const Transaction_Status = statusRaw ? matchCode(statusRaw, TRANSACTION_STATUSES) : undefined;
  if (statusRaw && !Transaction_Status) {
    errors.push({ field: "Transaction_Status", code: "INVALID_TRANSACTION_STATUS", message: `Allowed values: ${TRANSACTION_STATUSES.join(", ")}.` });
  }
  if (Transaction_Date && !isValidTransactionDate(Transaction_Date)) {
    errors.push({ field: "Transaction_Date", code: "INVALID_DATE", message: "Use an ISO 8601 date-time with an explicit timezone, for example 2026-11-24T08:30:00+02:00." });
  }

  if (errors.length || !UPI || !Transaction_ID || !Transaction_Type || !Transaction_Date) {
    return { ok: false, errors };
  }
  return { ok: true, value: { UPI, Transaction_ID, Transaction_Type, Transaction_Date, ...(Transaction_Status ? { Transaction_Status } : {}) } };
}

// ---------------------------------------------------------------- naming

/** Deterministic version name (letters/digits/underscore, ≤ 62 chars) from Transaction_ID. */
export function versionNameFor(transactionId: string): string {
  const hash = createHash("sha256").update(transactionId).digest("hex").slice(0, 8).toUpperCase();
  const base = transactionId.replace(/[^A-Za-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  return `${VERSION_PREFIX}${base}_${hash}`;
}

const sql = (value: string) => `'${value.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------- layer schema

const LOGICAL_FIELDS = {
  upi: "name",
  transactionId: "transaction_id",
  transactionType: "transaction_type",
  transactionStatus: "transaction_status",
  transactionDate: "transaction_date",
  case: "case_",
  validationMessage: "validation_message",
  versionStatus: "version_status",
  versionName: "version_name",
} as const;
type Logical = keyof typeof LOGICAL_FIELDS;

interface LayerSchema {
  objectIdField: string;
  fields: Record<Logical, string>;
  domains: Partial<Record<Logical, string[]>>;
}

let schemaCache: { value: LayerSchema; at: number } | null = null;
const SCHEMA_TTL_MS = 10 * 60_000;

async function layerSchema(token: string): Promise<LayerSchema> {
  if (schemaCache && Date.now() - schemaCache.at < SCHEMA_TTL_MS) return schemaCache.value;
  const meta = await arcgisPost(config.lais.plotLayerUrl, {}, token);
  if (meta.isDataBranchVersioned !== true) {
    throw new LaisConfigurationError("The configured Plot layer is not branch versioned; refusing to edit it.");
  }
  const byLower = new Map<string, { name: string; domain?: { codedValues?: Array<{ code: unknown }> } }>();
  for (const f of meta.fields ?? []) byLower.set(String(f.name).toLowerCase(), f);
  const fields = {} as Record<Logical, string>;
  const domains: Partial<Record<Logical, string[]>> = {};
  const missing: string[] = [];
  for (const [logical, expected] of Object.entries(LOGICAL_FIELDS) as Array<[Logical, string]>) {
    const f = byLower.get(expected);
    if (!f) missing.push(expected);
    else {
      fields[logical] = f.name;
      if (f.domain?.codedValues) domains[logical] = f.domain.codedValues.map((c) => String(c.code));
    }
  }
  if (missing.length) throw new LaisConfigurationError(`The Plot layer is missing fields: ${missing.join(", ")}`);
  for (const [logical, code] of [["case", "Yes"], ["versionStatus", "VersionCreated"]] as const) {
    const codes = domains[logical];
    if (codes && !codes.includes(code)) throw new LaisConfigurationError(`Domain of ${fields[logical]} has no '${code}' code.`);
  }
  const value: LayerSchema = { objectIdField: String(meta.objectIdField ?? "objectid"), fields, domains };
  schemaCache = { value, at: Date.now() };
  return value;
}

// ---------------------------------------------------------------- ArcGIS helpers

interface VersionRef {
  /** Fully qualified, e.g. owner.LAIS_X_ABCD1234 */
  name: string;
  guid: string;
}

type Attributes = Record<string, unknown>;

async function queryPlots(token: string, schema: LayerSchema, where: string, gdbVersion?: string, outFields?: string[]): Promise<Attributes[]> {
  const body = await arcgisPost(
    `${config.lais.plotLayerUrl}/query`,
    {
      where,
      outFields: (outFields ?? [schema.objectIdField, ...Object.values(schema.fields)]).join(","),
      returnGeometry: "false",
      resultRecordCount: "3",
      ...(gdbVersion ? { gdbVersion } : {}),
    },
    token,
  );
  return (body.features ?? []).map((f: { attributes?: Attributes }) => f.attributes ?? {});
}

async function findVersion(token: string, shortName: string): Promise<VersionRef | null> {
  const body = await arcgisPost(`${config.lais.versionManagementUrl}/versionInfos`, { ownerFilter: config.LAIS_ARCGIS_USERNAME }, token);
  const owner = config.LAIS_ARCGIS_USERNAME.toLowerCase();
  for (const v of (body.versions ?? []) as Array<{ versionName?: string; versionGuid?: string }>) {
    const full = String(v.versionName ?? "");
    const dot = full.lastIndexOf(".");
    if (dot < 0 || !v.versionGuid) continue;
    if (full.slice(dot + 1).toLowerCase() === shortName.toLowerCase() && full.slice(0, dot).toLowerCase() === owner) {
      return { name: full, guid: v.versionGuid };
    }
  }
  return null;
}

async function createVersion(token: string, shortName: string, description: string): Promise<VersionRef> {
  try {
    const body = await arcgisPost(
      `${config.lais.versionManagementUrl}/create`,
      { versionName: shortName, description: description.slice(0, 60), accessPermission: "public" },
      token,
    );
    const info = body.versionInfo as { versionName?: string; versionGuid?: string } | undefined;
    if (!info?.versionName || !info.versionGuid) throw new ArcGisError("ArcGIS did not return the created version");
    return { name: info.versionName, guid: info.versionGuid };
  } catch (error) {
    // Another process may have created it a moment ago: use it rather than fail.
    const existing = await findVersion(token, shortName).catch(() => null);
    if (existing) return existing;
    throw error;
  }
}

/**
 * ArcGIS refusals that retrying can never fix (licence, privilege, ownership) are configuration
 * problems of the integration account: report them as such (503), not as a transient 502.
 */
const PERMANENT_REFUSAL = /user type extension|not been assigned|not licensed|license|permission|not authorized|insufficient privilege|does not have (the )?(required )?privilege/i;

function asConfigurationError(error: unknown): unknown {
  if (error instanceof ArcGisError && (error.code === 403 || PERMANENT_REFUSAL.test(error.message))) {
    return new LaisConfigurationError(`The LAIS ArcGIS account cannot edit: ${error.message}`);
  }
  return error;
}

function assertSuccess(body: ArcGisJson, what: string): void {
  if (body.success === false) throw new ArcGisError(`ArcGIS refused ${what}`);
}

/** Attribute update of exactly one Plot inside `version`, in its own exclusive edit session. */
async function editInVersion(token: string, version: VersionRef, attributes: Attributes): Promise<void> {
  const sessionId = `{${randomUUID().toUpperCase()}}`;
  const versionUrl = `${config.lais.versionManagementUrl}/versions/${version.guid.replace(/[{}]/g, "")}`;
  let reading = false;
  let editing = false;
  try {
    assertSuccess(await arcgisPost(`${versionUrl}/startReading`, { sessionId }, token), "startReading");
    reading = true;
    assertSuccess(await arcgisPost(`${versionUrl}/startEditing`, { sessionId }, token), "startEditing");
    editing = true;
    const result = await arcgisPost(
      `${config.lais.plotLayerUrl}/applyEdits`,
      { gdbVersion: version.name, sessionID: sessionId, rollbackOnFailure: "true", updates: JSON.stringify([{ attributes }]) },
      token,
    );
    const update = result.updateResults?.[0] as { success?: boolean; error?: { description?: string } } | undefined;
    if (!update?.success) throw new ArcGisError(update?.error?.description ?? "ArcGIS did not confirm the Plot update");
    assertSuccess(await arcgisPost(`${versionUrl}/stopEditing`, { sessionId, saveEdits: "true" }, token), "stopEditing");
    editing = false;
  } catch (error) {
    if (editing) {
      await arcgisPost(`${versionUrl}/stopEditing`, { sessionId, saveEdits: "false" }, token).catch((e) =>
        logger.error({ err: (e as Error).message, version: version.name }, "LAIS: could not discard edit session"),
      );
    }
    throw asConfigurationError(error);
  } finally {
    if (reading) {
      await arcgisPost(`${versionUrl}/stopReading`, { sessionId }, token).catch((e) =>
        logger.warn({ err: (e as Error).message, version: version.name }, "LAIS: could not release read lock"),
      );
    }
  }
}

// ---------------------------------------------------------------- record mapping

function toIso(value: unknown): string | null {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

function toRecord(schema: LayerSchema, a: Attributes, stage: LaisRecord["stage"]): LaisRecord {
  const s = (k: Logical) => (a[schema.fields[k]] === undefined || a[schema.fields[k]] === null ? null : String(a[schema.fields[k]]));
  return {
    UPI: s("upi"),
    Transaction_ID: s("transactionId"),
    Transaction_Type: s("transactionType"),
    Transaction_Status: s("transactionStatus"),
    Transaction_Date: toIso(a[schema.fields.transactionDate]),
    case: s("case"),
    validation_message: s("validationMessage"),
    version_name: s("versionName"),
    version_status: s("versionStatus"),
    stage,
  };
}

function samePayload(schema: LayerSchema, a: Attributes, input: LaisSubmission): boolean {
  const f = schema.fields;
  return (
    a[f.upi] === input.UPI &&
    a[f.transactionType] === input.Transaction_Type &&
    Number(a[f.transactionDate]) === Date.parse(input.Transaction_Date) &&
    (input.Transaction_Status === undefined || a[f.transactionStatus] === input.Transaction_Status)
  );
}

/** Is this Transaction_ID already in sde.DEFAULT (i.e. its fields were posted)? */
async function findPosted(token: string, schema: LayerSchema, transactionId: string): Promise<{ record: Attributes | null; duplicates: boolean }> {
  const rows = await queryPlots(token, schema, `${schema.fields.transactionId} = ${sql(transactionId)}`);
  return { record: rows[0] ?? null, duplicates: rows.length > 1 };
}

const VALIDATED = "Validated by the LAIS integration API";

function entryMatches(e: LedgerEntry, input: LaisSubmission): boolean {
  return (
    e.UPI === input.UPI &&
    e.Transaction_Type === input.Transaction_Type &&
    Date.parse(e.Transaction_Date) === Date.parse(input.Transaction_Date) &&
    (e.Transaction_Status ?? undefined) === input.Transaction_Status
  );
}

function entryRecord(e: LedgerEntry, stage: LaisRecord["stage"]): LaisRecord {
  return {
    UPI: e.UPI,
    Transaction_ID: e.Transaction_ID,
    Transaction_Type: e.Transaction_Type,
    Transaction_Status: e.Transaction_Status ?? null,
    Transaction_Date: new Date(Date.parse(e.Transaction_Date)).toISOString(),
    case: "Yes",
    validation_message: VALIDATED,
    version_name: e.versionName,
    version_status: e.versionName ? "VersionCreated" : "Pending",
    stage,
  };
}

const duplicateIdError = (message: string): FieldError[] => [{ field: "Transaction_ID", code: "DUPLICATE_TRANSACTION_ID", message }];

// ---------------------------------------------------------------- per-transaction lock

const locks = new Map<string, Promise<unknown>>();

/** Serialise work on one Transaction_ID inside this process (concurrent identical retries). */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

// ---------------------------------------------------------------- public API

export async function submitTransaction(token: string, input: LaisSubmission): Promise<SubmitOutcome> {
  return withLock(input.Transaction_ID.toLowerCase(), async () => {
    const schema = await layerSchema(token);
    const f = schema.fields;

    for (const [logical, value, field] of [
      ["transactionType", input.Transaction_Type, "Transaction_Type"],
      ["transactionStatus", input.Transaction_Status, "Transaction_Status"],
    ] as const) {
      const codes = schema.domains[logical];
      if (value !== undefined && codes && !codes.includes(value)) {
        return { kind: "invalid", errors: [{ field, code: field === "Transaction_Type" ? "INVALID_TRANSACTION_TYPE" : "INVALID_TRANSACTION_STATUS", message: `Allowed values: ${codes.join(", ")}.` }] };
      }
    }

    const plots = await queryPlots(token, schema, `${f.upi} = ${sql(input.UPI)}`, undefined, [schema.objectIdField, f.upi]);
    if (plots.length !== 1) {
      return {
        kind: "invalid",
        errors: [plots.length === 0
          ? { field: "UPI", code: "PARCEL_NOT_FOUND", message: "No parcel with this UPI exists in GIS." }
          : { field: "UPI", code: "UPI_NOT_UNIQUE", message: "More than one parcel has this UPI in GIS. GIS must resolve the duplicate before this transaction can be accepted." }],
      };
    }
    const objectId = Number(plots[0]![schema.objectIdField]);

    const usedElsewhere = duplicateIdError("Transaction_ID has already been used for a different transaction. Use a new Transaction_ID; existing records are not overwritten.");

    // 1. Already posted to sde.DEFAULT (fields present on the Plot)?
    const posted = await findPosted(token, schema, input.Transaction_ID);
    if (posted.duplicates) return { kind: "conflict", errors: duplicateIdError("GIS holds more than one Plot with this Transaction_ID. Contact the GIS integration administrator.") };
    if (posted.record) {
      return samePayload(schema, posted.record, input)
        ? { kind: "duplicate", record: toRecord(schema, posted.record, "Posted") }
        : { kind: "conflict", errors: usedElsewhere };
    }

    // 2. Already accepted by this API?
    const entry = await getEntry(input.Transaction_ID);
    if (entry && !entryMatches(entry, input)) return { kind: "conflict", errors: usedElsewhere };

    const shortName = versionNameFor(input.Transaction_ID);
    let version = await findVersion(token, shortName);
    const writeAttributes = config.LAIS_WRITE_MODE === "attributes";

    if (entry?.versionName && !version) {
      // Its version was reconciled/posted or deleted by GIS: the transaction is closed. Never recreate it.
      return { kind: "duplicate", record: entryRecord(entry, "Closed") };
    }
    if (entry && version && (entry.attributesWritten || !writeAttributes)) {
      return { kind: "duplicate", record: entryRecord(entry, "InReview") };
    }
    if (!entry && version) {
      return { kind: "conflict", errors: duplicateIdError("A GIS version for this Transaction_ID already exists but has no API record. Contact the GIS integration administrator.") };
    }

    // 3. New transaction, or the completion of an earlier attempt that failed part-way.
    //    Record the intent first so a failure after version creation is recoverable on retry.
    let current = entry ?? (await putEntry({ ...input, objectId, versionName: null, attributesWritten: false }));
    version ??= await createVersion(token, shortName, `LAIS ${input.Transaction_Type} UPI ${input.UPI} ${input.Transaction_ID}`);
    current = await putEntry({ ...current, versionName: version.name });

    if (writeAttributes && !current.attributesWritten) {
      await editInVersion(token, version, {
        [schema.objectIdField]: objectId,
        [f.transactionId]: input.Transaction_ID,
        [f.transactionType]: input.Transaction_Type,
        [f.transactionDate]: Date.parse(input.Transaction_Date),
        [f.case]: "Yes",
        [f.validationMessage]: VALIDATED,
        [f.versionStatus]: "VersionCreated",
        [f.versionName]: version.name,
        ...(input.Transaction_Status ? { [f.transactionStatus]: input.Transaction_Status } : {}),
      });
      current = await putEntry({ ...current, attributesWritten: true });
    }
    logger.info({ transactionId: input.Transaction_ID, version: version.name, objectId, mode: config.LAIS_WRITE_MODE }, "LAIS transaction accepted");
    return { kind: "created", record: entryRecord(current, "InReview") };
  });
}

export type StatusOutcome = { kind: "found"; record: LaisRecord } | { kind: "not_found" } | { kind: "conflict" };

export async function transactionStatus(token: string, transactionId: string): Promise<StatusOutcome> {
  const schema = await layerSchema(token);
  const posted = await findPosted(token, schema, transactionId);
  if (posted.duplicates) return { kind: "conflict" };
  if (posted.record) return { kind: "found", record: toRecord(schema, posted.record, "Posted") };
  const entry = await getEntry(transactionId);
  if (!entry) return { kind: "not_found" };
  const version = entry.versionName ? await findVersion(token, versionNameFor(transactionId)) : null;
  return { kind: "found", record: entryRecord(entry, entry.versionName && !version ? "Closed" : "InReview") };
}

/** Test hook. */
export async function resetLaisCachesForTests(): Promise<void> {
  schemaCache = null;
  locks.clear();
  await clearLedgerForTests();
}
