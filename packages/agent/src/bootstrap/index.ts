// SPDX-License-Identifier: Apache-2.0
// Bootstrap — workspace file loading & system prompt assembly
export {
  type BootstrapFile,
  type TruncationResult,
  type PromptMode,
  type RuntimeInfo,
  type InboundMetadata,
  type BootstrapContextFile,
  SUBAGENT_BOOTSTRAP_ALLOWLIST,
  BOOTSTRAP_HEAD_RATIO,
  BOOTSTRAP_TAIL_RATIO,
} from "./types.js";

export {
  loadWorkspaceBootstrapFiles,
  truncateFileContent,
  filterBootstrapFilesForSubAgent,
  filterBootstrapFilesForLightContext,
  filterBootstrapFilesForCron,
  filterBootstrapFilesForGroupChat,
  buildBootstrapContextFiles,
} from "./workspace-loader.js";

export * from "./sections/index.js";

export { extractMarkdownSections, MAX_POST_COMPACTION_CHARS } from "./section-extractor.js";

export { assembleRichSystemPrompt, assembleRichSystemPromptBlocks, SECTION_SEPARATOR } from "./system-prompt-assembler.js";
export type { AssemblerParams, SystemPromptBlocks } from "./system-prompt-assembler.js";
