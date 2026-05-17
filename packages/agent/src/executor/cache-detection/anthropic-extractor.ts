// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-break detection — Anthropic Messages API adapter.
 *
 * Extracts `RecordPromptStateInput` from an Anthropic params object
 * (system, tools, messages, cache_control markers, headers, extra body
 * params, thinking effort). Hashes are computed with the djb2-based
 * `computeHash` helper from prompt-state-utils.ts.
 *
 * @module
 */

import type { RecordPromptStateInput } from "./cache-state-types.js";
import { MAX_SNAPSHOT_CHARS } from "./cache-state.js";
import { computeHash } from "./prompt-state-utils.js";

/**
 * Standard Anthropic Messages API fields.
 * Any key in the params object NOT in this set is an "extra body" parameter.
 * Includes cache/SDK-internal fields to avoid false positives from breakpoint injection.
 */
const STANDARD_ANTHROPIC_FIELDS = new Set([
  "model", "max_tokens", "messages", "system", "stop_sequences",
  "stream", "temperature", "top_p", "top_k", "tools", "tool_choice",
  "thinking", "output_config", "cache_control", "container",
  "inference_geo", "service_tier", "metadata",
  // SDK-internal / breakpoint-injected fields (not user-controlled)
  "betas",
]);

/**
 * Extract prompt state from Anthropic API payload for pre-call recording.
 *
 * CRITICAL: Does NOT mutate the original params object. Creates shallow copies
 * for hashing with cache_control stripped. Per-tool hashing uses
 * input_schema.
 */
export function extractAnthropicPromptState(
  params: Record<string, unknown>,
  modelId: string,
  retention: string | undefined,
  sessionKey: string,
  agentId: string,
  headers?: Record<string, string>,
): RecordPromptStateInput {
  // Extract tools (do NOT mutate params)
  const tools = Array.isArray(params.tools)
    ? (params.tools as Array<Record<string, unknown>>)
    : [];

  // Per-tool hashing using input_schema.
  // Skip server-side tools (tool_search_tool_regex etc.) which lack input_schema.
  const perToolHashes: Record<string, number> = {};
  const toolNames: string[] = [];
  for (const tool of tools) {
    const name = tool.name as string;
    // Server-side tools have a `type` field (e.g., "tool_search_tool_regex_20251119")
    // and no input_schema — skip them for per-tool hashing.
    if (typeof tool.type === "string" && (tool.type as string).startsWith("tool_search_tool_")) continue;
    toolNames.push(name);
    perToolHashes[name] = computeHash(tool.input_schema);
  }

  // Hash all tools together (without cache_control -- explicit field pick)
  // Filter out server-side tools for stable hashing.
  const toolsForHash = tools
    .filter((t) => !(typeof t.type === "string" && (t.type as string).startsWith("tool_search_tool_")))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  const toolsHash = computeHash(toolsForHash);

  // System prompt hash (strip cache_control from system blocks)
  const system = Array.isArray(params.system)
    ? (params.system as Array<Record<string, unknown>>)
    : [];
  const systemForHash = system.map((block) => {

    const { cache_control: _cc, ...rest } = block;
    return rest;
  });
  const systemHash = computeHash(systemForHash);

  // Hash cache_control metadata separately
  const cacheMetadata = [
    ...tools.map((t) => t.cache_control).filter(Boolean),
    ...system.map((b) => b.cache_control).filter(Boolean),
  ];
  const cacheMetadataHash = cacheMetadata.length > 0
    ? computeHash(cacheMetadata)
    : null;

  // Hash tracked Anthropic headers
  const headersHash = headers
    ? computeHash({
        "anthropic-beta": headers["anthropic-beta"] ?? "",
        "anthropic-version": headers["anthropic-version"] ?? "",
      })
    : null;

  // Hash extra body params (keys not in STANDARD_ANTHROPIC_FIELDS)
  const extraKeys = Object.keys(params).filter(k => !STANDARD_ANTHROPIC_FIELDS.has(k));
  const extraBodyHash = extraKeys.length > 0
    ? computeHash(Object.fromEntries(extraKeys.sort().map(k => [k, params[k]])))
    : null;

  // Extract effort value from thinking param
  const thinking = params.thinking as Record<string, unknown> | undefined;
  const effortValue = thinking ? JSON.stringify(thinking) : undefined;

  // Hash system blocks WITH cache_control markers intact (catches TTL/scope flips)
  const cacheControlHash = computeHash(system);

  // Lazy getter -- capture stripped values at creation time (before any cache_control mutation).
  // Serialization only runs when a cache break is detected (zero cost on cache hits).
  const capturedSystem = system.map((block) => (block.text as string) ?? "");
  const capturedToolsForHash = toolsForHash; // already stripped of cache_control
  const buildDiffableContent = (): { system: string; tools: string } => ({
    system: capturedSystem.join("\n").slice(0, MAX_SNAPSHOT_CHARS),
    tools: JSON.stringify(capturedToolsForHash, null, 2).slice(0, MAX_SNAPSHOT_CHARS),
  });

  // Compute breakpoint budget from API params for cache break enrichment.
  // Counts cache_control markers on system blocks, tools, and messages.
  let systemBpCount = 0;
  let toolBpCount = 0;
  let messageBpCount = 0;
  for (const block of system) {
    if (block.cache_control) systemBpCount++;
  }
  for (const tool of tools) {
    if (tool.cache_control) toolBpCount++;
  }
  const messages = Array.isArray(params.messages)
    ? (params.messages as Array<Record<string, unknown>>)
    : [];
  for (const msg of messages) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.cache_control) { messageBpCount++; break; }
      }
    }
  }
  const sdkAutoCount = 1; // SDK always places a marker on the last user message

  return {
    sessionKey,
    agentId,
    provider: "anthropic",
    model: modelId,
    systemHash,
    toolsHash,
    cacheMetadataHash,
    toolNames,
    perToolHashes,
    retention,
    headersHash,
    extraBodyHash,
    effortValue,
    cacheControlHash,
    buildDiffableContent,
    breakpointBudget: {
      total: 4,
      system: systemBpCount,
      tool: toolBpCount,
      message: messageBpCount,
      sdkAuto: sdkAutoCount,
    },
  };
}
