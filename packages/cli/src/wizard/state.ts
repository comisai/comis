/**
 * Immutable state machine for the init wizard.
 *
 * Manages wizard state through step execution, enforcing immutability
 * (each transition returns a fresh state object), flow-defined step
 * sequences, and jump-to support for review edits.
 *
 * No disk persistence: Ctrl+C means start over.
 * Single Escape goes back one step; double Escape exits.
 *
 * @module
 */

import type {
  FlowType,
  WizardState,
  WizardStepId,
  WizardStep,
} from "./types.js";
import { INITIAL_STATE } from "./types.js";
import type {
  WizardPrompter,
  SelectOpts,
  MultiselectOpts,
  TextOpts,
  PasswordOpts,
} from "./prompter.js";
import { CancelError, SkipError } from "./prompter.js";

// ---------- Constants ----------

/** Time window (ms) for detecting double-escape (exit wizard). */
export const DOUBLE_ESCAPE_MS = 800;

/** Sentinel value injected as the "Skip" option in wrapped prompts. */
export const SKIP_SENTINEL = "__WIZARD_SKIP__";

// ---------- Skip-Wrapped Prompter ----------

/**
 * Wrap a prompter so selecting a "Cancel" option throws an explicit
 * CancelError that exits the wizard immediately.
 *
 * Applied to ALL steps (including non-skippable ones).
 */
export function wrapWithCancel(inner: WizardPrompter): WizardPrompter {
  return {
    intro: (title) => inner.intro(title),
    outro: (message) => inner.outro(message),
    note: (message, title) => inner.note(message, title),
    confirm: (opts) => inner.confirm(opts),
    spinner: () => inner.spinner(),
    group: (steps) => inner.group(steps),
    log: inner.log,

    select: async <T>(opts: SelectOpts<T>): Promise<T> => {
      const cancelOption = opts.options.find((o) => o.label === "Cancel");
      const result = await inner.select(opts);
      if (cancelOption && result === cancelOption.value) {
        throw new CancelError(true);
      }
      return result;
    },

    multiselect: (opts) => inner.multiselect(opts),
    text: (opts) => inner.text(opts),
    password: (opts) => inner.password(opts),
  };
}

/**
 * Wrap a prompter to inject a "Skip" option into every interactive prompt.
 *
 * - select: appends a "Skip" option; throws SkipError if chosen
 * - multiselect: appends a "Skip (none)" option; throws SkipError if chosen
 * - text: allows empty input to skip; appends hint to message
 * - password: allows empty input to skip; appends hint to message
 * - confirm, spinner, group, log, note, intro, outro: pass through unchanged
 *
 * Cancel interception is handled by wrapWithCancel (applied separately).
 */
