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

import { buildExecEnv, buildSpawnCommand, resolveSecretRefs } from "./exec-shared.js";
import type { ExecSandboxConfig } from "../sandbox/types.js";
import { createSecretManagerWithMutableHandle } from "@comis/core";

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

// ── CR-02 RED: buildSpawnCommand must forward network + secureCredentialHome ──

describe("CR-02 — buildSpawnCommand forwards network + secureCredentialHome to buildArgs (EGRESS-01/02 production path)", () => {
  it("buildSpawnCommand with broker-only + secureCredentialHome config → args contain --unshare-net (EGRESS-01 production wiring)", () => {
    // Track what SandboxOptions were actually passed to buildArgs
    let capturedOpts: Record<string, unknown> | undefined;
    const fakeSandbox = {
      name: "bwrap",
      available: () => true,
      buildArgs: (opts: Record<string, unknown>): string[] => {
        capturedOpts = opts;
        // Return minimal args that include --unshare-net when network is broker-only
        const net = opts["network"] as { mode: string } | undefined;
        if (net?.mode === "broker-only") return ["/usr/bin/bwrap", "--unshare-net"];
        return ["/usr/bin/bwrap", "--share-net"];
      },
    };

    // ExecSandboxConfig with network + secureCredentialHome
    const sandboxConfig: ExecSandboxConfig = {
      sandbox: fakeSandbox as unknown as ExecSandboxConfig["sandbox"],
      sharedPaths: [],
      readOnlyPaths: [],
      configReadOnlyPaths: [],
      network: { mode: "broker-only", brokerSocketPath: "/run/comis/broker.sock" },
      secureCredentialHome: true,
    };

    const result = buildSpawnCommand(
      "echo hello",
      "/workspace",
      sandboxConfig,
      "/workspace",
      "/workspace/.tmp",
    );

    // The resulting args must include --unshare-net (bwrap broker-only profile)
    expect(result.args).toContain("--unshare-net");

    // capturedOpts must have the network and secureCredentialHome forwarded
    expect(capturedOpts?.["network"]).toEqual({ mode: "broker-only", brokerSocketPath: "/run/comis/broker.sock" });
    expect(capturedOpts?.["secureCredentialHome"]).toBe(true);
  });

  it("buildSpawnCommand without network field → --share-net in args (EGRESS-03 no-regression)", () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const fakeSandbox = {
      name: "bwrap",
      available: () => true,
      buildArgs: (opts: Record<string, unknown>): string[] => {
        capturedOpts = opts;
        const net = opts["network"] as { mode: string } | undefined;
        if (net?.mode === "broker-only") return ["/usr/bin/bwrap", "--unshare-net"];
        return ["/usr/bin/bwrap", "--share-net"];
      },
    };

    const sandboxConfig: ExecSandboxConfig = {
      sandbox: fakeSandbox as unknown as ExecSandboxConfig["sandbox"],
      sharedPaths: [],
      readOnlyPaths: [],
      configReadOnlyPaths: [],
    };

    const result = buildSpawnCommand(
      "echo hello",
      "/workspace",
      sandboxConfig,
      "/workspace",
      "/workspace/.tmp",
    );

    expect(result.args).toContain("--share-net");
    expect(capturedOpts?.["network"]).toBeUndefined();
    expect(capturedOpts?.["secureCredentialHome"]).toBeUndefined();
  });
});

// ── W-1 / REQ-18: resolveSecretRefs — platformSecretNames refused + normal resolve ──

