/**
 * Post-compaction rehydration context engine layer.
 *
 * After LLM compaction reduces conversation history to a summary, the agent
 * loses critical operating instructions, file context, and state awareness.
 * This layer detects when compaction has occurred and injects:
 *
 * - AGENTS.md critical sections (max 3K chars)
 * - Recently-accessed files (max 5, each max 8K chars)
 * - Resume instruction for seamless continuation
 * - Active state restoration (channel, agent context)
 * - Overflow check with graceful degradation
 *
 * Rehydration uses split injection for KV-cache stability:
 * - Position 1 (after compaction summary): AGENTS.md + files (rarely changes)
 * - End of array: Resume instruction + active state (changes every turn)
 *
 * Double-rehydration prevention ensures the layer only fires once per
 * compaction event.
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextLayer, TokenBudget, RehydrationLayerDeps } from "./types.js";
import {
  MAX_REHYDRATION_FILES,
  MAX_REHYDRATION_FILE_CHARS,
  MAX_REHYDRATION_SKILL_CHARS,
  MAX_REHYDRATION_SKILLS,
  MAX_REHYDRATION_CHARS_PER_SKILL,
  MAX_REHYDRATION_TOKEN_BUDGET_CHARS,
  CHARS_PER_TOKEN_RATIO,
} from "./constants.js";
import { findCompactionSummaryIndex } from "./history-window.js";
import {
  extractMarkdownSections,
  MAX_POST_COMPACTION_CHARS,
} from "../bootstrap/section-extractor.js";
import { estimateContextCharsWithDualRatio } from "../safety/token-estimator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a simple hash of the compaction summary content for tracking.
 * Uses the first 200 chars of the compaction message text as an identity key.
 */
function getCompactionIdentity(msg: AgentMessage): string {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const m = msg as any;
  if (typeof m.content === "string") {
    return m.content.slice(0, 200);
  }
  if (Array.isArray(m.content) && m.content[0]?.type === "text") {
    return (m.content[0].text ?? "").slice(0, 200);
  }
  return "";
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Build the AGENTS.md sections content.
 */
function buildAgentsMdContent(
  agentsMd: string,
  sectionNames: string[],
): string {
  if (!agentsMd || sectionNames.length === 0) return "";

  const sections = extractMarkdownSections(agentsMd, sectionNames);
  if (sections.length === 0) return "";

  let combined = sections.join("\n\n");
  if (combined.length > MAX_POST_COMPACTION_CHARS) {
    combined = combined.slice(0, MAX_POST_COMPACTION_CHARS);
  }

  return `[Critical instructions from AGENTS.md]\n${combined}\n[End critical instructions]`;
}

/**
 * Build the file content sections.
 */
async function buildFileContent(
  deps: RehydrationLayerDeps,
): Promise<string> {
  const filePaths = deps.getRecentFiles();
  const paths = filePaths.slice(0, MAX_REHYDRATION_FILES);
  if (paths.length === 0) return "";

  const parts: string[] = [];
  for (const filePath of paths) {
    try {
      const content = await deps.readFile(filePath);
      if (!content) continue;
      const truncated = content.length > MAX_REHYDRATION_FILE_CHARS
        ? content.slice(0, MAX_REHYDRATION_FILE_CHARS)
        : content;
      parts.push(`[File: ${filePath}]\n${truncated}\n[End file]`);
    } catch {
      deps.logger.debug(
        { filePath },
        "Rehydration: failed to read file, skipping",
      );
    }
  }

  return parts.join("\n\n");
}

/**
 * Build the prompt skills content for position-1 injection.
 * Truncates at whole skill boundaries to prevent malformed XML.
 * Per-skill budget: MAX_REHYDRATION_CHARS_PER_SKILL (5K) with closing tag repair.
 * Max 10 skills, max 15K chars total.
 */
function buildSkillsContent(deps: RehydrationLayerDeps): string {
  const xml = deps.getPromptSkillsXml?.();
  if (!xml || xml.trim() === "") return "";

  const closingTag = "</skill>";
  const skillOpenRegex = /<skill[\s>]/g;

  // Phase 1: Extract individual skill blocks and apply per-skill truncation (POST-COMPACT-BUDGET)
  const skillBlocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = skillOpenRegex.exec(xml)) !== null) {
    const startIdx = match.index;
    const closeIdx = xml.indexOf(closingTag, startIdx);
    if (closeIdx === -1) break; // malformed -- stop

    let skillBlock = xml.slice(startIdx, closeIdx + closingTag.length);

    // POST-COMPACT-BUDGET: Per-skill truncation with closing tag repair
    if (skillBlock.length > MAX_REHYDRATION_CHARS_PER_SKILL) {
      // Reserve space for repair suffix: "\n...</skill>" = 12 chars
      const repairSuffix = "\n..." + closingTag;
      const contentBudget = MAX_REHYDRATION_CHARS_PER_SKILL - repairSuffix.length;
      const truncated = skillBlock.slice(0, contentBudget);
      // Find last complete line within budget
      const lastNewline = truncated.lastIndexOf("\n");
      const cutPoint = lastNewline > 0 ? lastNewline : contentBudget;
      skillBlock = truncated.slice(0, cutPoint) + repairSuffix;
    }

    skillBlocks.push(skillBlock);
  }

  if (skillBlocks.length === 0) return "";

  // Phase 2: Enforce MAX_REHYDRATION_SKILLS count limit
  const limitedBlocks = skillBlocks.slice(0, MAX_REHYDRATION_SKILLS);

  // Phase 3: Reassemble XML with wrapper
  // Preserve opening tag from original XML
  const wrapperOpenEnd = xml.indexOf(">") + 1;
  const wrapperOpen = xml.slice(0, wrapperOpenEnd);
  let truncatedXml = wrapperOpen + "\n" + limitedBlocks.join("\n") + "\n</available_skills>";

  // Phase 4: Enforce char budget (15K)
  if (truncatedXml.length > MAX_REHYDRATION_SKILL_CHARS) {
    // Re-truncate at skill boundaries within char budget
    const withinBudget = truncatedXml.slice(0, MAX_REHYDRATION_SKILL_CHARS);
    const lastClose = withinBudget.lastIndexOf(closingTag);
    if (lastClose > 0) {
      truncatedXml = withinBudget.slice(0, lastClose + closingTag.length) + "\n</available_skills>";
    } else {
      // Can't fit even one complete skill -- skip
      return "";
    }
  }

  return `[Restored prompt skills]\n${truncatedXml}\n[End restored prompt skills]`;
}