export function wrapWithSkip(inner: WizardPrompter): WizardPrompter {
  return {
    intro: (title) => inner.intro(title),
    outro: (message) => inner.outro(message),
    note: (message, title) => inner.note(message, title),
    confirm: (opts) => inner.confirm(opts),
    spinner: () => inner.spinner(),
    group: (steps) => inner.group(steps),
    log: inner.log,

    select: async <T>(opts: SelectOpts<T>): Promise<T> => {
      const hasSkipOption = opts.options.some(
        (o) => o.label === "Skip" || o.label === "Cancel",
      );
      if (hasSkipOption) return inner.select(opts);

      const skipValue = SKIP_SENTINEL as unknown as T;
      const result = await inner.select({
        ...opts,
        options: [
          ...opts.options,
          { value: skipValue, label: "Skip", hint: "skip this section" },
        ],
      });
      if (result === skipValue) throw new SkipError();
      return result;
    },

    multiselect: async <T>(opts: MultiselectOpts<T>): Promise<T[]> => {
      const hasExitOption = opts.options.some(
        (o) => o.label === "Cancel" || o.label === "Skip",
      );
      if (hasExitOption) return inner.multiselect(opts);

      const skipValue = SKIP_SENTINEL as unknown as T;
      const result = await inner.multiselect({
        ...opts,
        options: [
          ...opts.options,
          { value: skipValue, label: "Skip (none)", hint: "skip this section" },
        ],
        required: false,
      });
      if (result.some((v) => v === skipValue)) throw new SkipError();
      return result;
    },

    text: async (opts: TextOpts): Promise<string> => {
      // Required fields pass through unchanged (no skip behavior)
      if (opts.required) return inner.text(opts);

      const result = await inner.text({
        ...opts,
        // Keep placeholder visible but strip defaultValue so empty Enter
        // actually returns "" instead of being replaced by @clack/core's
        // finalize handler (which substitutes defaultValue for falsy input).
        placeholder: opts.placeholder ?? opts.defaultValue,
        defaultValue: undefined,
        message: `${opts.message} (leave empty to skip)`,
        validate: (value: string) => {
          if (typeof value !== "string" || value === "") return undefined;
          return opts.validate?.(value);
        },
      });
      if (result === "") throw new SkipError();
      return result;
    },

    password: async (opts: PasswordOpts): Promise<string> => {
      const result = await inner.password({
        ...opts,
        message: `${opts.message} (leave empty to skip)`,
        validate: (value: string) => {
          if (typeof value !== "string" || value === "") return undefined;
          return opts.validate?.(value);
        },
      });
      if (result === "") throw new SkipError();
      return result;
    },
  };
}

// ---------- Flow Step Sequences ----------

/**
 * Ordered step sequences for each wizard flow.
 *
 * Each flow defines which steps run and in what order.
 * Steps not in a flow's sequence are skipped entirely.
 */
export const FLOW_STEPS: Record<FlowType, readonly WizardStepId[]> = {
  quickstart: [
    "welcome",
    "detect-existing",
    "flow-select",
    "provider",
    "credentials",
    "agent",
    "review",
    "write-config",
    "daemon-start",
    "finish",
  ],
  advanced: [
    "welcome",
    "detect-existing",
    "flow-select",
    "provider",
    "credentials",
    "agent",
    "channels",
    "gateway",
    "workspace",
    "tool-providers",
    "review",
    "write-config",
    "daemon-start",
    "finish",
  ],
  remote: [
    "welcome",
    "detect-existing",
    "flow-select",
    "gateway",
    "review",
    "write-config",
    "finish",
  ],
};

// ---------- State Dependencies ----------

/**
 * When a step is revisited via jump-to, these state fields
 * (produced by downstream steps) must be cleared.
 *
 * For example, changing provider invalidates credentials and model
 * selections. Changing flow-select affects which steps run and
 * which state fields are relevant.
 */
const STATE_DEPENDENCIES: Partial<
  Record<WizardStepId, readonly (keyof WizardState)[]>
> = {
  provider: ["provider", "model", "channels"],
  credentials: [],
  "flow-select": ["channels", "gateway", "dataDir"],
  agent: [],
  channels: [],
  gateway: [],
  workspace: [],
  "tool-providers": [],
};

// ---------- Core State Functions ----------

/**
 * Create a new WizardState by merging updates into current state.
 *
 * Returns a fresh object reference -- the original is never mutated.
 * TypeScript's `readonly` modifier provides compile-time safety;
 * runtime Object.freeze() is intentionally omitted for performance.
 */
export function updateState(
  current: WizardState,
  updates: Partial<WizardState>,
): WizardState {
  return { ...current, ...updates };
}

/**
 * Return new state with stepId appended to completedSteps.
 *
 * Idempotent: if stepId is already in completedSteps, returns
 * a new object with the same completedSteps array.
 */
export function markStepComplete(
  state: WizardState,
  stepId: WizardStepId,
): WizardState {
  if (state.completedSteps.includes(stepId)) {
    return { ...state };
  }
  return { ...state, completedSteps: [...state.completedSteps, stepId] };
}

