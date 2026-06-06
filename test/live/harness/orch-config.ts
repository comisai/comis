// SPDX-License-Identifier: Apache-2.0
/**
 * buildOrchConfig — shared helper for multi-agent orchestration scenario tests.
 *
 * Builds a temp YAML config file patching multi-agent keys:
 *
 *   1. agents:                   — map of agent id → {model, provider}
 *   2. routing:                  — defaultAgentId + bindings array
 *   3. security.agentToAgent:    — enabled flag + graphMaxGlobalSubAgents + graphMaxConcurrency
 *   4. security.agentToAgent.subagentContext: — nested sub-block for maxSpawnDepth (the depth-exceeded
 *                                  hop-cap key). Lives inside security.agentToAgent (NOT a separate
 *                                  top-level block — the schema rejects unknown top-level keys).
 *                                  maxPingPongTurns (also inside agentToAgent) controls ping-pong
 *                                  reply loops; maxSpawnDepth controls spawn depth — different limits.
 *
 * The gateway port is NOT patched here — ConversationDriver._buildPortedConfigPath()
 * handles that separately so each driver gets its own unique port.
 *
 * Base config: test/config/config.test.yaml
 *
 * Mirrors tool-config.ts and ctx-config.ts exactly, changing only the patched
 * key paths.
 *
 * @module
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const _here = dirname(fileURLToPath(import.meta.url));

/**
 * A single agent entry in the agents map.
 */
export interface AgentEntry {
  /** Agent ID (used as key in the agents YAML map). */
  id: string;
}

/**
 * A routing binding — associates a channel/peer selector to an agent.
 * specificity weights: peerId=8, channelId=4, guildId=2, channelType=1
 */
export interface RoutingBinding {
  channelType?: string;
  channelId?: string;
  peerId?: string;
  guildId?: string;
  agentId: string;
}

/**
 * Options for building a per-scenario multi-agent temp config.
 */
export interface OrchConfigOpts {
  /**
   * Array of agent entries. Each id becomes a key in the YAML agents: map.
   * The "default" agent is always included in the base config.
   */
  agents: AgentEntry[];
  /**
   * routing.defaultAgentId — the fallback agent when no binding matches.
   */
  defaultAgentId: string;
  /**
   * routing.bindings — ordered list of channel/peer selector → agent mappings.
   * Omit to produce no additional bindings (empty bindings list in YAML).
   */
  bindings?: RoutingBinding[];
  /**
   * security.agentToAgent.graphMaxGlobalSubAgents — cross-graph global
   * sub-agent cap. Emits the agentToAgent: block when provided.
   */
  maxGlobalSubAgents?: number;
  /**
   * security.agentToAgent.graphMaxConcurrency — per-graph parallel node cap.
   * Emits the agentToAgent: block when provided.
   */
  graphMaxConcurrency?: number;
  /**
   * security.agentToAgent.subagentContext.maxSpawnDepth — depth-exceeded hop-cap key.
   * Controls how deep the sub-agent spawn tree can go before triggering
   * a depth_exceeded rejection in sub-agent-runner.ts.
   *
   * IMPORTANT: this patches security.agentToAgent.subagentContext.maxSpawnDepth — a
   * NESTED sub-block inside security.agentToAgent, NOT a separate top-level YAML block.
   * The config schema uses strictObject and rejects unknown top-level keys.
   * maxPingPongTurns (also inside agentToAgent) controls cross-session reply loops,
   * not spawn depth — these are different limits.
   *
   * Omit to leave at the config default (3).
   */
  maxSpawnDepth?: number;
  /** Human-readable label used in the output filename (sanitised). */
  label?: string;
}

/**
 * Build a temp YAML config for a multi-agent orchestration scenario.
 *
 * Appends agents:, routing:, and optionally security.agentToAgent: and
 * subagentContext: blocks to the base test config. The gateway port is NOT
 * patched — ConversationDriver handles that separately.
 *
 * @returns Absolute path to the written temp YAML file.
 */
