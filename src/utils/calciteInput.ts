import { flushSync } from "react-dom";

/**
 * Handler for Calcite `…Input` events that keeps React state in step with what the field shows.
 *
 * Calcite fires these as custom DOM events, outside React's event system, so React renders the
 * state update at default (deferred) priority. A button clicked a few milliseconds after the last
 * keystroke (fast typing, paste then click, a busy map on first open) could run with the previous
 * value: for example, "Verify" counting every feature instead of the typed WHERE clause.
 * Committing synchronously removes that window.
 */
export function calciteInput(set: (value: string) => void) {
  return (e: Event) => {
    const value = String((e.target as HTMLElement & { value?: unknown }).value ?? "");
    flushSync(() => set(value));
  };
}
