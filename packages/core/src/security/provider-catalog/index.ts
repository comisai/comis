// SPDX-License-Identifier: Apache-2.0
// provider-catalog public surface

export type { HostPattern, InjectionRule, RequestFinalizer, StaticHeader, HostRule, BrokerBinding, ProviderPreset, PresetLibrary } from "./types.js";
export type { InjectionInput } from "./injection-engine.js";
export { normalizeHost, hostRuleMatches, pathAllowed, resolveBinding } from "./matcher.js";
export { applyInjections } from "./injection-engine.js";
export { expandPreset, PRESETS } from "./presets.js";