/**
 * Jump to a target step for review edits.
 *
 * Clears all state fields produced by steps AFTER the target step
 * in the flow sequence (using STATE_DEPENDENCIES), and removes
 * those steps from completedSteps.
 *
 * After jump-to, the wizard resumes from the target step with
 * downstream state wiped so the user re-enters those values.
 */
export function jumpToStep(
  state: WizardState,
  targetStepId: WizardStepId,
  flow: FlowType,
): WizardState {
  const steps = FLOW_STEPS[flow];
  const targetIndex = steps.indexOf(targetStepId);

  if (targetIndex === -1) {
    // Target step not in this flow -- return unchanged state
    return { ...state };
  }

  // Collect all state fields that need clearing from steps after the target
  const fieldsToClear = new Set<keyof WizardState>();
  const stepsToRemove = new Set<WizardStepId>();

  for (let i = targetIndex; i < steps.length; i++) {
    const stepId = steps[i];
    stepsToRemove.add(stepId);

    const deps = STATE_DEPENDENCIES[stepId];
    if (deps) {
      for (const field of deps) {
        fieldsToClear.add(field);
      }
    }
  }

  // Build the cleared state
  const cleared: Record<string, unknown> = { ...state };
  for (const field of fieldsToClear) {
    cleared[field] = undefined;
  }

  // Remove downstream steps from completedSteps
  cleared["completedSteps"] = state.completedSteps.filter(
    (s) => !stepsToRemove.has(s),
  );

  return cleared as WizardState;
}

/**
 * Get the next incomplete step in the flow sequence.
 *
 * Returns the first step ID that is not in completedSteps,
 * or null if all steps are complete.
 */
export function getNextStep(
  state: WizardState,
  flow: FlowType,
): WizardStepId | null {
  const steps = FLOW_STEPS[flow];
  for (const stepId of steps) {
    if (!state.completedSteps.includes(stepId)) {
      return stepId;
    }
  }
  return null;
}

/**
 * Get the index of a step in a flow's step sequence.
 *
 * Returns -1 if the step is not in the given flow.
 */
export function getStepIndex(
  stepId: WizardStepId,
  flow: FlowType,
): number {
  return FLOW_STEPS[flow].indexOf(stepId);
}

/**
 * Check if a step has been completed.
 */
export function isStepComplete(
  state: WizardState,
  stepId: WizardStepId,
): boolean {
  return state.completedSteps.includes(stepId);
}

/**
 * Get progress info for the current flow.
 *
 * Returns completed count and total step count for the flow.
 */
export function getCompletedStepCount(
  state: WizardState,
  flow: FlowType,
): { completed: number; total: number } {
  const steps = FLOW_STEPS[flow];
  const completed = steps.filter((s) =>
    state.completedSteps.includes(s),
  ).length;
  return { completed, total: steps.length };
}

// ---------- State Machine Runner ----------

/** Registry mapping step IDs to their implementations. */
export type StepRegistry = Map<WizardStepId, WizardStep>;

/**
 * Steps where skip injection is suppressed.
 *
 * These steps are either mandatory for the wizard to function
 * (flow-select, welcome, write-config) or purely informational
 * (review, finish) where skip adds no value.
 */
export const NON_SKIPPABLE_STEPS: ReadonlySet<WizardStepId> = new Set([
  "welcome",
  "flow-select",
  "provider",
  "credentials",
  "channels",
  "gateway",
  "tool-providers",
  "review",
  "write-config",
  "daemon-start",
  "finish",
]);

/**
 * Main wizard execution loop.
 *
 * Runs steps in sequence for the given flow, handles cancellation,
 * and processes _jumpTo signals from step return values.
 *
 * 1. Start with initialState or INITIAL_STATE
 * 2. Get the flow's step sequence from FLOW_STEPS
 * 3. Loop: get next incomplete step, look it up in registry,
 *    call step.execute(), get new state, mark step complete
 * 4. If step throws SkipError: mark step complete, keep state unchanged
 * 5. If step throws CancelError: single escape goes back one step,
 *    double escape (within 800ms) or escape at first step exits
 * 6. If returned state has _jumpTo: clear dependent state via
 *    jumpToStep(), strip _jumpTo, continue loop from target
 * 7. Return final state when all steps complete
 */
