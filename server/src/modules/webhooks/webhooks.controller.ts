import { Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { CurrentUser, RequirePermissions } from "../../common/auth/auth.decorators.js";
import type { SessionUser } from "../../common/auth/portal-auth.js";
import { ReqInfo, type RequestInfo } from "../../common/http/request-info.js";
import { WebhooksService } from "./webhooks.service.js";

/** The subdivision completion webhook (App B), for administrators. Payloads are shown; signing keys never. */
@ApiTags("Webhooks")
@ApiBearerAuth()
@ApiSecurity("apiKey")
@RequirePermissions("admin:audit")
@Controller("webhooks/subdivision")
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get("events")
  @ApiOperation({ summary: "Events in the outbox, newest first" })
  @ApiQuery({ name: "status", required: false, enum: ["pending", "delivering", "delivered", "dead"] })
  events(@Query() query: Record<string, unknown>) {
    return this.webhooks.events(query);
  }

  @Get("waiting")
  @ApiOperation({ summary: "Posted subdivisions waiting for complete data" })
  waiting() {
    return this.webhooks.waiting();
  }

  @Post("events/:eventId/replay")
  @HttpCode(200)
  @ApiOperation({ summary: "Send a dead-lettered event again" })
  replay(@Param("eventId") eventId: string, @CurrentUser() user: SessionUser, @ReqInfo() info: RequestInfo) {
    return this.webhooks.replay(eventId, user, info);
  }
}
