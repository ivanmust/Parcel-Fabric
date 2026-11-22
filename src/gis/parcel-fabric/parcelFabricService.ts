import esriRequest from "@arcgis/core/request.js";
import { executeForCount, executeQueryJSON } from "@arcgis/core/rest/query.js";
import type Extent from "@arcgis/core/geometry/Extent.js";
import type Geometry from "@arcgis/core/geometry/Geometry.js";
import type SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import { layerRegistry, type ServiceLayerInfo } from "../layers/layerRegistry";
import { sessionQuery, sessionRows, sqlList, sqlString } from "../layers/query";
import { versionSession, type ServiceEditsJson } from "../version-management/versionSession";
import { useEditing, isDefaultVersion } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { arcgisError } from "../../services/arcgis/serviceMetadata";
import { UPI_PATTERN } from "./upi";

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

/** Common checks and the POST itself. */
async function callServer(url: string, params: Record<string, string>): Promise<ServerOpResult> {
  const ed = useEditing.getState();
  if (ed.session !== "editing" || !ed.current) throw new Error("Start editing first.");
  if (isDefaultVersion(ed)) throw new Error("Run Parcel Fabric operations in a named version, not in the default version.");
  const sessionId = versionSession.editSessionId();
  if (!sessionId) throw new Error("The edit session id is not known. Stop and start editing, then try again.");
  // After an undo the server still holds the undone edits ("forward edits"); the SDK removes them
  // before its next edit or on save. A server operation would build on them, and a later save could
  // remove the operation's results, so require a clean state first.
  if (versionSession.vms?.canRedo(ed.current)) throw new Error("You undid edits in this session. Save or discard first, then run the Parcel Fabric operation.");
  let data: ServerOpResult;
  try {
    const res = await esriRequest(url, {
      method: "post",
      responseType: "json",
      query: { f: "json", gdbVersion: ed.current.name, sessionId, async: "false", ...params },
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

export const parcelFabricService = {
  isParcelLayer(layerKey: string | undefined): boolean {
    return !!layerKey && layerRegistry.get(layerKey)?.fabricRole === "parcel-polygon";
  },

  readParcels,

  /**
   * Merge parcels into one new parcel. The parents are retired by the active record and kept as
   * historic parcels; the new parcel is created by the record.
   */
  async merge(objectIds: number[], newName: string, extraAttributes: Record<string, string | number> = {}): Promise<{ moment?: number; created: number[] }> {
    if (objectIds.length < 2) throw new Error("Select at least two parcels to merge.");
    const name = newName.trim();
    if (!name) throw new Error("Enter the UPI (name) of the new parcel.");
    const info = parcelLayer();
    const record = requireRecord();
    const parents = await readParcels(objectIds);
    if (parents.length !== objectIds.length) throw new Error("Some selected parcels are historic or no longer exist. Reselect current parcels.");
    const result = await callServer(`${serviceUrls().fabric}/merge`, {
      parentParcels: JSON.stringify(parents.map((p) => ({ id: p.globalId, layerId: String(info.serviceLayerId) }))),
      record: record.globalId,
      targetParcelType: String(info.serviceLayerId),
      defaultAreaUnit: String(SQUARE_METRE),
      attributeOverrides: JSON.stringify({ type: "PropertySet", propertySetItems: ["name", name, ...Object.entries(extraAttributes).flat(), "isseed", 0] }),
    });
    versionSession.recordServerOperation("Merge parcels", result, { record: record.name, parents: parents.map((p) => p.name), newName: name });
    return { moment: result.moment, created: addedObjectIds(result, info) };
  },

  /** Divide a parcel by area or width. The parent is retired by the active record. */
  async divide(objectId: number, opts: { option: DivideOption; parts: number; areaOrWidth: number; bearing: number; leftSide: boolean; distributeRemainder: boolean }) {
    const info = parcelLayer();
    const record = requireRecord();
    if (!Number.isInteger(opts.parts) || opts.parts < 2 || opts.parts > 100) throw new Error("Number of parts must be a whole number from 2 to 100.");
    if (!Number.isFinite(opts.bearing) || opts.bearing < 0 || opts.bearing >= 360) throw new Error("Bearing must be between 0 and 360 degrees.");
    if (opts.option !== "ProportionalArea" && !(opts.areaOrWidth > 0)) throw new Error("Enter the area (m²) or width (m) of each part.");
    const [parcel] = await readParcels([objectId]);
    if (!parcel) throw new Error("The selected parcel is historic or no longer exists.");
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
    return { moment: result.moment, created: addedObjectIds(result, info) };
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
   * Evaluate the topology rules inside an area of the version being edited. The server marks the
   * area validated and writes any errors to the topology error layers.
   */
  async validate(area: Extent): Promise<{ moment?: number }> {
    const result = await callServer(`${serviceUrls().validation}/evaluate`, {
      evaluationArea: JSON.stringify({ xmin: area.xmin, ymin: area.ymin, xmax: area.xmax, ymax: area.ymax, spatialReference: area.spatialReference.toJSON() }),
      evaluationType: JSON.stringify(["topologyRules"]),
      returnEdits: "false",
    });
    versionSession.recordServerOperation("Validate topology", result);
    return { moment: result.moment };
  },

  /** Count dirty areas and topology errors (point, line, polygon) inside an area, at the session moment. */
  async validationStatus(area: Extent): Promise<{ dirtyAreas: number; errors: { layerKey: string; name: string; count: number }[] }> {
    const layers = layerRegistry.allByRole("topology-error");
    const counts = await Promise.all(
      layers.map(async (i) => {
        return { layerKey: i.key, name: i.name, count: await executeForCount(i.url, sessionQuery(i, { geometry: area })) };
      }),
    );
    const dirty = counts.find((c) => /dirty/i.test(c.name));
    return { dirtyAreas: dirty?.count ?? 0, errors: counts.filter((c) => c !== dirty) };
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
