// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the Phase-189 background video poller (JOB-02 / JOB-03 — the
 * milestone's durability keystone).
 *
 * The poller is the two-phase crash-safe delivery queue (setup-delivery.ts)
 * retyped for an EXTERNAL-provider poll: it drives a tracked job
 * poll→done→fetchResult→persist→deliver(sendAttachment)→record→markDone (markDone
 * LAST — at-least-once), markFailed+WARN on failed/timeout, and on boot
 * `startAndResume()` reloads `listPending()` rows + resumes each so the finished
 * clip reaches the RECORDED channel even though the originating turn is gone.
 *
 * Deterministic by construction: the per-job loop uses the SHIPPED `pollUntilDone`
 * with an INJECTED `sleep` (resolves immediately) + `nowMs` (fake clock), and the
 * outer sweeper uses an injected `createFakeTimers()` TimerPort (advance + unref
 * recording). No real timers, no real waits.
 *
 * MUST-DIFFER from the delivery queue (asserted here):
 *  1. external-provider poll via `pollUntilDone` (genuinely-new outer code).
 *  2. `sendAttachment`, NOT `sendMessage` (no text-queue routing).
 *  3. explicit off-turn `traceId` ON the log object (no ALS frame in the bg ctx).
 *  4. at-least-once: `markDone` AFTER delivery (one bounded restart-duplicate).
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ok, err } from "@comis/shared";
import { ensureVideoJobTable, createVideoJobStore } from "@comis/memory";
import type { VideoJobStore, VideoJobRecord } from "@comis/memory";
import type { VideoGenerationConfig } from "@comis/core";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createVideoPoller, type VideoPoller } from "./setup-video-poller.js";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const SMALL_MP4 = Buffer.from("fake-mp4-bytes");

const PERSISTED_OK = {
  filePath: "/home/agent/.comis/workspace/media/videos/abc123.mp4",
  relativePath: "videos/abc123.mp4",
  mimeType: "video/mp4",
  sizeBytes: 42_424,
  mediaKind: "video" as const,
  savedAt: 0,
};

/** A minimal video-gen config the poller reads (timeout/poll cadence). */
function makeConfig(overrides: Partial<VideoGenerationConfig> = {}): VideoGenerationConfig {
  return {
    provider: "fal",
    defaultDurationSecs: 8,
    defaultAspectRatio: "16:9",
    defaultResolution: "720p",
    maxPerHour: 5,
    timeoutMs: 300_000,
    pollIntervalMs: 10_000,
    fallbackChain: [],
    ...overrides,
  } as unknown as VideoGenerationConfig;
}

/** The in-memory VideoJobRecord the handler hands to `track()` (WR-02/WR-06: the
 *  poller no longer re-reads it from listPending — the handler already has the
 *  routing in scope at submit). Defaults match the seeded `fal-req-abc123` row. */
