// SPDX-License-Identifier: Apache-2.0
/**
 * Live-fire coverage matrix — source of truth for (dimension × mode-value) coverage.
 *
 * Mirrors the test/e2e/flow-matrix.ts typed-data pattern. Both the architecture
 * gate test (test/architecture/live-coverage-matrix.test.ts) and the live runner
 * consume this file.
 *
 * Shape: every §7.2 combination-generating dimension × mode-value cell. Each cell is:
 *   - status="covered" with `reference` = repo-relative path to a passing
 *     test file that exercises this (dimension × modeValue); OR
 *   - status="skipped" with `reference` = non-empty, non-blocklisted reason
 *     naming which phase covers it.
 *
 * Skip-reason discipline: the blocklist regex enforced by the matrix gate matches
 * any reference that starts with a blocklisted word (see SKIP_REASON_BLOCKLIST in
 * test/architecture/live-coverage-matrix.test.ts). Use "covered in Phase N (NAME)"
 * format for deferred cells.
 *
 * // Total cells: 135
 *
 * @module
 */

export interface CoverageCell {
  readonly dimension: string;
  readonly modeValue: string;
  readonly status: "covered" | "skipped";
  /**
   * For `status: "covered"` — repo-relative path to a test file that exercises
   * this (dimension × modeValue) combination.
   *
   * For `status: "skipped"` — human-readable, case-specific reason explaining
   * which phase covers it. MUST be non-empty and MUST NOT start with a blocklisted
   * word (see SKIP_REASON_BLOCKLIST in live-coverage-matrix.test.ts).
   */
  readonly reference: string;
  readonly phase?: string;
}

export const COVERAGE_DIMENSIONS = [
  // Context engine
  "contextEngine.version",
  // Embedding
  "embedding.provider",
  "local.gpu",
  "embeddingDimensions",
  // Memory
  "memory.costFeatures.enabled",
  // Recall lanes
  "recall.fts",
  "recall.vector",
  "recall.temporal",
  "recall.causal",
  "recall.graphSpread",
  "recall.entity",
  // RAG options
  "rag.rerank.enabled",
  "rag.mmr.enabled",
  "rag.pinned.enabled",
  "rag.forget.enabled",
  "rag.feedback.enabled",
  "rag.onlineTuning.enabled",
  "rag.includeTrustLevels",
  // Security
  "security.storage",
  // MCP
  "mcp.transport",
  "mcp.auth",
  // Cache
  "cacheRetention",
  "adaptiveCacheRetention",
  "cacheBreakpointStrategy",
  "geminiCache",
  // LLM
  "thinkingLevel",
  // Queue
  "queue.defaultMode",
  "queue.overflow",
  // Streaming
  "streaming.chunkMode",
  "streaming.typingMode",
  "streaming.tableMode",
  "streaming.replyMode",
  "streaming.useMarkdownIR",
  // Session
  "session.resetPolicy.mode",
  "dmScope.mode",
  // TTS
  "tts.autoMode",
  "tts.provider",
  // Transcription
  "transcription.provider",
  "transcription.fallback",
  // Vision
  "vision.providers",
  // Image generation
  "image-gen",
  // Search
  "search",
  // Failover
  "modelFailover",
  // Channel modes
  "slack.mode",
  "email.authType",
  // Tools
  "deferredTools.mode",
  "tooling.installDetours.mode",
  // Workspace
  "workspace.profile",
  // Bootstrap
  "bootstrap.promptMode",
  // ORCH (Phase 141)
  "routing.bindingSpecificity",
  "routing.defaultAgentId",
  "agent.isolation",
  "agentToAgent.maxGlobalSubAgents",
  "agentToAgent.graphMaxConcurrency",
  "elevatedReply.trustRouting",
  "subagent.reentry",
] as const;

export type DimensionName = (typeof COVERAGE_DIMENSIONS)[number];

/**
 * The 129-cell coverage matrix. All cells are initially status="skipped" with
 * phase-reference reasons. Subsequent phases settle cells to "covered" as they
 * build and run the corresponding live tests.
 */
