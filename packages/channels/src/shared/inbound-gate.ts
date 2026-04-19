/**
 * Inbound Pipeline Phase 3: Message Gate.
 *
 * Evaluates auto-reply rules, handles slash commands (/send, /approve,
 * /deny, /config, /stop, general commands), reset triggers, and prompt
 * skill detection. Returns a gate decision indicating whether the message
 * should be processed, skipped, or was handled inline (command response sent).
 *
 * @module
 */

import type { ChannelPort, NormalizedMessage, SessionKey, AutoReplyEngineConfig } from "@comis/core";
import { formatSessionKey } from "@comis/core";
import { parseSlashCommand, matchPromptSkillCommand } from "@comis/agent";

import type { InboundPipelineDeps } from "./inbound-pipeline.js";
import { evaluateAutoReply, isGroupMessage } from "./auto-reply-engine.js";
import { matchesResetTrigger } from "./inbound-pipeline.js";
import { deliverToChannel } from "./deliver-to-channel.js";
import type { SendOverrideStore } from "./send-policy.js";

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
  | "groupHistoryBuffer"
  | "commandQueue"
  | "sessionLabelStore"
  | "getResetTriggers"
  | "greetingGenerator"
  | "loadPromptSkill"
  | "getUserInvocableSkillNames"
  | "approvalGate"
  | "handleConfigCommand"
  | "handleSlashCommand"
  | "activeRunRegistry"
>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Gate decision: what should happen with this message. */
export type GateDecision =
  | { action: "process"; processedMsg: NormalizedMessage; directives?: Record<string, unknown> }
  | { action: "handled" }
  | { action: "skip" };

