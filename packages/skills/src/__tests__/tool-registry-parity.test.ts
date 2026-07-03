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
      // The opt-in, default-OFF dialectic tool. Registered as a
      // CONDITIONAL descriptor (gated on ctx.dialecticEnabled === true, fed from
      // agentConfig.dialectic.enabled). The parity set pins it exactly as the other
      // feature-gated conditionals (browser / background_tasks) —
      // its presence in the registry's single-source-of-truth set is intentional, and
      // the daemon filters on `conditional` BEFORE build so it is ABSENT from the built
      // tool set when the knob is off (default-OFF byte-identity, the cost gate).
      "memory_ask",
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
      // The video-generation tool. Registered as a CONDITIONAL
      // descriptor (gated on ctx.videoGenProvider, mirroring image_generate's
      // imageGenProvider gate) — the daemon populates the signal at boot.
      "video_generate",
      // The video-status query tool. CONDITIONAL descriptor
      // (gated on ctx.videoStatusEnabled — the async store+poller stack, set on
      // the SAME condition video_generate uses). Never exported.
      "video_status",
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

  // memory_ask default-OFF byte-identity — the opt-in cost gate. The daemon builds the
  // live tool set by FILTERING descriptors on `conditional(ctx)` BEFORE invoking
  // `build` (registry.ts JSDoc + setup-tools). So with `dialecticEnabled` absent/false
  // the memory_ask tool is NOT in the built set (no behavior change, no query-time LLM
  // surface); with `dialecticEnabled: true` it IS present, constructed by its `build`.
  describe("memory_ask conditional opt-in gate", () => {
    const askDescriptor = REGISTRY.find((d) => d.name === "memory_ask");

    /** Mirror the daemon's filter-then-build: keep only descriptors whose `conditional`
     *  (when present) passes for ctx, then construct each via `build`. */
    function buildLiveToolSet(ctx: never): string[] {
      return REGISTRY.filter((d) => (d.conditional ? d.conditional(ctx) : true))
        .map((d) => d.build(ctx)?.name)
        .filter((n): n is string => typeof n === "string");
    }

    it("is registered as a CONDITIONAL descriptor (not unconditional)", () => {
      expect(askDescriptor, "memory_ask must be in the registry").toBeDefined();
      expect(askDescriptor!.category).toBe("memory");
      expect(typeof askDescriptor!.conditional, "memory_ask must carry a conditional gate").toBe(
        "function",
      );
    });

    it("with dialecticEnabled absent/false: memory_ask is ABSENT from the built tool set", () => {
      const offCtx = { agentId: "test-agent", rpcCall: async () => ({}) } as never;
      const falseCtx = {
        agentId: "test-agent",
        rpcCall: async () => ({}),
        dialecticEnabled: false,
      } as never;
      expect(buildLiveToolSet(offCtx)).not.toContain("memory_ask");
      expect(buildLiveToolSet(falseCtx)).not.toContain("memory_ask");
      // The conditional predicate itself returns false for the off cases.
      expect(askDescriptor!.conditional!(offCtx)).toBe(false);
      expect(askDescriptor!.conditional!(falseCtx)).toBe(false);
    });

    it("with dialecticEnabled: true: memory_ask IS present and builds with the correct name + params", () => {
      const onCtx = {
        agentId: "test-agent",
        rpcCall: async () => ({}),
        dialecticEnabled: true,
      } as never;
      expect(buildLiveToolSet(onCtx)).toContain("memory_ask");
      expect(askDescriptor!.conditional!(onCtx)).toBe(true);
      const tool = askDescriptor!.build(onCtx);
      expect(tool?.name).toBe("memory_ask");
      // The tool declares a `question` parameter (the dialectic question).
      expect(JSON.stringify(tool?.parameters)).toContain("question");
    });
  });

  // video_generate build-signature non-regression. The build callback
  // threads ctx.videoGenProvider so the description is
  // runtime-built from the active backend matrix. The parity STUB_CTX has NO
  // videoGenProvider, so the build runs with provider=undefined → it MUST still
  // construct (the static-fallback path, never throws) and MUST NOT change the
  // captured params (the provider affects only the description — the description is NOT in the
  // snapshot, so the snapshot stays byte-identical). Specifically: NO new param
  // and NO reference_images param (multi-ref support is deliberately deferred).
  describe("video_generate build is provider-optional and only affects the description", () => {
    const videoDescriptor = REGISTRY.find((d) => d.name === "video_generate");

    it("is registered as a CONDITIONAL descriptor gated on videoGenProvider", () => {
      expect(videoDescriptor, "video_generate must be in the registry").toBeDefined();
      expect(videoDescriptor!.category).toBe("media");
      expect(typeof videoDescriptor!.conditional, "video_generate must carry a conditional gate").toBe(
        "function",
      );
    });

    it("builds with provider=undefined (STUB_CTX) without throwing and keeps name video_generate", () => {
      let tool!: ReturnType<typeof videoDescriptor.build>;
      expect(() => {
        tool = videoDescriptor!.build(STUB_CTX);
      }).not.toThrow();
      expect(tool?.name).toBe("video_generate");
    });

    it("keeps the 8 shipped params and declares NO reference_images param (description-only)", () => {
      const schema = videoDescriptor!.build(STUB_CTX)?.parameters as any;
      expect(schema.required ?? []).toContain("prompt");
      for (const p of [
        "duration",
        "aspect_ratio",
        "resolution",
        "audio",
        "negative_prompt",
        "seed",
        "image_url",
        "model",
      ]) {
        expect(schema.properties[p], `param ${p} must exist`).toBeDefined();
      }
      // Multi-ref support is deliberately deferred — NO reference_images param.
      expect(schema.properties.reference_images).toBeUndefined();
    });
  });
});
