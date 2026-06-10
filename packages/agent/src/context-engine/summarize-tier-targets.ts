// SPDX-License-Identifier: Apache-2.0
/**
 * Tier-aware summary token target resolver (Phase 171, SUM-02).
 *
 * Provides resolveSummaryTargetTokens() keyed on capabilityClass + depth,
 * and the deterministic nano structured extractor floor. No I/O, no network,
 * no @comis/memory import (agent↛memory architecture cut).
 *
 * @module
 */

import type { CapabilityClass } from "../executor/model-profile.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { LEAF_FALLBACK_SUMMARY_MARKER } from "./constants.js";
import { computeShrinkBounds } from "./lcd-leaf-summarizer.js";
import { estimateMessageTokens, estimateMessageChars } from "../safety/token-estimator.js";

// ---------------------------------------------------------------------------
// Tier-aware target tokens
// ---------------------------------------------------------------------------

/**
 * Resolve the effective summary target token count for the given tier.
 *
 * Rules (SUM-02):
 *  - nano   → min(256, configuredTarget)
 *  - small  → min(400, configuredTarget)
 *  - mid    → min(800, configuredTarget)
 *  - frontier → configuredTarget (uncapped)
 *  - unknown → fail-closed to nano floor (min(256, configuredTarget))
 *
 * The `depth` parameter is accepted for future depth-scaling but is currently
 * unused in the token resolution logic.
 *
 * @param capabilityClass - the model's capability class
 * @param depth - the depth level of the summary (reserved for future use)
 * @param configuredTarget - the operator-configured leafTargetTokens / condensedTargetTokens
 * @returns the effective token target to pass as `reserveTokens`
 */
export function resolveSummaryTargetTokens(
  capabilityClass: CapabilityClass,
  depth: number,   // reserved — future depth-based scaling; currently unused
  configuredTarget: number,
): number {
  void depth; // reserved for future use — suppress unused-param lint
  switch (capabilityClass) {
    case "nano":
      return Math.min(256, configuredTarget);
    case "small":
      return Math.min(400, configuredTarget);
    case "mid":
      return Math.min(800, configuredTarget);
    case "frontier":
      return configuredTarget;
    default:
      // Fail-closed to nano for unknown capability classes
      return Math.min(256, configuredTarget);
  }
}

// ---------------------------------------------------------------------------
// Nano deterministic structured extractor
// ---------------------------------------------------------------------------

/**
 * Build a deterministic structured extraction for nano/small-without-override eviction.
 *
 * Replaces the bare count-note (`LEAF_FALLBACK_SUMMARY_MARKER N messages`) with a
 * structured JSON block carrying decisions/files/entities/constraints extracted by
 * simple string heuristics (no LLM). The result MUST:
 *   1. Carry LEAF_FALLBACK_SUMMARY_MARKER so DOC-01 scans detect it.
 *   2. Pass the shrink invariant (C1): tokenCount strictly < chunkTokens.
 *
 * If the structured JSON exceeds `shrinkCeilingTokens` (from computeShrinkBounds),
 * falls back to a bare count-note that is guaranteed to be smaller.
 *
 * @param messages - the chunk's AgentMessages (content scanned, never logged)
 * @param chunkTokens - the chunk's pre-computed token count (the strict floor to beat)
 * @returns { content, tokenCount } — content carries the marker; tokenCount < chunkTokens
 */
export function buildNanoStructuredExtraction(
  messages: AgentMessage[],
  chunkTokens: number,
): { content: string; tokenCount: number } {
  // Extract patterns by simple string heuristics (no LLM)
  const decisions: string[] = [];
  const files: string[] = [];
  const entities: string[] = [];
  const constraints: string[] = [];

  for (const msg of messages) {
    const text = contentOf(msg);
    if (!text) continue;
    for (const line of text.split("\n")) {
      // decisions: lines mentioning a choice or agreement
      if (
        decisions.length < 5 &&
        /decided|decision|agreed|changed to|updated to/i.test(line)
      ) {
        const trimmed = line.trim().slice(0, 120);
        if (trimmed) decisions.push(trimmed);
      }
      // files: lines referencing source file paths
      if (
        files.length < 5 &&
        /\.ts\b|\.js\b|\.md\b|\.yaml\b|\.json\b|\/[a-z]/i.test(line)
      ) {
        // Extract the file-like fragment
        const match = line.match(/([./][\w/.-]+\.\w+)/);
        if (match) files.push(match[1]!.slice(0, 80));
      }
      // entities: PascalCase identifiers longer than 3 chars
      if (entities.length < 5) {
        const matched = line.match(/\b([A-Z][a-z][A-Za-z]{2,})\b/g);
        if (matched) {
          for (const e of matched) {
            if (entities.length < 5 && !entities.includes(e)) entities.push(e);
          }
        }
      }
      // constraints: normative language
      if (
        constraints.length < 5 &&
        /\bmust\b|\bnever\b|\balways\b|\brequire\b|\bconstraint\b/i.test(line)
      ) {
        const trimmed = line.trim().slice(0, 120);
        if (trimmed) constraints.push(trimmed);
      }
    }
  }

  const structured =
    `${LEAF_FALLBACK_SUMMARY_MARKER} [structured-extract]\n` +
    `decisions: ${JSON.stringify(decisions)}\n` +
    `files: ${JSON.stringify(files)}\n` +
    `entities: ${JSON.stringify(entities)}\n` +
    `constraints: ${JSON.stringify(constraints)}`;

  // Compute the rendered character sum for shrink bounds
  const renderedChars = messages.reduce(
    (acc, m) => acc + estimateMessageChars(m as unknown as Message),
    0,
  );
  const { shrinkCeilingTokens } = computeShrinkBounds(renderedChars, 256);

  const tokenCount = estimateMessageTokens({ role: "user", content: structured } as Message);

  // C1 / shrink invariant: if structured output is not smaller than the ceiling,
  // fall back to the bare count-note (always tiny, always beats the ceiling)
  if (tokenCount >= shrinkCeilingTokens) {
    return buildBareCountNote(messages.length, chunkTokens);
  }

  return { content: structured, tokenCount };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Extract text content from an AgentMessage (role-agnostic).
 * Content may be a string or a block array — extract the first text block.
 */
function contentOf(msg: AgentMessage): string | undefined {
  const raw = (msg as unknown as { content?: unknown }).content;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    for (const block of raw) {
      const type = (block as { type?: string }).type;
      if (type === "text" || type === undefined) {
        const text = (block as { text?: string }).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return undefined;
}

/**
 * Bare count-note fallback when structured extraction exceeds shrinkCeilingTokens.
 * Mirrors the count-note pattern from lcd-leaf-summarizer.ts (buildDeterministicFallback).
 */
function buildBareCountNote(
  messageCount: number,
  chunkTokens: number,
): { content: string; tokenCount: number } {
  const content = `${LEAF_FALLBACK_SUMMARY_MARKER} ${messageCount} earlier messages summarized deterministically`;
  const tokenCount = Math.max(1, Math.min(chunkTokens - 1, estimateMessageTokens({ role: "user", content } as Message)));
  return { content, tokenCount };
}