/**
 * Build the resume instruction.
 */
function buildResumeInstruction(): string {
  return `[Resume instruction]
The conversation was just compacted. The summary above contains key context from the previous conversation.
Continue from where the conversation left off based on the compaction summary. Do not ask the user to repeat information that is in the summary.
[End resume instruction]`;
}

/**
 * Build the active state section.
 */
function buildActiveState(
  deps: RehydrationLayerDeps,
): string {
  const state = deps.getActiveState();
  const parts: string[] = [];

  if (state.channelType) parts.push(`Channel type: ${state.channelType}`);
  if (state.channelId) parts.push(`Channel ID: ${state.channelId}`);
  if (state.agentId) parts.push(`Agent ID: ${state.agentId}`);

  if (parts.length === 0) return "";

  return `[Active state]\n${parts.join("\n")}\n[End active state]`;
}

/**
 * Strip file content sections from a rehydration text string.
 * Keeps AGENTS.md sections, resume instruction, and active state.
 */
function stripFileContent(text: string): string {
  // Remove all [File: ...] ... [End file] blocks
  return text.replace(/\[File: [^\]]*\]\n[\s\S]*?\[End file\]\n*/g, "").trim();
}

/**
 * Strip skill content sections from a rehydration text string.
 * Keeps AGENTS.md sections, file content, resume instruction, and active state.
 */
function stripSkillsContent(text: string): string {
  return text.replace(/\[Restored prompt skills\]\n[\s\S]*?\[End restored prompt skills\]\n*/g, "").trim();
}

/**
 * Assemble result array with split injection.
 *
 * Layout: compaction[0] + [position1] + history[1..N] + [end]
 * Position-1 message goes right after the compaction summary (stable KV-cache prefix).
 * End message goes after all history messages (dynamic content).
 */
