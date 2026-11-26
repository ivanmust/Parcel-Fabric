import esriRequest from "@arcgis/core/request.js";
import { executeForCount, executeQueryJSON } from "@arcgis/core/rest/query.js";
import type Extent from "@arcgis/core/geometry/Extent.js";
import type Geometry from "@arcgis/core/geometry/Geometry.js";
import Graphic from "@arcgis/core/Graphic.js";
import type Polygon from "@arcgis/core/geometry/Polygon.js";
import * as areaOperator from "@arcgis/core/geometry/operators/areaOperator.js";
import type SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import { layerRegistry, type ServiceLayerInfo } from "../layers/layerRegistry";
import { hasField, sessionQuery, sessionRows, sqlList, sqlString } from "../layers/query";
import { ensureProjection, project } from "../geometry/coordinates";
import { versionSession, type ServiceEditsJson } from "../version-management/versionSession";
import { useEditing, isDefaultVersion } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { arcgisError, fetchServiceJson } from "../../services/arcgis/serviceMetadata";
import { LOCATION_FIELDS, UPI_PATTERN } from "./upi";
import { mergeAdjacencyProblem } from "./adjacency";

/**
 * Parcel Fabric operations through the ParcelFabricServer and ValidationServer REST extensions.
 * Unlike plain polygon edits, merge and divide keep the fabric's lineage: parent parcels are retired
 * (RetiredByRecord) and kept as historic parcels, and new parcels are created by the active record.
 *
 * Parameter names and formats follow this server's REST Services Directory and the Esri REST API
 * reference (merge-parcel-fabric-server, divide-parcel-fabric-server, evaluate). Every call runs in
 * the open edit session of a named version and needs the ArcGIS Advanced Editing licence.
 */

/** PF_AreaUnits coded value for square metres. */
const SQUARE_METRE = 109404;

interface ServerOpResult {
  success?: boolean;
  moment?: number;
  /** evaluate: the area it validated. Absent when it validated nothing, even with success: true. */
  validatedArea?: object;
  serviceEdits?: ServiceEditsJson[];
  error?: { message?: string; details?: string[] };
}

export interface ParcelRef {
  objectId: number;
  globalId: string;
  name: string | null;
}

export type DivideOption = "ProportionalArea" | "EqualArea" | "EqualWidth";

const parcelLayer = () => layerRegistry.requireRole("parcel-polygon");

function requireRecord() {
  const record = useEditing.getState().activeRecord;
  if (!record) throw new Error("Choose the active parcel record first (Editing Tools → Active parcel record).");
  return record;
}

/** What every operation needs: an edit session of a named version, with nothing undone. */
function requireFabricSession() {
  const ed = useEditing.getState();
  if (ed.session !== "editing" || !ed.current) throw new Error("Start editing first.");
  if (isDefaultVersion(ed)) throw new Error("Run Parcel Fabric operations in a named version, not in the default version.");
  const sessionId = versionSession.editSessionId();
  if (!sessionId) throw new Error("The edit session id is not known. Stop and start editing, then try again.");
  // After an undo the server still holds the undone edits ("forward edits"); the SDK removes them
  // before its next edit or on save. A server operation would build on them, and a later save could
  // remove the operation's results, so require a clean state first.
  if (versionSession.vms?.canRedo(ed.current)) throw new Error("You undid edits in this session. Save or discard first, then run the Parcel Fabric operation.");
  return { gdbVersion: ed.current.name, sessionId };
}

/** Common checks and the POST itself. */
async function callServer(url: string, params: Record<string, string>): Promise<ServerOpResult> {
  const { gdbVersion, sessionId } = requireFabricSession();
  let data: ServerOpResult;
  try {
    const res = await esriRequest(url, {
      method: "post",
      responseType: "json",
      query: { f: "json", gdbVersion, sessionId, async: "false", ...params },
    });
    data = res.data as ServerOpResult;
  } catch (e) {
    throw arcgisError(e);
  }
  if (!data?.success) {
    const details = (data?.error?.details ?? []).filter(Boolean).join(" ");
    throw new Error([data?.error?.message ?? "The server did not complete the operation.", details].filter(Boolean).join(": "));
  }
  return data;
}

