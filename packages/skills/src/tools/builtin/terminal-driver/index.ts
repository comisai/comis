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
  type TerminalEvictedEvent,
} from "./terminal-tools.js";

// terminal_session_status is a REAL, classifier-backed, owner-scoped tool. Its body lives in
// terminal-status-tool.ts; terminal-tools-stubs.ts re-exports it so this import path is unchanged.
// Still never-export (the tool-metadata-registry entry is unchanged — default-deny preserved).
export { createTerminalSessionStatusTool } from "./terminal-tools-stubs.js";
export type { TerminalStatusView } from "./terminal-session-registry.js";

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

// Deterministic unattended honest-fail backstop: reap a turn's LIVE never-tasked drives at an
// unattended (webhook/cron) turn-end so the origin records an honest failure instead of a silent
// success with a leaked idle drive (the model-independent floor beneath the wait-tool
// `WAIT_TASK_NOT_DELIVERED_NOTE` best-effort recovery).
export { reapNeverTaskedDrives, type ReapUntaskedRegistry } from "./terminal-reap-untasked.js";

// The production worker-spawn posture helper (extracted from the registry to keep it
// under the 800-line cap; re-exported here so the package surface is unchanged).
export {
  buildProductionSpawnWorker,
  resolveWorkerMainPath,
  WORKER_PERMISSION_ARGS,
} from "./terminal-worker-launch.js";

// Socket-path helpers (PURE) — re-exported so the daemon's recover-on-boot
// liveness probe derives the SAME `<dataDir>/terminal-worker/tmux.sock` the worker binds.
// Importing for the re-export runs no side effect: worker-main's `main()` is `isEntryScript`-guarded.
export { terminalWorkerDir, resolveTmuxSocketPath } from "./terminal-worker-main.js";

// The no-secret host-allowlist egress proxy (EgressControlPort impl),
// moved here from @comis/daemon so the standalone worker process can construct
// its OWN egress for `network: listed-hosts` (the worker runs outside the jail
// and has network; the daemon also constructs one for the in-process test path).
export {
  createTerminalEgressProxy,
  type TerminalEgressProxyDeps,
  type EgressProxyLogger,
} from "./terminal-egress-proxy.js";

// The PERSISTENT, agent-scoped projects-root allocator (`<agentWorkspaceDir>/projects`).
// The daemon injects it as the registry's `allocateWorkspace` with a no-op
// `cleanupWorkspace`, so a driven session's work persists in the agent's own
// workspace instead of a throwaway /tmp dir. See its doc + buildScopeArgs' carve-out
// re-bind for the security posture (only this subtree is re-exposed in the jail).
export { prepareAgentTerminalWorkspace } from "./terminal-workspace.js";

// The per-session usage-cap primitive (closure-local counters + injected
// clock). The tool layer consumes createSessionCaps to REJECT on
// maxRequestsPerSession and EVICT on maxInteractions/wallClockMs.
export {
  createSessionCaps,
  type SessionCaps,
  type SessionLimits,
  type CapBreach,
} from "./terminal-caps.js";

// The injected-timer reaper (idle-TTL + wall-clock sweep + max-sessions
// overflow). The registry composes it; the tool layer reuses EvictReason on the same
// onEvict path for max_interactions. TYPE-ONLY TimerPort + injected clock — never @comis/infra.
export {
  createTerminalReaper,
  type TerminalReaper,
  type ReaperDeps,
  type ReaperSession,
  type EvictReason,
  type ReaperEvictInfo,
} from "./terminal-reaper.js";

// The length-prefixed IPC framer's max-frame guard — the registry's
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
// is the scope contract the daemon wiring maps config scope onto.
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
  type TmuxBackendLike,
} from "./terminal-worker-entry.js";

// The tmux worker backend — the THIRD loadBackend option (node-pty | pipe | tmux) for
// long-running sessions. tmux owns the PTY in a DETERMINISTICALLY-named session
// (comis-<sessionId>) so the server outlives the worker and a restart RE-ATTACHES
// (has-session → read the existing pane) rather than re-creating. The daemon binds the
// resolved tmux path + has-session probe into the loadTmux seam. Pure command builders +
// the FakePtyLike-shaped factory (a node-pty `tmux attach` that streams + drives);
// dependency-free (the one-shot runner + attach-pty spawner are injected). The live
// drive/survival test is Linux-gated.
export {
  createTmuxBackend,
  tmuxSessionName,
  buildTmuxSpawnArgv,
  buildTmuxHasSessionArgv,
  buildTmuxKillArgv,
  buildTmuxAttachArgv,
  buildTmuxSetOptionArgv,
  type TmuxBackendDeps,
} from "./terminal-tmux-backend.js";

// The pure state classifier + the load-bearing cursor-parked gate. The worker drives
// classifyFrame each settled frame; the session_status tool surfaces its state. Pure +
// infra-free + no raw clock — value-imports only node builtins + the render snapshot type.
export {
  classifyFrame,
  isCursorParked,
  type ClassifierState,
  type ClassifierFrame,
  type FrameHistory,
  type Classification,
} from "./terminal-classifier.js";

// The pure safe-only auto-answer policy. The woken turn calls decideAutoAnswer on a settled
// prompt — a safe-pattern match sends a canned keystroke via the send-guards; everything else
// (incl. auth/destructive/approval, escalate-always) escalates with no keystroke.
// Operator-dialable, never model-dialable; pure + infra-free (only @comis/core's
// scrubSecretsFromText).
export {
  decideAutoAnswer,
  type AutoAnswerMode,
  type AutoAnswerDecision,
} from "./terminal-auto-answer.js";

