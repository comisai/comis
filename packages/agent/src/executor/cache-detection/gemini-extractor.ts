// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-break detection — Gemini-native adapter (Phase 42 split per
 * EXEC-SPLIT-09).
 *
 * Extracts `RecordPromptStateInput` from a Gemini params object (nested
 * `config.systemInstruction`, `config.tools[0].functionDeclarations`,
 * `parametersJsonSchema`). No cache_control markers, no header tracking,
 * no extra-body tracking — static config only.
 *
 * @module
 */

import type { RecordPromptStateInput } from "./cache-state-types.js";
import { computeHash, sanitizeMcpToolName } from "./prompt-state-utils.js";

/**
 * Extract Gemini-native prompt state for pre-call cache break detection.
 *
 * Gemini payload structure differs from Anthropic:
 * - System prompt: config.systemInstruction (string, not array of blocks)
 * - Tools: config.tools[0].functionDeclarations (nested, not flat)
 * - Per-tool schema: parametersJsonSchema (not input_schema)
 * - No cache_control markers (cacheMetadataHash always null)
 * - No adaptive retention (Gemini reads static config.cacheRetention)
 */
export function extractGeminiPromptState(
  params: Record<string, unknown>,
  modelId: string,
  sessionKey: string,
  agentId: string,
): RecordPromptStateInput {
  const configObj = params.config as Record<string, unknown> | undefined;

  // System instruction is a string (not array of blocks like Anthropic)
  const systemInstruction = configObj?.systemInstruction;
  const systemHash = computeHash(systemInstruction ?? "");

  // Tools are nested: config.tools[0].functionDeclarations
  const toolsArr = configObj?.tools as Array<Record<string, unknown>> | undefined;
  const functionDeclarations: Array<Record<string, unknown>> =
    Array.isArray(toolsArr) && toolsArr.length > 0
      ? (toolsArr[0]?.functionDeclarations as Array<Record<string, unknown>> ?? [])
      : [];

  // Per-tool hashing using parametersJsonSchema (Gemini equivalent of Anthropic input_schema)
  const perToolHashes: Record<string, number> = {};
  const toolNames: string[] = [];
  for (const decl of functionDeclarations) {
    const name = decl.name as string;
    toolNames.push(name);
    perToolHashes[sanitizeMcpToolName(name)] = computeHash(decl.parametersJsonSchema);
  }

  // Hash all function declarations together for aggregate tools hash
  const toolsHash = computeHash(functionDeclarations);

  return {
    sessionKey,
    agentId,
    provider: "google",
    model: modelId,
    systemHash,
    toolsHash,
    cacheMetadataHash: null, // Gemini has no inline cache_control markers
    toolNames,
    perToolHashes,
    retention: undefined,       // Gemini reads static config, not adaptive retention
    headersHash: null, // Gemini does not track headers
    extraBodyHash: null, // Gemini does not track extra body params
  };
}
