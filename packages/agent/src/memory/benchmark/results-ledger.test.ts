// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first co-located unit tests for the append-only results ledger -- the
 * dated, append-only, NEVER-OVERWRITTEN results history.
 *
 * THE LOAD-BEARING TEST (Test 3): the never-overwrite invariant. The key fact
 * (fs-safe.ts:436-452) is that
 * `writeRegularFile`'s default `unlinkExisting:true` SILENTLY OVERWRITES a
 * pre-existing dated file -- the O_EXCL there is anti-TOCTOU-symlink, NOT
 * anti-clobber. So the never-overwrite invariant is enforced by an explicit
 * `existsSync` guard in `appendLedgerRow`, and this test proves the REAL
 * semantics: a 2nd write for an already-written dated path is REFUSED (ok:false)
 * AND the 1st file's bytes are byte-identical to the first read.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLedgerRow, appendLedgerRow, ledgerRowPath, type LedgerRow } from "./results-ledger.js";
import type { CategorySpread } from "./cross-judge-spread.js";
import type { ProportionTest } from "./significance.js";
import type { BenchmarkCost, BenchmarkLatency } from "./qa-report.js";

// A fixed injected epoch (never a wall-clock read) -- 2023-11-14T22:13:20.000Z.
const NOW_MS = 1_700_000_000_000;

function makeSpread(): CategorySpread[] {
  return [
    { category: "single-hop", judgeA: 71.1, judgeB: 73.3, spread: 2.2, survives: true },
    { category: "multi-session", judgeA: 30, judgeB: 45, spread: 15, survives: false },
  ];
}

function makeCost(): BenchmarkCost {
  return { answerTokensPerQuery: 412, judgeTokensPerQuery: 88, totalTokensPerQuery: 500 };
}

function makeLatency(): BenchmarkLatency {
  return {
    recallP50Ms: 12,
    recallP95Ms: 28,
    answerP50Ms: 800,
    answerP95Ms: 1500,
    judgeP50Ms: 600,
    judgeP95Ms: 1100,
    endToEndP50Ms: 1412,
    endToEndP95Ms: 2628,
  };
}

function makeSig(): ProportionTest {
  return { n: 120, pValue: 0.012, significant: true };
}

/** A clean ledger-row INPUT (everything but the injected timestamp). */
function makeRowInput(overrides: Partial<Omit<LedgerRow, "timestamp">> = {}): Omit<LedgerRow, "timestamp"> {
  return {
    date: "2026-06-02",
    commit: "abc1234",
    branch: "bench/prove-climb",
    systemVersions: { comis: "1.0.0", pi: "0.78.0" },
    tier: "head-to-head",
    judgeSpread: makeSpread(),
    n: 120,
    significance: makeSig(),
    cost: makeCost(),
    latency: makeLatency(),
    ...overrides,
  };
}

describe("results-ledger -- buildLedgerRow (pure dated-row builder)", () => {
  it("Test 1: builds a row whose timestamp is the INJECTED clock and whose fields are exactly the contract fields", () => {
    const row = buildLedgerRow(makeRowInput(), NOW_MS);

    // Injected clock -- the ISO derived from NOW_MS, never Date.now().
    expect(row.timestamp).toBe(new Date(NOW_MS).toISOString());

    // Every contract field carried through, field-by-field.
    expect(row.date).toBe("2026-06-02");
    expect(row.commit).toBe("abc1234");
    expect(row.branch).toBe("bench/prove-climb");
    expect(row.tier).toBe("head-to-head");
    expect(row.n).toBe(120);
    expect(row.significance).toEqual({ n: 120, pValue: 0.012, significant: true });
    expect(row.systemVersions).toEqual({ comis: "1.0.0", pi: "0.78.0" });
    expect(row.judgeSpread).toHaveLength(2);
    expect(row.judgeSpread[0]).toEqual({
      category: "single-hop",
      judgeA: 71.1,
      judgeB: 73.3,
      spread: 2.2,
      survives: true,
    });
    expect(row.cost.totalTokensPerQuery).toBe(500);
    expect(row.latency.endToEndP95Ms).toBe(2628);

    // The exact key set -- no extra fields leaked in.
    expect(Object.keys(row).sort()).toEqual(
      [
        "branch",
        "commit",
        "cost",
        "date",
        "judgeSpread",
        "latency",
        "n",
        "significance",
        "systemVersions",
        "tier",
        "timestamp",
      ].sort(),
    );
  });

  it("Test 1b: rebuilds nested structures (no input-spread aliasing) -- mutating the input afterwards does not change the row", () => {
    const input = makeRowInput();
    const row = buildLedgerRow(input, NOW_MS);

    // Mutate the INPUT after the build -- a field-by-field rebuild must be unaffected.
    input.judgeSpread[0].judgeA = 999;
    input.systemVersions.comis = "9.9.9";
    input.cost.totalTokensPerQuery = -1;

    expect(row.judgeSpread[0].judgeA).toBe(71.1);
    expect(row.systemVersions.comis).toBe("1.0.0");
    expect(row.cost.totalTokensPerQuery).toBe(500);
  });

  it("Test 1c: a null significance (a degenerate/un-tested run) is carried through as null, never fabricated", () => {
    const row = buildLedgerRow(makeRowInput({ significance: null }), NOW_MS);
    expect(row.significance).toBeNull();
  });

  it("Test 2 (secret-omission): a config-shaped secret hung off the input + a credentialed model URI never reach the row", () => {
    // Hang an off-contract secret on the input + a userinfo-bearing model URI in systemVersions.
    const polluted = makeRowInput({
      systemVersions: {
        comis: "1.0.0",
        // A free-form model URI carrying embedded credentials -- must be sanitized.
        embedding: "https://user:secret@host.example/v1/models/text-embedding",
      },
    }) as Omit<LedgerRow, "timestamp"> & { apiKey?: string; authorization?: string };
    polluted.apiKey = "sk-SHOULD-NOT-APPEAR-0123456789";
    polluted.authorization = "Bearer sk-leak-9876543210";

    const row = buildLedgerRow(polluted, NOW_MS);
    const json = JSON.stringify(row);

    // No credential substring of any shape survives.
    expect(json).not.toMatch(/apiKey/);
    expect(json).not.toMatch(/sk-/);
    expect(json).not.toMatch(/Bearer/);
    expect(json).not.toMatch(/secret@/);
    // The sanitized URI keeps scheme+host+path but drops the userinfo.
    expect(row.systemVersions.embedding).toBe("https://host.example/v1/models/text-embedding");
    // The legitimate version survives.
    expect(row.systemVersions.comis).toBe("1.0.0");
  });
});

