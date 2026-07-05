// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for applyBundleInstall.
 *
 * Pins the public surface of the bundle-install-helper module.
 *
 * Atomic two-phase invariant is the headline test coverage:
 *   - Phase A reject (plaintext_secret / osv_malware / name_collision)
 *     ⇒ applyBundleInstall THROWS with the bracketed `[bundle_install_rejected:<kind>]`
 *     code AND `persistMcpServers` is invoked ZERO times AND
 *     `deps.mcpClientManager.connect` is invoked ZERO times.
 *
 * Phase A clean ⇒ persistMcpServers fires exactly once with the merged
 * `nextServers` array AND `manager.connect` fires exactly once per entry in
 * the connectQueue.
 *
 * Mock strategy:
 *   - vi.mock("../api/shared/persist-mcp-servers.js") — controllable spy
 *     proving zero-write under Phase A reject; assertable call args under
 *     Phase A clean.
 *   - vi.mock("@comis/skills") to override osvMalwareCheck (mirrors the
 *     resolver test pattern).
 *   - mcpClientManager.connect is a per-test vi.fn() on the deps fixture.
 *
 * Each test writes a SKILL.md to a tmpdir, calls applyBundleInstall, then
 * asserts on (a) the result shape, (b) `persistMcpServers` call count, and
 * (c) `mcpClientManager.connect` call count.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
//
// vi.hoisted lifts the spy declarations above the vi.mock factory bodies so
// the same vi.fn instance is shared between the test scope (assertions) and
// the mock module (intercepted call).

const mockPersistMcpServers = vi.hoisted(() =>
  vi.fn(async () => ({ persistence: "persisted" as const })),
);

const mockOsvMalwareCheck = vi.hoisted(() =>
  vi.fn(async (_pkg: string, _ecosystem: string, _opts: unknown) => ({
    verdict: "safe" as const,
    advisoryIds: [] as readonly string[],
  })),
);

vi.mock("../api/shared/persist-mcp-servers.js", () => ({
  persistMcpServers: mockPersistMcpServers,
}));

vi.mock("@comis/skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/skills")>();
  return {
    ...actual,
    osvMalwareCheck: mockOsvMalwareCheck,
  };
});

// ---------------------------------------------------------------------------
// Imports — applyBundleInstall is the symbol under test
// ---------------------------------------------------------------------------

import { applyBundleInstall, applyImportedBundleInstall } from "./bundle-install-helper.js";
import type { ComisLogger } from "@comis/infra";
import type { McpServerEntry } from "@comis/core";

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
    level: "info",
    isLevelEnabled: vi.fn(() => true),
  } as unknown as ComisLogger;
}

interface DepsOverrides {
  currentServers?: McpServerEntry[];
  connectImpl?: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: DepsOverrides = {}): {
  deps: Parameters<typeof applyBundleInstall>[0]["deps"];
  connectSpy: ReturnType<typeof vi.fn>;
} {
  const connectSpy =
    overrides.connectImpl ??
    vi.fn(async (config: { name: string }) => ({
      ok: true as const,
      value: {
        name: config.name,
        status: "connected" as const,
        tools: [] as unknown[],
      },
    }));
  const container = {
    config: {
      integrations: {
        mcp: {
          servers: overrides.currentServers ?? [],
        },
      },
    },
  } as unknown as Parameters<typeof applyBundleInstall>[0]["deps"]["container"];
  const deps = {
    getAgentBrowserService: vi.fn(),
    approvalGate: undefined,
    mcpClientManager: { connect: connectSpy } as never,
    skillRegistries: undefined,
    notificationService: undefined,
    execGit: vi.fn(),
    agents: {},
    defaultAgentId: "default-agent",
    defaultWorkspaceDir: "/tmp/ws",
    workspaceDirs: new Map<string, string>(),
    logger: makeLogger(),
    tenantId: "test-tenant",
    memoryApi: {} as never,
    memoryAdapter: {} as never,
    container,
    eventBus: undefined,
    persistDeps: {
      configPaths: ["/tmp/config.yaml"],
      defaultConfigPaths: ["/tmp/default.yaml"],
      logger: makeLogger(),
    } as never,
  } as Parameters<typeof applyBundleInstall>[0]["deps"];
  return { deps, connectSpy };
}

