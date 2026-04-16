/**
 * Multi-round adversarial debate node type driver.
 * Runs 2+ agents through multiple rounds of argumentation, each seeing
 * the full transcript of prior turns. An optional synthesizer agent
 * produces a final verdict after all rounds complete.
 * @module
 */

import { z } from "zod";
import type { NodeTypeDriver, NodeDriverContext, NodeDriverAction } from "@comis/core";

const configSchema = z.strictObject({
  agents: z.array(z.string().min(1)).min(2),
  rounds: z.number().int().min(1).max(5).default(2),
  synthesizer: z.string().min(1).optional(),
});

interface DebateState {
  agents: string[];
  rounds: number;
  synthesizer: string | undefined;
  currentRound: number;
  currentAgentIndex: number;
  transcript: string[];
  phase: "debating" | "synthesizing";
}

export function createDebateDriver(): NodeTypeDriver {
  return {
    typeId: "debate",
    name: "Multi-Round Adversarial Debate",
    description: "Multi-round adversarial debate between agents with optional synthesizer.",
    configSchema,
    defaultTimeoutMs: 600_000,
    estimateDurationMs(config) {
      const c = config as z.infer<typeof configSchema>;
      const agents = (c.agents as string[])?.length ?? 2;
      const rounds = (c.rounds as number) ?? 2;
      const synth = c.synthesizer ? 1 : 0;
      return (agents * rounds + synth) * 90_000;
    },
    initialize(ctx: NodeDriverContext): NodeDriverAction {
      const config = ctx.typeConfig as z.infer<typeof configSchema>;
      const state: DebateState = {
        agents: config.agents,
        rounds: config.rounds,
        synthesizer: config.synthesizer,
        currentRound: 1,
        currentAgentIndex: 0,
        transcript: [],
        phase: "debating",
      };
      ctx.setState(state);

      return {
        action: "spawn",
        agentId: config.agents[0],
        task: buildDebateTask(ctx.task, state, [], ctx.sharedDir),
      };
    },

    onTurnComplete(ctx: NodeDriverContext, agentOutput: string): NodeDriverAction {
      const state = ctx.getState<DebateState>()!;

      if (state.phase === "synthesizing") {
        return { action: "complete", output: agentOutput };
      }

      // Record this turn
      const agentId = state.agents[state.currentAgentIndex];
      state.transcript.push(
        `[Round ${state.currentRound}] ${agentId}: ${agentOutput}`,
      );

      // Advance to next agent/round
      state.currentAgentIndex++;
      if (state.currentAgentIndex >= state.agents.length) {
        state.currentAgentIndex = 0;
        state.currentRound++;
      }

      // After first round output is recorded in transcript,
      // use session-reuse task builder. The session history has prior conversation.
      // graph-driver-handler auto-injects reuseSessionKey from ds.persistentSessionKey.
      const useSessionReuse = state.transcript.length > 0;

      // Check if debating is done
      if (state.currentRound > state.rounds) {
        if (state.synthesizer) {
          state.phase = "synthesizing";
          ctx.setState(state);
          return {
            action: "spawn",
            agentId: state.synthesizer,
            task: useSessionReuse
              ? buildSynthesizerSessionReuseTask(ctx.sharedDir)
              : buildSynthesizerTask(ctx.task, state.transcript, ctx.sharedDir),
          };
        }
        return {
          action: "complete",
          output: formatTranscript(state.transcript),
        };
      }

      ctx.setState(state);
      const nextAgent = state.agents[state.currentAgentIndex];
      return {
        action: "spawn",
        agentId: nextAgent,
        task: useSessionReuse
          ? buildSessionReuseDebateTask(state, ctx.sharedDir)
          : buildDebateTask(ctx.task, state, state.transcript, ctx.sharedDir),
      };
    },

    onAbort(_ctx: NodeDriverContext): void {
      // No cleanup needed
    },

    getPartialOutput(ctx: NodeDriverContext): string | undefined {
      const state = ctx.getState<DebateState>();
      if (!state || state.transcript.length === 0) return undefined;

      // Determine the highest completed round from transcript entries
      let maxRound = 0;
      for (const entry of state.transcript) {
        const m = entry.match(/^\[Round (\d+)\]/);
        if (m) {
          const round = Number(m[1]);
          if (round > maxRound) maxRound = round;
        }
      }

      const header = `[Partial -- ${maxRound} of ${state.rounds} rounds completed]\n\n`;
      return header + formatTranscript(state.transcript);
    },
  };
}

