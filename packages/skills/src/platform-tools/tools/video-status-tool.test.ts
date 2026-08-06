// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createVideoStatusTool } from "./video-status-tool.js";

describe("createVideoStatusTool", () => {
  it("states that terminal media is already delivered and must not be attached again", () => {
    const tool = createVideoStatusTool(vi.fn());

    expect(tool.description).toContain("automatically delivered");
    expect(tool.description).toContain("Do not call message.attach");
  });
});
