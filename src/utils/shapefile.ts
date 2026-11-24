/**
 * Reads Shapefiles in the browser: a .zip, or loose .shp + .prj (+ .dbf, .cpg) files. No SDK and no
 * network, so it is also tested directly in Node (tests/unit/shapefile.test.mjs).
 * Format: ESRI Shapefile Technical Description (1998), dBASE III attributes, ZIP (stored or deflated).
 */
export type ShapeKind = "point" | "multipoint" | "polyline" | "polygon";
export type ShapeValue = string | number | null;

export interface ShapeField {
  name: string;
  alias: string;
  numeric: boolean;
}

export interface ShapeDataset {
  name: string;
  kind: ShapeKind;
  /** The .prj text: the coordinate system as WKT. */
  wkt: string;
  fields: ShapeField[];
  /** One list of coordinates per part (a point or multipoint has a single part). */
  features: { parts: number[][][]; values: ShapeValue[] }[];
  /** Records without a geometry, or deleted in the .dbf. */
  skipped: number;
}

export interface NamedBytes {
  name: string;
  bytes: Uint8Array;
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
const MAX_FEATURES = 200_000;
const WANTED = /\.(shp|dbf|prj|cpg)$/i;

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

async function inflate(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("The .zip is too large when unpacked (limit 300 MB).");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function unzip(zip: Uint8Array): Promise<NamedBytes[]> {
  const v = view(zip);
  let end = zip.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("This is not a readable .zip file.");
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new Error("ZIP64 archives are not supported. Zip only the Shapefile.");

  const out: NamedBytes[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || v.getUint32(at, true) !== 0x02014b50) throw new Error("The .zip file is damaged.");
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const packed = v.getUint32(at + 20, true);
    const nameLength = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, "/");
    at += 46 + nameLength + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
    if (!WANTED.test(name) || name.startsWith("__MACOSX/")) continue;
    if (flags & 1) throw new Error("Password-protected .zip files are not supported.");
    if (local + 30 > zip.length) throw new Error("The .zip file is damaged.");
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (start + packed > zip.length) throw new Error("The .zip file is damaged.");
    const body = zip.subarray(start, start + packed);
    if (method !== 0 && method !== 8) throw new Error("The .zip uses an unsupported compression. Zip it again with Windows or 7-Zip (Deflate).");
    const bytes = method === 0 ? body : await inflate(body, MAX_UNPACKED_BYTES - total);
    total += bytes.length;
    if (total > MAX_UNPACKED_BYTES) throw new Error("The .zip is too large when unpacked (limit 300 MB).");
    out.push({ name, bytes });
  }
  return out;
}

function shapeKind(code: number): ShapeKind {
  if (code === 1 || code === 11 || code === 21) return "point";
  if (code === 8 || code === 18 || code === 28) return "multipoint";
  if (code === 3 || code === 13 || code === 23) return "polyline";
  if (code === 5 || code === 15 || code === 25) return "polygon";
  throw new Error(`Shape type ${code} is not supported (points, lines and polygons are).`);
}

function readShp(bytes: Uint8Array): { kind: ShapeKind; shapes: (number[][][] | null)[] } {
  const v = view(bytes);
  if (bytes.length < 100 || v.getInt32(0, false) !== 9994) throw new Error("The .shp file is not a valid Shapefile.");
  const kind = shapeKind(v.getInt32(32, true));
  const damaged = () => new Error("The .shp file is damaged or incomplete.");
  if (v.getInt32(24, false) * 2 > bytes.length) throw damaged();

  const shapes: (number[][][] | null)[] = [];
  let at = 100;
  while (at + 8 <= bytes.length) {
    const start = at + 8;
    const end = start + v.getInt32(at + 4, false) * 2;
    if (end < start + 4 || end > bytes.length) throw damaged();
    at = end;
    if (shapes.length >= MAX_FEATURES) throw new Error(`Too many features (limit ${MAX_FEATURES.toLocaleString("en-US")}).`);
    const code = v.getInt32(start, true);
    if (code === 0) {
      shapes.push(null);
      continue;
    }
    if (shapeKind(code) !== kind) throw damaged();

    const readPoints = (from: number, count: number) => {
      if (count < 0 || from + count * 16 > end) throw damaged();
      return Array.from({ length: count }, (_, i) => {
        const x = v.getFloat64(from + i * 16, true);
        const y = v.getFloat64(from + i * 16 + 8, true);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw damaged();
        return [x, y];
      });
    };

    if (kind === "point") {
      shapes.push([readPoints(start + 4, 1)]);
    } else if (kind === "multipoint") {
      if (start + 40 > end) throw damaged();
      shapes.push([readPoints(start + 40, v.getInt32(start + 36, true))]);
    } else {
      if (start + 44 > end) throw damaged();
      const partCount = v.getInt32(start + 36, true);
      const pointCount = v.getInt32(start + 40, true);
      const pointsAt = start + 44 + partCount * 4;
      if (partCount < 1 || pointsAt > end) throw damaged();
      const points = readPoints(pointsAt, pointCount);
      const starts = Array.from({ length: partCount }, (_, i) => v.getInt32(start + 44 + i * 4, true));
      shapes.push(starts.map((s, i) => points.slice(s, starts[i + 1] ?? pointCount)));
    }
  }
  return { kind, shapes };
}

