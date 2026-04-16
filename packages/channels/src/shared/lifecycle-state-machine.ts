/**
 * Pure finite state machine for lifecycle reactions.
 *
 * Defines 12 lifecycle phases with deterministic valid transitions.
 * No external dependencies, no side effects -- purely data and predicates.
 */

/**
 * The 12 lifecycle phases an agent message can pass through.
 *
 * - idle: No active processing
 * - queued: Message received, awaiting agent attention
 * - thinking: LLM is generating a response
 * - memory: Searching or writing to memory
 * - tool: Executing a generic tool
 * - coding: Executing code-related tools (bash, file ops)
 * - web: Executing web-related tools (search, browse, fetch)
 * - media: Processing media (image, audio, video)
 * - done: Processing complete
 * - error: Processing failed
 * - stall_soft: Soft stall warning (phase exceeded soft threshold)
 * - stall_hard: Hard stall warning (phase exceeded hard threshold)
 */
export type LifecyclePhase =
  | "idle"
  | "queued"
  | "thinking"
  | "memory"
  | "tool"
  | "coding"
  | "web"
  | "media"
  | "done"
  | "error"
  | "stall_soft"
  | "stall_hard";

/** Category grouping for lifecycle phases. */
export type PhaseCategory = "idle" | "intermediate" | "terminal" | "stall";

/** All 12 lifecycle phases as an iterable array. */
export const ALL_PHASES: readonly LifecyclePhase[] = [
  "idle",
  "queued",
  "thinking",
  "memory",
  "tool",
  "coding",
  "web",
  "media",
  "done",
  "error",
  "stall_soft",
  "stall_hard",
] as const;

/** The intermediate phases that represent active processing. */
const INTERMEDIATE_PHASES: readonly LifecyclePhase[] = [
  "thinking",
  "memory",
  "tool",
  "coding",
  "web",
  "media",
] as const;

/**
 * Deterministic transition map for the lifecycle state machine.
 *
 * Rules:
 * - idle -> [queued]
 * - queued -> [thinking, done, error]
 * - intermediate -> [all other intermediates, done, error, stall_soft]
 * - done/error -> [idle] (after hold period cleanup)
 * - stall_soft -> [stall_hard, all intermediates, done, error]
 * - stall_hard -> [all intermediates, done, error]
 */
export const VALID_TRANSITIONS: Record<LifecyclePhase, readonly LifecyclePhase[]> = {
  idle: ["queued"],
  queued: ["thinking", "done", "error"],
  thinking: ["memory", "tool", "coding", "web", "media", "done", "error", "stall_soft"],
  memory: ["thinking", "tool", "coding", "web", "media", "done", "error", "stall_soft"],
  tool: ["thinking", "memory", "coding", "web", "media", "done", "error", "stall_soft"],
  coding: ["thinking", "memory", "tool", "web", "media", "done", "error", "stall_soft"],
  web: ["thinking", "memory", "tool", "coding", "media", "done", "error", "stall_soft"],
  media: ["thinking", "memory", "tool", "coding", "web", "done", "error", "stall_soft"],
  done: ["idle"],
  error: ["idle"],
  stall_soft: ["stall_hard", ...INTERMEDIATE_PHASES, "done", "error"],
  stall_hard: [...INTERMEDIATE_PHASES, "done", "error"],
} as const;

/**
 * Returns the category for a given lifecycle phase.
 *
 * - "idle" for idle
 * - "terminal" for done or error
 * - "stall" for stall_soft or stall_hard
 * - "intermediate" for all active processing phases
 */
export function getPhaseCategory(phase: LifecyclePhase): PhaseCategory {
  if (phase === "idle") return "idle";
  if (phase === "done" || phase === "error") return "terminal";
  if (phase === "stall_soft" || phase === "stall_hard") return "stall";
  return "intermediate";
}

/**
 * Checks whether a transition from one phase to another is valid.
 */
export function isValidTransition(from: LifecyclePhase, to: LifecyclePhase): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Returns true if the phase is a terminal state (done or error).
 */
export function isTerminal(phase: LifecyclePhase): boolean {
  return phase === "done" || phase === "error";
}
