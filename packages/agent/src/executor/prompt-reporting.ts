// SPDX-License-Identifier: Apache-2.0
import { formatSessionKey, tryGetContext } from "@comis/core";
import {
  buildSystemPromptReport,
  persistSystemPromptReport,
  type BootstrapFileForReport,
  type ResolvedToolForReport,
} from "@comis/observability";
import type { BootstrapContextFile } from "../bootstrap/types.js";
import type { BootstrapFile } from "../bootstrap/index.js";
import type { PromptAssemblyParams } from "./prompt-assembly-shared.js";

export interface PromptReportInput {
  readonly params: PromptAssemblyParams;
  readonly systemPrompt: string;
  readonly bootstrapMaxChars: number;
  readonly bootstrapFilesForReport: readonly BootstrapFile[];
  readonly bootstrapContextFiles: readonly BootstrapContextFile[];
  readonly inlineMemory: string | undefined;
  readonly memorySections: readonly string[];
  readonly retrievedRagHits: number;
  readonly retrievedSectionsChars: number;
}

export async function persistPromptReport(input: PromptReportInput): Promise<void> {
  const {
    params,
    systemPrompt,
    bootstrapMaxChars,
    bootstrapFilesForReport,
    bootstrapContextFiles,
    inlineMemory,
    memorySections,
    retrievedRagHits,
    retrievedSectionsChars,
  } = input;
  const { config, deps, sessionKey, agentId, mergedCustomTools, logger } = params;
  // Build + persist SystemPromptReport.
  // Hook site: after assembleRichSystemPrompt + assembleRichSystemPromptBlocks
  // and after the before_agent_start hook applies any prompt modification —
  // the report captures the FINAL system prompt that flows to the model
  // (cache-stable portion). Dynamic preamble is built downstream and is
  // intentionally not part of the report (it's per-turn diagnostic, not
  // a system-prompt artifact).
  //
  // Best-effort: any failure in build/persist is swallowed via try/catch
  // so it never aborts assembly. Persistence is already best-effort
  // internally (Result.err is logged), but the caller is non-throwing.
  if (deps.observabilityStore !== undefined || deps.sessionStore !== undefined) {
    try {
      const reportBootstrapFiles: BootstrapFileForReport[] = bootstrapFilesForReport.map((f) => {
        const rawContent = f.content;
        const rawChars = rawContent !== undefined ? rawContent.length : 0;
        // The bootstrap context file built from this raw file has a
        // matching path; truncation may have shortened it.
        const ctxFile = bootstrapContextFiles.find((c) => c.path === f.name);
        // `content` for missing files is the "[MISSING] Expected at: ..." marker
        // — that's a synthetic content, not what was on disk. For the
        // report's `injectedChars` we want the actual character count
        // injected into the prompt, including any [MISSING] marker.
        const injectedChars = ctxFile ? ctxFile.content.length : 0;
        return {
          name: f.name,
          missing: f.missing,
          rawChars,
          injectedChars,
          // Only include rawContent for sha256 when the file actually
          // existed; missing files have no content to hash.
          rawContent: f.missing ? undefined : rawContent,
        };
      });

      const reportTools: ResolvedToolForReport[] = mergedCustomTools.map((t) => ({
        name: t.name,
        // pi-coding-agent ToolDefinition uses `parameters` for the JSON
        // schema (see buildBootstrapContextFiles caller / executor-tool-
        // assembly.ts:367-369).
        schema: t.parameters as object | undefined,
      }));

      const report = buildSystemPromptReport({
        source: deps.isFirstMessageInSession ? "session-create" : "run",
        generatedAt: deps.clock.now(),
        agentId: agentId ?? config.name,
        sessionId: formatSessionKey(sessionKey),
        context: {
          traceId: tryGetContext()?.traceId,
          tenantId: deps.tenantId,
          sessionKey: formatSessionKey(sessionKey),
          runId: deps.runId,
          provider: params.resolvedModelProvider ?? config.provider,
          model: params.resolvedModelId ?? config.model,
          workspaceDir: deps.workspaceDir,
        },
        systemPrompt,
        bootstrapMaxChars,
        bootstrapFiles: reportBootstrapFiles,
        tools: reportTools,
        policyFilteredToolNames: deps.policyFilteredToolNames,
        // memoryInjection reflects RETRIEVED memory only (inline + retrieved
        // sections). The predicate gates on injected content (memorySections
        // includes the temporal-guidance block); the COUNTS use the retrieved-only
        // accumulators so they never tally the fixed guidance text. The
        // `?? 0` on inlineMemory.length is load-bearing for the sections-only
        // branch (the outer predicate can be true with inlineMemory undefined).
        memoryInjection: (inlineMemory !== undefined || memorySections.length > 0)
          ? {
              ragHits: retrievedRagHits,
              charsInjected: (inlineMemory?.length ?? 0) + retrievedSectionsChars,
              trustTags: [],
            }
          : undefined,
      });

      const persistResult = await persistSystemPromptReport(report, {
        observabilityStore: deps.observabilityStore,
        sessionStore: deps.sessionStore,
        logger,
      });
      if (!persistResult.ok) {
        // The persist function already logged via the injected logger;
        // we only log a DEBUG-level summary here for cross-correlation.
        logger.debug(
          {
            agentId: agentId ?? config.name,
            sessionKey: formatSessionKey(sessionKey),
            errorKind: "dependency" as const,
            hint: "SystemPromptReport persistence had partial failure; see prior warn lines",
          },
          "SystemPromptReport persist returned err",
        );
      }
    } catch (err) {
      // Never abort assembly because of the report. Same best-effort
      // pattern as memory:injected emit above; same risk profile.
      logger.debug(
        {
          err,
          hint: "SystemPromptReport build/persist threw; assembly continues",
          errorKind: "internal" as const,
        },
        "SystemPromptReport build/persist failed (non-fatal)",
      );
    }
  }
}
