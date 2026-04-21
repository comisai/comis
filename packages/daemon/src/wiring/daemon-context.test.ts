// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DaemonContext", () => {
  // -------------------------------------------------------------------------
  // 1. Import succeeds without error
  // -------------------------------------------------------------------------

  it("imports DaemonContext type without error", async () => {
    const mod = await import("./daemon-context.js");
    // Module should exist and export (even if only type-level)
    expect(mod).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 2. Source contains all expected interface fields
  // -------------------------------------------------------------------------

  it("source file contains all expected interface fields", () => {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const sourcePath = resolve(thisDir, "daemon-context.ts");
    const source = readFileSync(sourcePath, "utf-8");

    // Core fields
    const expectedFields = [
      "container",
      "instanceId",
      "startupStartMs",
      // Logging
      "logger",
      "logLevelManager",
      "gatewayLogger",
      "channelsLogger",
      "agentLogger",
      "schedulerLogger",
      "skillsLogger",
      "memoryLogger",
      "daemonVersion",
      // Observability
      "tokenTracker",
      "latencyRecorder",
      "sharedCostTracker",
      "diagnosticCollector",
      "billingEstimator",
      "channelActivityTracker",
      "deliveryTracer",
      // Process
      "processMonitor",
      "watchdogHandle",
      "deviceIdentity",
      // Memory
      "embeddingPort",
      "cachedPort",
      "memoryAdapter",
      "sessionStore",
      "memoryApi",
      "embeddingQueue",
      // Agents
      "sessionManager",
      "executors",
      "workspaceDirs",
      "costTrackers",
      "stepCounters",
      "defaultAgentId",
      "defaultWorkspaceDir",
      // Schedulers
      "cronSchedulers",
      "executionTrackers",
      "resetSchedulers",
      // Browser
      "browserServices",
      // Channels
      "adaptersByType",
      // Media
      "ttsAdapter",
      "visionRegistry",
      "linkRunner",
      // Cross-session
      "crossSessionSender",
      "subAgentRunner",
      // RPC / Gateway
      "rpcCall",
      "heartbeatRunner",
      "gatewayHandle",
      "shutdownHandle",
      "channelManager",
      // Resolver functions
      "getExecutor",
      "getAgentCronScheduler",
      "getAgentBrowserService",
    ];

    for (const field of expectedFields) {
      // Match field as interface member (field name followed by colon or question mark + colon)
      const regex = new RegExp(`\\b${field}[?]?\\s*:`);
      expect(
        regex.test(source),
        `Expected field "${field}" to be defined in DaemonContext interface`,
      ).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Interface exports expected type imports
  // -------------------------------------------------------------------------

  it("source imports from expected packages", () => {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const sourcePath = resolve(thisDir, "daemon-context.ts");
    const source = readFileSync(sourcePath, "utf-8");

    const expectedImports = [
      "@comis/core",
      "@comis/infra",
      "@comis/agent",
      "@comis/memory",
      "@comis/scheduler",
      "@comis/gateway",
      "@comis/skills",
      "@comis/channels",
    ];

    for (const pkg of expectedImports) {
      expect(
        source.includes(pkg),
        `Expected import from "${pkg}" in daemon-context.ts`,
      ).toBe(true);
    }
  });
});
