// SPDX-License-Identifier: Apache-2.0
/**
 * Command directive handlers for PiExecutor.
 *
 * Extracted from pi-executor.ts execute() to isolate command directive
 * processing (thinking level, compact, model switch, model cycle,
 * export, fork, branch) into a focused module. Each directive is a
 * self-contained try/catch block.
 *
 * Consumers:
 * - pi-executor.ts: calls applyCommandDirectives() during execute()
 *
 * @module
 */

import {
  safePath,
  type SessionKey,
} from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/infra";
import type { CommandDirectives } from "../commands/types.js";
import { normalizeModelId } from "../provider/model-id-normalize.js";
import type { ExecutionResult } from "./types.js";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of PiExecutorDeps used by command handlers. */
export interface CommandHandlerDeps {
  logger: ComisLogger;
  eventBus: import("@comis/core").TypedEventBus;
  modelRegistry: import("@mariozechner/pi-coding-agent").ModelRegistry;
  workspaceDir: string;
}

/**
 * Minimal session interface for command handlers.
 * Typed structurally to avoid importing the full AgentSession type.
 */
export interface CommandSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK internal API not typed
  setThinkingLevel?: (level: any) => void;
  compact(instructions?: string): Promise<{ tokensBefore: number }>;
  setModel(model: unknown): Promise<void>;
  cycleModel(direction: string): Promise<{ model?: { id?: string } } | undefined>;
  exportToHtml(outputPath?: string): Promise<string>;
  navigateTree(entryId: string): Promise<{ cancelled: boolean }>;
  getUserMessagesForForking(): Array<{ entryId: string; text: string }>;
}

