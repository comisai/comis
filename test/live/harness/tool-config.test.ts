// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for tool-config.ts.
 *
 * Always runs — no COMIS_LIVE required, no daemon needed.
 * Tests that buildToolConfig writes the correct YAML structure
 * for each DEFERRED_MODES matrix cell.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { buildToolConfig } from "./tool-config.js";

describe("buildToolConfig", () => {
  it("returns a path to a file that exists", () => {
    const p = buildToolConfig({ deferredToolsMode: "always", label: "t1" });
    expect(existsSync(p)).toBe(true);
    rmSync(p, { force: true });
  });

  // ── deferredTools.mode under agents.default ───────────────────────────────

  it("patches deferredTools.mode: always under agents.default", () => {
    const p = buildToolConfig({ deferredToolsMode: "always", label: "t-always" });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("deferredTools:");
    expect(content).toContain("mode: always");
    rmSync(p, { force: true });
  });

  it("patches deferredTools.mode: auto under agents.default", () => {
    const p = buildToolConfig({ deferredToolsMode: "auto", label: "t-auto" });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("deferredTools:");
    expect(content).toContain("mode: auto");
    rmSync(p, { force: true });
  });

  it("patches deferredTools.mode: never under agents.default", () => {
    const p = buildToolConfig({ deferredToolsMode: "never", label: "t2" });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("deferredTools:");
    expect(content).toContain("mode: never");
    rmSync(p, { force: true });
  });

  // ── tooling.installDetours.mode at TOP-LEVEL tooling: ────────────────────
  // CRITICAL: installDetours is under the TOP-LEVEL `tooling:` section,
  // NOT under agents.default. This mirrors the real config schema
  // (packages/core/src/config/schema-tooling.ts ToolingConfigSchema) and
  // test/config/config.test-install-detour-advise.yaml.

  it("patches installDetours.mode: soft-stop under TOP-LEVEL tooling:", () => {
    const p = buildToolConfig({ installDetourMode: "soft-stop", label: "t2-detour" });
    const content = readFileSync(p, "utf-8");
    // Must appear under a top-level tooling: block
    expect(content).toMatch(/^tooling:/m);
    expect(content).toContain("installDetours:");
    expect(content).toContain("mode: soft-stop");
    rmSync(p, { force: true });
  });

  it("patches installDetours.mode: observe under TOP-LEVEL tooling:", () => {
    const p = buildToolConfig({ installDetourMode: "observe", label: "t-observe" });
    const content = readFileSync(p, "utf-8");
    expect(content).toMatch(/^tooling:/m);
    expect(content).toContain("installDetours:");
    expect(content).toContain("mode: observe");
    rmSync(p, { force: true });
  });

  it("patches installDetours.mode: advise under TOP-LEVEL tooling:", () => {
    const p = buildToolConfig({ installDetourMode: "advise", label: "t-advise" });
    const content = readFileSync(p, "utf-8");
    expect(content).toMatch(/^tooling:/m);
    expect(content).toContain("installDetours:");
    expect(content).toContain("mode: advise");
    rmSync(p, { force: true });
  });

  it("does NOT place installDetours under agents.default", () => {
    const p = buildToolConfig({ installDetourMode: "soft-stop", label: "t-not-under-agents" });
    const content = readFileSync(p, "utf-8");
    // installDetours must appear AFTER the last agents line, not inside the agents block
    const toolingIdx = content.indexOf("tooling:");
    const agentsIdx = content.indexOf("agents:");
    // tooling: block must appear at top-level (column 0) and be a separate block from agents
    expect(toolingIdx).toBeGreaterThan(-1);
    // The tooling: occurrence that contains installDetours must be at column 0 (top-level)
    const toolingLineStart = content.lastIndexOf("\n", toolingIdx) + 1;
    expect(content[toolingLineStart]).toBe("t"); // "tooling:" starts at column 0
    // agents: block must exist and come before tooling:
    expect(agentsIdx).toBeGreaterThan(-1);
    expect(toolingIdx).toBeGreaterThan(agentsIdx);
    rmSync(p, { force: true });
  });

  // ── both patches coexist ──────────────────────────────────────────────────

  it("applies both deferredToolsMode and installDetourMode together", () => {
    const p = buildToolConfig({
      deferredToolsMode: "never",
      installDetourMode: "observe",
      label: "t3",
    });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("deferredTools:");
    expect(content).toContain("mode: never");
    expect(content).toMatch(/^tooling:/m);
    expect(content).toContain("installDetours:");
    expect(content).toContain("mode: observe");
    rmSync(p, { force: true });
  });

  it("skips deferredTools patch when deferredToolsMode is omitted", () => {
    const p = buildToolConfig({ installDetourMode: "advise", label: "t-skip-deferred" });
    const content = readFileSync(p, "utf-8");
    expect(content).not.toContain("deferredTools:");
    rmSync(p, { force: true });
  });

  it("skips installDetours patch when installDetourMode is omitted", () => {
    const p = buildToolConfig({ deferredToolsMode: "always", label: "t-skip-detour" });
    const content = readFileSync(p, "utf-8");
    expect(content).not.toContain("installDetours:");
    rmSync(p, { force: true });
  });

  // ── filename helpers ──────────────────────────────────────────────────────

  it("uses a custom filePrefix in the output filename", () => {
    const p = buildToolConfig({
      deferredToolsMode: "always",
      label: "prefix-test",
      filePrefix: "tool-custom",
    });
    expect(p).toMatch(/tool-custom-/);
    rmSync(p, { force: true });
  });

  it("sanitises the label in the output filename", () => {
    const p = buildToolConfig({ deferredToolsMode: "always", label: "has spaces & chars!" });
    expect(p).toMatch(/has_spaces___chars_/);
    rmSync(p, { force: true });
  });
});