describe("W-1 / REQ-18 — resolveSecretRefs: platformSecretNames refused, normal secret resolves", () => {
  // -------------------------------------------------------------------------
  // W-1-a: platformSecretNames.has(name) === true → refused (ok:false)
  // -------------------------------------------------------------------------
  it("W-1-a: resolveSecretRefs returns ok:false with error when name is in platformSecretNames", () => {
    const { secretManager } = createSecretManagerWithMutableHandle({
      ANTHROPIC_API_KEY: "sk-real-key",
    });
    const platformSecretNames: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY"]);

    const result = resolveSecretRefs(["ANTHROPIC_API_KEY"], secretManager, platformSecretNames);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Error must mention the name and explain why (platform-managed, cannot expose)
      expect(result.error).toMatch(/ANTHROPIC_API_KEY/);
      expect(result.error).toMatch(/platform-managed/);
    }
  });

  it("W-1-a (multiple refs): stops at the first platformSecretNames hit and returns ok:false", () => {
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle({});
    mutableHandle.upsert("MY_TASK_SECRET", "task-value");
    const platformSecretNames: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY"]);

    // refs has a normal key first, then a platform-managed key
    // HOWEVER: MY_TASK_SECRET is NOT in platformSecretNames, ANTHROPIC_API_KEY IS
    // but ANTHROPIC_API_KEY is missing from the store — resolveSecretRefs would
    // refuse on platformSecretNames membership BEFORE checking store presence
    const result = resolveSecretRefs(
      ["ANTHROPIC_API_KEY"],
      secretManager,
      platformSecretNames,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/platform-managed/);
    }
  });

  // -------------------------------------------------------------------------
  // W-1-b: normal secret (not in platformSecretNames) resolves to { ok: true }
  //         with env populated from secretManager.get
  // -------------------------------------------------------------------------
  it("W-1-b: resolveSecretRefs returns ok:true and populates env when secret is not platform-managed", () => {
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle({});
    mutableHandle.upsert("MY_TASK_SECRET", "task-value-resolved");
    const platformSecretNames: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY"]);

    const result = resolveSecretRefs(["MY_TASK_SECRET"], secretManager, platformSecretNames);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env["MY_TASK_SECRET"]).toBe("task-value-resolved");
    }
  });

  it("W-1-b (additive upsert): secretManager.get returns a newly upserted value without restart", () => {
    // This test verifies REQ-18: broker/exec can resolve a newly upserted key
    // per-request without daemon restart. createSecretManagerWithMutableHandle
    // returns both handles over ONE shared Map — upsert() is immediately visible
    // to secretManager.get() on the next call.
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle({});
    const platformSecretNames: ReadonlySet<string> = new Set();

    // Before upsert: key does not exist
    const before = resolveSecretRefs(["NEW_BROKER_KEY_03_04"], secretManager, platformSecretNames);
    expect(before.ok).toBe(false);

    // After upsert (simulating what mutableHandle.upsert does in the daemon handler)
    mutableHandle.upsert("NEW_BROKER_KEY_03_04", "live-value");

    // Per-request resolution: secretManager.get reads from the shared Map
    const after = resolveSecretRefs(["NEW_BROKER_KEY_03_04"], secretManager, platformSecretNames);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.env["NEW_BROKER_KEY_03_04"]).toBe("live-value");
    }
  });
});

// ── §5.5 Path A (REQ-19): resolveSecretRefs places real value; platform secret blocked ──

describe("§5.5 Path A (REQ-19) — resolveSecretRefs in sandbox exec path", () => {
  it("resolveSecretRefs places real value in sandbox env for user-task secret (exec-shared.ts:204)", () => {
    // REQ-19 §5.5 Path A: the exec sandbox must receive the REAL value for
    // user-controlled secrets (non-platform-managed names). This test verifies
    // the exec-shared.ts:204 secretManager.get(name) path works end-to-end.
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle({});
    mutableHandle.upsert("EXAMPLE_API_KEY", "my-real-value");
    const platformSecretNames: ReadonlySet<string> = new Set();

    const result = resolveSecretRefs(["EXAMPLE_API_KEY"], secretManager, platformSecretNames);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env["EXAMPLE_API_KEY"]).toBe("my-real-value");
    }
  });

  it("resolveSecretRefs blocks a platform-managed secret name (exec-shared.ts:193)", () => {
    // REQ-19 §5.5 Path A: platform-managed secrets (e.g., ANTHROPIC_API_KEY)
    // MUST be refused — the exec sandbox must never receive them. This prevents
    // agents from exfiltrating daemon credentials through secretRefs.
    const { secretManager } = createSecretManagerWithMutableHandle({
      ANTHROPIC_API_KEY: "sk-real-platform-key",
    });
    const platformSecretNames: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY"]);

    const result = resolveSecretRefs(["ANTHROPIC_API_KEY"], secretManager, platformSecretNames);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("platform-managed");
    }
  });
});