/** Result of command directive application. */
export interface CommandDirectiveResult {
  /** Whether any command-only directive was applied (compact, model switch, etc.) */
  hasCommandDirective: boolean;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Apply command directives to a session.
 *
 * Handles: thinking level, compact, model switch, model cycle,
 * export, fork, branch. Each directive is a self-contained try/catch
 * block that mutates `result` (adding response text).
 *
 * @param params - Directives, session, result, and dependencies
 * @returns Whether any command-only directives were applied
 */
export async function applyCommandDirectives(params: {
  directives: CommandDirectives | undefined;
  session: CommandSession;
  result: ExecutionResult;
  config: { provider: string };
  deps: CommandHandlerDeps;
  sessionKey: SessionKey;
}): Promise<CommandDirectiveResult> {
  const { directives, session, result, config: _config, deps, sessionKey } = params;

  if (!directives) {
    return { hasCommandDirective: false };
  }

  let hasCommandDirective = false;

  // Apply thinking level via SDK's session.setThinkingLevel() for active session clamping.
  // This is in addition to overrides.defaultThinkingLevel (set above) which provides the
  // pre-session baseline via SettingsManager. session.setThinkingLevel() invokes SDK-native
  // clamping logic (clamps to model capabilities based on available thinking levels).
  if (directives.thinkingLevel) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK internal API not typed
      (session as any).setThinkingLevel(directives.thinkingLevel);
      deps.logger.debug(
        { thinkingLevel: directives.thinkingLevel },
        "Thinking level applied via SDK setThinkingLevel()",
      );
    } catch (thinkError) {
      deps.logger.warn(
        {
          err: thinkError,
          thinkingLevel: directives.thinkingLevel,
          hint: "session.setThinkingLevel() failed; falling back to SettingsManager override",
          errorKind: "config" as ErrorKind,
        },
        "setThinkingLevel failed",
      );
    }
  }

  // /compact delegates to SDK's compact() with custom instructions support
  if (directives.compact) {
    hasCommandDirective = true;
    const compactOpts = typeof directives.compact === "object"
      ? directives.compact
      : { verbose: false, instructions: undefined };
    try {
      const compactResult = await session.compact(compactOpts.instructions);
      deps.logger.info(
        { tokensBefore: compactResult.tokensBefore },
        "Manual compaction complete",
      );
      deps.eventBus.emit("compaction:flush", {
        sessionKey,
        memoriesWritten: 0,
        trigger: "manual" as const,
        success: true,
        timestamp: Date.now(),
      });
    } catch (compactError) {
      deps.logger.warn(
        {
          err: compactError,
          hint: "Manual compaction failed; session remains intact",
          errorKind: "internal" as const,
        },
        "Manual compaction error",
      );
    }
  }

  // /model <name> delegates to SDK's session.setModel() for immediate validation
  if (directives.modelSwitch) {
    hasCommandDirective = true;
    const { provider, modelId } = directives.modelSwitch;
    // Normalize switch model ID before registry lookup
    const normalizedSwitch = normalizeModelId(provider, modelId);
    const switchModel = deps.modelRegistry.find(provider, normalizedSwitch.modelId);
    if (switchModel) {
      try {
        await session.setModel(switchModel);
        result.response = `Model switched to ${provider}/${modelId}`;
        result.finishReason = "stop";
        deps.logger.info(
          { provider, model: modelId },
          "Model switched via SDK setModel()",
        );
      } catch (setModelError) {
        const errMsg = setModelError instanceof Error ? setModelError.message : "unknown error";
        result.response = `Failed to switch model: ${errMsg}`;
        result.finishReason = "stop";
        deps.logger.warn(
          {
            err: setModelError,
            provider,
            model: modelId,
            hint: "session.setModel() failed -- API key may be invalid or model unavailable",
            errorKind: "auth" as ErrorKind,
          },
          "Model switch failed",
        );
      }
    } else {
      result.response = `Unknown model: ${provider}/${modelId}`;
      result.finishReason = "stop";
    }
  }

  // /model cycle delegates to SDK's session.cycleModel()
  if (directives.modelCycle) {
    hasCommandDirective = true;
    const direction = directives.modelCycle.direction ?? "forward";
    try {
      const cycleResult = await session.cycleModel(direction);
      if (cycleResult) {
        const modelName = cycleResult.model?.id ?? "unknown";
        result.response = `Model cycled to: ${modelName}`;
        result.finishReason = "stop";
        deps.logger.info(
          { model: modelName, direction },
          "Model cycled via SDK",
        );
      }
    } catch (cycleError) {
      const errMsg = cycleError instanceof Error ? cycleError.message : "unknown error";
      result.response = `Model cycle failed: ${errMsg}`;
      result.finishReason = "stop";
      deps.logger.warn(
        {
          err: cycleError,
          hint: "session.cycleModel() failed",
          errorKind: "internal" as ErrorKind,
        },
        "Model cycle error",
      );
    }
  }

  // /export delegates to SDK's exportToHtml()
  if (directives.exportSession) {
    hasCommandDirective = true;
    // Validate output path if provided
    let resolvedExportPath: string | undefined;
    const rawOutputPath = directives.exportSession.outputPath;
    if (rawOutputPath) {
      try {
        // Validate path is safe -- use safePath with full relative path to catch '../..' traversal.
        // IMPORTANT: Do NOT use path.basename() here -- it strips traversal components, defeating the check.
        // For absolute paths: validate basename within its parent directory.
        // For relative paths: validate the FULL relative path against workspace dir as jail.
        resolvedExportPath = rawOutputPath.startsWith("/")
          ? safePath(path.dirname(rawOutputPath), path.basename(rawOutputPath))
          : safePath(deps.workspaceDir, rawOutputPath);  // full relative path -- catches '../..'
      } catch {
        result.response = "Invalid export path";
        result.finishReason = "stop";
        deps.logger.warn(
          { outputPath: rawOutputPath, hint: "Export path validation failed", errorKind: "validation" as ErrorKind },
          "Invalid export path rejected",
        );
      }
    }
    // Only proceed with export if path validation passed (or no path was specified)
    if (!rawOutputPath || resolvedExportPath) {
      try {
        // Pass the RESOLVED safe path (not the original unvalidated path) to exportToHtml
        const exportPath = await session.exportToHtml(resolvedExportPath);
        deps.logger.info(
          { exportPath },
          "Session exported to HTML",
        );
        result.response = `Session exported to: ${exportPath}`;
        result.finishReason = "stop";
      } catch (exportError) {
        deps.logger.warn(
          {
            err: exportError,
            hint: "Session export to HTML failed",
            errorKind: "internal" as ErrorKind,
          },
          "Export error",
        );
        result.response = `Export failed: ${exportError instanceof Error ? exportError.message : "unknown error"}`;
        result.finishReason = "error";
      }
    }
  }

  // /fork delegates to SDK's navigateTree() on the latest user message
  // v0.65.0: fork() moved to AgentSessionRuntime; navigateTree() provides
  // equivalent in-session branching and is still on AgentSession.
  if (directives.forkSession) {
    hasCommandDirective = true;
    try {
      const userMessages = session.getUserMessagesForForking();
      if (userMessages.length === 0) {
        result.response = "No user messages to fork from.";
        result.finishReason = "stop";
      } else {
        const lastMsg = userMessages[userMessages.length - 1];
        const navResult = await session.navigateTree(lastMsg.entryId);
        if (navResult.cancelled) {
          result.response = "Fork cancelled.";
        } else {
          const preview = lastMsg.text.slice(0, 80);
          const ellipsis = lastMsg.text.length > 80 ? "..." : "";
          result.response = `Forked from: "${preview}${ellipsis}"`;
        }
        result.finishReason = "stop";
        deps.logger.info(
          { entryId: lastMsg.entryId },
          "Session forked via SDK",
        );
      }
    } catch (forkError) {
      deps.logger.warn(
        {
          err: forkError,
          hint: "Session fork failed",
          errorKind: "internal" as ErrorKind,
        },
        "Fork error",
      );
      result.response = `Fork failed: ${forkError instanceof Error ? forkError.message : "unknown error"}`;
      result.finishReason = "error";
    }
  }

  // /branch lists branch points or navigates to one
  if (directives.branchAction) {
    hasCommandDirective = true;
    const { targetId } = directives.branchAction;
    if (targetId) {
      // Navigate to specific branch
      try {
        const navResult = await session.navigateTree(targetId);
        if (navResult.cancelled) {
          result.response = "Branch navigation cancelled.";
        } else {
          result.response = `Navigated to branch: ${targetId}`;
        }
        result.finishReason = "stop";
        deps.logger.info(
          { targetId },
          "Branch navigated via SDK",
        );
      } catch (navError) {
        deps.logger.warn(
          {
            err: navError,
            targetId,
            hint: "Branch navigation failed",
            errorKind: "internal" as ErrorKind,
          },
          "Branch navigate error",
        );
        result.response = `Branch navigation failed: ${navError instanceof Error ? navError.message : "unknown error"}`;
        result.finishReason = "error";
      }
    } else {
      // List available branch points
      try {
        const branches = session.getUserMessagesForForking();
        if (branches.length === 0) {
          result.response = "No branch points available.";
        } else {
          const lines = ["**Branch Points**", ""];
          for (const b of branches) {
            const preview = b.text.slice(0, 60);
            const ellipsis = b.text.length > 60 ? "..." : "";
            lines.push(`- \`${b.entryId}\`: "${preview}${ellipsis}"`);
          }
          lines.push("");
          lines.push("Use `/branch <id>` to navigate to a branch point.");
          result.response = lines.join("\n");
        }
        result.finishReason = "stop";
      } catch (listError) {
        deps.logger.warn(
          {
            err: listError,
            hint: "Branch listing failed",
            errorKind: "internal" as ErrorKind,
          },
          "Branch list error",
        );
        result.response = `Branch listing failed: ${listError instanceof Error ? listError.message : "unknown error"}`;
        result.finishReason = "error";
      }
    }
  }

  return { hasCommandDirective };
}
