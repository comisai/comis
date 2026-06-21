// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the pure RFC4180 CSV serializer (COST-03, Phase 179 WS6).
 *
 * Greenfield — no CSV module existed in the repo (the `join(",")` hits elsewhere
 * are list-formatting). `toCsv` is the backend serializer the `comis cost export`
 * command emits; the SPA `<a download>` blob (diagnostics-view.ts:383) is the
 * separate web side (Wave 2), not this.
 *
 * The load-bearing guarantees the tests pin:
 *   - RFC4180 escaping: a field with a comma/quote/newline is wrapped in `"`
 *     with internal `"` doubled; a plain field is emitted bare.
 *   - the header row of the column keys comes first (escaped the same way).
 *   - null/undefined → an empty field; numbers/booleans serialize predictably.
 *   - CONTENT-FREE BY CONSTRUCTION: `toCsv` projects ONLY the explicit `columns`
 *     allowlist — never `Object.keys(row)` — so a body/secret/query key planted
 *     in a source row can never leak into the CSV (threat T-179-07).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { toCsv } from "./csv.js";

describe("toCsv — RFC4180 serializer", () => {
  it("emits the column keys as the first (header) row", () => {
    const out = toCsv([{ a: 1, b: 2 }], ["a", "b"]);
    const lines = out.split("\r\n");
    expect(lines[0]).toBe("a,b");
    expect(lines[1]).toBe("1,2");
  });

  it("escapes a field containing a comma by wrapping it in double-quotes", () => {
    const out = toCsv([{ a: "x,y", b: "plain" }], ["a", "b"]);
    expect(out.split("\r\n")[1]).toBe('"x,y",plain');
  });

  it("escapes a field containing a double-quote by doubling the internal quote", () => {
    const out = toCsv([{ a: 'he said "hi"' }], ["a"]);
    // RFC4180: wrap in quotes, double the embedded quote.
    expect(out.split("\r\n")[1]).toBe('"he said ""hi"""');
  });

  it("escapes a field containing a newline (CR or LF) by wrapping it in quotes", () => {
    const out = toCsv([{ a: "line1\nline2" }, { a: "carriage\rreturn" }], ["a"]);
    const lines = out.split("\r\n");
    // The embedded \n stays inside the quoted field (the field, not the record,
    // separator); the row count is header + 2 data records by \r\n splitting.
    expect(lines[0]).toBe("a");
    expect(lines[1]).toBe('"line1\nline2"');
    expect(lines[2]).toBe('"carriage\rreturn"');
  });

  it("serializes numbers and booleans predictably; null/undefined → an empty field", () => {
    const out = toCsv(
      [{ n: 3.14, b: true, z: false, nil: null, miss: undefined }],
      ["n", "b", "z", "nil", "miss"],
    );
    expect(out.split("\r\n")[1]).toBe("3.14,true,false,,");
  });

  it("projects ONLY the allowlisted columns — a non-listed key is ABSENT (content-free)", () => {
    // A source row carrying a secret/body field that is NOT in the column allowlist.
    const rows = [
      { agentId: "agent-1", totalCost: 0.5, messageBody: "SECRET-BODY-MARKER", apiKey: "sk-LEAK" },
    ];
    const out = toCsv(rows, ["agentId", "totalCost"]);
    expect(out).toContain("agent-1");
    expect(out).toContain("0.5");
    // The non-allowlisted keys never reach the CSV — not as a header, not as a value.
    expect(out).not.toContain("messageBody");
    expect(out).not.toContain("SECRET-BODY-MARKER");
    expect(out).not.toContain("apiKey");
    expect(out).not.toContain("sk-LEAK");
  });

  it("emits a header-only document for an empty row set (no data records)", () => {
    const out = toCsv([], ["a", "b"]);
    expect(out).toBe("a,b");
  });
});
