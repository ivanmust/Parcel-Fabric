import type FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import type Layer from "@arcgis/core/layers/Layer.js";
import type { ServiceJson } from "../../services/arcgis/serviceMetadata";

/**
 * Registry of operational layers created from service metadata. Everything
 * here comes from the services' REST metadata – nothing about layer IDs,
 * names, geometry types or fields is hard-coded.
 */
/** Role of a layer inside the Parcel Fabric, derived from the controller metadata. */
export type FabricRole =
  | "records"
  | "parcel-polygon"
  | "parcel-line"
  | "points"
  | "connection-lines"
  | "adjustment"
  | "topology-error";

export const FABRIC_ROLE_LABEL: Record<FabricRole, string> = {
  records: "Parcel records",
  "parcel-polygon": "Parcel type (polygons)",
  "parcel-line": "Parcel type (lines)",
  points: "Fabric points",
  "connection-lines": "Connection lines",
  adjustment: "Least-squares adjustment",
  "topology-error": "Topology / validation errors",
};

export interface ServiceLayerInfo {
  /** Parcel Fabric role, or null for non-fabric layers */
  fabricRole: FabricRole | null;
  /** Stable key, e.g. "fs:3" or "added:<uuid>" */
  key: string;
  serviceLayerId: number | null;
  name: string;
  kind: "feature" | "table";
  geometryType: string | null;
  url: string;
  layer: FeatureLayer;
  metadata: ServiceJson;
  source: "parcel-fabric" | "added";
}

type Listener = () => void;

class LayerRegistry {
  private items = new Map<string, ServiceLayerInfo>();
  private listeners = new Set<Listener>();
  private version = 0;
  featureServiceJson: ServiceJson | null = null;
  mapServiceJson: ServiceJson | null = null;
  /** Non-feature layers added by the user (MapImageLayer, tile layers, ...) */
  otherLayers = new Map<string, Layer>();

  set(info: ServiceLayerInfo) {
    this.items.set(info.key, info);
    this.emit();
  }
  remove(key: string) {
    this.items.delete(key);
    this.emit();
  }
  get(key: string) {
    return this.items.get(key);
  }
  findByLayer(layer: Layer | null | undefined) {
    if (!layer) return undefined;
    for (const i of this.items.values()) if (i.layer === layer) return i;
    return undefined;
  }
  all() {
    return [...this.items.values()];
  }
  /** Layers of the Parcel Fabric service (not ones the user added). */
  fabricLayers() {
    return this.all().filter((i) => i.source === "parcel-fabric");
  }
  /** The first layer with a Parcel Fabric role (e.g. the parcel polygons), if the service has one. */
  byRole(role: FabricRole) {
    return this.all().find((i) => i.fabricRole === role);
  }
  allByRole(role: FabricRole) {
    return this.all().filter((i) => i.fabricRole === role);
  }
  /** Like `byRole`, but throws a readable error when the service has no such layer. */
  requireRole(role: FabricRole): ServiceLayerInfo {
    const info = this.byRole(role);
    if (!info) throw new Error(`This service has no ${FABRIC_ROLE_LABEL[role].toLowerCase()} layer.`);
    return info;
  }
  getVersion() {
    return this.version;
  }
  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }
}

export const layerRegistry = new LayerRegistry();
