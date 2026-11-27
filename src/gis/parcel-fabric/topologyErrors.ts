/**
 * Plain-language explanations of topology errors, by the error's rule type (`esriTRT…`).
 *
 * The app only finds and shows errors; it never fixes them. Correcting the parcels is the
 * surveyor's responsibility, so each explanation says what is wrong and what the surveyor must
 * check. Errors that are correct as they are (e.g. a gap along the outer edge of the data) are
 * marked as exceptions by a GIS administrator in ArcGIS Pro; the app no longer lists them.
 */

export interface TopologyErrorExplanation {
  /** What is wrong, in words a non-GIS user understands. */
  what: string;
  /** What the surveyor must check or correct. */
  check: string;
}

const EXPLANATIONS: Record<string, TopologyErrorExplanation> = {
  esriTRTAreaBoundaryCoveredByLine: {
    what: "Part of this parcel's boundary has no parcel line along it.",
    check: "The surveyor must add or correct the boundary lines so they follow the whole parcel edge.",
  },
  esriTRTLineEndpointCoveredByPoint: {
    what: "A parcel line ends without a corner point.",
    check: "The surveyor must add the missing corner point, or connect the line to the existing point.",
  },
  esriTRTLineCoveredByAreaBoundary: {
    what: "This line is not on the boundary of any parcel (a loose line).",
    check: "The surveyor must decide: if it is a boundary, the parcel must be drawn along it; if it is not needed, it must be removed.",
  },
  esriTRTPointCoveredByLineEndpoint: {
    what: "This point is not at the end of any parcel line (a loose point).",
    check: "The surveyor must connect it to the boundary it belongs to, or remove it if it is not a parcel corner.",
  },
  esriTRTAreaNoGaps: {
    what: "There is an empty space between parcels: this ground belongs to no parcel.",
    check:
      "Inside the data, the surveyor must draw the missing parcel or move the neighbouring boundaries together. Along the outer edge of the data a gap is expected: report it to the GIS administrator to accept it.",
  },
  esriTRTAreaNoOverlap: {
    what: "Two parcels cover the same ground.",
    check: "The surveyor must decide which parcel this area belongs to and correct the other parcel's boundary.",
  },
  esriTRTLineNoDangles: {
    what: "A line end is not connected to any other line.",
    check: "The surveyor must connect the line end to the boundary it should meet, or remove the line if no parcel uses it.",
  },
  esriTRTLineNoSelfOverlap: {
    what: "A line runs back over itself.",
    check: "The surveyor must correct the line's vertices so it does not double back.",
  },
  esriTRTLineNoSelfIntersect: {
    what: "A line crosses itself.",
    check: "The surveyor must correct the line's vertices so it does not cross itself.",
  },
};

/** The explanation for an error of this rule type; unknown rules get a general one. */
export function explainTopologyError(ruleType: string | null | undefined, ruleName: string): TopologyErrorExplanation {
  return (
    (ruleType && EXPLANATIONS[ruleType]) || {
      what: `The data breaks the topology rule "${ruleName}".`,
      check: "The surveyor must check the parcels here and correct their shape.",
    }
  );
}

/** What a not-yet-validated (dirty) area means. */
export const DIRTY_AREA_EXPLANATION: TopologyErrorExplanation = {
  what: "This area changed and has not been validated yet, so its errors are not known.",
  check: "Validate this map view (named version, while editing) to find them.",
};

export interface ParcelAtError {
  label: string;
  /** How much of the error lies in or along the parcel: area for an area error, length for a line error (0 when it only touches it). */
  shared: number;
}

/**
 * Which parcels to name for an error. The parcels the error lies in or along are the ones at fault:
 * both parcels of an overlap, the parcel whose boundary has no line. A neighbour that only touches the
 * error (at a corner, or a line end) is not named. When no parcel shares anything (a gap, a loose
 * line), the parcels touching it are named. Point errors name the parcels they touch.
 * `errorSize` is the error's area or length (0 for point errors); a sliver under 1% of it does not count.
 */
export function parcelsAtError(candidates: ParcelAtError[], errorSize: number): string[] {
  const sharing = errorSize > 0 ? candidates.filter((c) => c.shared > errorSize * 0.01) : [];
  const chosen = sharing.length ? sharing : candidates;
  return [...new Set(chosen.map((c) => c.label))].sort((a, b) => a.localeCompare(b));
}
