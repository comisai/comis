// SPDX-License-Identifier: Apache-2.0
// Model catalog re-exports for the @comis/core barrel (relocated from @comis/agent).
export {
  createModelCatalog,
  resolveModelPricing,
  ZERO_COST,
} from "../model/model-catalog.js";
export type {
  CatalogEntry,
  ModelCatalog,
  PerTokenCostRates,
} from "../model/model-catalog.js";
// RESOLVE-01: provider↔model chimera detector (observability-excellence).
export { resolveModelFamily, isProviderModelChimera } from "../model/model-family.js";
export type { ModelFamily } from "../model/model-family.js";
