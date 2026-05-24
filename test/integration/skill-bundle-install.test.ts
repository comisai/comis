// SPDX-License-Identifier: Apache-2.0
//
// Phase 68 BUNDLE-06/03 — skill-bundle install + boot re-merge integration test.
//
// This is the CAPSTONE acceptance test for Phase 68. It exercises the REAL
// persistToConfig + appendConfigAuditWithOutcome + bundle-resolver chain
// against a tmpdir-backed config.yaml. The unit tests in
// packages/daemon/src/skills/bundle-install-helper.test.ts +
// packages/daemon/src/wiring/setup-skill-bundles.test.ts mock persistMcpServers
// and assert call args; this integration test catches what mocks cannot:
//
//   - BUNDLE-06 (atomic invariant): a 3-entry bundle where entry 2 trips OSV
//     produces ZERO bytes written to config.yaml AND ZERO manager.connect
//     calls. The throw fires before any side effect.
//
//   - BUNDLE-06 (Phase A clean): a 2-entry clean bundle's full round-trip —
//     manifest → resolver → install-helper → persisted YAML on disk — yields
//     both entries with their _bundleSource provenance markers and the
//     correct per-entry shape.
//
//   - BUNDLE-03 (boot idempotence): setupSkillBundles called twice over the
//     same on-disk state produces byte-identical YAML output (skip-when-equal
//     short-circuit fires, no spurious YAML rewrite).
//
// NOTE on the mock surface: OSV is mocked deterministically (controllable
// malicious vs safe verdicts); persistToConfig is REAL; manager.connect is
// mocked to track call count (we are not testing transport spawn).
//
// Per CLAUDE.md "Integration (requires pnpm build first)": vitest aliases
// `@comis/*` to `packages/*/dist/index.js`, so a stale dist silently masks
// src changes. The orchestrate harness ensures pnpm build runs before this
// suite; running standalone requires `pnpm build` first.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

import {
  applyBundleInstall,
  setupSkillBundles,
  _resetSigusr1Timer,
  _resetMutationFence,
  _resetConfigMutatedCoalescer,
} from "@comis/daemon";
import type { ApplyBundleInstallArgs } from "@comis/daemon";
import type { McpServerEntry } from "@comis/core";
import type { SkillMetadata, SkillRegistry } from "@comis/skills";

// ---------------------------------------------------------------------------
// Hoisted OSV mock — deterministic malicious-vs-safe verdicts
// ---------------------------------------------------------------------------
//
// vi.mock("@comis/skills") replaces the module-level export so EVERY call
// site sees the controllable mock — including the resolver inside
// packages/daemon/dist/. The hoisted spy lets test code change the verdict
// per-scenario; default is "safe".

const mockOsvMalwareCheck = vi.hoisted(() =>
  vi.fn(async (pkg: string, _ecosystem: string, _opts: unknown) => {
    if (pkg === "malicious-pkg") {
      return { verdict: "malicious" as const, advisoryIds: ["MAL-2024-0001"] };
    }
    return { verdict: "safe" as const, advisoryIds: [] };
  }),
);

vi.mock("@comis/skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/skills")>();
  return {
    ...actual,
    osvMalwareCheck: mockOsvMalwareCheck,
  };
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tempDir: string;
let configPath: string;
let skillsRoot: string;
let auditLogPath: string;

function makeLogger() {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    level: "debug",
    isLevelEnabled: vi.fn(() => true),
    child: vi.fn(() => logger),
  };
  return logger;
}

function makeContainer(initialConfig: unknown) {
  return {
    config: initialConfig,
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
    tenantId: "test-tenant",
  };
}

function makePersistDeps(container: ReturnType<typeof makeContainer>) {
  return {
    container,
    configPaths: [configPath],
    defaultConfigPaths: [configPath],
    configGitManager: undefined,
    logger: makeLogger(),
  } as never;
}