// Terminal Platform Profiles: the read-side per-platform perception/render profile registry.
// The daemon woken turn resolves a session's profile by its operator-declared allowId to feed
// `decideAutoAnswer` the profile's dialogs; the worker/classifier consume the render transform +
// perception package-internally. Selection is by allowId only.
export {
  getPlatformProfile,
  type TerminalPlatformProfile,
  type PlatformPerception,
  type PlatformDialog,
  type KeySpec,
} from "./platforms/index.js";

// The normalized region-scoped loop guard. The woken turn calls observe() on a settled prompt
// region — a repeated NORMALIZED prompt (spinner/timestamp/progress-only diff) escalates
// (terminal:escalated, reason loop_detected) and COMPOSES with the maxInteractions EVICT.
// Closure-local ring, injected clock, never-throw typed result; infra-free (only node:crypto).
export {
  createLoopGuard,
  type LoopGuard,
  type LoopGuardDeps,
} from "./terminal-loop-guard.js";

// The pure bounded content-free drive-state journal — a promoted drive's CROSS-WAKE MEMORY.
// The daemon woken-turn driver reads+updates it per wake via the closure-local
// Map<sessionId, DriveJournal> holder in setupTerminalWake. Pure shape +
// (de)serialize/append/oldest-trim; content-free and bounded.
export {
  emptyJournal,
  appendAnswered,
  appendStep,
  updateJournal,
  serializeJournal,
  deserializeJournal,
  CAP_ANSWERED,
  CAP_STEPS,
  TAG_MAX,
  type DriveJournal,
} from "./terminal-drive-journal.js";

// The pure bounded digest/diff read selector + the content-free one-line screen digest.
// The daemon woken-turn read applies boundedReadDigest to the returned view + threads
// screenDigestLine into the journal's lastScreenDigest (run through scrubSecretsFromText);
// the read tool delegates to boundedReadDigest (digest default). Pure, byte-capped, never throws.
export {
  boundedReadDigest,
  screenDigestLine,
  READ_DIGEST_BYTE_CAP,
  type DriveReadMode,
  type ReadDigest,
} from "./terminal-read-digest.js";

// The pure re-attach DECISION + the persisted durable session IDENTITY. The registry's
// recover-on-boot consumes reattachDecision; the daemon (de)serializes descriptors via
// serialize/deserialize for the durable descriptor store. Pure, total, infra-free (injected
// has-session probe); the descriptor (de)serialize rejects a malformed/partial identity to
// undefined (corrupt-skip, never partial-trust authorization).
export {
  reattachDecision,
  serializeDescriptor,
  deserializeDescriptor,
  type SessionDescriptor,
  type ReattachDecision,
} from "./terminal-reattach-match.js";

// The recover-on-boot SCAN orchestrator + the injected descriptor-store port + the
// rehydrate/persist/durable-lost helpers the registry delegates to (kept here so the
// 800-line registry stays lean). The daemon implements SessionDescriptorStorePort as the
// fs-safe durable descriptor store + injects it onto the registry deps. Pure via the injected
// port; consumes reattachDecision; the bulk lives here, not the registry.
export {
  recoverSessionDescriptors,
  rehydrateHandleFromDescriptor,
  buildSessionDescriptor,
  applyRecoveredSessions,
  markRunningSessionsLost,
  staysRecoverable,
  type SessionDescriptorStorePort,
  type RecoveredAction,
  type DurableCreateInputs,
  type TerminalDurabilityDeps,
} from "./terminal-session-reattach.js";

// The pure busy-vs-hung predicate: the liveness backstop turns it into a synthesized `stuck`
// ONLY on `"hung"`, and the reaper idle exclusion consumes it on `"busy"` — ONE shared
// definition of "alive and making progress". Promoted to the barrel here as its first
// cross-package consumer.
export { busyOrHung, type BusySignal, type BusyVerdict } from "./terminal-busy-predicate.js";

// The pure spend-ceiling check over the drive journal's run-total cost — the wake-turn loop
// escalates/stops on a breach (never a silent overspend).
export { checkSpendCeiling, type SpendBreach } from "./terminal-spend-ceiling.js";

// The pure three-way wake decision + the terminal-outcome map (done/needs-you/failed). The
// daemon wake-notify wiring is their first consumer.
export {
  decideWakeAction,
  mapTerminalOutcome,
  type OutcomeInputs,
  type EscalationReason,
} from "./terminal-drive-outcome.js";

// The pure drive.notify gate — needs-you ALWAYS fires; done/failed suppressed only under
// "none". Consumed by the outcome-notify wiring.
export { shouldNotifyOutcome, type NotifyPolicy } from "./terminal-notify-policy.js";

// The pure content-free heartbeat one-liner from the drive journal. The heartbeat cadence
// timer notifies it for each promoted drive.
export { heartbeatLine } from "./terminal-heartbeat-digest.js";

// The transition-only in-worker attention emitter — the WORKER half of the no-poll mechanism.
// The worker calls observe() with each settled frame's classification; the emitter writes a
// redaction-safe TerminalEventFrame to the injected fd3-writer ONLY on a state TRANSITION
// (edge-, not level-triggered) — NO timer, NO clock. Closure-local last-state; infra-free
// (only the terminal-ipc framer).
export {
  createAttentionEmitter,
  type AttentionEmitter,
  type AttentionEmitterDeps,
  type ObserveOptions,
} from "./terminal-attention-emitter.js";
