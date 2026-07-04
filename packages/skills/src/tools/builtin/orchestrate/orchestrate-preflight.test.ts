// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the three pure orchestrate pre-flight helpers —
 * `extractCapabilityFootprint`, `classifyRecoverableStderr`, and
 * `buildDescribeDigest`. RED-first (TDD): the suite fails to load on pre-patch
 * code (the module does not exist) and goes green once `orchestrate-preflight.ts`
 * ships.
 *
 * All three are pure and total (no eval/fs/net): a model-authored script scanned
 * as INERT TEXT → a capability footprint; a bounded stderr tail → a closed
 * recoverable class (or none); a deterministic name+capability projection of the
 * tool cap-map. These cases pin the token-scan tolerance (whitespace across the
 * `comis_tools . method` boundary; the `comis_tools.<m>(` ts/js floor), the
 * ordered first-match classifier (misuse before the generic type_error), and the
 * digest's determinism + bound.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  extractCapabilityFootprint,
  classifyRecoverableStderr,
  buildDescribeDigest,
} from "./orchestrate-preflight.js";

describe("extractCapabilityFootprint", () => {
  it("maps a single comis_tools.web_fetch( call site to orch:web", () => {
    const out = extractCapabilityFootprint("const r = await comis_tools.web_fetch({url});");

    expect([...out.caps]).toEqual(["orch:web"]);
    expect(out.methods).toEqual(["web_fetch"]);
    expect(out.unknownMethods).toEqual([]);
  });

  it("collects BOTH capabilities from a mixed read + web_search script (methods sorted)", () => {
    const script = `
      const f = await comis_tools.read({ path: "results/x.jsonl" });
      const s = await comis_tools.web_search({ query: "who wrote it" });
    `;
    const out = extractCapabilityFootprint(script);

    expect(out.caps.has("orch:read")).toBe(true);
    expect(out.caps.has("orch:web")).toBe(true);
    expect(out.caps.size).toBe(2);
    expect(out.methods).toEqual(["read", "web_search"]); // sorted, deduped
    expect(out.unknownMethods).toEqual([]);
  });

  it("reports an unknown comis_tools method as DATA rather than throwing, with empty caps", () => {
    const out = extractCapabilityFootprint("await comis_tools.not_a_tool({});");

    expect(out.unknownMethods).toEqual(["not_a_tool"]);
    expect(out.caps.size).toBe(0);
    expect(out.methods).toEqual([]);
  });

  it("is whitespace/newline tolerant across the comis_tools . method boundary", () => {
    const out = extractCapabilityFootprint("comis_tools\n  .\n  web_fetch ({url});");

    expect(out.caps.has("orch:web")).toBe(true);
    expect(out.methods).toEqual(["web_fetch"]);
    expect(out.unknownMethods).toEqual([]);
  });

  it("does NOT match a bare method call without the comis_tools. prefix (ts/js floor)", () => {
    // A `from comis_tools import web_fetch` python bare-call form is out of the
    // ts/js floor — it falls through to the authoritative endpoint (INV-1-safe).
    const out = extractCapabilityFootprint("const data = web_fetch({ url: 'x' });");

    expect(out.caps.size).toBe(0);
    expect(out.methods).toEqual([]);
    expect(out.unknownMethods).toEqual([]);
  });

  it("returns empty footprint for a script with zero tool calls (total over any input)", () => {
    const out = extractCapabilityFootprint("const x = 1 + 2;\nconsole.log(x);\n");

    expect(out.caps.size).toBe(0);
    expect(out.methods).toEqual([]);
    expect(out.unknownMethods).toEqual([]);
  });

  it("is total over the empty string", () => {
    const out = extractCapabilityFootprint("");

    expect(out.caps.size).toBe(0);
    expect(out.methods).toEqual([]);
    expect(out.unknownMethods).toEqual([]);
  });

  it("dedupes repeated call sites of the same method", () => {
    const out = extractCapabilityFootprint(
      "comis_tools.web_fetch({a:1}); comis_tools.web_fetch({b:2}); comis_tools.web_fetch({c:3});",
    );

    expect(out.methods).toEqual(["web_fetch"]);
    expect([...out.caps]).toEqual(["orch:web"]);
  });

  it("yields the SOURCE-ORDERED call-site sequence with repeats preserved (= per-method counts), leaving the deduped methods SET unchanged", () => {
    // web_search, jq, jq, web_fetch in source order — jq appears TWICE (its call count).
    const script =
      'comis_tools.web_search({q:1}); comis_tools.jq({a:1}); comis_tools.jq({b:2}); comis_tools.web_fetch({url:"x"});';
    const out = extractCapabilityFootprint(script);

    // The ordered sequence preserves source order AND repeats (jq twice = its count).
    expect(out.sequence).toEqual(["web_search", "jq", "jq", "web_fetch"]);
    // The existing sorted/deduped SET is UNCHANGED — the sequence is ADDITIVE (no regression).
    expect(out.methods).toEqual(["jq", "web_fetch", "web_search"]);
  });

  it("bounds the ordered sequence to a fixed cap, keeping the first N cap-mapped call sites in source order", () => {
    // The descriptor is bounded so a pathological script cannot bloat it. This value
    // MUST match SEQUENCE_CAP in orchestrate-preflight.ts — a security bound pinned
    // here so a change to the production cap fails this test loudly.
    const SEQUENCE_CAP = 64;
    const script = "comis_tools.read({});\n".repeat(SEQUENCE_CAP + 10);
    const out = extractCapabilityFootprint(script);

    expect(out.sequence).toHaveLength(SEQUENCE_CAP);
    expect(out.sequence.every((m) => m === "read")).toBe(true);
    // The deduped SET still collapses the repeats to the single method.
    expect(out.methods).toEqual(["read"]);
  });

  it("excludes unknown (non-cap-mapped) methods from the ordered sequence (mirrors methods/unknownMethods)", () => {
    const out = extractCapabilityFootprint(
      "comis_tools.web_fetch({}); comis_tools.not_a_tool({}); comis_tools.jq({});",
    );

    // not_a_tool is NOT cap-mapped → excluded from the sequence; only the cap-mapped
    // web_fetch, jq remain, in source order.
    expect(out.sequence).toEqual(["web_fetch", "jq"]);
    expect(out.unknownMethods).toEqual(["not_a_tool"]);
  });
});

