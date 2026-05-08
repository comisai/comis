// SPDX-License-Identifier: Apache-2.0
/**
 * Production no-op factory for ToolCapabilityPort.
 *
 * Returns an empty-defaults adapter that is safe to inject from any production
 * code path. Used as the interim port between Phase 17 (port lands) and Phase 23
 * (live adapter lands) -- see design §11 Phase 7 production-behavior paragraph.
 *
 * With the no-op port:
 * - The capability-index renderer sees no clusters/skills/servers -> returns
 *   empty text -> executor-prompt-runner.ts filters it out (§5 empty-render rule).
 * - The install-detour parser sees no overlaps -> no events emitted, no hints,
 *   no soft-stop refusals.
 * Both subsystems are inert but not broken. Acceptable interim state.
 *
 * IMPORTANT -- boundary discipline (Pitfall 13):
 * Test code must NOT import this. Tests use the test-only stub factory in
 * `__test-helpers/` instead. The architecture-grep test in Plan 17-04
 * (`packages/<pkg>/src/__tests__/architecture.test.ts`) enforces this both ways.
 *
 * @module
 */

import type {
  ToolCapabilityPort,
  PromptSkillCapability,
  CapabilitySourceRef,
} from "./tool-capability.js";

// Module-level constants -- returned by every call so callers can rely on
// reference-stability for cheap equality checks.
const EMPTY_ALIAS_MAP: ReadonlyMap<string, CapabilitySourceRef> = new Map();
const EMPTY_SERVERS: readonly string[] = Object.freeze([]);
const EMPTY_SKILLS: readonly PromptSkillCapability[] = Object.freeze([]);

/**
 * Production no-op factory. Production-OK; safe to import from any production
 * code path. Tests must NOT import this -- use the test-only stub factory in
 * `__test-helpers/` instead.
 *
 * @returns A frozen ToolCapabilityPort with empty defaults for all 9 methods.
 */
export function createNoOpCapabilityPort(): ToolCapabilityPort {
  return Object.freeze({
    isCapabilityIndexEnabled: () => true,
    getInstallDetourMode: () => "advise" as const,
    getBuiltinCluster: () => undefined,
    getClusterConfig: () => undefined,
    getMcpServerHint: () => undefined,
    getSkillHint: () => undefined,
    getPackageAliasMap: () => EMPTY_ALIAS_MAP,
    getConnectedMcpServers: () => EMPTY_SERVERS,
    getPromptSkillCapabilities: () => EMPTY_SKILLS,
  });
}
