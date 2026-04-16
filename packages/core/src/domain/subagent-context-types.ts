import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

// ---------------------------------------------------------------------------
// SubagentResult Schema
// ---------------------------------------------------------------------------

/**
 * Structured result returned by a subagent upon completion.
 *
 * Required fields capture the essential outcome; optional fields provide
 * additional detail that the parent agent can use for decision-making.
 * Validated at runtime because the result is parsed from LLM output.
 */
export const SubagentResultSchema = z.strictObject({
  /** Whether the subagent completed its task successfully */
  taskComplete: z.boolean(),
  /** Human-readable summary of what was accomplished */
  summary: z.string().min(1).max(10_000),
  /** Key conclusions or findings */
  conclusions: z.array(z.string().min(1)).min(1).max(50),
  /** File paths created or modified */
  filePaths: z.array(z.string()).max(100).optional(),
  /** Next steps the parent should consider */
  actionableItems: z.array(z.string()).max(50).optional(),
  /** Error descriptions encountered */
  errors: z.array(z.string()).max(50).optional(),
  /** Arbitrary structured data for parent consumption */
  keyData: z.record(z.string(), z.unknown()).optional(),
  /** Confidence score (0-1) for the conclusions */
  confidence: z.number().min(0).max(1).optional(),
});

export type SubagentResult = z.infer<typeof SubagentResultSchema>;

// ---------------------------------------------------------------------------
// Parse Function
// ---------------------------------------------------------------------------

/**
 * Parse unknown input into a SubagentResult, returning Result<T, ZodError>.
 */
export function parseSubagentResult(raw: unknown): Result<SubagentResult, z.ZodError> {
  const result = SubagentResultSchema.safeParse(raw);
  if (result.success) return ok(result.data);
  return err(result.error);
}

// ---------------------------------------------------------------------------
// SubagentEndReason
// ---------------------------------------------------------------------------

/**
 * Terminal reason for a subagent lifecycle ending.
 *
 * - completed: task finished normally
 * - failed: unrecoverable error during execution
 * - killed: explicitly terminated by parent or budget guard
 * - swept: removed by retention sweep (resultRetentionMs expired)
 * - watchdog_timeout: force-failed by per-run watchdog timer (maxRunTimeoutMs exceeded)
 * - ghost_sweep: force-failed by ghost run sweep (stuck past grace period)
 */
export const SubagentEndReasonSchema = z.enum(["completed", "failed", "killed", "swept", "watchdog_timeout", "ghost_sweep"]);

export type SubagentEndReason = z.infer<typeof SubagentEndReasonSchema>;

// ---------------------------------------------------------------------------
// SpawnPacket
// ---------------------------------------------------------------------------

/**
 * Data packet assembled by the parent to spawn a subagent.
 *
 * Constructed programmatically (not parsed from external input), so
 * this is a plain TypeScript interface without a Zod schema.
 */
export interface SpawnPacket {
  /** Task description for the subagent */
  task: string;
  /** File paths the subagent should reference (not inline content) */
  artifactRefs: string[];
  /** Domain knowledge extracted from parent system prompt sections */
  domainKnowledge: string[];
  /** Tool profile group names for subagent tool assembly */
  toolGroups: string[];
  /** Objective statement that survives compaction via transformContext hook */
  objective: string;
  /** Optional summary of parent conversation context */
  parentSummary?: string;
  /** Workspace directory inherited from parent agent */
  workspaceDir: string;
  /** Current spawn depth in the chain (0 = top-level) */
  depth: number;
  /** Maximum allowed spawn depth from config */
  maxDepth: number;
  /** Map of all registered agent IDs to their resolved workspace directories. */
  agentWorkspaces?: Record<string, string>;
  /** Discovered deferred tool names inherited from parent agent.
   *  Child agents restore these into their DiscoveryTracker so previously-discovered
   *  tools are immediately available without re-discovery. */
  discoveredDeferredTools?: string[];
  /** Cached prompt state from parent for prefix sharing.
   *  When present and model/provider match, sub-agent reuses parent's frozen
   *  system prompt instead of building its own. */
  cacheSafeParams?: {
    frozenSystemPrompt: string;
    /** Structured blocks for multi-block cache_control in sub-agents. */
    frozenSystemPromptBlocks?: { staticPrefix: string; attribution: string; semiStableBody: string };
    toolNames: string[];
    model: string;
    provider: string;
    cacheRetention: string | undefined;
    /** 2.1: Timestamp (ms since epoch) when the parent last confirmed a cache write.
     *  Used by the TTL expiry guard in sub-agents to disable skipCacheWrite when
     *  the shared prefix cache has likely expired. */
    cacheWriteTimestamp?: number;
  };
}

// ---------------------------------------------------------------------------
// CondensedResult
// ---------------------------------------------------------------------------

/**
 * A subagent result that has been through the condensation pipeline.
 *
 * Tracks the compression level applied and token accounting for
 * observability. Constructed programmatically, not parsed from
 * external input.
 */
export interface CondensedResult {
  /** Condensation level applied (1=passthrough, 2=LLM summary, 3=truncation) */
  level: 1 | 2 | 3;
  /** The structured result (validated SubagentResult) */
  result: SubagentResult;
  /** Token count of original full result */
  originalTokens: number;
  /** Token count after condensation */
  condensedTokens: number;
  /** Compression ratio (condensedTokens / originalTokens) */
  compressionRatio: number;
  /** Disk path where full result is stored */
  diskPath: string;
}

// ---------------------------------------------------------------------------
// Event Payload Interfaces
// ---------------------------------------------------------------------------

/**
 * Emitted when a spawn packet has been assembled and validated,
 * before the subagent execution begins.
 */
export interface SubAgentSpawnPreparedEvent {
  runId: string;
  parentSessionKey: string;
  agentId: string;
  task: string;
  depth: number;
  maxDepth: number;
  artifactCount: number;
  timestamp: number;
}

/**
 * Emitted when a spawn request is denied due to depth or children limits.
 */
export interface SubAgentSpawnRejectedEvent {
  parentSessionKey: string;
  agentId: string;
  task: string;
  reason: "depth_exceeded" | "children_exceeded" | "queue_full" | "queue_timeout";
  currentDepth: number;
  maxDepth: number;
  currentChildren: number;
  maxChildren: number;
  timestamp: number;
}

/**
 * Emitted when the subagent execution actually begins.
 */
export interface SubAgentSpawnStartedEvent {
  runId: string;
  parentSessionKey: string;
  agentId: string;
  task: string;
  depth: number;
  timestamp: number;
}

/**
 * Emitted when a subagent result has been through the condensation pipeline.
 */
export interface SubAgentResultCondensedEvent {
  runId: string;
  agentId: string;
  level: 1 | 2 | 3;
  originalTokens: number;
  condensedTokens: number;
  compressionRatio: number;
  taskComplete: boolean;
  diskPath: string;
  timestamp: number;
}

/**
 * Emitted when a subagent lifecycle ends for any reason.
 */
export interface SubAgentLifecycleEndedEvent {
  runId: string;
  agentId: string;
  parentSessionKey: string;
  endReason: SubagentEndReason;
  durationMs: number;
  tokensUsed: number;
  cost: number;
  condensationLevel?: 1 | 2 | 3;
  timestamp: number;
}

/**
 * Emitted when a subagent's context engine performs compaction.
 */
export interface SubAgentContextCompactedEvent {
  runId: string;
  agentId: string;
  sessionKey: string;
  fallbackLevel: 1 | 2 | 3;
  originalMessages: number;
  keptMessages: number;
  timestamp: number;
}
