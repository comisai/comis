// SPDX-License-Identifier: Apache-2.0
/**
 * RED->GREEN unit suite for the letta-fs-baseline adapter (PROVE-01 honesty
 * anchor) — the keyless Letta-style filesystem-tool CONTROL that conforms to the
 * Task-1 `CompetitorAdapter` interface by wrapping the existing pure
 * `formatFilesystemContext` full-haystack formatter.
 *
 * WHY IT EXISTS (the honesty control): a deliberately-trivial no-memory baseline.
 * It dumps the ENTIRE haystack (no ranking, no top-k) and lets the same answer +
 * judge models grade it. If a full-dump baseline ties/beats Comis's ranked recall
 * on a benchmark, the BENCHMARK is weak, not Comis (Letta's filesystem agent
 * scored 74.0% on LoCoMo, above Mem0's self-reported 68.5%). It is recorded ONLY
 * under an explicit control label + isControl:true — NEVER as Comis's headline
 * (T-98-02-01 / T-104-03-04).
 *
 * KEYLESS at $0: no env, no key, no provider call — the formatter is pure. This is
 * the ONLY competitor adapter that actually runs in the keyless CI.
 *
 * UNGATED, default-CI: pure deterministic. ARCHITECTURE: imports the in-package
 * modules only — no @comis/memory.
 */

import { describe, it, expect } from "vitest";
import {
  createLettaFsBaselineAdapter,
  LETTA_FS_BASELINE_CONTROL_LABEL,
} from "./letta-fs-baseline-adapter.js";
import type { AdapterConfig } from "./competitor-adapter.js";

/** Build an AdapterConfig carrying a per-cell haystack (the open extension key). */
function cfgWithDocs(docs: ReadonlyArray<{ content: string; createdAt: number }>): AdapterConfig {
  return { tier: "j1", docs };
}

