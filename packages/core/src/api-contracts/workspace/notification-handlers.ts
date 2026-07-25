// SPDX-License-Identifier: Apache-2.0
/**
 * Notification-handlers contract slice.
 *
 * Mirrors `packages/daemon/src/api/notification-handlers.ts` (1 method).
 * Spread order in `NOTIFICATION_HANDLERS_CONTRACTS` is determinism-critical
 * for codegen output stability (`contracts.generated.*` byte-identity).
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "../types.js";
import { ChannelEndpointSchema } from "../../domain/conversation-scope.js";

// ===========================================================================
// --- notification-handlers.ts ---
// ===========================================================================

/**
 * `notification.send` — bridge from the agent tool to the
 * NotificationService. RPC scope. The handler resolves `_agentId`
 * from internals, validates the chain-depth guard (rejects calls
 * where `origin === "notification"` to prevent recursive notification
 * chains), and maps tool-param names (`channel_type`, `channel_id`)
 * to NotifyUserOptions (`channelType`, `channelId`).
 *
 * Request: `{ message, priority?, channel_type?, channel_id?, destination_endpoint?, origin? }`.
 * The contract uses the snake_case names the handler reads
 * (`channel_type` / `channel_id`) because tools call into the daemon
 * with snake_case keys; the handler is responsible for the camelCase
 * mapping at the service boundary. `priority` is
 * `z.enum(["low","normal","high","critical"])` — the handler casts
 * directly without validation, but the enum here documents the
 * intended set + lets the dev-mode response parse catch future drift.
 *
 * Response: `{ success: boolean, entryId?: string, error?: string }`
 * — modeled as a union of the success shape and the error shape via
 * separate optional fields so it stays inside the 12-shape allowlist.
 * The handler returns one of:
 *   - `{ success: true, entryId }` on `notifyUser` returning `ok`.
 *   - `{ success: false, error }` on missing `message`, on the
 *     chain-depth guard, or on `notifyUser` returning `err`.
 */
export const NotificationSendContract = defineContract({
  method: "notification.send",
  request: z.object({
    message: z.string().optional(),
    priority: z.enum(["low", "normal", "high", "critical"]).optional(),
    channel_type: z.string().optional(),
    channel_id: z.string().optional(),
    destination_endpoint: ChannelEndpointSchema.optional(),
    origin: z.string().optional(),
  }),
  response: z.object({
    success: z.boolean(),
    entryId: z.string().optional(),
    error: z.string().optional(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * notification-handlers slice (1 contract). Spread order is
 * determinism-critical for codegen output stability.
 */
export const NOTIFICATION_HANDLERS_CONTRACTS = [
  NotificationSendContract,
] as const;
