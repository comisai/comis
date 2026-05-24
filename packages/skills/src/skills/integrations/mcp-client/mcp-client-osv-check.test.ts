// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 63 plan 04 SAFETY-05/06 — co-located unit tests for the OSV
 * malware check + MCP-command package-name extractor introduced at
 * `mcp-client-osv-check.ts`.
 *
 * Why TDD: per AGENTS.md §2.10 + CLAUDE.md "TDD-First", every behavior
 * change in production source starts with a failing test. This file
 * pins:
 *
 *   - extractMcpPackageName: 8 cases over npx / uvx / pnpm dlx /
 *     unknown / absolute-path commands + npm `pkg@1.2.3` version strip.
 *   - osvMalwareCheck: 5 cases over cache hit / MAL- match / empty 200
 *     / 5xx fail-open / network-error fail-open + corrupted-cache
 *     fallthrough.
 *
 * Mock-fetch pattern mirrors `packages/skills/src/tools/media/ssrf-fetcher.test.ts`
 * (vi.mock factory + `globalThis.fetch` swap). Cache root is injected
 * via `opts.cacheDir = tempDir` so tests never touch the real
 * `~/.comis/cache/osv/`.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  osvMalwareCheck,
  extractMcpPackageName,
} from "./mcp-client-osv-check.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockLogger } from "../../../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Test fixtures + harness
// ---------------------------------------------------------------------------

let tempDir: string;
let logger: ReturnType<typeof createMockLogger>;

