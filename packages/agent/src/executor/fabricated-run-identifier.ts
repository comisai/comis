// SPDX-License-Identifier: Apache-2.0
/**
 * Fabricated run-identifier detection.
 *
 * A reply may hand the requester a tracking identifier for background work —
 * "dispatched, Run ID: <id>". That is a checkable claim: an identifier can only
 * be known if the execution obtained it, from a spawn receipt or a lookup. Both
 * are tool calls. So an execution that ran NO tool at all cannot have obtained
 * any identifier, new or historical, and one appearing in its reply was
 * invented.
 *
 * The zero-tool condition is what makes this safe to enforce. A reply quoting a
 * run started on an earlier turn is legitimate, and any execution that ran even
 * one tool may have looked one up — so this guard defers in both cases and
 * leaves them to the spawn-evidence guard, which reasons about receipts.
 *
 * The check is deliberately language-neutral. The natural-language phrase lists
 * in the sibling evidence guards only cover the language they enumerate, and a
 * runtime cannot carry a fixed human language; an identifier label and an
 * identifier-shaped value are machine syntax and read the same in every locale.
 *
 * @module
 */

/**
 * Run-identifier label immediately followed by an identifier-shaped value.
 *
 * Both halves are required. A bare identifier may reference anything (a trace,
 * a session, a document) and prose about identifiers in general asserts no
 * specific run, so either half alone is not a dispatch claim. Inline markup and
 * quoting are allowed between the two, which is how a formatted reply renders.
 */
const RUN_IDENTIFIER_CLAIM =
  /\brun[\s_-]?id\b\s*[:=]?\s*(?:<[^>]{1,40}>|["'`*]){0,4}\s*([0-9a-z][0-9a-z_-]{7,})/i;

/**
 * Report whether a reply asserts a run identifier the execution cannot have.
 *
 * @param params.response - The reply text about to be delivered
 * @param params.toolCallCount - Tool calls performed by this execution
 * @returns True when an identifier is asserted by a zero-tool execution
 */
export function assertsUnbackedRunIdentifier(params: {
  response: string;
  toolCallCount: number;
}): boolean {
  if (params.toolCallCount > 0) return false;
  return RUN_IDENTIFIER_CLAIM.test(params.response);
}
