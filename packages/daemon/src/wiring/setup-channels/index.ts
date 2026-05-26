// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon channels-subsystem wiring.
 *
 * Barrel re-export of the canonical public API of the former setup-channels.ts
 * monolith. No aliases — every export keeps its canonical name.
 *
 * Decomposition:
 *   - setup-channels-registry.ts     setupChannels orchestrator + ChannelsDeps/Result
 *   - setup-channels-credentials.ts  cron event listeners (registerCronEventListeners): API-key + model resolution per cron tick
 *   - setup-channels-runtime.ts      buildAndStartChannelManager: voice pipeline + command queue + slash handlers + lifecycle reactors
 *
 * @module
 */

export type { ChannelsDeps, ChannelsResult } from "./setup-channels-registry.js";
export { setupChannels } from "./setup-channels-registry.js";
