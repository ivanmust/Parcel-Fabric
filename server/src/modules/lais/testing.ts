import { clearLocksForTests } from "../../common/utils/lock.js";
import { clearLedgerForTests } from "./repositories/ledger.repository.js";
import { clearSchemaCacheForTests } from "./repositories/plot-layer.repository.js";

export { versionNameFor } from "./domain/version-naming.js";

export async function resetLaisCachesForTests(): Promise<void> {
  clearSchemaCacheForTests();
  clearLocksForTests();
  await clearLedgerForTests();
}
