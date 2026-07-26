// SPDX-License-Identifier: Apache-2.0
/** Cache and bounded-fetch contract for well-known skill sources. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import type {
  SkillImportFetchDeps,
  SkillImportResponse,
} from "./import-fetch.js";
import { fetchWellKnownSkill } from "./wellknown-skill-fetch.js";

const BASE = "https://example.com";
const REF = `wellknown:${BASE}#summarize`;

function response(body: string, status = 200): SkillImportResponse {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode(body);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Bad Gateway",
    headers: new Headers(),
    body: chunks(),
  };
}

function fetchDeps(
  fetchPinned: SkillImportFetchDeps["fetchPinned"],
): SkillImportFetchDeps {
  return {
    validate: async (url) =>
      ok({ hostname: new URL(url).hostname, ip: "198.51.100.40", url: new URL(url) }),
    fetchPinned,
  };
}

function registry() {
  return [{ id: "primary", base: BASE, kind: "wellknown" as const, trust: "community" as const }];
}

describe("fetchWellKnownSkill", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "wellknown-skill-fetch-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("re-fetches an index after its configured cache TTL expires", async () => {
    let indexCalls = 0;
    const pinned = vi.fn(async (url: string) => {
      if (url.endsWith("/.well-known/skills/index.json")) {
        indexCalls += 1;
        return response(JSON.stringify({ skills: [{ name: "summarize" }] }));
      }
      return response("---\nname: summarize\ndescription: Test\n---\nBody");
    });
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const first = await fetchWellKnownSkill({
      ref: REF,
      dataDir,
      registries: registry(),
      cacheTtlMs: 100,
      nowMs: () => 1_000,
      fetchDeps: fetchDeps(pinned),
      logger,
    });
    const second = await fetchWellKnownSkill({
      ref: REF,
      dataDir,
      registries: registry(),
      cacheTtlMs: 100,
      nowMs: () => 1_101,
      fetchDeps: fetchDeps(pinned),
      logger,
    });

    expect(first).toMatchObject({ ok: true, value: { cache: "fresh" } });
    expect(second).toMatchObject({ ok: true, value: { cache: "fresh" } });
    expect(indexCalls).toBe(2);
  });

  it("uses an expired validated index with an explicit coverage warning when refresh fails", async () => {
    let indexCalls = 0;
    const pinned = vi.fn(async (url: string) => {
      if (url.endsWith("/.well-known/skills/index.json")) {
        indexCalls += 1;
        return indexCalls === 1
          ? response(JSON.stringify({ skills: [{ name: "summarize" }] }))
          : response("upstream unavailable", 502);
      }
      return response("---\nname: summarize\ndescription: Test\n---\nBody");
    });
    const logger = { debug: vi.fn(), warn: vi.fn() };

    await fetchWellKnownSkill({
      ref: REF,
      dataDir,
      registries: registry(),
      cacheTtlMs: 100,
      nowMs: () => 1_000,
      fetchDeps: fetchDeps(pinned),
      logger,
    });
    const stale = await fetchWellKnownSkill({
      ref: REF,
      dataDir,
      registries: registry(),
      cacheTtlMs: 100,
      nowMs: () => 1_101,
      fetchDeps: fetchDeps(pinned),
      logger,
    });

    expect(stale).toMatchObject({ ok: true, value: { cache: "stale" } });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ coverage: "stale_index_cache", errorKind: "dependency" }),
      "Well-known skill index refresh degraded to stale cache",
    );
  });

  it("stops a member fetch at the configured per-entry cap", async () => {
    const pinned = vi.fn(async (url: string) =>
      url.endsWith("/.well-known/skills/index.json")
        ? response(JSON.stringify({ skills: [{ name: "summarize" }] }))
        : response("1234"),
    );
    const options = {
      ref: REF,
      dataDir,
      registries: registry(),
      cacheTtlMs: 100,
      maxEntryBytes: 3,
      maxBundleBytes: 32,
      nowMs: () => 1_000,
      fetchDeps: fetchDeps(pinned),
      logger: { debug: vi.fn(), warn: vi.fn() },
    };

    const result = await fetchWellKnownSkill(options);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain(
      "skills.installVetting.maxEntryBytes=3",
    );
  });

  it("refuses query parameters before fetching or recording a well-known reference", async () => {
    const pinned = vi.fn();

    const result = await fetchWellKnownSkill({
      ref: `wellknown:${BASE}?token=test-key#summarize`,
      dataDir,
      registries: registry(),
      cacheTtlMs: 100,
      fetchDeps: fetchDeps(pinned),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("query parameters");
    expect(pinned).not.toHaveBeenCalled();
  });
});
