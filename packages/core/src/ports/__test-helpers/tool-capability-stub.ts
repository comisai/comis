// SPDX-License-Identifier: Apache-2.0
//
// Test-only fixture factory for ToolCapabilityPort.
//
// Provides a one-line-overridable stub for unit tests that exercise only a
// subset of the port. NOT a production code path. Lives in __test-helpers/
// to be visible to co-located *.test.ts files only.
// production source MUST NOT import this.
//
// The architecture-grep test (packages/<pkg>/src/__tests__/architecture.test.ts)
// enforces this boundary by source-grepping production paths for the literal
// `createCapabilityPortStub` and asserting zero matches. Without that test,
// the stub would compile into `dist/__test-helpers/` (tsconfig does NOT exclude
// `__test-helpers/`) and could leak into the published `comisai` tarball via the
// umbrella's bundledDependencies (see CLAUDE.md "Supply-chain invariants").
//
// Usage:
//   import { createCapabilityPortStub } from
//     "../ports/__test-helpers/tool-capability-stub.js";
//   const port = createCapabilityPortStub({
//     getInstallDetourMode: () => "soft-stop",
//   });
//
// @module

import type {
  ToolCapabilityPort,
  PromptSkillCapability,
  CapabilitySourceRef,
} from "../tool-capability.js";

const EMPTY_ALIAS_MAP: ReadonlyMap<string, CapabilitySourceRef> = new Map();
const EMPTY_SERVERS: readonly string[] = Object.freeze([]);
const EMPTY_SKILLS: readonly PromptSkillCapability[] = Object.freeze([]);

/**
 * Test-only fixture factory. Tests use this; production source must NOT import.
 *
 * Pass `overrides` to replace specific methods; unspecified methods return
 * empty defaults. The architecture-grep test enforces the production/test
 * boundary at every commit.
 *
 * Returned port is intentionally NOT frozen so tests can mutate-then-restore
 * fields when exercising state transitions.
 *
 * @param overrides - Optional partial implementation; merged via spread.
 * @returns An unfrozen ToolCapabilityPort with empty defaults plus overrides.
 */
export function createCapabilityPortStub(
  overrides?: Partial<ToolCapabilityPort>,
): ToolCapabilityPort {
  return {
    isCapabilityIndexEnabled: () => true,
    getInstallDetourMode: () => "advise" as const,
    getBuiltinCluster: () => undefined,
    getClusterConfig: () => undefined,
    getMcpServerHint: () => undefined,
    getSkillHint: () => undefined,
    getPackageAliasMap: () => EMPTY_ALIAS_MAP,
    getConnectedMcpServers: () => EMPTY_SERVERS,
    getPromptSkillCapabilities: () => EMPTY_SKILLS,
    ...overrides,
  };
}
