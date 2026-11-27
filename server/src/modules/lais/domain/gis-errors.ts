import { ArcGisError } from "../../../common/arcgis/arcgis-client.js";

/** The GIS service or the integration account is not set up the way this API needs. */
export class LaisConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaisConfigurationError";
  }
}

const PERMANENT_REFUSAL = /user type extension|not been assigned|not licensed|license|permission|not authorized|insufficient privilege|does not have (the )?(required )?privilege/i;
const PROTECTED_VERSION = /only be executed by the owner|version is protected/i;

/** ArcGIS refusals that a retry can never fix are configuration problems (503), not outages (502). */
export function asConfigurationError(error: unknown): unknown {
  if (!(error instanceof ArcGisError)) return error;
  if (PROTECTED_VERSION.test(error.message)) {
    return new LaisConfigurationError(
      `The LAIS ArcGIS account cannot post to the protected default version: give it the Portal "Manage versions" privilege (version administrator). ArcGIS: ${error.message}`,
    );
  }
  if (error.code === 403 || PERMANENT_REFUSAL.test(error.message)) {
    return new LaisConfigurationError(`The LAIS ArcGIS account cannot edit: ${error.message}`);
  }
  return error;
}

/** ArcGIS refuses to read or post a version an editor holds open. */
export const isVersionInUse = (error: unknown) => error instanceof ArcGisError && /lock|in use|being edited|another (user|session)/i.test(error.message) && !/extension|licen/i.test(error.message);
