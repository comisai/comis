// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the OSV malware check + MCP-command package-name
 * extractor introduced at `mcp-client-osv-check.ts`.
 *
 * This file pins:
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

describe("extractMcpPackageName — npx command parsing", () => {
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

describe("extractMcpPackageName — uvx command parsing", () => {
  it("extractMcpPackageName parses uvx pkg into pypi ecosystem entry", () => {
    expect(extractMcpPackageName("uvx", ["yfinance-mcp"])).toEqual({
      ecosystem: "pypi",
      name: "yfinance-mcp",
    });
  });
});

describe("extractMcpPackageName — pnpm dlx command parsing", () => {
  it("extractMcpPackageName parses pnpm dlx pkg into npm ecosystem entry", () => {
    expect(extractMcpPackageName("pnpm", ["dlx", "yfinance-mcp"])).toEqual({
      ecosystem: "npm",
      name: "yfinance-mcp",
    });
  });
});

describe("extractMcpPackageName — unknown commands return null", () => {
  it("extractMcpPackageName returns null for unrecognized node command", () => {
    expect(extractMcpPackageName("node", ["/path/to/server.js"])).toBeNull();
  });

  it("extractMcpPackageName returns null for unrecognized python3 command", () => {
    expect(extractMcpPackageName("python3", ["-m", "server"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regressions — closing extractMcpPackageName OSV-bypass surfaces.
//
// The pre-fix parser had several silent OSV-skip paths a malicious operator
// (or LLM-driven config) could exploit:
//
//   1. `uvx --from <pkg> <tool>` was NOT recognized: `argList[0]` was
//      `--from` (starts with `-`), so the parser returned null and the OSV
//      check was silently skipped with INFO log. uvx's documented
//      `--from <package>` invocation lets an operator point at any pypi
//      package while the binary name is unrelated.
//   2. Version-suffix regex `/@[\d.^~><=*]+$/` was too narrow — it stripped
//      `@1.2.3` and `@^1.0` but NOT dist-tags (`@latest`, `@beta`,
//      `@next`), pre-release suffixes (`@1.0.0-beta.1`), git URLs
//      (`@git+https://...`), file specs (`@file:./pkg`). OSV would be
//      queried with e.g. `yfinance@latest` — not a valid OSV package name,
//      no advisory match, malicious package proceeds.
//   3. `endsWith("npx")` matched any command suffixing with "npx", e.g.
//      `/tmp/mynpx` (symlink to attacker's binary). Constraint should be
//      `basename(command) === "npx"`.
//   4. Multi-arg flag handling: `npx --prefer-online -y pkg` would be
//      truncated to look at `argList[0] === "-y"` only.
// ---------------------------------------------------------------------------
describe("extractMcpPackageName — dist-tag and pre-release suffix strip", () => {
  it("strips @latest dist-tag from npx -y pkg@latest", () => {
    expect(extractMcpPackageName("npx", ["-y", "yfinance@latest"])).toEqual({
      ecosystem: "npm",
      name: "yfinance",
    });
  });

  it("strips @beta dist-tag from npx pkg@beta", () => {
    expect(extractMcpPackageName("npx", ["yfinance@beta"])).toEqual({
      ecosystem: "npm",
      name: "yfinance",
    });
  });

  it("strips pre-release suffix from npx -y pkg@1.0.0-beta.1", () => {
    expect(extractMcpPackageName("npx", ["-y", "yfinance@1.0.0-beta.1"])).toEqual({
      ecosystem: "npm",
      name: "yfinance",
    });
  });

  it("strips build-metadata suffix from npx -y pkg@1.0.0+build.123", () => {
    expect(extractMcpPackageName("npx", ["-y", "yfinance@1.0.0+build.123"])).toEqual({
      ecosystem: "npm",
      name: "yfinance",
    });
  });

  it("strips git URL spec from npx -y pkg@git+https://...", () => {
    expect(extractMcpPackageName("npx", ["-y", "yfinance@git+https://github.com/x/y.git"])).toEqual({
      ecosystem: "npm",
      name: "yfinance",
    });
  });

  it("strips @1.0 scoped pre-release from @scope/pkg@^1.0.0-beta.1", () => {
    expect(extractMcpPackageName("npx", ["-y", "@scope/pkg@^1.0.0-beta.1"])).toEqual({
      ecosystem: "npm",
      name: "@scope/pkg",
    });
  });

  it("strips @latest from scoped package @scope/pkg@latest", () => {
    expect(extractMcpPackageName("npx", ["-y", "@scope/pkg@latest"])).toEqual({
      ecosystem: "npm",
      name: "@scope/pkg",
    });
  });
});

describe("extractMcpPackageName — uvx --from support", () => {
  it("parses uvx --from <pkg> <tool> with --from preceding pkg as pypi", () => {
    expect(extractMcpPackageName("uvx", ["--from", "evil-pkg", "some-tool"])).toEqual({
      ecosystem: "pypi",
      name: "evil-pkg",
    });
  });

  it("parses uvx --from <pkg> <tool> when --from precedes after other flags", () => {
    expect(
      extractMcpPackageName("uvx", ["--quiet", "--from", "evil-pkg", "some-tool"]),
    ).toEqual({ ecosystem: "pypi", name: "evil-pkg" });
  });
});

describe("extractMcpPackageName — basename match", () => {
  it("returns null for command whose basename merely ends with 'npx' (suffix collision)", () => {
    // /tmp/mynpx is a hypothetical attacker symlink — the parser must NOT
    // treat it as npx via endsWith heuristic.
    expect(extractMcpPackageName("/tmp/mynpx", ["-y", "evil"])).toBeNull();
  });

  it("returns null for command 'fakeuvx' that endsWith 'uvx' but is not uvx", () => {
    expect(extractMcpPackageName("/usr/local/bin/fakeuvx", ["pkg"])).toBeNull();
  });

  it("matches absolute path /usr/local/bin/npx via basename", () => {
    expect(extractMcpPackageName("/usr/local/bin/npx", ["-y", "pkg"])).toEqual({
      ecosystem: "npm",
      name: "pkg",
    });
  });
});

describe("extractMcpPackageName — multi-flag arg skipping", () => {
  it("skips ALL leading dash-prefixed flags for npx, not just -y", () => {
    expect(
      extractMcpPackageName("npx", ["--prefer-online", "-y", "yfinance@1.2.3"]),
    ).toEqual({ ecosystem: "npm", name: "yfinance" });
  });
});

// ---------------------------------------------------------------------------
// osvMalwareCheck — API + on-disk cache behavior
// ---------------------------------------------------------------------------

describe("osvMalwareCheck — cache lifecycle", () => {
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
  // Regression — cache-shape validation guards against cache poisoning.
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
  // Regression — chmod on existing cache directory.
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

describe("osvMalwareCheck — verdict resolution against OSV API", () => {
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

// ---------------------------------------------------------------------------
// Process-wide concurrency cap on OSV API calls.
//
// Pre-fix N parallel osvMalwareCheck calls fired N parallel fetches at
// api.osv.dev. The fix serializes the NETWORK portion via a shared
// promise chain, so the fetch calls are ordered strictly. Cache hits
// (including post-wait re-reads for parallel callers of the same pkg)
// short-circuit before reaching the network call.
// ---------------------------------------------------------------------------
describe("osvMalwareCheck — process-wide network serialization", () => {
  it("serializes 5 concurrent osvMalwareCheck calls onto the shared fetch chain", async () => {
    // Track when each fetch begins / ends to detect overlap.
    const fetchEvents: Array<{ pkg: string; phase: "start" | "end"; t: number }> = [];
    let counter = 0;
    const mockFetch = vi.fn().mockImplementation(async (_, init) => {
      // Decode the body to find which package this call is for.
      const body = JSON.parse((init as RequestInit).body as string);
      const pkg = body.package.name as string;
      fetchEvents.push({ pkg, phase: "start", t: ++counter });
      // Force the fetches to take "time" — without await, vi runs them
      // sequentially in microtask order anyway, but this models a real
      // network call's async gap.
      await new Promise((resolve) => setTimeout(resolve, 1));
      fetchEvents.push({ pkg, phase: "end", t: ++counter });
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      } as unknown as Response;
    });

    // Fire 5 concurrent calls on 5 unique packages so cache short-
    // circuits don't mask the serialization behavior.
    const results = await Promise.all([
      osvMalwareCheck("wr06-pkg-1", "npm", { cacheDir: tempDir, ttlMs: 86_400_000, logger, fetchImpl: mockFetch as unknown as typeof fetch }),
      osvMalwareCheck("wr06-pkg-2", "npm", { cacheDir: tempDir, ttlMs: 86_400_000, logger, fetchImpl: mockFetch as unknown as typeof fetch }),
      osvMalwareCheck("wr06-pkg-3", "npm", { cacheDir: tempDir, ttlMs: 86_400_000, logger, fetchImpl: mockFetch as unknown as typeof fetch }),
      osvMalwareCheck("wr06-pkg-4", "npm", { cacheDir: tempDir, ttlMs: 86_400_000, logger, fetchImpl: mockFetch as unknown as typeof fetch }),
      osvMalwareCheck("wr06-pkg-5", "npm", { cacheDir: tempDir, ttlMs: 86_400_000, logger, fetchImpl: mockFetch as unknown as typeof fetch }),
    ]);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.verdict === "safe")).toBe(true);

    // Each pkg's start->end span must close before the next pkg's start.
    // For 5 unique packages we expect 10 events total in start/end/start/end pattern.
    expect(fetchEvents).toHaveLength(10);
    for (let i = 0; i < 5; i++) {
      const startEvent = fetchEvents[i * 2]!;
      const endEvent = fetchEvents[i * 2 + 1]!;
      expect(startEvent.phase).toBe("start");
      expect(endEvent.phase).toBe("end");
      expect(startEvent.pkg).toBe(endEvent.pkg); // start matches its end
    }
  });

  it("concurrent osvMalwareCheck calls for the SAME package coalesce: only ONE fetch fires", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);

    // Fire 4 parallel calls on the SAME package — caller 1 writes the
    // cache, callers 2..4 take their chain slot, re-read the cache,
    // observe the hit, and short-circuit before reaching the fetch.
    const results = await Promise.all([
      osvMalwareCheck("wr06-coalesce", "npm", { cacheDir: tempDir, ttlMs: 86_400_000, logger, fetchImpl: mockFetch as unknown as typeof fetch }),
      osvMalwareCheck("wr06-coalesce", "npm", { cacheDir: tempDir, ttlMs: 86_400_000, logger, fetchImpl: mockFetch as unknown as typeof fetch }),
      osvMalwareCheck("wr06-coalesce", "npm", { cacheDir: tempDir, ttlMs: 86_400_000, logger, fetchImpl: mockFetch as unknown as typeof fetch }),
      osvMalwareCheck("wr06-coalesce", "npm", { cacheDir: tempDir, ttlMs: 86_400_000, logger, fetchImpl: mockFetch as unknown as typeof fetch }),
    ]);
    expect(results.every((r) => r.verdict === "safe")).toBe(true);
    // Coalescing target: 1 leader fetch, the remaining 3 callers cache-hit.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("osvMalwareCheck — fail-open semantics", () => {
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
