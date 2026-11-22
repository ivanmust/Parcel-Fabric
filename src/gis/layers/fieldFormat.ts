import type FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import type Graphic from "@arcgis/core/Graphic.js";
import type Field from "@arcgis/core/layers/support/Field.js";

/** Render an attribute the way ArcGIS Pro would: domain names, subtype names, dates. */
export function formatAttribute(layer: FeatureLayer, field: Field, feature: Graphic): { text: string; isNull: boolean; raw?: string } {
  const value = feature.attributes?.[field.name];
  if (value === null || value === undefined || value === "") return { text: "<Null>", isNull: true };

  const subtypeField = layer.subtypeField;
  if (subtypeField && field.name === subtypeField && layer.subtypes?.length) {
    const st = layer.subtypes.find((s) => s.code === value);
    if (st) return { text: st.name, isNull: false, raw: String(value) };
  }

  const domain = layer.getFieldDomain(field.name, { feature });
  if (domain?.type === "coded-value") {
    const name = domain.getName(value);
    if (name) return { text: name, isNull: false, raw: String(value) };
  }

  switch (field.type) {
    case "date":
      return { text: new Date(value).toLocaleString("en-GB"), isNull: false };
    case "date-only":
    case "time-only":
    case "timestamp-offset":
      return { text: String(value), isNull: false };
    case "double":
    case "single":
      return { text: Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 }), isNull: false };
    default:
      return { text: String(value), isNull: false };
  }
}

export const FIELD_TYPE_LABEL: Record<string, string> = {
  "small-integer": "Short",
  integer: "Long",
  "big-integer": "Big integer",
  single: "Float",
  double: "Double",
  string: "Text",
  date: "Date",
  "date-only": "Date only",
  "time-only": "Time only",
  "timestamp-offset": "Timestamp offset",
  oid: "ObjectID",
  "global-id": "GlobalID",
  guid: "GUID",
  geometry: "Geometry",
  blob: "Blob",
  raster: "Raster",
  xml: "XML",
};
