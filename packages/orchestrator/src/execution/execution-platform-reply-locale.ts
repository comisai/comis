// SPDX-License-Identifier: Apache-2.0
/**
 * The accessor shape for an agent's deterministic-platform-reply locale.
 *
 * A LEAF with no imports, deliberately. `ExecutionPipelineDeps` (the deps owner)
 * and `execution-execute.ts` (the consumer, which already imports the deps type
 * from the pipeline) both need this shape, so declaring it in either one puts a
 * back-edge between them — a real `.d.ts` cycle the `cycles` gate rejects.
 *
 * Structural on purpose: this layer sends the pipeline-timeout reply but must
 * not depend on the config package to describe where its strings come from.
 *
 * @module
 */

/**
 * An agent's response-locale pin plus the operator-supplied strings for the
 * deterministic platform replies (locale tag → message id → text). Both
 * optional: with neither, those replies use the runtime's English pack.
 */
export interface PlatformReplyLocale {
  readonly language?: string;
  readonly localePacks?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
