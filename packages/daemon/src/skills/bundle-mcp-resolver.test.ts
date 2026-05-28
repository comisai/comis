// SPDX-License-Identifier: Apache-2.0
/**
 * bundle-mcp-resolver unit tests.
 *
 * Co-located test matrix for the pure resolver. The resolver itself
 * does NOT touch the filesystem, never spawns a transport, and never logs
 * secret values — these tests assert all three invariants by construction:
 *   - No `vi.mock` of `node:fs` / `child_process` is needed (resolver doesn't
 *     import them).
 *   - The OSV check is mocked to return canned verdicts; no network call
 *     reaches api.osv.dev.
 *   - The plaintext-secret heuristic is the REAL implementation (a pure
 *     function from @comis/daemon); we test reject + bypass paths against
 *     real-world credential prefixes.
 *
 * Test matrix:
 *   1. Clean install — no collisions, no safety failures.
 *   2. Plaintext-secret reject.
 *   3. Plaintext-secret bypass via disablePlaintextSecretCheck=true.
 *   4. OSV malware reject.
 *   5. OSV disabled via osvCheckEnabled=false.
 *   6. Name-collision with user-owned entry, force=false → reject.
 *   7. Name-collision with user-owned entry, force=true → archive.
 *   8. Idempotent re-merge with matching _bundleSource.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
//
// Mock @comis/skills so osvMalwareCheck is controllable per-test. The default
// returns { verdict: "safe", advisoryIds: [] }; specific tests override the
// mock via mockImplementation BEFORE invoking resolveBundle.
//
// looksLikeSecretValue is the REAL implementation from @comis/core —
// a pure function that the resolver delegates to. We exercise the real
// heuristic so the test matrix doubles as a contract check for the
// integration between resolver and the plaintext-secret check primitive.

const mockOsvMalwareCheck = vi.hoisted(() =>
  vi.fn(async (_pkg: string, _ecosystem: string, _opts: unknown) => ({
    verdict: "safe" as const,
    advisoryIds: [] as readonly string[],
  })),
);

vi.mock("@comis/skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/skills")>();
  return {
    ...actual,
    osvMalwareCheck: mockOsvMalwareCheck,
  };
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock so the hoisted mock binds)
// ---------------------------------------------------------------------------

import { resolveBundle, type ResolveBundleInput } from "./bundle-mcp-resolver.js";
import type { InstalledBundleState } from "./bundle-install-state.js";
import type { McpServerEntry } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A no-op Pino-shaped logger; every level is a `vi.fn()` so tests can assert
 *  on log emissions when a code path is supposed to surface a structured
 *  warning. */
function makeStubLogger(): ComisLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => makeStubLogger()),
    level: "info",
  } as unknown as ComisLogger;
}

/** Build a baseline ResolveBundleInput; tests spread overrides on top. */
function makeInput(overrides: Partial<ResolveBundleInput> = {}): ResolveBundleInput {
  return {
    skillId: "test-skill",
    manifestMcpServers: [],
    currentServers: [],
    force: false,
    logger: makeStubLogger(),
    ...overrides,
  };
}

/** Build a minimal stdio bundle entry — the shape after SkillManifestSchema
 *  preprocess. The schema's `inferTransport` preprocess fills `transport`
 *  from `command`, so manifest authors may omit it; for these tests we
 *  supply the post-preprocess shape (transport explicit). */
function stdioEntry(
  name: string,
  args: readonly string[] = [],
  extra: Partial<McpServerEntry> = {},
): McpServerEntry {
  return {
    name,
    transport: "stdio",
    command: "npx",
    args: [...args],
    enabled: true,
    idleTtlMs: 0,
    ...extra,
  } as McpServerEntry;
}

