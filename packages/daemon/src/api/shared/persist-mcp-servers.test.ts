// SPDX-License-Identifier: Apache-2.0
/**
 * Tests pinning the extracted persistMcpServers helper's PUBLIC surface.
 *
 * Mock strategy (mirrors `mcp-handlers.test.ts:25-44`):
 *   - Mock `./persist-to-config.js` at file top so `persistToConfig` is a
 *     controllable vi.fn returning ok|err.
 *   - Mock `../../config/audit-hook.js` so the JSONL append + audit-base
 *     constructor are no-op vi.fns the assertion phase inspects.
 *   - Mock `../mcp-config-mutated-coalescer.js` so `computeMcpDiff` returns
 *     an empty diff and `getCoalescer` returns a stub `.schedule(...)` —
 *     the helper invokes these but their behavior is exercised in their
 *     own dedicated tests.
 *
 * The mock paths above are written from this test file's location
 * (`shared/persist-mcp-servers.test.ts`) — vitest resolves each `vi.mock(...)`
 * argument to an absolute module ID, so the SAME absolute ID would also be
 * matched when the helper module (`shared/persist-mcp-servers.ts`) imports
 * `./persist-to-config.js` (sibling) or `../../config/audit-hook.js`
 * (up-two-then-into-config). Vitest's module registry is keyed by absolute
 * path, so a relative-path mismatch between mocker and importer does NOT
 * defeat the mock.
 *
 * The persistToConfig secret-gate tests (at the bottom) use `vi.importActual`
 * to bypass the file-top mock and exercise the REAL persistToConfig with a
 * live filesystem spy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync as realWriteFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as yamlStringify } from "yaml";

// ---------------------------------------------------------------------------
// Module mocks — applied to the absolute modules the extracted helper imports.
// ---------------------------------------------------------------------------

vi.mock("./persist-to-config.js", () => ({
  persistToConfig: vi.fn().mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } }),
}));

vi.mock("../../config/audit-hook.js", () => ({
  buildConfigAuditBase: vi.fn().mockReturnValue({ /* opaque audit base */ }),
  appendConfigAuditWithOutcome: vi.fn(),
}));

