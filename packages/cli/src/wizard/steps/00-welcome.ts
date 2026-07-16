// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).
/**
 * Welcome step -- step 00 of the init wizard.
 *
 * Always runs first in every flow. Displays the branded Comis
 * intro banner, presents a security notice explaining agent
 * capabilities, and requires explicit user acknowledgement before
 * proceeding. Declining exits cleanly with no partial state.
 *
 * @module
 */

import type { WizardState, WizardStep } from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { CancelError } from "../prompter.js";
import { updateState } from "../state.js";
import { heading } from "../theme.js";

// ---------- Security Notice ----------

const SECURITY_NOTICE = `Comis agents can execute tools, read files, and interact
with external services on your behalf. A bad prompt can
trick an agent into doing unsafe things.

Trust model
By default, Comis is a personal agent — one trusted operator
boundary. If multiple users can message one tool-enabled
agent, they share that delegated authority. That is a
different trust mode and requires explicit lock-down.

Recommended baseline
- Keep channel allowMode: "allowlist" (shipped default —
  default-deny; do not switch to "open" without review).
- Keep session.dmScopeMode: "per-channel-peer" (default) to
  isolate DM sessions between users.
- Run agents with least-privilege tools and the exec sandbox
  enabled.
- Keep secrets (bot tokens, API keys) outside the agent's
  reachable filesystem.
- Use a strong model for any agent with tools or untrusted
  inboxes.

Run regularly
  comis security audit
  comis security audit --fix

You are responsible for reviewing agent actions and
configuring appropriate safety guardrails.

Learn more: https://docs.comis.ai/security`;

// ---------- Step Implementation ----------

export const welcomeStep: WizardStep = {
  id: "welcome",
  label: "Welcome & Security",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    // Branded intro banner
    prompter.intro(heading("Comis Agent Setup"));

    // Welcome message
    prompter.note(
      "Welcome! This wizard will set up a Comis agent that can learn and act across sessions.",
    );

    // Security notice
    prompter.note(SECURITY_NOTICE, "Security Notice");

    // Risk acknowledgement -- must explicitly accept
    const accepted = await prompter.confirm({
      message:
        "I understand Comis is personal-by-default; shared or multi-user use requires lock-down. Continue?",
      initialValue: false,
    });

    if (!accepted) {
      prompter.outro("Setup cancelled. You can re-run 'comis init' when ready.");
      throw new CancelError();
    }

    return updateState(state, { riskAccepted: true });
  },
};