function makeMcpManager() {
  const connections = new Map<string, { name: string }>();
  return {
    connect: vi.fn(async (cfg: { name: string }) => {
      connections.set(cfg.name, { name: cfg.name });
      return {
        ok: true as const,
        value: {
          name: cfg.name,
          status: "connected" as const,
          tools: [],
          client: null,
          lastHealthCheck: Date.now(),
          reconnectAttempt: 0,
          maxReconnectAttempts: 5,
          generation: 0,
        },
      };
    }),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
    getConnection: vi.fn((name: string) =>
      connections.has(name)
        ? { name, status: "connected", tools: [], client: null }
        : undefined,
    ),
    getAllConnections: vi.fn(() => Array.from(connections.values())),
    getTools: vi.fn(() => []),
    callTool: vi.fn(),
    reconnect: vi.fn(),
  };
}

interface BundleEntryFixture {
  readonly name: string;
  readonly transport: "stdio" | "sse" | "http";
  readonly command?: string;
  readonly args?: readonly string[];
}

function writeSkillManifest(skillName: string, bundle: readonly BundleEntryFixture[]): string {
  const skillDir = join(skillsRoot, skillName);
  mkdirSync(skillDir, { recursive: true });
  const entries = bundle
    .map((e) => {
      const lines: string[] = [`  - name: ${e.name}`, `    transport: ${e.transport}`];
      if (e.command !== undefined) lines.push(`    command: ${e.command}`);
      if (e.args !== undefined) {
        lines.push(`    args:`);
        for (const a of e.args) lines.push(`      - ${a}`);
      }
      return lines.join("\n");
    })
    .join("\n");
  const manifest = `---
name: ${skillName}
description: "${skillName} test skill"
type: prompt
mcpServers:
${entries}
---

# ${skillName}

Bundled-MCP test skill.
`;
  const skillMdPath = join(skillDir, "SKILL.md");
  writeFileSync(skillMdPath, manifest, "utf-8");
  return skillDir;
}

