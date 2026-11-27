import { config } from "./config/env.js";
import { configWarnings } from "./config/config-warnings.js";
import { logger } from "./common/logging/logger.js";
import { startEditingDoneRetries } from "./modules/lais/domain/editing-done.js";
import { startSubdivisionWebhook } from "./modules/webhooks/domain/worker.js";
import { createApp } from "./app.factory.js";

const app = await createApp();
await app.listen(config.PORT);
logger.info({ port: config.PORT, portal: config.PORTAL_URL, env: config.NODE_ENV }, "Parcel Fabric API listening");
for (const warning of configWarnings(config)) logger.warn(warning);

// Background work; each does nothing while its feature is switched off.
const stopEditingDone = startEditingDoneRetries();
const stopWebhook = startSubdivisionWebhook();

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  setTimeout(() => process.exit(1), 5000).unref();
  stopEditingDone?.();
  await stopWebhook?.();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => logger.error({ reason }, "Unhandled promise rejection"));
