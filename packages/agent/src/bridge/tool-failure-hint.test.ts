// SPDX-License-Identifier: Apache-2.0
//
// UC-C2 obs-gap (live 2026-06-20): the generic tool-failure hint ("check
// errorText for root cause") masked the actual `[error_code]` the errorText
// carried, so a command-allowlist policy block read like a tmux/macOS
// dependency failure. The hint now names the bracketed category code.
import { describe, it, expect } from "vitest";
import { toolFailureHint, GENERIC_TOOL_FAILURE_HINT } from "./tool-failure-hint.js";

describe("toolFailureHint", () => {
  it("names permission_denied from a JSON-wrapped tool result (the UC-C2 shape)", () => {
    const errorText = '{"content":[{"type":"text","text":"[permission_denied] command not allowlisted: expr"}],"details":{}}';
    const hint = toolFailureHint(errorText);
    expect(hint).toContain("permission_denied");
    expect(hint).not.toBe(GENERIC_TOOL_FAILURE_HINT);
  });

  it("names invalid_value (the cron schedule_kind case)", () => {
    expect(toolFailureHint('{"content":[{"text":"[invalid_value] Invalid schedule_kind: \\"in\\""}]}')).toContain("invalid_value");
  });

  it("names path_traversal", () => {
    expect(toolFailureHint("[path_traversal] escape attempt")).toContain("path_traversal");
  });

  it("falls back to the generic hint when there is no recognizable code", () => {
    expect(toolFailureHint("some opaque failure")).toBe(GENERIC_TOOL_FAILURE_HINT);
    expect(toolFailureHint("")).toBe(GENERIC_TOOL_FAILURE_HINT);
    expect(toolFailureHint(undefined)).toBe(GENERIC_TOOL_FAILURE_HINT);
  });

  it("does NOT match a bare single-word bracket or an array index (avoids false positives)", () => {
    expect(toolFailureHint("result[0] was empty")).toBe(GENERIC_TOOL_FAILURE_HINT);
    expect(toolFailureHint("[error] generic")).toBe(GENERIC_TOOL_FAILURE_HINT);
  });

  it("names EISDIR with a directory-path hint (the live read-a-directory incident)", () => {
    const hint = toolFailureHint(
      '{"content":[{"type":"text","text":"EISDIR: illegal operation on a directory, read"}],"details":{}}',
    );
    expect(hint).toContain("EISDIR");
    expect(hint.toLowerCase()).toContain("director");
    expect(hint).not.toBe(GENERIC_TOOL_FAILURE_HINT);
  });

  it("names ENOTDIR with a path hint", () => {
    expect(toolFailureHint("ENOTDIR: not a directory, scandir '/x/file.txt/sub'")).toContain("ENOTDIR");
  });
});
