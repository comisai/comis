import { describe, it, expect, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { registerToolMetadata } from "@comis/core";
import { wrapWithMetadataEnforcement } from "./tool-metadata-enforcement.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTool(name: string, executeFn?: (...args: any[]) => Promise<any>) {
  return {
    name,
    label: name,
    description: `A ${name} tool`,
    parameters: Type.Object({}),
    execute: executeFn ?? vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "ok" }],
      details: { result: "ok" },
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests -- unique tool names per test to avoid singleton collision
// ---------------------------------------------------------------------------

describe("wrapWithMetadataEnforcement", () => {
  // -------------------------------------------------------------------------
  // Passthrough behavior
  // -------------------------------------------------------------------------
  describe("passthrough behavior", () => {
    it("passes through when no metadata registered", async () => {
      const tool = createMockTool("enf_no_meta");
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", { foo: "bar" });

      expect(result.content[0].text).toBe("ok");
      expect(tool.execute).toHaveBeenCalledWith("call-1", { foo: "bar" }, undefined, undefined);
    });

    it("passes through when metadata has no caps or validators", async () => {
      registerToolMetadata("enf_readonly_only", { isReadOnly: true });
      const tool = createMockTool("enf_readonly_only");
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.content[0].text).toBe("ok");
    });

    it("preserves tool name, label, description, and parameters", () => {
      const tool = createMockTool("enf_props");
      const wrapped = wrapWithMetadataEnforcement(tool);

      expect(wrapped.name).toBe("enf_props");
      expect(wrapped.label).toBe("enf_props");
      expect(wrapped.description).toBe("A enf_props tool");
      expect(wrapped.parameters).toBe(tool.parameters);
    });
  });

  // -------------------------------------------------------------------------
  // Result truncation
  // -------------------------------------------------------------------------
  describe("result truncation", () => {
    it("truncates content when over maxResultSizeChars", async () => {
      registerToolMetadata("enf_truncate", { maxResultSizeChars: 100 });

      const longText = "x".repeat(5000);
      const tool = createMockTool(
        "enf_truncate",
        vi.fn().mockResolvedValue({
          content: [{ type: "text" as const, text: longText }],
          details: { result: "ok" },
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.content[0].text.length).toBeLessThan(longText.length);
      expect(result.content[0].text).toContain("chars truncated");
    });

    it("does not truncate when result under maxResultSizeChars", async () => {
      registerToolMetadata("enf_under_cap", { maxResultSizeChars: 10000 });

      const shortText = "a".repeat(100);
      const originalContent = [{ type: "text" as const, text: shortText }];
      const tool = createMockTool(
        "enf_under_cap",
        vi.fn().mockResolvedValue({
          content: originalContent,
          details: { result: "ok" },
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      // Reference equality: same array returned when under budget
      expect(result.content).toBe(originalContent);
      expect(result.content[0].text).toBe(shortText);
    });

    it("handles result with no content field", async () => {
      registerToolMetadata("enf_no_content", { maxResultSizeChars: 100 });

      const tool = createMockTool(
        "enf_no_content",
        vi.fn().mockResolvedValue({
          details: { result: "ok" },
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.details.result).toBe("ok");
    });
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------
  describe("input validation", () => {
    it("calls validateInput before execute", async () => {
      const validator = vi.fn().mockReturnValue(undefined);
      registerToolMetadata("enf_validate_ok", { validateInput: validator });

      const tool = createMockTool("enf_validate_ok");
      const wrapped = wrapWithMetadataEnforcement(tool);

      await wrapped.execute("call-1", { path: "/test" });

      expect(validator).toHaveBeenCalledWith({ path: "/test" });
      expect(tool.execute).toHaveBeenCalled();
    });

    it("throws on validation failure without calling execute", async () => {
      registerToolMetadata("enf_validate_fail", {
        validateInput: () => "path is required",
      });

      const executeFn = vi.fn();
      const tool = createMockTool("enf_validate_fail", executeFn);
      const wrapped = wrapWithMetadataEnforcement(tool);

      await expect(wrapped.execute("call-1", {})).rejects.toThrow(
        "[invalid_value] path is required",
      );
      expect(executeFn).not.toHaveBeenCalled();
    });

    it("supports async validators", async () => {
      registerToolMetadata("enf_async_valid", {
        validateInput: async () => undefined,
      });

      const tool = createMockTool("enf_async_valid");
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.content[0].text).toBe("ok");
    });

    it("handles async validation failure", async () => {
      registerToolMetadata("enf_async_fail", {
        validateInput: async () => "invalid",
      });

      const executeFn = vi.fn();
      const tool = createMockTool("enf_async_fail", executeFn);
      const wrapped = wrapWithMetadataEnforcement(tool);

      await expect(wrapped.execute("call-1", {})).rejects.toThrow(
        "[invalid_value] invalid",
      );
      expect(executeFn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Empty result marker injection
  // -------------------------------------------------------------------------
  describe("empty result marker injection", () => {
    it("injects marker when tool returns content: []", async () => {
      const tool = createMockTool(
        "enf_empty_arr",
        vi.fn().mockResolvedValue({
          content: [],
          details: { result: "ok" },
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe("(enf_empty_arr completed with no output)");
    });

    it("injects marker when tool returns content with empty text", async () => {
      const tool = createMockTool(
        "enf_empty_text",
        vi.fn().mockResolvedValue({
          content: [{ type: "text" as const, text: "" }],
          details: { result: "ok" },
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe("(enf_empty_text completed with no output)");
    });

    it("injects marker when tool returns content with whitespace-only text", async () => {
      const tool = createMockTool(
        "enf_ws_only",
        vi.fn().mockResolvedValue({
          content: [{ type: "text" as const, text: "   \n  " }],
          details: { result: "ok" },
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe("(enf_ws_only completed with no output)");
    });

    it("passes through tool returning non-empty text unchanged", async () => {
      const tool = createMockTool(
        "enf_real_output",
        vi.fn().mockResolvedValue({
          content: [{ type: "text" as const, text: "real output" }],
          details: { result: "ok" },
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe("real output");
    });

    it("passes through tool returning image content unchanged", async () => {
      const tool = createMockTool(
        "enf_image_out",
        vi.fn().mockResolvedValue({
          content: [{ type: "image" as const, data: "base64data", mimeType: "image/png" }],
          details: { result: "ok" },
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("image");
    });

    it("injects marker when content is undefined", async () => {
      const tool = createMockTool(
        "enf_undef_content",
        vi.fn().mockResolvedValue({
          details: { result: "ok" },
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe("(enf_undef_content completed with no output)");
    });

    it("injects marker when content is null", async () => {
      const tool = createMockTool(
        "enf_null_content",
        vi.fn().mockResolvedValue({
          content: null,
          details: { result: "ok" },
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe("(enf_null_content completed with no output)");
    });

    it("includes the tool name in the marker text", async () => {
      const tool = createMockTool(
        "exec",
        vi.fn().mockResolvedValue({
          content: [],
          details: {},
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      expect(result.content[0].text).toContain("exec");
      expect(result.content[0].text).toBe("(exec completed with no output)");
    });

    it("runs after truncation (truncated result is not marked empty)", async () => {
      registerToolMetadata("enf_trunc_then_empty", { maxResultSizeChars: 100 });

      const longText = "x".repeat(5000);
      const tool = createMockTool(
        "enf_trunc_then_empty",
        vi.fn().mockResolvedValue({
          content: [{ type: "text" as const, text: longText }],
          details: { result: "ok" },
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      // Truncation produces a non-empty result with "chars truncated" notice
      // so the empty marker should NOT fire
      expect(result.content[0].text).toContain("chars truncated");
      expect(result.content[0].text).not.toContain("completed with no output");
    });

    it("does NOT inject marker for error results (isError: true)", async () => {
      const tool = createMockTool(
        "enf_err_empty",
        vi.fn().mockResolvedValue({
          content: [],
          details: { result: "err" },
          isError: true,
        }),
      );
      const wrapped = wrapWithMetadataEnforcement(tool);

      const result = await wrapped.execute("call-1", {});

      // Error results should pass through unchanged, even with empty content
      expect(result.content).toEqual([]);
      expect(result.isError).toBe(true);
    });
  });
});
