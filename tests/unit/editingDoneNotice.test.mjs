// What the editor is told after Save sends "Editing done" (no server): npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterSaveNotice } from "../../src/services/lais/editingDoneNotice.ts";

const view = (status, last_result = "HTTP 200") => ({ status, last_result });

test("not a LAIS transaction's version: nothing is said", () => {
  assert.equal(afterSaveNotice({ kind: "skipped" }), null);
});

test("delivered: the editor is told LAIS has the work", () => {
  const n = afterSaveNotice({ kind: "sent", transactionId: "LAIS-SUB-1", view: view("delivered"), warnings: [] });
  assert.equal(n.kind, "success");
  assert.equal(n.title, "Sent to LAIS");
  assert.match(n.message, /LAIS-SUB-1/);
});

test("LAIS not reached: a warning that GIS keeps retrying", () => {
  const n = afterSaveNotice({ kind: "sent", transactionId: "LAIS-SUB-1", view: view("retrying", "HTTP 503"), warnings: [] });
  assert.equal(n.kind, "warning");
  assert.match(n.message, /HTTP 503/);
});

test("unfinished work: information with the first problem, not an error", () => {
  const n = afterSaveNotice({ kind: "refused", transactionId: "LAIS-SUB-1", code: "not_ready", message: "all problems", problems: ["The version has no new parcels yet."] });
  assert.equal(n.kind, "info");
  assert.equal(n.title, "Saved · not sent to LAIS yet");
  assert.equal(n.message, "The version has no new parcels yet.");
});

test("work LAIS already has: information", () => {
  const n = afterSaveNotice({ kind: "refused", transactionId: "LAIS-SUB-1", code: "already_sent", message: "LAIS already received this work", problems: [] });
  assert.equal(n.kind, "info");
  assert.match(n.title, /already has/);
});

test("approved, posted or no version: nothing to send, nothing said", () => {
  for (const code of ["already_approved", "already_posted", "version_gone"]) {
    assert.equal(afterSaveNotice({ kind: "refused", transactionId: "X", code, message: "", problems: [] }), null, code);
  }
});

test("server or network failure: a warning that the save worked but Editing done did not", () => {
  const n = afterSaveNotice({ kind: "failed", transactionId: "LAIS-SUB-1", message: "GIS could not be read" });
  assert.equal(n.kind, "warning");
  assert.match(n.title, /Saved, but Editing done failed/);
});