/** Build task text with transcript context for a debate turn (non-reuse path). */
function buildDebateTask(
  originalTask: string,
  state: DebateState,
  transcript: string[],
  sharedDir: string,
): string {
  const parts = [originalTask];
  if (transcript.length > 0) {
    parts.push("\n\n--- Debate Transcript ---");
    parts.push(transcript.join("\n\n"));
    parts.push("--- End Transcript ---");
  }
  const agentId = state.agents[state.currentAgentIndex];
  if (transcript.length === 0) {
    // First speaker — make opening argument
    parts.push(
      `\n\nYou are ${agentId}, arguing in round ${state.currentRound} of ${state.rounds}. ` +
      `Present your opening argument.`,
    );
  } else if (state.currentRound === 1) {
    // Later speakers in round 1 — must take opposing position
    parts.push(
      `\n\nYou are ${agentId}, arguing in round ${state.currentRound} of ${state.rounds}. ` +
      `You MUST take a different position from the previous speaker(s). ` +
      `Challenge their strongest points and present counter-evidence.`,
    );
  } else {
    // Round 2+ — refine, rebut, and strengthen
    parts.push(
      `\n\nYou are ${agentId}, arguing in round ${state.currentRound} of ${state.rounds}. ` +
      `Address weaknesses in your prior arguments that opponents exposed. ` +
      `Present new evidence and strengthen your position.`,
    );
  }
  parts.push(
    `\n\nIMPORTANT: A shared pipeline folder is available at "${sharedDir}". ` +
    `Read the detailed upstream reports there (e.g., *-output.md files) for deeper analysis ` +
    `beyond the summaries provided above.`,
  );
  return parts.join("\n");
}

/**
 * Build session-reuse-aware debate task text.
 * When a persistent session exists (tracked by graph-driver-handler's ds.persistentSessionKey),
 * the session JSONL already contains the prior conversation. Embedding the transcript in the
 * task text would duplicate it. This function produces lean task instructions referencing
 * "the conversation history above" instead.
 */
function buildSessionReuseDebateTask(
  state: DebateState,
  sharedDir: string,
): string {
  const agentId = state.agents[state.currentAgentIndex];
  const parts: string[] = [];

  if (state.currentRound === 1 && state.currentAgentIndex > 0) {
    // First round, second+ agent (counter-argument)
    parts.push(
      `You are ${agentId}, arguing in round ${state.currentRound} of ${state.rounds}. ` +
      `The prior arguments are in the conversation history above. ` +
      `You MUST take a different position from the previous speaker(s). ` +
      `Challenge their strongest points and present counter-evidence.`,
    );
  } else {
    // Subsequent rounds
    parts.push(
      `You are ${agentId}, arguing in round ${state.currentRound} of ${state.rounds}. ` +
      `The full debate so far is in the conversation history above. ` +
      `Address weaknesses in your prior arguments that opponents exposed. ` +
      `Present new evidence and strengthen your position.`,
    );
  }
  parts.push(
    `\nIMPORTANT: A shared pipeline folder is available at "${sharedDir}". ` +
    `Read the detailed upstream reports there (e.g., *-output.md files) for deeper analysis ` +
    `beyond the summaries provided above.`,
  );
  return parts.join("\n");
}

/**
 * Build session-reuse-aware synthesizer task text.
 * References conversation history instead of embedding the full transcript.
 */
function buildSynthesizerSessionReuseTask(sharedDir: string): string {
  return [
    "You are the synthesizer. The full debate transcript is in the conversation history above.",
    "Produce a balanced verdict weighing all arguments.",
    `\nIMPORTANT: A shared pipeline folder is available at "${sharedDir}". ` +
    `Read the detailed upstream reports there (e.g., *-output.md files) for the full context ` +
    `behind each argument.`,
  ].join("\n");
}

/** Build task text for the synthesizer with full transcript (non-reuse path). */
function buildSynthesizerTask(task: string, transcript: string[], sharedDir: string): string {
  return [
    task,
    "\n\n--- Full Debate Transcript ---",
    transcript.join("\n\n"),
    "--- End Transcript ---",
    "\n\nYou are the synthesizer. Produce a balanced verdict weighing all arguments.",
    `\n\nIMPORTANT: A shared pipeline folder is available at "${sharedDir}". ` +
    `Read the detailed upstream reports there (e.g., *-output.md files) for the full context ` +
    `behind each argument.`,
  ].join("\n");
}

/** Format full transcript as the final output when no synthesizer is present. */
function formatTranscript(transcript: string[]): string {
  return [
    "--- Debate Transcript ---",
    transcript.join("\n\n"),
    "--- End Transcript ---",
  ].join("\n");
}
