// SPDX-License-Identifier: Apache-2.0
/**
 * Inbound Pipeline — Message Gate stage.
 *
 * Evaluates auto-reply rules, handles slash commands (/send, /approve,
 * /deny, /config, /stop, general commands), reset triggers, and prompt
 * skill detection. Returns a gate decision indicating whether the message
 * should be processed, skipped, or was handled inline (command response sent).
 *
 * @module
 */

import type { AutoReplyEngineConfig, ChannelPort, ConversationRef, DeliverToChannelOptions, NormalizedMessage, ResolvedTurnScope, SessionKey } from "@comis/core";
import { emitObservationalEventSafely, formatSessionKey, systemNowMs } from "@comis/core";
// Command parsers/matchers live inside this orchestrator package; use local
// relative imports so the gate does not pull them via @comis/agent.
import { parseSlashCommand } from "../commands/index.js";

import type { InboundPipelineDeps } from "./inbound-pipeline.js";
import { evaluateAutoReply, isGroupMessage } from "@comis/channels";
import { matchesResetTrigger } from "./inbound-pipeline.js";
import type { SendOverrideStore } from "@comis/channels";
import { handleExportTrajectory } from "../commands/export-trajectory.js";
import { approvalRequestIsOwnedByInbound } from "../approval/index.js";
import type { InboundCallback } from "../approval/index.js";
import type { SourceTerminalScope } from "../source-message-terminal.js";
import { renderLocalized } from "../localization/deterministic-localization.js";
import type { LocalizationKey } from "@comis/core";

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/** Minimal deps needed for the gate phase. */
export type GateDeps = Pick<
  InboundPipelineDeps,
  | "logger"
  | "eventBus"
  | "sessionManager"
  | "autoReplyEngineConfig"
  | "commandQueue"
  | "getResetTriggers"
  | "approvalGate"
  | "interactiveCallbackRouter"
  | "onGraphReportRequest"
  | "handleConfigCommand"
  | "handleSlashCommand"
  | "activeRunRegistry"
  | "sessionResolver"
  | "deliveryService"
  | "localization"
> & {
  /**
   * Bundle export DI. Injected by daemon wiring.
   * Optional — when absent, /export-trajectory falls through to the generic
   * handleSlashCommand block (where it will be handled as unrecognised if
   * the daemon has not provided this dep).
   */
  exportSessionBundle?: (sessionId: string) => Promise<{ bundlePath: string }>;
};

