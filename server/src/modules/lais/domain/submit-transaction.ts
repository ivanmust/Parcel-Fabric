import { config } from "../../../config/env.js";
import { logger } from "../../../common/logging/logger.js";
import { withLock } from "../../../common/utils/lock.js";
import { allEntries, getEntry, putEntry } from "../repositories/ledger.repository.js";
import { layerSchema, type LayerSchema } from "../repositories/plot-layer.repository.js";
import { createVersion, editInVersion, findVersion, ownedVersions, type VersionRef } from "../repositories/version.repository.js";
import type { LedgerEntry } from "../models/ledger-entry.model.js";
import type { Attributes, FieldError, LaisSubmission, SubmitOutcome } from "../models/transaction.model.js";
import { mergeNeighbourProblem, resolveParcels } from "./parcel-rules.js";
import { duplicateIdError, entryMatches, entryRecord, findPosted, samePayload, toRecord, VALIDATED } from "./transaction-records.js";
import { describeEntry, detectCompletion } from "./transaction-progress.js";
import { shortVersionName, versionNameFor } from "./version-naming.js";

/** Lock key: checking that parcels are free and recording a new transaction happen one at a time. */
const NEW_SUBMISSIONS = "\u0000new-submissions";

const USED_ELSEWHERE = "Transaction_ID has already been used for a different transaction. Use a new Transaction_ID; existing records are not overwritten.";
const INCONSISTENT = "GIS holds different transactions under this Transaction_ID. Contact the GIS integration administrator.";

type FieldNamer = (index: number) => string;

const writesAttributes = () => config.LAIS_WRITE_MODE === "attributes";
const invalid = (errors: FieldError[]): SubmitOutcome => ({ kind: "invalid", errors });
const conflict = (message: string): SubmitOutcome => ({ kind: "conflict", errors: duplicateIdError(message) });

/** Type and status must be codes of the Plot layer's domains. */
function domainErrors(schema: LayerSchema, input: LaisSubmission): FieldError[] {
  const checks = [
    { logical: "transactionType", value: input.Transaction_Type, field: "Transaction_Type", code: "INVALID_TRANSACTION_TYPE" },
    { logical: "transactionStatus", value: input.Transaction_Status, field: "Transaction_Status", code: "INVALID_TRANSACTION_STATUS" },
  ] as const;
  for (const { logical, value, field, code } of checks) {
    const codes = schema.domains[logical];
    if (value !== undefined && codes && !codes.includes(value)) return [{ field, code, message: `Allowed values: ${codes.join(", ")}.` }];
  }
  return [];
}

/** The Plot's transaction_id field must hold the id when the fields are written on the Plot. */
function transactionIdTooLong(schema: LayerSchema, input: LaisSubmission, entry: LedgerEntry | undefined): FieldError[] {
  const room = schema.lengths.transactionId;
  if (!writesAttributes() || !room || input.Transaction_ID.length <= room || entry?.attributesWritten) return [];
  return [
    {
      field: "Transaction_ID",
      code: "TOO_LONG_FOR_GIS",
      message: `GIS stores Transaction_ID on the parcel in a field of ${room} characters; this one has ${input.Transaction_ID.length}. Contact the GIS integration administrator.`,
    },
  ];
}

/** One open transaction per parcel: another accepted transaction holds it until GIS posts or removes its version. */
async function parcelsHeldElsewhere(token: string, schema: LayerSchema, input: LaisSubmission, objectIds: number[], fieldOf: FieldNamer): Promise<FieldError[]> {
  const mine = input.Transaction_ID.toLowerCase();
  const wanted = new Set(objectIds);
  const others = (await allEntries()).filter((e) => e.Transaction_ID.toLowerCase() !== mine && e.versionName && !e.completion && e.objectIds.some((id) => wanted.has(id)));
  if (!others.length) return [];

  const versions = await ownedVersions(token);
  const errors: FieldError[] = [];
  for (const other of others) {
    if (!versions.has(shortVersionName(other.versionName!).toLowerCase())) continue;
    const posted = await findPosted(token, schema, other.Transaction_ID);
    if (await detectCompletion(token, schema, other, posted.rows)) continue;
    objectIds.forEach((id, i) => {
      if (!other.objectIds.includes(id) || errors.some((e) => e.field === fieldOf(i))) return;
      errors.push({
        field: fieldOf(i),
        code: "UPI_IN_TRANSACTION",
        message: `UPI ${input.UPIs[i]} is already in transaction ${other.Transaction_ID} (${other.Transaction_Type}, GIS version ${other.versionName}), which GIS has not finished. Submit a new transaction for this parcel once that one is Posted or Closed.`,
        transactionId: other.Transaction_ID,
      });
    });
  }
  return errors;
}

