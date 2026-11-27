import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { Permission } from "./roles.js";
import type { SessionUser } from "./portal-auth.js";

export const AUTH_POLICY = "auth:policy";

/**
 * public:       no credentials
 * api-key-only: the API key; a Portal token is never accepted (server-to-server LAIS API)
 * signed-in:    the API key, or a Portal user with the permissions (the default)
 */
export type AuthPolicy = { kind: "public" } | { kind: "api-key-only" } | { kind: "signed-in"; permissions: Permission[] };

export const Public = () => SetMetadata(AUTH_POLICY, { kind: "public" } satisfies AuthPolicy);
export const ApiKeyOnly = () => SetMetadata(AUTH_POLICY, { kind: "api-key-only" } satisfies AuthPolicy);
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(AUTH_POLICY, { kind: "signed-in", permissions } satisfies AuthPolicy);

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): SessionUser => {
  return context.switchToHttp().getRequest<Request>().user!;
});
