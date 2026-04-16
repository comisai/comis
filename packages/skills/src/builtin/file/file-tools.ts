/**
 * Comis File Tools Factory.
 *
 * Creates file tools with safePath security wrapping for path-accepting tools.
 * All 7 file tools (read/edit/notebook_edit/write/grep/find/ls) are Comis-native.
 * Tools are enabled individually via SkillsConfig builtinTools toggles.
 *
 * @module
 */

import type { SkillsConfig } from "@comis/core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createComisReadTool } from "../file-tools/read-tool.js";
import { createComisEditTool } from "../file-tools/edit-tool.js";
import { createComisNotebookEditTool } from "../file-tools/notebook-edit-tool.js";
import { createComisWriteTool } from "../file-tools/write-tool.js";
import { createComisGrepTool } from "../file-tools/grep-tool.js";
import { createComisFindTool } from "../file-tools/find-tool.js";
import { createComisLsTool } from "../file-tools/ls-tool.js";
import { type SafePathLogger, type LazyPaths } from "./safe-path-wrapper.js";
import type { FileStateTracker } from "./file-state-tracker.js";

/**
 * Create Comis file tools based on config toggles.
 *
 * Only tools whose corresponding config toggle is true will be included
 * in the returned array. Path-accepting tools (read, edit, write, ls,
 * grep, find) are wrapped with safePath to prevent directory traversal.
 * When a FileStateTracker is provided, read/write/edit tools are additionally
 * wrapped with file state guards (dedup, read-before-write, staleness, device blocking).
 *
 * @param config - Skills configuration with builtinTools toggles
 * @param workspacePath - Absolute path to workspace root
 * @param logger - Optional logger for traversal warnings
 * @param readOnlyPaths - Optional additional paths for read-only tools
 * @param sharedPaths - Optional shared read+write paths
 * @param tracker - Optional per-session FileStateTracker for safety guards
 * @returns Array of enabled, security-wrapped file AgentTools
 */
export function createComisFileTools(
  config: SkillsConfig,
  workspacePath: string,
  logger?: SafePathLogger,
  readOnlyPaths?: string[],
  sharedPaths?: LazyPaths,
  tracker?: FileStateTracker,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
): AgentTool<any>[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
  const tools: AgentTool<any>[] = [];
  const bt = config.builtinTools;

  /** Adapt SafePathLogger to ToolLogger (warn+debug, Pino object-first) for read/edit/notebook_edit. */
  const toolLogger = logger ? { warn: logger.warn.bind(logger), debug: logger.debug?.bind(logger) ?? (() => {}) } : undefined;

  /** Adapt SafePathLogger to simple ToolLogger (debug-only, message-first) for write/grep. */
  const simpleLogger = logger?.debug
    ? { debug: (msg: string, ...args: unknown[]) => logger.debug!({ args }, msg) }
    : undefined;

  if (bt.read) {
    tools.push(createComisReadTool(workspacePath, toolLogger, tracker, readOnlyPaths, sharedPaths));
  }

  if (bt.edit) {
    tools.push(createComisEditTool(workspacePath, toolLogger, tracker, sharedPaths));
  }

  if (bt.notebookEdit) {
    tools.push(createComisNotebookEditTool(workspacePath, toolLogger, tracker));
  }

  if (bt.write) {
    tools.push(createComisWriteTool(workspacePath, simpleLogger, tracker, sharedPaths));
  }

  if (bt.grep) {
    tools.push(createComisGrepTool(workspacePath, simpleLogger, readOnlyPaths, sharedPaths));
  }

  if (bt.find) {
    tools.push(createComisFindTool(workspacePath, simpleLogger, readOnlyPaths, sharedPaths));
  }

  if (bt.ls) {
    tools.push(createComisLsTool(workspacePath, simpleLogger, readOnlyPaths, sharedPaths));
  }

  return tools;
}
