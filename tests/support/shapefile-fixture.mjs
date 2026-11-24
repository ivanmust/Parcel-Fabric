// Writes small Shapefiles and zips for the tests, following the ESRI Shapefile and ZIP specifications.
import { deflateRawSync, crc32 } from "node:zlib";

/**
 * shapes: polygons / polylines as parts of [x, y]; points as [x, y]; multipoints as [[x, y], …]; null = no geometry.
 * type: 1 point, 3 polyline, 5 polygon, 8 multipoint, 11 / 13 / 15 the Z versions.
 */
export function shp(type, shapes) {
  const base = type % 10;
  const z = type > 10;
  const bodies = shapes.map((shape) => {
    if (!shape) return Buffer.alloc(4);
    if (base === 1) {
      const b = Buffer.alloc(z ? 36 : 20);
      b.writeInt32LE(type, 0);
      b.writeDoubleLE(shape[0], 4);
      b.writeDoubleLE(shape[1], 12);
      return b;
    }
    const points = base === 8 ? shape : shape.flat();
    const head = base === 8 ? 40 : 44 + shape.length * 4;
    const b = Buffer.alloc(head + points.length * 16 + (z ? 2 * (16 + points.length * 8) : 0));
    b.writeInt32LE(type, 0);
    if (base === 8) b.writeInt32LE(points.length, 36);
    else {
      b.writeInt32LE(shape.length, 36);
      b.writeInt32LE(points.length, 40);
      let first = 0;
      shape.forEach((part, i) => {
        b.writeInt32LE(first, 44 + i * 4);
        first += part.length;
      });
    }
    points.forEach(([x, y], i) => {
      b.writeDoubleLE(x, head + i * 16);
      b.writeDoubleLE(y, head + i * 16 + 8);
    });
    return b;
  });
  const header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0);
  header.writeInt32LE(1000, 28);
  header.writeInt32LE(type, 32);
  const records = bodies.flatMap((body, i) => {
    const h = Buffer.alloc(8);
    h.writeInt32BE(i + 1, 0);
    h.writeInt32BE(body.length / 2, 4);
    return [h, body];
  });
  const all = Buffer.concat([header, ...records]);
  all.writeInt32BE(all.length / 2, 24);
  return all;
}

/** fields: [name, "C" | "N" | "D", size]; a null row is a deleted record. */
export function dbf(fields, rows, encoding = "utf8") {
  const recordSize = 1 + fields.reduce((n, f) => n + f[2], 0);
  const header = Buffer.alloc(32 + fields.length * 32 + 1);
  header[0] = 3;
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt16LE(header.length, 8);
  header.writeUInt16LE(recordSize, 10);
  fields.forEach(([name, type, size], i) => {
    header.write(name, 32 + i * 32, 10, "latin1");
    header.write(type, 32 + i * 32 + 11, 1, "latin1");
    header[32 + i * 32 + 16] = size;
  });
  header[header.length - 1] = 0x0d;
  const records = rows.map((row) => {
    const b = Buffer.alloc(recordSize, 0x20);
    if (!row) {
      b[0] = 0x2a;
      return b;
    }
    let at = 1;
    fields.forEach(([, , size], i) => {
      b.write(String(row[i] ?? ""), at, size, encoding);
      at += size;
    });
    return b;
  });
  return Buffer.concat([header, ...records, Buffer.from([0x1a])]);
}

/** entries: { "name.shp": Buffer }; deflated unless `store`. */
export function zip(entries, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const raw = Buffer.from(data);
    const body = store ? raw : deflateRawSync(raw);
    const n = Buffer.from(name);
    const common = (b, at) => {
      b.writeUInt16LE(20, at);
      b.writeUInt16LE(store ? 0 : 8, at + 4);
      b.writeUInt32LE(crc32(raw), at + 10);
      b.writeUInt32LE(body.length, at + 14);
      b.writeUInt32LE(raw.length, at + 18);
      b.writeUInt16LE(n.length, at + 22);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    common(local, 4);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    common(central, 6);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, body);
    centrals.push(central, n);
    offset += local.length + n.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
