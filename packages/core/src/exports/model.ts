// SPDX-License-Identifier: Apache-2.0
// Model catalog re-exports for the @comis/core barrel (D-01 #4).
// Relocated from @comis/agent in Phase 35 per WEB-CONTRACTS-02 D-01 #4.
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
