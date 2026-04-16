/**
 * Unit tests for validation error formatter.
 *
 * Tests the pure function that rewrites AJV validation errors
 * from pi-ai's validateToolArguments() into concise LLM-friendly messages.
 */

import { describe, it, expect } from "vitest";
import { formatValidationError } from "./validation-error-formatter.js";

describe("formatValidationError", () => {
  // -----------------------------------------------------------------------
  // Non-validation errors -> null
  // -----------------------------------------------------------------------

  it("returns null for non-validation-error text", () => {
    expect(formatValidationError("Some random error")).toBeNull();
  });

  it("returns null for tool-not-found errors", () => {
    expect(formatValidationError("Tool grep not found")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(formatValidationError("")).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Required property errors
  // -----------------------------------------------------------------------

  it("rewrites missing required property to 'Required parameter X is missing'", () => {
    const input = [
      'Validation failed for tool "grep":',
      "  - pattern: must have required property 'pattern'",
      "",
      "Received arguments:",
      "{}",
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[grep] Invalid parameters:\n- Required parameter `pattern` is missing",
    );
  });

  it("handles multiple missing required properties", () => {
    const input = [
      'Validation failed for tool "write":',
      "  - content: must have required property 'content'",
      "  - file_path: must have required property 'file_path'",
      "",
      "Received arguments:",
      "{}",
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[write] Invalid parameters:\n" +
        "- Required parameter `content` is missing\n" +
        "- Required parameter `file_path` is missing",
    );
  });

  // -----------------------------------------------------------------------
  // Type mismatch errors
  // -----------------------------------------------------------------------

  it("rewrites type mismatch 'must be array' to 'expected array, got string'", () => {
    const input = [
      'Validation failed for tool "edit":',
      "  - edits: must be array",
      "",
      "Received arguments:",
      '{"edits": "wrong"}',
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[edit] Invalid parameters:\n- `edits` expected array",
    );
  });

  it("rewrites 'must be string' type mismatch", () => {
    const input = [
      'Validation failed for tool "write":',
      "  - content: must be string",
      "",
      "Received arguments:",
      '{"content": 123}',
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[write] Invalid parameters:\n- `content` expected string",
    );
  });

  it("rewrites 'must be number' type mismatch", () => {
    const input = [
      'Validation failed for tool "read":',
      "  - limit: must be number",
      "",
      "Received arguments:",
      '{"limit": "ten"}',
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[read] Invalid parameters:\n- `limit` expected number",
    );
  });

  it("rewrites 'must be boolean' type mismatch", () => {
    const input = [
      'Validation failed for tool "exec":',
      "  - verbose: must be boolean",
      "",
      "Received arguments:",
      '{"verbose": "yes"}',
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[exec] Invalid parameters:\n- `verbose` expected boolean",
    );
  });

  it("rewrites 'must be object' type mismatch", () => {
    const input = [
      'Validation failed for tool "edit":',
      "  - options: must be object",
      "",
      "Received arguments:",
      '{"options": "bad"}',
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[edit] Invalid parameters:\n- `options` expected object",
    );
  });

  it("rewrites 'must be integer' type mismatch", () => {
    const input = [
      'Validation failed for tool "read":',
      "  - offset: must be integer",
      "",
      "Received arguments:",
      '{"offset": 1.5}',
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[read] Invalid parameters:\n- `offset` expected integer",
    );
  });

  // -----------------------------------------------------------------------
  // Enum / allowed values errors
  // -----------------------------------------------------------------------

  it("rewrites enum error to 'must be one of the allowed values'", () => {
    const input = [
      'Validation failed for tool "exec":',
      "  - root: must be equal to one of the allowed values",
      "",
      "Received arguments:",
      '{"command": 123}',
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[exec] Invalid parameters:\n- `root` must be one of the allowed values",
    );
  });

  // -----------------------------------------------------------------------
  // Additional properties errors
  // -----------------------------------------------------------------------

  it("rewrites additional properties error", () => {
    const input = [
      'Validation failed for tool "grep":',
      "  - root: must NOT have additional properties",
      "",
      "Received arguments:",
      '{"pattern": "test", "foo": "bar"}',
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[grep] Invalid parameters:\n- unknown parameter (not accepted by this tool)",
    );
  });

  // -----------------------------------------------------------------------
  // Nested path conversion
  // -----------------------------------------------------------------------

  it("converts nested AJV paths to dot notation", () => {
    const input = [
      'Validation failed for tool "edit":',
      "  - /edits/0/oldText: must have required property 'oldText'",
      "",
      "Received arguments:",
      "{}",
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[edit] Invalid parameters:\n- Required parameter `edits[0].oldText` is missing",
    );
  });

  it("converts deeply nested paths", () => {
    const input = [
      'Validation failed for tool "config":',
      "  - /settings/0/nested/1/value: must be string",
      "",
      "Received arguments:",
      "{}",
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[config] Invalid parameters:\n- `settings[0].nested[1].value` expected string",
    );
  });

  // -----------------------------------------------------------------------
  // Constraint errors (pass-through)
  // -----------------------------------------------------------------------

  it("passes through constraint messages with path prefix", () => {
    const input = [
      'Validation failed for tool "grep":',
      "  - limit: must be <= 1000",
      "",
      "Received arguments:",
      '{"limit": 5000}',
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[grep] Invalid parameters:\n- `limit` must be <= 1000",
    );
  });

  it("passes through minLength constraint", () => {
    const input = [
      'Validation failed for tool "write":',
      "  - content: must NOT have fewer than 1 characters",
      "",
      "Received arguments:",
      '{"content": ""}',
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[write] Invalid parameters:\n- `content` must NOT have fewer than 1 characters",
    );
  });

  // -----------------------------------------------------------------------
  // Received arguments stripping
  // -----------------------------------------------------------------------

  it("strips large received arguments JSON", () => {
    const largeJson = JSON.stringify({
      a: "x".repeat(1000),
      b: "y".repeat(1000),
      c: { nested: "z".repeat(1000) },
    });
    const input = [
      'Validation failed for tool "write":',
      "  - content: must have required property 'content'",
      "",
      "Received arguments:",
      largeJson,
    ].join("\n");

    const result = formatValidationError(input);
    expect(result).not.toContain("Received arguments:");
    expect(result).not.toContain(largeJson);
    expect(result).toBe(
      "[write] Invalid parameters:\n- Required parameter `content` is missing",
    );
  });

  // -----------------------------------------------------------------------
  // Mixed error types
  // -----------------------------------------------------------------------

  it("handles mix of required, type, and constraint errors", () => {
    const input = [
      'Validation failed for tool "edit":',
      "  - file_path: must have required property 'file_path'",
      "  - edits: must be array",
      "  - limit: must be <= 100",
      "",
      "Received arguments:",
      '{"edits": "wrong", "limit": 999}',
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[edit] Invalid parameters:\n" +
        "- Required parameter `file_path` is missing\n" +
        "- `edits` expected array\n" +
        "- `limit` must be <= 100",
    );
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("handles validation error with no Received arguments section", () => {
    const input = [
      'Validation failed for tool "grep":',
      "  - pattern: must have required property 'pattern'",
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[grep] Invalid parameters:\n- Required parameter `pattern` is missing",
    );
  });

  it("handles tool name with special characters", () => {
    const input = [
      'Validation failed for tool "my-tool_v2":',
      "  - param: must be string",
      "",
      "Received arguments:",
      "{}",
    ].join("\n");

    expect(formatValidationError(input)).toBe(
      "[my-tool_v2] Invalid parameters:\n- `param` expected string",
    );
  });
});
