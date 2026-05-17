// SPDX-License-Identifier: Apache-2.0
/**
 * Pins the canonical key sets of `SingleAgentDeps` and `SingleAgentResult`
 * so additions/renames surface here as compile + assertion failures
 * (independent of the broader parity gate). The types leaf has no
 * executable bodies.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { SingleAgentDeps, SingleAgentResult } from "./setup-agents-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("setup-agents-types", () => {
  it("SingleAgentDeps witness includes every required and optional field", () => {
    // The witness's `Record<keyof T, true>` compile-checks exhaustiveness.
    const witness: Record<keyof SingleAgentDeps, true> = {
      container: true,
      memoryAdapter: true,
      sessionStore: true,
      agentLogger: true,
      resolvedAgentDir: true,
      daemonTracingDefaults: true,
      subAgentToolNames: true,
      mcpToolsInherited: true,
      outboundMediaEnabled: true,
      autonomousMediaEnabled: true,
      activeRunRegistry: true,
      canaryFallbackSecret: true,
      injectionRateLimiter: true,
      embeddingQueue: true,
      contextStore: true,
      db: true,
      providerHealth: true,
      lastKnownModel: true,
      embeddingPort: true,
      deliveryMirror: true,
      deliveryMirrorConfig: true,
      geminiCacheManager: true,
      getChannelMaxChars: true,
      backgroundTaskManager: true,
      secretsCrypto: true,
      secretsDb: true,
      oauthCredentialStore: true,
      mcpClientManager: true,
      fileLock: true,
      clock: true,
      env: true,
      timers: true,
    };
    expect(Object.keys(witness).length).toBe(32);
  });

  it("SingleAgentResult witness pins the per-agent factory output keys", () => {
    const witness: Record<keyof SingleAgentResult, true> = {
      executor: true,
      workspaceDir: true,
      costTracker: true,
      budgetGuard: true,
      stepCounter: true,
      piSessionAdapter: true,
      skillWatcherHandle: true,
      skillRegistry: true,
      toolCapabilityPort: true,
    };
    expect(Object.keys(witness).length).toBe(9);
  });

  it("SingleAgentResult source still declares the 8 documented members", () => {
    const source = readFileSync(join(__dirname, "setup-agents-types.ts"), "utf-8");
    const interfaceStart = source.indexOf("export interface SingleAgentResult {");
    expect(interfaceStart).toBeGreaterThan(-1);
    const interfaceEnd = source.indexOf("\n}", interfaceStart);
    const interfaceBlock = source.slice(interfaceStart, interfaceEnd);
    // All 8 declared fields still present.
    expect(interfaceBlock).toContain("executor:");
    expect(interfaceBlock).toContain("workspaceDir:");
    expect(interfaceBlock).toContain("costTracker:");
    expect(interfaceBlock).toContain("budgetGuard:");
    expect(interfaceBlock).toContain("stepCounter:");
    expect(interfaceBlock).toContain("piSessionAdapter:");
    expect(interfaceBlock).toContain("skillWatcherHandle?:");
    expect(interfaceBlock).toContain("skillRegistry:");
  });

  it("SingleAgentDeps source preserves shared-dep fields the registry must thread", () => {
    const source = readFileSync(join(__dirname, "setup-agents-types.ts"), "utf-8");
    const interfaceStart = source.indexOf("export interface SingleAgentDeps {");
    expect(interfaceStart).toBeGreaterThan(-1);
    // The next top-level export-keyword starts SingleAgentResult.
    const interfaceEnd = source.indexOf("\nexport ", interfaceStart + 1);
    const interfaceBlock = source.slice(interfaceStart, interfaceEnd);
    // 7 required shared-dependency fields the registry must thread.
    expect(interfaceBlock).toContain("container:");
    expect(interfaceBlock).toContain("memoryAdapter:");
    expect(interfaceBlock).toContain("sessionStore:");
    expect(interfaceBlock).toContain("agentLogger:");
    expect(interfaceBlock).toContain("resolvedAgentDir:");
    expect(interfaceBlock).toContain("subAgentToolNames?:");
    expect(interfaceBlock).toContain("mcpToolsInherited:");
  });
});
