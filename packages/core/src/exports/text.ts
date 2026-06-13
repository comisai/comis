// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — pure text utilities:
//   Phase 179 — Script classification + token-factor
//   Phase 180 — search normalization (FTS-02) + trigram query routing (FTS-01)

export { SCRIPT_CLASSES, classifyCodepoint, scriptShares, dominantScript } from "../text/script-classes.js";
export type { ScriptClass, ScriptClassRow } from "../text/script-classes.js";
export { scriptTokenFactor } from "../text/token-factor.js";
export { normalizeForSearch } from "../text/normalize-search.js";
export { routeSearchQuery } from "../text/trigram-query.js";
export type { TrigramRoute, SearchLane } from "../text/trigram-query.js";
