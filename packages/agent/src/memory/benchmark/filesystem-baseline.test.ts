// SPDX-License-Identifier: Apache-2.0
/**
 * RED->GREEN unit suite for {@link formatFilesystemContext} (the Letta-style
 * filesystem-tool CONTROL) — the deliberately-trivial no-memory reference the
 * gated QA harness records as a labelled control row.
 *
 * THE LOAD-BEARING PROPERTY (what distinguishes the control from recall): the
 * formatter dumps the FULL haystack — EVERY doc, in deterministic order, with NO
 * relevance ranking and NO top-k truncation. Recall returns a ranked top-5; the
 * control returns the whole "filesystem". If a full-dump baseline ties/beats
 * Comis's ranked recall on a benchmark, the *benchmark* is weak (exactly how
 * Letta showed a filesystem agent scored 74.0% on LoCoMo, above Mem0's
 * self-reported 68.5%).
 *
 * UNGATED, default-CI: pure deterministic string construction (no clock, no I/O,
 * no provider). Imports `filesystem-baseline.ts` so it is never a 0%-coverage
 * file under the agent all:true floor.
 *
 * SECURITY — prototype-pollution discipline: the doc `content`
 * strings originate from the UNTRUSTED dataset haystack. The formatter builds the
 * dump by string concatenation only and NEVER uses doc content as an object key,
 * so a `"__proto__"` / `"constructor"` content value becomes ordinary rendered
 * text and can NEVER mutate `Object.prototype` (mirrors qa-accuracy.ts /
 * longmemeval-loader.ts's null-proto + literal-key discipline).
 *
 * ARCHITECTURE: imports the in-package pure module only — no @comis/memory (the
 * control stays inside the @comis/agent ↛ @comis/memory cut; the harness wiring is
 * the `.bench.test.ts` cut escape).
 */

import { describe, it, expect } from "vitest";
import { formatFilesystemContext } from "./filesystem-baseline.js";

describe("formatFilesystemContext -- Letta-style full-dump control", () => {
  it("Test 1 (RED): the dump contains BOTH docs' content (the trivial full-context baseline)", () => {
    const out = formatFilesystemContext([
      { content: "alpha-fact", createdAt: 1 },
      { content: "beta-fact", createdAt: 2 },
    ]);
    expect(out).toContain("alpha-fact");
    expect(out).toContain("beta-fact");
  });

  it("Test 2 (THE LOAD-BEARING PROPERTY): an N-doc input dumps ALL N docs (no top-k truncation, unlike ranked recall)", () => {
    // ≥6 docs proves it is NOT a top-5 like recall (maxResults:5 in the harness).
    const docs = [
      { content: "doc-content-0", createdAt: 10 },
      { content: "doc-content-1", createdAt: 20 },
      { content: "doc-content-2", createdAt: 30 },
      { content: "doc-content-3", createdAt: 40 },
      { content: "doc-content-4", createdAt: 50 },
      { content: "doc-content-5", createdAt: 60 },
      { content: "doc-content-6", createdAt: 70 },
    ];
    const out = formatFilesystemContext(docs);
    for (const d of docs) {
      expect(out, `every doc content must be present (no truncation): ${d.content}`).toContain(
        d.content,
      );
    }
  });

  it("Test 3: docs are emitted in deterministic createdAt-ascending order (reproducible control context)", () => {
    // Supplied out of order; the dump must order by createdAt ascending so the
    // control context is reproducible regardless of input order.
    const out = formatFilesystemContext([
      { content: "third-newest", createdAt: 300 },
      { content: "first-oldest", createdAt: 100 },
      { content: "second-middle", createdAt: 200 },
    ]);
    const iFirst = out.indexOf("first-oldest");
    const iSecond = out.indexOf("second-middle");
    const iThird = out.indexOf("third-newest");
    expect(iFirst).toBeGreaterThanOrEqual(0);
    expect(iFirst).toBeLessThan(iSecond);
    expect(iSecond).toBeLessThan(iThird);
  });

  it("Test 4: a stable order on equal createdAt (ties keep input order; total + deterministic)", () => {
    const out = formatFilesystemContext([
      { content: "tie-A", createdAt: 5 },
      { content: "tie-B", createdAt: 5 },
      { content: "tie-C", createdAt: 5 },
    ]);
    expect(out.indexOf("tie-A")).toBeLessThan(out.indexOf("tie-B"));
    expect(out.indexOf("tie-B")).toBeLessThan(out.indexOf("tie-C"));
  });

  it("Test 5 (SECURITY): a doc whose content is the literal '__proto__' does NOT pollute Object.prototype", () => {
    const before = ({} as Record<string, unknown>).polluted;
    expect(before).toBeUndefined();
    const out = formatFilesystemContext([
      { content: "__proto__", createdAt: 1 },
      { content: "constructor", createdAt: 2 },
      { content: '{"polluted":true}', createdAt: 3 },
    ]);
    // The malicious content is emitted as plain text...
    expect(out).toContain("__proto__");
    expect(out).toContain("constructor");
    // ...and NO object prototype was mutated.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("Test 6: a very large doc is included verbatim (no silent drop by size)", () => {
    const big = "X".repeat(200_000);
    const out = formatFilesystemContext([
      { content: "small-marker", createdAt: 1 },
      { content: big, createdAt: 2 },
    ]);
    expect(out).toContain(big);
    expect(out).toContain("small-marker");
  });

  it("Test 7: an empty haystack yields a total (non-throwing) string", () => {
    expect(() => formatFilesystemContext([])).not.toThrow();
    expect(typeof formatFilesystemContext([])).toBe("string");
  });
});
