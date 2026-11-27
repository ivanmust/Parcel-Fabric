import { applyDecorators, Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiCreatedResponse, ApiOperation, ApiQuery, ApiResponse, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiKeyOnly } from "../../../common/auth/auth.decorators.js";
import { ReqInfo, type RequestInfo } from "../../../common/http/request-info.js";
import { STAGES } from "../models/transaction.model.js";
import { SubmitTransactionDto } from "../dto/transaction.dto.js";
import { ApproveTransactionDto, RejectTransactionDto } from "../dto/decision.dto.js";
import { ApprovalResponseDto, ChangesResponseDto, LaisFailureDto, RejectionResponseDto, TransactionListResponseDto, TransactionResponseDto } from "../dto/lais-response.dto.js";
import { LaisTransactionsService } from "../services/lais-transactions.service.js";

const SubmissionFailures = () =>
  applyDecorators(
    ApiResponse({ status: 401, description: "Missing or wrong X-API-Key", type: LaisFailureDto }),
    ApiResponse({ status: 422, description: "Validation failed; errors[] name each field", type: LaisFailureDto }),
    ApiResponse({ status: 502, description: "GIS unavailable: retry with the same payload", type: LaisFailureDto }),
  );

/** The LAIS server-to-server API. Responses: { success, case: "Yes" | "No", message, data | errors }. */
@ApiTags("LAIS transactions")
@ApiSecurity("apiKey")
@ApiKeyOnly()
@Controller("lais/transactions")
export class LaisTransactionsController {
  constructor(private readonly transactions: LaisTransactionsService) {}

  @Post()
  @ApiOperation({ summary: "Submit a transaction", description: "Validates it, creates its public GIS version and writes the transaction fields on its Plots inside the version." })
  @ApiBody({ type: SubmitTransactionDto })
  @ApiCreatedResponse({ type: TransactionResponseDto })
  @ApiResponse({ status: 409, description: "ALREADY_RECORDED (data = the transaction), DUPLICATE_TRANSACTION_ID or UPI_IN_TRANSACTION", type: LaisFailureDto })
  @SubmissionFailures()
  submit(@Body() body: unknown, @ReqInfo() info: RequestInfo) {
    return this.transactions.submit(body, info);
  }

  @Get()
  @ApiOperation({ summary: "List transactions, oldest change first", description: "Poll with updatedSince = the previous next_updated_since." })
  @ApiQuery({ name: "updatedSince", required: false, description: "ISO 8601 with a timezone" })
  @ApiQuery({ name: "stage", required: false, enum: STAGES })
  @ApiQuery({ name: "limit", required: false, description: "1–200, default 100" })
  @ApiOkResponse({ type: TransactionListResponseDto })
  list(@Query() query: Record<string, unknown>) {
    return this.transactions.list(query);
  }

  @Get(":transactionId")
  @ApiOperation({ summary: "A transaction's stage, result parcels and warnings" })
  @ApiOkResponse({ type: TransactionResponseDto })
  @ApiResponse({ status: 404, type: LaisFailureDto })
  findOne(@Param("transactionId") transactionId: string) {
    return this.transactions.findOne(transactionId);
  }

  @Get(":transactionId/changes")
  @ApiOperation({ summary: "What the transaction's version changed compared with sde.DEFAULT" })
  @ApiQuery({ name: "geometry", required: false, type: Boolean, description: "Include GeoJSON (EPSG:4326)" })
  @ApiOkResponse({ type: ChangesResponseDto })
  changes(@Param("transactionId") transactionId: string, @Query("geometry") geometry?: string) {
    return this.transactions.changes(transactionId, String(geometry ?? "false").toLowerCase() === "true");
  }

  @Post(":transactionId/approve")
  @HttpCode(200)
  @ApiOperation({ summary: "Registrar approved: GIS assigns UPIs, posts the version and answers the UPIs by parcel_ref", description: "Safe to repeat after a failure; it reuses the same UPIs." })
  @ApiBody({ type: ApproveTransactionDto })
  @ApiOkResponse({ type: ApprovalResponseDto })
  @ApiResponse({ status: 409, description: "FLOW_NOT_ENABLED, NOT_SUBMITTED, EVENT_MISMATCH, ALREADY_APPROVED, CELL_REQUIRED, RECONCILE_CONFLICT, VERSION_IN_USE, …", type: LaisFailureDto })
  approve(@Param("transactionId") transactionId: string, @Body() body: unknown, @ReqInfo() info: RequestInfo) {
    return this.transactions.approve(transactionId, body, info);
  }

  @Post(":transactionId/reject")
  @HttpCode(200)
  @ApiOperation({ summary: "Registrar rejected: recorded; the GIS editor revises and sends the work again" })
  @ApiBody({ type: RejectTransactionDto })
  @ApiOkResponse({ type: RejectionResponseDto })
  reject(@Param("transactionId") transactionId: string, @Body() body: unknown, @ReqInfo() info: RequestInfo) {
    return this.transactions.reject(transactionId, body, info);
  }
}
