import type { NextFunction, Request, Response } from "express";
import { logger } from "../logging/logger.js";
import { HttpError } from "../utils/httpError.js";

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, `No route for ${req.method} ${req.path}`, "not_found"));
}

// Express recognises error handlers by arity, so all four parameters must stay.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const isHttp = err instanceof HttpError;
  const isBodyParse = !isHttp && (err as { type?: string })?.type === "entity.parse.failed";
  const status = isHttp ? err.status : isBodyParse ? 400 : 500;
  if (status >= 500) logger.error({ err, requestId: req.id }, "Unhandled error");
  res.status(status).json({
    error: {
      code: isHttp ? err.code : isBodyParse ? "invalid_json" : "internal_error",
      message: isHttp ? err.message : isBodyParse ? "Request body is not valid JSON" : "An unexpected server error occurred",
      details: isHttp ? err.details : undefined,
      requestId: req.id,
    },
  });
}
