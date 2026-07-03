// SPDX-License-Identifier: Apache-2.0
/**
 * Barrel for the pure activity projections. Re-exports the chat and
 * ACP projections, the coalesce engine, and the projection config types.
 */
export { chatProjection } from "./chat-projection.js";
export type { ProjectionConfig } from "./chat-projection.js";
export { acpProjection } from "./acp-projection.js";
export { coalesce, CHAT_COALESCE_RULES } from "./coalesce.js";
export type { CoalesceResult, ActivityVerbosity } from "./coalesce.js";
