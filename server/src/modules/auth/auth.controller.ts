import { Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { writeAudit } from "../../common/audit/audit-log.js";
import { CurrentUser, Public } from "../../common/auth/auth.decorators.js";
import { bearerToken, forgetToken, type SessionUser } from "../../common/auth/portal-auth.js";
import { ReqInfo, type RequestInfo } from "../../common/http/request-info.js";

@ApiTags("Session")
@ApiBearerAuth()
@Controller("auth")
export class AuthController {
  @Get("session")
  @ApiOperation({ summary: "The signed-in user with application role and permissions" })
  session(@CurrentUser() user: SessionUser) {
    return { user };
  }

  @Post("signed-in")
  @HttpCode(204)
  @ApiOperation({ summary: "Record a sign-in in the audit log" })
  async signedIn(@CurrentUser() user: SessionUser, @ReqInfo() info: RequestInfo): Promise<void> {
    await writeAudit({ username: user.username, appRole: user.appRole, action: "auth.sign-in", outcome: "success", ip: info.ip, requestId: info.requestId });
  }

  @Post("signed-out")
  @Public()
  @HttpCode(204)
  @ApiOperation({ summary: "Forget a token on sign-out (optional token; always 204)" })
  signedOut(@Req() request: Request): void {
    const token = bearerToken(request);
    if (token) forgetToken(token);
  }
}
