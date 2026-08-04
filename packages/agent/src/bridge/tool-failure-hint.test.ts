// SPDX-License-Identifier: Apache-2.0
//
// Live incident (2026-06-20): the generic tool-failure hint ("check
// errorText for root cause") masked the actual `[error_code]` the errorText
// carried, so a command-allowlist policy block read like a tmux/macOS
// dependency failure. The hint names the bracketed category code.
import { describe, it, expect } from "vitest";
import { toolFailureHint, GENERIC_TOOL_FAILURE_HINT } from "./tool-failure-hint.js";

describe("toolFailureHint", () => {
  it("names permission_denied from a JSON-wrapped tool result (code buried in content[].text)", () => {
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

  it("directs a destructive no-effect failure to the target and approval evidence", () => {
    const hint = toolFailureHint(
      "No filesystem entries were removed; the deletion command had no observable effect.",
    );

    expect(hint).toContain("target");
    expect(hint).toContain("approval");
    expect(hint).not.toBe(GENERIC_TOOL_FAILURE_HINT);
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

  it("directs MCP validation failures to the rejected arguments", () => {
    const hint = toolFailureHint('MCP error -32602: Input validation error: "too_big"');
    expect(hint).toContain("arguments");
    expect(hint).not.toBe(GENERIC_TOOL_FAILURE_HINT);
  });

  it("preserves the exact background capacity knob and current occupancy", () => {
    const hint = toolFailureHint(
      "[background_capacity] Background task capacity reached: " +
      "agents.worker.backgroundTasks.maxPerAgent=5; active=5.",
    );
    expect(hint).toContain("agents.worker.backgroundTasks.maxPerAgent=5");
    expect(hint).toContain("active=5");
    expect(hint).not.toBe(GENERIC_TOOL_FAILURE_HINT);
  });

  it("preserves the exact spawn ceiling knob and current occupancy", () => {
    const hint = toolFailureHint(
      "[spawn_ceiling] Sub-agent spawn rejected: " +
      "autonomy.spawn.maxConcurrentSelfAgents=4; current=4; reason=concurrency.",
    );
    expect(hint).toContain("autonomy.spawn.maxConcurrentSelfAgents=4");
    expect(hint).toContain("current=4");
    expect(hint).not.toBe(GENERIC_TOOL_FAILURE_HINT);
  });

  it("does not suggest waiting when the spawn ceiling reason is depth", () => {
    const hint = toolFailureHint(
      "[spawn_ceiling] Sub-agent spawn rejected: "
      + "autonomy.spawn.maxSpawnDepth=1; current=1; reason=depth.",
    );

    expect(hint).toContain("autonomy.spawn.maxSpawnDepth=1");
    expect(hint).toContain("current=1");
    expect(hint).toContain("restart");
    expect(hint.toLowerCase()).not.toContain("wait for a running sub-agent");
  });
});

// ---------------------------------------------------------------------------
// errorKind-aware validation hint.
//
// The validation advice ("inspect argsPreview ... correct the rejected fields")
// sat behind `isMcpValidationError`, an MCP-TRANSPORT-specific matcher. A platform
// tool whose arguments were rejected therefore fell through to the generic
// bracketed-code branch and got "check the policy or configuration for
// \"invalid_value\"" — which interpolates a failure-CLASS code into the slot where
// a config key or rejected field belongs. There is no "policy or configuration for
// invalid_value" to check.
//
// The classifier already knows: the same failure carried errorKind "validation" on
// the very log line beside the hint. The hint builder took only the error text and
// re-derived the class from prose. Same root shape as the MCP pre-flight
// misclassification fixed earlier: the class is known, the consumer recomputes it.
// ---------------------------------------------------------------------------

describe("toolFailureHint — errorKind-aware validation", () => {
  it("a validation errorKind selects the field-level advice even for a non-MCP tool", () => {
    const hint = toolFailureHint("[invalid_value] gateway rejected the request", "validation");
    expect(hint).toContain("argsPreview");
    expect(hint).not.toContain("policy or configuration for");
  });

  it("without an errorKind the generic bracketed-code hint is unchanged", () => {
    const hint = toolFailureHint("[invalid_value] gateway rejected the request");
    expect(hint).toContain("invalid_value");
  });

  it("a non-validation errorKind does not hijack the specific branches", () => {
    const hint = toolFailureHint("[tool_denied] blocked by policy", "precondition");
    expect(hint).toContain("tool_denied");
    expect(hint).not.toContain("argsPreview");
  });

  it("a runtime-guard hint still wins over the errorKind branch", () => {
    const hint = toolFailureHint("step limit reached, blocking tool execution", "validation");
    expect(hint).toMatch(/max_steps|step budget/i);
  });
});
