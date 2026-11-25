// Unit tests for the Merge neighbour check (real ArcGIS geometry operators, no server): npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import Polygon from "@arcgis/core/geometry/Polygon.js";
import { connectedGroups, mergeAdjacencyProblem, sharedBoundaryLength, MIN_SHARED_BOUNDARY_M } from "../../src/gis/parcel-fabric/adjacency.ts";

// A projected coordinate system in metres, like the Plot layer's (ITRF 2005 TM).
const SR = { wkid: 32735 };
const box = (x, y, w = 10, h = 10, sr = SR) =>
  new Polygon({ rings: [[[x, y], [x, y + h], [x + w, y + h], [x + w, y], [x, y]]], spatialReference: sr });
const parcel = (objectId, geometry) => ({ objectId, label: `UPI-${objectId}`, geometry });

test("parcels sharing a whole side are neighbours", () => {
  assert.ok(Math.abs(sharedBoundaryLength(box(0, 0), box(10, 0)) - 10) < 0.05);
  assert.equal(mergeAdjacencyProblem([parcel(1, box(0, 0)), parcel(2, box(10, 0))]), null);
});

test("parcels sharing only part of a side are neighbours", () => {
  // 3 m of B's left side runs along A's right side
  assert.equal(mergeAdjacencyProblem([parcel(1, box(0, 0)), parcel(2, box(10, 7, 10, 10))]), null);
});

test("vertices a few millimetres apart (within tolerance) still count as a shared boundary", () => {
  assert.equal(mergeAdjacencyProblem([parcel(1, box(0, 0)), parcel(2, box(10.003, 0))]), null);
});

test("parcels touching only at a corner are refused", () => {
  assert.ok(sharedBoundaryLength(box(0, 0), box(10, 10)) < MIN_SHARED_BOUNDARY_M);
  const problem = mergeAdjacencyProblem([parcel(1, box(0, 0)), parcel(2, box(10, 10))]);
  assert.match(problem, /UPI-1 and UPI-2 only touch at a corner/);
});

test("parcels apart are refused with the distance", () => {
  assert.match(mergeAdjacencyProblem([parcel(1, box(0, 0)), parcel(2, box(30, 0))]), /not neighbours: they are 20\.0 m apart/);
  // a 5 cm sliver between them is a gap, not a shared boundary
  assert.match(mergeAdjacencyProblem([parcel(1, box(0, 0)), parcel(2, box(10.05, 0))]), /not neighbours: they are 0\.05 m apart/);
});

test("a chain A–B–C is one connected group even though A and C don't touch", () => {
  assert.equal(mergeAdjacencyProblem([parcel(1, box(0, 0)), parcel(2, box(10, 0)), parcel(3, box(20, 0))]), null);
  // an L shape: A–B side by side, C above B
  assert.equal(mergeAdjacencyProblem([parcel(1, box(0, 0)), parcel(2, box(10, 0)), parcel(3, box(10, 10))]), null);
});

test("several parcels that are not one connected group are refused, naming the groups", () => {
  const problem = mergeAdjacencyProblem([parcel(1, box(0, 0)), parcel(2, box(10, 0)), parcel(3, box(100, 0))]);
  assert.match(problem, /not one connected group of neighbours/);
  assert.match(problem, /\[UPI-1 and UPI-2\] and \[UPI-3\]/);
  // two pairs, each touching inside, but the pairs apart
  const pairs = mergeAdjacencyProblem([parcel(1, box(0, 0)), parcel(2, box(10, 0)), parcel(3, box(100, 0)), parcel(4, box(110, 0))]);
  assert.match(pairs, /\[UPI-1 and UPI-2\] and \[UPI-3 and UPI-4\]/);
});

test("connectedGroups joins ids through links", () => {
  assert.deepEqual(connectedGroups([1, 2, 3, 4], [[1, 2], [3, 4]]), [[1, 2], [3, 4]]);
  assert.deepEqual(connectedGroups([1, 2, 3, 4], [[1, 2], [2, 3], [3, 4]]), [[1, 2, 3, 4]]);
  assert.deepEqual(connectedGroups([5, 1, 3], []), [[1], [3], [5]]);
});

test("shapes in degrees are refused rather than measured wrongly", () => {
  const wgs = { wkid: 4326 };
  assert.throws(() => mergeAdjacencyProblem([parcel(1, box(30, -2, 0.001, 0.001, wgs)), parcel(2, box(30.001, -2, 0.001, 0.001, wgs))]), /metres, not degrees/);
});
