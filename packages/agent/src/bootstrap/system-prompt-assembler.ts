// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { InstructionSection } from "@comis/core";
import {
  compileExecutionPrompt,
  type CompiledExecutionPrompt,
  type RuntimePromptSection,
} from "../executor/prompt-compiler.js";
import type {
  BootstrapContextFile,
  PromptMode,
} from "./types.js";

export const SECTION_SEPARATOR = "\n\n---\n\n";

export interface SystemPromptBlocks {
  readonly staticPrefix: string;
  readonly attribution: string;
  readonly semiStableBody: string;
}

/**
 * Inputs retained at the executor boundary while prompt policy is compiled
 * from typed instruction sections. Fields that describe runtime features are
 * deliberately not converted into capability claims; provider tool schemas
 * and the active registry remain authoritative.
 */
export interface AssemblerParams {
  promptMode?: PromptMode;
  instructionSections?: readonly InstructionSection[];
  bootstrapFiles?: BootstrapContextFile[];
  extraSystemPrompt?: string;
  additionalSections?: string[];
  promptSkillsXml?: string;
  activePromptSkillContent?: string;
  reasoningTagHint?: boolean;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function legacyBootstrapSections(
  files: readonly BootstrapContextFile[],
): readonly InstructionSection[] {
  return files
    .filter((file) => file.content.length > 0 && !file.content.startsWith("[MISSING]"))
    .map((file) => {
      const isAgentState = file.path === "BOOTSTRAP.md";
      return {
        id: `workspace:${file.path.replace(/\.md$/iu, "").toLowerCase()}`,
        sourceKind: isAgentState ? "agent_state" as const : "operator" as const,
        trust: isAgentState ? "untrusted" as const : "trusted" as const,
        stability: isAgentState ? "turn" as const : "stable" as const,
        content: file.content,
        contentHash: sha256Hex(file.content),
        maxChars: Math.max(1, file.content.length),
      };
    });
}

function runtimeSection(
  id: string,
  content: string | undefined,
  maxChars: number,
  priority: number,
): RuntimePromptSection | undefined {
  if (content === undefined || content.length === 0) return undefined;
  return {
    id,
    sourceKind: "external",
    trust: "untrusted",
    stability: "volatile",
    content,
    maxChars,
    priority,
    contentHash: sha256Hex(content),
  };
}

function runtimeSections(params: AssemblerParams): readonly RuntimePromptSection[] {
  const sections = [
    runtimeSection("runtime:available-skills", params.promptSkillsXml, 6_000, 30),
    runtimeSection("runtime:active-skill", params.activePromptSkillContent, 8_000, 50),
    runtimeSection("runtime:task-context", params.extraSystemPrompt, 4_000, 40),
    ...(params.additionalSections ?? []).map((content, index) =>
      runtimeSection(`runtime:additional:${index}`, content, 4_000, 20)),
  ];
  return sections.filter((section): section is RuntimePromptSection => section !== undefined);
}

export function compileRichSystemPrompt(params: AssemblerParams): CompiledExecutionPrompt {
  return compileExecutionPrompt({
    mode: params.promptMode ?? "full",
    operatorPolicy: params.instructionSections
      ?? legacyBootstrapSections(params.bootstrapFiles ?? []),
    runtimeSections: runtimeSections(params),
    requireFinalTags: params.reasoningTagHint,
  });
}

export function assembleRichSystemPromptBlocks(params: AssemblerParams): SystemPromptBlocks {
  const compiled = compileRichSystemPrompt(params);
  return {
    staticPrefix: compiled.stableEnginePrefix,
    attribution: compiled.stableOperatorPolicyPrefix,
    semiStableBody: compiled.dynamicRuntimePreamble,
  };
}

export function assembleRichSystemPrompt(params: AssemblerParams): string {
  const blocks = assembleRichSystemPromptBlocks(params);
  return [blocks.staticPrefix, blocks.attribution, blocks.semiStableBody]
    .filter((block) => block.length > 0)
    .join(SECTION_SEPARATOR);
}
