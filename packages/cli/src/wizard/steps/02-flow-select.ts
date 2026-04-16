/**
 * Flow selection step -- step 02 of the init wizard.
 *
 * Presents three flow choices that determine the subsequent step
 * sequence via FLOW_STEPS in the state machine:
 *
 * - **QuickStart** -- 3 questions, sensible defaults, configure later
 * - **Advanced** -- full control over gateway, channels, models, network
 * - **Remote Only** -- connect to an existing Comis gateway
 *
 * @module
 */

import type {
  WizardState,
  WizardStep,
  WizardPrompter,
  FlowType,
} from "../index.js";
import { updateState } from "../index.js";

// ---------- Step Implementation ----------

export const flowSelectStep: WizardStep = {
  id: "flow-select",
  label: "Setup Mode",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    const selectedFlow = await prompter.select<FlowType>({
      message: "How would you like to set up?",
      options: [
        {
          value: "quickstart" as FlowType,
          label: "QuickStart (Recommended)",
          hint: "3 questions, sensible defaults, configure details later",
        },
        {
          value: "advanced" as FlowType,
          label: "Advanced",
          hint: "Full control over gateway, channels, models, and network",
        },
        {
          value: "remote" as FlowType,
          label: "Remote Only",
          hint: "Connect to an existing Comis gateway on another machine",
        },
      ],
      initialValue: "quickstart" as FlowType,
    });

    return updateState(state, { flow: selectedFlow });
  },
};