function localized(
  deps: GateDeps,
  msg: NormalizedMessage,
  key: LocalizationKey,
  values?: Readonly<Record<string, string | number>>,
): string {
  return renderLocalized(deps.localization, {
    key,
    ...(typeof msg.metadata?.locale === "string" ? { locale: msg.metadata.locale } : {}),
    ...(values === undefined ? {} : { values }),
  });
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Gate decision: what should happen with this message. */
export type GateDecision =
  | { action: "process"; processedMsg: NormalizedMessage; directives?: Record<string, unknown> }
  | { action: "handled" }
  | { action: "skip" };

function inboundDeliveryOptions(
  turnScope: ResolvedTurnScope,
  conversationRef: ConversationRef,
  options: Pick<DeliverToChannelOptions, "skipChunking"> = {},
): DeliverToChannelOptions {
  return {
    completionMode: "deferred_retry",
    authority: {
      tenantId: turnScope.conversation.tenantId,
      agentId: turnScope.conversation.agentId,
      conversationRef,
    },
    destinationEndpoint: turnScope.endpoint,
    ...(turnScope.endpoint.threadId === undefined ? {} : { threadId: turnScope.endpoint.threadId }),
    ...options,
  };
}

/** Route a signed platform callback after principal resolution but before chat activation policy. */
async function routeInteractiveCallback(
  deps: GateDeps,
  adapter: ChannelPort,
  msg: NormalizedMessage,
  sessionKey: SessionKey,
  agentId: string,
  turnScope: ResolvedTurnScope,
  conversationRef: ConversationRef,
): Promise<boolean> {
  if (
    msg.metadata?.isButtonCallback !== true
    || typeof msg.metadata.callbackData !== "string"
    || deps.interactiveCallbackRouter === undefined
  ) return false;

  const routed = await deps.interactiveCallbackRouter.route({
    tenantId: sessionKey.tenantId,
    channelType: turnScope.endpoint.channelType,
    channelKey: turnScope.endpoint.conversationId,
    ...(turnScope.endpoint.threadId === undefined ? {} : { threadId: turnScope.endpoint.threadId }),
    agentId,
    conversationRef,
    resolvingPrincipalId: turnScope.principal.principalId,
    sessionKey: formatSessionKey(sessionKey),
    rawData: msg.metadata.callbackData,
    inboundUserId: msg.senderId,
  });
  const resolution = routed.ok ? routed.value : { kind: "unknown" as const };
  switch (resolution.kind) {
    case "resolved":
    case "details_requested":
      break;
    case "graph_report_requested":
      if (deps.onGraphReportRequest) {
        await deps.onGraphReportRequest(
          resolution.graphId,
          turnScope.endpoint.channelType,
          turnScope.endpoint.conversationId,
          adapter,
          inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
        );
        break;
      }
      await deps.deliveryService.deliverToChannel(
        adapter, msg.channelId,
        localized(deps, msg, "error.report_unavailable"),
        inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
      );
      break;
    case "malformed":
    case "invalid_signature":
    case "expired":
    case "unknown":
    case "ambiguous":
      await deps.deliveryService.deliverToChannel(
        adapter, msg.channelId,
        localized(deps, msg, "error.callback_invalid"),
        inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
      );
      break;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Gate function
// ---------------------------------------------------------------------------

/**
 * Evaluate all message gates: auto-reply engine, slash commands, reset
 * triggers, and prompt skill detection.
 *
 * Returns a `GateDecision`:
 * - `"process"`: message should continue to routing/execution (may have modified msg/directives)
 * - `"handled"`: a command was intercepted and a response already delivered
 * - `"skip"`: message was suppressed (auto-reply gate, inject-history)
 */
export async function evaluateInboundGate(
  deps: GateDeps,
  adapter: ChannelPort,
  processedMsg: NormalizedMessage,
  sessionKey: SessionKey,
  agentId: string,
  turnScope: ResolvedTurnScope,
  conversationRef: ConversationRef,
  sendOverrides: SendOverrideStore,
  sourceTerminalScope?: SourceTerminalScope,
): Promise<GateDecision> {
  let msg = processedMsg;

  // Sender allowlists and principal/session resolution run in the outer inbound
  // pipeline before this gate. Callback verification belongs before auto-reply:
  // a legitimate button in a mention-gated group is control input, not chat history.
  if (await routeInteractiveCallback(
    deps,
    adapter,
    msg,
    sessionKey,
    agentId,
    turnScope,
    conversationRef,
  )) {
    return { action: "handled" };
  }

  // -------------------------------------------------------------------
  // AUTO-REPLY ENGINE GATE
  // -------------------------------------------------------------------
  // Follow-up messages always activate -- bypass auto-reply evaluation
  if (msg.metadata?.isFollowup === true) {
    // Skip auto-reply evaluation -- follow-ups are system-generated
    // Fall through to execution
  } else if (deps.autoReplyEngineConfig?.enabled !== false) {
    const arConfig: AutoReplyEngineConfig = deps.autoReplyEngineConfig ?? {
      enabled: true,
      groupActivation: "mention-gated" as const,
      customPatterns: [],
      historyInjection: true,
      maxHistoryInjections: 50,
      maxGroupHistoryMessages: 20,
    };
    const isGroup = isGroupMessage(msg);
    const decision = evaluateAutoReply(msg, arConfig, isGroup);

    if (decision.action === "activate") {
      emitObservationalEventSafely(deps, "autoreply:activated", {
        channelId: msg.channelId,
        senderId: msg.senderId,
        activationMode: arConfig.groupActivation,
        reason: decision.reason,
        timestamp: systemNowMs(),
      });
      // Continue to routing + execution below
    } else if (decision.action === "inject-history") {
      emitObservationalEventSafely(deps, "autoreply:suppressed", {
        channelId: msg.channelId,
        senderId: msg.senderId,
        reason: decision.reason,
        injectedAsHistory: true,
        timestamp: systemNowMs(),
      });
      deps.logger.info(
        {
          channelType: adapter.channelType,
          chatId: msg.channelId,
          senderId: msg.senderId,
          reason: decision.reason,
          activationMode: arConfig.groupActivation,
          isBotMentioned: msg.metadata?.isBotMentioned === true,
          replyToBot: msg.metadata?.replyToBot === true,
          action: "inject-history" as const,
          hint: "Group activation policy did not match — message saved as history context only. Set autoReplyEngine.groupActivation=always to respond to all group messages, or @-mention/reply to the bot to activate it.",
          errorKind: "config" as const,
        },
        "Group message did not activate agent",
      );

      // Group history injection was disabled in production (groupHistoryBuffer
      // deps slot was never wired); the slot has been removed.

      // Route history injection through command queue for serialization
      if (deps.commandQueue) {
        const historyEnqueueResult = await deps.commandQueue.enqueue(
          sessionKey,
          msg,
          adapter.channelType,
          async () => {
            // No-op execution: serialized with concurrent executions via queue.
            // Lightweight save to append message as history context.
            const existing = deps.sessionManager.loadOrCreate(turnScope.conversation);
            if (!existing.ok) return;
            deps.sessionManager.save(turnScope.conversation, [
              ...existing.value.slice(-(arConfig.maxHistoryInjections - 1)),
              { role: "user" as const, content: `[${msg.senderId}]: ${msg.text ?? ""}` },
            ]);
          },
          sourceTerminalScope,
        );
        if (!historyEnqueueResult.ok) {
          deps.logger.warn({
            err: historyEnqueueResult.error.message,
            hint: "Check if command queue is shut down or overflow policy rejected the message",
            errorKind: "resource" as const,
            channelType: adapter.channelType,
          }, "History injection enqueue failed");
        }
      }
      return { action: "skip" }; // Do not route to agent
    } else {
      // "ignore" -- emit suppressed event and return
      emitObservationalEventSafely(deps, "autoreply:suppressed", {
        channelId: msg.channelId,
        senderId: msg.senderId,
        reason: decision.reason,
        injectedAsHistory: false,
        timestamp: systemNowMs(),
      });
      deps.logger.info(
        {
          channelType: adapter.channelType,
          chatId: msg.channelId,
          senderId: msg.senderId,
          reason: decision.reason,
          activationMode: arConfig.groupActivation,
          isBotMentioned: msg.metadata?.isBotMentioned === true,
          replyToBot: msg.metadata?.replyToBot === true,
          action: "ignore" as const,
          hint: "Group activation policy did not match and history injection is disabled. Set autoReplyEngine.groupActivation=always or autoReplyEngine.historyInjection=true to change.",
          errorKind: "config" as const,
        },
        "Group message ignored",
      );
      return { action: "skip" };
    }
  }

  // -------------------------------------------------------------------
  // /send command handler (runtime send policy override)
  // -------------------------------------------------------------------
  if (msg.text && /^\/send\s/i.test(msg.text)) {
    const arg = msg.text.replace(/^\/send\s+/i, "").trim().toLowerCase();
    if (arg === "on" || arg === "off" || arg === "inherit") {
      // Verify sender is session owner
      if (msg.senderId === sessionKey.userId) {
        const overrideKey = formatSessionKey(sessionKey);
        sendOverrides.set(overrideKey, arg);
        emitObservationalEventSafely(deps, "sendpolicy:override_changed", {
          sessionKey,
          override: arg,
          changedBy: msg.senderId,
          timestamp: systemNowMs(),
        });
        await deps.deliveryService.deliverToChannel(
          adapter,
          msg.channelId,
          `Send policy override set to: ${arg}`,
          inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
        );
      } else {
        await deps.deliveryService.deliverToChannel(
          adapter, msg.channelId,
          "Only the session owner can change send policy overrides.",
          inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
        );
      }
      return { action: "handled" }; // Do not route to agent
    }
  }

  // -------------------------------------------------------------------
  // /approve and /deny COMMAND INTERCEPTION
  // -------------------------------------------------------------------
  if (msg.text && deps.approvalGate) {
    const result = await handleApprovalCommand(
      deps,
      adapter,
      msg,
      sessionKey,
      agentId,
      turnScope,
      conversationRef,
    );
    if (result) return { action: "handled" };
  }

  // -------------------------------------------------------------------
  // CONFIG COMMAND INTERCEPTION
  // -------------------------------------------------------------------
  if (msg.text && deps.handleConfigCommand) {
    const configParsed = parseSlashCommand(msg.text);
    if (configParsed.found && configParsed.command === "config") {
      const response = await deps.handleConfigCommand(configParsed.args, adapter.channelType);
      if (response) {
        await deps.deliveryService.deliverToChannel(
          adapter,
          msg.channelId,
          response,
          inboundDeliveryOptions(turnScope, conversationRef),
        );
        return { action: "handled" }; // Do not route to agent
      }
    }
  }

  // -------------------------------------------------------------------
  // /stop COMMAND INTERCEPTION
  // -------------------------------------------------------------------
  if (msg.text) {
    const stopParsed = parseSlashCommand(msg.text);
    if (stopParsed.found && stopParsed.command === "stop") {
      // Active-session lookup goes through the composite-key resolver.
      // `formattedKey` is retained as a diagnostic log field so
      // operators can correlate /stop-aborts with session traces.
      const formattedKey = formatSessionKey(sessionKey);
      const runHandle = deps.sessionResolver?.resolveActiveSession(conversationRef);
      if (runHandle) {
        try {
          await runHandle.abort();
          emitObservationalEventSafely(deps, "execution:aborted", {
            sessionKey,
            reason: "user_stop",
            agentId,
            timestamp: systemNowMs(),
          });
          deps.logger.info(
            { agentId, sessionKey: formattedKey },
            "Execution aborted by /stop command",
          );
          await deps.deliveryService.deliverToChannel(
            adapter,
            msg.channelId,
            "Execution stopped.",
            inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
          );
        } catch (abortError) {
          deps.logger.warn(
            {
              err: abortError,
              agentId,
              hint: "Abort call failed; execution may have already completed",
              errorKind: "internal" as const,
            },
            "Stop command abort failed",
          );
          await deps.deliveryService.deliverToChannel(
            adapter,
            msg.channelId,
            "Could not stop execution (may have already completed).",
            inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
          );
        }
      } else {
        await deps.deliveryService.deliverToChannel(
          adapter,
          msg.channelId,
          "No active execution to stop.",
          inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
        );
      }
      return { action: "handled" }; // Do not route to agent
    }
  }

  // -------------------------------------------------------------------
  // /export-trajectory — owner-gated bundle export
  //
  // Handled BEFORE the generic handleSlashCommand block because:
  //   1. handleSlashCommand(text, sessionKey, agentId) is synchronous-shaped
  //      and cannot carry the async DM side-effect to the owner.
  //   2. The handler needs direct access to msg + adapter for owner-gate
  //      (msg.senderId === sessionKey.userId) and DM routing (adapter.sendMessage).
  //
  // "export-trajectory" is also in KNOWN_COMMANDS so parseSlashCommand
  // returns found:true — the text NEVER reaches the LLM.
  // -------------------------------------------------------------------
  if (
    msg.text &&
    msg.text.trim().startsWith("/export-trajectory") &&
    deps.exportSessionBundle
  ) {
    return await handleExportTrajectory({
      msg,
      sessionKey,
      agentId,
      adapter,
      deliveryService: deps.deliveryService,
      deliveryOptions: inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
      exportSessionBundle: deps.exportSessionBundle,
      logger: deps.logger,
    });
  }

  // -------------------------------------------------------------------
  // GENERAL SLASH COMMAND INTERCEPTION
  // -------------------------------------------------------------------
  if (/^\/help\s*$/iu.test(msg.text ?? "")) {
    await deps.deliveryService.deliverToChannel(
      adapter,
      msg.channelId,
      localized(deps, msg, "help.commands"),
      inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
    );
    return { action: "handled" };
  }

  if (msg.text && deps.handleSlashCommand) {
    const cmdResult = await deps.handleSlashCommand(msg.text, sessionKey, agentId);
    if (cmdResult) {
      if (cmdResult.handled) {
        // Fully handled commands: send response and return (skip executor)
        if (cmdResult.response) {
          await deps.deliveryService.deliverToChannel(
            adapter,
            msg.channelId,
            cmdResult.response,
            inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
          );
        }
        return { action: "handled" };
      }
      // Directive commands (handled=false): pass directives and cleaned text to executor
      if (cmdResult.directives && Object.keys(cmdResult.directives).length > 0) {
        msg = {
          ...msg,
          text: cmdResult.cleanedText ?? msg.text,
          metadata: {
            ...msg.metadata,
            _commandDirectives: cmdResult.directives,
          },
        };
      }
    }
  }

  // -------------------------------------------------------------------
  // RESET TRIGGER PHRASE GATE
  // -------------------------------------------------------------------
  const resetTriggers = deps.getResetTriggers?.(agentId) ?? [];
  if (resetTriggers.length > 0 && msg.text && matchesResetTrigger(msg.text, resetTriggers)) {
    deps.logger.debug({
      step: "reset-trigger",
      agentId,
      channelType: adapter.channelType,
    }, "Reset trigger matched");
    const expired = deps.sessionManager.expire(turnScope.conversation);
    if (expired.ok && expired.value) {
      emitObservationalEventSafely(deps, "session:expired", {
        conversationScope: turnScope.conversation,
        reason: "auto-reset:trigger-phrase",
      });
    }
    // greetingGenerator deps slot has been deleted; static reset message
    // matches the production absent-mode behavior.
    await deps.deliveryService.deliverToChannel(
      adapter,
      msg.channelId,
      localized(deps, msg, "session.reset"),
      inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
    );
    return { action: "handled" }; // Do not route to agent
  }

  // Prompt skill detection (loadPromptSkill + getUserInvocableSkillNames deps
  // slots) has been removed. Both fields were never wired by the daemon; skill
  // commands now pass through as plain text to the agent (production
  // absent-mode).

  // Extract command directives from metadata (set by general slash command interception above)
  const directives = msg.metadata?._commandDirectives as Record<string, unknown> | undefined;

  return { action: "process", processedMsg: msg, directives };
}

// ---------------------------------------------------------------------------
// Approval command helper (keeps gate function readable)
// ---------------------------------------------------------------------------

/** Handle /approve and /deny commands. Returns true if command was handled. */
async function handleApprovalCommand(
  deps: GateDeps,
  adapter: ChannelPort,
  msg: NormalizedMessage,
  sessionKey: SessionKey,
  agentId: string,
  turnScope: ResolvedTurnScope,
  conversationRef: ConversationRef,
): Promise<boolean> {
  const text = msg.text!.trim();
  const gate = deps.approvalGate!;
  const formattedKey = formatSessionKey(sessionKey);
  const callbackPrincipal: InboundCallback = {
    tenantId: sessionKey.tenantId,
    channelType: turnScope.endpoint.channelType,
    channelKey: turnScope.endpoint.conversationId,
    ...(turnScope.endpoint.threadId === undefined ? {} : { threadId: turnScope.endpoint.threadId }),
    agentId,
    conversationRef,
    resolvingPrincipalId: turnScope.principal.principalId,
    sessionKey: formattedKey,
    rawData: text,
    inboundUserId: msg.senderId,
  };
  const ownedPending = () => gate.pendingForAuthority({
    tenantId: sessionKey.tenantId,
    agentId,
    conversationRef,
    resolvingPrincipalId: turnScope.principal.principalId,
  })
    .filter((request) => approvalRequestIsOwnedByInbound(request, callbackPrincipal));

  // Bare command (no arguments) -- auto-resolve if unambiguous
  const bareApproveMatch = /^\/approve\s*$/i.test(text);
  const bareDenyMatch = !bareApproveMatch && /^\/deny\s*$/i.test(text);

  if (bareApproveMatch || bareDenyMatch) {
    const isApprove = !!bareApproveMatch;
    const matches = ownedPending();

    if (matches.length === 0) {
      await deps.deliveryService.deliverToChannel(
        adapter,
        msg.channelId,
        localized(deps, msg, "approval.none_pending"),
        inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
      );
    } else if (matches.length === 1) {
      const approvedBy = `chat:${msg.senderId}`;
      gate.resolveApproval(matches[0].requestId, isApprove, approvedBy);
      await deps.deliveryService.deliverToChannel(
        adapter, msg.channelId,
        localized(deps, msg, "approval.resolved_one", {
          outcome: isApprove ? "approved" : "denied",
          action: matches[0].toolName ?? matches[0].action,
          id: matches[0].shortId,
        }),
        inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
      );
    } else {
      const lines = matches.map(
        (r) => `  ${r.shortId} - ${r.toolName ?? r.action}`,
      );
      const cmd = isApprove ? "/approve" : "/deny";
      await deps.deliveryService.deliverToChannel(
        adapter, msg.channelId,
        localized(deps, msg, "approval.multiple", {
          command: cmd,
          choices: lines.join("\n"),
        }),
        inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
      );
    }
    return true;
  }

  // Command with arguments
  const approveMatch = /^\/approve\s+(.+)/i.exec(text);
  const denyMatch = !approveMatch ? /^\/deny\s+(.+)/i.exec(text) : null;

  if (approveMatch || denyMatch) {
    const isApprove = !!approveMatch;
    // Preserve the argument's case: a shortId is a 12-char base62 token that
    // distinguishes case, so it must be matched case-sensitively. Only the
    // `all` keyword test is case-insensitive (lower-cased separately below).
    const arg = (approveMatch?.[1] ?? denyMatch?.[1] ?? "").trim();
    const approvedBy = `chat:${msg.senderId}`;

    if (arg.toLowerCase() === "all") {
      // Batch: resolve all pending approvals matching this session
      const matches = ownedPending();

      if (matches.length === 0) {
        await deps.deliveryService.deliverToChannel(
          adapter,
          msg.channelId,
          localized(deps, msg, "approval.none_pending_resolve"),
          inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
        );
      } else {
        for (const req of matches) {
          gate.resolveApproval(req.requestId, isApprove, approvedBy);
        }
        await deps.deliveryService.deliverToChannel(
          adapter, msg.channelId,
          localized(deps, msg, "approval.resolved_many", {
            outcome: isApprove ? "approved" : "denied",
            count: matches.length,
          }),
          inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
        );
      }
    } else {
      // Single: resolve by EXACT 12-char shortId. The full requestId
      // and its prefix never reach the channel, so the chat path no longer
      // accepts a requestId prefix — only the shortId shown in the prompt. The
      // shortId is unique, so an exact match yields at most one request.
      const match = ownedPending().find((r) => r.shortId === arg);

      if (match === undefined) {
        await deps.deliveryService.deliverToChannel(
          adapter, msg.channelId,
          localized(deps, msg, "approval.not_found", { id: arg }),
          inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
        );
      } else {
        gate.resolveApproval(match.requestId, isApprove, approvedBy);
        await deps.deliveryService.deliverToChannel(
          adapter, msg.channelId,
          localized(deps, msg, "approval.resolved_one", {
            outcome: isApprove ? "approved" : "denied",
            action: match.toolName ?? match.action,
            id: match.shortId,
          }),
          inboundDeliveryOptions(turnScope, conversationRef, { skipChunking: true }),
        );
      }
    }
    return true;
  }

  return false;
}
