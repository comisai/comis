// SPDX-License-Identifier: Apache-2.0
//
// Live-UAT 2026-06-21 (Telegram onboarding, fresh VPS install): during the
// first-wake identity write, a BUILT-IN `edit` tool returned a JSON-wrapped
// `[text_not_found]` result (the model's old_text didn't match IDENTITY.md).
// classifyToolError tagged it errorKind:"dependency" and the channel renderer
// surfaced it into the chat as a bare "❌ dependency" status line — alarming the
// user mid-onboarding for what was a normal, self-corrected retry (the agent
// re-read + retried successfully, exactly as the [text_not_found] hint advises).
//
// Two pre-fix defects this test pins:
//   1. WRONG ANCHOR — the old regex `/^\[(invalid_value|validation)\]/` anchored
//      at `^`, but errorText is the JSON-stringified tool RESULT, so the
//      bracketed code sits inside `.content[].text`, never at offset 0. Even
//      `[invalid_value]` never matched once wrapped.
//   2. WRONG DEFAULT — every unmatched failure fell through to "dependency",
//      so a built-in tool rejecting the model's input read as an external
//      dependency outage. A structured `[code]` means the call REACHED the tool
//      and the tool rejected it — that is validation (or, for IO codes,
//      internal), never "dependency".
import { describe, it, expect } from "vitest";
import { classifyToolError } from "./pi-event-bridge.js";

/** The on-the-wire shape: errorText is the JSON-stringified tool result. */
const wrap = (code: string, msg = "x"): string =>
  JSON.stringify({ content: [{ type: "text", text: `[${code}] ${msg}` }], details: {} });

describe("classifyToolError", () => {
  it("classifies the live incident — JSON-wrapped [text_not_found] from `edit` — as validation, not dependency", () => {
    const errorText = wrap(
      "text_not_found",
      "Could not find the exact text in IDENTITY.md. The old text must match exactly including all whitespace and newlines.",
    );
    expect(classifyToolError("edit", errorText)).toBe("validation");
  });

  it("classifies model-input + policy file-tool codes as validation (the structured-[code] family)", () => {
    for (const code of [
      "invalid_value",
      "no_changes",
      "duplicate_match",
      "not_read",
      "stale_file",
      "file_not_found",
      "permission_denied",
      "path_traversal",
      "write_secret_blocked",
    ]) {
      expect(classifyToolError("edit", wrap(code))).toBe("validation");
    }
  });

  it("classifies genuine IO failures as internal, not dependency", () => {
    for (const code of ["read_error", "write_error", "grep_error", "dir_create_failed", "pdf_error"]) {
      expect(classifyToolError("read", wrap(code))).toBe("internal");
    }
  });

  it("falls back to dependency ONLY when no structured [code] is present (external/MCP/unknown)", () => {
    expect(classifyToolError("mcp__server__tool", "connection refused")).toBe("dependency");
    expect(classifyToolError("edit", "some opaque failure")).toBe("dependency");
    expect(classifyToolError("edit", undefined)).toBe("dependency");
    expect(classifyToolError("edit", "")).toBe("dependency");
  });

  it("does not misfire on array indices or single-word brackets (snake_case required)", () => {
    expect(classifyToolError("read", "result[0] was empty")).toBe("dependency");
    expect(classifyToolError("read", "[error] generic")).toBe("dependency");
  });
});
