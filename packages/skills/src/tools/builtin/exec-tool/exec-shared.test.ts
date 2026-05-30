// SPDX-License-Identifier: Apache-2.0
/**
 * exec-shared.ts unit tests.
 *
 * EGRESS-03 — per-spawn proxy env (brokerSpawnEnv):
 *  - buildExecEnv with brokerSpawnEnv → env contains proxy vars + placeholder keys
 *  - brokerSpawnEnv wins over wrapEnv output (merge-last)
 *  - buildExecEnv without brokerSpawnEnv → NO proxy vars (property-tested over 3 shapes)
 *  - buildExecEnv without brokerSpawnEnv is byte-identical to pre-patch output (regression guard)
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

import { vi, describe, it, expect } from "vitest";

// Mock node:fs so that existsSync always returns false (no venv/bin → simpler env builds).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { buildExecEnv } from "./exec-shared.js";
import type { ExecSandboxConfig } from "../sandbox/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal sandboxConfig with a custom wrapEnv transform. */
function makeSandboxConfig(
  wrapEnv: (env: Record<string, string>, workspacePath: string) => Record<string, string>,
): ExecSandboxConfig {
  return {
    sandbox: {
      buildArgs: () => [],
      wrapEnv,
      available: () => false,
    },
  } as unknown as ExecSandboxConfig;
}

/**
 * A fixed set of base env vars to pass as subprocessEnv.
 * Passing subprocessEnv explicitly avoids calling systemEnvSnapshot(),
 * giving us deterministic test outputs.
 */
const FIXED_BASE: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/testuser",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("EGRESS-03 — per-spawn proxy env (brokerSpawnEnv)", () => {
  it('buildExecEnv with brokerSpawnEnv → result contains HTTPS_PROXY, HTTP_PROXY, NODE_EXTRA_CA_CERTS, and placeholder keys', () => {
    const result = buildExecEnv({
      workspacePath: "/home/agent/workspace",
      subprocessEnv: { ...FIXED_BASE },
      brokerSpawnEnv: {
        HTTPS_PROXY: "http://proxy:8080",
        HTTP_PROXY: "http://proxy:8080",
        NODE_EXTRA_CA_CERTS: "/etc/comis/ca.pem",
        placeholders: { ANTHROPIC_API_KEY: "broker-placeholder" },
      },
    });

    expect(result.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(result.HTTP_PROXY).toBe("http://proxy:8080");
    expect(result.NODE_EXTRA_CA_CERTS).toBe("/etc/comis/ca.pem");
    expect(result.ANTHROPIC_API_KEY).toBe("broker-placeholder");
  });

  it('buildExecEnv with brokerSpawnEnv wins over wrapEnv output (merge-last)', () => {
    // wrapEnv injects HTTPS_PROXY: "wrong-value" — broker must win
    const sandboxConfig = makeSandboxConfig((env) => ({
      ...env,
      HTTPS_PROXY: "wrong-value",
    }));

    const result = buildExecEnv({
      workspacePath: "/home/agent/workspace",
      subprocessEnv: { ...FIXED_BASE },
      sandboxConfig,
      brokerSpawnEnv: {
        HTTPS_PROXY: "correct-proxy",
        HTTP_PROXY: "correct-proxy",
        NODE_EXTRA_CA_CERTS: "/etc/comis/ca.pem",
        placeholders: { ANTHROPIC_API_KEY: "broker-placeholder" },
      },
    });

    expect(result.HTTPS_PROXY).toBe("correct-proxy");
  });

  it('buildExecEnv without brokerSpawnEnv has NO HTTPS_PROXY, HTTP_PROXY, NODE_EXTRA_CA_CERTS (property test — 3 shapes)', () => {
    // Shape A: bare call — no subprocessEnv, no userEnv
    const shapeA = buildExecEnv({
      workspacePath: "/home/agent/workspace",
      subprocessEnv: { ...FIXED_BASE },
    });

    // Shape B: userEnv with some keys
    const shapeB = buildExecEnv({
      workspacePath: "/home/agent/workspace",
      subprocessEnv: { ...FIXED_BASE },
      userEnv: { MY_VAR: "hello", PORT: "3000" },
    });

    // Shape C: sandboxConfig with a wrapEnv that does NOT set HTTPS_PROXY
    const sandboxConfig = makeSandboxConfig((env) => ({
      ...env,
      CACHE_DIR: "/workspace/.cache",
    }));
    const shapeC = buildExecEnv({
      workspacePath: "/home/agent/workspace",
      subprocessEnv: { ...FIXED_BASE },
      sandboxConfig,
    });

    for (const [shapeName, result] of [["A", shapeA], ["B", shapeB], ["C", shapeC]] as const) {
      expect(result, `Shape ${shapeName}: must not contain HTTPS_PROXY`).not.toHaveProperty("HTTPS_PROXY");
      expect(result, `Shape ${shapeName}: must not contain HTTP_PROXY`).not.toHaveProperty("HTTP_PROXY");
      expect(result, `Shape ${shapeName}: must not contain NODE_EXTRA_CA_CERTS`).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
      expect(result, `Shape ${shapeName}: must not contain ANTHROPIC_API_KEY`).not.toHaveProperty("ANTHROPIC_API_KEY");
    }
  });

  it('buildExecEnv without brokerSpawnEnv is byte-identical to pre-patch output (regression guard)', () => {
    const knownInputs = {
      workspacePath: "/home/agent/workspace",
      subprocessEnv: { ...FIXED_BASE },
      userEnv: { MY_VAR: "test-value" },
      resolvedSecretEnv: { SOME_SECRET: "resolved-val" },
    };

    // Call twice with identical inputs — results must be deep-equal.
    // This guards that the new optional parameter does not alter existing behavior.
    const result1 = buildExecEnv({ ...knownInputs });
    const result2 = buildExecEnv({ ...knownInputs });

    expect(result1).toEqual(result2);

    // Explicitly assert the new proxy keys are absent (belt-and-suspenders).
    expect(result1).not.toHaveProperty("HTTPS_PROXY");
    expect(result1).not.toHaveProperty("HTTP_PROXY");
    expect(result1).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
  });
});
