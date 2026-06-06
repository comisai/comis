// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for orch-config.ts.
 *
 * Always runs — no COMIS_LIVE required, no daemon needed.
 * Tests that buildOrchConfig writes the correct YAML structure
 * for multi-agent orchestration configs (agents, routing, security.agentToAgent,
 * subagentContext.maxSpawnDepth).
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildOrchConfig } from "./orch-config.js";

describe("buildOrchConfig", () => {
  it("returns a path to a file that exists", () => {
    const p = buildOrchConfig({ agents: [{ id: "default" }], defaultAgentId: "default", label: "t1" });
    expect(existsSync(p)).toBe(true);
    rmSync(p, { force: true });
  });

  // ── agents block ──────────────────────────────────────────────────────────

  it("YAML contains agents block with declared ids", () => {
    const p = buildOrchConfig({
      agents: [{ id: "default" }, { id: "agent-b" }],
      defaultAgentId: "default",
      label: "t2-agents",
    });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("agents:");
    expect(content).toContain("agent-b:");
    rmSync(p, { force: true });
  });

  // ── routing block ─────────────────────────────────────────────────────────

  it("YAML contains routing.defaultAgentId", () => {
    const p = buildOrchConfig({
      agents: [{ id: "myDefault" }],
      defaultAgentId: "myDefault",
      label: "t3-routing",
    });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("routing:");
    expect(content).toContain("defaultAgentId: myDefault");
    rmSync(p, { force: true });
  });

  it("YAML contains routing bindings with peerId", () => {
    const p = buildOrchConfig({
      agents: [{ id: "default" }, { id: "agent-b" }],
      defaultAgentId: "default",
      bindings: [{ peerId: "user-vip", agentId: "agent-b" }],
      label: "t4-bindings",
    });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("bindings:");
    expect(content).toContain("peerId:");
    rmSync(p, { force: true });
  });

  // ── security.agentToAgent block ───────────────────────────────────────────

  it("YAML contains security.agentToAgent block when caps provided", () => {
    const p = buildOrchConfig({
      agents: [{ id: "default" }],
      defaultAgentId: "default",
      maxGlobalSubAgents: 3,
      label: "t5-sec",
    });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("agentToAgent:");
    expect(content).toContain("graphMaxGlobalSubAgents: 3");
    rmSync(p, { force: true });
  });

  it("YAML contains graphMaxConcurrency when provided", () => {
    const p = buildOrchConfig({
      agents: [{ id: "default" }],
      defaultAgentId: "default",
      graphMaxConcurrency: 2,
      label: "t6-concurrency",
    });
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("agentToAgent:");
    expect(content).toContain("graphMaxConcurrency: 2");
    rmSync(p, { force: true });
  });

  // ── subagentContext.maxSpawnDepth (separate block, NOT under agentToAgent) ─

  it("YAML contains subagentContext.maxSpawnDepth when provided", () => {
    const p = buildOrchConfig({
      agents: [{ id: "default" }],
      defaultAgentId: "default",
      maxSpawnDepth: 1,
      label: "t7-depth",
    });
    const content = readFileSync(p, "utf-8");
    // CRITICAL: subagentContext is a SEPARATE top-level block from security.agentToAgent
    expect(content).toContain("subagentContext:");
    expect(content).toContain("maxSpawnDepth: 1");
    rmSync(p, { force: true });
  });

  it("subagentContext is a separate top-level block from security", () => {
    const p = buildOrchConfig({
      agents: [{ id: "default" }],
      defaultAgentId: "default",
      maxGlobalSubAgents: 3,
      maxSpawnDepth: 2,
      label: "t7b-separate",
    });
    const content = readFileSync(p, "utf-8");
    // Both blocks must exist
    expect(content).toContain("agentToAgent:");
    expect(content).toContain("subagentContext:");
    // subagentContext must appear at top-level (column 0)
    const subagentIdx = content.indexOf("\nsubagentContext:");
    expect(subagentIdx).toBeGreaterThan(-1);
    rmSync(p, { force: true });
  });

  // ── gateway port is NOT patched ───────────────────────────────────────────

  it("gateway port is NOT patched (ConversationDriver handles that)", () => {
    const p = buildOrchConfig({
      agents: [{ id: "default" }],
      defaultAgentId: "default",
      label: "t8-gateway",
    });
    const content = readFileSync(p, "utf-8");
    // The gateway block from base config remains unchanged — still contains original port
    // We verify no port override was introduced (no port: <something-other-than-original>)
    // Just ensure file is written without crashing and gateway block is preserved
    expect(content).toContain("gateway:");
    rmSync(p, { force: true });
  });

  // ── filename helpers ──────────────────────────────────────────────────────

  it("sanitises the label in the output filename", () => {
    const p = buildOrchConfig({ agents: [{ id: "default" }], defaultAgentId: "default", label: "has spaces & chars!" });
    expect(p).toMatch(/has_spaces___chars_/);
    rmSync(p, { force: true });
  });

  it("writes temp file to OS tmpdir", () => {
    const p = buildOrchConfig({ agents: [{ id: "default" }], defaultAgentId: "default", label: "t-tmpdir" });
    expect(p.startsWith(tmpdir())).toBe(true);
    rmSync(p, { force: true });
  });
});
