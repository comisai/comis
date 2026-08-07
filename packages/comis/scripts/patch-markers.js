// SPDX-License-Identifier: Apache-2.0
/**
 * Proof-of-application markers for the patched provider dependency.
 *
 * pnpm applies `patchedDependencies` at install time. When the pin drifts out
 * of sync with the installed version the patch quietly does not apply, so the
 * pack step verifies the result rather than trusting the config.
 *
 * One marker per patched FILE, not a single sentinel for the whole patch. A
 * patch that loses a hunk while being rebased onto a new upstream version
 * still applies cleanly, so a single check cannot tell "applied" from "applied
 * in part" — which is exactly how this drifted: the marker pointed at a hunk
 * that a version rebase had legitimately dropped, and the pack failed claiming
 * the patch was missing while the surviving hunks were present all along.
 *
 * `test/architecture/pi-patch-markers.test.ts` holds the list to the patch:
 * every file the patch touches needs an entry here, so the next rebase that
 * adds or removes a hunk has to update this table too.
 *
 * @module
 */

/** Files the patch modifies, each with a string only the patch introduces. */
export const PATCH_MARKERS = [
  {
    file: ["dist", "api", "anthropic-messages.js"],
    marker: "rejects thinking budgets below 1024",
    describes: "thinking-budget clamp (skip thinking rather than send a doomed request)",
  },
  {
    file: ["dist", "api", "bedrock-converse-stream.js"],
    marker: "rejects thinking budgets below 1024",
    describes: "thinking-budget clamp (skip thinking rather than send a doomed request)",
  },
];

/**
 * Behaviour upstream absorbed from a patch we used to carry.
 *
 * The former `isNonEmptyJsonBody` hunk stopped an SDK error whose
 * `$response.body` is a class instance (AWS SDK v3 wraps the HTTP response)
 * from being stringified into the display string, where it REPLACED the real
 * deserialized message. Upstream now does the same prototype check under the
 * name `isPlainNonEmptyObject`, so the patch is correctly gone.
 *
 * Checked as a WARNING, never a hard failure: this is upstream's private
 * helper, and blocking a release because they renamed it would be a false
 * positive on the publish path. The signal still matters — if the protection
 * disappears, provider errors degrade to byte-array noise and we want to know
 * before shipping, not from a confusing incident report.
 */
export const UPSTREAM_ABSORBED_MARKERS = [
  {
    file: ["dist", "utils", "error-body.js"],
    marker: "function isPlainNonEmptyObject",
    describes: "plain-object body check that keeps a class instance from replacing error.message",
  },
];
