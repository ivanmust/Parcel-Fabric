// Unit tests for the topology error explanations and the parcels named at an error (no server): npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIRTY_AREA_EXPLANATION, explainTopologyError, parcelsAtError } from "../../src/gis/parcel-fabric/topologyErrors.ts";

const RULES = [
  "esriTRTAreaBoundaryCoveredByLine",
  "esriTRTLineEndpointCoveredByPoint",
  "esriTRTLineCoveredByAreaBoundary",
  "esriTRTPointCoveredByLineEndpoint",
  "esriTRTAreaNoGaps",
  "esriTRTAreaNoOverlap",
  "esriTRTLineNoDangles",
  "esriTRTLineNoSelfOverlap",
  "esriTRTLineNoSelfIntersect",
];

test("every parcel fabric rule is explained and tells the surveyor what to check", () => {
  for (const rule of RULES) {
    const e = explainTopologyError(rule, "Rule name");
    assert.ok(e.what.length > 10, rule);
    assert.match(e.check, /surveyor/i, rule);
    assert.doesNotMatch(e.what, /esriTRT/, rule);
  }
});

test("an overlap says two parcels cover the same ground", () => {
  assert.match(explainTopologyError("esriTRTAreaNoOverlap", "Must not overlap").what, /same ground/);
});

test("an unknown rule gets a general explanation with the rule's name", () => {
  const e = explainTopologyError("esriTRTSomethingNew", "Must be special");
  assert.match(e.what, /Must be special/);
  assert.match(e.check, /surveyor/);
  assert.match(explainTopologyError(null, "Topology rule 9").what, /Topology rule 9/);
});

test("no explanation offers to fix anything in the app", () => {
  for (const rule of [...RULES, null]) {
    const e = explainTopologyError(rule, "x");
    assert.doesNotMatch(`${e.what} ${e.check}`, /\b(click|button|mark as exception)\b/i, String(rule));
  }
  assert.match(DIRTY_AREA_EXPLANATION.what, /not been validated/);
});

test("an overlap names the two parcels sharing the ground, not a neighbour that only touches it", () => {
  const parcels = parcelsAtError(
    [
      { label: "1/02/13/02/2674", shared: 12 },
      { label: "1/02/13/02/2675", shared: 12 },
      { label: "1/02/13/02/9999", shared: 0 },
    ],
    12,
  );
  assert.deepEqual(parcels, ["1/02/13/02/2674", "1/02/13/02/2675"]);
});

test("a sliver from a touching boundary does not count as shared ground", () => {
  assert.deepEqual(parcelsAtError([{ label: "A", shared: 100 }, { label: "B", shared: 0.0001 }], 100), ["A"]);
});

test("a gap shares ground with no parcel, so the parcels around it are named", () => {
  assert.deepEqual(parcelsAtError([{ label: "B", shared: 0 }, { label: "A", shared: 0 }], 5), ["A", "B"]);
});

test("point errors, and line errors along no parcel, name the parcels they touch, each once", () => {
  assert.deepEqual(parcelsAtError([{ label: "B", shared: 0 }, { label: "A", shared: 0 }, { label: "A", shared: 0 }], 0), ["A", "B"]);
  assert.deepEqual(parcelsAtError([], 0), []);
});

test("a boundary-line error names the parcels along it, not neighbours touching its ends", () => {
  const parcels = parcelsAtError(
    [
      { label: "1/02/13/02/2673", shared: 0 },
      { label: "1/02/13/02/2674", shared: 42.5 },
      { label: "1/02/13/02/2675", shared: 0 },
    ],
    42.5,
  );
  assert.deepEqual(parcels, ["1/02/13/02/2674"]);
});
