// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { DEFAULT_TEMPLATES } from "@comis/core";
import { isHeartbeatContentEffectivelyEmpty } from "./heartbeat-file.js";

describe("isHeartbeatContentEffectivelyEmpty", () => {
  it("treats an unterminated HTML comment as non-instructional content", () => {
    expect(isHeartbeatContentEffectivelyEmpty("<!-- unfinished operator note")).toBe(true);
  });

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

  it("preserves the exact line-classification quirks of the original matcher", () => {
    // Header requires whitespace AFTER the hashes; bare hashes are content.
    expect(isHeartbeatContentEffectivelyEmpty("## ")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("##")).toBe(false);
    // Indented headers and list markers are still structural.
    expect(isHeartbeatContentEffectivelyEmpty("  ## Title")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("  - [ ]")).toBe(true);
    // Checkbox may hug the marker or trail whitespace; text after it is content.
    expect(isHeartbeatContentEffectivelyEmpty("-[x]")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("-   [ ]  ")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("- [x] done")).toBe(false);
    // A bare marker is an empty list item; a broken checkbox is content.
    expect(isHeartbeatContentEffectivelyEmpty("*")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("- [")).toBe(false);
  });

  it("classifies an attacker-shaped whitespace run in linear time (polynomial-ReDoS regression)", () => {
    // A single HEARTBEAT.md line of `*` + a long whitespace run + one trailing
    // non-whitespace char drove the old backtracking matcher quadratic
    // (~19s of event-loop block at 200k spaces). The classifier must stay
    // linear on this shape.
    const line = "*" + " ".repeat(200_000) + "!";
    const start = performance.now();
    const result = isHeartbeatContentEffectivelyEmpty(line);
    const elapsedMs = performance.now() - start;
    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
