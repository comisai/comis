import { describe, it, expect } from "vitest";
import {
  registerToolMetadata,
  getToolMetadata,
  getAllToolMetadata,
  truncateContentBlocks,
  _clearRegistryForTest,
} from "./tool-metadata.js";

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe("tool metadata registry", () => {
  it("getToolMetadata returns undefined for unregistered tool", () => {
    expect(getToolMetadata("nonexistent_tool_xyz")).toBeUndefined();
  });

  it("registerToolMetadata stores and retrieves metadata", () => {
    registerToolMetadata("reg_test_store", {
      maxResultSizeChars: 5000,
      isReadOnly: true,
    });

    const meta = getToolMetadata("reg_test_store");
    expect(meta).toBeDefined();
    expect(meta!.maxResultSizeChars).toBe(5000);
    expect(meta!.isReadOnly).toBe(true);
  });

  it("registerToolMetadata merges metadata incrementally", () => {
    registerToolMetadata("reg_test_merge", { isReadOnly: true });
    registerToolMetadata("reg_test_merge", { maxResultSizeChars: 10000 });

    const meta = getToolMetadata("reg_test_merge");
    expect(meta).toEqual({ isReadOnly: true, maxResultSizeChars: 10000 });
  });

  it("registerToolMetadata overwrites fields on re-register", () => {
    registerToolMetadata("reg_test_overwrite", { maxResultSizeChars: 5000 });
    registerToolMetadata("reg_test_overwrite", { maxResultSizeChars: 10000 });

    const meta = getToolMetadata("reg_test_overwrite");
    expect(meta!.maxResultSizeChars).toBe(10000);
  });

  it("getAllToolMetadata returns ReadonlyMap", () => {
    registerToolMetadata("reg_test_all_a", { isReadOnly: true });
    registerToolMetadata("reg_test_all_b", { maxResultSizeChars: 2000 });

    const all = getAllToolMetadata();
    expect(all.has("reg_test_all_a")).toBe(true);
    expect(all.has("reg_test_all_b")).toBe(true);
  });

  it("_clearRegistryForTest clears all entries", () => {
    registerToolMetadata("reg_test_clear", { isReadOnly: true });
    expect(getToolMetadata("reg_test_clear")).toBeDefined();

    _clearRegistryForTest();
    expect(getToolMetadata("reg_test_clear")).toBeUndefined();

    // Clean up (registry already clear, but be explicit)
    _clearRegistryForTest();
  });
});

// ---------------------------------------------------------------------------
// coDiscoverWith tests (quick-260414-ppo)
// ---------------------------------------------------------------------------

describe("tool metadata -- coDiscoverWith", () => {
  it("stores and retrieves coDiscoverWith field", () => {
    registerToolMetadata("co_disc_test_a", { coDiscoverWith: ["co_disc_test_b"] });
    const meta = getToolMetadata("co_disc_test_a");
    expect(meta).toBeDefined();
    expect(meta!.coDiscoverWith).toEqual(["co_disc_test_b"]);
  });

  it("merges coDiscoverWith with existing metadata", () => {
    registerToolMetadata("co_disc_merge", { isReadOnly: true });
    registerToolMetadata("co_disc_merge", { coDiscoverWith: ["other_tool"] });
    const meta = getToolMetadata("co_disc_merge");
    expect(meta!.isReadOnly).toBe(true);
    expect(meta!.coDiscoverWith).toEqual(["other_tool"]);
  });
});

// ---------------------------------------------------------------------------
// Truncation tests
// ---------------------------------------------------------------------------

describe("truncateContentBlocks", () => {
  it("returns original array when total chars under budget", () => {
    const content = [{ type: "text", text: "x".repeat(100) }];
    const result = truncateContentBlocks(content, 200);
    expect(result).toBe(content); // Same reference
  });

  it("returns original array when total chars equal to budget", () => {
    const content = [{ type: "text", text: "x".repeat(100) }];
    const result = truncateContentBlocks(content, 100);
    expect(result).toBe(content); // Same reference
  });

  it("truncates text blocks proportionally with 60/40 split", () => {
    const content = [{ type: "text", text: "x".repeat(10000) }];
    const result = truncateContentBlocks(content, 2000);

    expect(result[0].text).toContain("chars truncated");

    // Verify the truncated text has head (60%) + marker + tail (40%) structure
    const text = result[0].text!;
    const markerIdx = text.indexOf("\n[...");
    expect(markerIdx).toBeGreaterThan(0);

    // Head should be roughly 60% of budget (2000 * 0.6 = 1200)
    expect(markerIdx).toBeGreaterThanOrEqual(1100);
    expect(markerIdx).toBeLessThanOrEqual(1300);
  });

  it("preserves non-text blocks unchanged", () => {
    const imageBlock = { type: "image", url: "https://example.com/img.png" };
    const textBlock = { type: "text", text: "x".repeat(5000) };
    const content = [imageBlock, textBlock];
    const result = truncateContentBlocks(content, 1000);

    // Image block should be the exact same object reference
    expect(result[0]).toBe(imageBlock);
    // Text block should be truncated
    expect(result[1].text).toContain("chars truncated");
  });

  it("enforces 500-char minimum per block", () => {
    const content = [
      { type: "text", text: "x".repeat(8000) },
      { type: "text", text: "y".repeat(200) },
    ];
    const result = truncateContentBlocks(content, 100);

    // The small block (200 chars) gets minimum budget of 500, which is > its length
    // so it should NOT be truncated (200 < 500 min budget)
    expect(result[1].text).toBe("y".repeat(200));
  });

  it("marker text includes char count and guidance", () => {
    const content = [{ type: "text", text: "x".repeat(10000) }];
    const result = truncateContentBlocks(content, 2000);
    const text = result[0].text!;

    expect(text).toContain("chars truncated");
    expect(text).toContain("Reduce output scope");
  });

  it("handles empty content array", () => {
    const content: Array<{ type: string; text?: string }> = [];
    const result = truncateContentBlocks(content, 1000);
    expect(result).toBe(content); // Same reference
  });

  it("handles blocks with no text field", () => {
    const content = [{ type: "text" }]; // no text property
    const result = truncateContentBlocks(content, 100);
    // Total chars is 0 (no text), 0 <= 100, returns original
    expect(result).toBe(content);
  });
});
