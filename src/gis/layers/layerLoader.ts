import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import GroupLayer from "@arcgis/core/layers/GroupLayer.js";
import MapImageLayer from "@arcgis/core/layers/MapImageLayer.js";
import Layer from "@arcgis/core/layers/Layer.js";
import PortalItem from "@arcgis/core/portal/PortalItem.js";
import { fetchServiceJson, type ServiceJson } from "../../services/arcgis/serviceMetadata";
import { layerRegistry, type FabricRole, type ServiceLayerInfo } from "./layerRegistry";

const GEOMETRY_RANK: Record<string, number> = {
  esriGeometryPolygon: 0,
  esriGeometryPolyline: 1,
  esriGeometryMultipoint: 2,
  esriGeometryPoint: 3,
};

export interface FeatureServiceLoadResult {
  group: GroupLayer;
  tables: FeatureLayer[];
  serviceJson: ServiceJson;
  /** Parcel Fabric controller (Parcel Layer) metadata, if the service has one. */
  parcelLayerJson: ServiceJson | null;
}

/** Scale (1:x) beyond which dense fabric points/connection lines are hidden when the service sets no range. */
export const DENSE_LAYER_MIN_SCALE = 5000;

/** Display filter for fabric parcels and lines: current features only (historic ones have RetiredByRecord). */
export const CURRENT_ONLY = "retiredbyrecord IS NULL";

const GROUP_TYPES = new Set(["Group Layer", "Topology Layer", "Parcel Layer"]);

/**
 * Work out each layer's role in the Parcel Fabric from the controller
 * ("Parcel Layer") metadata: `systemLayers`, `associatedLayers` and the
 * FeatureServer's `controllerDatasetLayers` (topology).
 */
function fabricRoles(parcelLayer: ServiceJson | null, topologyJson: ServiceJson | null): Map<number, FabricRole> {
  const roles = new Map<number, FabricRole>();
  if (!parcelLayer) return roles;
  const sys = parcelLayer.systemLayers ?? {};
  const assoc = parcelLayer.associatedLayers ?? {};
  if (typeof sys.recordsLayerId === "number") roles.set(sys.recordsLayerId, "records");
  for (const id of assoc.polygonParcelTypes ?? []) roles.set(id, "parcel-polygon");
  for (const id of assoc.lineParcelTypes ?? []) roles.set(id, "parcel-line");
  if (typeof assoc.pointsLayerId === "number") roles.set(assoc.pointsLayerId, "points");
  if (typeof assoc.connectionsLayerId === "number") roles.set(assoc.connectionsLayerId, "connection-lines");
  for (const k of ["adjustmentPointsLayerId", "adjustmentLinesLayerId", "adjustmentVectorsLayerId"])
    if (typeof assoc[k] === "number") roles.set(assoc[k], "adjustment");
  for (const sub of topologyJson?.subLayers ?? []) if (!roles.has(sub.id)) roles.set(sub.id, "topology-error");
  return roles;
}

/**
 * Build operational layers for the Parcel Fabric FeatureServer from live
 * metadata. When the MapServer is readable, its layer tree (groups, topology,
 * parcel layer, default visibility, drawing order) is mirrored so the table of
 * contents matches the published map; otherwise a flat list ordered by
 * geometry type is used. Leaves are always FeatureServer layers (editable).
 */
