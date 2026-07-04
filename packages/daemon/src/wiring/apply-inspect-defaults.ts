// SPDX-License-Identifier: Apache-2.0
/**
 * util.inspect default deepening for Anthropic SDK debug logging, extracted
 * from `daemon.ts`.
 *
 * When ANTHROPIC_LOG=debug|info is set, the Anthropic SDK calls
 * `console.debug('[req] sending request', { ...payload })`, which Node formats
 * with util.inspect using the default `depth: 2`. That collapses the request
 * body to `messages: [Array]`, so the actual body we are trying to capture is
 * lost. `applyInspectDefaultsForLogging` deepens util.inspect ONLY when the SDK
 * debug logger is actually enabled; when ANTHROPIC_LOG is unset the SDK emits no
 * debug lines anyway, so inspect defaults are left alone — production logs
 * unchanged.
 *
 * It was moved out of `daemon.ts` (a behavior-neutral function extraction, no
 * logic change) to keep that composition root under its architecture line cap
 * (`__tests__/architecture.test.ts` enforces the daemon.ts ≤3000-line budget) —
 * a shrink-only split, NOT an allowlist add. The single caller (daemon.ts
 * `main()`) imports it from this path AND re-exports it, so its public surface
 * is unchanged (`daemon.test.ts` imports it from "./daemon.js").
 *
 * @module
 */

import { inspect } from "node:util";

/**
 * When ANTHROPIC_LOG=debug|info is set, deepen util.inspect so the Anthropic
 * SDK's `console.debug('[req] sending request', …)` line shows the full request
 * body instead of collapsing it to `messages: [Array]` at the default depth 2.
 *
 * `breakLength: Infinity` keeps each log line single-line so grep-based
 * inspection of the daemon log keeps working.
 *
 * Returns whether each default was changed (used by tests; ignored at runtime).
 */
export function applyInspectDefaultsForLogging(
  env: Record<string, string | undefined>,
): { depthChanged: boolean; breakLengthChanged: boolean } {
  const lvl = env["ANTHROPIC_LOG"];
  if (lvl !== "debug" && lvl !== "info") {
    return { depthChanged: false, breakLengthChanged: false };
  }
  const depthChanged = inspect.defaultOptions.depth !== null;
  const breakLengthChanged = inspect.defaultOptions.breakLength !== Infinity;
  inspect.defaultOptions.depth = null;
  inspect.defaultOptions.breakLength = Infinity;
  return { depthChanged, breakLengthChanged };
}
