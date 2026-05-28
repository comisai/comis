// SPDX-License-Identifier: Apache-2.0
/**
 * Parity protection for the platform-tool descriptor registry.
 *
 * Locks the descriptor registry's tool set and normalized schema output.
 *
 * Snapshot file name is keyed by TypeBox version: cross-version snapshots
 * are never compared. A `typebox` bump regenerates the snapshot as a
 * separate PR.
 *
 * The dual gate (explicit name set assertion + file-backed snapshot)
 * catches tool removals immediately rather than relying on a
 * snapshot-diff alone.
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

describe("platform-tool registry parity", () => {
  const REGISTRY = createPlatformToolRegistry();

  it("yields a stable tool name set", () => {
    const names = REGISTRY.map((d) => d.name).sort();
    // Explicit list — a tool removal fails this assertion immediately,
    // not just the snapshot-diff.
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
      "get_prompt",
      "heartbeat_manage",
      "image",
      "image_generate",
      "list_prompts",
      "list_resources",
      "mcp_login",
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
      "read_resource",
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
