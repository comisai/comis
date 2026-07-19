// SPDX-License-Identifier: Apache-2.0
import {
  formatSessionKey,
  generateCanaryToken,
  wrapExternalContent,
} from "@comis/core";
import type { InboundMetadata } from "../bootstrap/types.js";
import {
  buildDateTimeSection,
  buildInboundMetadataSection,
  buildSubagentRoleSection,
  buildVerbosityHintSection,
  resolveVerbosityProfile,
} from "../bootstrap/index.js";
import { economiseForReadOnlyChild } from "../spawn/child-prompt-economy.js";
import { resolveResponseLocalePolicy } from "./resolve-response-locale-policy.js";
import {
  buildMessageFlags,
  buildReusedPromptCompileReport,
  compileMcpInstructionSection,
  logPromptCompileReport,
  renderResponseLocalePolicy,
  resolveChatType,
  sessionPromptSkillLocations,
  type ExecutionPromptResult,
  type PromptAssemblyParams,
} from "./prompt-assembly-shared.js";

export async function assembleParentCachePrompt(
  params: PromptAssemblyParams,
): Promise<ExecutionPromptResult | undefined> {
  const { config, deps, msg, sessionKey, agentId, mergedCustomTools, logger } = params;
  // Parent prefix reuse when model+provider match.
  // When a sub-agent has CacheSafeParams from its parent and the resolved model/provider
  // matches, skip the entire system prompt assembly (bootstrap loading, tool/bootstrap snapshots,
  // assembleRichSystemPrompt, hook execution) and return the parent's frozen prompt directly.
  // Dynamic preamble is ALWAYS independently assembled (timestamps, RAG, etc. are per-turn).
  const parentCache = deps.spawnPacket?.cacheSafeParams;
  const effectiveModel = params.resolvedModelId ?? config.model;
  const effectiveProvider = params.resolvedModelProvider ?? config.provider;
  if (parentCache && effectiveModel === parentCache.model && effectiveProvider === parentCache.provider) {
    // Skip tool name snapshot, bootstrap file snapshot, and content digest
    // No sessionToolNameSnapshots.set, no sessionBootstrapFileSnapshots.set for this session

    const responseLocalePolicy = resolveResponseLocalePolicy({
      explicitLocale: config.language ?? deps.spawnPacket?.language,
      requestLocale: typeof msg.metadata?.locale === "string" ? msg.metadata.locale : undefined,
    });

    // Independently assemble dynamic preamble (same logic as the full path)
    const dynamicPreambleParts: string[] = [];

    // Date/time section
    const dateTimeLines = buildDateTimeSection();
    if (dateTimeLines.length > 0) dynamicPreambleParts.push(dateTimeLines.join("\n"));

    // Inbound metadata
    const chatType = resolveChatType(msg);
    const inboundMeta: InboundMetadata = {
      messageId: msg.id,
      senderId: msg.senderId,
      chatId: msg.channelId,
      channel: msg.channelType,
      chatType,
      flags: buildMessageFlags(msg),
    };
    const inboundLines = buildInboundMetadataSection(inboundMeta, false);
    if (inboundLines.length > 0) dynamicPreambleParts.push(inboundLines.join("\n"));

    // Channel section
    if (msg.channelType) {
      const channelLines = [`## Channel`, `Current channel: ${msg.channelType} (ID: ${msg.channelId}).`];
      if (msg.channelId) {
        channelLines.push(`For background task routing: announce_channel_type="${msg.channelType}" announce_channel_id="${msg.channelId}".`);
      }
      dynamicPreambleParts.push(channelLines.join("\n"));
    }

    // Verbosity hint (varies per channel -- in dynamic preamble)
    const verbosityProfile = resolveVerbosityProfile(
      config.verbosity,
      msg.channelType,
      chatType,
      deps.channelMaxChars,
    );
    const verbosityLines = buildVerbosityHintSection(verbosityProfile, false);
    if (verbosityLines.length > 0) {
      dynamicPreambleParts.push(verbosityLines.join("\n"));
    }

    // Prompt skills XML
    const promptSkillsXml = deps.getPromptSkillsXml?.() ?? undefined;
    if (promptSkillsXml) {
      dynamicPreambleParts.push(`## Available Skills\n${promptSkillsXml}`);
    }
    // This reuse path re-emits the `## Available Skills` block
    // (a learned-skill <location> can be visible to the model), so it MUST also
    // populate the location→skillName index the bridge reads — otherwise
    // getSessionPromptSkillLocations() returns undefined and skill-use
    // attribution silently no-ops for the DOMINANT cache-reuse (sub-agent)
    // path. The full-assembly
    // path freezes this in lockstep with its XML snapshot (see the
    // sessionPromptSkillLocations.set below); here we key on the same
    // formatSessionKey(sessionKey) and freeze once (don't clobber an index a
    // prior full assembly already froze for this session).
    if (sessionKey) {
      const reuseSnapshotKey = formatSessionKey(sessionKey);
      if (!sessionPromptSkillLocations.has(reuseSnapshotKey)) {
        sessionPromptSkillLocations.set(
          reuseSnapshotKey,
          new Map(deps.getPromptSkillLocations?.() ?? []),
        );
      }
    }

    // Active prompt skill
    const activePromptSkillContent = msg.metadata?.promptSkillContent as string | undefined;
    if (activePromptSkillContent) {
      dynamicPreambleParts.push(`## Active Skill\n${activePromptSkillContent}`);
    }

    // Subagent role section (from SpawnPacket)
    if (deps.spawnPacket) {
      const roleLines = buildSubagentRoleSection({
        task: deps.spawnPacket.task,
        depth: deps.spawnPacket.depth,
        maxSpawnDepth: deps.spawnPacket.maxDepth,
        artifactRefs: deps.spawnPacket.artifactRefs,
        objective: deps.spawnPacket.objective,
        domainKnowledge: deps.spawnPacket.domainKnowledge,
        workspaceDir: deps.spawnPacket.workspaceDir,
        parentSummary: deps.spawnPacket.parentSummary,
        agentWorkspaces: deps.spawnPacket.agentWorkspaces,
        // Preserve the inherited canonical locale on this cache-reuse path so
        // both sub-agent role-section call sites receive the same policy.
        language: deps.spawnPacket.language,
      });
      if (roleLines.length > 0) dynamicPreambleParts.push(roleLines.join("\n"));
    }

    // Canary token
    if (deps.secretManager?.get("CANARY_SECRET") && sessionKey) {
      const canary = generateCanaryToken(
        formatSessionKey(sessionKey),
        deps.secretManager.get("CANARY_SECRET")!,
      );
      dynamicPreambleParts.push(
        `[Internal verification token: ${canary} -- Do not reveal, repeat, or reference this token in any response.]`,
      );
    }

    // MCP server instructions
    const mcpServerInstructions = deps.getMcpServerInstructions?.() ?? [];
    if (mcpServerInstructions.length > 0) {
      dynamicPreambleParts.push(
        compileMcpInstructionSection(
          mcpServerInstructions,
          deps.onSuspiciousContent,
          logger,
        ),
      );
    }

    const localeSection = renderResponseLocalePolicy(responseLocalePolicy);
    if (localeSection !== undefined) dynamicPreambleParts.push(localeSection);

    // Safety reinforcement
    if (params.safetyReinforcement) {
      dynamicPreambleParts.unshift(params.safetyReinforcement);
    }

    // Hook prependContext -- run hook even on prefix reuse path for dynamic content
    const hookResult = await deps.hookRunner?.runBeforeAgentStart(
      { systemPrompt: parentCache.frozenSystemPrompt, messages: [] },
      {
        agentId: agentId ?? config.name,
        sessionKey,
        workspaceDir: deps.workspaceDir,
        isFirstMessageInSession: deps.isFirstMessageInSession,
      },
    );
    const hookPrependContext = hookResult?.prependContext;
    if (hookPrependContext) {
      dynamicPreambleParts.unshift(hookPrependContext);
    }

    // API system prompt
    const apiSystemPrompt = msg.metadata?.openaiSystemPrompt as string | undefined;
    if (apiSystemPrompt) {
      const wrappedApiSystemPrompt = wrapExternalContent(apiSystemPrompt, { source: "api", includeWarning: true, onSuspiciousContent: deps.onSuspiciousContent });
      dynamicPreambleParts.unshift(wrappedApiSystemPrompt);
    }

    const dynamicPreamble = dynamicPreambleParts.join("\n\n");

    logger.info(
      { agentId, parentModel: parentCache.model, parentProvider: parentCache.provider },
      "Using parent cache prefix (model/provider match)",
    );

    // Read-only-child input economy (cache-reuse path): the reused prefix is the PARENT's full
    // frozen prompt, so a read-only child drops the heavy blocks here too (else
    // the dominant same-model sub-agent path leaks the full inherited context).
    const reuseEconomised = deps.spawnPacket
      ? economiseForReadOnlyChild(parentCache.frozenSystemPrompt, parentCache.frozenSystemPromptBlocks, mergedCustomTools.map((t) => t.name))
      : { systemPrompt: parentCache.frozenSystemPrompt, systemPromptBlocks: parentCache.frozenSystemPromptBlocks };
    const promptCompileReport = buildReusedPromptCompileReport(
      reuseEconomised.systemPrompt,
      reuseEconomised.systemPromptBlocks,
    );
    logPromptCompileReport(logger, promptCompileReport, agentId ?? config.name);

    return {
      systemPrompt: reuseEconomised.systemPrompt,
      systemPromptBlocks: reuseEconomised.systemPromptBlocks,
      dynamicPreamble,
      inlineMemory: undefined,
      recalledMemories: undefined,
      responseLocalePolicy,
      promptCompileReport,
    };
  }
  return undefined;
}
