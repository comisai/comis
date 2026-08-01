// SPDX-License-Identifier: Apache-2.0
/** Operator guidance for a locale repair that did not converge. */

export function unrepairedMismatchHint(source: string): string {
  return source === "request"
    ? "The enforced locale was INFERRED from this request (localeSource=request), not pinned by an operator. "
      + "The model answered in a different script on every attempt, which usually means the conversation's "
      + "established language differs from this one message's. Pin the intended language with the agent's "
      + "explicit response-locale setting if the inferred target is wrong; a persistent mismatch here costs "
      + "an extra model call and breaks the prompt cache each turn."
    : "The enforced locale is an OPERATOR PIN (localeSource=explicit) and the model did not honour it. "
      + "Verify the pin is the language you intend, then inspect the selected model's locale fidelity.";
}