function makeRecord(overrides: Partial<VideoJobRecord> = {}): VideoJobRecord {
  return {
    jobId: "fal-req-abc123",
    provider: "fal",
    model: "fal-ai/veo3.1/fast",
    agentId: "alpha",
    channelType: "telegram",
    channelId: "ch-recorded",
    traceId: "trace-seed",
    state: "pending",
    estimatedCostUsd: 2.4,
    deliverAttempts: 0,
    submittedAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

interface MockProvider {
  id: string;
  isAvailable: () => boolean;
  submit: ReturnType<typeof vi.fn>;
  poll: ReturnType<typeof vi.fn>;
  fetchResult: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

function makeProvider(overrides: Partial<MockProvider> = {}): MockProvider {
  return {
    id: "fal",
    isAvailable: () => true,
    submit: vi.fn(),
    poll: vi.fn().mockResolvedValue(ok({ jobId: "fal-req-abc123", state: "done" })),
    fetchResult: vi.fn().mockResolvedValue(
      ok({ buffer: SMALL_MP4, mimeType: "video/mp4", costUsd: 0.8, model: "fal-ai/veo3.1/fast", provider: "fal", durationSecs: 8 }),
    ),
    execute: vi.fn(),
    ...overrides,
  };
}

/** A spy-wrapper over a frozen VideoJobStore so tests can assert call counts
 *  (the real store is Object.freeze'd → vi.spyOn cannot redefine its methods).
 *  Each method delegates to the real store (hits the real :memory: db). */
function spyStore(real: VideoJobStore): VideoJobStore & {
  markDoneSpy: ReturnType<typeof vi.fn>;
  markFailedSpy: ReturnType<typeof vi.fn>;
  incrementSpy: ReturnType<typeof vi.fn>;
} {
  const markDoneSpy = vi.fn((...args: Parameters<VideoJobStore["markDone"]>) => real.markDone(...args));
  const markFailedSpy = vi.fn((...args: Parameters<VideoJobStore["markFailed"]>) => real.markFailed(...args));
  const incrementSpy = vi.fn((...args: Parameters<VideoJobStore["incrementDeliveryAttempt"]>) =>
    real.incrementDeliveryAttempt(...args),
  );
  return {
    insert: (...a) => real.insert(...a),
    listPending: () => real.listPending(),
    get: (...a) => real.get(...a),
    markDone: markDoneSpy as unknown as VideoJobStore["markDone"],
    markFailed: markFailedSpy as unknown as VideoJobStore["markFailed"],
    updateProgress: (...a) => real.updateProgress(...a),
    incrementDeliveryAttempt: incrementSpy as unknown as VideoJobStore["incrementDeliveryAttempt"],
    markDoneSpy,
    markFailedSpy,
    incrementSpy,
  };
}

interface MockPollerDeps {
  store: ReturnType<typeof spyStore>;
  provider: MockProvider;
  persist: ReturnType<typeof vi.fn>;
  costLimiter: { record: ReturnType<typeof vi.fn> };
  sendAttachment: ReturnType<typeof vi.fn>;
  /** DEL-03 (Phase 192): the link/notice degrade path sends via sendMessage. */
  sendMessage: ReturnType<typeof vi.fn>;
  getChannelAdapter: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof createMockLogger>;
  timers: ReturnType<typeof createFakeTimers>;
  sleep: ReturnType<typeof vi.fn>;
  nowMs: () => number;
  /** OBS-03 (Phase 192): the event bus the off-turn synthetic
   *  `observability:token_usage` cost route emits on. */
  eventBus: { emit: ReturnType<typeof vi.fn> };
}

/** The OBS-03 synthetic cost event shape (the loose `observability:token_usage`
 *  payload the poller emits + token-tracker SUMs). */
interface TokenUsageEvent {
  traceId: string;
  agentId: string;
  channelId: string;
  sessionKey: string;
  provider: string;
  model: string;
  tokens: { prompt: number; completion: number; total: number };
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** Find the OBS-03 synthetic cost emits the poller fired on the bus. */
function tokenUsageEmits(deps: MockPollerDeps): TokenUsageEvent[] {
  return deps.eventBus.emit.mock.calls
    .filter((c) => c[0] === "observability:token_usage")
    .map((c) => c[1] as TokenUsageEvent);
}

/**
 * Build the poller + its mock deps. Uses a real in-`:memory:` VideoJobStore so
 * the restart-resume case can seed a real pending row, and a fake clock/timer so
 * nothing waits.
 */
function makePoller(opts: {
  provider?: MockProvider;
  sendAttachment?: ReturnType<typeof vi.fn>;
  /** DEL-03 (Phase 192): the link/notice degrade send spy (defaults to ok). */
  sendMessage?: ReturnType<typeof vi.fn>;
  adapterHasSend?: boolean; // false → IRC-style adapter without sendAttachment
  persist?: ReturnType<typeof vi.fn>;
  config?: VideoGenerationConfig;
  seedRows?: Array<Record<string, unknown>>;
  // OBS-04 (Phase 192): an optional trajectory registry — when provided the
  // poller best-effort live-emits video.* off-turn via getRecorder(sessionKey).
  trajectoryRegistry?: { getRecorder: ReturnType<typeof vi.fn> };
  // DEL-03 (Phase 192): an optional video-size override (the media-compressor
  // maxVideoBytes knob). A small value forces the default fixture oversized.
  maxVideoBytes?: number;
  // CR-01 (Phase 192): the resolved video secrets bound for exact-match scrub.
  videoSecrets?: readonly string[];
} = {}): { poller: VideoPoller; deps: MockPollerDeps; db: Database.Database } {
  const db = new Database(":memory:");
  ensureVideoJobTable(db);
  const real = createVideoJobStore(db);
  const store = spyStore(real);

  // Seed pending rows. Default: ONE row matching makeRecord()'s jobId so the
  // store's markDone/markFailed/incrementDeliveryAttempt writes land on a real
  // DB row (the handler inserts the row at submit, then calls track with the
  // in-memory record). The sweeper/startAndResume rebuild records FROM these
  // rows. Tests override via `seedRows`.
  const rows = opts.seedRows ?? [{ jobId: "fal-req-abc123" }];
  for (const row of rows) {
    void real.insert({
      jobId: "seed-job",
      provider: "fal",
      model: "fal-ai/veo3.1/fast",
      agentId: "alpha",
      channelType: "telegram",
      channelId: "ch-recorded",
      traceId: "trace-seed",
      state: "pending",
      estimatedCostUsd: 2.4,
      submittedAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      ...row,
    });
  }

  const provider = opts.provider ?? makeProvider();
  const sendAttachment = opts.sendAttachment ?? vi.fn().mockResolvedValue(ok("msg-1"));
  const sendMessage = opts.sendMessage ?? vi.fn().mockResolvedValue(ok("notice-1"));
  // DEL-03: the link/notice degrade calls sendMessage (a REQUIRED ChannelPort
  // method, present on every adapter). An IRC-style adapter (adapterHasSend:false)
  // still exposes sendMessage — it just lacks sendAttachment (the capability gate).
  const adapter = opts.adapterHasSend === false ? { sendMessage } : { sendAttachment, sendMessage };
  const getChannelAdapter = vi.fn().mockReturnValue(adapter);
  const persist = opts.persist ?? vi.fn().mockResolvedValue(ok(PERSISTED_OK));
  const costLimiter = { record: vi.fn() };
  const logger = createMockLogger();
  const timers = createFakeTimers();
  const sleep = vi.fn().mockResolvedValue(undefined);
  const eventBus = { emit: vi.fn() };
  let clock = 0;
  const nowMs = () => clock; // never advances on its own → deadline only via explicit jumps

  const deps: MockPollerDeps = {
    store, provider, persist, costLimiter, sendAttachment, sendMessage, getChannelAdapter, logger, timers, sleep, nowMs, eventBus,
  };

  const poller = createVideoPoller({
    store,
    provider: provider as never,
    persist: persist as never,
    costLimiter,
    getChannelAdapter: getChannelAdapter as never,
    config: opts.config ?? makeConfig(),
    logger,
    timers,
    sleep,
    nowMs,
    eventBus: eventBus as never,
    ...(opts.trajectoryRegistry ? { trajectoryRegistry: opts.trajectoryRegistry as never } : {}),
    ...(opts.maxVideoBytes !== undefined ? { maxVideoBytes: opts.maxVideoBytes } : {}),
    ...(opts.videoSecrets !== undefined ? { videoSecrets: opts.videoSecrets } : {}),
  });
  void clock;
  return { poller, deps, db };
}

/** A capture recorder + a registry resolving it by sessionKey (OBS-04). */
function captureRegistry(): { calls: Array<{ type: string; data: Record<string, unknown> }>; getRecorder: ReturnType<typeof vi.fn> } {
  const calls: Array<{ type: string; data: Record<string, unknown> }> = [];
  const recorder = {
    recordEvent: vi.fn((type: string, data: Record<string, unknown>) => {
      calls.push({ type, data });
    }),
  };
  return { calls, getRecorder: vi.fn(() => recorder) };
}

/** Flush the microtask queue so fire-and-forget runJob loops settle. The full
 *  chain is poll→fetchResult→persist→sendAttachment→markDone→info — each an
 *  await — so the default count is generous. */
async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("createVideoPoller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── JOB-02 happy path: poll→done→fetch→persist→deliver→record→markDone ───
  it("drives a tracked job to completion: persist once, deliver via sendAttachment, record actual cost, markDone", async () => {
    const { poller, deps } = makePoller();
    const markDoneSpy = deps.store.markDoneSpy;
    poller.track(makeRecord());
    await flush();

    expect(deps.provider.poll).toHaveBeenCalled();
    expect(deps.provider.fetchResult).toHaveBeenCalledTimes(1);
    expect(deps.persist).toHaveBeenCalledTimes(1);
    expect((deps.persist.mock.calls[0]![2] as { mediaKind: string }).mediaKind).toBe("video");
    // delivered via sendAttachment (NOT sendMessage) to the recorded channel.
    expect(deps.getChannelAdapter).toHaveBeenCalledWith("telegram");
    expect(deps.sendAttachment).toHaveBeenCalledTimes(1);
    const attachment = deps.sendAttachment.mock.calls[0]![1] as { type: string; url: string };
    expect(attachment.type).toBe("video");
    expect(attachment.url).toBe(PERSISTED_OK.filePath);
    // cost reconciled to the ACTUAL (0.8), not the estimate.
    expect(deps.costLimiter.record).toHaveBeenCalledWith("alpha", 0.8);
    // markDone called once with the persisted path.
    expect(markDoneSpy).toHaveBeenCalledTimes(1);
    expect(markDoneSpy.mock.calls[0]![0]).toBe("fal-req-abc123");
    expect((markDoneSpy.mock.calls[0]![1] as { mediaPath: string }).mediaPath).toBe(PERSISTED_OK.filePath);
  });

  // The record the handler tracks carries the routing for the announce directly
  // (WR-02/WR-06: the poller no longer re-reads it from listPending — the handler
  // already has agentId/channelType/channelId/traceId in scope at submit).
  it("delivers to the RECORDED channel/agent carried on the tracked record", async () => {
    // Seed a row whose channel differs from any default, then track its record.
    const { poller, deps } = makePoller({
      seedRows: [{ jobId: "fal-req-abc123", agentId: "beta", channelType: "discord", channelId: "ch-beta" }],
    });
    poller.track(makeRecord({ agentId: "beta", channelType: "discord", channelId: "ch-beta" }));
    await flush();
    expect(deps.getChannelAdapter).toHaveBeenCalledWith("discord");
    expect(deps.sendAttachment.mock.calls[0]![0]).toBe("ch-beta");
    expect(deps.costLimiter.record).toHaveBeenCalledWith("beta", 0.8);
  });

  // ─── JOB-02 failed branch ───
  it("markFailed + WARN(errorKind+hint+jobId+traceId) on a failed poll; NO sendAttachment, NO markDone", async () => {
    const provider = makeProvider({
      poll: vi.fn().mockResolvedValue(ok({ jobId: "fal-req-abc123", state: "failed" })),
    });
    const { poller, deps } = makePoller({ provider, seedRows: [{ jobId: "fal-req-abc123" }] });
    const markFailedSpy = deps.store.markFailedSpy;
    const markDoneSpy = deps.store.markDoneSpy;
    poller.track(makeRecord());
    await flush();

    expect(markFailedSpy).toHaveBeenCalledTimes(1);
    expect(markFailedSpy.mock.calls[0]![0]).toBe("fal-req-abc123");
    expect(deps.sendAttachment).not.toHaveBeenCalled();
    expect(markDoneSpy).not.toHaveBeenCalled();
    const w = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_failed",
    );
    expect(w).toBeTruthy();
    expect((w![0] as { errorKind?: string }).errorKind).toBeTruthy();
    expect((w![0] as { hint?: string }).hint).toBeTruthy();
    expect((w![0] as { jobId?: string }).jobId).toBe("fal-req-abc123");
    // MUST-DIFFER 3: traceId is on the object explicitly (read from the row).
    expect((w![0] as { traceId?: string }).traceId).toBe("trace-seed");
  });

  // ─── JOB-02 timeout branch (job_timeout) ───
  it("markFailed('job_timeout') + WARN when the deadline is exceeded (poll stays pending)", async () => {
    // poll always pending; the deadline is hit because nowMs jumps past timeoutMs.
    let clock = 0;
    const provider = makeProvider({
      poll: vi.fn().mockResolvedValue(ok({ jobId: "fal-req-abc123", state: "pending" })),
    });
    const db = new Database(":memory:");
    ensureVideoJobTable(db);
    const store = spyStore(createVideoJobStore(db));
    void store.insert({
      jobId: "fal-req-abc123", provider: "fal", model: "m", agentId: "alpha",
      channelType: "telegram", channelId: "ch", traceId: "trace-seed",
      state: "pending", estimatedCostUsd: 2.4, submittedAtMs: 0, updatedAtMs: 0,
    });
    const markFailedSpy = store.markFailedSpy;
    const logger = createMockLogger();
    const sleep = vi.fn().mockImplementation(async () => { clock += 60_000; }); // each sleep advances the clock
    const poller = createVideoPoller({
      store, provider: provider as never, persist: vi.fn().mockResolvedValue(ok(PERSISTED_OK)) as never,
      costLimiter: { record: vi.fn() }, getChannelAdapter: vi.fn().mockReturnValue({ sendAttachment: vi.fn() }) as never,
      config: makeConfig({ timeoutMs: 120_000, pollIntervalMs: 10_000 } as Partial<VideoGenerationConfig>),
      logger, timers: createFakeTimers(), sleep, nowMs: () => clock,
    });
    poller.track(
      makeRecord({ model: "m", channelId: "ch", submittedAtMs: 0, updatedAtMs: 0 }),
    );
    await flush(40);

    expect(markFailedSpy).toHaveBeenCalledTimes(1);
    expect(markFailedSpy.mock.calls[0]![1]).toBe("job_timeout");
    const w = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { videoErrorKind?: string }).videoErrorKind === "job_timeout",
    );
    expect(w).toBeTruthy();
    expect((w![0] as { hint?: string }).hint).toBeTruthy();
    expect((w![0] as { jobId?: string }).jobId).toBe("fal-req-abc123");
  });

  // ─── I8 obs floor: done branch INFO line carries traceId from the row ───
  it("emits an INFO completion line with jobId + traceId (from the row) + costUsd + durationMs", async () => {
    const { poller, deps } = makePoller({ seedRows: [{ jobId: "fal-req-abc123", traceId: "trace-seed" }] });
    poller.track(makeRecord({ traceId: "trace-seed" }));
    await flush();
    const info = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_complete",
    );
    expect(info).toBeTruthy();
    expect((info![0] as { jobId?: string }).jobId).toBe("fal-req-abc123");
    // MUST-DIFFER 3: traceId is explicit (the bg ctx has no ALS frame).
    expect((info![0] as { traceId?: string }).traceId).toBe("trace-seed");
    expect((info![0] as { costUsd?: number }).costUsd).toBe(0.8);
    expect(typeof (info![0] as { durationMs?: number }).durationMs).toBe("number");
  });

  // ─── OBS-04 (Phase 192): off-turn best-effort live trajectory emits ───
  it("done branch best-effort live-emits video.generated THEN video.delivered from the ROW's sessionKey (off-turn, not ALS)", async () => {
    const reg = captureRegistry();
    const { poller } = makePoller({ trajectoryRegistry: reg });
    poller.track(makeRecord({ sessionKey: "default:u1:telegram:c1" }));
    await flush();
    // The recorder was resolved by the ROW's sessionKey (the off-turn key — there
    // is NO ALS frame in the poller tick).
    expect(reg.getRecorder).toHaveBeenCalledWith("default:u1:telegram:c1");
    const types = reg.calls.map((c) => c.type);
    expect(types).toContain("video.generated");
    expect(types).toContain("video.delivered");
    // Order: generated before delivered.
    expect(types.indexOf("video.generated")).toBeLessThan(types.indexOf("video.delivered"));
    // video.generated carries the cost-carry (actual cost 0.8 from the fetch).
    const gen = reg.calls.find((c) => c.type === "video.generated")!;
    expect(gen.data).toMatchObject({ provider: "fal", outcome: "ok", costUsd: 0.8 });
    // video.delivered records the channelType + delivered:true (sent ok).
    const del = reg.calls.find((c) => c.type === "video.delivered")!;
    expect(del.data).toEqual({ channelType: "telegram", delivered: true });
  });

  it("off-turn safety: getRecorder→undefined (recorder gone) → NO throw, NO record, the INFO floor STILL fires", async () => {
    // The common off-turn case: the session closed / the daemon restarted, so the
    // in-memory registry has no recorder. The live emit must no-op (the OFFLINE
    // assembler in Plan 02 is the binding oracle); the §2.7 INFO line survives.
    const reg = { getRecorder: vi.fn(() => undefined) };
    const { poller, deps } = makePoller({ trajectoryRegistry: reg });
    poller.track(makeRecord({ sessionKey: "gone-session" }));
    await flush();
    expect(reg.getRecorder).toHaveBeenCalledWith("gone-session");
    // The completion INFO line STILL fired (the logger-only floor is intact).
    const info = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_complete",
    );
    expect(info).toBeTruthy();
  });

  it("a job with NO sessionKey (old row) does not resolve a recorder; the INFO floor still fires (graceful)", async () => {
    const reg = captureRegistry();
    const { poller, deps } = makePoller({ trajectoryRegistry: reg });
    // makeRecord() with sessionKey explicitly cleared (a pre-192 / in-flight row).
    poller.track(makeRecord({ sessionKey: undefined }));
    await flush();
    expect(reg.getRecorder).not.toHaveBeenCalled();
    expect(reg.calls).toHaveLength(0);
    const info = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_complete",
    );
    expect(info).toBeTruthy();
  });

  it("fail branch best-effort live-emits video.failed {errorKind, provider} from the ROW's sessionKey (beside the WARN)", async () => {
    // A provider that polls to `failed` (a thrown poll → the generic
    // empty_response fallback) so the markFailed branch runs.
    const provider = makeProvider({ poll: vi.fn().mockResolvedValue(err(new Error("boom"))) });
    const reg = captureRegistry();
    const { poller, deps } = makePoller({ provider, trajectoryRegistry: reg });
    poller.track(makeRecord({ sessionKey: "default:u1:telegram:c1" }));
    await flush();
    expect(reg.getRecorder).toHaveBeenCalledWith("default:u1:telegram:c1");
    const failed = reg.calls.find((c) => c.type === "video.failed");
    expect(failed).toBeDefined();
    expect(failed!.data).toEqual({ errorKind: "empty_response", provider: "fal" });
    // SEC-03 / non-regression: the §2.7 WARN with the pinned step still fires.
    const w = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_failed",
    );
    expect(w).toBeTruthy();
  });

  it("no trajectoryRegistry (boot without one) → done branch does not throw and delivers normally", async () => {
    // The poller's obs deps are optional; absent → no live emit, the floor + the
    // delivery path are unaffected.
    const { poller, deps } = makePoller(); // no trajectoryRegistry
    poller.track(makeRecord({ sessionKey: "s" }));
    await flush();
    expect(deps.sendAttachment).toHaveBeenCalledTimes(1);
    expect(deps.store.markDoneSpy).toHaveBeenCalledTimes(1);
  });

  // ─── OBS-03 (Phase 192): the off-turn synthetic observability:token_usage cost route ───
  it("done branch emits observability:token_usage EXACTLY ONCE: cost.total === actual, tokens 0, fields from the ROW (not ALS)", async () => {
    const { poller, deps } = makePoller({
      seedRows: [{ jobId: "fal-req-abc123", agentId: "alpha", channelType: "telegram", channelId: "ch-recorded", traceId: "trace-seed" }],
    });
    poller.track(makeRecord({ agentId: "alpha", channelId: "ch-recorded", traceId: "trace-seed", sessionKey: "default:u1:telegram:c1" }));
    await flush();

    const emits = tokenUsageEmits(deps);
    // EXACTLY ONCE per render (markDone already flipped the row out of pending,
    // so the done branch cannot repeat for one render — Pitfall 3).
    expect(emits).toHaveLength(1);
    const ev = emits[0]!;
    // The actual cost from the FAL fetch (0.8) rides cost.total; tokens all 0
    // (A3: subscribers SUM cost.total, never divide — a 0-token event is safe).
    expect(ev.cost.total).toBeCloseTo(0.8, 4);
    expect(ev.tokens).toEqual({ prompt: 0, completion: 0, total: 0 });
    // MUST-DIFFER 3: the routing comes from the persisted ROW (no ALS frame off-turn).
    expect(ev.traceId).toBe("trace-seed");
    expect(ev.agentId).toBe("alpha");
    expect(ev.channelId).toBe("ch-recorded");
    expect(ev.sessionKey).toBe("default:u1:telegram:c1");
    expect(ev.provider).toBe("fal");
  });

  it("FAL has no per-call actual → the synthetic cost.total falls back to the row's estimatedCostUsd (Pitfall 4)", async () => {
    // A FAL-style fetch result with NO costUsd (the queue API reports no per-call
    // cost). The cost route bills the estimate (the same `?? estimate` fallback
    // costLimiter.record uses) so the rollup + the reconstruct agree.
    const provider = makeProvider({
      fetchResult: vi.fn().mockResolvedValue(
        ok({ buffer: SMALL_MP4, mimeType: "video/mp4", model: "fal-ai/veo3.1/fast", provider: "fal", durationSecs: 8 }),
      ),
    });
    const { poller, deps } = makePoller({
      provider,
      seedRows: [{ jobId: "fal-req-abc123", estimatedCostUsd: 1.5 }],
    });
    poller.track(makeRecord({ estimatedCostUsd: 1.5, sessionKey: "s" }));
    await flush();

    const emits = tokenUsageEmits(deps);
    expect(emits).toHaveLength(1);
    expect(emits[0]!.cost.total).toBeCloseTo(1.5, 4);
  });

  it("a render with no actual AND a zero estimate emits NO synthetic cost event (gated > 0)", async () => {
    const provider = makeProvider({
      fetchResult: vi.fn().mockResolvedValue(
        ok({ buffer: SMALL_MP4, mimeType: "video/mp4", model: "m", provider: "fal", durationSecs: 8 }),
      ),
    });
    const { poller, deps } = makePoller({
      provider,
      seedRows: [{ jobId: "fal-req-abc123", estimatedCostUsd: 0 }],
    });
    poller.track(makeRecord({ estimatedCostUsd: 0, sessionKey: "s" }));
    await flush();

    expect(tokenUsageEmits(deps)).toHaveLength(0);
    // The delivery still happened — only the cost emit is gated, not the render.
    expect(deps.store.markDoneSpy).toHaveBeenCalledTimes(1);
  });

  it("no eventBus (boot without one) → done branch does not throw and delivers normally", async () => {
    // The eventBus dep is optional; absent → no synthetic cost emit, delivery
    // path unaffected (the cost route is gated on deps.eventBus).
    const db = new Database(":memory:");
    ensureVideoJobTable(db);
    const store = spyStore(createVideoJobStore(db));
    void store.insert({
      jobId: "fal-req-abc123", provider: "fal", model: "m", agentId: "alpha",
      channelType: "telegram", channelId: "ch", traceId: "trace-seed",
      state: "pending", estimatedCostUsd: 2.4, submittedAtMs: 0, updatedAtMs: 0,
    });
    const poller = createVideoPoller({
      store, provider: makeProvider() as never, persist: vi.fn().mockResolvedValue(ok(PERSISTED_OK)) as never,
      costLimiter: { record: vi.fn() }, getChannelAdapter: vi.fn().mockReturnValue({ sendAttachment: vi.fn().mockResolvedValue(ok("m")) }) as never,
      config: makeConfig(), logger: createMockLogger(), timers: createFakeTimers(), sleep: vi.fn().mockResolvedValue(undefined), nowMs: () => 0,
      // NO eventBus
    });
    poller.track(makeRecord({ channelId: "ch", sessionKey: "s" }));
    await flush();
    expect(store.markDoneSpy).toHaveBeenCalledTimes(1);
  });

  // ─── OBS-01 (Phase 192): the completion INFO line carries the full field set ───
  it("OBS-01: the video_poll_complete INFO line carries videoProvider/model/costUsd/sizeBytes/durationMs/durationSecs/mimeType/traceId/jobId/agentId", async () => {
    const { poller, deps } = makePoller({ seedRows: [{ jobId: "fal-req-abc123", agentId: "alpha", traceId: "trace-seed" }] });
    poller.track(makeRecord({ agentId: "alpha", traceId: "trace-seed" }));
    await flush();
    const info = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_complete",
    );
    expect(info).toBeTruthy();
    const line = info![0] as Record<string, unknown>;
    expect(line.videoProvider).toBe("fal");
    expect(line.model).toBe("fal-ai/veo3.1/fast");
    expect(line.costUsd).toBe(0.8);
    expect(line.sizeBytes).toBe(PERSISTED_OK.sizeBytes);
    expect(typeof line.durationMs).toBe("number");
    // OBS-01 completeness (192): mimeType + durationSecs ride the completion line
    // where derivable (from the fetched `out`).
    expect(line.durationSecs).toBe(8);
    expect(line.mimeType).toBe("video/mp4");
    expect(line.traceId).toBe("trace-seed");
    expect(line.jobId).toBe("fal-req-abc123");
    expect(line.agentId).toBe("alpha");
  });

  // ─── OBS-02 (Phase 192): every failure branch WARNs the closed errorKind + hint ───
  it("OBS-02: every poller failure branch WARNs with the closed errorKind (∈ log union), videoErrorKind (domain), and hint", async () => {
    // Drive the markFailed branch (a thrown poll → empty_response) and assert the
    // WARN carries the CLOSED log errorKind (VIDEO_ERR_TO_LOG[kind]) + the domain
    // videoErrorKind + an actionable hint — no failure branch emits unclassified.
    const provider = makeProvider({ poll: vi.fn().mockResolvedValue(err(new Error("boom"))) });
    const { poller, deps } = makePoller({ provider, seedRows: [{ jobId: "fal-req-abc123" }] });
    poller.track(makeRecord({ sessionKey: "s" }));
    await flush();
    const w = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_failed",
    );
    expect(w).toBeTruthy();
    const line = w![0] as Record<string, unknown>;
    // The closed log union (10-member ErrorKind) — empty_response maps to "dependency".
    expect(line.errorKind).toBe("dependency");
    // The domain kind (7-member VideoErrorKind) rides videoErrorKind, never the log union.
    expect(line.videoErrorKind).toBe("empty_response");
    expect(typeof line.hint).toBe("string");
    expect((line.hint as string).length).toBeGreaterThan(0);
    // No synthetic cost emit on a failed render (cost is reconciled only on done).
    expect(tokenUsageEmits(deps)).toHaveLength(0);
  });

  // ─── JOB-03 restart resume: seed pending + done provider → ONE delivery ───
  it("startAndResume(): a seeded pending job delivers EXACTLY ONE attachment to the recorded channel (turn gone)", async () => {
    const { poller, deps } = makePoller({
      seedRows: [{ jobId: "seed-job", agentId: "alpha", channelType: "telegram", channelId: "ch-recorded" }],
    });
    const markDoneSpy = deps.store.markDoneSpy;
    await poller.startAndResume();
    await flush();

    // EXACTLY ONE attachment, to the RECORDED channel — no rawParams, no live RPC.
    expect(deps.sendAttachment).toHaveBeenCalledTimes(1);
    expect(deps.getChannelAdapter).toHaveBeenCalledWith("telegram");
    expect(deps.sendAttachment.mock.calls[0]![0]).toBe("ch-recorded");
    expect(markDoneSpy).toHaveBeenCalledTimes(1);
    // a transition-gated INFO names the resumed count.
    const info = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof (c[0] as { resumed?: number }).resumed === "number",
    );
    expect(info).toBeTruthy();
    expect((info![0] as { resumed?: number }).resumed).toBe(1);
    poller.shutdown();
  });

  it("startAndResume(): no pending rows → no delivery, no resumed log", async () => {
    const { poller, deps } = makePoller({ seedRows: [] });
    await poller.startAndResume();
    await flush();
    expect(deps.sendAttachment).not.toHaveBeenCalled();
    poller.shutdown();
  });

  // ─── single-tick gate + .unref() ───
  it("startAndResume() arms the outer sweeper via the injected timer and calls .unref() (leak guard)", async () => {
    const { poller, deps } = makePoller();
    await poller.startAndResume();
    const intervals = deps.timers.unrefRecord().filter((e) => e.kind === "interval");
    expect(intervals.length).toBeGreaterThanOrEqual(1);
    expect(intervals.every((e) => e.unrefCalled)).toBe(true);
    poller.shutdown();
  });

  it("the sweeper re-discovers a pending row not in the in-flight set and re-tracks it (single-tick gate)", async () => {
    // Start with no in-flight jobs, then insert a pending row AFTER startAndResume
    // and advance the timer so the sweeper picks it up.
    const { poller, deps } = makePoller({ seedRows: [] });
    await poller.startAndResume();
    await flush();
    void deps.store.insert({
      jobId: "late-job", provider: "fal", model: "m", agentId: "alpha",
      channelType: "telegram", channelId: "ch-late", traceId: "t",
      state: "pending", estimatedCostUsd: 1, submittedAtMs: 0, updatedAtMs: 0,
    });
    // Advance the fake timer one sweep interval → the sweeper re-discovers it.
    deps.timers.advance(makeConfig().pollIntervalMs);
    await flush();
    expect(deps.sendAttachment).toHaveBeenCalledTimes(1);
    expect(deps.sendAttachment.mock.calls[0]![0]).toBe("ch-late");
    poller.shutdown();
  });

  // ─── shutdown ───
  it("shutdown() clears the interval (cancelled in the timer record) and stops further polls", async () => {
    const { poller, deps } = makePoller({ seedRows: [] });
    await poller.startAndResume();
    poller.shutdown();
    const intervals = deps.timers.unrefRecord().filter((e) => e.kind === "interval");
    expect(intervals.every((e) => e.cancelled)).toBe(true);
    // A late pending row is NOT picked up after shutdown (advance fires nothing).
    void deps.store.insert({
      jobId: "post-shutdown", provider: "fal", model: "m", agentId: "alpha",
      channelType: "telegram", channelId: "ch", traceId: "t",
      state: "pending", estimatedCostUsd: 1, submittedAtMs: 0, updatedAtMs: 0,
    });
    deps.timers.advance(makeConfig().pollIntervalMs * 3);
    await flush();
    expect(deps.sendAttachment).not.toHaveBeenCalled();
  });

  // ─── DEL-02 IRC degrade: adapter without sendAttachment ───
  it("DEL-02: an adapter without sendAttachment does not throw, logs a notice, and still markDone", async () => {
    const { poller, deps } = makePoller({
      adapterHasSend: false,
      seedRows: [{ jobId: "fal-req-abc123" }],
    });
    const markDoneSpy = deps.store.markDoneSpy;
    poller.track(makeRecord());
    await flush();
    // No throw; the clip IS persisted so the at-least-once contract still marks done.
    expect(deps.persist).toHaveBeenCalledTimes(1);
    expect(markDoneSpy).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DEL-03 (BLOCKER): oversized-video graceful degrade at the DELIVERY site.
  // A clip over the channel's video-size limit is NEVER silently dropped: a
  // link (where the channel renders URLs) or a notice (+ the persisted path) is
  // sent via sendMessage, NEVER routed through compressAttachments (the v2.23
  // silent-drop). markDone holds in every branch (the clip IS persisted).
  // ─────────────────────────────────────────────────────────────────────────

  // DEL-03 Test 1 (under-limit, non-regression): a clip BELOW the limit delivers
  // via sendAttachment exactly as today — NO sendMessage, NO degrade.
  it("DEL-03: a clip UNDER the channel limit delivers via sendAttachment unchanged (no degrade, no sendMessage)", async () => {
    // PERSISTED_OK.sizeBytes = 42_424 (~41 KB) is far under Telegram's ~50MB limit.
    const { poller, deps } = makePoller({ seedRows: [{ jobId: "fal-req-abc123" }] });
    const markDoneSpy = deps.store.markDoneSpy;
    poller.track(makeRecord());
    await flush();

    expect(deps.sendAttachment).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).not.toHaveBeenCalled(); // no degrade path taken
    expect(markDoneSpy).toHaveBeenCalledTimes(1);
  });

  // DEL-03 Test 2 (over-limit, link-capable channel): an over-limit clip on a
  // link-rendering channel (telegram) does NOT call sendAttachment; it calls
  // sendMessage with a link/notice whose text does NOT contain the silent-drop
  // marker. markDone still holds (at-least-once: the clip IS persisted).
  it("DEL-03: an OVER-limit clip on a link channel degrades to sendMessage (NOT sendAttachment, NOT '[Attachment too large]'); markDone holds", async () => {
    // Force oversized: a tiny maxVideoBytes override makes the 42 KB fixture
    // exceed the limit on telegram (a link-rendering channel).
    const { poller, deps } = makePoller({
      seedRows: [{ jobId: "fal-req-abc123", channelType: "telegram", channelId: "ch-recorded" }],
      maxVideoBytes: 1000,
    });
    const markDoneSpy = deps.store.markDoneSpy;
    poller.track(makeRecord({ channelType: "telegram", channelId: "ch-recorded" }));
    await flush();

    // The attachment send is SKIPPED; the degrade goes out via sendMessage.
    expect(deps.sendAttachment).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    // Targets the RECORDED channel only (T-192-09 — never a default/broadcast).
    expect(deps.sendMessage.mock.calls[0]![0]).toBe("ch-recorded");
    const text = deps.sendMessage.mock.calls[0]![1] as string;
    // NEVER the v2.23 silent-drop marker (the RED crux — P5).
    expect(text).not.toContain("[Attachment too large");
    // The persisted workspace path rides the degrade message (recoverable).
    expect(text).toContain(PERSISTED_OK.filePath);
    // markDone STILL holds — a degraded delivery is a completed job (at-least-once).
    expect(markDoneSpy).toHaveBeenCalledTimes(1);
    // An INFO names the degrade (content-free canonical fields).
    const info = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_oversized_degrade",
    );
    expect(info).toBeTruthy();
    expect((info![0] as { traceId?: string }).traceId).toBe("trace-seed");
    expect((info![0] as { sizeBytes?: number }).sizeBytes).toBe(PERSISTED_OK.sizeBytes);
    expect(typeof (info![0] as { limit?: number }).limit).toBe("number");
    expect(typeof (info![0] as { hint?: string }).hint).toBe("string");
  });

  // DEL-03 Test 3 (over-limit, notice-only channel): an over-limit clip on a
  // non-link channel sends a NOTICE ("video too large for <channel>; saved to
  // <path>") via sendMessage + markDone; never throws, never silently drops.
  it("DEL-03: an OVER-limit clip on a notice-only channel sends a notice (+ persisted path) via sendMessage; markDone holds", async () => {
    // A channel that has sendAttachment but does NOT render links (an unknown
    // channelType → channelRendersVideoLink === false → the notice policy).
    const { poller, deps } = makePoller({
      seedRows: [{ jobId: "fal-req-abc123", channelType: "matrix", channelId: "ch-notice" }],
      maxVideoBytes: 1000,
    });
    const markDoneSpy = deps.store.markDoneSpy;
    poller.track(makeRecord({ channelType: "matrix", channelId: "ch-notice" }));
    await flush();

    expect(deps.sendAttachment).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage.mock.calls[0]![0]).toBe("ch-notice");
    const text = deps.sendMessage.mock.calls[0]![1] as string;
    expect(text).not.toContain("[Attachment too large");
    expect(text).toContain(PERSISTED_OK.filePath); // the saved workspace path
    expect(text.toLowerCase()).toContain("too large"); // the notice phrasing
    expect(markDoneSpy).toHaveBeenCalledTimes(1);
  });

  // DEL-03 Test 4 (IRC over-limit): IRC has NO sendAttachment, so an over-limit
  // clip falls through the existing DEL-02 capability gate (a persisted-only
  // notice), never an undefined-method call; markDone still holds.
  it("DEL-03: an OVER-limit clip on IRC (no sendAttachment) takes the DEL-02 persisted-only notice path; no undefined-method, markDone holds", async () => {
    const { poller, deps } = makePoller({
      adapterHasSend: false, // IRC-style: no sendAttachment
      seedRows: [{ jobId: "fal-req-abc123", channelType: "irc", channelId: "#room" }],
      maxVideoBytes: 1000, // over-limit, but IRC degrades via the capability gate first
    });
    const markDoneSpy = deps.store.markDoneSpy;
    poller.track(makeRecord({ channelType: "irc", channelId: "#room" }));
    await flush();

    // No throw, no sendAttachment (it does not exist on the adapter).
    expect(deps.sendAttachment).not.toHaveBeenCalled();
    // The DEL-02 persisted-only notice INFO fired (not the oversized-degrade
    // branch — the capability gate handles IRC before the size check matters).
    const skipped = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_deliver_skipped",
    );
    expect(skipped).toBeTruthy();
    // at-least-once: the clip is persisted → the turn completes.
    expect(deps.persist).toHaveBeenCalledTimes(1);
    expect(markDoneSpy).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CR-01 (BLOCKER): bounded redelivery + dead-letter + cost-exactly-once.
  // ─────────────────────────────────────────────────────────────────────────

  // CR-01 #1: a persistent delivery failure must converge to markFailed after
  // maxDeliveryAttempts and STOP re-downloading — not re-poll + re-fetchResult +
  // re-persist + re-sendAttachment every sweep forever.
  it("CR-01: a delivery that always fails dead-letters to markFailed after maxDeliveryAttempts and stops re-downloading", async () => {
    const sendAttachment = vi.fn().mockResolvedValue(err(new Error("channel down")));
    const { poller, deps } = makePoller({
      sendAttachment,
      config: makeConfig({ maxDeliveryAttempts: 3 } as Partial<VideoGenerationConfig>),
      seedRows: [{ jobId: "fal-req-abc123" }],
    });
    const markDoneSpy = deps.store.markDoneSpy;
    const markFailedSpy = deps.store.markFailedSpy;

    // startAndResume drives the seeded pending row AND arms the sweeper. On
    // pre-fix code each subsequent sweep re-downloads (fetchResult/persist) +
    // re-sends with NO bound, so the counts grow unboundedly past
    // maxDeliveryAttempts and the row never converges.
    await poller.startAndResume();
    await flush();
    for (let i = 0; i < 8; i++) {
      deps.timers.advance(makeConfig().pollIntervalMs);
      await flush();
    }
    poller.shutdown();

    // BOUNDED: the per-job work happens at most maxDeliveryAttempts times.
    expect(sendAttachment.mock.calls.length).toBeLessThanOrEqual(3);
    expect(deps.provider.fetchResult.mock.calls.length).toBeLessThanOrEqual(3);
    expect(deps.persist.mock.calls.length).toBeLessThanOrEqual(3);
    // CONVERGED: the row is dead-lettered to failed (out of `pending`), never markDone.
    expect(markFailedSpy).toHaveBeenCalled();
    expect(markFailedSpy.mock.calls[0]![0]).toBe("fal-req-abc123");
    expect(markDoneSpy).not.toHaveBeenCalled();
    // A dead-letter WARN names the bound (errorKind + hint).
    const w = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_deadletter",
    );
    expect(w).toBeTruthy();
    expect((w![0] as { errorKind?: string }).errorKind).toBeTruthy();
    expect((w![0] as { hint?: string }).hint).toBeTruthy();
    expect((w![0] as { jobId?: string }).jobId).toBe("fal-req-abc123");
  });

  // WR-02 (Phase 192): a delivery dead-letter must NOT mislabel its trajectory
  // errorKind as `empty_response` (a RENDER failure kind). The render SUCCEEDED;
  // delivery exhausted retries. `comis explain` must point at the channel, not the
  // provider/prompt. The persisted last_error + the trajectory kind must say delivery.
  it("WR-02: a delivery dead-letter records a delivery-specific errorKind on the trajectory, NOT empty_response", async () => {
    const sendAttachment = vi.fn().mockResolvedValue(err(new Error("channel down")));
    const reg = captureRegistry();
    const { poller, deps } = makePoller({
      sendAttachment,
      config: makeConfig({ maxDeliveryAttempts: 2 } as Partial<VideoGenerationConfig>),
      seedRows: [{ jobId: "fal-req-abc123", sessionKey: "default:u1:telegram:c1" }],
      trajectoryRegistry: reg,
    });
    const markFailedSpy = deps.store.markFailedSpy;

    await poller.startAndResume();
    await flush();
    for (let i = 0; i < 4; i++) {
      deps.timers.advance(makeConfig().pollIntervalMs);
      await flush();
    }
    poller.shutdown();

    // The dead-letter fired (markFailed was called).
    expect(markFailedSpy).toHaveBeenCalled();
    // The store markFailed kind is delivery-specific, NOT the render `empty_response`.
    const failedKind = markFailedSpy.mock.calls[0]![1] as string;
    expect(failedKind).not.toBe("empty_response");
    expect(failedKind).toBe("delivery_failed");
    // The trajectory video.failed record carries the delivery-specific kind too —
    // so the reconstructed IncidentReport.videoGenerated.errorKind is honest.
    const failedEvent = reg.calls.find((c) => c.type === "video.failed");
    expect(failedEvent).toBeTruthy();
    expect((failedEvent!.data as { errorKind?: string }).errorKind).toBe("delivery_failed");
    // The WARN/last_error hint explicitly names DELIVERY (not render/prompt).
    const w = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_deadletter",
    );
    expect((w![0] as { hint?: string }).hint?.toLowerCase()).toContain("delivery");
    // last_error persisted via markFailed's hint arg also names delivery.
    expect((markFailedSpy.mock.calls[0]![2] as string).toLowerCase()).toContain("delivery");
  });

  // CR-01 #2: cost is recorded EXACTLY ONCE — a delivery that fails once then
  // succeeds on the next sweep must not double-charge the limiter.
  it("CR-01: a job that fails delivery once then succeeds records cost EXACTLY ONCE (no double-count)", async () => {
    const sendAttachment = vi
      .fn()
      .mockResolvedValueOnce(err(new Error("transient channel error")))
      .mockResolvedValue(ok("msg-1"));
    const { poller, deps } = makePoller({
      sendAttachment,
      config: makeConfig({ maxDeliveryAttempts: 5 } as Partial<VideoGenerationConfig>),
      seedRows: [{ jobId: "fal-req-abc123" }],
    });
    const markDoneSpy = deps.store.markDoneSpy;

    // startAndResume drives the seeded pending row (first delivery fails → stays
    // pending) and arms the sweeper. Advance one sweep → the retry succeeds.
    await poller.startAndResume();
    await flush();
    deps.timers.advance(makeConfig().pollIntervalMs);
    await flush();
    poller.shutdown();

    expect(sendAttachment.mock.calls.length).toBe(2); // one fail, one success
    expect(markDoneSpy).toHaveBeenCalledTimes(1);
    // The crux: cost recorded ONCE (the successful terminal delivery), not on the
    // failed first attempt and not twice.
    expect(deps.costLimiter.record).toHaveBeenCalledTimes(1);
    expect(deps.costLimiter.record).toHaveBeenCalledWith("alpha", 0.8);
  });

  // CR-01 / WR-03: a persist failure marks the job failed but must NOT record
  // cost (it never reached the terminal markDone — the cost record rides markDone).
  it("CR-01/WR-03: a persist failure marks failed and does NOT record cost (cost rides the terminal markDone)", async () => {
    const persist = vi.fn().mockResolvedValue(err(new Error("disk full")));
    const { poller, deps } = makePoller({ persist, seedRows: [{ jobId: "fal-req-abc123" }] });
    const markFailedSpy = deps.store.markFailedSpy;
    const markDoneSpy = deps.store.markDoneSpy;

    poller.track(makeRecord());
    await flush();

    expect(markFailedSpy).toHaveBeenCalledTimes(1);
    expect(markDoneSpy).not.toHaveBeenCalled();
    // No artifact was delivered → the limiter is not charged.
    expect(deps.costLimiter.record).not.toHaveBeenCalled();
  });

  // CR-01 #3: the poller's markFailed must CHECK the store Result; a failing
  // terminal write is logged at ERROR (not silently discarded).
  it("CR-01: a failing markFailed store write is logged at ERROR (Result not discarded)", async () => {
    const provider = makeProvider({
      poll: vi.fn().mockResolvedValue(ok({ jobId: "fal-req-abc123", state: "failed" })),
    });
    const { poller, deps } = makePoller({ provider, seedRows: [{ jobId: "fal-req-abc123" }] });
    // Force the terminal markFailed write to fail.
    deps.store.markFailedSpy.mockResolvedValue(err(new Error("sqlite busy")));

    poller.track(makeRecord());
    await flush();

    const e = (deps.logger.error as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_markfailed",
    );
    expect(e).toBeTruthy();
    expect((e![0] as { errorKind?: string }).errorKind).toBeTruthy();
    expect((e![0] as { hint?: string }).hint).toBeTruthy();
    expect((e![0] as { jobId?: string }).jobId).toBe("fal-req-abc123");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WR-01: off-turn suppressed errors route to the Pino logger, not console.*
  // ─────────────────────────────────────────────────────────────────────────
  it("WR-01: a throw escaping the per-job loop is routed to the Pino logger (no console.debug)", async () => {
    // Make pollUntilDone's poll throw synchronously so runJob rejects and the
    // suppressError wrapper fires. On pre-fix code suppressError gets no logger
    // and writes to console.debug (invisible to daemon.log).
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const provider = makeProvider({
      poll: vi.fn().mockRejectedValue(new Error("unexpected provider throw")),
    });
    const { poller, deps } = makePoller({ provider, seedRows: [{ jobId: "fal-req-abc123" }] });
    poller.track(makeRecord());
    await flush();

    // The suppressed rejection reached the Pino logger (a debug line with the
    // suppressed step), NOT console.debug.
    const suppressed = (deps.logger.debug as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_suppressed",
    );
    expect(suppressed).toBeTruthy();
    expect(consoleDebug).not.toHaveBeenCalled();
    consoleDebug.mockRestore();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WR-02: the handler's insert-failure path tracks an in-memory record; the
  // poller must drive it from that record WITHOUT a listPending read (so it is
  // genuinely delivered, not orphaned). Modeled by tracking a record whose row
  // is NOT in the store (insert failed) — delivery still happens.
  // ─────────────────────────────────────────────────────────────────────────
  it("WR-02/WR-06: track() drives delivery from the in-memory record even when the row is not in listPending", async () => {
    // No seeded rows at all → listPending() returns []. On pre-fix code, track→
    // loadRecord→listPending().find() is undefined → the job is NEVER delivered
    // (the orphan bug). With the record passed directly, it IS delivered.
    const { poller, deps } = makePoller({ seedRows: [] });
    // listPending must not be the source of the routing for track().
    poller.track(makeRecord());
    await flush();

    expect(deps.provider.fetchResult).toHaveBeenCalledTimes(1);
    expect(deps.sendAttachment).toHaveBeenCalledTimes(1);
    expect(deps.sendAttachment.mock.calls[0]![0]).toBe("ch-recorded");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WR-01/WR-02 (Phase 190): the off-turn poller must NOT collapse a classified
  // terminal failure to the generic `empty_response`. The adapters classify a
  // Veo `operation.error` / Grok `status:"failed"|"expired"` into the right
  // `VideoErrorKind` + actionable hint on the `poll()` snapshot; the poller must
  // thread that SPECIFIC kind onto the WARN line + persist the HINT (not the bare
  // enum token) as `last_error` so `video.status` returns an actionable string.
  //
  // RED on pre-fix code: `runJob` mapped poll() → `{ state }` only and ran the
  // failed branch through `classifyOutcome`, which returns ONLY job_timeout /
  // empty_response — so a content-policy block surfaced as `empty_response` with a
  // generic "retry or adjust the prompt" hint, and `last_error` held the bare enum
  // token. After the fix the poller reads the classified kind+hint off the snapshot.
  // ─────────────────────────────────────────────────────────────────────────
  it("WR-01: a classified Veo terminal failure (content_blocked) on the poll snapshot is preserved — NOT collapsed to empty_response", async () => {
    // The Veo adapter's poll() now carries the classified kind+hint on a failed
    // operation.error (e.g. a responsible-AI/content-policy block).
    const provider = makeProvider({
      poll: vi.fn().mockResolvedValue(
        ok({
          jobId: "fal-req-abc123",
          state: "failed",
          errorKind: "content_blocked",
          hint: "Veo blocked the prompt by safety/responsible-AI policy. Revise the prompt and retry.",
        }),
      ),
    });
    const { poller, deps } = makePoller({ provider, seedRows: [{ jobId: "fal-req-abc123" }] });
    const markFailedSpy = deps.store.markFailedSpy;
    poller.track(makeRecord());
    await flush();

    // The off-turn WARN carries the SPECIFIC videoErrorKind (not empty_response).
    const w = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_failed",
    );
    expect(w).toBeTruthy();
    expect((w![0] as { videoErrorKind?: string }).videoErrorKind).toBe("content_blocked");
    expect((w![0] as { videoErrorKind?: string }).videoErrorKind).not.toBe("empty_response");
    // §2.7: the off-turn line still sets traceId explicitly + an actionable hint.
    expect((w![0] as { traceId?: string }).traceId).toBe("trace-seed");
    expect((w![0] as { hint?: string }).hint).toContain("safety");
    // WR-02: last_error persists the ACTIONABLE HINT, not the bare enum token.
    expect(markFailedSpy).toHaveBeenCalledTimes(1);
    const persistedLastError = markFailedSpy.mock.calls[0]![2] as string;
    expect(persistedLastError).toContain("safety");
    expect(persistedLastError).not.toBe("content_blocked");
    expect(persistedLastError).not.toBe("empty_response");
  });

  it("WR-01: a classified Grok terminal failure (quota_exceeded) on the poll snapshot is preserved — NOT collapsed to empty_response", async () => {
    const provider = makeProvider({
      poll: vi.fn().mockResolvedValue(
        ok({
          jobId: "fal-req-abc123",
          state: "failed",
          errorKind: "quota_exceeded",
          hint: "xAI reported a quota/rate/credits limit. Reduce frequency or check billing, then retry.",
        }),
      ),
    });
    const { poller, deps } = makePoller({ provider, seedRows: [{ jobId: "fal-req-abc123" }] });
    const markFailedSpy = deps.store.markFailedSpy;
    poller.track(makeRecord());
    await flush();

    const w = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_failed",
    );
    expect(w).toBeTruthy();
    expect((w![0] as { videoErrorKind?: string }).videoErrorKind).toBe("quota_exceeded");
    expect((w![0] as { errorKind?: string }).errorKind).toBe("resource"); // VIDEO_ERR_TO_LOG mapping
    // WR-02: the persisted last_error is the actionable hint.
    const persistedLastError = markFailedSpy.mock.calls[0]![2] as string;
    expect(persistedLastError).toContain("quota");
    expect(persistedLastError).not.toBe("quota_exceeded");
  });

  it("WR-01/WR-02: an unclassified failed poll (no errorKind on the snapshot) still falls back to empty_response (FAL parity)", async () => {
    // The FAL adapter's poll() carries no errorKind on a failed status — the
    // poller's existing classifyOutcome fallback (empty_response) must still apply.
    const provider = makeProvider({
      poll: vi.fn().mockResolvedValue(ok({ jobId: "fal-req-abc123", state: "failed" })),
    });
    const { poller, deps } = makePoller({ provider, seedRows: [{ jobId: "fal-req-abc123" }] });
    const markFailedSpy = deps.store.markFailedSpy;
    poller.track(makeRecord());
    await flush();

    const w = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_failed",
    );
    expect((w![0] as { videoErrorKind?: string }).videoErrorKind).toBe("empty_response");
    // With no classified hint, the generic fallback hint is persisted (still
    // actionable text, never undefined).
    expect(markFailedSpy.mock.calls[0]![1]).toBe("empty_response");
    expect(typeof markFailedSpy.mock.calls[0]![2]).toBe("string");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WR-04: lost-update window. The sweeper re-discovers a row that was `pending`
  // in the listPending snapshot, but a concurrent path already transitioned it to
  // terminal. startJob must re-read the row state and short-circuit (no re-fetch /
  // re-deliver) when it is no longer pending. Modeled by a store whose
  // listPending() returns the row but whose get() reports `done` (the divergence).
  // ─────────────────────────────────────────────────────────────────────────
  it("WR-04: a row pending in the listPending snapshot but already done on re-read short-circuits (no re-fetch)", async () => {
    const { poller, deps } = makePoller({ seedRows: [{ jobId: "fal-req-abc123" }] });
    // The row is still pending in listPending() (the snapshot), but get() — the
    // authoritative re-read in startJob — reports it already done.
    deps.store.get = vi.fn().mockResolvedValue(
      ok({ ...makeRecord(), state: "done", deliverAttempts: 0 }),
    ) as unknown as VideoJobStore["get"];

    // Drive via the sweeper (the path that rebuilds records from a stale snapshot).
    await poller.startAndResume();
    await flush();

    expect(deps.provider.fetchResult).not.toHaveBeenCalled();
    expect(deps.sendAttachment).not.toHaveBeenCalled();
    poller.shutdown();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SEC-03 redaction (Phase 192-04) — the OFF-TURN poller log surface.
  //
  // The handler SEC-03 test (video-handlers.test.ts) covers the in-turn lines;
  // the off-turn poller WARN/INFO lines are a SEPARATE surface the image-only
  // SEC-03 test never reached. A poll/fetch failure rides `err: cause` on the
  // `video_poll_failed` WARN, and the oversized-degrade INFO must never echo the
  // retained `sourceUrl` (which for Veo IS the keyed-download-URL). Assert no
  // secret (the full set incl. the Veo `…&key=AIza…` URL) appears in ANY poller
  // log line across all 4 levels (incl. the serialized `err.message`).
  // ─────────────────────────────────────────────────────────────────────────
  // Realistic provider-key formats (so the de-mask discipline engages): a real
  // `AIzaSy`+33 Google key (the Veo credential), a Bearer + an sk- key (Grok auth
  // + the generic), and the Veo download URL with the key as `&key=AIza…`.
  const GOOGLE_SECRET = "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456";
  const BEARER_SECRET = "Bearer sk-grok-9f8e7d6c5b4a32100123456789ab";
  const SK_SECRET = "sk-proj-DEADBEEFcafef00dDEADBEEFcafef00dXY";
  // CR-01 de-mask: a FAL FAL_KEY is shaped `<uuid>:<32hex>` — caught by NEITHER
  // sanitizeLogString's prior patterns NOR the transport backstop. The robust fix
  // (exact-match bound secrets) + the new uuid:hex pattern must scrub it.
  const FAL_SECRET = "b1946ac9-2c7f-4d3e-8a1b-9f8e7d6c5b4a:9f8e7d6c5b4a32109f8e7d6c5b4a3210";
  const VEO_KEYED_URL =
    `https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media&key=${GOOGLE_SECRET}`;
  const SECRET_VALUES = [
    GOOGLE_SECRET,
    BEARER_SECRET,
    SK_SECRET,
    "sk-grok-9f8e7d6c5b4a32100123456789ab",
    FAL_SECRET,
    "9f8e7d6c5b4a32109f8e7d6c5b4a3210", // the bare FAL hex tail
    VEO_KEYED_URL,
  ];

  /** Every poller log call (all 4 levels) + nested `err.message`/stack/CAUSE (a raw
   *  provider Error rides `err: cause`; Error.message is non-enumerable so a
   *  plain JSON.stringify drops it — the production Pino serializer emits it).
   *  CR-01 de-mask: ALSO walk `err.cause` — undici "fetch failed" carries the
   *  keyed-URL detail there, the exact field the prior helper never inspected. */
  function allPollerLogText(logger: ReturnType<typeof createMockLogger>): string[] {
    const levels = ["debug", "info", "warn", "error"] as const;
    const blobs: string[] = [];
    const pushErr = (e: unknown, depth: number): void => {
      if (depth > 6 || !(e instanceof Error)) return;
      blobs.push(e.message);
      if (typeof e.stack === "string") blobs.push(e.stack);
      pushErr((e as { cause?: unknown }).cause, depth + 1);
    };
    for (const level of levels) {
      const spy = logger[level] as ReturnType<typeof vi.fn>;
      for (const call of spy.mock.calls) {
        const payload = (call[0] ?? {}) as Record<string, unknown>;
        blobs.push(JSON.stringify(payload));
        if (typeof call[1] === "string") blobs.push(call[1]);
        pushErr(payload.err, 0);
      }
    }
    return blobs;
  }

  function assertNoPollerSecretLeak(logger: ReturnType<typeof createMockLogger>): void {
    const blobs = allPollerLogText(logger);
    expect(blobs.length).toBeGreaterThan(0); // non-vacuous
    for (const blob of blobs) {
      for (const secret of SECRET_VALUES) expect(blob).not.toContain(secret);
      // No LIVE secret-shaped value (the sanitized `[REDACTED]` placeholder is
      // safe — a live token has no `[` right after the prefix).
      expect(blob).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i);
      expect(blob).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
      expect(blob).not.toMatch(/key=AIza[A-Za-z0-9_-]{4,}/);
      expect(blob).not.toMatch(/AIzaSy[A-Za-z0-9_-]{10,}/);
    }
  }

  it("a fetchResult failure whose raw provider Error carries the full secret set does not leak it via the off-turn WARN", async () => {
    // fetchResult rejects with a raw SDK-shaped error embedding every secret —
    // the poller WARNs `err: cause` (video_poll_failed). No secret may surface.
    const provider = makeProvider({
      poll: vi.fn().mockResolvedValue(ok({ jobId: "fal-req-abc123", state: "done" })),
      fetchResult: vi
        .fn()
        .mockResolvedValue(
          err(
            new Error(
              `download failed: ${GOOGLE_SECRET} ${BEARER_SECRET} ${SK_SECRET} ${VEO_KEYED_URL}`,
            ),
          ),
        ),
    });
    const { poller, deps } = makePoller({ provider, seedRows: [{ jobId: "fal-req-abc123" }] });
    poller.track(makeRecord());
    await flush();

    // The failure WARN fired (non-vacuous).
    expect(
      (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => (c[0] as { step?: string }).step === "video_poll_failed",
      ),
    ).toBe(true);
    assertNoPollerSecretLeak(deps.logger);
  });

  it("an oversized-degrade whose retained sourceUrl is the Veo keyed-download-URL never logs the key (video_poll_oversized_degrade)", async () => {
    // The render result carries the Veo keyed-download-URL as sourceUrl; the clip
    // is over the (forced) size limit → the degrade INFO/notice fires. The keyed
    // URL rides the user-facing sendMessage TEXT, never the log object.
    const provider = makeProvider({
      fetchResult: vi.fn().mockResolvedValue(
        ok({
          buffer: SMALL_MP4,
          mimeType: "video/mp4",
          costUsd: 0.8,
          model: "veo-3.1",
          provider: "google",
          durationSecs: 8,
          sourceUrl: VEO_KEYED_URL,
        }),
      ),
    });
    // maxVideoBytes: 1000 forces the 42 KB PERSISTED_OK fixture oversized.
    const { poller, deps } = makePoller({ provider, maxVideoBytes: 1000 });
    poller.track(makeRecord());
    await flush();

    // The degrade branch fired (sendMessage, not sendAttachment) — non-vacuous.
    expect(
      (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => (c[0] as { step?: string }).step === "video_poll_oversized_degrade",
      ),
    ).toBe(true);
    // No secret in ANY poller log line (the keyed URL is on the sendMessage text).
    assertNoPollerSecretLeak(deps.logger);
  });

  it("a failed oversized-degrade notice send (err: noticeResult.error carries a secret) does not leak it", async () => {
    // The degrade-notice sendMessage rejects with a secret-bearing error → the
    // poller WARNs `err: noticeResult.error`. No secret may surface.
    const provider = makeProvider({
      fetchResult: vi.fn().mockResolvedValue(
        ok({
          buffer: SMALL_MP4,
          mimeType: "video/mp4",
          costUsd: 0.8,
          model: "veo-3.1",
          provider: "google",
          durationSecs: 8,
          sourceUrl: VEO_KEYED_URL,
        }),
      ),
    });
    const sendMessage = vi
      .fn()
      .mockResolvedValue(err(new Error(`channel rejected the notice ${VEO_KEYED_URL} ${BEARER_SECRET}`)));
    const { poller, deps } = makePoller({ provider, sendMessage, maxVideoBytes: 1000 });
    poller.track(makeRecord());
    await flush();

    // The degrade WARN fired on the failed notice send (non-vacuous).
    expect(
      (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => (c[0] as { step?: string }).step === "video_poll_oversized_degrade",
      ),
    ).toBe(true);
    assertNoPollerSecretLeak(deps.logger);
  });

  // ─── CR-01 de-mask: the THREE real leaks the prior poller-SEC tests missed ───

  it("CR-01: a fetchResult error whose KEYED URL lives in err.cause (undici 'fetch failed') does not leak + keeps the failure class", async () => {
    // The realistic undici shape: TypeError("fetch failed") with the keyed-URL +
    // network detail in `.cause`. The prior redactErr read only the top message →
    // the cause (and any secret in it) was dropped (a §2.7 regression) and, where a
    // secret rode the cause, the de-masked helper now SURFACES it as a leak.
    const cause = new Error(`getaddrinfo ENOTFOUND fetch ${VEO_KEYED_URL}`);
    const provider = makeProvider({
      poll: vi.fn().mockResolvedValue(ok({ jobId: "fal-req-abc123", state: "done" })),
      fetchResult: vi.fn().mockResolvedValue(err(new Error("fetch failed", { cause }))),
    });
    const { poller, deps } = makePoller({ provider, seedRows: [{ jobId: "fal-req-abc123" }] });
    poller.track(makeRecord());
    await flush();

    assertNoPollerSecretLeak(deps.logger);
    // WR-01 / §2.7: the cause's failure CLASS must survive redaction on the WARN.
    const w = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { step?: string }).step === "video_poll_failed",
    );
    expect(w).toBeTruthy();
    expect((w![0] as { errMessage?: string }).errMessage).toContain("ENOTFOUND");
  });

  it("CR-01: a FAL key (uuid:hex shape) echoed in a fetchResult error is scrubbed (pattern + bound)", async () => {
    // FAL's uuid:hex key is caught by NO prior pattern. With the secret BOUND
    // (exact-match) AND the new uuid:hex pattern, it must never reach the log.
    const provider = makeProvider({
      poll: vi.fn().mockResolvedValue(ok({ jobId: "fal-req-abc123", state: "done" })),
      fetchResult: vi
        .fn()
        .mockResolvedValue(err(new Error(`FAL queue rejected request with key=${FAL_SECRET}`))),
    });
    const { poller, deps } = makePoller({
      provider,
      seedRows: [{ jobId: "fal-req-abc123" }],
      videoSecrets: [FAL_SECRET],
    });
    poller.track(makeRecord());
    await flush();
    assertNoPollerSecretLeak(deps.logger);
  });

  it("CR-01: a BOUND video secret echoed verbatim by the provider is exact-match scrubbed from the WARN", async () => {
    // The robust shape-independent guard (the v2.20 knownSecrets precedent): the
    // resolved secret bound at the wiring site is scrubbed by exact match even
    // when it has no recognizable prefix/shape.
    const opaque = "zZ9-opaque-provider-token-no-recognizable-prefix-123456";
    const provider = makeProvider({
      poll: vi.fn().mockResolvedValue(ok({ jobId: "fal-req-abc123", state: "done" })),
      fetchResult: vi.fn().mockResolvedValue(err(new Error(`upstream said: ${opaque}`))),
    });
    const { poller, deps } = makePoller({
      provider,
      seedRows: [{ jobId: "fal-req-abc123" }],
      videoSecrets: [opaque],
    });
    poller.track(makeRecord());
    await flush();
    const blobs = allPollerLogText(deps.logger);
    for (const blob of blobs) expect(blob).not.toContain(opaque);
  });
});