describe("classifyRecoverableStderr", () => {
  it.each([
    ["ImportError: cannot import name 'foo' from 'bar'", "bad_import"],
    ["ModuleNotFoundError: No module named 'x'", "bad_import"],
    ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'left-pad'", "bad_import"],
    ["node:internal/modules/cjs/loader: Cannot find module './missing.js'", "bad_import"],
    ["TypeError: comis_tools.web_fetch is not a function", "comis_tools_misuse"],
    ["AttributeError: module 'comis_tools' has no attribute 'web_fetch'", "comis_tools_misuse"],
    ["TypeError: Cannot read properties of undefined (reading 'jq')", "type_error"],
    ["AttributeError: 'NoneType' object has no attribute 'read'", "type_error"],
    // A malformed body — the single most frequent small/nano-model authoring
    // failure — is recoverable: the one-shot repair re-runs the fixed script in
    // the same jail. Node and Python both surface the exact token `SyntaxError`.
    ["SyntaxError: Unexpected token ')'", "syntax_error"],
    ["SyntaxError: Unexpected identifier 'foo'", "syntax_error"],
    ["SyntaxError: invalid syntax", "syntax_error"],
    ["  File \"s.py\", line 2\n    x = (\nSyntaxError: '(' was never closed", "syntax_error"],
  ] as const)("classifies %j as %s", (tail, expected) => {
    expect(classifyRecoverableStderr(tail)).toBe(expected);
  });

  it("prefers comis_tools_misuse over the generic type_error (order matters)", () => {
    // A comis_tools TypeError must classify as misuse, not the generic type_error —
    // the misuse branch is tested BEFORE the generic one.
    expect(classifyRecoverableStderr("TypeError: comis_tools.read is not a function")).toBe(
      "comis_tools_misuse",
    );
  });

  it("classifies a SyntaxError that mentions comis_tools as syntax_error, not misuse", () => {
    // A malformed body whose traceback happens to show a comis_tools call is still
    // syntax_error — the misuse branch requires a Type/Attribute-error SHAPE, which
    // a SyntaxError tail lacks, so the comis_tools token alone must not divert it.
    const tail =
      '  File "script.py", line 3\n    head = comis_tools.grep({"path": "x"\nSyntaxError: \'{\' was never closed';
    expect(classifyRecoverableStderr(tail)).toBe("syntax_error");
  });

  it.each([
    ["Segmentation fault (core dumped)"],
    ["Killed"],
    ["RangeError: Maximum call stack size exceeded"],
    [""],
    ["   \n  "],
  ] as const)("returns undefined for the non-recoverable tail %j", (tail) => {
    expect(classifyRecoverableStderr(tail)).toBeUndefined();
  });
});

describe("buildDescribeDigest", () => {
  it("names every capability value and the anchor method tokens", () => {
    const digest = buildDescribeDigest();

    expect(digest.length).toBeGreaterThan(0);
    expect(digest).toContain("orch:read");
    expect(digest).toContain("orch:web");
    expect(digest).toContain("web_fetch");
    expect(digest).toContain("web_search");
    expect(digest).toContain("read");
  });

  it("is deterministic — two calls are byte-equal", () => {
    expect(buildDescribeDigest()).toBe(buildDescribeDigest());
  });

  it("is bounded (< 4000 chars)", () => {
    expect(buildDescribeDigest().length).toBeLessThan(4000);
  });
});
