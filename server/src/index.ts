import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { startEditingDoneRetries } from "./lais/editingDone.js";

const server = createApp().listen(config.PORT, () => {
  logger.info({ port: config.PORT, portal: config.PORTAL_URL, env: config.NODE_ENV }, "Parcel Fabric API listening");
});
// GIS → LAIS "editing done" notifications not yet received by LAIS (only while LAIS_EDITING_DONE=true).
startEditingDoneRetries();

function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => logger.error({ reason }, "Unhandled promise rejection"));