function textDecoder(cpg?: Uint8Array): (b: Uint8Array) => string {
  const declared = cpg ? new TextDecoder().decode(cpg).trim().toLowerCase() : "";
  const label = /^\d{4}$/.test(declared) ? `windows-${declared}` : declared;
  if (label && label !== "utf-8" && label !== "utf8") {
    try {
      const declaredDecoder = new TextDecoder(label);
      return (b) => declaredDecoder.decode(b);
    } catch {
      // Unknown code page: use the same fallback as a file without a .cpg.
    }
  }
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const western = new TextDecoder("windows-1252");
  return (b) => {
    try {
      return utf8.decode(b);
    } catch {
      return western.decode(b);
    }
  };
}

/** Attribute rows in record order; a deleted record is null, so rows stay aligned with shapes. */
function readDbf(bytes: Uint8Array, decode: (b: Uint8Array) => string): { fields: ShapeField[]; rows: (ShapeValue[] | null)[] } {
  const damaged = () => new Error("The .dbf file is damaged or incomplete.");
  if (bytes.length < 32) throw damaged();
  const v = view(bytes);
  const count = v.getUint32(4, true);
  const headerSize = v.getUint16(8, true);
  const recordSize = v.getUint16(10, true);
  if (recordSize < 1 || headerSize + count * recordSize > bytes.length) throw damaged();

  const columns: (ShapeField & { at: number; size: number; type: string })[] = [];
  const used = new Set(["__oid"]);
  let offset = 1;
  for (let at = 32; at + 32 <= headerSize && bytes[at] !== 0x0d; at += 32) {
    const raw = bytes.subarray(at, at + 11);
    const zero = raw.indexOf(0);
    const alias = decode(zero < 0 ? raw : raw.subarray(0, zero)).trim() || `Field ${columns.length + 1}`;
    let name = alias.replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z]/.test(name)) name = `F_${name}`;
    const base = name;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`;
    used.add(name.toLowerCase());
    const type = String.fromCharCode(bytes[at + 11]!);
    const size = bytes[at + 16]!;
    columns.push({ name, alias, numeric: type === "N" || type === "F", type, at: offset, size });
    offset += size;
  }
  if (offset > recordSize) throw damaged();

  const rows: (ShapeValue[] | null)[] = [];
  for (let r = 0; r < count; r++) {
    const record = bytes.subarray(headerSize + r * recordSize, headerSize + (r + 1) * recordSize);
    if (record[0] === 0x2a) {
      rows.push(null);
      continue;
    }
    rows.push(
      columns.map((c) => {
        const text = decode(record.subarray(c.at, c.at + c.size)).replaceAll("\0", "").trim();
        if (!text) return null;
        if (c.numeric) return Number.isFinite(Number(text)) ? Number(text) : null;
        if (c.type === "D" && /^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
        return text;
      }),
    );
  }
  return { fields: columns.map(({ name, alias, numeric }) => ({ name, alias, numeric })), rows };
}

/** Every Shapefile in the given files; .zip files are unpacked first. */
export async function readShapefiles(input: NamedBytes[]): Promise<ShapeDataset[]> {
  if (input.reduce((n, f) => n + f.bytes.length, 0) > MAX_UPLOAD_BYTES) throw new Error("The files are too large (limit 100 MB).");
  const files = new Map<string, Uint8Array>();
  for (const f of input) {
    if (/\.zip$/i.test(f.name)) {
      for (const entry of await unzip(f.bytes)) files.set(`${f.name}/${entry.name}`.toLowerCase(), entry.bytes);
    } else if (WANTED.test(f.name)) {
      files.set(f.name.toLowerCase(), f.bytes);
    }
  }
  const shps = [...files.keys()].filter((name) => name.endsWith(".shp"));
  if (!shps.length) throw new Error("No .shp found. Choose a .zip of the Shapefile, or select its .shp, .dbf, .shx and .prj files together.");

  return shps.map((path) => {
    const base = path.slice(0, -4);
    const name = base.split("/").pop()!;
    const prj = files.get(`${base}.prj`);
    const wkt = prj ? new TextDecoder().decode(prj).trim() : "";
    if (!wkt) throw new Error(`${name}: the .prj file is missing. It gives the coordinate system; without it the data can't be placed on the map.`);
    const { kind, shapes } = readShp(files.get(path)!);
    const dbf = files.get(`${base}.dbf`);
    const table = dbf ? readDbf(dbf, textDecoder(files.get(`${base}.cpg`))) : null;
    if (table && table.rows.length !== shapes.length)
      throw new Error(`${name}: the .dbf has ${table.rows.length} records but the .shp has ${shapes.length}. They are not from the same dataset.`);

    const features: ShapeDataset["features"] = [];
    shapes.forEach((parts, i) => {
      const values = table ? table.rows[i] : [];
      if (parts && values) features.push({ parts, values });
    });
    if (!features.length) throw new Error(`${name}: the Shapefile has no features with a geometry.`);
    return { name, kind, wkt, fields: table?.fields ?? [], features, skipped: shapes.length - features.length };
  });
}
