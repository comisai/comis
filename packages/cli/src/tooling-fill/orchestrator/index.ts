// SPDX-License-Identifier: Apache-2.0
/**
 * tooling-fill orchestrator.
 *
 * Thin orchestrator + barrel: composes discover → fill → verify pipeline
 * stages and re-exports the canonical public surface
 * (runToolingFill + PromptIO/OrchestratorOpts/OrchestratorResult types).
 *
 * Pipeline data flow:
 *   discoverTools(opts) → { doc, rawYaml, configJs, entries }
 *   fillTools(opts, configJs, entries) → { supervisor, filled, skipped, diffString }
 *   verifyFill(opts, rawYaml, doc, supervisor, filled, skipped, diffString) → OrchestratorResult
 *
 * Dependency direction: the 3 leaves import from `./orchestrator-types.js`;
 * none of them imports from this barrel. The barrel is the only file that
 * imports from all three.
 *
 * @module
 */
export type {
  OrchestratorOpts,
  OrchestratorResult,
  PromptIO,
} from "./orchestrator-types.js";

import type {
  OrchestratorOpts,
  OrchestratorResult,
} from "./orchestrator-types.js";
import { discoverTools } from "./orchestrator-discover.js";
import { fillTools } from "./orchestrator-fill.js";
import { verifyFill } from "./orchestrator-verify.js";

/**
 * Top-level entry. Always resolves a `{exitCode, summary}` — never throws
 * Always resolves — never throws (orchestrator catches Result errors internally).
 */
export async function runToolingFill(
  opts: OrchestratorOpts,
): Promise<OrchestratorResult> {
  const discovered = discoverTools(opts);
  if (discovered.kind === "bail") return discovered.result;

  const { doc, rawYaml, configJs, entries } = discovered;
  const filledOutcome = await fillTools(opts, configJs, entries);
  if (filledOutcome.kind === "bail") return filledOutcome.result;

  const { supervisor, filled, skipped, diffString } = filledOutcome;
  return verifyFill(
    opts,
    rawYaml,
    doc,
    supervisor,
    filled,
    skipped,
    diffString,
  );
}
