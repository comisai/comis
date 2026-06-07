// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { repairToolCallJSON } from "./tool-call-repair.js";
import { FAIL_CLOSED_PROFILE } from "./model-profile.js";
import { extractErrorTag, PARAMETER_VALIDATION_TAGS } from "../safety/tool-retry-breaker.js";

describe("repairToolCallJSON", () => {
  // Case 1: valid JSON passes through unchanged
  it("passes valid JSON through unchanged as ok(parsed)", () => {
    const result = repairToolCallJSON('{"path":"/tmp/file.txt"}', FAIL_CLOSED_PROFILE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ path: "/tmp/file.txt" });
    }
  });

  // Case 2: trailing comma repaired
  it("repairs trailing comma in JSON object", () => {
    const result = repairToolCallJSON('{"path":"/tmp/file.txt",}', FAIL_CLOSED_PROFILE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ path: "/tmp/file.txt" });
    }
  });

  // Case 3: irreparable JSON returns err("irreparable")
  it("returns err('irreparable') for non-JSON input", () => {
    const result = repairToolCallJSON("not json at all <<<", FAIL_CLOSED_PROFILE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("irreparable");
    }
  });

  // Case 4 (S3 ADVERSARIAL — value preserved after shape repair):
  // A malicious command with a shape error (trailing comma).
  // Repair fixes the shape but MUST NOT change the value.
  // Security blocking happens DOWNSTREAM in the existing exec gates.
  it("S3 adversarial: repairs shape but preserves malicious command value unchanged", () => {
    // The command value "rm -rf /" is adversarial — but repair is shape-only.
    // The EXISTING exec gate (validateExecCommand) blocks this value downstream.
    const input = '{"command":"rm -rf /",}';
    const result = repairToolCallJSON(input, FAIL_CLOSED_PROFILE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Value MUST be preserved exactly — shape-only repair invariant
      expect(result.value).toEqual({ command: "rm -rf /" });
      // Confirm the dangerous value is unchanged (not sanitized/replaced)
      expect(result.value["command"]).toBe("rm -rf /");
    }
  });

  // Case 5 (S3 ADVERSARIAL — scope never widens):
  // A path to a sensitive file with a shape error (trailing comma).
  // Repair fixes the shape but MUST NOT substitute a safe path.
  it("S3 adversarial: repairs shape but preserves sensitive path value unchanged", () => {
    // The path "/etc/passwd" is adversarial — but repair is shape-only.
    // The EXISTING exec gate (Gate 8 paths check in validateExecCommand) blocks this downstream.
    const input = '{"path":"/etc/passwd",}';
    const result = repairToolCallJSON(input, FAIL_CLOSED_PROFILE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Value MUST be preserved exactly — shape-only repair invariant
      expect(result.value).toEqual({ path: "/etc/passwd" });
      // Confirm the sensitive path is unchanged (not substituted with a safe path)
      expect(result.value["path"]).toBe("/etc/passwd");
    }
  });

  // Case 6 (breaker carve-out): "Validation failed" prefix → extractErrorTag → "validation_failed"
  // which IS in PARAMETER_VALIDATION_TAGS → no breaker increment for irreparable-shape failures.
  it("irreparable repair errors produce 'validation_failed' tag (breaker carve-out preserved)", () => {
    // Simulate: repair returns err("irreparable"); caller produces a "Validation failed" message
    const repairResult = repairToolCallJSON("not json at all <<<", FAIL_CLOSED_PROFILE);
    expect(repairResult.ok).toBe(false);

    // The CALLER of repairToolCallJSON would produce a "Validation failed" prefixed message
    // (as the tool-call-repair-wrapper does). Confirm extractErrorTag returns "validation_failed".
    const simulatedErrorMessage = "Validation failed: tool arguments are not valid JSON and could not be repaired. Please emit valid JSON.";
    const tag = extractErrorTag(simulatedErrorMessage);
    expect(tag).toBe("validation_failed");

    // Confirm the tag is in PARAMETER_VALIDATION_TAGS (breaker does NOT increment for this tag)
    expect(PARAMETER_VALIDATION_TAGS.has(tag)).toBe(true);
  });
});
