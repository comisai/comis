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
 */
export function createStepCounter(maxSteps: number = DEFAULT_MAX_STEPS): StepCounter {
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

    getCount(): number {
      return count;
    },
  };
}
