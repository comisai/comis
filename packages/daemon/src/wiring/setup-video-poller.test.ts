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
import type { VideoJobStore } from "@comis/memory";
import type { VideoGenJob, VideoGenerationConfig } from "@comis/core";
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

/** A tracked job the handler would hand to `track()`. */
function makeJob(overrides: Partial<VideoGenJob> = {}): VideoGenJob {
  return { jobId: "fal-req-abc123", provider: "fal", model: "fal-ai/veo3.1/fast", ...overrides };
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
} {
  const markDoneSpy = vi.fn((...args: Parameters<VideoJobStore["markDone"]>) => real.markDone(...args));
  const markFailedSpy = vi.fn((...args: Parameters<VideoJobStore["markFailed"]>) => real.markFailed(...args));
  return {
    insert: (...a) => real.insert(...a),
    listPending: () => real.listPending(),
    get: (...a) => real.get(...a),
    markDone: markDoneSpy as unknown as VideoJobStore["markDone"],
    markFailed: markFailedSpy as unknown as VideoJobStore["markFailed"],
    updateProgress: (...a) => real.updateProgress(...a),
    markDoneSpy,
    markFailedSpy,
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
} = {}): { poller: VideoPoller; deps: MockPollerDeps; db: Database.Database } {
  const db = new Database(":memory:");
  ensureVideoJobTable(db);
  const real = createVideoJobStore(db);
  const store = spyStore(real);

  // Seed pending rows. Default: ONE row matching makeJob()'s jobId so a bare
  // `track(makeJob())` has a row to read its routing from (the handler inserts
  // the row at submit, then calls track). Tests override via `seedRows`.
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
  });
  void clock;
  return { poller, deps, db };
}

/** Flush the microtask queue so fire-and-forget runJob loops settle. The full
 *  chain is loadRecord→poll→fetchResult→persist→sendAttachment→markDone→info —
 *  each an await — so the default count is generous. */
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
    poller.track(makeJob());
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

  // The job the handler tracks must carry routing for the announce. Since
  // VideoGenJob is {jobId,provider,model} only, the poller reads the channel +
  // agent from the persisted row (inserted at submit). track() is given the row.
  it("delivers to the RECORDED channel/agent read from the persisted job row", async () => {
    // Seed a row whose channel differs from any default, then track its job.
    const { poller, deps } = makePoller({
      seedRows: [{ jobId: "fal-req-abc123", agentId: "beta", channelType: "discord", channelId: "ch-beta" }],
    });
    poller.track(makeJob());
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
    poller.track(makeJob());
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
    poller.track(makeJob());
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
    poller.track(makeJob());
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
    poller.track(makeJob());
    await flush();
    // No throw; the clip IS persisted so the at-least-once contract still marks done.
    expect(deps.persist).toHaveBeenCalledTimes(1);
    expect(markDoneSpy).toHaveBeenCalledTimes(1);
  });
});
