// SPDX-License-Identifier: Apache-2.0
/**
 * OSV malware check integration test.
 *
 * Pins the public-API contract surfaced through @comis/skills (loaded
 * from `dist/` per the Vitest alias). Covers the 5 OSV API branches
 * + 6 package-name extraction cases from a real consumer's vantage
 * point, mirroring the integration pattern set with
 * `mcp-env-scrub.test.ts`.
 *
 * The unit-level branch coverage lives in the co-located
 * `packages/skills/src/skills/integrations/mcp-client/mcp-client-osv-check.test.ts`;
 * this file is the boundary check that the `@comis/skills` barrel
 * still exposes the entry points unchanged.
 *
 * Per CLAUDE.md: integration tests import from `dist/`; this file
 * relies on `pnpm --filter=@comis/skills build` having run before
 * vitest executes (or `pnpm build` for the full workspace).
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { osvMalwareCheck, extractMcpPackageName } from "@comis/skills";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const createMockLogger = () => {
  const mock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return mock;
};

// ---------------------------------------------------------------------------
// osvMalwareCheck — branch coverage from public-API consumer perspective
// ---------------------------------------------------------------------------

describe("OSV malware check — integration boundary", () => {
  let tempDir: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "osv-integ-"));
    logger = createMockLogger();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("OSV malware check returns malicious verdict for MAL- advisory ID match", async () => {
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

  it("OSV API non-200 response triggers fail-open with dependency errorKind WARN", async () => {
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
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency" }),
      expect.any(String),
    );
  });

  it("OSV API network error triggers fail-open with network errorKind WARN", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await osvMalwareCheck("any-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result.verdict).toBe("safe");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "network" }),
      expect.any(String),
    );
  });

  it("OSV cache hit within TTL returns cached verdict without fetch invocation", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);
    // First call: cache miss → write
    await osvMalwareCheck("safe-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Second call: cache hit → no new fetch
    const result = await osvMalwareCheck("safe-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result.verdict).toBe("safe");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("OSV empty response writes safe cache entry with mode 0o600", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response);
    await osvMalwareCheck("empty-pkg", "npm", {
      cacheDir: tempDir,
      ttlMs: 86_400_000,
      logger,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    const cachePath = join(tempDir, "npm-empty-pkg.json");
    expect(existsSync(cachePath)).toBe(true);
    const mode = statSync(cachePath).mode & 0o777;
    expect(mode).toBe(0o600);
    const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as {
      verdict: string;
      advisoryIds: readonly string[];
    };
    expect(cached.verdict).toBe("safe");
  });
});

// ---------------------------------------------------------------------------
// extractMcpPackageName — package-name extraction boundary
// ---------------------------------------------------------------------------

describe("extractMcpPackageName — package extraction boundary", () => {
  it("extractMcpPackageName parses npx -y @org/pkg into npm ecosystem", () => {
    expect(
      extractMcpPackageName("npx", ["-y", "@modelcontextprotocol/server-yfinance"]),
    ).toEqual({
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

  it("extractMcpPackageName parses uvx pkg into pypi ecosystem", () => {
    expect(extractMcpPackageName("uvx", ["yfinance-mcp"])).toEqual({
      ecosystem: "pypi",
      name: "yfinance-mcp",
    });
  });

  it("extractMcpPackageName parses pnpm dlx pkg into npm ecosystem", () => {
    expect(extractMcpPackageName("pnpm", ["dlx", "yfinance-mcp"])).toEqual({
      ecosystem: "npm",
      name: "yfinance-mcp",
    });
  });

  it("extractMcpPackageName returns null for unrecognized node command", () => {
    expect(extractMcpPackageName("node", ["/path/to/server.js"])).toBeNull();
  });

  it("extractMcpPackageName returns null for unrecognized python3 command", () => {
    expect(extractMcpPackageName("python3", ["-m", "server"])).toBeNull();
  });
});
