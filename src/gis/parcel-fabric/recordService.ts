import type FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import type Graphic from "@arcgis/core/Graphic.js";
import { layerRegistry, type ServiceLayerInfo } from "../layers/layerRegistry";
import { useEditing, type ActiveRecord } from "../../stores/editingStore";
import { useApp } from "../../stores/appStore";
import { describeArcGISError } from "../../services/arcgis/serviceMetadata";
import { audit } from "../../services/audit/audit";
import { asShownOnMap, hasField, sqlString } from "../layers/query";

/** Fabric layers whose new features should carry the active record in `createdbyrecord`. */
const RECORD_STAMPED_ROLES = new Set(["parcel-polygon", "parcel-line", "points", "connection-lines"]);
const CREATED_BY_RECORD = "createdbyrecord";

export interface RecordRow {
  objectId: number;
  globalId: string;
  name: string;
  recordType: string | null;
  recordedDate: number | null;
  parcelCount: number | null;
}

function recordsInfo(): ServiceLayerInfo | undefined {
  return layerRegistry.byRole("records");
}

export function recordsLayer(): FeatureLayer | null {
  return recordsInfo()?.layer ?? null;
}

function toRow(layer: FeatureLayer, g: Graphic): RecordRow {
  const a = g.attributes;
  const typeDomain = layer.getFieldDomain("recordtype");
  const rt = a.recordtype ?? null;
  return {
    objectId: a[layer.objectIdField],
    globalId: a[layer.globalIdField ?? "globalid"],
    name: a[layer.displayField ?? "name"] ?? `Record ${a[layer.objectIdField]}`,
    recordType: rt === null ? null : typeDomain?.type === "coded-value" ? (typeDomain.getName(rt) ?? String(rt)) : String(rt),
    recordedDate: a.recordeddate ?? null,
    parcelCount: a.parcelcount ?? null,
  };
}

/**
 * Parcel records (the fabric's Records layer). Records are created and
 * searched through the FeatureServer, inside the active version's edit
 * session. Assigning existing parcels to records ("assignFeaturesToRecord")
 * is a ParcelFabricServer operation and is not done here.
 */
export const recordService = {
  async search(text: string, limit = 25): Promise<RecordRow[]> {
    const layer = recordsLayer();
    if (!layer) return [];
    await layer.load();
    const nameField = layer.displayField ?? "name";
    const t = text.trim();
    const res = await layer.queryFeatures(asShownOnMap(layer, {
      where: t ? `UPPER(${nameField}) LIKE UPPER(${sqlString(`%${t}%`)})` : "1=1",
      outFields: [layer.objectIdField, layer.globalIdField ?? "globalid", nameField, "recordtype", "recordeddate", "parcelcount"],
      orderByFields: [`${layer.objectIdField} DESC`],
      num: limit,
      returnGeometry: false,
    }));
    return res.features.map((g) => toRow(layer, g));
  },

  /** Create a record feature (no geometry – the fabric computes it when parcels are built). */
  async create(input: { name: string; recordType: number | null; recordedDate: Date | null }): Promise<RecordRow> {
    const layer = recordsLayer();
    if (!layer) throw new Error("This service has no parcel Records layer.");
    if (useEditing.getState().session !== "editing") throw new Error("Start editing before creating a record.");
    const name = input.name.trim();
    if (!name) throw new Error("A record name is required.");
    // Record names identify legal documents – refuse duplicates in this version.
    const dup = await layer.queryObjectIds(asShownOnMap(layer, { where: `${layer.displayField ?? "name"} = ${sqlString(name)}` }));
    if (dup.length) throw new Error(`A record named "${name}" already exists in this version.`);
    const attributes: Record<string, unknown> = { [layer.displayField ?? "name"]: name };
    if (hasField(layer, "recordtype")) attributes.recordtype = input.recordType;
    if (hasField(layer, "recordeddate") && input.recordedDate) attributes.recordeddate = input.recordedDate.getTime();
    const result = await layer.applyEdits({ addFeatures: [{ attributes } as never] });
    const r = result.addFeatureResults[0];
    if (!r || r.error) {
      audit("record.create", "failure", name, { error: r?.error?.message });
      throw new Error(r?.error?.message ?? "The server did not create the record.");
    }
    const fs = await layer.queryFeatures(asShownOnMap(layer, { objectIds: [r.objectId as number], outFields: ["*"], returnGeometry: false }));
    const row = toRow(layer, fs.features[0]!);
    audit("record.create", "success", name, { objectId: row.objectId, globalId: row.globalId });
    return row;
  },

  /** Set (or clear) the active record; new fabric features get it in `createdbyrecord`. */
  setActive(record: ActiveRecord | null) {
    useEditing.getState().patch({ activeRecord: record });
    for (const info of layerRegistry.all()) {
      if (!info.fabricRole || !RECORD_STAMPED_ROLES.has(info.fabricRole)) continue;
      applyToTemplates(info.layer, record?.globalId ?? null);
    }
    useApp.getState().log("info", "records", record ? `Active record: ${record.name}` : "Active record cleared");
  },
};

/**
 * Write the active record into each feature template prototype of a layer. The SDK's own template and
 * type objects are updated: rebuilding them from toJSON() left plain-object domains, so the next record
 * change threw part-way and the parcel layers went on stamping the previous record.
 */
function applyToTemplates(layer: FeatureLayer, guid: string | null) {
  const stamp = <T extends { prototype?: unknown }>(template: T): T => {
    const prototype = (template.prototype ?? {}) as { attributes?: Record<string, unknown> };
    template.prototype = { ...prototype, attributes: { ...prototype.attributes, [CREATED_BY_RECORD]: guid } };
    return template;
  };
  if (layer.templates?.length) layer.templates = layer.templates.map(stamp);
  if (layer.types?.length) {
    for (const type of layer.types) if (type.templates?.length) type.templates = type.templates.map(stamp);
    layer.types = [...layer.types];
  }
}

/**
 * Safety net: if a new fabric feature reached the server without
 * `createdbyrecord` (e.g. created from a shared template), assign the active
 * record with a follow-up update in the same edit session.
 */
window.addEventListener("ps:features-edited", async (ev) => {
  const { layerKey, edits } = (ev as CustomEvent).detail as {
    layerKey: string;
    edits: { addedFeatures: { objectId?: number | null; error?: unknown }[] };
  };
  const active = useEditing.getState().activeRecord;
  const info = layerRegistry.get(layerKey);
  if (!active || !info?.fabricRole || !RECORD_STAMPED_ROLES.has(info.fabricRole)) return;
  if (!hasField(info.layer, CREATED_BY_RECORD)) return;
  const added = edits.addedFeatures.filter((r) => !r.error && typeof r.objectId === "number").map((r) => r.objectId as number);
  if (!added.length) return;
  try {
    const missing = (await info.layer.queryObjectIds(
      asShownOnMap(info.layer, {
        objectIds: added,
        where: `${CREATED_BY_RECORD} IS NULL`,
      }),
    )) as number[];
    if (!missing.length) return;
    const res = await info.layer.applyEdits({
      updateFeatures: missing.map((oid) => ({ attributes: { [info.layer.objectIdField]: oid, [CREATED_BY_RECORD]: active.globalId } })) as never,
    });
    const failed = res.updateFeatureResults.filter((r) => r.error).length;
    useApp.getState().log(failed ? "warning" : "info", "records", `Assigned record "${active.name}" to ${missing.length - failed} new ${info.name} feature(s)`);
  } catch (e) {
    useApp.getState().log("error", "records", "Could not assign the active record to new features", describeArcGISError(e));
  }
});
