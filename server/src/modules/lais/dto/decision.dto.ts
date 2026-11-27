import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class ApproveTransactionDto {
  @ApiProperty({ format: "uuid", description: "The editing-done notification being approved" })
  event_id!: string;

  @ApiProperty({ maxLength: 100 })
  approved_by!: string;

  @ApiPropertyOptional({ description: "Cell for the new UPIs when GIS can't tell", example: "1/02/13/02" })
  cell?: string;
}

export class RejectTransactionDto {
  @ApiProperty({ format: "uuid" })
  event_id!: string;

  @ApiProperty({ maxLength: 100 })
  rejected_by!: string;

  @ApiProperty({ maxLength: 1000 })
  reason!: string;
}

export class AssignedUpiDto {
  @ApiProperty({ description: "The parcel's Plot global id from the notification" })
  parcel_ref!: string;

  @ApiProperty({ example: "1/02/13/02/3875" })
  UPI!: string;
}

export class ApprovalDto {
  @ApiProperty()
  event_id!: string;

  @ApiProperty({ enum: ["approving", "approved"] })
  status!: string;

  @ApiProperty()
  approved_by!: string;

  @ApiProperty({ type: String, nullable: true })
  approved_at!: string | null;

  @ApiProperty({ type: String, nullable: true })
  cell!: string | null;

  @ApiProperty({ type: [AssignedUpiDto] })
  upis!: AssignedUpiDto[];
}

export class RejectionDto {
  @ApiProperty()
  event_id!: string;

  @ApiProperty()
  rejected_by!: string;

  @ApiProperty()
  rejected_at!: string;

  @ApiProperty()
  reason!: string;
}