// ---------------------------------------------------------------------------
// Phase function
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
  sendOverrides: SendOverrideStore,
): Promise<GateDecision> {
  let msg = processedMsg;

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
      deps.eventBus.emit("autoreply:activated", {
        channelId: msg.channelId,
        senderId: msg.senderId,
        activationMode: arConfig.groupActivation,
        reason: decision.reason,
        timestamp: Date.now(),
      });
      // Continue to routing + execution below
    } else if (decision.action === "inject-history") {
      deps.eventBus.emit("autoreply:suppressed", {
        channelId: msg.channelId,
        senderId: msg.senderId,
        reason: decision.reason,
        injectedAsHistory: true,
        timestamp: Date.now(),
      });

      // Push to group history ring buffer for context injection
      if (deps.groupHistoryBuffer) {
        deps.groupHistoryBuffer.push(formatSessionKey(sessionKey), msg);
      }

      // Route history injection through command queue for serialization
      if (deps.commandQueue) {
        const historyEnqueueResult = await deps.commandQueue.enqueue(sessionKey, msg, adapter.channelType, async () => {
          // No-op execution: serialized with concurrent executions via queue.
          // Lightweight save to append message as history context.
          const existing = deps.sessionManager.loadOrCreate(sessionKey);
          deps.sessionManager.save(sessionKey, [
            ...existing.slice(-(arConfig.maxHistoryInjections - 1)),
            { role: "user" as const, content: `[${msg.senderId}]: ${msg.text ?? ""}` },
          ]);
        });
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
      deps.eventBus.emit("autoreply:suppressed", {
        channelId: msg.channelId,
        senderId: msg.senderId,
        reason: decision.reason,
        injectedAsHistory: false,
        timestamp: Date.now(),
      });
      deps.logger.debug({
        step: "auto-reply-suppressed",
        channelType: adapter.channelType,
        chatId: msg.channelId,
        reason: decision.reason,
      }, "Auto-reply suppressed");
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
        deps.eventBus.emit("sendpolicy:override_changed", {
          sessionKey,
          override: arg,
          changedBy: msg.senderId,
          timestamp: Date.now(),
        });
        await deliverToChannel(adapter, msg.channelId, `Send policy override set to: ${arg}`, { skipChunking: true });
      } else {
        await deliverToChannel(
          adapter, msg.channelId,
          "Only the session owner can change send policy overrides.",
          { skipChunking: true },
        );
      }
      return { action: "handled" }; // Do not route to agent
    }
  }

  // -------------------------------------------------------------------
  // /approve and /deny COMMAND INTERCEPTION (APPR-CHAT)
  // -------------------------------------------------------------------
  if (msg.text && deps.approvalGate) {
    const result = await handleApprovalCommand(deps, adapter, msg, sessionKey);
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
        await deliverToChannel(adapter, msg.channelId, response);
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
      const formattedKey = formatSessionKey(sessionKey);
      const runHandle = deps.activeRunRegistry?.get(formattedKey);
      if (runHandle) {
        try {
          await runHandle.abort();
          deps.eventBus.emit("execution:aborted", {
            sessionKey,
            reason: "user_stop",
            agentId,
            timestamp: Date.now(),
          });
          deps.logger.info(
            { agentId, sessionKey: formattedKey },
            "Execution aborted by /stop command",
          );
          await deliverToChannel(adapter, msg.channelId, "Execution stopped.", { skipChunking: true });
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
          await deliverToChannel(adapter, msg.channelId, "Could not stop execution (may have already completed).", { skipChunking: true });
        }
      } else {
        await deliverToChannel(adapter, msg.channelId, "No active execution to stop.", { skipChunking: true });
      }
      return { action: "handled" }; // Do not route to agent
    }
  }

  // -------------------------------------------------------------------
  // GENERAL SLASH COMMAND INTERCEPTION (CMD-WIRE)
  // -------------------------------------------------------------------
  if (msg.text && deps.handleSlashCommand) {
    const cmdResult = await deps.handleSlashCommand(msg.text, sessionKey, agentId);
    if (cmdResult) {
      if (cmdResult.handled) {
        // Fully handled commands: send response and return (skip executor)
        if (cmdResult.response) {
          await deliverToChannel(adapter, msg.channelId, cmdResult.response, { skipChunking: true });
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
    deps.sessionManager.expire(sessionKey);
    deps.eventBus.emit("session:expired", {
      sessionKey,
      reason: "auto-reset:trigger-phrase",
    });
    let resetMessage = "Session reset.";
    if (deps.greetingGenerator) {
      const greetingResult = await deps.greetingGenerator.generate(agentId);
      if (greetingResult.ok) {
        resetMessage = greetingResult.value;
      }
    }
    await deliverToChannel(adapter, msg.channelId, resetMessage, { skipChunking: true });
    return { action: "handled" }; // Do not route to agent
  }

  // -------------------------------------------------------------------
  // PROMPT SKILL DETECTION
  // -------------------------------------------------------------------
  if (msg.text && deps.loadPromptSkill && deps.getUserInvocableSkillNames) {
    const systemCmd = parseSlashCommand(msg.text);
    if (!systemCmd.found) {
      const skillNames = deps.getUserInvocableSkillNames();
      const skillMatch = matchPromptSkillCommand(msg.text, skillNames);
      if (skillMatch) {
        const loadResult = await deps.loadPromptSkill(skillMatch.name, skillMatch.args || undefined);
        if (loadResult.ok) {
          const skill = loadResult.value;
          msg = {
            ...msg,
            text: skillMatch.args || "",
            metadata: {
              ...msg.metadata,
              promptSkillContent: skill.content,
              promptSkillAllowedTools: skill.allowedTools.length > 0 ? skill.allowedTools : undefined,
              promptSkillName: skill.skillName,
            },
          };
          deps.eventBus.emit("skill:prompt_invoked", {
            skillName: skill.skillName,
            invokedBy: "user",
            args: skillMatch.args,
            timestamp: Date.now(),
          });
        } else {
          deps.logger.warn(
            { skillName: skillMatch.name, err: loadResult.error, hint: "Check skill manifest and file accessibility", errorKind: "config" as const },
            "Failed to load prompt skill",
          );
        }
      }
    }
  }

  // Extract command directives from metadata (set by CMD-WIRE interception above)
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
): Promise<boolean> {
  const text = msg.text!.trim();
  const gate = deps.approvalGate!;

  // Bare command (no arguments) -- auto-resolve if unambiguous
  const bareApproveMatch = /^\/approve\s*$/i.test(text);
  const bareDenyMatch = !bareApproveMatch && /^\/deny\s*$/i.test(text);

  if (bareApproveMatch || bareDenyMatch) {
    const isApprove = !!bareApproveMatch;
    const formattedKey = formatSessionKey(sessionKey);
    const pending = gate.pending();
    const matches = pending.filter((r) => r.sessionKey === formattedKey);

    if (matches.length === 0) {
      await deliverToChannel(adapter, msg.channelId, "No pending approvals.", { skipChunking: true });
    } else if (matches.length === 1) {
      const approvedBy = `chat:${msg.senderId}`;
      gate.resolveApproval(matches[0].requestId, isApprove, approvedBy);
      const verb = isApprove ? "Approved" : "Denied";
      await deliverToChannel(
        adapter, msg.channelId,
        `${verb}: ${matches[0].toolName ?? matches[0].action} (${matches[0].requestId.slice(0, 8)})`,
        { skipChunking: true },
      );
    } else {
      const lines = matches.map(
        (r) => `  ${r.requestId.slice(0, 8)} - ${r.toolName ?? r.action}`,
      );
      const cmd = isApprove ? "/approve" : "/deny";
      await deliverToChannel(
        adapter, msg.channelId,
        `Multiple pending approvals. Specify an ID or use "${cmd} all":\n${lines.join("\n")}`,
        { skipChunking: true },
      );
    }
    return true;
  }

  // Command with arguments
  const approveMatch = /^\/approve\s+(.+)/i.exec(text);
  const denyMatch = !approveMatch ? /^\/deny\s+(.+)/i.exec(text) : null;

  if (approveMatch || denyMatch) {
    const isApprove = !!approveMatch;
    const arg = (approveMatch?.[1] ?? denyMatch?.[1] ?? "").trim().toLowerCase();
    const approvedBy = `chat:${msg.senderId}`;

    if (arg === "all") {
      // Batch: resolve all pending approvals matching this session
      const formattedKey = formatSessionKey(sessionKey);
      const pending = gate.pending();
      const matches = pending.filter((r) => r.sessionKey === formattedKey);

      if (matches.length === 0) {
        await deliverToChannel(adapter, msg.channelId, "No pending approvals to resolve.", { skipChunking: true });
      } else {
        for (const req of matches) {
          gate.resolveApproval(req.requestId, isApprove, approvedBy);
        }
        const verb = isApprove ? "Approved" : "Denied";
        await deliverToChannel(
          adapter, msg.channelId,
          `${verb} ${matches.length} pending approval(s).`,
          { skipChunking: true },
        );
      }
    } else {
      // Single: resolve by request ID prefix match
      const pending = gate.pending();
      const match = pending.find((r) => r.requestId.startsWith(arg));

      if (!match) {
        await deliverToChannel(
          adapter, msg.channelId,
          `No pending approval found for ID: ${arg} (may have already been resolved or timed out).`,
          { skipChunking: true },
        );
      } else {
        gate.resolveApproval(match.requestId, isApprove, approvedBy);
        const verb = isApprove ? "Approved" : "Denied";
        await deliverToChannel(
          adapter, msg.channelId,
          `${verb}: ${match.toolName ?? match.action} (${match.requestId.slice(0, 8)})`,
          { skipChunking: true },
        );
      }
    }
    return true;
  }

  return false;
}