let tmpRoot: string;
let skillDir: string;

function writeSkillManifest(content: string): void {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8");
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), `bundle-install-helper-test-${randomUUID().slice(0, 8)}-`));
  skillDir = join(tmpRoot, "skill");
  mockPersistMcpServers.mockReset();
  mockPersistMcpServers.mockResolvedValue({ persistence: "persisted" as const });
  mockOsvMalwareCheck.mockReset();
  mockOsvMalwareCheck.mockImplementation(
    async (_pkg: string, _ecosystem: string, _opts: unknown) => ({
      verdict: "safe" as const,
      advisoryIds: [] as readonly string[],
    }),
  );
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------

describe("applyBundleInstall — atomic two-phase install hook", () => {
  // -------------------------------------------------------------------------
  // 1. No mcpServers block in SKILL.md ⇒ silent no-op.
  //    Asserts: persistMcpServers called 0 times, manager.connect called 0 times,
  //    result.persistence === "skipped".
  // -------------------------------------------------------------------------
  it("no mcpServers block in SKILL.md ⇒ skipped no-op with ZERO writes and ZERO connects", async () => {
    writeSkillManifest("---\nname: plain-skill\ndescription: no bundle\n---\nBody\n");
    const { deps, connectSpy } = makeDeps();

    const result = await applyBundleInstall({
      skillId: "plain-skill",
      skillDir,
      force: false,
      ctx: undefined,
      deps,
    });

    expect(result.persistence).toBe("skipped");
    expect(mockPersistMcpServers.mock.calls.length).toBe(0);
    expect(connectSpy.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. Empty mcpServers array ⇒ silent no-op (identical to Test 1).
  // -------------------------------------------------------------------------
  it("empty mcpServers array ⇒ skipped no-op with ZERO writes and ZERO connects", async () => {
    writeSkillManifest(
      "---\nname: empty-bundle-skill\ndescription: empty\nmcpServers: []\n---\nBody\n",
    );
    const { deps, connectSpy } = makeDeps();

    const result = await applyBundleInstall({
      skillId: "empty-bundle-skill",
      skillDir,
      force: false,
      ctx: undefined,
      deps,
    });

    expect(result.persistence).toBe("skipped");
    expect(mockPersistMcpServers.mock.calls.length).toBe(0);
    expect(connectSpy.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. Phase A reject (plaintext secret) — atomic invariant.
  //    Asserts: applyBundleInstall throws with [bundle_install_rejected:plaintext_secret]
  //    AND persistMcpServers called 0 times AND manager.connect called 0 times.
  // -------------------------------------------------------------------------
  it("Phase A reject (plaintext_secret) ⇒ throws + ZERO writes + ZERO connects (atomic)", async () => {
    writeSkillManifest(
      [
        "---",
        "name: leaky-skill",
        "description: ships a credential",
        "mcpServers:",
        "  - name: leaky",
        "    transport: stdio",
        "    command: npx",
        "    args: [some-pkg]",
        "    env:",
        "      OPENAI_API_KEY: sk-abc1234567890abcdef1234567890abcdef",
        "---",
        "Body",
      ].join("\n"),
    );
    const { deps, connectSpy } = makeDeps();

    await expect(
      applyBundleInstall({
        skillId: "leaky-skill",
        skillDir,
        force: false,
        ctx: undefined,
        deps,
      }),
    ).rejects.toThrow(/\[bundle_install_rejected:plaintext_secret\]/);

    // Atomic invariant: Phase A reject ⇒ ZERO side effects.
    expect(mockPersistMcpServers.mock.calls.length).toBe(0);
    expect(connectSpy.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. Phase A reject (OSV malware) on a 3-entry bundle — the hero scenario.
  //    Entry 2 trips OSV; entries 1 and 3 are clean. Atomic invariant: ZERO
  //    writes, ZERO connects despite 2/3 entries being safe.
  // -------------------------------------------------------------------------
  it("Phase A reject (osv_malware) on 3-entry bundle with entry 2 malicious ⇒ ZERO writes + ZERO connects (atomic invariant)", async () => {
    mockOsvMalwareCheck.mockImplementation(async (pkg: string) => {
      if (pkg === "malicious-pkg") {
        return { verdict: "malicious" as const, advisoryIds: ["MAL-2024-0001"] };
      }
      return { verdict: "safe" as const, advisoryIds: [] };
    });
    writeSkillManifest(
      [
        "---",
        "name: partially-bad-skill",
        "description: 3 entries; entry 2 malicious",
        "mcpServers:",
        "  - name: clean1",
        "    transport: stdio",
        "    command: npx",
        "    args: [clean-pkg-1]",
        "  - name: bad",
        "    transport: stdio",
        "    command: npx",
        "    args: [malicious-pkg]",
        "  - name: clean2",
        "    transport: stdio",
        "    command: npx",
        "    args: [clean-pkg-2]",
        "---",
        "Body",
      ].join("\n"),
    );
    const { deps, connectSpy } = makeDeps();

    await expect(
      applyBundleInstall({
        skillId: "partially-bad-skill",
        skillDir,
        force: false,
        ctx: undefined,
        deps,
      }),
    ).rejects.toThrow(/\[bundle_install_rejected:osv_malware\]/);

    // The canonical atomic-invariant gate: Phase A reject on entry 2 ⇒
    // NO persist call (despite entries 1 and 3 being safe); NO connect call.
    expect(mockPersistMcpServers.mock.calls.length).toBe(0);
    expect(connectSpy.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. Phase A clean ⇒ persistMcpServers fires once + manager.connect fires
  //    per entry (Phase B commit).
  //    Asserts: result.persistence === "persisted", persistMcpServers called
  //    EXACTLY once with the merged servers array, manager.connect called
  //    once per bundle entry.
  // -------------------------------------------------------------------------
  it("Phase A clean ⇒ persistMcpServers called once + manager.connect called once per entry (atomic commit)", async () => {
    writeSkillManifest(
      [
        "---",
        "name: clean-bundle-skill",
        "description: 2 safe stdio entries",
        "mcpServers:",
        "  - name: alpha",
        "    transport: stdio",
        "    command: npx",
        "    args: [pkg-alpha]",
        "  - name: bravo",
        "    transport: stdio",
        "    command: npx",
        "    args: [pkg-bravo]",
        "---",
        "Body",
      ].join("\n"),
    );
    const { deps, connectSpy } = makeDeps();

    const result = await applyBundleInstall({
      skillId: "clean-bundle-skill",
      skillDir,
      force: false,
      ctx: undefined,
      deps,
    });

    expect(result.persistence).toBe("persisted");
    // Single atomic write commits all entries.
    expect(mockPersistMcpServers.mock.calls.length).toBe(1);
    // Verify the actionType + entityId + skillId thread through to the persist call.
    const persistArgs = mockPersistMcpServers.mock.calls[0]!;
    expect(persistArgs[2]).toBe("skills.bundle.install");
    expect(persistArgs[3]).toBe("clean-bundle-skill");
    // Verify the merged array contains BOTH new bundle entries, each tagged
    // with _bundleSource.
    const persistedServers = persistArgs[1] as McpServerEntry[];
    expect(persistedServers.length).toBe(2);
    expect(persistedServers.every((s) => s._bundleSource === "clean-bundle-skill")).toBe(true);
    expect(persistedServers.find((s) => s.name === "alpha")).toBeDefined();
    expect(persistedServers.find((s) => s.name === "bravo")).toBeDefined();
    // Phase B sequential connect: one call per entry.
    expect(connectSpy.mock.calls.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 6. Name-collision with user entry, force=false ⇒ reject.
  //    The user has a pre-existing "yfinance" entry (no _bundleSource — so
  //    classified as user-owned). The bundle ships a "yfinance" too. Without
  //    --force, the resolver returns name_collision; the helper throws with
  //    the bracketed code and persistMcpServers/connect are called 0 times.
  //    The existing user entry is NOT touched.
  // -------------------------------------------------------------------------
  it("name-collision with user entry, force=false ⇒ throws name_collision + ZERO writes + ZERO connects", async () => {
    const userEntry: McpServerEntry = {
      name: "yfinance",
      transport: "http",
      url: "https://my.proxy/yfinance",
      enabled: true,
      idleTtlMs: 0,
    } as McpServerEntry;
    writeSkillManifest(
      [
        "---",
        "name: yfin-skill",
        "description: collides with user yfinance",
        "mcpServers:",
        "  - name: yfinance",
        "    transport: stdio",
        "    command: npx",
        "    args: [yfinance-mcp]",
        "---",
        "Body",
      ].join("\n"),
    );
    const { deps, connectSpy } = makeDeps({ currentServers: [userEntry] });

    await expect(
      applyBundleInstall({
        skillId: "yfin-skill",
        skillDir,
        force: false,
        ctx: undefined,
        deps,
      }),
    ).rejects.toThrow(/\[bundle_install_rejected:name_collision\]/);

    // Atomic: the user's existing yfinance entry is UNTOUCHED because the
    // persist call never fires.
    expect(mockPersistMcpServers.mock.calls.length).toBe(0);
    expect(connectSpy.mock.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 7. Name-collision with user entry, force=true ⇒ user entry archived to
  //    _bundleArchive; persist + connect proceed.
  //    Asserts: persistMcpServers called once. The persisted entry for
  //    "yfinance" carries _bundleSource === skillId AND _bundleArchive set
  //    to the prior user entry shape.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // 8. Bundle entry with explicit `cwd` MUST forward to manager.connect.
  //    If `buildRuntimeConfig` omits `cwd`, a bundle declaring
  //    `cwd: "/specific/dir"` connects with the default workspace cwd at
  //    install-time, silently mis-rooting the MCP child until the next daemon
  //    restart. The next-restart setupMcp path reads cwd correctly so the
  //    persisted entry is always correct — the regression risk is the
  //    install-time connect's runtime config projection.
  // -------------------------------------------------------------------------
  it("bundle entry with explicit cwd forwards to manager.connect at install time", async () => {
    writeSkillManifest(
      [
        "---",
        "name: cwd-skill",
        "description: entry with explicit cwd",
        "mcpServers:",
        "  - name: rooted",
        "    transport: stdio",
        "    command: npx",
        "    args: [some-pkg]",
        "    cwd: /opt/skill-roots/rooted",
        "---",
        "Body",
      ].join("\n"),
    );
    const { deps, connectSpy } = makeDeps();

    const result = await applyBundleInstall({
      skillId: "cwd-skill",
      skillDir,
      force: false,
      ctx: undefined,
      deps,
    });

    expect(result.persistence).toBe("persisted");
    expect(connectSpy.mock.calls.length).toBe(1);
    const connectArg = connectSpy.mock.calls[0]![0] as { cwd?: string };
    // The cwd field must reach manager.connect — omitting it from
    // buildRuntimeConfig's field projection would mis-root the MCP child.
    expect(connectArg.cwd).toBe("/opt/skill-roots/rooted");
  });

  it("name-collision with user entry, force=true ⇒ user entry archived to _bundleArchive; persist + connect proceed (force override)", async () => {
    const userEntry: McpServerEntry = {
      name: "yfinance",
      transport: "http",
      url: "https://my.proxy/yfinance",
      enabled: true,
      idleTtlMs: 0,
    } as McpServerEntry;
    writeSkillManifest(
      [
        "---",
        "name: yfin-skill-force",
        "description: collides + force=true",
        "mcpServers:",
        "  - name: yfinance",
        "    transport: stdio",
        "    command: npx",
        "    args: [yfinance-mcp]",
        "---",
        "Body",
      ].join("\n"),
    );
    const { deps, connectSpy } = makeDeps({ currentServers: [userEntry] });

    const result = await applyBundleInstall({
      skillId: "yfin-skill-force",
      skillDir,
      force: true,
      ctx: undefined,
      deps,
    });

    expect(result.persistence).toBe("persisted");
    expect(mockPersistMcpServers.mock.calls.length).toBe(1);
    const persistArgs = mockPersistMcpServers.mock.calls[0]!;
    const persistedServers = persistArgs[1] as McpServerEntry[];
    // After --force: yfinance entry is the bundle's stdio shape, with the user
    // http entry archived under _bundleArchive.
    const yfin = persistedServers.find((s) => s.name === "yfinance");
    expect(yfin).toBeDefined();
    expect(yfin?._bundleSource).toBe("yfin-skill-force");
    expect(yfin?._bundleArchive).toBeDefined();
    expect(yfin?._bundleArchive?.transport).toBe("http");
    expect(yfin?._bundleArchive?.url).toBe("https://my.proxy/yfinance");
    // Connect fires for the bundle entry.
    expect(connectSpy.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applyImportedBundleInstall — the imported trust tier's persist path.
//
// The imported tier's teeth: a bundled MCP entry persists DISABLED and is NEVER
// auto-connected at install (the operator opts in per server later; each later
// connect re-runs the malware/secret checks at the connect site). Contrast with
// applyBundleInstall above (the trusted create/upload path), which persists
// enabled + connects. The ownership ledger is recorded either way so a later
// skills.delete can disconnect + remove exactly these entries.
// ---------------------------------------------------------------------------

describe("applyImportedBundleInstall — imported-tier persist-disabled + no auto-connect", () => {
  it("persists every bundled entry enabled:false, NEVER connects, and records the ownership ledger", async () => {
    const { deps, connectSpy } = makeDeps();
    const dataDir = join(tmpRoot, "imported-data");
    const bundleEntries = [
      { name: "imp-alpha", transport: "stdio", command: "npx", args: ["pkg-alpha"], enabled: true },
      { name: "imp-bravo", transport: "stdio", command: "npx", args: ["pkg-bravo"], enabled: true },
    ] as unknown as McpServerEntry[];

    const result = await applyImportedBundleInstall(
      deps,
      dataDir,
      {
        skillId: "imported-skill",
        nextServers: [...bundleEntries],
        bundleEntries,
      },
      undefined,
    );

    expect(result.ok).toBe(true);
    // Single atomic config write.
    expect(mockPersistMcpServers.mock.calls.length).toBe(1);
    const persisted = mockPersistMcpServers.mock.calls[0]![1] as McpServerEntry[];
    // Every bundled entry lands DISABLED — the imported-tier invariant.
    expect(persisted.find((s) => s.name === "imp-alpha")?.enabled).toBe(false);
    expect(persisted.find((s) => s.name === "imp-bravo")?.enabled).toBe(false);
    // NEVER auto-connect at import — the operator opts in per server later.
    expect(connectSpy.mock.calls.length).toBe(0);
    // The ownership ledger records the entries so skills.delete can unwind them.
    const ledger = JSON.parse(
      readFileSync(join(dataDir, "installed-bundles.json"), "utf-8"),
    ) as Record<string, Record<string, string>>;
    expect(Object.keys(ledger["imported-skill"] ?? {}).sort()).toEqual([
      "imp-alpha",
      "imp-bravo",
    ]);
  });

  it("returns err when the config write does not persist (fail-closed)", async () => {
    const { deps, connectSpy } = makeDeps();
    mockPersistMcpServers.mockResolvedValueOnce({
      persistence: "runtime_only" as const,
      warning: "disk write failed",
    });
    const dataDir = join(tmpRoot, "imported-data-2");
    const bundleEntries = [
      { name: "imp-only", transport: "stdio", command: "npx", args: ["pkg"], enabled: true },
    ] as unknown as McpServerEntry[];

    const result = await applyImportedBundleInstall(
      deps,
      dataDir,
      { skillId: "imported-skill-2", nextServers: [...bundleEntries], bundleEntries },
      undefined,
    );

    expect(result.ok).toBe(false);
    // A non-imported entry (not in the bundle set) is left untouched, and the
    // import still never connects even on the persist-failure path.
    expect(connectSpy.mock.calls.length).toBe(0);
  });
});