/** An already accepted transaction is answered from the ledger: after a posted Merge its UPIs have expired. */
async function answerRecorded(token: string, schema: LayerSchema, entry: LedgerEntry): Promise<SubmitOutcome> {
  const posted = await findPosted(token, schema, entry.Transaction_ID);
  if (posted.inconsistent) return conflict(INCONSISTENT);
  const version = await findVersion(token, shortVersionName(entry.versionName!));
  return { kind: "duplicate", record: await describeEntry(token, schema, entry, version, posted.rows) };
}

function transactionFields(schema: LayerSchema, input: LaisSubmission, version: VersionRef): Attributes {
  const f = schema.fields;
  return {
    [f.transactionId]: input.Transaction_ID,
    [f.transactionType]: input.Transaction_Type,
    [f.transactionDate]: Date.parse(input.Transaction_Date),
    [f.case]: "Yes",
    [f.validationMessage]: VALIDATED,
    [f.versionStatus]: "VersionCreated",
    [f.versionName]: version.name,
    ...(input.Transaction_Status ? { [f.transactionStatus]: input.Transaction_Status } : {}),
  };
}

function versionDescription(input: LaisSubmission): string {
  const parcels = input.UPIs.length ? `UPI ${input.UPIs[0]}${input.UPIs.length > 1 ? ` +${input.UPIs.length - 1}` : ""}` : "new plot";
  return `LAIS ${input.Transaction_Type} ${parcels} ${input.Transaction_ID}`;
}

/**
 * Create the version and write the transaction on its Plots inside it. The intent is saved first, so
 * a failure part-way is completed by a retry instead of creating a second version.
 */
async function recordSubmission(
  token: string,
  schema: LayerSchema,
  input: LaisSubmission,
  entry: LedgerEntry | undefined,
  objectIds: number[],
  postedRows: Attributes[],
  fieldOf: FieldNamer,
): Promise<SubmitOutcome> {
  const shortName = entry?.versionName ? shortVersionName(entry.versionName) : versionNameFor(input);
  let version = await findVersion(token, shortName);
  if (entry?.versionName && !version) return { kind: "duplicate", record: await describeEntry(token, schema, entry, null, postedRows) };
  if (!entry && version) return conflict(`GIS version ${shortName} already exists for another submission. Contact the GIS integration administrator.`);

  const held = await parcelsHeldElsewhere(token, schema, input, objectIds, fieldOf);
  if (held.length) return { kind: "busy", errors: held };

  let current = entry ?? (await putEntry({ ...input, objectIds, versionName: null, attributesWritten: false }));
  version ??= await createVersion(token, shortName, versionDescription(input));
  current = await putEntry({ ...current, versionName: version.name });

  if (writesAttributes() && !current.attributesWritten && objectIds.length) {
    const fields = transactionFields(schema, input, version);
    await editInVersion(token, version, objectIds.map((objectId) => ({ [schema.objectIdField]: objectId, ...fields })));
    current = await putEntry({ ...current, attributesWritten: true });
  }
  logger.info({ transactionId: input.Transaction_ID, version: version.name, objectIds, mode: config.LAIS_WRITE_MODE }, "LAIS transaction accepted");
  const plotFields = current.attributesWritten ? "written" : objectIds.length ? "version-only" : "no-parcel";
  return { kind: "created", record: entryRecord(current, "InReview"), plotFields };
}

export async function submitTransaction(token: string, input: LaisSubmission, listForm = false): Promise<SubmitOutcome> {
  const fieldOf: FieldNamer = (i) => (listForm ? `UPIs[${i}]` : "UPI");

  return withLock(input.Transaction_ID.toLowerCase(), async () => {
    const schema = await layerSchema(token);
    const badCodes = domainErrors(schema, input);
    if (badCodes.length) return invalid(badCodes);

    const known = await getEntry(input.Transaction_ID);
    if (known && !entryMatches(known, input)) return conflict(USED_ELSEWHERE);
    if (known?.versionName && (known.attributesWritten || !writesAttributes())) return answerRecorded(token, schema, known);

    const parcels = await resolveParcels(token, schema, input.UPIs, fieldOf);
    if (parcels.errors.length) return invalid(parcels.errors);

    if (input.Transaction_Type === "Merge") {
      const problem = await mergeNeighbourProblem(token, schema, parcels.objectIds.map((objectId, i) => ({ objectId, upi: input.UPIs[i]! })));
      if (problem) return invalid([{ field: "UPIs", code: "NOT_NEIGHBOURS", message: problem }]);
    }

    const posted = await findPosted(token, schema, input.Transaction_ID);
    if (posted.inconsistent) return conflict(INCONSISTENT);
    if (posted.rows.length) {
      return samePayload(schema, posted.rows, input) ? { kind: "duplicate", record: toRecord(schema, posted.rows, "Posted") } : conflict(USED_ELSEWHERE);
    }

    const tooLong = transactionIdTooLong(schema, input, known);
    if (tooLong.length) return invalid(tooLong);

    return withLock(NEW_SUBMISSIONS, () => recordSubmission(token, schema, input, known, parcels.objectIds, posted.rows, fieldOf));
  });
}
