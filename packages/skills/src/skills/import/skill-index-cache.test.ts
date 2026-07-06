// SPDX-License-Identifier: Apache-2.0
/**
 * Behaviour suite for the well-known index cache — a names-and-paths disk cache
 * that returns a hit only within its TTL, treats a corrupt or shape-invalid
 * file as a miss (never trusting it), stores no file bodies, is bounded by
 * entry count (oldest evicted beyond the cap), and writes with tight
 * permissions (0o700 dir / 0o600 files) against an injected clock.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSkillIndexCache, type CachedIndexEntry } from "./skill-index-cache.js";

/** The fixed 15-minute freshness window the cache defaults to. */
const DEFAULT_TTL_MS = 900_000;

let tmpRoot: string;
let cacheDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), `skill-index-cache-${randomUUID().slice(0, 8)}-`));
  cacheDir = join(tmpRoot, "skill-index-cache");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** A mutable injected clock. */
function makeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

const SAMPLE: readonly CachedIndexEntry[] = [
  { name: "pdf-extractor", files: ["SKILL.md", "references/notes.md"] },
  { name: "csv-summarizer", files: ["SKILL.md"] },
];

/** Count the JSON cache files currently on disk. */
function cacheFiles(): readonly string[] {
  return readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
}

describe("createSkillIndexCache — TTL round-trip", () => {
  it("returns the stored entries on a get within the TTL window", () => {
    const clock = makeClock(1_000_000);
    const cache = createSkillIndexCache({ cacheDir, now: clock.now });
    cache.put("origin-a", SAMPLE);
    clock.advance(DEFAULT_TTL_MS - 1);
    expect(cache.get("origin-a")).toEqual(SAMPLE);
  });

  it("returns undefined for an origin that was never cached", () => {
    const cache = createSkillIndexCache({ cacheDir });
    expect(cache.get("never-put")).toBeUndefined();
  });

  it("treats an entry read past the TTL as a miss", () => {
    const clock = makeClock(1_000_000);
    const cache = createSkillIndexCache({ cacheDir, now: clock.now });
    cache.put("origin-a", SAMPLE);
    clock.advance(DEFAULT_TTL_MS + 1);
    expect(cache.get("origin-a")).toBeUndefined();
  });

  it("round-trips an entry that advertises no files", () => {
    const clock = makeClock(5);
    const cache = createSkillIndexCache({ cacheDir, now: clock.now });
    cache.put("origin-b", [{ name: "manifest-only" }]);
    expect(cache.get("origin-b")).toEqual([{ name: "manifest-only" }]);
  });

  it("uses the system clock and the 15-minute TTL by default", () => {
    // No injected now/ttl/maxEntries → the module defaults; an immediate get
    // is comfortably inside the default window.
    const cache = createSkillIndexCache({ cacheDir });
    cache.put("origin-default", SAMPLE);
    expect(cache.get("origin-default")).toEqual(SAMPLE);
  });
});

describe("createSkillIndexCache — an untrusted file is a miss", () => {
  it("treats a non-JSON cache file as a miss without throwing", () => {
    const cache = createSkillIndexCache({ cacheDir });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "origin-corrupt.json"), "not-json{", "utf-8");
    expect(cache.get("origin-corrupt")).toBeUndefined();
  });

  it("treats a shape-invalid cache file (skills is the wrong type) as a miss", () => {
    const cache = createSkillIndexCache({ cacheDir });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "origin-drift.json"),
      JSON.stringify({ fetchedAt: 1, skills: "not-an-array" }),
      "utf-8",
    );
    expect(cache.get("origin-drift")).toBeUndefined();
  });
});

describe("createSkillIndexCache — names and paths only", () => {
  it("persists only skill names and rel-paths, never a file body", () => {
    const clock = makeClock(10);
    const cache = createSkillIndexCache({ cacheDir, now: clock.now });
    // A caller hands over an entry that also carries a body-like field; it must
    // NOT be persisted — the cache is names + paths only by construction.
    const withBody = [
      { name: "pdf-extractor", files: ["SKILL.md"], body: "SECRET-BODY-BYTES" },
    ] as unknown as readonly CachedIndexEntry[];
    cache.put("origin-a", withBody);

    const raw = readFileSync(join(cacheDir, "origin-a.json"), "utf-8");
    expect(raw).toContain("pdf-extractor");
    expect(raw).toContain("SKILL.md");
    expect(raw).not.toContain("SECRET-BODY-BYTES");
    expect(raw).not.toContain("body");
    // The round-trip returns only name + files.
    expect(cache.get("origin-a")).toEqual([{ name: "pdf-extractor", files: ["SKILL.md"] }]);
  });
});

describe("createSkillIndexCache — bounded entry count", () => {
  it("evicts the oldest entries once the cap is exceeded", () => {
    const clock = makeClock(1000);
    const cache = createSkillIndexCache({ cacheDir, maxEntries: 3, now: clock.now });
    // Five distinct origins, each strictly newer than the last.
    for (let i = 0; i < 5; i++) {
      cache.put(`origin-${i}`, [{ name: `skill-${i}`, files: ["SKILL.md"] }]);
      clock.advance(1000);
    }
    // At most maxEntries files survive on disk.
    expect(cacheFiles().length).toBe(3);
    // The two oldest were evicted; the newest survives. Elapsed 5s « 15m TTL,
    // so these misses are eviction, not expiry.
    expect(cache.get("origin-0")).toBeUndefined();
    expect(cache.get("origin-1")).toBeUndefined();
    expect(cache.get("origin-4")).toEqual([{ name: "skill-4", files: ["SKILL.md"] }]);
  });

  it("evicts unreadable and shape-invalid cache files first when over the cap", () => {
    const clock = makeClock(1000);
    const cache = createSkillIndexCache({ cacheDir, maxEntries: 1, now: clock.now });
    mkdirSync(cacheDir, { recursive: true });
    // Two pre-existing bad files: one unparseable, one valid-JSON-wrong-shape.
    // Both are treated as oldest, so both are evicted ahead of a fresh write.
    writeFileSync(join(cacheDir, "unreadable.json"), "not-json{", "utf-8");
    writeFileSync(join(cacheDir, "wrong-shape.json"), JSON.stringify({ nope: 1 }), "utf-8");

    cache.put("origin-a", [{ name: "a", files: ["SKILL.md"] }]);

    expect(cacheFiles().length).toBe(1);
    expect(existsSync(join(cacheDir, "unreadable.json"))).toBe(false);
    expect(existsSync(join(cacheDir, "wrong-shape.json"))).toBe(false);
    expect(cache.get("origin-a")).toEqual([{ name: "a", files: ["SKILL.md"] }]);
  });
});

describe("createSkillIndexCache — filesystem safety", () => {
  it("creates the cache dir 0o700 and writes entry files 0o600", () => {
    const cache = createSkillIndexCache({ cacheDir });
    cache.put("origin-a", SAMPLE);
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(cacheDir, "origin-a.json")).mode & 0o777).toBe(0o600);
  });

  it("swallows a write failure (best-effort) instead of throwing", () => {
    // Root the cache dir under a regular FILE → the dir can never be created.
    const filePath = join(tmpRoot, "a-file");
    writeFileSync(filePath, "x", "utf-8");
    const cache = createSkillIndexCache({ cacheDir: join(filePath, "nested-cache") });
    expect(() => cache.put("origin-a", SAMPLE)).not.toThrow();
    expect(cache.get("origin-a")).toBeUndefined();
  });
});
