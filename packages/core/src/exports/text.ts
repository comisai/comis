// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — pure text utilities: script classification +
// token-factor, search normalization + trigram query routing, grapheme-safe
// truncation boundary + multilingual name heuristic.

export { SCRIPT_CLASSES, classifyCodepoint, scriptShares, dominantScript } from "../text/script-classes.js";
export type { ScriptClass, ScriptClassRow } from "../text/script-classes.js";
export { classifyGenerationQuality } from "../text/generation-quality.js";
export type { GenerationPass } from "../text/generation-quality.js";
export { scriptTokenFactor } from "../text/token-factor.js";
export { normalizeForSearch } from "../text/normalize-search.js";
export { routeSearchQuery } from "../text/trigram-query.js";
export type { TrigramRoute, SearchLane } from "../text/trigram-query.js";
export { adjustSliceBoundary } from "../text/slice-boundary.js";
export { resolveMultilingual, EMBED_MULTILINGUAL, RERANK_MULTILINGUAL } from "../text/multilingual-heuristic.js";
