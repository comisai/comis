// SPDX-License-Identifier: Apache-2.0
// Model catalog re-exports for the @comis/core barrel.
export {
  createModelCatalog,
  resolveModelPricing,
  resolvePricingState,
  modelResolvesInCatalog,
  ZERO_COST,
} from "../model/model-catalog.js";
export type {
  CatalogEntry,
  ModelCatalog,
  PerTokenCostRates,
} from "../model/model-catalog.js";
// Provider↔model chimera detector. Only the
// consumed entry point is on the public barrel; `resolveModelFamily`/`ModelFamily` stay
// module-local (used internally + via the module's own test) until a consumer needs them.
export { isProviderModelChimera } from "../model/model-family.js";
