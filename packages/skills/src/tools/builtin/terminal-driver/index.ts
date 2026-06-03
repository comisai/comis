// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/skills terminal-driver barrel — the public surface the daemon wiring
 * (composition root, `setup-tools.ts`) consumes: the nine AgentTool factories
 * (eight implemented + one stub [`status`]), the `TerminalSessionRegistry`
 * constructor + its production worker-spawn helper, and the allowlist + IPC types
 * the wiring needs to map config → `AllowEntryLike` and to type the injected ports.
 *
 * Re-exported through `../../index.js` (the `./tools` subpath). The public-export
 * consumer is the daemon wiring (it constructs the registry + pushes the tools).
 *
 * @module
 */

// The eight implemented tools + their shared deps contract.
export {
  createTerminalSessionCreateTool,
  createTerminalSessionReadTool,
  createTerminalSessionListTool,
  createTerminalSessionKillTool,
  createTerminalSessionSendTextTool,
  createTerminalSessionSendKeyTool,
  createTerminalSessionResizeTool,
  createTerminalSessionWaitTool,
  type TerminalToolDeps,
  type ToolLogger as TerminalToolLogger,
  type TerminalEventBus,
  type TerminalStateEvent,
  type TerminalSpawnFailedEvent,
} from "./terminal-tools.js";

// The lone remaining stub tool (registered, never-export, rejects not_implemented → Phase 124).
export { createTerminalSessionStatusTool } from "./terminal-tools-stubs.js";

// The daemon-side session registry.
export {
  createTerminalSessionRegistry,
  type TerminalSessionRegistry,
  type TerminalSessionRegistryDeps,
  type RegistryLogger,
  type FakeWorkerChild,
  type CreateRequest,
  type CreateResult,
  type TerminalView,
  type SessionHandle,
  type SessionListing,
  type SessionStatus,
  type SessionOwner,
} from "./terminal-session-registry.js";

// The production worker-spawn posture helper (extracted from the registry to keep it
// under the 800-line cap; re-exported here so the package surface is unchanged).
export {
  buildProductionSpawnWorker,
  WORKER_PERMISSION_ARGS,
} from "./terminal-worker-launch.js";

// P4 OPS-03/06: the per-session usage-cap primitive (closure-local counters + injected
// clock). The tool layer (Plan 05) consumes createSessionCaps to REJECT on
// maxRequestsPerSession and EVICT on maxInteractions/wallClockMs.
export {
  createSessionCaps,
  type SessionCaps,
  type SessionLimits,
  type CapBreach,
} from "./terminal-caps.js";

// The length-prefixed IPC framer's max-frame guard (HR-01) — the registry's
// stdout handler branches on FrameTooLargeError to drop a corrupt worker.
export {
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  type TerminalReplyFrame,
  type TerminalRequestFrame,
  type TerminalEventFrame,
  type TerminalFrame,
} from "./terminal-ipc.js";

// The canonical-binary allowlist matcher + the config-mapping types. `TerminalScope`
// is the SEC-02 scope contract the daemon wiring maps config scope onto (122-01 is
// the SOLE writer of this barrel in Wave 1).
export {
  matchAllowEntry,
  buildDirectSpawn,
  canonicalize,
  type AllowEntryLike,
  type AllowMatch,
  type AllowMatchResult,
  type TerminalScope,
} from "./allowlist-matcher.js";

// The supervised worker entry (the daemon wires its production spawn posture).
export {
  createTerminalWorker,
  defaultLoadPty,
  type TerminalWorker,
  type TerminalWorkerDeps,
} from "./terminal-worker-entry.js";