beforeEach(() => {
  // Per-test cache root keeps each case hermetic; tests never write to
  // the real ~/.comis/cache/osv/.
  tempDir = mkdtempSync(join(tmpdir(), "osv-check-unit-"));
  logger = createMockLogger();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// extractMcpPackageName — package-name extraction
// ---------------------------------------------------------------------------

describe("extractMcpPackageName — npx command parsing (SAFETY-05)", () => {
  it("extractMcpPackageName parses npx -y @org/pkg into npm ecosystem entry", () => {
    expect(
      extractMcpPackageName("npx", ["-y", "@modelcontextprotocol/server-yfinance"]),
    ).toEqual({ ecosystem: "npm", name: "@modelcontextprotocol/server-yfinance" });
  });

  it("extractMcpPackageName parses npx pkg without -y flag into npm ecosystem entry", () => {
    expect(extractMcpPackageName("npx", ["@modelcontextprotocol/server-yfinance"])).toEqual({
      ecosystem: "npm",
      name: "@modelcontextprotocol/server-yfinance",
    });
  });

  it("extractMcpPackageName strips version suffix from npx pkg@1.2.3 specifier", () => {
    expect(extractMcpPackageName("npx", ["-y", "yfinance-mcp@1.2.3"])).toEqual({
      ecosystem: "npm",
      name: "yfinance-mcp",
    });
  });

  it("extractMcpPackageName matches absolute npx path via endsWith heuristic", () => {
    expect(extractMcpPackageName("/usr/local/bin/npx", ["-y", "pkg"])).toEqual({
      ecosystem: "npm",
      name: "pkg",
    });
  });
});

describe("extractMcpPackageName — uvx command parsing (SAFETY-05)", () => {
  it("extractMcpPackageName parses uvx pkg into pypi ecosystem entry", () => {
    expect(extractMcpPackageName("uvx", ["yfinance-mcp"])).toEqual({
      ecosystem: "pypi",
      name: "yfinance-mcp",
    });
  });
});

describe("extractMcpPackageName — pnpm dlx command parsing (SAFETY-05)", () => {
  it("extractMcpPackageName parses pnpm dlx pkg into npm ecosystem entry", () => {
    expect(extractMcpPackageName("pnpm", ["dlx", "yfinance-mcp"])).toEqual({
      ecosystem: "npm",
      name: "yfinance-mcp",
    });
  });
});

describe("extractMcpPackageName — unknown commands return null (SAFETY-05 Pitfall 4)", () => {
  it("extractMcpPackageName returns null for unrecognized node command", () => {
    expect(extractMcpPackageName("node", ["/path/to/server.js"])).toBeNull();
  });

  it("extractMcpPackageName returns null for unrecognized python3 command", () => {
    expect(extractMcpPackageName("python3", ["-m", "server"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// osvMalwareCheck — API + on-disk cache behavior
// ---------------------------------------------------------------------------

describe("osvMalwareCheck — cache lifecycle (SAFETY-06)", () => {
  it("osvMalwareCheck returns cached verdict without invoking fetch within TTL window", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    // Cold cache: miss + fetch + write.
    const first = await osvMalwareCheck("safe-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(first.verdict).toBe("safe");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Warm cache: hit, no further fetch.
    const second = await osvMalwareCheck("safe-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(second.verdict).toBe("safe");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("osvMalwareCheck treats corrupted cache file as miss and re-fetches", async () => {
    // Synthesize a corrupt cache entry under the per-test cache dir.
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const cachePath = join(tempDir, "npm-corrupt-pkg.json");
    writeFileSync(cachePath, "{ this is not json", { mode: 0o600 });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    const result = await osvMalwareCheck("corrupt-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result.verdict).toBe("safe");
    // Corrupt cache → fall through to fresh fetch (NOT cache hit).
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // CR-01 regression — cache-shape validation guards against cache poisoning.
  // A previously-installed malicious package (or attacker with cache write
  // access) cannot write a fake "safe" verdict and defeat future OSV checks
  // by hand-crafting JSON whose `verdict` is anything other than the closed
  // enum `"safe" | "malicious"`. The pre-fix code did
  // `JSON.parse(raw) as OsvCacheEntry` (unsafe cast) and the downstream
  // malicious-block check was `verdict === "malicious"` — any other value
  // (capital-M "Malicious", empty string, number, etc.) silently passed
  // as "not malicious". The fix validates the cache entry's shape via Zod
  // before trusting it.
  // -------------------------------------------------------------------------
  it("osvMalwareCheck treats cache entry with non-enum verdict (capital-M Malicious) as miss and re-fetches", async () => {
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const cachePath = join(tempDir, "npm-poisoned-pkg.json");
    // Adversary writes a cache entry whose verdict is shaped like
    // "Malicious" (capital M). Under the unsafe-cast code path this would
    // be returned as a cache hit and the connect-time
    // `verdict === "malicious"` check would NOT fire (no exact match) —
    // i.e. the package is treated as safe.
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now(),
        verdict: "Malicious",
        advisoryIds: [],
      }),
      { mode: 0o600 },
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ vulns: [{ id: "MAL-2026-FAKE" }] }),
    } as unknown as Response);

    const result = await osvMalwareCheck("poisoned-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    // The shape-invalid cache entry must be ignored — a fresh fetch fires.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The fresh fetch reports the true verdict (malicious in this case).
    expect(result.verdict).toBe("malicious");
  });

  it("osvMalwareCheck treats cache entry whose advisoryIds is not a string array as miss and re-fetches", async () => {
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const cachePath = join(tempDir, "npm-malformed-adv.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now(),
        verdict: "safe",
        advisoryIds: [42, { id: "MAL-x" }], // wrong element type
      }),
      { mode: 0o600 },
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    const result = await osvMalwareCheck("malformed-adv-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe("safe");
    expect(result.advisoryIds).toEqual([]);
  });

  it("osvMalwareCheck treats cache entry with non-numeric fetchedAt as miss and re-fetches", async () => {
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const cachePath = join(tempDir, "npm-bad-ts.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: "9999-12-31T23:59:59Z", // string, not number
        verdict: "safe",
        advisoryIds: [],
      }),
      { mode: 0o600 },
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    const result = await osvMalwareCheck("bad-ts-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe("safe");
  });

  // -------------------------------------------------------------------------
  // CR-01 regression — chmod on existing cache directory.
  //
  // `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })` ONLY sets mode
  // on newly-created directories. A pre-existing cache dir with looser
  // perms (e.g. inherited from a shared parent or a prior install) keeps
  // its old mode — the cache files inside go in at 0o600, but the parent
  // dir's perms control whether a different user can list/replace files.
  // The fix calls `chmodSync(cacheDir, 0o700)` after mkdirSync so the
  // perms tighten even for pre-existing dirs.
  // -------------------------------------------------------------------------
  it("osvMalwareCheck chmods the cache dir to 0o700 even when it pre-exists with looser perms", async () => {
    // Pre-create the cache dir with deliberately loose perms.
    mkdirSync(tempDir, { recursive: true, mode: 0o755 });
    chmodSync(tempDir, 0o755);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    await osvMalwareCheck("chmod-test-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    // After the call the cache dir mode should be tightened to 0o700.
    const dirMode = statSync(tempDir).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });
});

describe("osvMalwareCheck — verdict resolution against OSV API (SAFETY-05)", () => {
  it("osvMalwareCheck returns malicious verdict for MAL- advisory ID match", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ vulns: [{ id: "MAL-2026-001" }] }),
    } as unknown as Response);

    const result = await osvMalwareCheck("evil-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result.verdict).toBe("malicious");
    expect(result.advisoryIds).toEqual(["MAL-2026-001"]);
  });

  it("osvMalwareCheck returns safe verdict and writes cache file at mode 0o600 on empty API response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    const result = await osvMalwareCheck("empty-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result.verdict).toBe("safe");
    expect(result.advisoryIds).toEqual([]);

    // Verify cache file written with mode 0o600.
    const cachePath = join(tempDir, "npm-empty-pkg.json");
    expect(existsSync(cachePath)).toBe(true);
    const mode = statSync(cachePath).mode & 0o777;
    expect(mode).toBe(0o600);
    // Verify cache payload is well-formed JSON.
    const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as {
      verdict: string;
      advisoryIds: readonly string[];
    };
    expect(cached.verdict).toBe("safe");
    expect(cached.advisoryIds).toEqual([]);
  });
});

describe("osvMalwareCheck — fail-open semantics (SAFETY-05)", () => {
  it("osvMalwareCheck triggers fail-open with dependency errorKind on OSV API non-200", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as unknown as Response);

    const result = await osvMalwareCheck("any-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result.verdict).toBe("safe");
    expect(result.advisoryIds).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency", packageName: "any-pkg" }),
      expect.any(String),
    );
  });

  it("osvMalwareCheck triggers fail-open with network errorKind on fetch throw", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await osvMalwareCheck("any-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result.verdict).toBe("safe");
    expect(result.advisoryIds).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "network", packageName: "any-pkg" }),
      expect.any(String),
    );
  });
});