function makeRegistryStub(metadata: SkillMetadata[]): SkillRegistry {
  return {
    init: vi.fn(),
    loadPromptSkill: vi.fn(),
    getPromptSkillDescriptions: vi.fn(() => []),
    getUserInvocableSkillNames: vi.fn(() => new Set<string>()),
    getRelevantPromptSkills: vi.fn(() => []),
    getMetadataCount: vi.fn(() => metadata.length),
    getAllMetadata: vi.fn(() => metadata),
    getSnapshot: vi.fn(),
    getSnapshotVersion: vi.fn(() => 0),
    startWatching: vi.fn(),
    getEligibleSkillNames: vi.fn(() => new Set<string>()),
    getPromptSkillCapabilities: vi.fn(() => []),
    initFromSdkSkills: vi.fn(),
  } as unknown as SkillRegistry;
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach — fresh tmpdir + process-wide state resets
// ---------------------------------------------------------------------------

beforeEach(() => {
  // PROCESS-WIDE state resets — see persist-to-config.ts:12-43 +
  // mcp-config-mutated-coalescer.ts. Any test that exercises the real
  // persistToConfig writer + the trailing-edge coalescer must reset these
  // singletons in beforeEach so a prior test's armed timer / pending fence
  // does not leak into the next one.
  _resetSigusr1Timer();
  _resetMutationFence();
  _resetConfigMutatedCoalescer();
  tempDir = mkdtempSync(join(tmpdir(), "skill-bundle-install-int-"));
  configPath = join(tempDir, "config.yaml");
  auditLogPath = join(tempDir, "config-audit.jsonl");
  skillsRoot = join(tempDir, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  // Seed config with a non-MCP scaffold so AppConfigSchema.safeParse holds
  // through persistToConfig's pre-write validation. integrations.mcp.servers
  // starts empty.
  writeFileSync(
    configPath,
    "logLevel: info\nintegrations:\n  mcp:\n    servers: []\n",
    { mode: 0o600 },
  );
  process.env.COMIS_CONFIG_AUDIT_LOG = auditLogPath;
  mockOsvMalwareCheck.mockClear();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.COMIS_CONFIG_AUDIT_LOG;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 68 BUNDLE-06 / BUNDLE-03 — atomic install + boot idempotence (integration)", () => {
  it("BUNDLE-06 atomic invariant: 3-entry bundle, entry 2 trips OSV → ZERO YAML writes, ZERO manager.connect calls", async () => {
    // Setup: 3-entry bundle where entry 2's package is the controllable
    // mock's MAL verdict trigger. The resolver iterates manifest entries
    // sequentially during STEP 3 (OSV check); the first malicious verdict
    // short-circuits the WHOLE resolver and returns err. The install-helper
    // throws on err BEFORE any persistMcpServers or manager.connect call.
    const skillDir = writeSkillManifest("malicious-skill", [
      { name: "clean-1", transport: "stdio", command: "npx", args: ["clean-pkg-1"] },
      { name: "bad-2", transport: "stdio", command: "npx", args: ["malicious-pkg"] },
      { name: "clean-3", transport: "stdio", command: "npx", args: ["clean-pkg-3"] },
    ]);

    // Snapshot the baseline YAML — the assertion downstream is byte equality.
    const yamlBaseline = readFileSync(configPath, "utf-8");

    const container = makeContainer(parseYaml(yamlBaseline));
    const mcpClientManager = makeMcpManager();
    const deps = {
      mcpClientManager,
      logger: makeLogger(),
      container,
      persistDeps: makePersistDeps(container),
      eventBus: container.eventBus,
    } as unknown as ApplyBundleInstallArgs["deps"];

    // BUNDLE-06 atomic invariant — applyBundleInstall MUST throw with the
    // bracketed [bundle_install_rejected:osv_malware] code.
    await expect(
      applyBundleInstall({
        skillId: "malicious-skill",
        skillDir,
        force: false,
        ctx: undefined,
        deps,
      }),
    ).rejects.toThrow(/\[bundle_install_rejected:osv_malware\]/);

    // ZERO YAML writes: the on-disk file is byte-identical to the baseline.
    const yamlAfter = readFileSync(configPath, "utf-8");
    expect(yamlAfter).toBe(yamlBaseline);

    // ZERO manager.connect calls — the throw fired before Phase B.
    expect(mcpClientManager.connect).not.toHaveBeenCalled();

    // ZERO audit JSONL records — persistMcpServers never fired so the
    // appendConfigAuditWithOutcome never wrote a config.write event.
    expect(existsSync(auditLogPath)).toBe(false);
  });

  it("BUNDLE-06 Phase A clean: 2-entry bundle round-trip → both entries persisted with _bundleSource markers, both manager.connect calls fired", async () => {
    // Setup: clean 2-entry bundle (both packages safe per the mock default).
    const skillDir = writeSkillManifest("clean-skill", [
      { name: "entry-a", transport: "stdio", command: "npx", args: ["safe-pkg-a"] },
      { name: "entry-b", transport: "stdio", command: "npx", args: ["safe-pkg-b"] },
    ]);

    const container = makeContainer(parseYaml(readFileSync(configPath, "utf-8")));
    const mcpClientManager = makeMcpManager();
    const deps = {
      mcpClientManager,
      logger: makeLogger(),
      container,
      persistDeps: makePersistDeps(container),
      eventBus: container.eventBus,
    } as unknown as ApplyBundleInstallArgs["deps"];

    const result = await applyBundleInstall({
      skillId: "clean-skill",
      skillDir,
      force: false,
      ctx: undefined,
      deps,
    });

    expect(result.persistence).toBe("persisted");
    expect(result.warning).toBeUndefined();

    // YAML reflects the bundle entries with _bundleSource markers.
    const persistedYaml = parseYaml(readFileSync(configPath, "utf-8")) as {
      integrations?: { mcp?: { servers?: Array<Record<string, unknown>> } };
    };
    const servers = persistedYaml.integrations?.mcp?.servers ?? [];
    expect(servers).toHaveLength(2);
    const byName = new Map(servers.map((s) => [s.name as string, s]));
    expect(byName.get("entry-a")?._bundleSource).toBe("clean-skill");
    expect(byName.get("entry-b")?._bundleSource).toBe("clean-skill");

    // Phase B connected each bundle entry exactly once.
    expect(mcpClientManager.connect).toHaveBeenCalledTimes(2);
    const connectArgs = mcpClientManager.connect.mock.calls.map(
      (c) => (c[0] as { name: string }).name,
    );
    expect(connectArgs.sort()).toEqual(["entry-a", "entry-b"]);

    // Audit JSONL: exactly one config.write record with callerSource:
    // "skills.bundle.install" (BUNDLE-06's atomic single-write invariant).
    expect(existsSync(auditLogPath)).toBe(true);
    const records = readFileSync(auditLogPath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { event?: string; callerSource?: string });
    const bundleRecords = records.filter(
      (r) => r.callerSource === "skills.bundle.install",
    );
    expect(bundleRecords).toHaveLength(1);
    expect(bundleRecords[0]).toMatchObject({
      event: "config.write",
      callerSource: "skills.bundle.install",
    });
  });

  it("BUNDLE-03 boot idempotence: setupSkillBundles called twice on the same on-disk state → byte-equal YAML output", async () => {
    // Pre-install a skill via the install helper to seed the YAML with a
    // bundle entry. This produces the realistic boot baseline (config.yaml
    // contains a server tagged _bundleSource).
    const skillDir = writeSkillManifest("idempotent-skill", [
      {
        name: "stable-mcp",
        transport: "stdio",
        command: "npx",
        args: ["safe-stable-pkg"],
      },
    ]);

    const container1 = makeContainer(parseYaml(readFileSync(configPath, "utf-8")));
    const mcpClientManager = makeMcpManager();
    await applyBundleInstall({
      skillId: "idempotent-skill",
      skillDir,
      force: false,
      ctx: undefined,
      deps: {
        mcpClientManager,
        logger: makeLogger(),
        container: container1,
        persistDeps: makePersistDeps(container1),
        eventBus: container1.eventBus,
      } as unknown as ApplyBundleInstallArgs["deps"],
    });

    // Snapshot the YAML AFTER the install — this is the boot baseline.
    const yamlAfterInstall = readFileSync(configPath, "utf-8");

    // First setupSkillBundles run — container.config.integrations.mcp.servers
    // already contains the bundle entry from the install above. The resolver
    // produces the SAME nextServers array (idempotent replace-in-place via
    // _bundleSource match); the orchestrator's skip-when-equal short-circuit
    // SHOULD fire and skip the persistMcpServers call entirely.
    const container2 = makeContainer(parseYaml(yamlAfterInstall));
    const registry = makeRegistryStub([
      {
        name: "idempotent-skill",
        description: "idempotent-skill test skill",
        path: skillDir,
        source: "bundled",
        type: "prompt",
        userInvocable: true,
        disableModelInvocation: false,
        filePath: join(skillDir, "SKILL.md"),
      },
    ]);

    await setupSkillBundles({
      container: container2 as never,
      skillRegistries: new Map([["test-agent", registry]]),
      persistDeps: makePersistDeps(container2),
      eventBus: container2.eventBus as never,
      logger: makeLogger(),
    });

    const yamlAfterFirstBoot = readFileSync(configPath, "utf-8");
    expect(yamlAfterFirstBoot).toBe(yamlAfterInstall);

    // Second setupSkillBundles run — same disk state, same skill metadata.
    // The skip-when-equal short-circuit MUST fire again; YAML stays
    // byte-identical (the idempotence proof).
    const container3 = makeContainer(parseYaml(yamlAfterFirstBoot));
    await setupSkillBundles({
      container: container3 as never,
      skillRegistries: new Map([["test-agent", registry]]),
      persistDeps: makePersistDeps(container3),
      eventBus: container3.eventBus as never,
      logger: makeLogger(),
    });

    const yamlAfterSecondBoot = readFileSync(configPath, "utf-8");
    expect(yamlAfterSecondBoot).toBe(yamlAfterFirstBoot);
    expect(yamlAfterSecondBoot).toBe(yamlAfterInstall);

    // Audit JSONL has exactly ONE bundle record from the install. Neither
    // boot run wrote a "skills.bundle.boot" record — because the
    // skip-when-equal short-circuit suppressed both persistMcpServers calls.
    const records = readFileSync(auditLogPath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { callerSource?: string });
    const bootRecords = records.filter(
      (r) => r.callerSource === "skills.bundle.boot",
    );
    expect(bootRecords).toHaveLength(0);
    const installRecords = records.filter(
      (r) => r.callerSource === "skills.bundle.install",
    );
    expect(installRecords).toHaveLength(1);
  });

  it("BUNDLE-03 boot persist: setupSkillBundles produces NEW entries on cold-start (servers:[] baseline) → writes YAML once with skills.bundle.boot callerSource", async () => {
    // Cold-start scenario: a skill exists on disk with mcpServers but its
    // bundle entries are NOT yet in config.yaml (e.g. operator manually
    // copied the skill folder into ~/.comis/skills without running install).
    // The boot path's setupSkillBundles SHOULD detect the new entries and
    // persist them ONCE with skills.bundle.boot provenance.
    const skillDir = writeSkillManifest("cold-start-skill", [
      { name: "cold-mcp", transport: "stdio", command: "npx", args: ["cold-safe-pkg"] },
    ]);

    const yamlBaseline = readFileSync(configPath, "utf-8");
    const container = makeContainer(parseYaml(yamlBaseline));
    const registry = makeRegistryStub([
      {
        name: "cold-start-skill",
        description: "cold-start skill",
        path: skillDir,
        source: "bundled",
        type: "prompt",
        userInvocable: true,
        disableModelInvocation: false,
        filePath: join(skillDir, "SKILL.md"),
      },
    ]);

    await setupSkillBundles({
      container: container as never,
      skillRegistries: new Map([["test-agent", registry]]),
      persistDeps: makePersistDeps(container),
      eventBus: container.eventBus as never,
      logger: makeLogger(),
    });

    // YAML now contains the bundle entry with _bundleSource marker.
    const persistedYaml = parseYaml(readFileSync(configPath, "utf-8")) as {
      integrations?: { mcp?: { servers?: Array<Record<string, unknown>> } };
    };
    const servers = persistedYaml.integrations?.mcp?.servers ?? [];
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("cold-mcp");
    expect((servers[0] as { _bundleSource?: string })._bundleSource).toBe(
      "cold-start-skill",
    );

    // Audit JSONL: exactly one record tagged skills.bundle.boot.
    const records = readFileSync(auditLogPath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { event?: string; callerSource?: string });
    const bootRecords = records.filter(
      (r) => r.callerSource === "skills.bundle.boot",
    );
    expect(bootRecords).toHaveLength(1);
    expect(bootRecords[0]).toMatchObject({
      event: "config.write",
      callerSource: "skills.bundle.boot",
    });

    // Second pass on the same in-memory + on-disk state is idempotent —
    // skip-when-equal fires, no new audit record, byte-equal YAML.
    const yamlAfterFirstBoot = readFileSync(configPath, "utf-8");
    // Refresh the container's in-memory mirror of integrations.mcp.servers
    // to simulate the post-persist swap state (persistMcpServers already
    // did this in-memory; re-reading from disk produces the same shape).
    const refreshed = parseYaml(yamlAfterFirstBoot);
    container.config = refreshed;
    await setupSkillBundles({
      container: container as never,
      skillRegistries: new Map([["test-agent", registry]]),
      persistDeps: makePersistDeps(container),
      eventBus: container.eventBus as never,
      logger: makeLogger(),
    });
    const yamlAfterSecondBoot = readFileSync(configPath, "utf-8");
    expect(yamlAfterSecondBoot).toBe(yamlAfterFirstBoot);
    const recordsAfter = readFileSync(auditLogPath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { callerSource?: string });
    const bootRecordsAfter = recordsAfter.filter(
      (r) => r.callerSource === "skills.bundle.boot",
    );
    // Still exactly 1 boot record — the second pass produced zero new ones.
    expect(bootRecordsAfter).toHaveLength(1);
  });
});
