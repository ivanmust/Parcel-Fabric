import type { LoggerService } from "@nestjs/common";
import { logger } from "./logger.js";

/** NestJS's own messages (startup, routes) go to the same pino logger as everything else. */
export class NestPinoLogger implements LoggerService {
  log(message: unknown, context?: string) {
    logger.debug({ context }, String(message));
  }
  warn(message: unknown, context?: string) {
    logger.warn({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    logger.error({ context, trace }, String(message));
  }
  debug(message: unknown, context?: string) {
    logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    logger.trace({ context }, String(message));
  }
}