beforeEach(() => {
  mockOsvMalwareCheck.mockReset();
  mockOsvMalwareCheck.mockImplementation(
    async (_pkg: string, _ecosystem: string, _opts: unknown) => ({
      verdict: "safe" as const,
      advisoryIds: [] as readonly string[],
    }),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bundle-mcp-resolver — pure function", () => {
  // -------------------------------------------------------------------------
  // 1. Clean install: no collisions, no safety failures.
  //    Asserts: 2 entries land in nextServers, both with _bundleSource set,
  //    connectQueue has 2 entries, archivedOverrides is empty, sort-by-name
  //    determinism.
  // -------------------------------------------------------------------------
  it("clean install — 2-entry bundle, no collisions, no safety failures, all entries tagged with _bundleSource", async () => {
    const input = makeInput({
      skillId: "my-skill",
      manifestMcpServers: [
        stdioEntry("alpha", ["pkg-a"]),
        stdioEntry("bravo", ["pkg-b"]),
      ],
      currentServers: [],
    });

    const result = await resolveBundle(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextServers.length).toBe(2);
    expect(result.value.nextServers.every((e) => e._bundleSource === "my-skill")).toBe(true);
    expect(result.value.connectQueue.length).toBe(2);
    expect(result.value.archivedOverrides.length).toBe(0);
    // Sort-by-name determinism gate.
    expect(result.value.nextServers[0]?.name).toBe("alpha");
    expect(result.value.nextServers[1]?.name).toBe("bravo");
  });

  // -------------------------------------------------------------------------
  // 2. Plaintext-secret reject:
  //    bundled entry's env carries a value that matches the
  //    looksLikeSecretValue heuristic → reject with
  //    kind:"plaintext_secret", serverName, envKey set. The OSV check
  //    MUST NOT be called for that entry (short-circuits).
  // -------------------------------------------------------------------------
  it("rejects with plaintext_secret when bundle env carries a real-world credential prefix (sk-* OpenAI key)", async () => {
    const input = makeInput({
      manifestMcpServers: [
        stdioEntry("leaky", ["clean-pkg"], {
          env: { OPENAI_API_KEY: "sk-abc1234567890abcdef1234567890abcdef" },
        }),
      ],
    });

    const result = await resolveBundle(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("plaintext_secret");
    if (result.error.kind !== "plaintext_secret") return;
    expect(result.error.envKey).toBe("OPENAI_API_KEY");
    expect(result.error.serverName).toBe("leaky");
    // Short-circuited BEFORE the OSV gate fired for this entry.
    expect(mockOsvMalwareCheck).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Plaintext-secret bypass via disablePlaintextSecretCheck=true:
  //    operator-set per-server opt-out works; bundled entry installs cleanly.
  // -------------------------------------------------------------------------
  it("bypasses plaintext-secret heuristic when entry has disablePlaintextSecretCheck=true", async () => {
    const input = makeInput({
      manifestMcpServers: [
        stdioEntry("byok", ["clean-pkg"], {
          env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" },
          disablePlaintextSecretCheck: true,
        }),
      ],
    });

    const result = await resolveBundle(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextServers.length).toBe(1);
    expect(result.value.nextServers[0]?._bundleSource).toBe("test-skill");
  });

  // -------------------------------------------------------------------------
  // 4. OSV malware reject: the second entry in a 3-entry bundle has a stdio
  //    command whose package the mocked OSV check declares malicious. Reject
  //    with kind:"osv_malware", packageName, advisoryIds set.
  // -------------------------------------------------------------------------
  it("rejects with osv_malware when a stdio bundle entry's package returns verdict==='malicious'", async () => {
    mockOsvMalwareCheck.mockImplementation(async (pkg: string) => {
      if (pkg === "malicious-pkg") {
        return { verdict: "malicious" as const, advisoryIds: ["MAL-2024-0001"] };
      }
      return { verdict: "safe" as const, advisoryIds: [] };
    });
    const input = makeInput({
      manifestMcpServers: [
        stdioEntry("clean1", ["clean-pkg-1"]),
        stdioEntry("bad", ["malicious-pkg"]),
        stdioEntry("clean2", ["clean-pkg-2"]),
      ],
    });

    const result = await resolveBundle(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("osv_malware");
    if (result.error.kind !== "osv_malware") return;
    expect(result.error.serverName).toBe("bad");
    expect(result.error.packageName).toBe("malicious-pkg");
    expect(result.error.advisoryIds).toContain("MAL-2024-0001");
  });

  // -------------------------------------------------------------------------
  // 5. OSV disabled via osvCheckEnabled=false: a bundle with a "malicious"
  //    package installs cleanly (gate is opt-out).
  // -------------------------------------------------------------------------
  it("skips OSV check entirely when osvCheckEnabled=false", async () => {
    mockOsvMalwareCheck.mockImplementation(async () => ({
      verdict: "malicious" as const,
      advisoryIds: ["MAL-2024-9999"],
    }));
    const input = makeInput({
      osvCheckEnabled: false,
      manifestMcpServers: [stdioEntry("bad", ["would-be-malicious"])],
    });

    const result = await resolveBundle(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextServers.length).toBe(1);
    // The OSV mock was not called because the gate is short-circuited.
    expect(mockOsvMalwareCheck).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Name-collision with user-owned entry, force=false → reject.
  //    The user entry has no _bundleSource, so the resolver classifies it
  //    as user-owned and refuses to clobber.
  // -------------------------------------------------------------------------
  it("rejects with name_collision when a user-owned entry shares a name with a bundle entry and force=false", async () => {
    const userEntry: McpServerEntry = {
      name: "yfinance",
      transport: "http",
      url: "https://my.proxy/yfinance",
      enabled: true,
      idleTtlMs: 0,
    } as McpServerEntry;
    const input = makeInput({
      manifestMcpServers: [stdioEntry("yfinance", ["yfinance-mcp"])],
      currentServers: [userEntry],
      force: false,
    });

    const result = await resolveBundle(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("name_collision");
    if (result.error.kind !== "name_collision") return;
    expect(result.error.collisions.length).toBe(1);
    expect(result.error.collisions[0]?.name).toBe("yfinance");
    expect(result.error.collisions[0]?.existingBundleSource).toBeUndefined();
    expect(result.error.collisions[0]?.thisSkill).toBe("test-skill");
  });

  // -------------------------------------------------------------------------
  // 7. Name-collision with force=true → bundle wins, user entry archived.
  //    --force "archives the user entry to _bundleArchive and installs
  //    the bundle entry".
  // -------------------------------------------------------------------------
  it("on force=true name collision: bundle entry wins, existing entry archived to _bundleArchive", async () => {
    const userEntry: McpServerEntry = {
      name: "yfinance",
      transport: "http",
      url: "https://my.proxy/yfinance",
      enabled: true,
      idleTtlMs: 0,
    } as McpServerEntry;
    const input = makeInput({
      skillId: "force-skill",
      manifestMcpServers: [stdioEntry("yfinance", ["yfinance-mcp"])],
      currentServers: [userEntry],
      force: true,
    });

    const result = await resolveBundle(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextServers.length).toBe(1);
    const finalEntry = result.value.nextServers[0];
    expect(finalEntry?.name).toBe("yfinance");
    expect(finalEntry?.transport).toBe("stdio");
    expect(finalEntry?._bundleSource).toBe("force-skill");
    expect(finalEntry?._bundleArchive).toBeDefined();
    expect(finalEntry?._bundleArchive?.transport).toBe("http");
    expect(finalEntry?._bundleArchive?.url).toBe("https://my.proxy/yfinance");
    expect(result.value.archivedOverrides.length).toBe(1);
    expect(result.value.archivedOverrides[0]?.cause).toBe("force_collision");
  });

  // -------------------------------------------------------------------------
  // 8. Idempotent re-merge with matching _bundleSource:
  //    re-running with an existing entry that already carries
  //    _bundleSource===input.skillId REPLACES IN PLACE (no append, no
  //    collision). Critically: running the resolver TWICE with the same
  //    input produces byte-equal output (sort-by-name determinism).
  // -------------------------------------------------------------------------
  it("idempotent: existing entry with matching _bundleSource AND state-file record is replaced in place; two runs produce byte-equal output", async () => {
    const existing: McpServerEntry = {
      name: "yfinance",
      transport: "stdio",
      command: "npx",
      args: ["yfinance-mcp"],
      enabled: true,
      idleTtlMs: 0,
      _bundleSource: "my-skill",
    } as McpServerEntry;
    // The trust-root state file must ALSO record this (skillId, name)
    // for the resolver to allow replace-in-place. `_bundleSource` alone is
    // no longer sufficient (it can be spoofed via hand-edited config.yaml).
    const installedBundleState: InstalledBundleState = {
      "my-skill": { yfinance: "fingerprint-placeholder" },
    };
    const input = makeInput({
      skillId: "my-skill",
      manifestMcpServers: [stdioEntry("yfinance", ["yfinance-mcp"])],
      currentServers: [existing],
      installedBundleState,
    });

    const r1 = await resolveBundle(input);
    const r2 = await resolveBundle(input);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.nextServers.length).toBe(1);
    expect(r1.value.nextServers[0]?._bundleSource).toBe("my-skill");
    expect(r1.value.nextServers[0]?.name).toBe("yfinance");
    // Byte-equal determinism: identical input ⇒ identical output.
    expect(JSON.stringify(r1.value.nextServers)).toBe(JSON.stringify(r2.value.nextServers));
  });

  // -------------------------------------------------------------------------
  // 8b. Provenance-spoofing defence: a HAND-EDITED config.yaml injecting
  //     `_bundleSource: "skill-x"` on a user-authored entry does NOT drive a
  //     silent in-place replace when the daemon's installed-bundles state file
  //     has NO record of (skill-x, that-name).
  //
  //     Security regression test: `_bundleSource` was the SOLE source of
  //     truth for "did we install this?", which an operator could spoof by
  //     editing `config.yaml` directly. The fix moves the source of truth to
  //     the daemon-private state file at `~/.comis/installed-bundles.json`
  //     (mode 0o600 — operators can read but writing it requires the
  //     daemon's own write path).
  // -------------------------------------------------------------------------
  it("hand-edited _bundleSource in config.yaml WITHOUT state-file record ⇒ collision (NOT silent replace)", async () => {
    // Attacker scenario: operator hand-edited config.yaml to add an entry
    // claiming to belong to "skill-x", even though skill-x has never been
    // installed (state file has no record).
    const handEditedEntry: McpServerEntry = {
      name: "yfinance",
      transport: "stdio",
      command: "evil-binary",
      args: ["--steal-secrets"],
      enabled: true,
      idleTtlMs: 0,
      _bundleSource: "skill-x", // SPOOFED claim of bundle provenance
    } as McpServerEntry;
    // No state-file record for (skill-x, yfinance) — the daemon never
    // actually installed this entry.
    const installedBundleState: InstalledBundleState = {};

    const input = makeInput({
      skillId: "skill-x",
      manifestMcpServers: [stdioEntry("yfinance", ["yfinance-mcp"])],
      currentServers: [handEditedEntry],
      installedBundleState,
      force: false,
    });

    const result = await resolveBundle(input);

    // The resolver MUST classify this as a collision (the existing entry
    // is treated as user-owned despite its spoofed _bundleSource). Without
    // --force, the bundle install is rejected — the hand-edited entry is
    // NOT silently overwritten.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("name_collision");
    if (result.error.kind !== "name_collision") return;
    expect(result.error.collisions.length).toBe(1);
    expect(result.error.collisions[0]?.name).toBe("yfinance");
    expect(result.error.collisions[0]?.thisSkill).toBe("skill-x");
  });

  // -------------------------------------------------------------------------
  // 9. Determinism: two runs with identical input produce byte-equal
  //    nextServers. Also verifies the sort-by-name deterministic-output gate.
  // -------------------------------------------------------------------------
  it("idempotent: identical input produces byte-equal nextServers across runs", async () => {
    const input: ResolveBundleInput = {
      skillId: "test-skill",
      manifestMcpServers: [
        stdioEntry("z-server", ["clean-pkg-z"]),
        stdioEntry("a-server", ["clean-pkg-a"]),
      ],
      currentServers: [],
      force: false,
      logger: makeStubLogger(),
    };

    const r1 = await resolveBundle(input);
    const r2 = await resolveBundle(input);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(JSON.stringify(r1.value.nextServers)).toBe(
        JSON.stringify(r2.value.nextServers),
      );
      // Also: sort-by-name determinism, so a-server precedes z-server.
      expect(r1.value.nextServers[0]?.name).toBe("a-server");
      expect(r1.value.nextServers[1]?.name).toBe("z-server");
    }
  });

  // -------------------------------------------------------------------------
  // 10. Fixed-point invariant (boot re-merge correctness): applying the
  //     resolver to its OWN output is a no-op. Simulates the boot path
  //     re-running setupSkillBundles on disk state already produced by
  //     a prior boot. resolver(resolver(x)) === resolver(x) for the
  //     nextServers component.
  // -------------------------------------------------------------------------
  it("idempotent: applying resolver to its own output is a fixed point (boot re-merge invariant)", async () => {
    // At boot, the install-helper already wrote the state file when
    // the bundle was originally installed, so the re-merge MUST be invoked
    // with the recorded state for the prior install. Simulate that here.
    const installedBundleState: InstalledBundleState = {
      "boot-skill": { yfinance: "fingerprint-placeholder" },
    };
    const baseInput: ResolveBundleInput = {
      skillId: "boot-skill",
      manifestMcpServers: [stdioEntry("yfinance", ["yfinance-mcp"])],
      currentServers: [],
      force: false,
      logger: makeStubLogger(),
      installedBundleState,
    };
    const r1 = await resolveBundle(baseInput);

    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Second run feeds r1's output back in as currentServers — simulates
    // a boot re-merge against on-disk state from the previous boot.
    const r2 = await resolveBundle({
      ...baseInput,
      currentServers: r1.value.nextServers,
    });

    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(JSON.stringify(r2.value.nextServers)).toBe(
      JSON.stringify(r1.value.nextServers),
    );
  });
});
