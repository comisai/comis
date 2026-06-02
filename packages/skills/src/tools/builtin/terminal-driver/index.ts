// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/skills terminal-driver barrel — the public surface the daemon wiring
 * (composition root, `setup-tools.ts`) consumes: the nine AgentTool factories
 * (four implemented + five stubs), the `TerminalSessionRegistry` constructor +
 * its production worker-spawn helper, and the allowlist + IPC types the wiring
 * needs to map config → `AllowEntryLike` and to type the injected ports.
 *
 * Re-exported through `../../index.js` (the `./tools` subpath). The public-export
 * consumer is the daemon wiring (it constructs the registry + pushes the tools).
 *
 * @module
 */

// The four implemented tools + their shared deps contract.
export {
  createTerminalSessionCreateTool,
  createTerminalSessionReadTool,
  createTerminalSessionListTool,
  createTerminalSessionKillTool,
  type TerminalToolDeps,
  type ToolLogger as TerminalToolLogger,
  type TerminalEventBus,
  type TerminalStateEvent,
  type TerminalSpawnFailedEvent,
} from "./terminal-tools.js";

// The five not-yet-implemented stub tools (registered, never-export, reject not_implemented).
export {
  createTerminalSessionSendTextTool,
  createTerminalSessionSendKeyTool,
  createTerminalSessionWaitTool,
  createTerminalSessionStatusTool,
  createTerminalSessionResizeTool,
} from "./terminal-tools-stubs.js";

// The daemon-side session registry + its production worker-spawn posture helper.
export {
  createTerminalSessionRegistry,
  buildProductionSpawnWorker,
  WORKER_PERMISSION_ARGS,
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
} from "./terminal-session-registry.js";

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

// The canonical-binary allowlist matcher + the config-mapping types.
export {
  matchAllowEntry,
  buildDirectSpawn,
  canonicalize,
  type AllowEntryLike,
  type AllowMatch,
} from "./allowlist-matcher.js";

// The supervised worker entry (the daemon wires its production spawn posture).
export {
  createTerminalWorker,
  defaultLoadPty,
  type TerminalWorker,
  type TerminalWorkerDeps,
} from "./terminal-worker-entry.js";
