// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the shared path-outside-workspace error message.
 * @module
 */

import { describe, it, expect } from "vitest";
import { pathOutsideWorkspaceMessage } from "./path-error.js";

describe("pathOutsideWorkspaceMessage — names the remedy so a small model self-corrects", () => {
  it("keeps the stable [path_traversal] prefix and echoes the offending path", () => {
    const msg = pathOutsideWorkspaceMessage("~/Desktop/report.md");
    expect(msg.startsWith("[path_traversal] Path outside workspace bounds: ~/Desktop/report.md")).toBe(true);
  });

  it("tells the model to use a workspace-relative path (the actual fix)", () => {
    const msg = pathOutsideWorkspaceMessage("/abs/x.md");
    expect(msg).toMatch(/relative to your workspace/i);
    expect(msg).toMatch(/report\.md/); // concrete example the model can mimic
  });

  it("names what is rejected (absolute, ~, ..) so the model stops retrying them", () => {
    const msg = pathOutsideWorkspaceMessage("../escape");
    expect(msg).toMatch(/absolute paths/i);
    expect(msg).toContain("~");
    expect(msg).toContain("..");
  });

  it("does NOT leak the host workspace absolute root", () => {
    const msg = pathOutsideWorkspaceMessage("~/Desktop/x");
    expect(msg).not.toMatch(/\/Users\/|\/home\/|workspace-qwen/);
  });
});
