// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type {
  HookBeforeAgentStartResult,
  HookBeforeToolCallResult,
  HookToolResultPersistResult,
  HookBeforeCompactionResult,
  HookBeforeDeliveryResult,
} from "../ports/hook-types.js";

// ─── Zod Schemas for Hook Result Validation ──────────────────────

export const BeforeAgentStartResultSchema = z.strictObject({
  systemPrompt: z.string().max(50_000).optional(),
  prependContext: z.string().max(50_000).optional(),
});

export const BeforeToolCallResultSchema = z.strictObject({
  params: z.record(z.string(), z.unknown()).optional(),
  block: z.boolean().optional(),
  blockReason: z.string().optional(),
});

export const ToolResultPersistResultSchema = z.strictObject({
  result: z.string().optional(),
});

export const BeforeCompactionResultSchema = z.strictObject({
  cancel: z.boolean().optional(),
  cancelReason: z.string().optional(),
});

export const BeforeDeliveryResultSchema = z.strictObject({
  text: z.string().max(50_000).optional(),
  cancel: z.boolean().optional(),
  cancelReason: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ─── Merge Strategies ────────────────────────────────────────────

export function mergeBeforeAgentStart(
  acc: HookBeforeAgentStartResult | undefined,
  next: HookBeforeAgentStartResult,
): HookBeforeAgentStartResult {
  return {
    systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
    prependContext: next.prependContext ?? acc?.prependContext,
  };
}

export function mergeBeforeToolCall(
  acc: HookBeforeToolCallResult | undefined,
  next: HookBeforeToolCallResult,
): HookBeforeToolCallResult {
  return {
    params: next.params ?? acc?.params,
    block: next.block ?? acc?.block,
    blockReason: next.blockReason ?? acc?.blockReason,
  };
}

export function mergeToolResultPersist(
  acc: HookToolResultPersistResult | undefined,
  next: HookToolResultPersistResult,
): HookToolResultPersistResult {
  return {
    result: next.result ?? acc?.result,
  };
}

export function mergeBeforeCompaction(
  acc: HookBeforeCompactionResult | undefined,
  next: HookBeforeCompactionResult,
): HookBeforeCompactionResult {
  return {
    cancel: next.cancel ?? acc?.cancel,
    cancelReason: next.cancelReason ?? acc?.cancelReason,
  };
}

export function mergeBeforeDelivery(
  acc: HookBeforeDeliveryResult | undefined,
  next: HookBeforeDeliveryResult,
): HookBeforeDeliveryResult {
  return {
    text: next.text ?? acc?.text,
    cancel: next.cancel ?? acc?.cancel,
    cancelReason: next.cancelReason ?? acc?.cancelReason,
    metadata: next.metadata ?? acc?.metadata,
  };
}
