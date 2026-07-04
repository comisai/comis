// SPDX-License-Identifier: Apache-2.0
// @allow-throw: execute() delegates the jailed run to runJailedScript, whose
// honest-degrade (throwToolError "not_implemented") and failed-child rejection
// propagate through this await — both are caught by the AgentTool execution
// boundary (agent-loop) and surfaced as a tool error.
/**
 * `orchestrate-tool` — the `orchestrate` runner. The
 * headline autonomy primitive: the model writes ONE script that chains
 * capability-scoped typed tools (the committed `comis_tools` SDK) in a jailed
 * child, and only size-bounded stdout re-enters context — a search→fetch→
 * synthesize chain in one inference turn, with intermediate results riding
 * ResultRefs (queried in-jail) rather than the transcript.
 *
 * The jailed-run CORE (the cap-socket bwrap jail, the SDK copy, the env-scrub,
 * the spawn, and the run lifecycle) lives in {@link runJailedScript}
 * (`jailed-script-runner`), the shared substrate. This tool owns only the
 * AgentTool shaping around it: the parameter schema, the per-run id, the
 * operator-facing completion INFO (`runId` + `durationMs`), and the stdout
 * size-bounce (only bounded stdout re-enters context).
 *
 * @module
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { registerActivityLabelSpec, systemNowMs } from "@comis/core";
import { createToolResultSizeGuard } from "@comis/agent";

import { runJailedScript, type JailedScriptRunnerDeps } from "./jailed-script-runner.js";

// Activity label (channel render): the descriptor name equals the emitted tool
// name (`"orchestrate"`). A static fallback so the render is not the bare
// humanized form while the script runs.
registerActivityLabelSpec("orchestrate", {
  semanticPhase: "tool",
  label: "running an orchestrate script",
});

// ---------------------------------------------------------------------------
// Parameter schema.
// ---------------------------------------------------------------------------

const OrchestrateParams = Type.Object({
  script: Type.String({
    description:
      "The script body to run in the jailed child. It may `import { comis_tools } from \"./comis_tools.js\"` and chain the capability-scoped tools; only what it console.logs (stdout) re-enters context.",
  }),
  language: Type.Union([Type.Literal("ts"), Type.Literal("js")], {
    description: 'The script language: "ts" or "js".',
  }),
  timeoutMs: Type.Optional(
    Type.Integer({ description: "Hard wall-clock timeout for the jailed run (ms). Default 60000." }),
  ),
  captureStdout: Type.Optional(
    Type.Boolean({ description: "Reserved — stdout is always the (only) captured channel." }),
  ),
});

type OrchestrateParamsType = {
  script: string;
  language: "ts" | "js";
  timeoutMs?: number;
  captureStdout?: boolean;
};

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/** Max stdout characters that re-enter context — the rest is size-bounced. */
const STDOUT_MAX_CHARS = 30_000;

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

/**
 * Create the `orchestrate` AgentTool. See the module doc for the
 * composition + the containment guarantees.
 *
 * @param deps - The injected collaborators (workspace, cap socket, sandbox,
 *   store, and the test seams).
 * @returns The `orchestrate` AgentTool.
 */
export function createOrchestrateTool(deps: JailedScriptRunnerDeps): AgentTool<typeof OrchestrateParams> {
  const log = deps.logger.child({ submodule: "orchestrate-tool" });
  const now = deps.now ?? systemNowMs;

  return {
    name: "orchestrate",
    label: "Orchestrate",
    description:
      "Run a script that chains capability-scoped tools (the comis_tools SDK) in a single jailed child, returning only its stdout. Use to collapse a multi-tool read/fetch/synthesize chain into one turn; intermediate high-volume results stay on disk as ResultRefs (sliced in-jail), never in context.",
    parameters: OrchestrateParams,

    async execute(
      _toolCallId: string,
      params: OrchestrateParamsType,
    ): Promise<AgentToolResult<unknown>> {
      const startedMs = now();
      const runId = `orch-${startedMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      // The shared jailed-run core drives the whole run and returns the RAW
      // stdout. The SAME runId threads through it (the script filename, the store
      // GC/cleanup, the internal logs) AND this tool's completion INFO / details.
      const stdout = await runJailedScript(deps, {
        script: params.script,
        language: params.language,
        timeoutMs: params.timeoutMs,
        runId,
      });

      // Only size-bounded stdout re-enters context (the run-specific shaping).
      const bounced = sizeBounceStdout(stdout);
      log.info(
        { runId, step: "complete", durationMs: now() - startedMs, stdoutBytes: stdout.length },
        "orchestrate run complete",
      );
      return { content: bounced, details: { runId, stdoutBytes: stdout.length } };
    },
  };
}

// ---------------------------------------------------------------------------
// Internals — the AgentTool-specific stdout shaping.
// ---------------------------------------------------------------------------

/** A text content block (the only shape the runner returns — stdout-only). */
interface TextBlock {
  type: "text";
  text: string;
}

/** Size-bounce the raw stdout into bounded text content. */
function sizeBounceStdout(stdout: string): TextBlock[] {
  const guard = createToolResultSizeGuard();
  const result = guard.truncateIfNeeded(
    [{ type: "text", text: stdout }],
    STDOUT_MAX_CHARS,
    "orchestrate stdout",
  );
  // The guard preserves the {type:"text", text} shape; map to the narrow block.
  return result.content.map((b) => ({ type: "text" as const, text: b.text ?? "" }));
}
