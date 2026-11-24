// Unit tests for the Shapefile reader (no server, no browser): npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readShapefiles } from "../../src/utils/shapefile.ts";
import { dbf, shp, zip } from "../support/shapefile-fixture.mjs";

const PRJ = Buffer.from('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]');
const square = (x, y, s) => [[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]];
const read = (files) => readShapefiles(Object.entries(files).map(([name, bytes]) => ({ name, bytes: new Uint8Array(bytes) })));

test("polygons with holes, text, numbers and dates, from a deflated zip", async () => {
  const hole = square(2, 2, 1).reverse();
  const files = {
    "survey/plots.shp": shp(5, [[square(0, 0, 10), hole], [square(20, 20, 5)]]),
    "survey/plots.dbf": dbf([["UPI", "C", 20], ["AREA", "N", 10], ["SURVEYED", "D", 8]], [["1/02/13/02/7", 99.5, "20261122"], ["", "", ""]]),
    "survey/plots.prj": PRJ,
  };
  const [d] = await read({ "upload.zip": zip(files) });
  assert.equal(d.kind, "polygon");
  assert.equal(d.name, "plots");
  assert.deepEqual(d.features[0].parts, [square(0, 0, 10), hole]);
  assert.deepEqual(d.features[0].values, ["1/02/13/02/7", 99.5, "2026-11-22"]);
  assert.deepEqual(d.features[1].values, [null, null, null]);
});

test("stored zip, several Shapefiles, unrelated entries ignored", async () => {
  const files = { "a.shp": shp(1, [[30.1, -1.95]]), "a.prj": PRJ, "b.shp": shp(3, [[[[0, 0], [1, 1]]]]), "b.prj": PRJ, "readme.txt": Buffer.from("x") };
  const out = await read({ "two.zip": zip(files, { store: true }) });
  assert.deepEqual(out.map((d) => d.kind).sort(), ["point", "polyline"]);
});

test("loose files, upper-case extensions", async () => {
  const [d] = await read({ "P.SHP": shp(8, [[[1, 2], [3, 4]]]), "P.PRJ": PRJ, "P.SHX": Buffer.alloc(100) });
  assert.deepEqual(d.features[0].parts, [[[1, 2], [3, 4]]]);
});

test("Z shapes keep X and Y", async () => {
  for (const [type, shape, kind] of [[11, [5, 6], "point"], [13, [[[0, 0], [2, 2]]], "polyline"], [15, [square(0, 0, 3)], "polygon"]]) {
    const [d] = await read({ "z.shp": shp(type, [shape]), "z.prj": PRJ });
    assert.equal(d.kind, kind);
    assert.equal(d.features.length, 1);
  }
});

test("empty and deleted records are skipped without shifting attributes", async () => {
  const [d] = await read({ "s.shp": shp(1, [[1, 1], null, [3, 3], [4, 4]]), "s.prj": PRJ, "s.dbf": dbf([["N", "N", 4]], [[1], [2], null, [4]]) });
  assert.equal(d.skipped, 2);
  assert.deepEqual(d.features.map((f) => [f.parts[0][0][0], f.values[0]]), [[1, 1], [4, 4]]);
});

test("text encodings: UTF-8, Windows-1252, declared code page", async () => {
  const one = async (encoding, cpg) =>
    (await read({ "t.shp": shp(1, [[1, 1]]), "t.prj": PRJ, "t.dbf": dbf([["NAME", "C", 12]], [["Musée"]], encoding), ...(cpg ? { "t.cpg": Buffer.from(cpg) } : {}) }))[0].features[0].values[0];
  assert.equal(await one("utf8"), "Musée");
  assert.equal(await one("latin1"), "Musée");
  assert.equal(await one("latin1", "1252"), "Musée");
});

test("field names are made safe and unique", async () => {
  const [d] = await read({ "f.shp": shp(1, [[1, 1]]), "f.prj": PRJ, "f.dbf": dbf([["A B", "C", 2], ["A_B", "C", 2], ["1X", "C", 2]], [["a", "b", "c"]]) });
  assert.deepEqual(d.fields.map((f) => f.name), ["A_B", "A_B_2", "F_1X"]);
});

test("bad input gets a readable error", async () => {
  const good = shp(5, [[square(0, 0, 1)]]);
  await assert.rejects(read({ "x.shp": good }), /\.prj file is missing/);
  await assert.rejects(read({ "x.dbf": dbf([["A", "C", 1]], [["a"]]) }), /No \.shp found/);
  await assert.rejects(read({ "x.zip": Buffer.from("this is not a zip archive at all") }), /not a readable \.zip/);
  await assert.rejects(read({ "x.shp": good.subarray(0, good.length - 10), "x.prj": PRJ }), /damaged/);
  await assert.rejects(read({ "x.shp": Buffer.alloc(120), "x.prj": PRJ }), /not a valid Shapefile/);
  await assert.rejects(read({ "x.shp": good, "x.prj": PRJ, "x.dbf": dbf([["A", "C", 1]], [["a"], ["b"]]) }), /not from the same dataset/);
});