describe("letta-fs-baseline-adapter — the keyless Letta-style filesystem control (PROVE-01)", () => {
  it("Test 1 (RED): system === 'letta-fs-baseline' and isControl === true (the control flag)", () => {
    const adapter = createLettaFsBaselineAdapter();
    expect(adapter.system).toBe("letta-fs-baseline");
    expect(adapter.isControl).toBe(true);
  });

  it("Test 2 (RED): run(tier, config) over a haystack runs keyless ($0) -> ran:true, isControl:true", async () => {
    // No env set, no key, no provider — the formatter is pure. We additionally
    // snapshot process.env to prove the run touched no environment.
    const envBefore = JSON.stringify(process.env);
    const adapter = createLettaFsBaselineAdapter();
    const out = await adapter.run(
      "j1",
      cfgWithDocs([
        { content: "alpha-fact", createdAt: 1 },
        { content: "beta-fact", createdAt: 2 },
      ]),
    );
    expect(out.ran).toBe(true);
    if (!out.ran) {
      throw new Error("expected ran:true");
    }
    expect(out.isControl).toBe(true);
    expect(out.system).toBe("letta-fs-baseline");
    expect(typeof out.manifestRef).toBe("string");
    expect(out.manifestRef.length).toBeGreaterThan(0);
    expect(JSON.stringify(process.env)).toBe(envBefore);
  });

  it("Test 3 (RED): the formatted control context dumps EVERY doc in createdAt order (no top-k)", async () => {
    // >=6 docs proves it is NOT a top-5 like ranked recall (the load-bearing
    // full-dump control semantics).
    const docs = [
      { content: "doc-content-0", createdAt: 70 },
      { content: "doc-content-1", createdAt: 60 },
      { content: "doc-content-2", createdAt: 50 },
      { content: "doc-content-3", createdAt: 40 },
      { content: "doc-content-4", createdAt: 30 },
      { content: "doc-content-5", createdAt: 20 },
      { content: "doc-content-6", createdAt: 10 },
    ];
    const adapter = createLettaFsBaselineAdapter();
    const context = adapter.formatControlContext(docs);
    for (const d of docs) {
      expect(context, `every doc must be present (no truncation): ${d.content}`).toContain(
        d.content,
      );
    }
    // createdAt-ascending order: doc-content-6 (createdAt 10) precedes doc-content-0 (createdAt 70).
    expect(context.indexOf("doc-content-6")).toBeLessThan(context.indexOf("doc-content-0"));
  });

  it("Test 4 (RED, prototype-pollution): a '__proto__' content value is TEXT, never mutates Object.prototype", async () => {
    const before = ({} as Record<string, unknown>).polluted;
    expect(before).toBeUndefined();
    const adapter = createLettaFsBaselineAdapter();
    const context = adapter.formatControlContext([
      { content: "__proto__", createdAt: 1 },
      { content: "constructor", createdAt: 2 },
      { content: '{"polluted":true}', createdAt: 3 },
    ]);
    expect(context).toContain("__proto__");
    expect(context).toContain("constructor");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("Test 5 (RED, control-label): the result + manifest carry an explicit control label, never Comis's headline", async () => {
    const adapter = createLettaFsBaselineAdapter();
    // The exported label is a fixed control identifier.
    expect(LETTA_FS_BASELINE_CONTROL_LABEL).toMatch(/control/i);
    const out = await adapter.run("j1", cfgWithDocs([{ content: "x", createdAt: 1 }]));
    expect(out.ran).toBe(true);
    if (!out.ran) {
      throw new Error("expected ran:true");
    }
    // Structurally a control: isControl:true so it can NEVER be mistaken for the
    // Comis cell, and the manifestRef references the control label.
    expect(out.isControl).toBe(true);
    expect(out.manifestRef).toContain(LETTA_FS_BASELINE_CONTROL_LABEL);
  });

  it("Test 6: an empty haystack still runs (total, never throws) and dumps the empty sentinel", async () => {
    const adapter = createLettaFsBaselineAdapter();
    const context = adapter.formatControlContext([]);
    expect(typeof context).toBe("string");
    expect(context.length).toBeGreaterThan(0); // the (empty filesystem) sentinel
    const out = await adapter.run("j1", cfgWithDocs([]));
    expect(out.ran).toBe(true);
  });

  it("Test 7 (RED, WR-02): run() OBSERVES the formatted control context — contextChars equals the rendered length (the format call is load-bearing, not dead)", async () => {
    // The honesty contract: the control's only real keyless work is formatting the
    // full-dump context. The run MUST observe that work (record its length), so a
    // linter/refactor cannot delete the format call with zero behavioural change.
    const adapter = createLettaFsBaselineAdapter();
    const docs = [
      { content: "alpha-fact", createdAt: 1 },
      { content: "beta-fact", createdAt: 2 },
    ];
    const expectedChars = adapter.formatControlContext(docs).length;
    const out = await adapter.run("j1", cfgWithDocs(docs));
    expect(out.ran).toBe(true);
    if (!out.ran) {
      throw new Error("expected ran:true");
    }
    // The observed length is the rendered context's length — load-bearing proof the
    // run actually formatted the haystack (a discarded call could not produce this).
    expect(out.contextChars).toBe(expectedChars);
    expect(out.contextChars).toBeGreaterThan(0);
  });

  it("Test 8 (RED, WR-02): contextChars tracks the haystack — a larger haystack yields a larger observed context", async () => {
    const adapter = createLettaFsBaselineAdapter();
    const small = await adapter.run("j1", cfgWithDocs([{ content: "x", createdAt: 1 }]));
    const large = await adapter.run(
      "j1",
      cfgWithDocs([
        { content: "a-much-longer-document-body-here", createdAt: 1 },
        { content: "and-a-second-longer-document-body", createdAt: 2 },
      ]),
    );
    expect(small.ran && large.ran).toBe(true);
    if (!small.ran || !large.ran) {
      throw new Error("expected both ran:true");
    }
    expect(large.contextChars).toBeGreaterThan(small.contextChars);
  });
});
