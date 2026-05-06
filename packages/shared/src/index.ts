// SPDX-License-Identifier: Apache-2.0
// @comis/shared - Foundation types and utilities

export type { Result } from "./result.js";
export { ok, err, tryCatch, fromPromise } from "./result.js";
export { suppressError } from "./suppress-error.js";
export { withTimeout, TimeoutError } from "./timeout.js";
export { checkAborted } from "./abort.js";
export { createTTLCache } from "./ttl-cache.js";
export type { TTLCache, TTLCacheOptions } from "./ttl-cache.js";

// Silent-token detection for agent responses (R5, RC-4).
export {
  stripReplyTags,
  isSilentResponse,
  NO_REPLY_TOKEN,
  HEARTBEAT_OK_TOKEN,
  SILENT_PREFIX,
} from "./silent-tokens.js";

// VisibleDeliveryRecord: JSONL-persisted-but-not-prompt-injected delivery
// metadata (R5 invariant 37).
export type { VisibleDeliveryKind, VisibleDeliveryRecord } from "./visible-delivery.js";