export async function loadParcelFeatureService(
  url: string,
  mapServerUrl: string | null,
  signal?: AbortSignal,
): Promise<FeatureServiceLoadResult> {
  const [serviceJson, layersJson, msLayersJson] = await Promise.all([
    fetchServiceJson(url, { signal }),
    fetchServiceJson(`${url}/layers`, { signal }),
    mapServerUrl ? fetchServiceJson(`${mapServerUrl}/layers`, { signal }).catch(() => null) : Promise.resolve(null),
  ]);
  layerRegistry.featureServiceJson = serviceJson;

  const allDefs: ServiceJson[] = layersJson.layers ?? [];
  const byId = new Map<number, ServiceJson>(allDefs.map((d) => [d.id, d]));
  const parcelLayerId: number | undefined = serviceJson.controllerDatasetLayers?.parcelLayerId;
  const topologyId: number | undefined = serviceJson.controllerDatasetLayers?.topologyLayerIds?.[0];
  const parcelLayerJson = parcelLayerId !== undefined ? (byId.get(parcelLayerId) ?? null) : null;
  const roles = fabricRoles(parcelLayerJson, topologyId !== undefined ? (byId.get(topologyId) ?? null) : null);

  const makeFeatureLayer = (def: ServiceJson, visible: boolean) => {
    const role = roles.get(def.id);
    // Parcel Fabric convention: show current parcels and lines; historic ones (RetiredByRecord set)
    // stay in the data and are reached through parcel lineage. Display only.
    const showsHistory = (role === "parcel-polygon" || role === "parcel-line") && (def.fields ?? []).some((f: ServiceJson) => f.name?.toLowerCase() === "retiredbyrecord");
    const layer = new FeatureLayer({ url: `${url}/${def.id}`, id: `fs-${def.id}`, title: def.name, visible, definitionExpression: showsHistory ? CURRENT_ONLY : undefined });
    // Display-only performance default: dense fabric points / connection lines (tens of
    // thousands of features) are drawn only when zoomed in, unless the service already
    // defines a visible scale range. The data and service are not modified.
    if ((role === "points" || role === "connection-lines") && !def.minScale) {
      void layer.when(() => {
        if (!layer.minScale) layer.minScale = DENSE_LAYER_MIN_SCALE;
      });
    }
    register(def, layer, url, "feature", roles.get(def.id));
    return layer;
  };

  let rootLayers: Layer[];
  const msLayers: ServiceJson[] | null = msLayersJson?.layers ?? null;
  if (msLayers?.length) {
    // MapServer order is top-of-TOC first; GroupLayer.layers index 0 draws at the bottom.
    const msById = new Map<number, ServiceJson>(msLayers.map((l) => [l.id, l]));
    const build = (ms: ServiceJson): Layer | null => {
      if (GROUP_TYPES.has(ms.type)) {
        const children = (ms.subLayers ?? [])
          .map((s: ServiceJson) => msById.get(s.id))
          .filter(Boolean)
          .map((c: ServiceJson) => build(c))
          .filter((l: Layer | null): l is Layer => !!l)
          .reverse();
        return new GroupLayer({
          id: `group-${ms.id}`,
          title: ms.name,
          visible: ms.defaultVisibility !== false,
          visibilityMode: "independent",
          layers: children,
        });
      }
      const def = byId.get(ms.id);
      return def?.type === "Feature Layer" ? makeFeatureLayer(def, ms.defaultVisibility !== false) : null;
    };
    rootLayers = msLayers
      .filter((l) => !l.parentLayer)
      .map(build)
      .filter((l): l is Layer => !!l)
      .reverse();
  } else {
    const ordered = allDefs
      .filter((l) => l.type === "Feature Layer")
      .sort((a, b) => (GEOMETRY_RANK[a.geometryType] ?? 9) - (GEOMETRY_RANK[b.geometryType] ?? 9) || b.id - a.id);
    rootLayers = ordered.map((def) => makeFeatureLayer(def, def.defaultVisibility !== false));
  }

  const tables = (layersJson.tables ?? []).map((def: ServiceJson) => {
    const layer = new FeatureLayer({ url: `${url}/${def.id}`, id: `fs-table-${def.id}`, title: def.name });
    register(def, layer, url, "table", roles.get(def.id));
    return layer;
  });

  const group = new GroupLayer({
    id: "parcel-fabric-fs",
    title: parcelLayerJson ? `Parcel Fabric — ${parcelLayerJson.name}` : serviceJson.documentInfo?.Title || "Parcel Fabric",
    visibilityMode: "independent",
    layers: rootLayers,
  });
  layerRegistry.emit();
  return { group, tables, serviceJson, parcelLayerJson };
}

