import { useCallback, useState } from "react";
import { describeArcGISError } from "../services/arcgis/serviceMetadata";

/**
 * State for a component's async actions: the label of the one running and the last error, as a
 * user-facing message. `run` resolves to that error message, or null when the action succeeded.
 */
export function useAsyncAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<unknown>, label = "Working"): Promise<string | null> => {
    setBusy(label);
    setError(null);
    try {
      await action();
      return null;
    } catch (e) {
      const message = describeArcGISError(e);
      setError(message);
      return message;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, isBusy: busy !== null, error, setError, run };
}
