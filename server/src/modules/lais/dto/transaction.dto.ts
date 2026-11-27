import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { STAGES, TRANSACTION_STATUSES, TRANSACTION_TYPES } from "../models/transaction.model.js";

export class SubmitTransactionDto {
  @ApiPropertyOptional({ description: "One parcel. Send UPI or UPIs, not both.", example: "1/02/13/02/1001" })
  UPI?: string;

  @ApiPropertyOptional({
    type: [String],
    description: "The parcels: Merge 2+ neighbours, Subdivision exactly 1, CorrectBoundaries 1+, CreatePlot 0+ (at most 20).",
    example: ["1/02/13/02/1001"],
  })
  UPIs?: string[];

  @ApiProperty({ description: "LAIS case number; letters, digits and . _ - : /", example: "LAIS-SUB-2026-00125" })
  Transaction_ID!: string;

  @ApiProperty({ enum: TRANSACTION_TYPES, example: "Subdivision" })
  Transaction_Type!: string;

  @ApiProperty({ description: "ISO 8601 with a timezone", example: "2026-11-24T08:30:00+02:00" })
  Transaction_Date!: string;

  @ApiPropertyOptional({ enum: TRANSACTION_STATUSES })
  Transaction_Status?: string;
}

export class TransactionWarningDto {
  @ApiProperty({ enum: ["UPI_MISSING", "NO_RESULT_PARCELS"] })
  code!: string;

  @ApiProperty()
  message!: string;
}

export class ResultParcelDto {
  @ApiProperty({ type: String, nullable: true, description: "null until GIS assigns a UPI" })
  UPI!: string | null;

  @ApiProperty({ description: "false if GIS has retired this parcel since" })
  current!: boolean;

  @ApiProperty({ type: Number, nullable: true })
  area_sqm!: number | null;

  @ApiProperty({ type: String, nullable: true })
  province!: string | null;

  @ApiProperty({ type: String, nullable: true })
  district!: string | null;

  @ApiProperty({ type: String, nullable: true })
  sector!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cell!: string | null;

  @ApiProperty({ type: String, nullable: true })
  village!: string | null;
}

export class TransactionResultDto {
  @ApiProperty({ type: [ResultParcelDto] })
  parcels!: ResultParcelDto[];

  @ApiProperty({ example: [{ UPI: "1/02/13/02/1001" }] })
  retired_parcels!: Array<{ UPI: string | null }>;

  @ApiProperty({ example: [{ name: "SUBV-LAIS-SUB-2026-00125-20261124", recorded_date: "2026-11-24T10:00:00.000Z" }] })
  records!: Array<{ name: string | null; recorded_date: string | null }>;

  @ApiProperty({ type: String, nullable: true })
  completed_at!: string | null;

  @ApiProperty()
  detected_at!: string;
}

export class TransactionRecordDto {
  @ApiProperty({ type: String, nullable: true })
  UPI!: string | null;

  @ApiProperty({ type: [String] })
  UPIs!: string[];

  @ApiProperty({ type: String, nullable: true })
  Transaction_ID!: string | null;

  @ApiProperty({ type: String, nullable: true })
  Transaction_Type!: string | null;

  @ApiProperty({ type: String, nullable: true })
  Transaction_Status!: string | null;

  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  Transaction_Date!: string | null;

  @ApiProperty({ type: String, nullable: true, example: "Yes" })
  case!: string | null;

  @ApiProperty({ type: String, nullable: true })
  validation_message!: string | null;

  @ApiProperty({ type: String, nullable: true, example: "svc_lais.SUBV-LAIS-SUB-2026-00125-20261124" })
  version_name!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: ["Pending", "VersionCreated"] })
  version_status!: string | null;

  @ApiProperty({ enum: STAGES, description: "InReview: not in sde.DEFAULT yet · Posted: in sde.DEFAULT · Closed: version removed unposted" })
  stage!: string;

  @ApiProperty({ type: TransactionResultDto, nullable: true })
  result!: TransactionResultDto | null;

  @ApiProperty({ type: [TransactionWarningDto] })
  warnings!: TransactionWarningDto[];

  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  updated_at!: string | null;
}

export class TransactionListDto {
  @ApiProperty({ type: [TransactionRecordDto] })
  transactions!: TransactionRecordDto[];

  @ApiProperty()
  has_more!: boolean;

  @ApiProperty({ description: "Pass as updatedSince on the next call" })
  next_updated_since!: string;
}