export function buildOrchConfig(opts: OrchConfigOpts): string {
  const base = join(_here, "../../config/config.test.yaml");
  let content = readFileSync(base, "utf-8");

  // ── agents: block ─────────────────────────────────────────────────────────
  // Append a fresh agents: block that includes all requested agent ids.
  // Each agent gets model: default + provider: default (minimal valid config).
  let agentsBlock = "agents:\n";
  for (const agent of opts.agents) {
    agentsBlock += `  ${agent.id}:\n`;
    agentsBlock += `    model: default\n`;
    agentsBlock += `    provider: default\n`;
  }

  // Replace the existing agents: block with the new one that includes all agents.
  // The base config has an agents: block — we replace it wholesale.
  if (/^agents:/m.test(content)) {
    // Remove the existing agents: block (from "agents:" to the next top-level key)
    content = content.replace(/^agents:[\s\S]*?(?=\n[^\s#\n])/m, agentsBlock.trimEnd());
  } else {
    content = content.trimEnd() + "\n" + agentsBlock;
  }

  // ── routing: block ────────────────────────────────────────────────────────
  const bindingsYaml =
    opts.bindings && opts.bindings.length > 0
      ? opts.bindings
          .map((b) => {
            let entry = "    - ";
            if (b.peerId !== undefined) entry += `peerId: "${b.peerId}"\n      `;
            if (b.channelId !== undefined) entry += `channelId: "${b.channelId}"\n      `;
            if (b.channelType !== undefined) entry += `channelType: ${b.channelType}\n      `;
            if (b.guildId !== undefined) entry += `guildId: "${b.guildId}"\n      `;
            entry += `agentId: ${b.agentId}`;
            return entry;
          })
          .join("\n")
      : "";

  const routingBlock =
    `routing:\n` +
    `  defaultAgentId: ${opts.defaultAgentId}\n` +
    (bindingsYaml.length > 0 ? `  bindings:\n${bindingsYaml}\n` : `  bindings: []\n`);

  if (/^routing:/m.test(content)) {
    // Replace existing routing: block
    content = content.replace(/^routing:[\s\S]*?(?=\n[^\s#\n])/m, routingBlock.trimEnd());
  } else {
    content = content.trimEnd() + "\n" + routingBlock;
  }

  // ── security.agentToAgent: block ──────────────────────────────────────────
  // Emitted when any agentToAgent option is provided; enables the feature.
  //
  // IMPORTANT: maxSpawnDepth patches security.agentToAgent.subagentContext.maxSpawnDepth
  // (a nested sub-block inside agentToAgent), NOT a top-level "subagentContext:" block.
  // The top-level config schema uses z.strictObject and rejects unknown top-level keys.
  // Security schema: SecurityConfigSchema.agentToAgent.subagentContext.maxSpawnDepth.
  const hasAgentToAgentCaps =
    opts.maxGlobalSubAgents !== undefined ||
    opts.graphMaxConcurrency !== undefined ||
    opts.maxSpawnDepth !== undefined;

  if (hasAgentToAgentCaps) {
    let agentToAgentBlock = `  agentToAgent:\n    enabled: true\n`;
    if (opts.maxGlobalSubAgents !== undefined) {
      agentToAgentBlock += `    graphMaxGlobalSubAgents: ${opts.maxGlobalSubAgents}\n`;
    }
    if (opts.graphMaxConcurrency !== undefined) {
      agentToAgentBlock += `    graphMaxConcurrency: ${opts.graphMaxConcurrency}\n`;
    }
    if (opts.maxSpawnDepth !== undefined) {
      // Correct location: security.agentToAgent.subagentContext.maxSpawnDepth
      // (NOT a top-level subagentContext: block — the schema rejects unknown top-level keys)
      agentToAgentBlock += `    subagentContext:\n      maxSpawnDepth: ${opts.maxSpawnDepth}\n`;
    }

    if (/^security:/m.test(content)) {
      // Replace the agentToAgent sub-block inside security:
      if (/agentToAgent:/.test(content)) {
        content = content.replace(
          /( *agentToAgent:[\s\S]*?)(?=\n[^\s#\n])/m,
          agentToAgentBlock.trimEnd(),
        );
      } else {
        // security: exists but no agentToAgent sub-block — inject it
        content = content.replace(/(^security:\s*\n)/m, `$1${agentToAgentBlock}`);
      }
    } else {
      // No security: block — append with sub-block
      content = content.trimEnd() + `\nsecurity:\n${agentToAgentBlock}`;
    }
  }

  const labelSanitised = (opts.label ?? "orch").replace(/[^a-zA-Z0-9_-]/g, "_");
  const outPath = join(tmpdir(), `orch-${labelSanitised}-${Date.now()}.yaml`);
  writeFileSync(outPath, content, "utf-8");
  return outPath;
}
