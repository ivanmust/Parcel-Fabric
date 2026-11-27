import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { TransactionListDto, TransactionRecordDto } from "./transaction.dto.js";
import { ApprovalDto, RejectionDto } from "./decision.dto.js";

export class LaisErrorDto {
  @ApiProperty({ example: "UPIs[0]" })
  field!: string;

  @ApiProperty({ example: "UPI_EXPIRED" })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional({ type: [String], description: "UPI_EXPIRED: the current UPIs that replaced it" })
  replacedBy?: string[];

  @ApiPropertyOptional({ description: "UPI_IN_TRANSACTION: the open transaction holding the parcel" })
  transactionId?: string;
}

export class LaisFailureDto {
  @ApiProperty({ example: false })
  success!: boolean;

  @ApiProperty({ example: "No" })
  case!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ type: [LaisErrorDto] })
  errors!: LaisErrorDto[];

  @ApiPropertyOptional({ description: "ALREADY_RECORDED: the transaction as it stands" })
  data?: unknown;

  @ApiProperty()
  requestId!: string;
}

abstract class LaisSuccessDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: "Yes" })
  case!: string;

  @ApiProperty()
  message!: string;
}

export class TransactionResponseDto extends LaisSuccessDto {
  @ApiProperty({ type: TransactionRecordDto })
  data!: TransactionRecordDto;
}

export class TransactionListResponseDto extends LaisSuccessDto {
  @ApiProperty({ type: TransactionListDto })
  data!: TransactionListDto;
}

class ApprovedTransactionDto extends TransactionRecordDto {
  @ApiProperty({ type: ApprovalDto })
  approval!: ApprovalDto;
}

export class ApprovalResponseDto extends LaisSuccessDto {
  @ApiProperty({ type: ApprovedTransactionDto })
  data!: ApprovedTransactionDto;
}

class RejectedTransactionDto {
  @ApiProperty()
  Transaction_ID!: string;

  @ApiProperty({ type: RejectionDto })
  rejection!: RejectionDto;
}

export class RejectionResponseDto extends LaisSuccessDto {
  @ApiProperty({ type: RejectedTransactionDto })
  data!: RejectedTransactionDto;
}

export class ChangesResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty()
  message!: string;

  @ApiProperty({ description: "summary per layer, plots inserted/updated/deleted, records, checks and warnings" })
  data!: Record<string, unknown>;
}
