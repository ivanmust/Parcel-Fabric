import { pino } from "pino";
import { config } from "../config/env.js";

/**
 * Structured JSON logger. Anything that could carry credentials is redacted
 * at the serializer level so it can never reach log files.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-esri-authorization']",
      "*.token",
      "*.password",
      "token",
      "password",
    ],
    censor: "[REDACTED]",
  },
  transport:
    config.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
});

/** Strip query-string tokens from URLs before logging them. */
export function scrubUrl(url: string): string {
  return url.replace(/([?&](?:token|access_token|password)=)[^&]*/gi, "$1[REDACTED]");
}
