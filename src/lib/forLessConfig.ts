/**
 * Tunable thresholds for the "For less, from her closet" laddering.
 * Values changed here take effect app-wide; do not thread them
 * through props.
 */

export const FOR_LESS = {
  /** Anchor price must be at least this many USD before we surface
   *  the ladder. Below this the price gap isn't meaningful. */
  minAnchorPriceUsd: 150,

  /** Candidate must be at most this fraction of the anchor's price. */
  maxCandidateFraction: 0.65,

  /** Maximum candidates returned per anchor. */
  maxCandidates: 3,

  /** When we can't compute a category top-quartile threshold, use
   *  the minAnchorPriceUsd floor alone. */
  fallbackToFloorOnly: true,
};
