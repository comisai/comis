// SPDX-License-Identifier: Apache-2.0
import type {
  ChannelPort,
  ElevatedReplyConfig,
  NormalizedMessage,
  SendPolicyConfig,
  SessionKey,
  TypedEventBus,
} from "@comis/core";
import {
  formatSessionKey,
  systemNowMs,
  tryGetContext,
} from "@comis/core";
import type { AgentExecutor, InboundMessageProvenancePlan } from "@comis/agent";
import type {
  ChannelRegistry,
  SendOverrideStore,
  SendPolicyContext,
} from "@comis/channels";
import {
  applySessionOverride,
  evaluateSendPolicy,
  isGroupMessage,
} from "@comis/channels";
import type { ComisLogger } from "@comis/core";
import type { CommandDirectives } from "../commands/index.js";
import { emitObservationalEvent } from "./execution-event-emitter.js";

export type ExecutionTrustLevel = "guest" | "user" | "admin";

interface ExecutionPolicyDeps {
  eventBus: TypedEventBus;
  logger: ComisLogger;
  sendPolicyConfig?: SendPolicyConfig;
  getElevatedReplyConfig?: (agentId: string) => ElevatedReplyConfig | undefined;
  channelRegistry?: ChannelRegistry;
}

interface ExecutionPolicyInput {
  deps: ExecutionPolicyDeps;
  adapter: ChannelPort;
  effectiveMsg: NormalizedMessage;
  originalMsg: NormalizedMessage;
  executor: AgentExecutor;
  sessionKey: SessionKey;
  agentId: string;
  sendOverrides: SendOverrideStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: any[];
  directives?: Record<string, unknown>;
  inboundProvenancePlans: readonly InboundMessageProvenancePlan[];
  onExecutionStart(): void;
  onExecutionComplete(): void;
}

interface ExecutionPolicyBase {
  effectiveMsg: NormalizedMessage;
  replyTo: string | undefined;
  trustLevel: ExecutionTrustLevel;
}

export type ExecutionPolicyResult =
  | (ExecutionPolicyBase & { kind: "continue" })
  | (ExecutionPolicyBase & {
      kind: "denied";
      result: Awaited<ReturnType<AgentExecutor["execute"]>>;
    });

/** Resolve the authorization level attached to a sender's execution context. */
export function resolveExecutionTrustLevel(
  config: ElevatedReplyConfig | undefined,
  senderId: string,
): ExecutionTrustLevel {
  if (senderId.startsWith("chat:") || senderId.startsWith("unknown:")) {
    return "guest";
  }
  if (!config?.enabled) return "user";
  const mapped = config.senderTrustMap[senderId] ?? config.defaultTrustLevel;
  return mapped === "admin" || mapped === "user" || mapped === "guest"
    ? mapped
    : "user";
}

/** Resolve send policy, reply routing, trust overrides, and the silent denied turn. */
export async function runExecutionPolicy(
  input: ExecutionPolicyInput,
): Promise<ExecutionPolicyResult> {
  const {
    deps,
    adapter,
    originalMsg,
    executor,
    sessionKey,
    agentId,
    sendOverrides,
  } = input;
  let effectiveMsg = input.effectiveMsg;
  const caps = deps.channelRegistry?.getCapabilities(adapter.channelType);
  const metaKey = caps?.replyToMetaKey;
  const replyTo =
    (isGroupMessage(originalMsg) || caps?.threadReplyInDm) &&
      metaKey && originalMsg.metadata?.[metaKey]
      ? String(originalMsg.metadata[metaKey])
      : undefined;

  const elevatedConfig = deps.getElevatedReplyConfig?.(agentId);
  const formattedSessionKey = formatSessionKey(sessionKey);
  const currentContext = tryGetContext();
  const trustLevel = currentContext?.agentId === agentId
    && currentContext.sessionKey === formattedSessionKey
    ? currentContext.trustLevel
    : resolveExecutionTrustLevel(elevatedConfig, effectiveMsg.senderId);

  if (deps.sendPolicyConfig?.enabled) {
    const policyContext: SendPolicyContext = {
      channelId: adapter.channelId,
      channelType: adapter.channelType,
      chatType: originalMsg.chatType ?? "dm",
    };
    const evaluated = evaluateSendPolicy(policyContext, deps.sendPolicyConfig);
    const decision = applySessionOverride(
      evaluated,
      sendOverrides.get(formatSessionKey(sessionKey)),
    );
    emitObservationalEvent(
      deps,
      decision.allowed ? "sendpolicy:allowed" : "sendpolicy:denied",
      {
        channelId: adapter.channelId,
        channelType: adapter.channelType,
        chatType: policyContext.chatType,
        reason: decision.reason,
        timestamp: systemNowMs(),
      },
    );
    if (!decision.allowed) {
      deps.logger.info(
        { channelId: adapter.channelId, reason: decision.reason },
        "Send policy denied outbound message",
      );
      input.onExecutionStart();
      try {
        const result = await executor.execute(
          effectiveMsg,
          sessionKey,
          input.tools,
          undefined,
          agentId,
          input.directives as CommandDirectives | undefined,
          undefined,
          {
            operationType: "interactive" as const,
            inboundProvenancePlans: input.inboundProvenancePlans,
          },
        );
        return { kind: "denied", effectiveMsg, replyTo, trustLevel, result };
      } finally {
        input.onExecutionComplete();
      }
    }
  }

  if (elevatedConfig?.enabled) {
    const route = elevatedConfig.trustModelRoutes[trustLevel];
    if (route) {
      emitObservationalEvent(deps, "elevated:model_routed", {
        sessionKey: formatSessionKey(sessionKey),
        senderTrustLevel: trustLevel,
        modelRoute: route,
        agentId,
        timestamp: systemNowMs(),
      });
      effectiveMsg = {
        ...effectiveMsg,
        metadata: { ...(effectiveMsg.metadata ?? {}), modelRoute: route },
      };
    }
    const promptOverride = elevatedConfig.trustPromptOverrides[trustLevel];
    if (promptOverride) {
      effectiveMsg = {
        ...effectiveMsg,
        metadata: {
          ...(effectiveMsg.metadata ?? {}),
          systemPromptOverride: promptOverride,
        },
      };
    }
  }

  return { kind: "continue", effectiveMsg, replyTo, trustLevel };
}