export async function runWizardFlow(
  flow: FlowType,
  prompter: WizardPrompter,
  steps: StepRegistry,
  initialState?: WizardState,
): Promise<WizardState> {
  let state: WizardState = initialState ?? INITIAL_STATE;
  let lastCancelTime = 0;
  const cancelPrompter = wrapWithCancel(prompter);
  const skippablePrompter = wrapWithSkip(cancelPrompter);

  /** Prompt for exit confirmation. Returns true to exit, false to stay. */
  const confirmExit = async (): Promise<boolean> => {
    try {
      return await prompter.confirm({
        message: "Are you sure you want to exit?",
        initialValue: false,
      });
    } catch (e) {
      // Escape on the confirmation itself → user insists on leaving
      if (e instanceof CancelError) return true;
      throw e;
    }
  };

  for (;;) {
    const nextStepId = getNextStep(state, flow);

    // All steps complete
    if (nextStepId === null) {
      return state;
    }

    const step = steps.get(nextStepId);
    if (!step) {
      // Step not registered -- skip it (allows partial step registries
      // during development or for flows that skip optional steps)
      state = markStepComplete(state, nextStepId);
      continue;
    }

    let newState: WizardState;
    try {
      const stepPrompter = NON_SKIPPABLE_STEPS.has(nextStepId)
        ? cancelPrompter
        : skippablePrompter;
      newState = await step.execute(state, stepPrompter);
    } catch (err) {
      if (err instanceof SkipError) {
        prompter.log.info(`Skipped: ${step.label}`);
        state = markStepComplete(state, nextStepId);
        continue;
      }
      if (err instanceof CancelError) {
        // Explicit cancel (user selected "Cancel" option) → confirm before exit
        if (err.explicit) {
          if (await confirmExit()) return state;
          continue;
        }

        const now = Date.now();

        // Double escape (rapid succession) → confirm before exit
        if (now - lastCancelTime < DOUBLE_ESCAPE_MS) {
          if (await confirmExit()) return state;
          lastCancelTime = 0;
          continue;
        }

        // Single escape → go back one step.
        // Find the immediately preceding completed step and re-run it.
        const flowSteps = FLOW_STEPS[flow];
        const currentIndex = flowSteps.indexOf(nextStepId);
        let prevStepId: WizardStepId | null = null;

        for (let i = currentIndex - 1; i >= 0; i--) {
          if (state.completedSteps.includes(flowSteps[i])) {
            prevStepId = flowSteps[i];
            break;
          }
        }

        // At first step (nothing to go back to) → exit wizard
        if (prevStepId === null) {
          return state;
        }

        // Go back: remove both the previous step AND the current step
        // from completedSteps so getNextStep resumes at the previous step.
        // This ensures we go back exactly one step (not two).
        state = {
          ...state,
          completedSteps: state.completedSteps.filter(
            (s) => s !== prevStepId && s !== nextStepId,
          ),
        };

        const prevStep = steps.get(prevStepId);
        const label = prevStep?.label ?? prevStepId;
        prompter.log.info(`Going back to: ${label}`);

        lastCancelTime = now;
        continue;
      }
      throw err;
    }

    // Check for jump-to signal
    if (newState._jumpTo) {
      const jumpTarget = newState._jumpTo;

      // Strip the transient _jumpTo field
      const { _jumpTo: _, ...stateWithoutJump } = newState;
      const cleanState = stateWithoutJump as WizardState;

      // Clear dependent downstream state and completedSteps
      state = jumpToStep(cleanState, jumpTarget, flow);
      continue;
    }

    // Mark step complete and continue
    state = markStepComplete(newState, nextStepId);
  }
}