/** Object ids the operation added to a layer (from `serviceEdits`). */
function addedObjectIds(result: ServerOpResult, info: ServiceLayerInfo): number[] {
  const edits = (result.serviceEdits ?? []).find((e) => e.id === info.serviceLayerId);
  return ((edits?.editedFeatures?.adds ?? []) as { attributes?: Record<string, unknown> }[])
    .map((a) => a.attributes?.[info.layer.objectIdField] ?? a.attributes?.objectid)
    .filter((v): v is number => typeof v === "number");
}

function serviceUrls() {
  const cfg = useApp.getState().config;
  if (!cfg) throw new Error("Configuration not loaded.");
  return { fabric: cfg.services.parcelFabricServer, validation: cfg.services.validationServer };
}

/** Current (non-historic) parcels by object id, read at the session moment. */
async function readParcels(objectIds: number[]): Promise<ParcelRef[]> {
  const info = parcelLayer();
  const res = await sessionRows(info, { objectIds, outFields: ["objectid", "globalid", "name", "retiredbyrecord"] });
  return res
    .filter((a) => !a.retiredbyrecord)
    .map((a) => ({ objectId: a[info.layer.objectIdField] as number, globalId: a[info.layer.globalIdField ?? "globalid"] as string, name: (a.name as string) ?? null }));
}

/**
 * The operation that retires parcels is kept on its record (Records `recordtype`: 1 Merge, 2 Split,
 * 3 Subdivision), so the history says why each historic parcel's UPI expired. An untyped record gets
 * the operation's type once the operation succeeds; a record typed for another operation is refused,
 * so one record never retires parcels for two different reasons.
 */
type HistoryOperation = "Merge" | "Subdivision";
const RECORD_TYPE: Record<HistoryOperation, number> = { Merge: 1, Subdivision: 3 };
const ACCEPTED_RECORD_TYPES: Record<HistoryOperation, number[]> = { Merge: [1], Subdivision: [3, 2] };

interface RecordTypeCheck {
  objectId: number;
  type: number | null;
}

/** Read the active record's type and refuse it when it belongs to another operation. */
async function checkRecordType(operation: HistoryOperation): Promise<RecordTypeCheck | null> {
  const record = requireRecord();
  const rec = layerRegistry.byRole("records");
  if (!rec || !hasField(rec.layer, "recordtype")) return null;
  const oid = rec.layer.objectIdField;
  const gid = rec.layer.globalIdField || "globalid";
  const [row] = await sessionRows(rec, { where: `${gid} = ${sqlString(record.globalId)}`, outFields: [oid, "recordtype"] });
  if (!row) throw new Error(`The active record "${record.name}" was not found in this version. Choose the active record again.`);
  const type = row.recordtype == null ? null : Number(row.recordtype);
  if (type !== null && !ACCEPTED_RECORD_TYPES[operation].includes(type)) {
    const domain = rec.layer.getFieldDomain("recordtype");
    const typeName = (domain?.type === "coded-value" ? domain.getName(type) : null) ?? `type ${type}`;
    throw new Error(
      `The active record "${record.name}" is a ${typeName} record. Create and activate a new record for this ${operation.toLowerCase()}, so the parcel history shows which operation retired each parcel.`,
    );
  }
  return { objectId: row[oid] as number, type };
}

/** After the operation succeeded: give an untyped record the operation's type. */
async function stampRecordType(check: RecordTypeCheck | null, operation: HistoryOperation): Promise<void> {
  if (!check || check.type !== null) return;
  const rec = layerRegistry.byRole("records")!;
  const res = await rec.layer.applyEdits({ updateFeatures: [{ attributes: { [rec.layer.objectIdField]: check.objectId, recordtype: RECORD_TYPE[operation] } }] as never });
  const failed = res.updateFeatureResults[0]?.error;
  if (failed) throw new Error(`The record type could not be set: ${failed.message}`);
}

/**
 * New parcels from a subdivision start without a UPI: whatever they copied from the parent (its UPI
 * and parcel number) is cleared, so the parent's UPI lives on only in the historic parent.
 */
