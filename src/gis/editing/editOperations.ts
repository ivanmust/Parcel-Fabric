import { layerRegistry } from "../layers/layerRegistry";
import { selectionService } from "../selection/selectionService";
import { useEditing } from "../../stores/editingStore";
import { describeArcGISError } from "../../services/arcgis/serviceMetadata";
import { isLayerEditable } from "./editorBridge";
import { parcelFabricService } from "../parcel-fabric/parcelFabricService";

const CHUNK = 250;

export interface DeletePlan {
  layers: { layerKey: string; name: string; count: number; editable: boolean; parcels: boolean }[];
  total: number;
  /** Parcel Fabric parcels are selected: they can be retired (history kept) or deleted permanently. */
  hasParcels: boolean;
}

/** What to do with selected Parcel Fabric parcels. Other layers are always deleted. */
export type ParcelDeleteMode = "retire" | "delete";

/** Describe what "Delete selected" would do, so the user can confirm it. */
export function planDeleteSelected(): DeletePlan {
  const layers = useEditing.getState().selection.map((s) => {
    const info = layerRegistry.get(s.layerKey);
    const parcels = info?.fabricRole === "parcel-polygon";
    return { layerKey: s.layerKey, name: s.name, count: s.count, parcels, editable: isLayerEditable(info) && (parcels || !!info?.layer.capabilities?.operations.supportsDelete) };
  });
  return { layers, total: layers.filter((l) => l.editable).reduce((n, l) => n + l.count, 0), hasParcels: layers.some((l) => l.parcels && l.editable) };
}

/**
 * Delete the selected features of every editable layer, in chunks, inside
 * the active edit session. Returns server-confirmed counts – nothing is
 * reported as deleted unless the server says so.
 */
export async function deleteSelected(parcelMode: ParcelDeleteMode = "retire"): Promise<{ deleted: number; failed: number; errors: string[] }> {
  if (useEditing.getState().session !== "editing") throw new Error("Start editing before deleting features.");
  const plan = planDeleteSelected();
  let deleted = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const l of plan.layers.filter((x) => x.editable)) {
    const info = layerRegistry.get(l.layerKey)!;
    const ids = selectionService.getIds(info);
    if (l.parcels) {
      // Parcels go through the Parcel Fabric: retire keeps them as history; delete also removes their unused lines and points.
      try {
        if (parcelMode === "retire") await parcelFabricService.retire(ids);
        else await parcelFabricService.deletePermanently(ids);
        deleted += ids.length;
        selectionService.clearLayer(info);
      } catch (e) {
        failed += ids.length;
        errors.push(`${info.name}: ${(e as Error).message}`);
      }
      continue;
    }
    const removed: number[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      try {
        const res = await info.layer.applyEdits({ deleteFeatures: chunk.map((objectId) => ({ objectId })) as never });
        for (const r of res.deleteFeatureResults) {
          if (r.error) {
            failed++;
            if (errors.length < 5) errors.push(`${info.name} #${r.objectId}: ${r.error.message}`);
          } else {
            deleted++;
            removed.push(r.objectId as number);
          }
        }
      } catch (e) {
        failed += chunk.length;
        errors.push(`${info.name}: ${describeArcGISError(e)}`);
      }
    }
    // Deselect only what the server deleted; anything that failed stays selected for a retry.
    selectionService.apply(info.layer, removed, "remove");
  }
  return { deleted, failed, errors };
}
