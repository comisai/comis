// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 33 parity protection — SKILLS-SPLIT-06 + SKILLS-SPLIT-07.
 *
 * These assertions lock the descriptor registry's tool set + normalized
 * schema output. Captured BEFORE the registry exists (TDD red); turns
 * GREEN when Plan 03 lands `packages/skills/src/platform-tools/registry.ts`.
 *
 * Snapshot file name is keyed by TypeBox version (per RES-PIT-10 amendment
 * in 33-RESEARCH.md): cross-version snapshots are never compared. A
 * `typebox` bump regenerates the snapshot as a separate PR.
 *
 * The dual gate (explicit name set assertion + file-backed snapshot)
 * matches RES-ARCH-5 decision in 33-RESEARCH.md Open Question Q5.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformToolRegistry } from "../platform-tools/registry.js";
import { normalizeToolSchema, TYPEBOX_VERSION } from "./normalize-tool-schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(
  here,
  "__snapshots__",
  `tool-registry.typebox-${TYPEBOX_VERSION}.snap`,
);

// Stub PlatformToolBuildContext — descriptor `build` callbacks return
// AgentTool objects whose `parameters` field is a static TypeBox object
// captured at module-load time. The RPC stub never gets called.
const STUB_CTX = {
  agentId: "test-agent",
  rpcCall: async () => ({}) as never,
} as never;

describe("platform-tool registry parity (SKILLS-SPLIT-06)", () => {
  const REGISTRY = createPlatformToolRegistry();

  it("yields a stable tool name set", () => {
    const names = REGISTRY.map((d) => d.name).sort();
    // Explicit list — a tool removal fails this assertion immediately,
    // not just the snapshot-diff (per RES-ARCH-5 dual-gate decision).
    expect(names).toEqual([
      "agents_manage",
      "background_tasks",
      "browser",
      "channels_manage",
      "cron",
      "ctx_expand",
      "ctx_inspect",
      "ctx_recall",
      "ctx_search",
      "describe_video",
      "discord_action",
      "extract_document",
      "gateway",
      "heartbeat_manage",
      "image",
      "image_generate",
      "mcp_manage",
      "memory_get",
      "memory_manage",
      "memory_search",
      "memory_store",
      "message",
      "models_manage",
      "notify",
      "obs_query",
      "pipeline",
      "providers_manage",
      "session_search",
      "session_status",
      "sessions_history",
      "sessions_list",
      "sessions_manage",
      "sessions_send",
      "sessions_spawn",
      "skills_manage",
      "slack_action",
      "subagents",
      "telegram_action",
      "tokens_manage",
      "transcribe_audio",
      "tts",
      "unified_context",
      "unified_memory",
      "unified_session",
      "whatsapp_action",
    ]);
  });

  it("for every tool: schema, metadata, policy match the snapshot", async () => {
    const descriptors = REGISTRY.map((d) => ({
      name: d.name,
      category: d.category,
      schema: normalizeToolSchema(d.build(STUB_CTX)?.parameters as never),
      conditional: !!d.conditional,
    }));
    const json = JSON.stringify(descriptors, null, 2);
    await expect(json).toMatchFileSnapshot(SNAPSHOT_PATH);
  });
});