async function clearInheritedUpi(objectIds: number[]): Promise<void> {
  const info = parcelLayer();
  const fields = ["name", "parcel_number"].filter((f) => hasField(info.layer, f));
  if (!objectIds.length || !fields.length) return;
  const oid = info.layer.objectIdField;
  const res = await info.layer.applyEdits({
    updateFeatures: objectIds.map((id) => ({ attributes: { [oid]: id, ...Object.fromEntries(fields.map((f) => [f, null])) } })) as never,
  });
  const failed = res.updateFeatureResults.find((r) => r.error);
  if (failed?.error) throw new Error(`The old UPI could not be cleared from the new parcels: ${failed.error.message}`);
}

/**
 * The location (province … village) the new parcels should carry: each field on which all the parents
 * agree. Read before the operation, while the parents are current. Divide and merge do not copy these
 * fields, and the new parcels need them (LAIS's "editing done" notification, the e-title) before any
 * UPI is assigned.
 */
async function parentLocation(parentIds: number[]): Promise<Record<string, unknown>> {
  const info = parcelLayer();
  const fields = LOCATION_FIELDS.filter((f) => hasField(info.layer, f));
  if (!fields.length || !parentIds.length) return {};
  const rows = await sessionRows(info, { objectIds: parentIds, outFields: fields });
  const agreed: Record<string, unknown> = {};
  for (const f of fields) {
    const values = new Set(rows.map((r) => r[f]).filter((v) => v !== null && v !== undefined && v !== ""));
    if (values.size === 1) agreed[f] = [...values][0];
  }
  return agreed;
}

/** Give the new parcels their parents' location (see parentLocation). */
async function inheritLocation(objectIds: number[], location: Record<string, unknown>): Promise<void> {
  if (!objectIds.length || !Object.keys(location).length) return;
  const info = parcelLayer();
  const oid = info.layer.objectIdField;
  const res = await info.layer.applyEdits({ updateFeatures: objectIds.map((id) => ({ attributes: { [oid]: id, ...location } })) as never });
  const failed = res.updateFeatureResults.find((r) => r.error);
  if (failed?.error) throw new Error(`The location could not be copied to the new parcels: ${failed.error.message}`);
}

/** Current parcels' shapes (data coordinate system, metres) with their UPIs, for the neighbour check. */
async function mergeCandidates(objectIds: number[]) {
  const info = parcelLayer();
  const oid = info.layer.objectIdField;
  const q = sessionQuery(info, { where: "retiredbyrecord IS NULL", objectIds, returnGeometry: true, outFields: [oid, "name"], outSpatialReference: info.layer.spatialReference });
  const features = (await executeQueryJSON(info.url, q)).features;
  if (features.length !== new Set(objectIds).size) throw new Error("Some selected parcels are historic or no longer exist. Reselect current parcels.");
  return features.map((f) => ({
    objectId: f.attributes[oid] as number,
    label: (f.attributes.name as string | null) || `OBJECTID ${String(f.attributes[oid])}`,
    geometry: f.geometry as Polygon,
  }));
}

/** Slightly inside an area, so a feature that only touches its edge isn't counted as in it. */
const inside = (area: Extent) => area.clone().expand(0.999);

const isDirtyAreas = (i: ServiceLayerInfo) => /dirty/i.test(i.name);
/** Retired dirty areas are validated already; errors marked as exceptions are accepted. */
function openProblems(i: ServiceLayerInfo): string {
  if (isDirtyAreas(i) && hasField(i.layer, "isretired")) return "(isretired = 0 OR isretired IS NULL)";
  if (hasField(i.layer, "isexception")) return "(isexception = 0 OR isexception IS NULL)";
  return "1=1";
}

