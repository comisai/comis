// SPDX-License-Identifier: Apache-2.0
/**
 * setupSkillBundles boot orchestrator tests.
 *
 * Pins the public surface of the boot-path bundle re-merge orchestrator.
 *
 * Behavioral matrix (6 scenarios):
 *
 *   1. Empty registries map → orchestrator returns without firing
 *      persistMcpServers (no skills → no work).
 *
 *   2. Single registry whose installed skills carry NO mcpServers block →
 *      orchestrator no-ops (no persistence call).
 *
 *   3. Single registry with one skill that DOES declare mcpServers; the
 *      container starts with empty servers — orchestrator fires persist
 *      exactly once with both bundle entries tagged `_bundleSource`.
 *
 *   4. On a second pass with the same disk + in-memory state (the persisted
 *      result), the orchestrator's skip-when-equal short-circuit fires —
 *      persistMcpServers is invoked ZERO times. (Boot-loop idempotence.)
 *
 *   5. Skill A's bundle has a NAME collision with a user-owned entry; force
 *      defaults to false at boot. Orchestrator WARN-logs + skips skill A;
 *      Skill B (clean) IS persisted. (Boot never overrides; operator must
 *      manually run install --force.)
 *
 *   6. Skill A's SKILL.md is unparseable (parseSkillManifest fails);
 *      Skills B + C are clean. Orchestrator WARN-logs A + continues with B + C.
 *
 * Mock strategy mirrors bundle-install-helper.test.ts:
 *   - vi.mock("../api/shared/persist-mcp-servers.js") with a hoisted spy
 *     so call-count assertions work AND no real YAML writes happen.
 *   - vi.mock("@comis/skills") to override osvMalwareCheck (defaults safe).
 *   - parseSkillManifest is NOT mocked — actual disk-read + Zod parse runs
 *     against tmpdir-written SKILL.md fixtures, which catches schema
 *     regressions for free.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Hoisted spies — shared between test scope (assertions) + mock factory
// ---------------------------------------------------------------------------

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
// Imports — setupSkillBundles is the symbol under test
// ---------------------------------------------------------------------------

import { setupSkillBundles } from "./setup-skill-bundles.js";
import type { ComisLogger } from "@comis/infra";
import type { McpServerEntry } from "@comis/core";
import type { SkillMetadata, SkillRegistry } from "@comis/skills";

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

/**
 * Build a stub SkillRegistry whose only consumed surface is `getAllMetadata()`.
 * The orchestrator never calls any other method.
 */
function makeRegistry(metadata: SkillMetadata[]): SkillRegistry {
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

/**
 * Write a SKILL.md to a tmpdir-scoped per-skill directory and return the
 * SkillMetadata that `getAllMetadata()` would produce.
 */
function writeSkill(
  rootDir: string,
  name: string,
  manifestYaml: string,
): SkillMetadata {
  const skillDir = join(rootDir, name);
  mkdirSync(skillDir, { recursive: true });
  const skillMdPath = join(skillDir, "SKILL.md");
  writeFileSync(skillMdPath, manifestYaml, "utf-8");
  return {
    name,
    description: `${name} description`,
    path: skillDir,
    source: "bundled",
    type: "prompt",
    userInvocable: true,
    disableModelInvocation: false,
    filePath: skillMdPath,
  } satisfies SkillMetadata;
}

interface DepsOverrides {
  currentServers?: McpServerEntry[];
  registries?: ReadonlyMap<string, SkillRegistry>;
  withPersistDeps?: boolean;
}

function makeDeps(overrides: DepsOverrides = {}): Parameters<typeof setupSkillBundles>[0] {
  const container = {
    config: {
      integrations: {
        mcp: {
          servers: overrides.currentServers ?? [],
        },
      },
    },
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as never,
  } as Parameters<typeof setupSkillBundles>[0]["container"];
  return {
    container,
    skillRegistries: overrides.registries ?? new Map(),
    logger: makeLogger(),
    ...(overrides.withPersistDeps !== false && {
      persistDeps: {
        configPaths: ["/tmp/config.yaml"],
        defaultConfigPaths: ["/tmp/default.yaml"],
        logger: makeLogger(),
      } as never,
    }),
    eventBus: container.eventBus,
  };
}

// ---------------------------------------------------------------------------
// Tmpdir setup
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), `setup-skill-bundles-${randomUUID().slice(0, 8)}-`));
  mockPersistMcpServers.mockReset();
  mockPersistMcpServers.mockResolvedValue({ persistence: "persisted" as const });
  mockOsvMalwareCheck.mockReset();
  mockOsvMalwareCheck.mockResolvedValue({ verdict: "safe", advisoryIds: [] });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers — manifest-content factories
