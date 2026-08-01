// SPDX-License-Identifier: Apache-2.0
import { ok, type Result } from "@comis/shared";

export interface ModelBinding {
  readonly provider: string;
  readonly model: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function readBinding(value: unknown): ModelBinding | undefined {
  const record = asRecord(value);
  return typeof record?.provider === "string" && typeof record.model === "string"
    ? { provider: record.provider, model: record.model }
    : undefined;
}

function sameBinding(left: ModelBinding, right: ModelBinding): boolean {
  return left.provider === right.provider && left.model === right.model;
}

/**
 * Resolve the previous distinct model binding from successful, paired
 * model-configuration transitions on the active session branch.
 */
export function resolvePreviousModelBinding(
  entries: readonly unknown[],
  agentId: string,
  current: ModelBinding,
): Result<ModelBinding | undefined, never> {
  const pending = new Map<string, ModelBinding>();
  const transitions: ModelBinding[] = [];

  for (const value of entries) {
    const entry = asRecord(value);
    if (entry?.type === "model_change") {
      const binding = readBinding({
        provider: entry.provider,
        model: entry.modelId,
      });
      if (binding !== undefined) transitions.push(binding);
      continue;
    }
    if (entry?.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message === undefined) continue;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const blockValue of message.content) {
        const block = asRecord(blockValue);
        if (
          (block?.type !== "toolCall" && block?.type !== "tool_use")
          || block.name !== "agents_manage"
          || typeof block.id !== "string"
        ) {
          continue;
        }
        const args = asRecord(block.arguments ?? block.input);
        const config = asRecord(args?.config);
        if (
          args?.action !== "update"
          || args.agent_id !== agentId
        ) {
          continue;
        }
        const binding = readBinding(config);
        if (binding !== undefined) pending.set(block.id, binding);
      }
      continue;
    }

    if (
      (message.role !== "toolResult" && message.role !== "tool")
      || typeof message.toolCallId !== "string"
    ) {
      continue;
    }
    const binding = pending.get(message.toolCallId);
    if (binding === undefined) continue;
    if (message.isError === true) {
      pending.delete(message.toolCallId);
      continue;
    }
    const details = asRecord(message.details);
    if (details?.updated !== true || details.agentId !== agentId) continue;
    const confirmedBinding = readBinding(details.config) ?? binding;
    transitions.push(confirmedBinding);
    pending.delete(message.toolCallId);
  }

  const distinct: ModelBinding[] = [];
  for (const binding of transitions) {
    if (distinct.length === 0 || !sameBinding(distinct[distinct.length - 1], binding)) {
      distinct.push(binding);
    }
  }
  if (distinct.length < 2 || !sameBinding(distinct[distinct.length - 1], current)) {
    return ok(undefined);
  }
  return ok(distinct[distinct.length - 2]);
}
