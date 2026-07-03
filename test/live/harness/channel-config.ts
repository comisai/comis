// SPDX-License-Identifier: Apache-2.0
/**
 * channel-config.ts — shared harness for the CHANNELS scenario tests.
 *
 * Provides:
 *   1. The channel enumeration tables (ALL_CHANNELS = the 10 registered adapters;
 *      REAL_CHANNELS = the 9 non-echo channels) — the single source of truth for
 *      the credential-validation loop.
 *   2. Streaming / queue / dmScope / delivery-timing config-OBJECT builders that
 *      round-trip every mode-value through the REAL @comis/core Zod schemas
 *      (StreamingConfigSchema / QueueConfigSchema / DmScopeConfigSchema /
 *      DeliveryTimingConfigSchema) — never an invented shape.
 *
 * CRITICAL — schema fidelity:
 *   - chunk/typing/table/reply are ENUMS, not booleans:
 *       chunk  ∈ {paragraph,newline,sentence,length}
 *       typing ∈ {never,instant,thinking,message}
 *       table  ∈ {code,bullets,off}
 *       reply  ∈ {off,first,all}
 *       useMarkdownIR : boolean
 *   - queue.defaultMode ∈ {followup,collect,steer,steer+followup}
 *   - queue.defaultOverflow.policy ∈ {drop-old,drop-new,summarize}
 *   - delivery-timing.mode ∈ {off,natural,custom,adaptive}
 *   - DmScopeConfig.mode ∈ {main,per-peer,per-channel-peer,per-account-channel-peer}
 *     (the REAL enum — NOT {global,agent,session,channel}, which are stale matrix labels).
 *
 * These builders are PURE — they return config OBJECTS (no temp YAML, no daemon),
 * because the CHAN scenarios drive the product schemas/functions directly. Mirrors
 * the file layout / `{...Schema.parse({}), ...overrides}` idiom of web-config.ts.
 *
 * @module
 */

import {
  StreamingConfigSchema,
  QueueConfigSchema,
  DeliveryTimingConfigSchema,
  DmScopeConfigSchema,
} from "@comis/core";
import type {
  StreamingConfig,
  QueueConfig,
  DeliveryTimingConfig,
  DmScopeConfig,
} from "@comis/core";

/** The 10 registered channel adapters (the 9 real launch-set channels + the echo loopback). */
export type ChannelType =
  | "discord"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "signal"
  | "line"
  | "irc"
  | "email"
  | "imessage"
  | "echo";

/**
 * All 10 registered channel adapters, in a stable order. The 10 channels are
 * the 9 real + echo. Single source of truth for the credential-validation loop.
 */
export const ALL_CHANNELS = [
  "discord",
  "telegram",
  "slack",
  "whatsapp",
  "signal",
  "line",
  "irc",
  "email",
  "imessage",
  "echo",
] as const satisfies readonly ChannelType[];

/**
 * The 9 real launch-set channels (ALL_CHANNELS minus echo). Each has a PUBLIC
 * exported credential-validator in @comis/channels; echo is the keyless loopback
 * (no credential-validator — its golden round-trip is its coverage).
 */
export const REAL_CHANNELS = [
  "discord",
  "telegram",
  "slack",
  "whatsapp",
  "signal",
  "line",
  "irc",
  "email",
  "imessage",
] as const satisfies readonly ChannelType[];

/**
 * Build a real StreamingConfig from the schema defaults with optional overrides.
 * The return type is the real @comis/core StreamingConfig, so any invented field
 * is a compile error.
 */
export function buildStreamingConfig(overrides?: Partial<StreamingConfig>): StreamingConfig {
  return { ...StreamingConfigSchema.parse({}), ...overrides };
}

/** Build a real QueueConfig from the schema defaults with optional overrides. */
export function buildQueueConfig(overrides?: Partial<QueueConfig>): QueueConfig {
  return { ...QueueConfigSchema.parse({}), ...overrides };
}

/**
 * Build a real DmScopeConfig from the schema defaults with optional overrides.
 * mode ∈ {main,per-peer,per-channel-peer,per-account-channel-peer} (the REAL enum).
 */
export function buildDmScopeConfig(overrides?: Partial<DmScopeConfig>): DmScopeConfig {
  return { ...DmScopeConfigSchema.parse({}), ...overrides };
}

/** Build a real DeliveryTimingConfig from the schema defaults with optional overrides. */
export function buildDeliveryTimingConfig(
  overrides?: Partial<DeliveryTimingConfig>,
): DeliveryTimingConfig {
  return { ...DeliveryTimingConfigSchema.parse({}), ...overrides };
}
