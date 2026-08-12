// SPDX-License-Identifier: Apache-2.0
/** Step counter interface for enforcing MAX_STEPS execution limits */
export interface StepCounter {
  /** Increment the step count by 1 and return the new count */
  increment(): number;
  /** Returns true when count >= maxSteps (agent should halt) */
  shouldHalt(): boolean;
  /** Reset the count to 0 */
  reset(): void;
  /** Return the current step count */
  getCount(): number;
  /** Return the configured step ceiling. */
  getLimit?(): number;
  /**
   * The config key or tool parameter that set this ceiling.
   *
   * Travels with the counter because only its creator knows which knob won: a
   * delegated run is bounded by `security.agentToAgent.subAgentMaxSteps`, a
   * top-level turn by `agents.<id>.maxSteps`. Guessing from the agent id names
   * the wrong key and sends operators to a setting with no effect.
   */
  getBindingKnob?(): string;
}

/** Default maximum steps if not specified */
const DEFAULT_MAX_STEPS = 50;

/**
 * Creates a step counter that signals halt at a configurable MAX_STEPS limit.
 *
 * Used by the agent executor to prevent runaway execution loops.
 * The counter tracks tool execution steps and signals when the agent
 * should stop processing.
 *
 * @param maxSteps - Maximum allowed steps before halting (default: 50)
 * @param bindingKnob - The config key/parameter that set `maxSteps`, reported
 *   verbatim when the ceiling stops a run.
 */
export function createStepCounter(
  maxSteps: number = DEFAULT_MAX_STEPS,
  bindingKnob?: string,
): StepCounter {
  let count = 0;

  return {
    increment(): number {
      count++;
      return count;
    },

    shouldHalt(): boolean {
      return count >= maxSteps;
    },

    reset(): void {
      count = 0;
    },

    ...(bindingKnob === undefined ? {} : { getBindingKnob: (): string => bindingKnob }),

    getCount(): number {
      return count;
    },

    getLimit(): number {
      return maxSteps;
    },
  };
}
