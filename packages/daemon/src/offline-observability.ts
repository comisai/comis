// SPDX-License-Identifier: Apache-2.0
/**
 * Narrow daemon-owned read surface for local observability tools.
 *
 * This entry point intentionally excludes daemon startup, channel adapters,
 * model providers, and other runtime wiring. The CLI loads it on demand when
 * assembling reports directly from an operator-owned data directory.
 */

export {
  assembleIncidentReportFromSources,
} from "./api/obs-handlers/obs-explain.js";
export {
  makeRealReader,
  resolveSessionFilePath,
} from "./api/obs-handlers/obs-explain-readers.js";
export {
  assembleSystemHealthReport,
} from "./api/obs-handlers/system-health.js";
export {
  extractSessionMessages,
} from "./api/obs-handlers/session-messages.js";
export type {
  SessionMessagesFilter,
  ExtractedChannelMessage,
  SessionMessagesCoverage,
  SessionMessagesResult,
} from "./api/obs-handlers/session-messages.js";
