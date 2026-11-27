import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { logger } from "../logging/logger.js";
import { HttpError } from "../errors/http-error.js";
import { API_KEY_HEADER, matchApiKey } from "./api-key.js";
import { API_CLIENT_USER, bearerToken, validatePortalToken, type SessionUser } from "./portal-auth.js";
import { AUTH_POLICY, type AuthPolicy } from "./auth.decorators.js";
import type { Permission } from "./roles.js";

const SIGNED_IN: AuthPolicy = { kind: "signed-in", permissions: [] };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<AuthPolicy>(AUTH_POLICY, [context.getHandler(), context.getClass()]) ?? SIGNED_IN;
    if (policy.kind === "public") return true;

    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = request.header(API_KEY_HEADER);
    if (policy.kind === "api-key-only" || apiKey !== undefined) {
      request.user = this.apiClient(request, apiKey);
      return true;
    }
    request.user = await this.portalUser(request);
    this.requirePermissions(request.user, policy.permissions);
    return true;
  }

  private apiClient(request: Request, apiKey: string | undefined): SessionUser {
    const match = matchApiKey(apiKey);
    if (!match) throw new HttpError(401, "Valid LAIS API credentials are required", "unauthorized");
    if (match === "previous") logger.warn({ requestId: request.id }, "Authenticated with the previous API key; finish the key change");
    return API_CLIENT_USER;
  }

  private async portalUser(request: Request): Promise<SessionUser> {
    const token = bearerToken(request);
    if (!token) throw new HttpError(401, "Authentication required", "auth_required");
    const origin = (request.headers["x-client-origin"] as string | undefined) ?? request.headers.origin;
    const user = await validatePortalToken(token, origin);
    request.portalToken = token;
    return user;
  }

  private requirePermissions(user: SessionUser, needed: Permission[]): void {
    const granted = new Set(user.permissions);
    if (!needed.every((p) => granted.has(p))) {
      throw new HttpError(403, "You do not have permission to perform this action", "forbidden", { needed });
    }
  }
}
