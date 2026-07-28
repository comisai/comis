// SPDX-License-Identifier: Apache-2.0
/**
 * Session-index sub-module barrel.
 *
 * Public surface:
 *   - `appendSessionIndexEntry` — append one lifecycle event to the date-rolled JSONL file
 *   - `SessionIndexEvent` — typed session and execution lifecycle records
 *   - Individual event types for callers that want explicit shapes
 *
 * @module
 */

export { appendSessionIndexEntry } from "./append.js";
export type {
  SessionIndexEvent,
  SessionStartedEvent,
  ExecutionStartedEvent,
  TurnCompletedEvent,
  SessionEndedEvent,
} from "./types.js";
