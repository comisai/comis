// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon channels-subsystem wiring (Phase 43 wave 8 split per FILE-SPLIT-08).
 *
 * Barrel re-export of the canonical public API of the former setup-channels.ts
 * monolith. No aliases — every export keeps its canonical name. The
 * pre-split parity snapshot (captured in 43-08a) reproduces verbatim against
 * this barrel.
 *
 * Decomposition:
 *   - setup-channels-registry.ts     ≤300L — setupChannels orchestrator + ChannelsDeps/Result
 *   - setup-channels-credentials.ts  ≤500L — cron event listeners (registerCronEventListeners): API-key + model resolution per cron tick
 *   - setup-channels-runtime.ts      ≤500L — buildAndStartChannelManager: voice pipeline + command queue + slash handlers + lifecycle reactors + approval notifier
 *
 * @module
 */

export type { ChannelsDeps, ChannelsResult } from "./setup-channels-registry.js";
export { setupChannels } from "./setup-channels-registry.js";
