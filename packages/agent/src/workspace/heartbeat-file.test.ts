// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { isHeartbeatContentEffectivelyEmpty } from "./heartbeat-file.js";
import { DEFAULT_TEMPLATES } from "./templates.js";

describe("isHeartbeatContentEffectivelyEmpty", () => {
  it("returns true for the default HEARTBEAT.md template", () => {
    expect(isHeartbeatContentEffectivelyEmpty(DEFAULT_TEMPLATES["HEARTBEAT.md"])).toBe(true);
  });

  it("returns true for empty string", () => {
    expect(isHeartbeatContentEffectivelyEmpty("")).toBe(true);
  });

  it("returns true for whitespace only", () => {
    expect(isHeartbeatContentEffectivelyEmpty("  \n\n  \t\n")).toBe(true);
  });

  it("returns true for headers only", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# Title\n## Section\n### Sub")).toBe(true);
  });

  it("returns true for empty list items only", () => {
    expect(isHeartbeatContentEffectivelyEmpty("- \n* \n- [ ] \n- [x] ")).toBe(true);
  });

  it("returns true for mixed headers + empty lists + whitespace", () => {
    const content = "# Tasks\n\n- \n## Section\n\n* \n- [ ] \n\n";
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(true);
  });

  it("returns false for content with task text", () => {
    const content = "# Tasks\n- Check disk space\n- Monitor CPU";
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(false);
  });

  it("returns false for paragraph text", () => {
    expect(isHeartbeatContentEffectivelyEmpty("Check the backup status every hour.")).toBe(false);
  });

  it("returns false for content after header", () => {
    const content = "# Tasks\nMonitor server health";
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(false);
  });
});
