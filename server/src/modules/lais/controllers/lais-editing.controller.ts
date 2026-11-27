import { Controller, Get, Param, Post, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiResponse, ApiSecurity, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { CurrentUser, RequirePermissions } from "../../../common/auth/auth.decorators.js";
import type { SessionUser } from "../../../common/auth/portal-auth.js";
import { ReqInfo, type RequestInfo } from "../../../common/http/request-info.js";
import { NotificationPreviewDto } from "../dto/editing-done.dto.js";
import { LaisEditingService } from "../services/lais-editing.service.js";

/** "Editing done" for GIS editors: the web app's side of the GIS → LAIS notification. */
@ApiTags("LAIS editing")
@ApiBearerAuth()
@ApiSecurity("apiKey")
@RequirePermissions("features:edit")
@Controller("lais-editing/transactions")
export class LaisEditingController {
  constructor(private readonly editing: LaisEditingService) {}

  @Get()
  @ApiOperation({ summary: "LAIS transactions with a version, and where each notification stands" })
  list() {
    return this.editing.list();
  }

  @Get(":transactionId/changes")
  @ApiOperation({ summary: "What the version changed compared with sde.DEFAULT, for review before Editing done" })
  @ApiQuery({ name: "geometry", required: false, type: Boolean })
  changes(@Param("transactionId") transactionId: string, @Query("geometry") geometry?: string) {
    return this.editing.changes(transactionId, String(geometry ?? "false").toLowerCase() === "true");
  }

  @Get(":transactionId/preview")
  @ApiOperation({ summary: "The editing.completed notification for this transaction (sends nothing)" })
  @ApiOkResponse({ type: NotificationPreviewDto, description: "The notification as LAIS receives it; event_id and sent_at stay null until it is sent" })
  @ApiResponse({ status: 422, description: "not_ready: the work is not finished; error.details.problems says what to fix" })
  preview(@Param("transactionId") transactionId: string, @CurrentUser() user: SessionUser) {
    return this.editing.preview(transactionId, user);
  }

  @Post(":transactionId/editing-done")
  @ApiOperation({
    summary: "Send the finished work to LAIS for the registrar's approval",
    description: "Only the transactionId: the work must use the Parcel Fabric record named after the version. Sends the editing.completed notification (the preview's format) to LAIS_WEBHOOK_URL with LAIS_WEBHOOK_METHOD (PUT) and X-API-Key = LAIS_WEBHOOK_KEY. 200 when LAIS received it, 202 while it is being retried.",
  })
  async editingDone(
    @Param("transactionId") transactionId: string,
    @CurrentUser() user: SessionUser,
    @ReqInfo() info: RequestInfo,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.editing.editingDone(transactionId, user, info);
    response.status(result.status);
    return result.body;
  }
}
