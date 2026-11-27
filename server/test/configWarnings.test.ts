import { test } from "node:test";
import assert from "node:assert/strict";
import { configWarnings } from "../src/config/configWarnings.js";

const base = {
  NODE_ENV: "production" as const,
  APP_ORIGINS: ["https://esrirw.rw"],
  LAIS_ARCGIS_REFERER: "https://esrirw.rw",
  LAIS_EDITING_DONE: "true" as const,
  LAIS_WEBHOOK_URL: "https://lais.example.rw/gis/editing-done",
  LAIS_WEBHOOK_KEY: "k".repeat(64),
};

test("a correct production setup has no warnings", () => {
  assert.deepEqual(configWarnings(base), []);
});

test("only local APP_ORIGINS / referer in production are flagged", () => {
  const w = configWarnings({ ...base, APP_ORIGINS: ["http://localhost:5174", "http://127.0.0.1:5174"], LAIS_ARCGIS_REFERER: "http://localhost:5174" });
  assert.equal(w.length, 2);
  assert.match(w[0]!, /APP_ORIGINS has only local addresses/);
  assert.match(w[1]!, /LAIS_ARCGIS_REFERER is a local address/);
  assert.deepEqual(configWarnings({ ...base, NODE_ENV: "development", APP_ORIGINS: ["http://localhost:5174"], LAIS_ARCGIS_REFERER: "http://localhost:5174" }), []);
});

test("a plain-http private LAIS endpoint is flagged twice; a missing one once", () => {
  const w = configWarnings({ ...base, LAIS_WEBHOOK_URL: "http://192.168.160.188:8000/api/gis/editing-done" });
  assert.equal(w.length, 2);
  assert.match(w[0]!, /plain http/);
  assert.match(w[1]!, /private network address \(192\.168\.160\.188\)/);
  assert.match(configWarnings({ ...base, LAIS_WEBHOOK_URL: "" })[0]!, /cannot reach LAIS/);
  assert.deepEqual(configWarnings({ ...base, LAIS_EDITING_DONE: "false", LAIS_WEBHOOK_URL: "" }), []);
});
