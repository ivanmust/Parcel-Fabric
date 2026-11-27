import { ApiProperty } from "@nestjs/swagger";

export class NotificationParcelDto {
  @ApiProperty({ type: String, nullable: true, example: "1/02/13/02/2679" })
  UPI!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 1089.91 })
  area_sqm!: number | null;

  @ApiProperty({ type: String, nullable: true, example: "Kigali City" })
  province!: string | null;

  @ApiProperty({ type: String, nullable: true, example: "Gasabo" })
  district!: string | null;

  @ApiProperty({ type: String, nullable: true, example: "Remera" })
  sector!: string | null;

  @ApiProperty({ type: String, nullable: true, example: "Nyarutarama" })
  cell!: string | null;

  @ApiProperty({ type: String, nullable: true, example: "Kamahwa" })
  village!: string | null;
}

export class ProposedParcelDto extends NotificationParcelDto {
  @ApiProperty({ description: "The Plot's global id; the approval answers each parcel's UPI by it", example: "{6F1E2A90-3C4B-4D5E-8F70-1A2B3C4D5E6F}" })
  parcel_ref!: string;

  @ApiProperty({ type: Object, nullable: true, description: "GeoJSON Polygon or MultiPolygon, EPSG:4326" })
  geometry!: Record<string, unknown> | null;
}

class TotalsDto {
  @ApiProperty({ example: 1089.91 })
  parent_area_sqm!: number;

  @ApiProperty({ example: 1089.91 })
  proposed_area_sqm!: number;
}

/** The editing.completed notification as LAIS receives it, plus the warnings for the editor. */
export class NotificationPreviewDto {
  @ApiProperty({ type: String, nullable: true, format: "uuid", description: "null until the work is sent" })
  event_id!: string | null;

  @ApiProperty({ example: "editing.completed" })
  event_type!: string;

  @ApiProperty({ type: String, nullable: true, format: "date-time", description: "null until the work is sent" })
  sent_at!: string | null;

  @ApiProperty({ example: "LAIS-SUB-2026-00125" })
  Transaction_ID!: string;

  @ApiProperty({ example: "Subdivision" })
  Transaction_Type!: string;

  @ApiProperty({ example: "qt_testing.SUBV-LAIS-SUB-2026-00125-20261124" })
  version_name!: string;

  @ApiProperty({ example: "SUBV-LAIS-SUB-2026-00125-20261124" })
  record_name!: string;

  @ApiProperty({ description: "The signed-in editor; empty with the API key", example: "gis.editor1" })
  edited_by!: string;

  @ApiProperty({ type: [NotificationParcelDto] })
  parent_parcels!: NotificationParcelDto[];

  @ApiProperty({ type: [ProposedParcelDto] })
  proposed_parcels!: ProposedParcelDto[];

  @ApiProperty({ type: TotalsDto })
  totals!: TotalsDto;

  @ApiProperty({ type: [String], description: "Worth checking before sending; not part of what LAIS receives" })
  warnings!: string[];
}
