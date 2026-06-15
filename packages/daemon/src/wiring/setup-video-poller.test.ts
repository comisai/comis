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
  getChannelAdapter: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof createMockLogger>;
  timers: ReturnType<typeof createFakeTimers>;
  sleep: ReturnType<typeof vi.fn>;
  nowMs: () => number;
}

/**
 * Build the poller + its mock deps. Uses a real in-`:memory:` VideoJobStore so
 * the restart-resume case can seed a real pending row, and a fake clock/timer so
 * nothing waits.
 */
function makePoller(opts: {
  provider?: MockProvider;
  sendAttachment?: ReturnType<typeof vi.fn>;
  adapterHasSend?: boolean; // false → IRC-style adapter without sendAttachment
  persist?: ReturnType<typeof vi.fn>;
  config?: VideoGenerationConfig;
  seedRows?: Array<Record<string, unknown>>;
  // OBS-04 (Phase 192): an optional trajectory registry — when provided the
  // poller best-effort live-emits video.* off-turn via getRecorder(sessionKey).
  trajectoryRegistry?: { getRecorder: ReturnType<typeof vi.fn> };
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
  const adapter = opts.adapterHasSend === false ? {} : { sendAttachment };
  const getChannelAdapter = vi.fn().mockReturnValue(adapter);
  const persist = opts.persist ?? vi.fn().mockResolvedValue(ok(PERSISTED_OK));
  const costLimiter = { record: vi.fn() };
  const logger = createMockLogger();
  const timers = createFakeTimers();
  const sleep = vi.fn().mockResolvedValue(undefined);
  let clock = 0;
  const nowMs = () => clock; // never advances on its own → deadline only via explicit jumps

  const deps: MockPollerDeps = {
    store, provider, persist, costLimiter, sendAttachment, getChannelAdapter, logger, timers, sleep, nowMs,
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
    ...(opts.trajectoryRegistry ? { trajectoryRegistry: opts.trajectoryRegistry as never } : {}),
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
});
