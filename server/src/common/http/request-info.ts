import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/** What the audit log records about a request. */
export interface RequestInfo {
  ip?: string;
  requestId: string;
}

export const ReqInfo = createParamDecorator((_data: unknown, context: ExecutionContext): RequestInfo => {
  const request = context.switchToHttp().getRequest<Request>();
  return { ip: request.ip, requestId: String(request.id) };
});
