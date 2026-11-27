import { existsSync } from "node:fs";
import { Catch, HttpException, NotFoundException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { logger } from "../logging/logger.js";
import { HttpError } from "./http-error.js";
import { LaisFailure } from "./lais-failure.js";

/** Requests to the LAIS integration API get the LAIS response shape. */
export const isLaisRequest = (request: Request) => /^\/api\/lais(\/|$)/.test(request.originalUrl);

const BODY_ERRORS: Record<string, HttpError> = {
  "entity.parse.failed": new HttpError(400, "Request body is not valid JSON", "invalid_json"),
  "entity.too.large": new HttpError(413, "Request body is too large", "payload_too_large"),
};

function toHttpError(exception: unknown, request: Request): HttpError {
  if (exception instanceof HttpError) return exception;
  const bodyError = BODY_ERRORS[(exception as { type?: string })?.type ?? ""];
  if (bodyError) return bodyError;
  if (exception instanceof NotFoundException) return new HttpError(404, `No route for ${request.method} ${request.path}`, "not_found");
  if (exception instanceof HttpException) return new HttpError(exception.getStatus(), exception.message, "error");
  return new HttpError(500, "An unexpected server error occurred", "internal_error");
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  /** Production: the web app's index.html for client-side routes. */
  constructor(private readonly spaIndex: string | null = null) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof LaisFailure) {
      response.status(exception.status).json({
        success: false,
        case: "No",
        message: exception.message,
        errors: exception.errors,
        ...(exception.data !== undefined ? { data: exception.data } : {}),
        requestId: request.id,
      });
      return;
    }
    if (this.servesWebApp(exception, request)) {
      response.sendFile(this.spaIndex!);
      return;
    }

    const error = toHttpError(exception, request);
    if (error.status >= 500) {
      if (exception instanceof HttpError) logger.warn({ code: error.code, status: error.status, requestId: request.id }, error.message);
      else logger.error({ err: exception, requestId: request.id }, "Unhandled error");
    }
    if (isLaisRequest(request)) {
      response.status(error.status).json({
        success: false,
        case: "No",
        message: error.message,
        errors: [{ field: "request", code: error.code.toUpperCase(), message: error.message }],
        requestId: request.id,
      });
      return;
    }
    response.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details, requestId: request.id } });
  }

  private servesWebApp(exception: unknown, request: Request): boolean {
    return (
      exception instanceof NotFoundException &&
      request.method === "GET" &&
      !request.path.startsWith("/api/") &&
      request.path !== "/api" &&
      !!this.spaIndex &&
      existsSync(this.spaIndex)
    );
  }
}
