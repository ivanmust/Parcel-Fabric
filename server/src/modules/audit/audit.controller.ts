import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { CurrentUser, RequirePermissions } from "../../common/auth/auth.decorators.js";
import type { SessionUser } from "../../common/auth/portal-auth.js";
import { ReqInfo, type RequestInfo } from "../../common/http/request-info.js";
import { AuditService } from "./audit.service.js";

class AuditEventDto {
  @ApiProperty({ example: "version.reconcile" })
  action!: string;

  @ApiPropertyOptional()
  target?: string;

  @ApiProperty({ enum: ["success", "failure", "attempt"] })
  outcome!: string;

  @ApiPropertyOptional({ type: Object })
  details?: Record<string, unknown>;
}

class ClientLogDto {
  @ApiProperty({ enum: ["error", "warn"] })
  level!: string;

  @ApiProperty({ maxLength: 2000 })
  message!: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  context?: string;
}

@ApiTags("Audit")
@ApiBearerAuth()
@ApiSecurity("apiKey")
@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Post("audit")
  @ApiOperation({ summary: "Record a GIS operation done in the web app" })
  @ApiBody({ type: AuditEventDto })
  record(@Body() body: unknown, @CurrentUser() user: SessionUser, @ReqInfo() info: RequestInfo) {
    return this.audit.record(body, user, info);
  }

  @Get("audit")
  @RequirePermissions("admin:audit")
  @ApiOperation({ summary: "Search the audit log, newest first" })
  @ApiQuery({ name: "username", required: false })
  @ApiQuery({ name: "action", required: false, description: "Start of the action name, e.g. version." })
  @ApiQuery({ name: "outcome", required: false, enum: ["success", "failure", "attempt"] })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  @ApiQuery({ name: "q", required: false })
  @ApiQuery({ name: "before", required: false, description: "Id of the last event already shown" })
  @ApiQuery({ name: "limit", required: false })
  search(@Query() query: Record<string, unknown>) {
    return this.audit.search(query);
  }

  @Post("client-log")
  @HttpCode(204)
  @ApiOperation({ summary: "Report a web-app error to the server log" })
  @ApiBody({ type: ClientLogDto })
  clientLog(@Body() body: unknown, @CurrentUser() user: SessionUser): void {
    this.audit.clientLog(body, user);
  }
}
