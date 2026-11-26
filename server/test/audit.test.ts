/**
 * Audit trail reading (GET /api/audit → readAudit): filters, newest-first order and paging.
 */
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const auditDir = mkdtempSync(path.join(tmpdir(), "audit-read-"));
process.env.AUDIT_DIR = auditDir;

type Read = typeof import("../src/audit/auditLog.js").readAudit;
let readAudit: Read;

const event = (id: string, time: string, username: string, action: string, outcome = "success", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, time, username, appRole: "GIS_EDITOR", action, outcome, ...extra });

before(async () => {
  // Two monthly files, oldest line first (as the server appends them), and one corrupt line.
  writeFileSync(
    path.join(auditDir, "audit-2026-10.jsonl"),
    [event("o1", "2026-10-30T08:00:00.000Z", "gisa@esri_rw", "auth.sign-in"), event("o2", "2026-10-31T09:00:00.000Z", "LAIS", "lais.transaction.submit", "failure", { details: { errors: ["UPI_IN_TRANSACTION"] } })].join("\n") + "\n",
  );
  writeFileSync(
    path.join(auditDir, "audit-2026-11.jsonl"),
    [
      event("n1", "2026-11-25T07:00:00.000Z", "gisa@esri_rw", "version.create", "success", { target: "gisa@esri_rw.SUBV-000010-20261125" }),
      "{not json",
      event("n2", "2026-11-25T08:00:00.000Z", "Editor.Two", "parcel-fabric.divide-parcel", "success", { details: { record: "SUBV-000010-20261125", parcel: "1/02/13/02/2679" } }),
      event("n3", "2026-11-26T09:00:00.000Z", "gisa@esri_rw", "version.reconcile-post", "failure", { target: "gisa@esri_rw.SUBV-000010-20261125" }),
      event("n4", "2026-11-26T10:00:00.000Z", "editor.two", "edit-session.save"),
    ].join("\n") + "\n",
  );
  readAudit = (await import("../src/audit/auditLog.js")).readAudit;
});

const ids = (page: { events: Array<{ id: string }> }) => page.events.map((e) => e.id);

describe("readAudit", () => {
  test("newest first across months; corrupt lines skipped", async () => {
    const page = await readAudit({ limit: 100 });
    assert.deepEqual(ids(page), ["n4", "n3", "n2", "n1", "o2", "o1"]);
    assert.equal(page.hasMore, false);
  });

  test("user: part of the name, any case", async () => {
    assert.deepEqual(ids(await readAudit({ username: "EDITOR.two", limit: 100 })), ["n4", "n2"]);
  });

  test("activity group by action prefix, and result", async () => {
    assert.deepEqual(ids(await readAudit({ action: "version.", limit: 100 })), ["n3", "n1"]);
    assert.deepEqual(ids(await readAudit({ outcome: "failure", limit: 100 })), ["n3", "o2"]);
  });

  test("search finds text in target and details", async () => {
    assert.deepEqual(ids(await readAudit({ q: "subv-000010", limit: 100 })), ["n3", "n2", "n1"]);
    assert.deepEqual(ids(await readAudit({ q: "2679", limit: 100 })), ["n2"]);
    assert.deepEqual(ids(await readAudit({ q: "upi_in_transaction", limit: 100 })), ["o2"]);
  });

  test("date range: from inclusive, to exclusive", async () => {
    assert.deepEqual(ids(await readAudit({ from: "2026-11-25T00:00:00Z", to: "2026-11-26T00:00:00Z", limit: 100 })), ["n2", "n1"]);
    assert.deepEqual(ids(await readAudit({ to: "2026-11-01T00:00:00+02:00", limit: 100 })), ["o2", "o1"]);
    assert.deepEqual(ids(await readAudit({ from: "2026-11-26T09:00:00Z", limit: 100 })), ["n4", "n3"]);
  });

  test("paging: hasMore, then the next page starts after the last id shown", async () => {
    let page = await readAudit({ limit: 2 });
    assert.deepEqual(ids(page), ["n4", "n3"]);
    assert.equal(page.hasMore, true);
    page = await readAudit({ limit: 2, before: "n3" });
    assert.deepEqual(ids(page), ["n2", "n1"]);
    assert.equal(page.hasMore, true);
    page = await readAudit({ limit: 2, before: "n1" });
    assert.deepEqual(ids(page), ["o2", "o1"]);
    assert.equal(page.hasMore, false);
  });

  test("paging keeps the filters", async () => {
    const page = await readAudit({ username: "gisa", limit: 1, before: "n3" });
    assert.deepEqual(ids(page), ["n1"]);
    assert.equal(page.hasMore, true);
  });
});
