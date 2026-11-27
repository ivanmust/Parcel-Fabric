import type { VersionInfo } from "@arcgis/core/versionManagement/support/jsonTypes.js";

/**
 * LAIS transaction versions: one PUBLIC version per transaction, named {TYPE}-{CASE_NUMBER}-{DATE}
 * (e.g. SUBV-CASE123-20261125), with a description starting "LAIS ". Keep the type codes in sync
 * with TYPE_CODES in server/src/modules/lais/domain/version-naming.ts.
 */
const LAIS_NAME = /(^|\.)((SUBV|MERG|CORB|CRPL)-.+-\d{8}|LAIS_.+)$/i;

export const isLaisVersionName = (name: string | null | undefined) => !!name && LAIS_NAME.test(name);

export const isLaisVersion = (v: VersionInfo) => isLaisVersionName(v.versionIdentifier.name) || /^LAIS /.test(v.description ?? "");