describe("results-ledger -- appendLedgerRow (the never-overwrite ledger)", () => {
  it("Test 3 (LOAD-BEARING never-overwrite): a 2nd write for the SAME dated path is REFUSED and the 1st file's bytes are UNCHANGED", () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-ledger-overwrite-"));
    try {
      const row1 = buildLedgerRow(makeRowInput(), NOW_MS);
      const first = appendLedgerRow({ historyDir: dir, row: row1 });
      expect(first.ok, "the first dated write succeeds").toBe(true);
      if (!first.ok) return;

      const path1 = first.value.path;
      const bytesAfterFirst = readFileSync(path1);

      // A SECOND write for the SAME date/commit but DIFFERENT content (a re-run).
      const row1Different = buildLedgerRow(makeRowInput({ n: 999 }), NOW_MS + 5_000);
      const second = appendLedgerRow({ historyDir: dir, row: row1Different });

      // The explicit existsSync guard refuses the clobber.
      expect(second.ok, "a 2nd write for an existing dated path is REFUSED").toBe(false);

      // The on-disk file's bytes are byte-identical to the first read (no silent overwrite).
      const bytesAfterSecond = readFileSync(path1);
      expect(bytesAfterSecond.equals(bytesAfterFirst)).toBe(true);
      // And the content is still row1's (n:120), not row1Different's (n:999).
      const parsed = JSON.parse(bytesAfterSecond.toString("utf8")) as LedgerRow;
      expect(parsed.n).toBe(120);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Test 4: a DIFFERENT date/commit write SUCCEEDS and BOTH dated files coexist (the genuine append)", () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-ledger-coexist-"));
    try {
      const rowA = buildLedgerRow(makeRowInput({ date: "2026-06-02", commit: "abc1234" }), NOW_MS);
      const rowB = buildLedgerRow(makeRowInput({ date: "2026-06-03", commit: "def5678" }), NOW_MS);

      const a = appendLedgerRow({ historyDir: dir, row: rowA });
      const b = appendLedgerRow({ historyDir: dir, row: rowB });
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;

      // Both dated entries exist on disk and are distinct paths.
      expect(a.value.path).not.toBe(b.value.path);
      expect(existsSync(a.value.path)).toBe(true);
      expect(existsSync(b.value.path)).toBe(true);

      // The first entry is untouched by the second (no mutation of a prior entry).
      const parsedA = JSON.parse(readFileSync(a.value.path, "utf8")) as LedgerRow;
      expect(parsedA.commit).toBe("abc1234");
      expect(parsedA.date).toBe("2026-06-02");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Test 4b: the same DATE but a DIFFERENT commit is non-colliding (the commit-in-the-filename design)", () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-ledger-samedate-"));
    try {
      const a = appendLedgerRow({
        historyDir: dir,
        row: buildLedgerRow(makeRowInput({ date: "2026-06-02", commit: "aaa0001" }), NOW_MS),
      });
      const b = appendLedgerRow({
        historyDir: dir,
        row: buildLedgerRow(makeRowInput({ date: "2026-06-02", commit: "bbb0002" }), NOW_MS),
      });
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) expect(a.value.path).not.toBe(b.value.path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Test 5: a date/commit that would traverse outside the confined history dir is REJECTED (err, never a write)", () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-ledger-traversal-"));
    try {
      // A traversal-shaped commit segment -- safePath must refuse to build a path
      // that escapes the history dir (and appendLedgerRow converts that to an err).
      const evil = buildLedgerRow(makeRowInput({ commit: "../../etc/passwd" }), NOW_MS);
      const r = appendLedgerRow({ historyDir: dir, row: evil });
      expect(r.ok, "a traversal path is rejected").toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("results-ledger -- ledgerRowPath (the dated filename)", () => {
  it("Test 6: composes <date>-<commit>.json under the history dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "comis-ledger-path-"));
    try {
      const p = ledgerRowPath(dir, "2026-06-02", "abc1234");
      expect(p.endsWith(`${"2026-06-02"}-abc1234.json`)).toBe(true);
      expect(p.startsWith(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