function assembleResult(
  messages: AgentMessage[],
  position1Message: AgentMessage | null,
  endMessage: AgentMessage | null,
  compactionIdx: number = 0,
): AgentMessage[] {
  // head messages (before summary) + summary + position1 + tail
  const result: AgentMessage[] = [];
  result.push(...messages.slice(0, compactionIdx + 1)); // head + compaction summary
  if (position1Message) result.push(position1Message);
  result.push(...messages.slice(compactionIdx + 1)); // rest of history after summary
  if (endMessage) result.push(endMessage);
  return result;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a post-compaction rehydration context layer.
 *
 * @param deps - Rehydration layer dependencies (logger, AGENTS.md, files, state)
 * @returns ContextLayer that injects recovery content after compaction
 */
export function createRehydrationLayer(
  deps: RehydrationLayerDeps,
): ContextLayer {
  // Closure state: track last rehydrated compaction identity to prevent double-rehydration
  let lastRehydratedCompactionId = "";

  return {
    name: "rehydration",

    async apply(messages: AgentMessage[], budget: TokenBudget): Promise<AgentMessage[]> {
      // Step 1: Detect compaction summary (may not be at index 0 after middle-out compaction)
      const compactionIdx = findCompactionSummaryIndex(messages);
      if (messages.length === 0 || compactionIdx < 0) {
        return messages;
      }

      // Step 2: Check for double-rehydration
      const compactionId = getCompactionIdentity(messages[compactionIdx]!); // eslint-disable-line security/detect-object-injection
      if (compactionId && compactionId === lastRehydratedCompactionId) {
        return messages;
      }

      deps.logger.debug(
        { messageCount: messages.length },
        "Rehydration triggered: compaction summary detected",
      );

      // Step 3: Assemble rehydration content
      const agentsMdSection = buildAgentsMdContent(
        deps.getAgentsMdContent(),
        deps.postCompactionSections,
      );

      const fileSection = await buildFileContent(deps);
      const skillsSection = buildSkillsContent(deps);
      const resumeInstruction = buildResumeInstruction();
      const activeState = buildActiveState(deps);

      // Step 4: Build split injection (position-aware rehydration)
      // Position 1 (stable content -- changes rarely, good for KV-cache prefix):
      const position1Parts = [agentsMdSection, fileSection, skillsSection].filter(Boolean);
      let position1Text = position1Parts.join("\n\n");

      // POST-COMPACT-BUDGET: Enforce total rehydration token budget
      if (position1Text.length > MAX_REHYDRATION_TOKEN_BUDGET_CHARS) {
        deps.logger.warn(
          {
            totalChars: position1Text.length,
            budgetChars: MAX_REHYDRATION_TOKEN_BUDGET_CHARS,
            hint: "Rehydration content truncated to token budget",
            errorKind: "resource" as const,
          },
          "Rehydration token budget exceeded, truncating",
        );
        position1Text = position1Text.slice(0, MAX_REHYDRATION_TOKEN_BUDGET_CHARS);
      }

      // End of array (dynamic content -- changes every turn):
      const endParts = [resumeInstruction, activeState].filter(Boolean);
      const endText = endParts.join("\n\n");

      if (!position1Text && !endText) {
        // Nothing to inject -- mark as rehydrated anyway
        lastRehydratedCompactionId = compactionId;
        return messages;
      }

      // Build position-1 message (if content exists)
      let position1Message: AgentMessage | null = position1Text
        ? { role: "user", content: [{ type: "text", text: position1Text }] } as unknown as AgentMessage
        : null;

      // Build end message (if content exists)
      const endMessage: AgentMessage | null = endText
        ? { role: "user", content: [{ type: "text", text: endText }] } as unknown as AgentMessage
        : null;

      // Assemble result: compaction + [position1] + history + [end]
      let result = assembleResult(messages, position1Message, endMessage, compactionIdx);

      // Step 5: Overflow check -- adapted for split injection
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const contextChars = estimateContextCharsWithDualRatio(result as any);
      /* eslint-enable @typescript-eslint/no-explicit-any */
      const budgetChars = budget.availableHistoryTokens * CHARS_PER_TOKEN_RATIO;
      let overflowStripped = false;

      if (contextChars > budgetChars) {
        // Stage 1: Strip file content from position-1 message
        if (position1Message) {
          const strippedPosition1Text = stripFileContent(position1Text);

          if (strippedPosition1Text.length > 0) {
            position1Message = {
              role: "user",
              content: [{ type: "text", text: strippedPosition1Text }],
            } as unknown as AgentMessage;
          } else {
            position1Message = null;
          }

          result = assembleResult(messages, position1Message, endMessage, compactionIdx);

          /* eslint-disable @typescript-eslint/no-explicit-any */
          const strippedChars = estimateContextCharsWithDualRatio(result as any);
          /* eslint-enable @typescript-eslint/no-explicit-any */

          if (strippedChars <= budgetChars) {
            deps.logger.warn(
              {
                contextChars,
                budgetChars,
                hint: "File content stripped from rehydration to fit within budget",
                errorKind: "resource" as const,
              },
              "Rehydration overflow: file content stripped",
            );
            deps.onOverflow?.({ contextChars, budgetChars, recoveryAction: "strip_files" });
            overflowStripped = true;
          } else {
            // Stage 2: Strip skills from position-1
            const currentPos1Text = position1Message
              ? ((position1Message as unknown as { content: Array<{ text: string }> }).content[0]?.text ?? "")
              : strippedPosition1Text;
            const noSkillsText = stripSkillsContent(currentPos1Text);

            if (noSkillsText.length > 0) {
              position1Message = {
                role: "user",
                content: [{ type: "text", text: noSkillsText }],
              } as unknown as AgentMessage;
            } else {
              position1Message = null;
            }

            result = assembleResult(messages, position1Message, endMessage, compactionIdx);

            /* eslint-disable @typescript-eslint/no-explicit-any */
            const noSkillsChars = estimateContextCharsWithDualRatio(result as any);
            /* eslint-enable @typescript-eslint/no-explicit-any */

            if (noSkillsChars <= budgetChars) {
              deps.logger.warn(
                {
                  contextChars,
                  budgetChars,
                  hint: "Skills content stripped from rehydration to fit within budget",
                  errorKind: "resource" as const,
                },
                "Rehydration overflow: skills stripped",
              );
              deps.onOverflow?.({ contextChars, budgetChars, recoveryAction: "strip_skills" });
              overflowStripped = true;
            } else {
              // Stage 3: Remove position-1 message entirely (keep end message)
              // eslint-disable-next-line no-useless-assignment
              position1Message = null;
              result = assembleResult(messages, null, endMessage, compactionIdx);

              /* eslint-disable @typescript-eslint/no-explicit-any */
              const noPos1Chars = estimateContextCharsWithDualRatio(result as any);
              /* eslint-enable @typescript-eslint/no-explicit-any */

              if (noPos1Chars <= budgetChars) {
                deps.logger.warn(
                  {
                    contextChars,
                    budgetChars,
                    hint: "Position-1 content removed from rehydration to fit within budget",
                    errorKind: "resource" as const,
                  },
                  "Rehydration overflow: position-1 removed",
                );
                deps.onOverflow?.({ contextChars, budgetChars, recoveryAction: "remove_position1" });
                overflowStripped = true;
              } else {
                // Stage 4: Remove both messages entirely
                deps.logger.error(
                  {
                    contextChars: noPos1Chars,
                    budgetChars,
                    hint: "Rehydration removed entirely due to overflow even after stripping all injected content",
                    errorKind: "resource" as const,
                  },
                  "Rehydration overflow: removed entirely",
                );
                deps.onOverflow?.({ contextChars: noPos1Chars, budgetChars, recoveryAction: "remove_rehydration" });
                lastRehydratedCompactionId = compactionId;
                return messages;
              }
            }
          }
        } else {
          // No position-1 message to strip -- remove end message
          deps.logger.error(
            {
              contextChars,
              budgetChars,
              hint: "Rehydration removed entirely due to overflow",
              errorKind: "resource" as const,
            },
            "Rehydration overflow: removed entirely",
          );
          deps.onOverflow?.({ contextChars, budgetChars, recoveryAction: "remove_rehydration" });
          lastRehydratedCompactionId = compactionId;
          return messages;
        }
      }

      // Step 6: Mark as rehydrated
      lastRehydratedCompactionId = compactionId;

      const sectionsInjected = agentsMdSection ? 1 : 0;
      const filesInjected = fileSection ? fileSection.split("[File:").length - 1 : 0;
      const skillsInjected = skillsSection ? 1 : 0;

      deps.logger.info(
        {
          splitInjection: true,
          sectionsInjected,
          filesInjected,
          skillsInjected,
          hasResumeInstruction: true,
          hasActiveState: !!activeState,
        },
        "Post-compaction rehydration complete",
      );

      // Report rehydration stats via callback
      deps.onRehydrated?.({ sectionsInjected, filesInjected, skillsInjected, overflowStripped });

      return result;
    },
  };
}