// ---------------------------------------------------------------------------

function manifestNoBundle(name: string): string {
  return `---
name: ${name}
description: "${name} description"
type: prompt
---

# ${name}

Plain skill without an mcpServers block.
`;
}

function manifestWithBundle(
  name: string,
  entries: ReadonlyArray<{
    name: string;
    transport: "stdio" | "sse" | "http";
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  }>,
): string {
  const yamlEntries = entries
    .map((e) => {
      const lines: string[] = [`  - name: ${e.name}`, `    transport: ${e.transport}`];
      if (e.command !== undefined) lines.push(`    command: ${e.command}`);
      if (e.args !== undefined) {
        lines.push(`    args:`);
        for (const a of e.args) lines.push(`      - ${a}`);
      }
      if (e.url !== undefined) lines.push(`    url: ${e.url}`);
      if (e.env !== undefined) {
        lines.push(`    env:`);
        for (const [k, v] of Object.entries(e.env)) lines.push(`      ${k}: "${v}"`);
      }
      return lines.join("\n");
    })
    .join("\n");
  return `---
name: ${name}
description: "${name} description"
type: prompt
mcpServers:
${yamlEntries}
---

# ${name}

Skill with a bundled mcpServers block.
`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupSkillBundles — boot orchestrator", () => {
  it("no installed skills → orchestrator returns without firing persistMcpServers", async () => {
    const deps = makeDeps({ registries: new Map() });
    await setupSkillBundles(deps);
    expect(mockPersistMcpServers).toHaveBeenCalledTimes(0);
  });

  it("all installed skills have no mcpServers block → no-op (no persist)", async () => {
    const md1 = writeSkill(tmpRoot, "skill-a", manifestNoBundle("skill-a"));
    const md2 = writeSkill(tmpRoot, "skill-b", manifestNoBundle("skill-b"));
    const registry = makeRegistry([md1, md2]);
    const deps = makeDeps({
      registries: new Map([["test-agent", registry]]),
    });
    await setupSkillBundles(deps);
    expect(mockPersistMcpServers).toHaveBeenCalledTimes(0);
  });

  it("one skill with mcpServers + empty currentServers → persist fires once with both entries tagged _bundleSource", async () => {
    const md = writeSkill(
      tmpRoot,
      "bundle-skill",
      manifestWithBundle("bundle-skill", [
        { name: "alpha-mcp", transport: "stdio", command: "npx", args: ["alpha-pkg"] },
        { name: "beta-mcp", transport: "stdio", command: "npx", args: ["beta-pkg"] },
      ]),
    );
    const registry = makeRegistry([md]);
    const deps = makeDeps({
      registries: new Map([["test-agent", registry]]),
    });
    await setupSkillBundles(deps);
    expect(mockPersistMcpServers).toHaveBeenCalledTimes(1);
    const [_deps, servers, actionType, entityId] = mockPersistMcpServers.mock.calls[0]!;
    expect(actionType).toBe("skills.bundle.boot");
    expect(entityId).toBe("boot");
    expect(servers).toHaveLength(2);
    const names = (servers as McpServerEntry[]).map((s) => s.name).sort();
    expect(names).toEqual(["alpha-mcp", "beta-mcp"]);
    for (const entry of servers as McpServerEntry[]) {
      expect(entry._bundleSource).toBe("bundle-skill");
    }
  });

  it("idempotence: second run with same disk + in-memory state → persistMcpServers SKIPPED (zero calls on the second invocation)", async () => {
    const md = writeSkill(
      tmpRoot,
      "idempotent-skill",
      manifestWithBundle("idempotent-skill", [
        { name: "stable-mcp", transport: "stdio", command: "npx", args: ["stable-pkg"] },
      ]),
    );
    const registry = makeRegistry([md]);

    // First run — container starts with empty servers; resolver produces 1
    // entry; persist fires once.
    const deps = makeDeps({ registries: new Map([["test-agent", registry]]) });
    await setupSkillBundles(deps);
    expect(mockPersistMcpServers).toHaveBeenCalledTimes(1);
    const [, servers] = mockPersistMcpServers.mock.calls[0]!;
    const persistedServers = servers as McpServerEntry[];

    // Simulate the in-memory swap: assign the persisted array onto
    // container.config.integrations.mcp.servers and re-invoke. Resolver
    // produces the same array (idempotent replace-in-place); the
    // skip-when-equal short-circuit MUST suppress the second persist.
    mockPersistMcpServers.mockClear();
    (deps.container.config as { integrations: { mcp: { servers: McpServerEntry[] } } })
      .integrations.mcp.servers = persistedServers;
    await setupSkillBundles(deps);
    expect(mockPersistMcpServers).toHaveBeenCalledTimes(0);
  });

  it("name collision against user-owned entry + force=false (boot default) → WARN log + skip skill A, continue with skill B", async () => {
    const mdA = writeSkill(
      tmpRoot,
      "skill-a",
      manifestWithBundle("skill-a", [
        { name: "shared-name", transport: "stdio", command: "npx", args: ["a-pkg"] },
      ]),
    );
    const mdB = writeSkill(
      tmpRoot,
      "skill-b",
      manifestWithBundle("skill-b", [
        { name: "unique-b", transport: "stdio", command: "npx", args: ["b-pkg"] },
      ]),
    );
    const registry = makeRegistry([mdA, mdB]);

    // Pre-existing user-owned entry colliding with skill-a's bundle.
    const userEntry: McpServerEntry = {
      name: "shared-name",
      transport: "stdio",
      command: "npx",
      args: ["user-pkg"],
      enabled: true,
      idleTtlMs: 0,
    } as McpServerEntry;

    const deps = makeDeps({
      currentServers: [userEntry],
      registries: new Map([["test-agent", registry]]),
    });
    await setupSkillBundles(deps);

    // Skill B's entry was persisted — exactly one persist call.
    expect(mockPersistMcpServers).toHaveBeenCalledTimes(1);
    const [, servers] = mockPersistMcpServers.mock.calls[0]!;
    const final = servers as McpServerEntry[];

    // Skill A's entry was NOT added (collision rejected); the user entry
    // is preserved; skill B's entry IS in the final array.
    expect(final.find((s) => s.name === "shared-name")?._bundleSource).toBeUndefined();
    expect(final.find((s) => s.name === "unique-b")?._bundleSource).toBe("skill-b");

    // WARN was logged with errorKind:"config" mentioning skill A. There are
    // TWO WARNs for this scenario: the resolver's own "name-collision reject"
    // log and the orchestrator's "resolver rejected" log. We test the
    // orchestrator's fields by filtering on the orchestrator's distinguishing
    // field (bundleErrorKind exists on the orchestrator WARN only; the
    // resolver's WARN exposes collisionCount instead).
    const warnSpy = deps.logger.warn as ReturnType<typeof vi.fn>;
    const orchestratorWarn = warnSpy.mock.calls.find((call) => {
      const obj = call[0] as { skillId?: string; bundleErrorKind?: string };
      return obj.skillId === "skill-a" && obj.bundleErrorKind !== undefined;
    });
    expect(orchestratorWarn).toBeDefined();
    // err MUST be a STRING (passed to Pino's err field — the serializer
    // only fires for Error instances; a plain BundleError object would be
    // recorded raw and log-aggregation tools that look for err.message would
    // miss it). bundleErrorKind carries the structured discriminator instead.
    const warnObj = orchestratorWarn![0] as { err?: unknown; bundleErrorKind?: string };
    expect(typeof warnObj.err).toBe("string");
    expect(warnObj.bundleErrorKind).toBe("name_collision");
  });

  it("initialServers in unsorted order but otherwise equal to merged result ⇒ NO spurious persist (idempotence holds on first boot after sort fix)", async () => {
    // Set the disk-state to a TWO-entry bundle pre-sorted INCORRECTLY (z before a).
    // The resolver produces sorted output (a, then z); without the pre-sort,
    // deepEqualServers compares "[z, a]" vs "[a, z]" and triggers a spurious
    // persist for the noop merge.
    const aEntry: McpServerEntry = {
      name: "alpha-mcp",
      transport: "stdio",
      command: "npx",
      args: ["alpha-pkg"],
      enabled: true,
      idleTtlMs: 0,
      _bundleSource: "sort-idempotence-skill",
    } as McpServerEntry;
    const zEntry: McpServerEntry = {
      name: "zulu-mcp",
      transport: "stdio",
      command: "npx",
      args: ["zulu-pkg"],
      enabled: true,
      idleTtlMs: 0,
      _bundleSource: "sort-idempotence-skill",
    } as McpServerEntry;

    const md = writeSkill(
      tmpRoot,
      "sort-idempotence-skill",
      manifestWithBundle("sort-idempotence-skill", [
        { name: "alpha-mcp", transport: "stdio", command: "npx", args: ["alpha-pkg"] },
        { name: "zulu-mcp", transport: "stdio", command: "npx", args: ["zulu-pkg"] },
      ]),
    );
    const registry = makeRegistry([md]);
    // Legacy deployment: servers persisted in declaration order, NOT sorted.
    // `zulu-mcp` comes before `alpha-mcp`. After this fix, resolver produces
    // sorted output [a, z]. The pre-sort makes initialServers also [a, z].
    const deps = makeDeps({
      currentServers: [zEntry, aEntry],
      registries: new Map([["test-agent", registry]]),
    });
    // The resolver only treats entries as "ours to replace" when the state
    // file records them. The test fixture path has dataDir="" so state is
    // empty — so both entries collide. To exercise the idempotence path AT
    // ALL we provide the state explicitly: in production, the
    // install-helper writes this on first install and the orchestrator
    // reads it on every boot.
    //
    // We pre-seed the daemon-private state for this skill by writing to a
    // fixture dataDir, then point container.config.dataDir at that fixture.
    (deps.container.config as Record<string, unknown>).dataDir = tmpRoot;
    // Manually write the state file so the resolver sees the recorded entries.
    writeFileSync(
      join(tmpRoot, "installed-bundles.json"),
      JSON.stringify({
        "sort-idempotence-skill": { "alpha-mcp": "fp", "zulu-mcp": "fp" },
      }),
      "utf-8",
    );

    await setupSkillBundles(deps);

    // The resolver produces [alpha-mcp, zulu-mcp]; initialServers (after
    // pre-sort) is also [alpha-mcp, zulu-mcp]. deepEqualServers
    // returns true. persistMcpServers MUST NOT be called.
    expect(mockPersistMcpServers).toHaveBeenCalledTimes(0);
  });

  it("partial manifest parse failure: skill A unparseable, B + C clean → log WARN for A, persist B+C only", async () => {
    // Skill A: write a broken SKILL.md (no frontmatter at all).
    const skillADir = join(tmpRoot, "skill-a");
    mkdirSync(skillADir, { recursive: true });
    const skillAPath = join(skillADir, "SKILL.md");
    writeFileSync(skillAPath, "no frontmatter here at all", "utf-8");
    const mdA: SkillMetadata = {
      name: "skill-a",
      description: "broken",
      path: skillADir,
      source: "bundled",
      type: "prompt",
      userInvocable: true,
      disableModelInvocation: false,
      filePath: skillAPath,
    };

    const mdB = writeSkill(
      tmpRoot,
      "skill-b",
      manifestWithBundle("skill-b", [
        { name: "b-mcp", transport: "stdio", command: "npx", args: ["b-pkg"] },
      ]),
    );
    const mdC = writeSkill(
      tmpRoot,
      "skill-c",
      manifestWithBundle("skill-c", [
        { name: "c-mcp", transport: "stdio", command: "npx", args: ["c-pkg"] },
      ]),
    );
    const registry = makeRegistry([mdA, mdB, mdC]);
    const deps = makeDeps({ registries: new Map([["test-agent", registry]]) });
    await setupSkillBundles(deps);

    // Exactly one persist call covering B + C.
    expect(mockPersistMcpServers).toHaveBeenCalledTimes(1);
    const [, servers] = mockPersistMcpServers.mock.calls[0]!;
    const names = (servers as McpServerEntry[]).map((s) => s.name).sort();
    expect(names).toEqual(["b-mcp", "c-mcp"]);

    // WARN was logged for skill A's parse failure.
    const warnSpy = deps.logger.warn as ReturnType<typeof vi.fn>;
    const skillAWarn = warnSpy.mock.calls.find((call) => {
      const obj = call[0] as { skillId?: string };
      return obj.skillId === "skill-a";
    });
    expect(skillAWarn).toBeDefined();
  });
});
