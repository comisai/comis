// SPDX-License-Identifier: Apache-2.0
import type { AgentConfig } from "../config/schema-agent/index.js";
import { PathTraversalError } from "../security/safe-path.js";
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

// ---------------------------------------------------------------------------
// resolveWorkspaceDir must root workspaces under the ACTIVE data dir, never a
// hardcoded ~/.comis. With a hardcoded base, isolated test daemons (temp
// COMIS_DATA_DIR) create workspace-<agentId> dirs inside the PRODUCTION
// ~/.comis, and because the path is then shared across daemon instances, a
// later run RESUMES an earlier run's degraded session JSONL (a silent-LLM-
// failure cascade). The resolver therefore takes an optional baseDataDir
// (precedence: explicit config.workspacePath > baseDataDir > ~/.comis).
// ---------------------------------------------------------------------------

describe("resolveWorkspaceDir — baseDataDir override (dataDir-rooted workspaces)", () => {
  it("default agent under baseDataDir", () => {
    const result = resolveWorkspaceDir({} as AgentConfig, "default", "/custom/data");
    expect(result).toBe(path.join("/custom/data", "workspace"));
  });

  it("named agent under baseDataDir", () => {
    const result = resolveWorkspaceDir({} as AgentConfig, "mem-04-poison", "/custom/data");
    expect(result).toBe(path.join("/custom/data", "workspace-mem-04-poison"));
  });

  it("explicit config.workspacePath still wins over baseDataDir", () => {
    const result = resolveWorkspaceDir(
      { workspacePath: "/explicit/ws" } as AgentConfig,
      "default",
      "/custom/data",
    );
    expect(result).toBe(path.resolve("/explicit/ws"));
  });

  it("empty baseDataDir falls back to ~/.comis (existing contract)", () => {
    const result = resolveWorkspaceDir({} as AgentConfig, "default", "");
    expect(result).toBe(path.join(os.homedir(), ".comis", "workspace"));
  });
});
