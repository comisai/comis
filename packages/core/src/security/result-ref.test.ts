// SPDX-License-Identifier: Apache-2.0
/**
 * Coverage tests for the ResultRef type + its pure threshold/GC math (Phase
 * 212, REF-01/REF-03).
 *
 * ResultRef is NET-NEW and DISTINCT from microcompaction-guard.ts (Gap 2):
 * proactive (a handle BY DEFAULT above a per-tool threshold), workspace-relative
 * `results/` (not `<sessionDir>/tool-results/`), a structured handle (not a
 * string ref), per-run GC lifecycle (not session-lifetime). The actual disk I/O
 * lives in Plan 03's `result-ref-store.ts` (skills); this module is the TYPE +
 * the pure math only — every fn takes an injected `nowMs`/byte-count, so there
 * is zero `Date.now()`/fs coupling (all macOS-unit-testable).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  type ResultRef,
  RESULT_REF_THRESHOLDS,
  DEFAULT_INLINE_THRESHOLD_BYTES,
  PER_FILE_CAP_BYTES,
  PER_RUN_AGGREGATE_CAP_BYTES,
  getResultRefThreshold,
  shouldMaterialize,
  isExpired,
  selectEvictions,
  checkPerFileCap,
  computeExpiresAt,
} from "./result-ref.js";

describe("ResultRef type", () => {
  it("type-checks a structured handle with the optional rows/schema", () => {
    const ref: ResultRef = {
      ref: "results/ws-7af3.jsonl",
      kind: "jsonl",
      bytes: 4096,
      rows: 12,
      schema: ["id", "title"],
      preview: '{"id":1,"title":"a"}\n',
      expiresAt: "2026-06-23T05:00:00.000Z",
    };
    expect(ref.ref).toBe("results/ws-7af3.jsonl");
    expect(ref.kind).toBe("jsonl");

    // rows/schema are optional — a minimal handle still type-checks.
    const minimal: ResultRef = {
      ref: "results/ws-0001.text",
      kind: "text",
      bytes: 10,
      preview: "hello",
      expiresAt: "2026-06-23T05:00:00.000Z",
    };
    expect(minimal.rows).toBeUndefined();
    expect(minimal.schema).toBeUndefined();
  });
});

describe("getResultRefThreshold / shouldMaterialize", () => {
  it("returns a finite threshold for high-volume tools", () => {
    expect(Number.isFinite(getResultRefThreshold("web_fetch"))).toBe(true);
    expect(getResultRefThreshold("web_fetch")).toBe(RESULT_REF_THRESHOLDS.web_fetch);
    // the other documented high-volume tools are finite too
    for (const tool of ["web_search", "extract_document", "grep", "read"]) {
      expect(Number.isFinite(getResultRefThreshold(tool))).toBe(true);
    }
  });

  it("returns the high default for a non-high-volume or unknown tool", () => {
    // a small/non-high-volume tool stays inline (threshold = the high default)
    expect(getResultRefThreshold("memory_get")).toBe(DEFAULT_INLINE_THRESHOLD_BYTES);
    expect(getResultRefThreshold("definitely_not_a_tool")).toBe(DEFAULT_INLINE_THRESHOLD_BYTES);
    // the high default is strictly larger than the high-volume threshold
    expect(DEFAULT_INLINE_THRESHOLD_BYTES).toBeGreaterThan(RESULT_REF_THRESHOLDS.web_fetch);
  });

  it("materializes only when the byte count exceeds the tool threshold", () => {
    const t = getResultRefThreshold("web_fetch");
    expect(shouldMaterialize("web_fetch", t + 1)).toBe(true);
    expect(shouldMaterialize("web_fetch", t)).toBe(false); // boundary: > not >=
    expect(shouldMaterialize("web_fetch", t - 1)).toBe(false);
    // a non-high-volume tool with a huge default never materializes at sane sizes
    expect(shouldMaterialize("memory_get", 1_000_000)).toBe(false);
  });
});

describe("isExpired", () => {
  it("returns true past the TTL and false before it", () => {
    const expiresAt = "2026-06-23T05:00:00.000Z";
    const expiryMs = Date.parse(expiresAt);
    expect(isExpired(expiresAt, expiryMs - 1)).toBe(false); // before
    expect(isExpired(expiresAt, expiryMs)).toBe(false); // exactly at expiry — not yet past
    expect(isExpired(expiresAt, expiryMs + 1)).toBe(true); // past
  });
});

describe("computeExpiresAt", () => {
  it("returns an ISO string the given ttl in the future", () => {
    const nowMs = Date.parse("2026-06-23T04:00:00.000Z");
    const ttlMs = 60 * 60 * 1000; // 1h
    const iso = computeExpiresAt(nowMs, ttlMs);
    expect(iso).toBe("2026-06-23T05:00:00.000Z");
    expect(Date.parse(iso)).toBe(nowMs + ttlMs);
  });
});

describe("selectEvictions", () => {
  it("returns the oldest paths until the aggregate is under the cap", () => {
    const entries = [
      { path: "results/c.jsonl", bytes: 300, createdAtMs: 3000 },
      { path: "results/a.jsonl", bytes: 500, createdAtMs: 1000 },
      { path: "results/b.jsonl", bytes: 400, createdAtMs: 2000 },
    ];
    // total = 1200; cap = 600 → must evict the 600 oldest bytes:
    // oldest a(500)+b(400)=900 ≤ 1200-600=600? Need to drop until remaining ≤ 600.
    // remaining after dropping a = 700 (> 600); after dropping a,b = 300 (≤ 600).
    const evicted = selectEvictions(entries, 600);
    expect(evicted).toEqual(["results/a.jsonl", "results/b.jsonl"]);
  });

  it("returns an empty list when already under the aggregate cap", () => {
    const entries = [{ path: "results/a.jsonl", bytes: 100, createdAtMs: 1000 }];
    expect(selectEvictions(entries, 1000)).toEqual([]);
  });

  it("evicts oldest-first regardless of input order", () => {
    const entries = [
      { path: "results/new.jsonl", bytes: 1000, createdAtMs: 9999 },
      { path: "results/old.jsonl", bytes: 1000, createdAtMs: 1 },
    ];
    // total 2000, cap 1000 → drop the single oldest (old)
    expect(selectEvictions(entries, 1000)).toEqual(["results/old.jsonl"]);
  });
});

describe("checkPerFileCap", () => {
  it("returns ok when the byte count is within the per-file cap", () => {
    const r = checkPerFileCap(1000, 2000);
    expect(r.ok).toBe(true);
  });

  it("returns an err handle describing the overflow when over the cap", () => {
    const r = checkPerFileCap(3000, 2000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("result_ref_too_large");
      expect(r.error.bytes).toBe(3000);
      expect(r.error.cap).toBe(2000);
    }
  });

  it("treats exactly-at-cap as within the cap (<= not <)", () => {
    expect(checkPerFileCap(2000, 2000).ok).toBe(true);
  });
});

describe("result-ref cap constants", () => {
  it("declares sane M1 per-file and per-run aggregate caps", () => {
    expect(PER_FILE_CAP_BYTES).toBeGreaterThan(0);
    expect(PER_RUN_AGGREGATE_CAP_BYTES).toBeGreaterThan(PER_FILE_CAP_BYTES);
  });
});