let ruleNames: Promise<Map<number, string>> | null = null;
/** Topology rule names by id, from the service's data elements. */
function topologyRuleNames(): Promise<Map<number, string>> {
  ruleNames ??= (async () => {
    const topologyId = layerRegistry.featureServiceJson?.controllerDatasetLayers?.topologyLayerIds?.[0];
    const url = useApp.getState().config?.services.featureServer;
    if (topologyId === undefined || !url) return new Map<number, string>();
    const json = await fetchServiceJson(`${url}/queryDataElements`, { query: { layers: JSON.stringify([topologyId]) } });
    const rules: { ruleId: number; name?: string; topologyRuleType?: string }[] = json.layerDataElements?.[0]?.dataElement?.topologyRules ?? [];
    // An unnamed rule shows its type in words, e.g. "Line endpoint covered by point".
    const words = (type = "") => {
      const text = type.replace(/^esriTRT/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
      return text.charAt(0).toUpperCase() + text.slice(1);
    };
    return new Map(rules.map((r) => [r.ruleId, r.name || words(r.topologyRuleType)]));
  })().catch((e) => {
    ruleNames = null;
    useApp.getState().log("warning", "validation", "Topology rule names could not be read", arcgisError(e).message);
    return new Map<number, string>();
  });
  return ruleNames;
}

export interface TopologyProblem {
  layerKey: string;
  objectId: number;
  label: string;
  detail: string;
}
const MAX_PROBLEMS_LISTED = 100;

export const parcelFabricService = {
  isParcelLayer(layerKey: string | undefined): boolean {
    return !!layerKey && layerRegistry.get(layerKey)?.fabricRole === "parcel-polygon";
  },

  readParcels,

  /**
   * Why these parcels can't be merged as neighbours (they must form one connected group sharing
   * boundaries), or null. Reads the shapes at the session moment; needs no edit session.
   */
  async checkMergeNeighbours(objectIds: number[]): Promise<string | null> {
    if (objectIds.length < 2) return null;
    return mergeAdjacencyProblem(await mergeCandidates(objectIds));
  },

  /**
   * Merge parcels into one new parcel. The parents are retired by the active record and kept as
   * historic parcels with their UPIs; the new parcel is created by the record. The parents must be
   * neighbours (one connected group), and the record must be a Merge record or untyped.
   */
  async merge(objectIds: number[], newName: string, extraAttributes: Record<string, string | number> = {}): Promise<{ moment?: number; created: number[] }> {
    if (objectIds.length < 2) throw new Error("Select at least two parcels to merge.");
    const name = newName.trim();
    if (!name) throw new Error("Enter the UPI (name) of the new parcel.");
    const info = parcelLayer();
    const record = requireRecord();
    const parents = await readParcels(objectIds);
    if (parents.length !== objectIds.length) throw new Error("Some selected parcels are historic or no longer exist. Reselect current parcels.");
    const notNeighbours = await this.checkMergeNeighbours(objectIds);
    if (notNeighbours) throw new Error(notNeighbours);
    const recordType = await checkRecordType("Merge");
    const location = await parentLocation(objectIds);
    const result = await callServer(`${serviceUrls().fabric}/merge`, {
      parentParcels: JSON.stringify(parents.map((p) => ({ id: p.globalId, layerId: String(info.serviceLayerId) }))),
      record: record.globalId,
      targetParcelType: String(info.serviceLayerId),
      defaultAreaUnit: String(SQUARE_METRE),
      attributeOverrides: JSON.stringify({ type: "PropertySet", propertySetItems: ["name", name, ...Object.entries(extraAttributes).flat(), "isseed", 0] }),
    });
    versionSession.recordServerOperation("Merge parcels", result, { record: record.name, parents: parents.map((p) => p.name), newName: name });
    try {
      await inheritLocation(addedObjectIds(result, info), location);
      await stampRecordType(recordType, "Merge");
    } catch (e) {
      throw new Error(`The parcels were merged, but the history is incomplete: ${(e as Error).message} Use Discard to roll it back.`, { cause: e });
    }
    return { moment: result.moment, created: addedObjectIds(result, info) };
  },

  /**
   * Divide a parcel by area or width. The parent is retired by the active record and kept as a
   * historic parcel with its UPI; the new parcels start without a UPI (see clearInheritedUpi).
   */
  async divide(objectId: number, opts: { option: DivideOption; parts: number; areaOrWidth: number; bearing: number; leftSide: boolean; distributeRemainder: boolean }) {
    const info = parcelLayer();
    const record = requireRecord();
    if (!Number.isInteger(opts.parts) || opts.parts < 2 || opts.parts > 100) throw new Error("Number of parts must be a whole number from 2 to 100.");
    if (!Number.isFinite(opts.bearing) || opts.bearing < 0 || opts.bearing >= 360) throw new Error("Bearing must be between 0 and 360 degrees.");
    if (opts.option !== "ProportionalArea" && !(opts.areaOrWidth > 0)) throw new Error("Enter the area (m²) or width (m) of each part.");
    const [parcel] = await readParcels([objectId]);
    if (!parcel) throw new Error("The selected parcel is historic or no longer exists.");
    const recordType = await checkRecordType("Subdivision");
    const location = await parentLocation([objectId]);
    const result = await callServer(`${serviceUrls().fabric}/divide`, {
      divideParcelGuid: parcel.globalId,
      divideParcelType: String(info.serviceLayerId),
      record: record.globalId,
      divideOption: opts.option,
      divideNumberOfParts: String(opts.parts),
      dividePartAreaOrWidth: String(opts.option === "ProportionalArea" ? 0 : opts.areaOrWidth),
      divideLineBearing: String(opts.bearing),
      divideLeftSide: String(opts.leftSide),
      divideDistributeRemainder: String(opts.distributeRemainder),
      defaultAreaUnit: String(SQUARE_METRE),
      divideAssociatedLines: "true",
    });
    versionSession.recordServerOperation("Divide parcel", result, { record: record.name, parcel: parcel.name, ...opts });
    const created = addedObjectIds(result, info);
    try {
      await clearInheritedUpi(created);
      await inheritLocation(created, location);
      await stampRecordType(recordType, "Subdivision");
    } catch (e) {
      throw new Error(`The parcel was divided, but the history is incomplete: ${(e as Error).message} Use Discard to roll it back.`, { cause: e });
    }
    return { moment: result.moment, created };
  },

  /**
   * Retire parcels: set them historic with the active record (`updateParcelHistory`, setAsHistoric).
   * They stay in the data as history; this is the normal way to end a parcel.
   */
  async retire(objectIds: number[]): Promise<{ moment?: number }> {
    if (!objectIds.length) throw new Error("Select the parcels to retire.");
    const info = parcelLayer();
    const record = requireRecord();
    const parcels = await readParcels(objectIds);
    if (parcels.length !== objectIds.length) throw new Error("Some selected parcels are already historic or no longer exist. Reselect current parcels.");
    const result = await callServer(`${serviceUrls().fabric}/updateParcelHistory`, {
      parcelFeatures: JSON.stringify(parcels.map((p) => ({ id: p.globalId, layerId: String(info.serviceLayerId) }))),
      setAsHistoric: "true",
      record: record.globalId,
    });
    versionSession.recordServerOperation("Retire parcels", result, { record: record.name, parcels: parcels.map((p) => p.name) });
    return { moment: result.moment };
  },

  /**
   * Delete parcels permanently (`deleteParcels`). Meant for mistakes: no history is kept. Parcel lines
   * and points that no other parcel uses are deleted too, so nothing is left orphaned.
   */
  async deletePermanently(objectIds: number[]): Promise<{ moment?: number }> {
    if (!objectIds.length) throw new Error("Select the parcels to delete.");
    const info = parcelLayer();
    const parcels = await readParcels(objectIds);
    if (parcels.length !== objectIds.length) throw new Error("Some selected parcels are historic or no longer exist. Reselect current parcels.");
    const result = await callServer(`${serviceUrls().fabric}/deleteParcels`, {
      parcels: JSON.stringify(parcels.map((p) => ({ id: p.globalId, layerId: String(info.serviceLayerId) }))),
    });
    versionSession.recordServerOperation("Delete parcels", result, { parcels: parcels.map((p) => p.name) });
    return { moment: result.moment };
  },

  /**
   * Evaluate the topology rules inside an area of the version being edited.
   *
   * The area MUST be sent in the data's coordinate system. Given any other (e.g. the map's Web
   * Mercator), the server answers success: true and validates nothing (verified live 2026-11-22).
   */
  async validate(area: Extent): Promise<{ moment?: number }> {
    await ensureProjection();
    const projected = project(area, parcelLayer().layer.spatialReference)?.extent;
    if (!projected) throw new Error("The map view could not be converted to the data's coordinate system.");
    const dirtyLayer = layerRegistry.allByRole("topology-error").find(isDirtyAreas);
    const dirtyBefore = dirtyLayer ? await executeForCount(dirtyLayer.url, sessionQuery(dirtyLayer, { where: openProblems(dirtyLayer), geometry: inside(area) })) : 0;
    const result = await callServer(`${serviceUrls().validation}/evaluate`, {
      evaluationArea: JSON.stringify({ xmin: projected.xmin, ymin: projected.ymin, xmax: projected.xmax, ymax: projected.ymax, spatialReference: projected.spatialReference.toJSON() }),
      evaluationType: JSON.stringify(["topologyRules"]),
      returnEdits: "false",
    });
    versionSession.recordServerOperation("Validate topology", result);
    if (dirtyBefore && !result.validatedArea) throw new Error("The server reported success but validated nothing in this map view.");
    return { moment: result.moment };
  },

  /**
   * What validation left in an area, at the session moment: dirty areas, errors by type, a list of
   * them to zoom to, and how many errors lie elsewhere in the version. Reading needs no edit session.
   */
  async validationStatus(area: Extent) {
    const layers = layerRegistry.allByRole("topology-error");
    const within = inside(area);
    const [names, found] = await Promise.all([
      topologyRuleNames(),
      Promise.all(
        layers.map(async (info) => {
          const where = openProblems(info);
          const dirty = isDirtyAreas(info);
          const oid = info.layer.objectIdField;
          const count = await executeForCount(info.url, sessionQuery(info, { where, geometry: within }));
          const total = dirty ? count : await executeForCount(info.url, sessionQuery(info, { where }));
          const rows = count ? await sessionRows(info, { where, geometry: within, outFields: ["*"], num: MAX_PROBLEMS_LISTED }) : [];
          return { info, dirty, oid, count, total, rows };
        }),
      ),
    ]);
    const errors = found.filter((f) => !f.dirty);
    const problems: TopologyProblem[] = [...errors, ...found.filter((f) => f.dirty)]
      .flatMap(({ info, dirty, oid, rows }) =>
        rows.map((r) => ({
          layerKey: info.key,
          objectId: r[oid] as number,
          label: dirty ? "Not validated yet" : (names.get(r.toporuleid as number) ?? `Topology rule ${String(r.toporuleid)}`),
          detail: `${info.name} #${String(r[oid])}`,
        })),
      )
      .slice(0, MAX_PROBLEMS_LISTED);
    return {
      dirtyAreas: found.find((f) => f.dirty)?.count ?? 0,
      errors: errors.map(({ info, count }) => ({ layerKey: info.key, name: info.name, count })),
      elsewhere: errors.reduce((n, f) => n + f.total - f.count, 0),
      problems,
    };
  },

  /** Geometry of a topology error or dirty area, in the given spatial reference. */
  async problemGeometry(problem: TopologyProblem, outSpatialReference: SpatialReference) {
    const info = layerRegistry.get(problem.layerKey);
    if (!info) return null;
    const q = sessionQuery(info, { objectIds: [problem.objectId], returnGeometry: true, outFields: [], outSpatialReference });
    return (await executeQueryJSON(info.url, q)).features[0]?.geometry ?? null;
  },

  /** Throws unless a manual split can run now (named-version edit session, active record). */
  requireSplitReady() {
    requireFabricSession();
    requireRecord();
  },

  /** A current parcel's exact geometry, in the data's coordinate system. */
  async editableGeometry(objectId: number): Promise<Polygon> {
    const info = parcelLayer();
    const q = sessionQuery(info, { where: "retiredbyrecord IS NULL", objectIds: [objectId], returnGeometry: true, returnZ: true, outFields: [], outSpatialReference: info.layer.spatialReference });
    const geometry = (await executeQueryJSON(info.url, q)).features[0]?.geometry;
    if (!geometry) throw new Error("The selected parcel is historic or no longer exists.");
    return geometry as Polygon;
  },

  /**
   * Manual split, with lineage kept:
   *  1. add the drawn part as a new parcel of the active record;
   *  2. clip the parcel with it (DiscardArea): the server retires the parcel and creates the remainder;
   *  3. build the record inside the parcel's extent only, for the new boundary line and its points;
   *  4. clear what the remainder copied from the parcel and is no longer true (UPI, number, areas).
   * The clipping-geometry form of clip is refused by this server, hence step 1.
   */
  async splitOff(objectId: number, drawnOn: Polygon, part: Polygon): Promise<number[]> {
    const info = parcelLayer();
    const { layer } = info;
    const oid = layer.objectIdField;
    const record = requireRecord();
    requireFabricSession();
    const [[parent], [original], geometry] = await Promise.all([readParcels([objectId]), sessionRows(info, { objectIds: [objectId], outFields: ["*"] }), this.editableGeometry(objectId)]);
    if (!parent || !original) throw new Error("The selected parcel is historic or no longer exists.");
    if (JSON.stringify(geometry.rings) !== JSON.stringify(drawnOn.rings)) throw new Error("The parcel changed after the line was drawn. Draw it again.");
    const recordType = await checkRecordType("Subdivision");

    const attributes: Record<string, unknown> = { createdbyrecord: record.globalId };
    if (hasField(layer, "isseed")) attributes.isseed = 0;
    for (const f of LOCATION_FIELDS) if (hasField(layer, f)) attributes[f] = original[f] ?? null;
    const added = (await layer.applyEdits({ addFeatures: [new Graphic({ geometry: part, attributes })] })).addFeatureResults[0];
    if (!added || added.error || typeof added.objectId !== "number") throw new Error(added?.error?.message ?? "The server did not add the new part.");
    const partId = added.objectId;

    let clipped: ServerOpResult;
    try {
      const partGuid = added.globalId || ((await sessionRows(info, { objectIds: [partId], outFields: ["globalid"] }))[0]?.globalid as string | undefined);
      if (!partGuid) throw new Error("The new part has no GlobalID.");
      const layerId = String(info.serviceLayerId);
      clipped = await callServer(`${serviceUrls().fabric}/clip`, {
        parentParcels: JSON.stringify([{ id: parent.globalId, layerId }]),
        clippingParcels: JSON.stringify([{ id: partGuid, layerId }]),
        clipOption: "DiscardArea",
        record: record.globalId,
        defaultAreaUnit: String(SQUARE_METRE),
      });
    } catch (e) {
      // Nothing was clipped: take the added part out again.
      const undone = await layer.applyEdits({ deleteFeatures: [{ objectId: partId }] as never }).then((r) => !r.deleteFeatureResults[0]?.error, () => false);
      throw new Error(`${(e as Error).message}${undone ? "" : " The new part could not be removed again: use Discard."}`, { cause: e });
    }
    versionSession.recordServerOperation("Split parcel (manual)", clipped, { record: record.name, parcel: parent.name });

    try {
      const remainder = addedObjectIds(clipped, info).filter((id) => id !== partId);
      if (remainder.length !== 1) throw new Error("The server did not return exactly one remainder parcel.");

      const around = geometry.extent!.clone().expand(1.02);
      const built = await callServer(`${serviceUrls().fabric}/build`, {
        record: record.globalId,
        buildExtent: JSON.stringify({ xmin: around.xmin, ymin: around.ymin, xmax: around.xmax, ymax: around.ymax, spatialReference: around.spatialReference.toJSON() }),
      });
      versionSession.recordServerOperation("Build split parcels", built, { record: record.name });

      const ids = [partId, remainder[0]!];
      const shapes = await executeQueryJSON(info.url, sessionQuery(info, { objectIds: ids, returnGeometry: true, outFields: [oid], outSpatialReference: layer.spatialReference }));
      const updates = shapes.features.map((f) => {
        const values: Record<string, unknown> = { [oid]: f.attributes[oid] };
        if (f.attributes[oid] !== partId) {
          for (const field of ["name", "parcel_number", "statedarea", "statedareaunit"]) if (hasField(layer, field)) values[field] = null;
        }
        // In this data "size" is the parcel's area in m².
        if (hasField(layer, "size") && f.geometry) values.size = Math.abs(areaOperator.execute(f.geometry as Polygon));
        return { attributes: values };
      });
      const failed = (await layer.applyEdits({ updateFeatures: updates as never })).updateFeatureResults.find((r) => r.error);
      if (failed?.error) throw new Error(failed.error.message);
      await stampRecordType(recordType, "Subdivision");
      return ids;
    } catch (e) {
      throw new Error(`The parcel was cut, but the split didn't finish: ${(e as Error).message} Use Discard to roll it back.`, { cause: e });
    }
  },

  /**
   * Lineage of a parcel through its records: the record that created it and the parcels that record
   * retired (predecessors), and the record that retired it and the parcels that record created
   * (successors). Predecessors and successors are limited to parcels that overlap this one.
   */
  async lineage(objectId: number, geometry: Geometry | null) {
    const info = parcelLayer();
    const [self] = await sessionRows(info, { objectIds: [objectId], outFields: ["objectid", "name", "createdbyrecord", "retiredbyrecord"] });
    if (!self) throw new Error("Parcel not found.");
    const createdBy = (self.createdbyrecord as string | null) ?? null;
    const retiredBy = (self.retiredbyrecord as string | null) ?? null;
    const recordNames = await this.recordNames([createdBy, retiredBy].filter((g): g is string => !!g));
    // Parcels linked through a record, limited to those overlapping this one.
    const linked = async (where: string) =>
      (await sessionRows(info, { where, geometry: geometry ?? undefined, outFields: ["objectid", "name", "retiredbyrecord"] }))
        .filter((r) => r.objectid !== objectId)
        .map((r) => ({ objectId: r.objectid as number, name: (r.name as string) ?? null, historic: !!r.retiredbyrecord }));
    const predecessors = createdBy ? await linked(`retiredbyrecord = ${sqlString(createdBy)}`) : [];
    const successors = retiredBy ? await linked(`createdbyrecord = ${sqlString(retiredBy)}`) : [];
    return {
      historic: !!retiredBy,
      createdBy: createdBy ? { globalId: createdBy, name: recordNames.get(createdBy) ?? createdBy } : null,
      retiredBy: retiredBy ? { globalId: retiredBy, name: recordNames.get(retiredBy) ?? retiredBy } : null,
      predecessors,
      successors,
    };
  },

  /** Current parcels in an area whose UPI (name) is empty or not in the UPI format (max 50). */
  async parcelsWithoutUpi(area: Extent): Promise<number[]> {
    const info = parcelLayer();
    const rows = await sessionRows(info, { where: "retiredbyrecord IS NULL", geometry: area, outFields: [info.layer.objectIdField, "name"] });
    return rows
      .filter((r) => !UPI_PATTERN.test(String(r.name ?? "")))
      .map((r) => r[info.layer.objectIdField] as number)
      .slice(0, 50);
  },

  /** Geometry of any parcel, current or historic, in the given spatial reference (ignores the display filter). */
  async parcelGeometry(objectId: number, outSpatialReference: SpatialReference) {
    const info = parcelLayer();
    const q = sessionQuery(info, { objectIds: [objectId], returnGeometry: true, outFields: [], outSpatialReference });
    return (await executeQueryJSON(info.url, q)).features[0]?.geometry ?? null;
  },

  async recordNames(guids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const rec = layerRegistry.byRole("records");
    if (!rec || !guids.length) return out;
    const nameField = rec.layer.displayField || "name";
    const gidField = rec.layer.globalIdField || "globalid";
    const rows = await sessionRows(rec, { where: `${gidField} IN (${sqlList(guids)})`, outFields: [gidField, nameField] });
    for (const r of rows) out.set(String(r[gidField]).toUpperCase(), String(r[nameField] ?? ""));
    // keys as given (case may differ)
    for (const g of guids) if (!out.has(g) && out.has(g.toUpperCase())) out.set(g, out.get(g.toUpperCase())!);
    return out;
  },
};
