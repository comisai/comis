// SPDX-License-Identifier: Apache-2.0
/**
 * The `videoHandlerDeps` dependency shape, extracted from
 * `api/types.ts` into its own leaf type module to keep `types.ts` under the
 * 800-line architecture cap (the video deps + their doc comments would push it
 * over). This is a TYPE-only module that imports only from `@comis/core` /
 * `@comis/skills` / `@comis/infra` / the sibling cost-limiter — nothing in the
 * `api/` handler graph imports it back, so it adds no madge cycle (same reasoning
 * the inline image shape cites; the video shape simply lives here instead).
 *
 * OBSERVABILITY SCOPE: the `trajectoryRegistry` + `eventBus` fields below are
 * OPTIONAL. The handler's logger floor (an INFO completion line + an ERROR/WARN
 * with errorKind+hint on every failure branch) always fires; when the fields are
 * present it ALSO direct-emits the in-turn
 * `video.requested`/`video.submitted`/`video.failed` trajectory records (so
 * `comis explain` reconstructs the turn) and — via the off-turn poller, which
 * emits the synthetic `observability:token_usage` cost route — the cost rollup.
 * The handler is logger-only when both fields are absent.
 *
 * @module
 */
import type { ComisLogger } from "@comis/infra";
import type { AppContainer } from "@comis/core";

/** Dependencies the `video.generate` RPC handler consumes. Mirrors the inline
 *  image `imageHandlerDeps` shape, retyped for video, with the pre-submit cost
 *  limiter and the optional trajectory/eventBus obs surface. */
export interface VideoHandlerDepsShape {
  provider: import("@comis/core").VideoGenerationPort;
  rateLimiter: import("@comis/skills").VideoGenRateLimiter;
  config: import("@comis/core").VideoGenerationConfig;
  logger: ComisLogger;
  /** Direct channel delivery -- resolve adapter by channel type. */
  getChannelAdapter: (channelType: string) => Pick<import("@comis/core").ChannelPort, "sendAttachment"> | undefined;
  /** Resolve the agent's main provider in lockstep with the completion
   *  path. OBS/lockstep ONLY — the provider INSTANCE is selected at wiring
   *  time (setup-video-provider.ts), NEVER re-derived here, so provider
   *  selection keeps a single source of truth. */
  resolveAgentMainProvider: (agentId: string) => { providerId: string };
  /** Resolve an `image_url` workspace file path under the caller's agent
   *  dir (safePath confinement) — the reference resolver is the image SSRF guard
   *  reused verbatim. */
  workspaceDirs: Map<string, string>;
  defaultWorkspaceDir: string;
  /** The per-agent persistence getter. Persists the generated video
   *  buffer to the agent's confined workspace (`~/.comis/workspace/media/
   *  videos/`) via MediaPersistenceService (raised maxBytes). Never throws —
   *  returns `err` on a persistence failure so the handler falls through to the
   *  size-capped base64 fallback. `PersistedFile` is on the `@comis/skills/tools`
   *  subpath (the proven import path). */
  persist: (
    agentId: string,
    buffer: Buffer,
    opts: { mediaKind: "video"; mimeType: string },
  ) => Promise<import("@comis/shared").Result<import("@comis/skills/tools").PersistedFile, Error>>;
  /** The per-agent/hour USD cost ceiling, gated
   *  PRE-submit against a worst-case estimate. Optional — undefined when
   *  `integrations.media.videoGeneration.maxCostPerHourUsd` is unset (count-only,
   *  no regression). When present the handler computes
   *  `est = estimateVideoCostUsd(...)` FIRST, then `canSpend(agentId, est)`
   *  BEFORE port.submit (block with quota_exceeded). The ACTUAL-cost reconcile
   *  `record(agentId, actual ?? est)` is now the POLLER's job (it runs the
   *  completion tail off-turn). The count rate limiter (maxPerHour) is RETAINED
   *  and orthogonal. */
  costLimiter?: import("./video-cost-limiter.js").VideoCostLimiter;
  /** The durable async job store. The handler `insert`s a `pending`
   *  row on a successful submit (jobId + routing + traceId + estimate), so the
   *  background poller resumes it across the agent turn AND a daemon restart. */
  videoJobStore: import("@comis/memory").VideoJobStore;
  /** Hand the submitted job to the background poller, which drives
   *  poll→done→fetchResult→persist→deliver→record→markDone off-turn.
   *  `track` takes the FULL in-memory `VideoJobRecord` the handler built (jobId +
   *  routing + traceId + estimate) so the poller drives delivery WITHOUT a
   *  listPending scan and the insert-failure path is delivered in-memory rather
   *  than orphaned. Narrow shape (only `track`) so the deps stay honest. */
  videoPoller: { track(record: import("@comis/memory").VideoJobRecord): void };
  /** The per-session trajectory recorder registry. The
   *  handler resolves the recorder by `_callerSessionKey` (createVideoObsEmitter)
   *  and DIRECT-emits the in-turn `video.requested`/`video.submitted`/
   *  `video.failed` lifecycle records (the image-handlers.ts precedent — no
   *  eventBus bridge in the daemon RPC context). Optional: `getRecorder?.()`
   *  no-ops on a boot mode without a registry; a null recorder is skipped (the
   *  logger floor still fires). Read off the BootContext `c.trajectoryRegistry`. */
  trajectoryRegistry?: import("@comis/observability").SessionTrajectoryHandleRegistry;
  /** The typed event bus. The handler does NOT
   *  emit the synthetic `observability:token_usage` cost row in-turn (the cost is
   *  unknown at submit — estimate only); the off-turn POLLER emits it on the
   *  terminal `done` branch. Threaded here for parity with the image
   *  handler deps + so the poller wiring reads the same instance. Optional. */
  eventBus?: AppContainer["eventBus"];
}

/** Dependencies the `video.status` RPC handler consumes. The READ side needs
 *  ONLY the agent-scoped store + a logger — far narrower than the
 *  `video.generate` deps (no provider / persist / deliver / cost / poller). Kept
 *  here beside `VideoHandlerDepsShape` so dispatch + main-helpers thread it from
 *  the SAME boot context. */
export interface VideoStatusHandlerDepsShape {
  /** The durable async job store. The handler reads
   *  `get(job_id, agentId)` — agent-scoped (filters BOTH columns), so a
   *  cross-agent jobId returns not-found, never the other agent's data.
   *  The SAME store instance the poller writes (single source). */
  videoJobStore: import("@comis/memory").VideoJobStore;
  logger: ComisLogger;
}
