// SPDX-License-Identifier: Apache-2.0
import type { AgentConfig } from "@comis/core";
import { PathTraversalError } from "@comis/core";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveWorkspaceDir } from "./workspace-resolver.js";

/** Create a minimal AgentConfig with optional workspacePath. */
function makeConfig(workspacePath?: string): AgentConfig {
  return {
    name: "Comis",
    model: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    maxSteps: 25,
    maxContextChars: 100_000,
    preserveRecent: 4,
    budgets: { perExecution: 100_000, perHour: 500_000, perDay: 2_000_000 },
    circuitBreaker: {
      failureThreshold: 5,
      resetTimeoutMs: 60_000,
      halfOpenTimeoutMs: 30_000,
    },
    modelRoutes: {},
    rag: {
      enabled: false,
      maxResults: 5,
      maxContextChars: 4000,
      minScore: 0.1,
      includeTrustLevels: ["system", "learned"],
    },
    bootstrap: {
      maxChars: 20_000,
      promptMode: "full",
    },
    modelFailover: {
      fallbackModels: [],
      authProfiles: [],
      allowedModels: [],
      maxAttempts: 6,
      cooldownInitialMs: 60_000,
      cooldownMultiplier: 5,
      cooldownCapMs: 3_600_000,
    },
    ...(workspacePath !== undefined ? { workspacePath } : {}),
  };
}

describe("workspace-resolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolveWorkspaceDir", () => {
    it("returns explicit config.workspacePath resolved to absolute when set", () => {
      const config = makeConfig("/custom/workspace");
      const result = resolveWorkspaceDir(config);
      expect(result).toBe("/custom/workspace");
    });

    it("returns ~/.comis/workspace for default agent", () => {
      const config = makeConfig();
      const result = resolveWorkspaceDir(config);
      expect(result).toBe(path.join(os.homedir(), ".comis", "workspace"));
    });

    it("returns ~/.comis/workspace-{agentId} for named agent", () => {
      const config = makeConfig();
      const result = resolveWorkspaceDir(config, "alice");
      expect(result).toBe(path.join(os.homedir(), ".comis", "workspace-alice"));
    });

    it('treats agentId === "default" same as no agentId', () => {
      const config = makeConfig();
      const withDefault = resolveWorkspaceDir(config, "default");
      const withUndefined = resolveWorkspaceDir(config);
      expect(withDefault).toBe(withUndefined);
      expect(withDefault).toBe(path.join(os.homedir(), ".comis", "workspace"));
    });

    it("resolves relative workspacePath to absolute via path.resolve", () => {
      const config = makeConfig("./relative/workspace");
      const result = resolveWorkspaceDir(config);
      expect(path.isAbsolute(result)).toBe(true);
      expect(result).toBe(path.resolve("./relative/workspace"));
    });

    // safePath defense-in-depth
    it("throws PathTraversalError for malicious agentId with traversal sequences", () => {
      const config = makeConfig();
      // workspace-../../../etc/passwd escapes ~/.comis/ base directory
      expect(() => resolveWorkspaceDir(config, "../../../etc/passwd")).toThrow(PathTraversalError);
    });

    it("throws PathTraversalError for agentId with null byte", () => {
      const config = makeConfig();
      expect(() => resolveWorkspaceDir(config, "bad\0agent")).toThrow(PathTraversalError);
    });
  });
});
