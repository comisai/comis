// SPDX-License-Identifier: Apache-2.0
/**
 * `ctx_expand` — recover the underlying messages of a compressed summary region
 * of THIS conversation, via the injected `ContextStorePort`.
 *
 * Walk + reconstruct + taint + budget-cap (the read-tool + exec-externalization
 * blueprint):
 *   1. SCOPE: conversation derived per-call from `tryGetContext().sessionKey`
 *      (fail-closed `permission_denied` with no live session) — never cached,
 *      never a caller-supplied id (E2 isolation).
 *   2. WALK: `getSummaryMessages(summaryId)` → message ids; re-join via the
 *      existing `getMessages` (id-keyed map). A drifted (missing) id is SKIPPED,
 *      never thrown — the result reports an `unrecoverable` count so the model
 *      knows coverage is partial (mirrors the assembler's per-row drift skip).
 *   3. BUDGET + SPILL: when the recovered body exceeds `maxExpandTokens`, the
 *      detail is `scrubSecretsFromText`-scrubbed (the externalized file is the
 *      broadest egress surface — defense-in-depth) and written to the session
 *      `tool-results/` dir via `safePath` (filename = the toolCallId, NOT agent
 *      text); the tool returns a compact file-handle reference instead of
 *      inlining the body. Small output is inlined, taint-wrapped.
 *   4. TAINT: inline recovered content is wrapped via
 *      `wrapExternalContent({ source: "unknown" })` (prompt-injection surface).
 *   5. OBSERVABILITY: ids/counts/durationMs/step ONLY — never the recovered body.
 *
 * @module
 */

import { mkdirSync, writeFileSync } from "node:fs";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { wrapExternalContent, scrubSecretsFromText, safePath, type LcdMessage } from "@comis/core";

import { jsonResult, readStringParam } from "../../../platform-tools/tool-helpers.js";
import { estimateTokens, renderMessageText, requireCtxScope, type ContextToolDeps } from "./context-tools-shared.js";

const CtxExpandParams = Type.Object({
  summaryId: Type.String({ description: "The summaryId (from ctx_search / ctx_inspect) whose covered messages to recover." }),
});

/** Join recovered message text blocks for the externalized/inline body. */
const BODY_SEPARATOR = "\n---\n";

/**
 * Create the `ctx_expand` tool — recover a compressed region's underlying
 * detail, bounded by `maxExpandTokens`, for THIS conversation only.
 */
export function createCtxExpandTool(deps: ContextToolDeps): AgentTool<typeof CtxExpandParams> {
  return {
    name: "ctx_expand",
    label: "Context Expand",
    description:
      "Recover the underlying messages of a compressed summary region of THIS conversation (zoom into a " +
      "<summary>). Large recovered regions are written to a file you can read with the file tools; small " +
      "ones are returned inline. Distinct from cross-session recall.",
    parameters: CtxExpandParams,

    async execute(toolCallId: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
      // (1) SCOPE — build the (conversation, agent, tenant) read scope from the
      //     LIVE context per-call (R4 / WR-02); fail closed without a fully-scoped
      //     session. NEVER a wiring closure (multi-agent-safe, Pitfall 4).
      const ctxScope = requireCtxScope();
      const conversationId = ctxScope.conversationId;
      const summaryId = readStringParam(params, "summaryId", true)!;
      const t0 = deps.nowMs();

      // (2) WALK + RECONSTRUCT — id-keyed map; skip a drifted id, never throw.
      //     Agent-scoped reads (R4) — a different agent's covered ids / messages
      //     are unreachable within a shared conversation (WR-02).
      const messageIds = deps.store.getSummaryMessages(ctxScope, summaryId);
      const byId = new Map<string, LcdMessage>(
        deps.store.getMessages(ctxScope).map((r) => [r.id, r]),
      );
      const parts: string[] = [];
      let unrecoverable = 0;
      for (const id of messageIds) {
        const row = byId.get(id);
        if (!row) {
          unrecoverable++;
          continue;
        }
        parts.push(renderMessageText(row));
      }
      const rawBody = parts.join(BODY_SEPARATOR);

      // (3) BUDGET + SPILL — oversized regions go to a secret-scrubbed file handle.
      const dir = deps.getToolResultsDir();
      const oversized = estimateTokens(rawBody) > deps.maxExpandTokens;
      if (oversized && dir) {
        const scrubbed = scrubSecretsFromText(rawBody).text; // defense-in-depth on the broadest egress surface
        mkdirSync(dir, { recursive: true });
        const persistPath = safePath(dir, `ctx-expand-${toolCallId}.txt`); // toolCallId, NOT agent text
        writeFileSync(persistPath, scrubbed, "utf-8");
        deps.logger.debug(
          {
            toolName: "ctx_expand",
            conversationId,
            summaryId,
            recoveredCount: parts.length,
            unrecoverable,
            spilled: true,
            durationMs: deps.nowMs() - t0,
            step: "ctx_expand",
          },
          "ctx_expand spilled",
        );
        return jsonResult({
          fullOutputPath: persistPath,
          unrecoverable,
          note: `[Expanded region saved to: ${persistPath} — read it with the file tools if you need the full detail.]`,
        });
      }

      // (4) INLINE — taint-wrap the recovered body before it leaves the tool.
      const body = wrapExternalContent(rawBody, { source: "unknown" });
      deps.logger.debug(
        {
          toolName: "ctx_expand",
          conversationId,
          summaryId,
          recoveredCount: parts.length,
          unrecoverable,
          spilled: false,
          durationMs: deps.nowMs() - t0,
          step: "ctx_expand",
        },
        "ctx_expand complete",
      );
      return jsonResult({ body, unrecoverable });
    },
  };
}