export const coverageMatrix: readonly CoverageCell[] = [
  // ===========================================================================
  // contextEngine.version (2 cells)
  // ===========================================================================
  {
    dimension: "contextEngine.version",
    modeValue: "pipeline",
    status: "covered",
    reference: "test/live/scenarios/ctx/pipeline.test.ts",
    phase: "138",
  },
  {
    dimension: "contextEngine.version",
    modeValue: "dag",
    status: "covered",
    reference: "test/live/scenarios/ctx/dag-invariants.test.ts",
    phase: "138",
  },

  // ===========================================================================
  // embedding.provider (3 cells)
  // ===========================================================================
  {
    // WR-02: no test exercises provider="auto" at all — LOCAL_MATRIX only has
    // provider="local" entries; no EMBEDDING_MATRIX row ever uses provider="auto"
    dimension: "embedding.provider",
    modeValue: "auto",
    status: "skipped",
    reference: "covered in Phase 139 (MEM) — auto provider falls back to local; add explicit auto matrix entry",
    phase: "139",
  },
  {
    // WR-01: embedding-matrix.test.ts is behind describe.skipIf(!isLive) Stage-B
    // — never runs in CI/sandbox; only runs with COMIS_LIVE=1 + local model
    dimension: "embedding.provider",
    modeValue: "local",
    status: "skipped",
    reference: "Stage-B live: test/live/scenarios/memory/embedding-matrix.test.ts — requires COMIS_LIVE=1 + local model",
    phase: "139",
  },
  {
    // WR-01: embedding-matrix.test.ts is behind describe.skipIf(!isLive || !hasOpenAiKey) Stage-C
    // — never runs in CI/sandbox; only runs with COMIS_LIVE=1 + OPENAI_API_KEY
    dimension: "embedding.provider",
    modeValue: "openai",
    status: "skipped",
    reference: "Stage-C live: test/live/scenarios/memory/embedding-matrix.test.ts — requires COMIS_LIVE=1 + OPENAI_API_KEY",
    phase: "139",
  },

  // ===========================================================================
  // local.gpu (5 cells)
  // ===========================================================================
  {
    // WR-01: embedding-matrix.test.ts is behind describe.skipIf(!isLive) Stage-B
    // — never runs in CI/sandbox; only runs with COMIS_LIVE=1 + local model
    dimension: "local.gpu",
    modeValue: "auto",
    status: "skipped",
    reference: "Stage-B live: test/live/scenarios/memory/embedding-matrix.test.ts — requires COMIS_LIVE=1 + local model",
    phase: "139",
  },
  {
    dimension: "local.gpu",
    modeValue: "metal",
    status: "skipped",
    reference: "macos-only: Apple Metal GPU backend cannot be exercised without real macOS+Metal hardware",
    phase: "139",
  },
  {
    dimension: "local.gpu",
    modeValue: "cuda",
    status: "skipped",
    reference: "linux-only: CUDA GPU backend requires real Linux+NVIDIA GPU hardware",
    phase: "139",
  },
  {
    dimension: "local.gpu",
    modeValue: "vulkan",
    status: "skipped",
    reference: "linux-only: Vulkan GPU backend requires real Linux GPU hardware with Vulkan drivers",
    phase: "139",
  },
  {
    // WR-01: embedding-matrix.test.ts is behind describe.skipIf(!isLive) Stage-B
    // — never runs in CI/sandbox; only runs with COMIS_LIVE=1 + local model
    dimension: "local.gpu",
    modeValue: "false",
    status: "skipped",
    reference: "Stage-B live: test/live/scenarios/memory/embedding-matrix.test.ts — requires COMIS_LIVE=1 + local model",
    phase: "139",
  },

  // ===========================================================================
  // embeddingDimensions (3 cells)
  // ===========================================================================
  {
    // WR-01: embedding-matrix.test.ts is behind describe.skipIf(!isLive) Stage-B
    // — never runs in CI/sandbox; only runs with COMIS_LIVE=1 + local model
    dimension: "embeddingDimensions",
    modeValue: "768",
    status: "skipped",
    reference: "Stage-B live: test/live/scenarios/memory/embedding-matrix.test.ts — requires COMIS_LIVE=1 + local model",
    phase: "139",
  },
  {
    // WR-01: embedding-matrix.test.ts is behind describe.skipIf(!isLive) Stage-B
    // — never runs in CI/sandbox; only runs with COMIS_LIVE=1 + local model
    dimension: "embeddingDimensions",
    modeValue: "1536",
    status: "skipped",
    reference: "Stage-B live: test/live/scenarios/memory/embedding-matrix.test.ts — requires COMIS_LIVE=1 + local model",
    phase: "139",
  },
  {
    // WR-01: embedding-matrix.test.ts is behind describe.skipIf(!isLive) Stage-B
    // — never runs in CI/sandbox; only runs with COMIS_LIVE=1 + local model
    dimension: "embeddingDimensions",
    modeValue: "3072",
    status: "skipped",
    reference: "Stage-B live: test/live/scenarios/memory/embedding-matrix.test.ts — requires COMIS_LIVE=1 + local model",
    phase: "139",
  },

  // ===========================================================================
  // memory.costFeatures.enabled (2 cells)
  // ===========================================================================
  {
    // WR-01: cost-features.test.ts only does a Stage-A YAML structural check for
    // costFeatures.enabled=true — no live daemon test exercises this path.
    // The Stage-B daemon test is behind describe.skipIf(!isLive).
    dimension: "memory.costFeatures.enabled",
    modeValue: "true",
    status: "skipped",
    reference: "Stage-B live: test/live/scenarios/memory/cost-features.test.ts — requires COMIS_LIVE=1",
    phase: "139",
  },
  {
    dimension: "memory.costFeatures.enabled",
    modeValue: "false",
    status: "covered",
    reference: "test/live/scenarios/memory/cost-features.test.ts",
    phase: "139",
  },

  // ===========================================================================
  // recall lanes — each boolean dimension (12 cells: 6 lanes × on/off)
  // ===========================================================================
  {
    dimension: "recall.fts",
    modeValue: "on",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "recall.fts",
    modeValue: "off",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "recall.vector",
    modeValue: "on",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "recall.vector",
    modeValue: "off",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "recall.temporal",
    modeValue: "on",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "recall.temporal",
    modeValue: "off",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "recall.causal",
    modeValue: "on",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "recall.causal",
    modeValue: "off",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "recall.graphSpread",
    modeValue: "on",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "recall.graphSpread",
    modeValue: "off",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "recall.entity",
    modeValue: "on",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "recall.entity",
    modeValue: "off",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },

  // ===========================================================================
  // RAG options (14 cells: 7 boolean dimensions × on/off, minus rag.includeTrustLevels)
  // ===========================================================================
  {
    dimension: "rag.rerank.enabled",
    modeValue: "true",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "rag.rerank.enabled",
    modeValue: "false",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "rag.mmr.enabled",
    modeValue: "true",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "rag.mmr.enabled",
    modeValue: "false",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "rag.pinned.enabled",
    modeValue: "true",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    dimension: "rag.pinned.enabled",
    modeValue: "false",
    status: "covered",
    reference: "test/live/scenarios/memory/recall-lanes.test.ts",
    phase: "139",
  },
  {
    // CR-02: recall-lanes.test.ts LANE_PAIRS contains no entries for rag.forget —
    // buildMemConfig lanes array does not include "forget"; this cell was never exercised.
    dimension: "rag.forget.enabled",
    modeValue: "true",
    status: "skipped",
    reference: "covered in Phase 140 (TOOL+MCP) — rag.forget live-fire test",
    phase: "140",
  },
  {
    // CR-02: recall-lanes.test.ts LANE_PAIRS contains no entries for rag.forget —
    // buildMemConfig lanes array does not include "forget"; this cell was never exercised.
    dimension: "rag.forget.enabled",
    modeValue: "false",
    status: "skipped",
    reference: "covered in Phase 140 (TOOL+MCP) — rag.forget live-fire test",
    phase: "140",
  },
  {
    // CR-02: recall-lanes.test.ts LANE_PAIRS contains no entries for rag.feedback —
    // buildMemConfig lanes array does not include "feedback"; this cell was never exercised.
    dimension: "rag.feedback.enabled",
    modeValue: "true",
    status: "skipped",
    reference: "covered in Phase 140 (TOOL+MCP) — rag.feedback live-fire test",
    phase: "140",
  },
  {
    // CR-02: recall-lanes.test.ts LANE_PAIRS contains no entries for rag.feedback —
    // buildMemConfig lanes array does not include "feedback"; this cell was never exercised.
    dimension: "rag.feedback.enabled",
    modeValue: "false",
    status: "skipped",
    reference: "covered in Phase 140 (TOOL+MCP) — rag.feedback live-fire test",
    phase: "140",
  },
  {
    // CR-02: recall-lanes.test.ts LANE_PAIRS contains no entries for rag.onlineTuning —
    // buildMemConfig lanes array does not include "onlineTuning"; this cell was never exercised.
    dimension: "rag.onlineTuning.enabled",
    modeValue: "true",
    status: "skipped",
    reference: "covered in Phase 140 (TOOL+MCP) — rag.onlineTuning live-fire test",
    phase: "140",
  },
  {
    // CR-02: recall-lanes.test.ts LANE_PAIRS contains no entries for rag.onlineTuning —
    // buildMemConfig lanes array does not include "onlineTuning"; this cell was never exercised.
    dimension: "rag.onlineTuning.enabled",
    modeValue: "false",
    status: "skipped",
    reference: "covered in Phase 140 (TOOL+MCP) — rag.onlineTuning live-fire test",
    phase: "140",
  },
  {
    dimension: "rag.includeTrustLevels",
    modeValue: "true",
    status: "covered",
    reference: "test/live/scenarios/memory/trust-safety.test.ts",
    phase: "139",
  },
  {
    // WR-01: trust-safety.test.ts only sets includeTrustLevels: true (lines 133, 172);
    // includeTrustLevels=false is never configured in any test in the suite.
    dimension: "rag.includeTrustLevels",
    modeValue: "false",
    status: "skipped",
    reference: "not exercised — deferred to Phase 140 (TOOL+MCP) — rag.includeTrustLevels=false live-fire test",
    phase: "140",
  },

  // ===========================================================================
  // security.storage (3 cells)
  // ===========================================================================
  {
    dimension: "security.storage",
    modeValue: "encrypted",
    status: "skipped",
    reference: "covered in Phase 146 (PLAT) — encrypted credential storage live-fire test",
    phase: "146",
  },
  {
    dimension: "security.storage",
    modeValue: "file",
    status: "skipped",
    reference: "covered in Phase 146 (PLAT) — file-based credential storage live-fire test",
    phase: "146",
  },
  {
    dimension: "security.storage",
    modeValue: "env",
    status: "skipped",
    reference: "covered in Phase 146 (PLAT) — env-var credential storage live-fire test",
    phase: "146",
  },

  // ===========================================================================
  // MCP transport (3 cells)
  // ===========================================================================
  {
    dimension: "mcp.transport",
    modeValue: "stdio",
    status: "skipped",
    reference: "stdio transport requires a child-process MCP server (HTTP mock + transport-auth.test.ts exclude it); covered live with a real stdio server — Stage-C",
    phase: "135",
  },
  {
    dimension: "mcp.transport",
    modeValue: "sse",
    status: "covered",
    reference: "test/live/scenarios/mcp/transport-auth.test.ts",
    phase: "140",
  },
  {
    dimension: "mcp.transport",
    modeValue: "http",
    status: "covered",
    reference: "test/live/scenarios/mcp/transport-auth.test.ts",
    phase: "140",
  },

  // ===========================================================================
  // MCP auth (3 cells)
  // ===========================================================================
  {
    dimension: "mcp.auth",
    modeValue: "none",
    status: "covered",
    reference: "test/live/scenarios/mcp/transport-auth.test.ts",
    phase: "140",
  },
  {
    dimension: "mcp.auth",
    modeValue: "bearer",
    status: "covered",
    reference: "test/live/scenarios/mcp/transport-auth.test.ts",
    phase: "140",
  },
  {
    dimension: "mcp.auth",
    modeValue: "oauth",
    status: "skipped",
    reference: "Stage-C live (requires COMIS_LIVE=1 + real OAuth MCP provider): exercises OAuth flow via transport-auth.test.ts — deferred to operator run",
    phase: "140",
  },

  // ===========================================================================
  // cacheRetention (3 cells)
  // ===========================================================================
  {
    dimension: "cacheRetention",
    modeValue: "none",
    // CR-03/CR-02: "none" exercises the kill-switch path — cache-matrix.test.ts now
    // asserts expectNoCacheWrite (cacheCreationInputTokens===0) for this combo,
    // honestly covering the kill-switch behaviour rather than a broken write assertion.
    status: "covered",
    reference: "test/live/scenarios/cache/cache-matrix.test.ts",
    phase: "137",
  },
  {
    dimension: "cacheRetention",
    modeValue: "short",
    status: "covered",
    reference: "test/live/scenarios/cache/cache-matrix.test.ts",
    phase: "137",
  },
  {
    dimension: "cacheRetention",
    modeValue: "long",
    status: "covered",
    reference: "test/live/scenarios/cache/cache-matrix.test.ts",
    phase: "137",
  },

  // ===========================================================================
  // adaptiveCacheRetention (2 cells)
  // ===========================================================================
  {
    dimension: "adaptiveCacheRetention",
    modeValue: "true",
    status: "covered",
    reference: "test/live/scenarios/cache/cache-matrix.test.ts",
    phase: "137",
  },
  {
    dimension: "adaptiveCacheRetention",
    modeValue: "false",
    status: "covered",
    reference: "test/live/scenarios/cache/cache-matrix.test.ts",
    phase: "137",
  },

  // ===========================================================================
  // cacheBreakpointStrategy (3 cells)
  // ===========================================================================
  {
    dimension: "cacheBreakpointStrategy",
    modeValue: "auto",
    status: "covered",
    reference: "test/live/scenarios/cache/cache-matrix.test.ts",
    phase: "137",
  },
  {
    dimension: "cacheBreakpointStrategy",
    modeValue: "multi-zone",
    status: "covered",
    reference: "test/live/scenarios/cache/cache-matrix.test.ts",
    phase: "137",
  },
  {
    dimension: "cacheBreakpointStrategy",
    modeValue: "single",
    status: "covered",
    reference: "test/live/scenarios/cache/cache-matrix.test.ts",
    phase: "137",
  },

  // ===========================================================================
  // geminiCache (2 cells)
  // ===========================================================================
  {
    dimension: "geminiCache",
    modeValue: "true",
    // CR-03: geminiCache is a Google Gemini CachedContent feature. The only STRATEGY_MATRIX
    // row with geminiCache=true used provider:"anthropic", which does not exercise the
    // Gemini CachedContent API path. CACHE-02 (gemini-cache.test.ts) drives a real Google
    // provider turn with geminiCache enabled and asserts both cacheCreationInputTokens>0
    // and totalCacheSaved>0 — this is the honest reference for this cell.
    status: "covered",
    reference: "test/live/scenarios/cache/gemini-cache.test.ts",
    phase: "137",
  },
  {
    dimension: "geminiCache",
    modeValue: "false",
    status: "covered",
    reference: "test/live/scenarios/cache/cache-matrix.test.ts",
    phase: "137",
  },

  // ===========================================================================
  // thinkingLevel (5 cells)
  // ===========================================================================
  {
    dimension: "thinkingLevel",
    modeValue: "off",
    status: "skipped",
    reference: "covered in Phase 141 (ORCH) — thinkingLevel variation live-fire test",
    phase: "141",
  },
  {
    dimension: "thinkingLevel",
    modeValue: "low",
    status: "skipped",
    reference: "covered in Phase 141 (ORCH) — thinkingLevel variation live-fire test",
    phase: "141",
  },
  {
    dimension: "thinkingLevel",
    modeValue: "medium",
    status: "skipped",
    reference: "covered in Phase 141 (ORCH) — thinkingLevel variation live-fire test",
    phase: "141",
  },
  {
    dimension: "thinkingLevel",
    modeValue: "high",
    status: "skipped",
    reference: "covered in Phase 141 (ORCH) — thinkingLevel variation live-fire test",
    phase: "141",
  },
  {
    dimension: "thinkingLevel",
    modeValue: "xhigh",
    status: "skipped",
    reference: "covered in Phase 141 (ORCH) — thinkingLevel variation live-fire test",
    phase: "141",
  },

  // ===========================================================================
  // queue.defaultMode (4 cells)
  // ===========================================================================
  {
    dimension: "queue.defaultMode",
    modeValue: "followup",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — queue followup mode live-fire test",
    phase: "144",
  },
  {
    dimension: "queue.defaultMode",
    modeValue: "collect",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — queue collect mode live-fire test",
    phase: "144",
  },
  {
    dimension: "queue.defaultMode",
    modeValue: "steer",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — queue steer mode live-fire test",
    phase: "144",
  },
  {
    dimension: "queue.defaultMode",
    modeValue: "steer+followup",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — queue steer+followup mode live-fire test",
    phase: "144",
  },

  // ===========================================================================
  // queue.overflow (3 cells)
  // ===========================================================================
  {
    dimension: "queue.overflow",
    modeValue: "drop-old",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — queue drop-old overflow live-fire test",
    phase: "144",
  },
  {
    dimension: "queue.overflow",
    modeValue: "drop-new",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — queue drop-new overflow live-fire test",
    phase: "144",
  },
  {
    dimension: "queue.overflow",
    modeValue: "summarize",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — queue summarize overflow live-fire test",
    phase: "144",
  },

  // ===========================================================================
  // streaming booleans (10 cells: 5 dimensions × true/false)
  // ===========================================================================
  {
    dimension: "streaming.chunkMode",
    modeValue: "true",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — streaming chunk mode enabled live-fire test",
    phase: "144",
  },
  {
    dimension: "streaming.chunkMode",
    modeValue: "false",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — streaming chunk mode disabled live-fire test",
    phase: "144",
  },
  {
    dimension: "streaming.typingMode",
    modeValue: "true",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — streaming typing mode enabled live-fire test",
    phase: "144",
  },
  {
    dimension: "streaming.typingMode",
    modeValue: "false",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — streaming typing mode disabled live-fire test",
    phase: "144",
  },
  {
    dimension: "streaming.tableMode",
    modeValue: "true",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — streaming table mode enabled live-fire test",
    phase: "144",
  },
  {
    dimension: "streaming.tableMode",
    modeValue: "false",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — streaming table mode disabled live-fire test",
    phase: "144",
  },
  {
    dimension: "streaming.replyMode",
    modeValue: "true",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — streaming reply mode enabled live-fire test",
    phase: "144",
  },
  {
    dimension: "streaming.replyMode",
    modeValue: "false",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — streaming reply mode disabled live-fire test",
    phase: "144",
  },
  {
    dimension: "streaming.useMarkdownIR",
    modeValue: "true",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — streaming Markdown IR enabled live-fire test",
    phase: "144",
  },
  {
    dimension: "streaming.useMarkdownIR",
    modeValue: "false",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — streaming Markdown IR disabled live-fire test",
    phase: "144",
  },

  // ===========================================================================
  // session.resetPolicy.mode (4 cells)
  // ===========================================================================
  {
    dimension: "session.resetPolicy.mode",
    modeValue: "daily",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies session reset policy",
    phase: "146",
  },
  {
    dimension: "session.resetPolicy.mode",
    modeValue: "idle",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies session reset policy",
    phase: "146",
  },
  {
    dimension: "session.resetPolicy.mode",
    modeValue: "hybrid",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies session reset policy",
    phase: "146",
  },
  {
    dimension: "session.resetPolicy.mode",
    modeValue: "none",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies session reset policy",
    phase: "146",
  },

  // ===========================================================================
  // dmScope.mode (4 cells)
  // ===========================================================================
  {
    dimension: "dmScope.mode",
    modeValue: "global",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies dmScope configuration",
    phase: "146",
  },
  {
    dimension: "dmScope.mode",
    modeValue: "agent",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies dmScope configuration",
    phase: "146",
  },
  {
    dimension: "dmScope.mode",
    modeValue: "session",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies dmScope configuration",
    phase: "146",
  },
  {
    dimension: "dmScope.mode",
    modeValue: "channel",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies dmScope configuration",
    phase: "146",
  },

  // ===========================================================================
  // tts.autoMode (4 cells)
  // ===========================================================================
  {
    dimension: "tts.autoMode",
    modeValue: "off",
    status: "skipped",
    reference: "covered in Phase 142 (MEDIA) — TTS auto mode off live-fire test",
    phase: "142",
  },
  {
    dimension: "tts.autoMode",
    modeValue: "always",
    status: "skipped",
    reference: "covered in Phase 142 (MEDIA) — TTS always-on auto mode live-fire test",
    phase: "142",
  },
  {
    dimension: "tts.autoMode",
    modeValue: "inbound",
    status: "skipped",
    reference: "covered in Phase 142 (MEDIA) — TTS inbound-triggered auto mode live-fire test",
    phase: "142",
  },
  {
    dimension: "tts.autoMode",
    modeValue: "tagged",
    status: "skipped",
    reference: "covered in Phase 142 (MEDIA) — TTS tagged auto mode live-fire test",
    phase: "142",
  },

  // ===========================================================================
  // tts.provider (3 cells)
  // ===========================================================================
  {
    dimension: "tts.provider",
    modeValue: "openai",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "tts.provider",
    modeValue: "elevenlabs",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "tts.provider",
    modeValue: "edge",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },

  // ===========================================================================
  // transcription.provider (3 cells)
  // ===========================================================================
  {
    dimension: "transcription.provider",
    modeValue: "openai",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "transcription.provider",
    modeValue: "groq",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "transcription.provider",
    modeValue: "deepgram",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },

  // ===========================================================================
  // transcription.fallback (2 cells)
  // ===========================================================================
  {
    dimension: "transcription.fallback",
    modeValue: "true",
    status: "skipped",
    reference: "covered in Phase 142 (MEDIA) — transcription fallback chain enabled live-fire test",
    phase: "142",
  },
  {
    dimension: "transcription.fallback",
    modeValue: "false",
    status: "skipped",
    reference: "covered in Phase 142 (MEDIA) — transcription fallback chain disabled live-fire test",
    phase: "142",
  },

  // ===========================================================================
  // vision.providers (3 cells)
  // ===========================================================================
  {
    dimension: "vision.providers",
    modeValue: "openai",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "vision.providers",
    modeValue: "anthropic",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "vision.providers",
    modeValue: "google",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },

  // ===========================================================================
  // image-gen (2 cells)
  // ===========================================================================
  {
    dimension: "image-gen",
    modeValue: "fal",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "image-gen",
    modeValue: "openai",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },

  // ===========================================================================
  // search (8 cells)
  // ===========================================================================
  {
    dimension: "search",
    modeValue: "brave",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "search",
    modeValue: "tavily",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "search",
    modeValue: "duckduckgo",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "search",
    modeValue: "searxng",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "search",
    modeValue: "exa",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "search",
    modeValue: "grok",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "search",
    modeValue: "perplexity",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },
  {
    dimension: "search",
    modeValue: "jina",
    status: "covered",
    reference: "test/live/sweep/probes.ts",
    phase: "135",
  },

  // ===========================================================================
  // modelFailover (2 cells)
  // ===========================================================================
  {
    dimension: "modelFailover",
    modeValue: "true",
    status: "skipped",
    reference: "covered in Phase 145 (SEC) — model failover enabled live-fire test",
    phase: "145",
  },
  {
    dimension: "modelFailover",
    modeValue: "false",
    status: "skipped",
    reference: "covered in Phase 145 (SEC) — model failover disabled live-fire test",
    phase: "145",
  },

  // ===========================================================================
  // slack.mode (2 cells)
  // ===========================================================================
  {
    dimension: "slack.mode",
    modeValue: "socket",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — Slack Socket Mode live-fire test",
    phase: "144",
  },
  {
    dimension: "slack.mode",
    modeValue: "http",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — Slack HTTP mode live-fire test",
    phase: "144",
  },

  // ===========================================================================
  // email.authType (2 cells)
  // ===========================================================================
  {
    dimension: "email.authType",
    modeValue: "password",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — email password authentication live-fire test",
    phase: "144",
  },
  {
    dimension: "email.authType",
    modeValue: "oauth2",
    status: "skipped",
    reference: "covered in Phase 144 (CHAN) — email OAuth2 authentication live-fire test",
    phase: "144",
  },

  // ===========================================================================
  // deferredTools.mode (3 cells)
  // ===========================================================================
  {
    dimension: "deferredTools.mode",
    modeValue: "always",
    status: "covered",
    reference: "test/live/scenarios/tools/modes.test.ts",
    phase: "140",
  },
  {
    dimension: "deferredTools.mode",
    modeValue: "auto",
    status: "skipped",
    reference: "Stage-C deferred: auto mode requires a real model selecting tool demotion (it.skip in modes.test.ts); set COMIS_LIVE=1",
    phase: "140",
  },
  {
    dimension: "deferredTools.mode",
    modeValue: "never",
    status: "covered",
    reference: "test/live/scenarios/tools/modes.test.ts",
    phase: "140",
  },

  // ===========================================================================
  // tooling.installDetours.mode (3 cells)
  // ===========================================================================
  {
    dimension: "tooling.installDetours.mode",
    modeValue: "observe",
    status: "skipped",
    reference: "install-detour observe requires a real model running an exec command to trigger detection (modes.test.ts Stage-C, describe.skipIf(!isLive)); set COMIS_LIVE=1",
    phase: "140",
  },
  {
    // test/integration/install-detour-advise-e2e.test.ts is the REAL integration test
    // exercising the advise mode end-to-end (boots daemon, constructs exec-tool inline,
    // asserts tool:install_detour_detected with action="hinted" + installDetourHint augmentation).
    // Deterministic CI gate — not skipif-wrapped.
    dimension: "tooling.installDetours.mode",
    modeValue: "advise",
    status: "covered",
    reference: "test/integration/install-detour-advise-e2e.test.ts",
    phase: "140",
  },
  {
    // test/integration/install-detour-soft-stop-e2e.test.ts is the REAL integration test
    // exercising soft-stop mode (boots daemon with config.test-tooling-soft-stop.yaml,
    // constructs exec-tool inline, asserts pip install of overlapping package is refused
    // pre-spawn with action="soft_stopped"). Deterministic CI gate — not skipif-wrapped.
    dimension: "tooling.installDetours.mode",
    modeValue: "soft-stop",
    status: "covered",
    reference: "test/integration/install-detour-soft-stop-e2e.test.ts",
    phase: "140",
  },

  // ===========================================================================
  // workspace.profile (2 cells)
  // ===========================================================================
  {
    dimension: "workspace.profile",
    modeValue: "full",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies workspace profile",
    phase: "146",
  },
  {
    dimension: "workspace.profile",
    modeValue: "specialist",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies workspace profile",
    phase: "146",
  },

  // ===========================================================================
  // bootstrap.promptMode (3 cells)
  // ===========================================================================
  {
    dimension: "bootstrap.promptMode",
    modeValue: "full",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies bootstrap promptMode",
    phase: "146",
  },
  {
    dimension: "bootstrap.promptMode",
    modeValue: "minimal",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies bootstrap promptMode",
    phase: "146",
  },
  {
    dimension: "bootstrap.promptMode",
    modeValue: "none",
    status: "skipped",
    reference: "not a LOOP dimension — deferred to Phase 146 (PLATFORM) which varies bootstrap promptMode",
    phase: "146",
  },

  // ===========================================================================
  // ORCH (7 cells)
  // ===========================================================================
  {
    dimension: "routing.bindingSpecificity",
    modeValue: "peer>channel>guild>type",
    status: "skipped",
    reference: "Phase 141 Wave-3 scenario: test/live/scenarios/orch/routing.test.ts (peer>channel>guild>type precedence)",
    phase: "141",
  },
  {
    dimension: "routing.defaultAgentId",
    modeValue: "fallback",
    status: "skipped",
    reference: "Phase 141 Wave-3 scenario: test/live/scenarios/orch/routing.test.ts (defaultAgentId fallback routing)",
    phase: "141",
  },
  {
    dimension: "agent.isolation",
    modeValue: "session-memory-scoping",
    status: "skipped",
    reference: "Phase 141 Wave-3 scenario: test/live/scenarios/orch/isolation.test.ts (session-memory scoping per agent)",
    phase: "141",
  },
  {
    dimension: "agentToAgent.maxGlobalSubAgents",
    modeValue: "capped",
    status: "skipped",
    reference: "Phase 141 Wave-3 scenario: test/live/scenarios/orch/dag-pipeline.test.ts (maxGlobalSubAgents cap enforcement)",
    phase: "141",
  },
  {
    dimension: "agentToAgent.graphMaxConcurrency",
    modeValue: "bounded",
    status: "skipped",
    reference: "Phase 141 Wave-3 scenario: test/live/scenarios/orch/dag-pipeline.test.ts (graphMaxConcurrency bounded execution)",
    phase: "141",
  },
  {
    dimension: "elevatedReply.trustRouting",
    modeValue: "enabled",
    status: "skipped",
    reference: "Phase 141 Wave-3 scenario: test/live/scenarios/orch/isolation.test.ts (elevatedReply trust routing enabled)",
    phase: "141",
  },
  {
    dimension: "subagent.reentry",
    modeValue: "hop-cap+at-most-once",
    status: "skipped",
    reference: "Phase 141 Wave-3 scenario: test/live/scenarios/orch/background-reentry.test.ts (hop-cap + at-most-once reentry)",
    phase: "141",
  },
] as const;
