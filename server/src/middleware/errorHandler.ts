import type { NextFunction, Request, Response } from "express";
import { logger } from "../logging/logger.js";
import { HttpError } from "../utils/httpError.js";

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, `No route for ${req.method} ${req.path}`, "not_found"));
}

/** Requests to the LAIS integration API get the LAIS response shape (see routes/lais.ts). */
export const isLaisRequest = (req: Request) => /^\/api\/lais(\/|$)/.test(req.originalUrl);

// Express recognises error handlers by arity, so all four parameters must stay.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const isHttp = err instanceof HttpError;
  const bodyType = !isHttp ? (err as { type?: string })?.type : undefined;
  const isBodyParse = bodyType === "entity.parse.failed";
  const isTooLarge = bodyType === "entity.too.large";
  const status = isHttp ? err.status : isBodyParse ? 400 : isTooLarge ? 413 : 500;
  const code = isHttp ? err.code : isBodyParse ? "invalid_json" : isTooLarge ? "payload_too_large" : "internal_error";
  const message = isHttp
    ? err.message
    : isBodyParse
      ? "Request body is not valid JSON"
      : isTooLarge
        ? "Request body is too large"
        : "An unexpected server error occurred";

  if (status >= 500) {
    if (isHttp) logger.warn({ code, status, requestId: req.id }, message);
    else logger.error({ err, requestId: req.id }, "Unhandled error");
  }

  if (isLaisRequest(req)) {
    res.status(status).json({
      success: false,
      case: "No",
      message,
      errors: [{ field: "request", code: code.toUpperCase(), message }],
      requestId: req.id,
    });
    return;
  }
  res.status(status).json({
    error: { code, message, details: isHttp ? err.details : undefined, requestId: req.id },
  });
}