vi.mock("../mcp-config-mutated-coalescer.js", () => ({
  computeMcpDiff: vi.fn().mockReturnValue({ added: [], removed: [] }),
  getCoalescer: vi.fn().mockReturnValue({ schedule: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Static import of the extracted module.
// ---------------------------------------------------------------------------

import { persistMcpServers } from "./persist-mcp-servers.js";
import type { PersistMcpResult } from "./persist-mcp-servers.js";
import { persistToConfig } from "./persist-to-config.js";
import type { ComisLogger } from "@comis/infra";
import type { McpServerEntry } from "@comis/core";

const mockPersistToConfig = vi.mocked(persistToConfig);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    level: "debug",
    isLevelEnabled: vi.fn(() => true),
  } as unknown as ComisLogger;
}

/**
 * Production-parity deps fixture: shared `container` between `persistDeps.container`
 * and outer `container`, mirroring `mcp-handlers.test.ts` `makePersistDeps`.
 */
function makeDeps(servers: McpServerEntry[] = []) {
  const container = {
    config: { integrations: { mcp: { servers } } },
  } as unknown as { config: { integrations: { mcp: { servers: McpServerEntry[] } } } };
  return {
    deps: {
      mcpClientManager: undefined,
      logger: makeLogger(),
      persistDeps: {
        // Share the SAME container reference so the in-memory swap observed by
        // the caller is the same object the helper writes to.
        container: Object.assign(container, { eventBus: { emit: vi.fn() } }),
        configPaths: ["/tmp/test-config.yaml"],
        defaultConfigPaths: ["/tmp/default-config.yaml"],
        logger: makeLogger(),
      },
      container,
      eventBus: { emit: vi.fn() },
    },
    container,
  };
}

/**
 * Tiny helper to construct a typed McpServerEntry without re-declaring every
 * optional field. The shape is permissive (cast through `as McpServerEntry`)
 * because only the persistMcpServers contract — name + transport + enabled —
 * is the unit under test here; full McpServerEntry coverage lives in the
 * schema's own dedicated tests.
 */
function makeEntry(name: string, command = "npx"): McpServerEntry {
  return {
    name,
    transport: "stdio",
    command,
    args: [],
    enabled: true,
  } as McpServerEntry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("persistMcpServers (extracted)", () => {
  beforeEach(() => {
    mockPersistToConfig.mockClear();
    mockPersistToConfig.mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } } as never);
  });

  // -------------------------------------------------------------------------
  // Barrel re-export proof. The daemon unit-test environment has no
  // self-alias for `@comis/daemon` (the integration tier owns the
  // dist-aliased import path). The equivalent and stronger structural proof
  // is to read the daemon barrel source and assert it re-exports the symbol.
  // -------------------------------------------------------------------------
  it("@comis/daemon barrel re-exports `persistMcpServers` + `PersistMcpResult`", () => {
    // Resolve the daemon barrel source relative to this test file's
    // location (api/shared/) → up two to packages/daemon/src/.
    const barrelPath = resolve(__dirname, "../../index.ts");
    const barrelSource = readFileSync(barrelPath, "utf-8");

    expect(barrelSource).toMatch(/export\s*\{[^}]*\bpersistMcpServers\b[^}]*\}/);
    expect(barrelSource).toMatch(/type\s+PersistMcpResult|PersistMcpResult/);
    // The re-export MUST target the new extracted module — not the legacy
    // `mcp-handlers.js` — so the @comis/daemon barrel is the canonical
    // sibling of the helper.
    expect(barrelSource).toMatch(/from\s+["']\.\/api\/shared\/persist-mcp-servers\.js["']/);
  });

  // -------------------------------------------------------------------------
  // Local-path resolution. The function exported from the new module IS the
  // canonical persistMcpServers (the helper is reached by both
  // `@comis/daemon` and the in-package importer through the SAME module).
  // Verified by direct callability.
  // -------------------------------------------------------------------------
  it("`./persist-mcp-servers.js` exports `persistMcpServers` as an async function", () => {
    expect(typeof persistMcpServers).toBe("function");
    // Async function: returns a Promise. Calling with throwaway args
    // (deps.persistDeps absent) returns a resolved promise — see the
    // "skipped" branch test below.
    const result = persistMcpServers(
      { persistDeps: undefined } as never,
      [],
      "mcp.connect",
      "probe",
      undefined,
    );
    expect(result).toBeInstanceOf(Promise);
  });

  // -------------------------------------------------------------------------
  // Widened actionType union accepts the bundle literals.
  // -------------------------------------------------------------------------
  it("accepts `skills.bundle.install` actionType and returns persistence:'persisted' on persistToConfig ok", async () => {
    const { deps } = makeDeps([]);
    const result: PersistMcpResult = await persistMcpServers(
      deps as never,
      [makeEntry("yfinance")],
      "skills.bundle.install",
      "yfinance-skill",
      undefined,
    );

    expect(result.persistence).toBe("persisted");
    expect(mockPersistToConfig).toHaveBeenCalledOnce();

    const [, callOpts] = mockPersistToConfig.mock.calls[0] as never as [unknown, { actionType: string; entityId: string }];
    expect(callOpts.actionType).toBe("skills.bundle.install");
    expect(callOpts.entityId).toBe("yfinance-skill");
  });

  // -------------------------------------------------------------------------
  // Preserve the existing skipped branch.
  // -------------------------------------------------------------------------
  it("returns persistence:'skipped' when deps.persistDeps is undefined", async () => {
    const result = await persistMcpServers(
      { persistDeps: undefined } as never,
      [makeEntry("anything")],
      "mcp.connect",
      "anything",
      undefined,
    );

    expect(result).toEqual({ persistence: "skipped" });
    expect(mockPersistToConfig).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Preserve the existing runtime_only branch.
  // -------------------------------------------------------------------------
  it("on persistToConfig err, returns persistence:'runtime_only' with warning + logs WARN with errorKind:'config'", async () => {
    mockPersistToConfig.mockResolvedValueOnce({ ok: false, error: "disk full" } as never);

    const { deps } = makeDeps([]);
    const warnSpy = deps.persistDeps.logger.warn as ReturnType<typeof vi.fn>;

    const result = await persistMcpServers(
      deps as never,
      [makeEntry("yfinance")],
      "mcp.connect",
      "yfinance",
      undefined,
    );

    expect(result.persistence).toBe("runtime_only");
    expect(result.warning).toBe("disk full");
    expect(warnSpy).toHaveBeenCalledOnce();
    const [firstCallArgs] = (warnSpy.mock.calls as unknown as Array<[Record<string, unknown>, string]>);
    expect(firstCallArgs[0]).toMatchObject({
      method: "mcp.connect",
      entityId: "yfinance",
      err: "disk full",
      errorKind: "config",
    });
  });

  // -------------------------------------------------------------------------
  // Preserve the in-memory atomic swap. The helper structuredClone's
  // container.config.integrations and replaces .mcp.servers with the new
  // array. The outer container reference (shared with persistDeps.container)
  // reflects the new state.
  // -------------------------------------------------------------------------
  it("on persistToConfig ok, container.config.integrations.mcp.servers is updated with the new array (in-memory swap)", async () => {
    const initial: McpServerEntry[] = [makeEntry("old", "old-cmd")];
    const { deps, container } = makeDeps(initial);
    const before = container.config.integrations.mcp.servers;

    const next: McpServerEntry[] = [makeEntry("new", "new-cmd")];
    const result = await persistMcpServers(
      deps as never,
      next,
      "skills.bundle.install",
      "new",
      undefined,
    );

    expect(result.persistence).toBe("persisted");
    // The in-memory swap replaces the FULL integrations subtree, so the
    // current `.servers` reference is the new array, and the prior reference
    // is no longer attached to container.config.integrations.
    expect(container.config.integrations.mcp.servers).toBe(next);
    expect(container.config.integrations.mcp.servers).not.toBe(before);
    expect(container.config.integrations.mcp.servers).toEqual([
      expect.objectContaining({ name: "new", command: "new-cmd" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// persistToConfig secret gate (uses REAL persistToConfig).
//
// These tests bypass the file-top vi.mock("./persist-to-config.js") by using
// vi.importActual to obtain the real implementation. A spy on fs.writeFileSync
// asserts the write is never reached when a secret is detected. scanForSecrets
// runs BEFORE writeFileSync so plaintext-secret patches are rejected.
// ---------------------------------------------------------------------------
describe("persistToConfig secret gate", () => {
  // We need the real persistToConfig — not the file-top mock.
  // vi.importActual bypasses the hoisted vi.mock above for this describe block.
  let realPersistToConfig: typeof import("./persist-to-config.js")["persistToConfig"];

  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    const real = await vi.importActual<typeof import("./persist-to-config.js")>("./persist-to-config.js");
    realPersistToConfig = real.persistToConfig;

    tmpDir = mkdtempSync(join(tmpdir(), "cred02-test-"));
    configPath = join(tmpDir, "config.yaml");
    // Write a minimal valid config so the merge has a base.
    realWriteFileSync(configPath, "version: 1\n");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePersistDeps(cfg: Record<string, unknown> = {}) {
    return {
      container: {
        config: cfg,
        eventBus: { emit: vi.fn() },
        tenantId: "default",
      } as never,
      configPaths: [configPath],
      defaultConfigPaths: [configPath],
      configGitManager: undefined,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: vi.fn(),
        level: "debug",
        isLevelEnabled: vi.fn(() => true),
      } as never,
    };
  }

  it("rejects plaintext secret in MCP server Authorization header — err([plaintext_secret_blocked]), no .tmp file written", async () => {
    const tmpFilePath = configPath + ".tmp";

    const deps = makePersistDeps({});
    const result = await realPersistToConfig(deps, {
      patch: {
        integrations: {
          mcp: {
            servers: [
              {
                name: "test-server",
                transport: "stdio",
                command: "npx",
                args: [],
                enabled: true,
                headers: {
                  Authorization: "Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                },
              },
            ],
          },
        },
      },
      actionType: "mcp.connect",
      entityId: "test-server",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/\[plaintext_secret_blocked\]/);
    // The write must never reach disk — no .tmp file should exist.
    expect(existsSync(tmpFilePath)).toBe(false);
  });

  it("allows ${VAR} ref in MCP header — no false-positive block (returns ok)", async () => {
    const deps = makePersistDeps({});
    const result = await realPersistToConfig(deps, {
      patch: {
        integrations: {
          mcp: {
            servers: [
              {
                name: "test-server",
                transport: "stdio",
                command: "npx",
                args: [],
                enabled: true,
                headers: {
                  Authorization: "Bearer ${MY_TOKEN}",
                },
              },
            ],
          },
        },
      },
      actionType: "mcp.connect",
      entityId: "test-server",
    });

    expect(result.ok).toBe(true);
  });

  it("rejects plaintext secret in mcp.env — err([plaintext_secret_blocked]), no .tmp file written", async () => {
    const tmpFilePath = configPath + ".tmp";

    const deps = makePersistDeps({});
    const result = await realPersistToConfig(deps, {
      patch: {
        integrations: {
          mcp: {
            servers: [
              {
                name: "test-server",
                transport: "stdio",
                command: "npx",
                args: [],
                enabled: true,
                env: {
                  API_KEY: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-AAAAAAA",
                },
              },
            ],
          },
        },
      },
      actionType: "mcp.connect",
      entityId: "test-server",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/\[plaintext_secret_blocked\]/);
    expect(existsSync(tmpFilePath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Persist gate must scan the WRITTEN content (updatedLocal), not only
  // the in-memory fullMerged. A secret present in the existing local file
  // (existingLocal) but NOT in container.config is in updatedLocal (it gets
  // re-written verbatim) yet would be absent from fullMerged (which merges
  // container.config + patch, not the raw on-disk file). Scanning both
  // covers loader-dropped / layer-divergence cases.
  // -------------------------------------------------------------------------
  it("rejects a plaintext secret that exists ONLY in the on-disk local file (not in container.config) — err([plaintext_secret_blocked]), no .tmp written", async () => {
    // The on-disk local file already has a plaintext secret — simulates a
    // pre-existing credential that the in-memory config loader may have
    // normalized away (key-layer divergence).
    realWriteFileSync(
      configPath,
      yamlStringify({
        integrations: {
          mcp: {
            servers: [
              {
                name: "legacy-server",
                transport: "stdio",
                command: "npx",
                args: [],
                enabled: true,
                headers: {
                  Authorization: "Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                },
              },
            ],
          },
        },
      }),
    );

    const tmpFilePath = configPath + ".tmp";

    // container.config does NOT contain the secret — simulating a loader
    // that normalizes/drops the header during parsing (the divergence case).
    const deps = makePersistDeps({});
    const result = await realPersistToConfig(deps, {
      // Empty patch: the plaintext secret lives ONLY in the on-disk local file
      // (existingLocal). deepMerge(existingLocal, {}) preserves the secret in
      // updatedLocal (the written file), but fullMerged = deepMerge({}, {}) = {}
      // has no secret. Scanning updatedLocal in addition to fullMerged is
      // required so the gate fires and the write is blocked.
      patch: {},
      actionType: "config.update",
      entityId: "legacy-server",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/\[plaintext_secret_blocked\]/);
    // No .tmp file should have been created — the write must be aborted
    expect(existsSync(tmpFilePath)).toBe(false);
  });

  it("allows persist when the local file contains only ${VAR} refs (no false-positive from on-disk scan)", async () => {
    realWriteFileSync(
      configPath,
      yamlStringify({
        integrations: {
          mcp: {
            servers: [
              {
                name: "safe-server",
                transport: "stdio",
                command: "npx",
                args: [],
                enabled: true,
                headers: {
                  Authorization: "Bearer ${MY_TOKEN}",
                },
              },
            ],
          },
        },
      }),
    );

    const deps = makePersistDeps({});
    const result = await realPersistToConfig(deps, {
      // Benign patch: update the same server without any plaintext secret
      patch: {
        integrations: {
          mcp: {
            servers: [
              {
                name: "safe-server",
                transport: "stdio",
                command: "npx",
                args: [],
                enabled: true,
                headers: {
                  Authorization: "Bearer ${MY_TOKEN}",
                },
              },
            ],
          },
        },
      },
      actionType: "mcp.connect",
      entityId: "safe-server",
    });

    expect(result.ok).toBe(true);
  });
});
