// SPDX-License-Identifier: Apache-2.0
// @comis/shared - Foundation types and utilities

export type { Result } from "./result.js";
export { ok, err, tryCatch, fromPromise } from "./result.js";
export { suppressError } from "./suppress-error.js";
export { withTimeout, TimeoutError } from "./timeout.js";
export { checkAborted } from "./abort.js";
// Permission-model fsync refusal predicate — lets fsync sites degrade
// gracefully under `node --permission` (which disables the fsync API).
export { isFsyncDisabledByPermissionModel } from "./fsync-permission.js";
export { createTTLCache } from "./ttl-cache.js";
export type { TTLCache, TTLCacheOptions } from "./ttl-cache.js";

// Silent-token detection for agent responses.
export {
  stripReplyTags,
  isSilentResponse,
  NO_REPLY_TOKEN,
  HEARTBEAT_OK_TOKEN,
  SILENT_PREFIX,
} from "./silent-tokens.js";

// VisibleDeliveryRecord: JSONL-persisted-but-not-prompt-injected delivery metadata.
export type { VisibleDeliveryKind, VisibleDeliveryRecord } from "./visible-delivery.js";

// Canonical sanitized MCP tool name parser.
export { extractMcpServerName } from "./mcp-tool-name.js";
