// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type {
  HookBeforeAgentStartResult,
  HookBeforeCompactionResult,
  HookBeforeDeliveryResult,
} from "../ports/hook-types.js";

// ─── Zod Schemas for Hook Result Validation ──────────────────────

export const BeforeAgentStartResultSchema = z.strictObject({
  systemPrompt: z.string().max(50_000).optional(),
  prependContext: z.string().max(50_000).optional(),
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