function register(def: ServiceJson, layer: FeatureLayer, serviceUrl: string, kind: "feature" | "table", fabricRole?: FabricRole) {
  const info: ServiceLayerInfo = {
    key: `fs:${def.id}`,
    serviceLayerId: def.id,
    name: def.name,
    kind,
    geometryType: def.geometryType ?? null,
    url: `${serviceUrl}/${def.id}`,
    layer,
    metadata: def,
    source: "parcel-fabric",
    fabricRole: fabricRole ?? null,
  };
  layerRegistry.set(info);
  // Capabilities (can add / update / delete) are only known once the layer has loaded. Load it now,
  // even when hidden or out of scale, and notify again so anything built from the registry (the
  // Editor's editable layers, toolbar states) is rebuilt with real capabilities. Without this, a
  // panel built before loading finished kept every layer marked "not editable".
  // (Load failures are reported to the user by MapController.loadServices.)
  layer.load().then(
    () => layerRegistry.emit(),
    () => undefined,
  );
}

/** MapServer as a dynamic MapImageLayer (hidden by default to avoid double drawing). */
export async function loadParcelMapService(url: string, signal?: AbortSignal): Promise<MapImageLayer> {
  layerRegistry.mapServiceJson = await fetchServiceJson(url, { signal });
  return new MapImageLayer({
    url,
    id: "parcel-fabric-ms",
    title: `${layerRegistry.mapServiceJson.documentInfo?.Title || "Parcel Fabric"} (Map Service)`,
    visible: false,
  });
}

/**
 * Add any ArcGIS Server layer or service by URL. The SDK inspects the URL and
 * creates the right layer type (FeatureLayer, MapImageLayer, TileLayer, ...).
 */
export async function createLayerFromUrl(url: string): Promise<Layer> {
  const clean = url.trim().replace(/\?.*$/, "").replace(/\/+$/, "");
  if (!/^https:\/\//i.test(clean)) throw new Error("Only HTTPS service URLs are supported.");
  const layer = await Layer.fromArcGISServerUrl({ url: clean });
  await layer.load();
  return layer;
}

export async function createLayerFromPortalItem(itemId: string): Promise<Layer> {
  const layer = await Layer.fromPortalItem({ portalItem: new PortalItem({ id: itemId }) });
  await layer.load();
  return layer;
}

/** Register FeatureLayers that the user added so they get properties/table support. */
export function registerAddedLayer(layer: Layer): void {
  const add = (l: Layer) => {
    if (l.type === "feature") {
      const fl = l as FeatureLayer;
      layerRegistry.set({
        key: `added:${fl.uid}`,
        serviceLayerId: fl.layerId ?? null,
        name: fl.title ?? "Layer",
        kind: fl.isTable ? "table" : "feature",
        geometryType: fl.geometryType ? `esriGeometry${fl.geometryType[0]!.toUpperCase()}${fl.geometryType.slice(1)}` : null,
        url: fl.url ? `${fl.url}/${fl.layerId}` : "",
        layer: fl,
        metadata: (fl.sourceJSON as ServiceJson) ?? {},
        source: "added",
        fabricRole: null,
      });
    } else if (l.type === "group") {
      (l as GroupLayer).layers.forEach(add);
    } else {
      layerRegistry.otherLayers.set(l.uid, l);
    }
  };
  add(layer);
}

export function unregisterLayer(layer: Layer): void {
  for (const info of layerRegistry.all()) {
    if (info.layer === layer || (layer.type === "group" && (layer as GroupLayer).allLayers.includes(info.layer))) {
      layerRegistry.remove(info.key);
    }
  }
  layerRegistry.otherLayers.delete(layer.uid);
}
