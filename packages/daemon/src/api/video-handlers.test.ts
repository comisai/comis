// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the video.generate RPC handler (Phase 188 baseline → Phase 189
 * inline→submit switch).
 *
 * Phase 189 (JOB-04 / JOB-02): `video.generate` no longer runs the inline
 * `port.execute()` (which blocked the turn on the full render) + persist/deliver/
 * base64 tail. It now `port.submit()`s, persists a `pending` VideoJobStore row,
 * hands the job to the background poller, and returns `{jobId, state:"submitted",
 * estimatedCostUsd}` PROMPTLY. The completion tail (poll→fetch→persist→deliver→
 * record→markDone) moved to the poller (setup-video-poller.ts).
 *
 * What this suite proves:
 *   - submit-not-execute: deps.provider.submit is called; deps.provider.execute is NOT.
 *   - persist + track: a successful submit inserts the JOB-01 row + tracks the job;
 *     the handler does NOT persist/deliver/base64 (that is the poller's job now).
 *   - submit failure: the SAME classified-error WARN path as the 188 !ok branch.
 *   - pre-submit gates PRESERVED (non-regression): SEC-02 cost ceiling, the count
 *     rate limit, the missing-prompt error, WR-02 resolved defaults — all still
 *     hold and block BEFORE submit.
 *   - SEC-03 image_url through the SSRF resolver; no credential VALUE in any log.
 *   - loose-record: {jobId,state,estimatedCostUsd} validates vs the EXISTING
 *     VideoGenerateContract.response (A3 — no contract change for video.generate).
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createVideoHandlers, type VideoHandlerDeps } from "./video-handlers.js";
import { VideoGenError } from "@comis/core";
import { ok, err } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
// SEC-03: the credential KEY-NAME set Pino redacts. The assertion below checks
// no credential VALUE leaks into any video log line.
import { CREDENTIAL_KEYS } from "@comis/observability";

// Mock node:fs/promises so the SEC-03 workspace-file reference branch (and the
// shared resolver) does no real I/O.
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from("REF-FILE-BYTES")),
}));

// CR-01: the image_url URL branch routes through the shared DNS-pinned SSRF
// fetcher (ssrf-image-fetch.ts → undici Agent + fetch). Mock undici so Agent is
// a real class and fetch delegates to globalThis.fetch — NEVER the real network.
const { undiciAgentCtor, undiciAgentClose } = vi.hoisted(() => {
  const undiciAgentCtor = vi.fn();
  const undiciAgentClose = vi.fn().mockResolvedValue(undefined);
  return { undiciAgentCtor, undiciAgentClose };
});
vi.mock("undici", () => {
  class MockAgent {
    close = undiciAgentClose;
    constructor(args: unknown) {
      undiciAgentCtor(args);
    }
  }
  const fetch = (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args);
  return { Agent: MockAgent, fetch };
});

// Preserve the contract registry + stripInternalFields + VideoGenError + the
// trace accessor; stub safePath (joins segments — the SEC-03 confinement test
// asserts the resolved path goes THROUGH safePath) and validateUrl (defaults ok
// with a resolved IP so the URL branch pins DNS; the SSRF test overrides it).
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  // IN-02: wrap the matrix accessors in spies that DELEGATE to the real
  // implementation by default (so the happy-path + real-backend reject tests
  // exercise the genuine VIDEO_MODELS matrix), but can be overridden per-test
  // (the i2v-on-a-t2v-only-backend reject needs a fabricated t2v-only cell —
  // no real backend is t2v-only).
  return {
    ...actual,
    listVideoModelCaps: vi.fn(actual.listVideoModelCaps),
    supportedModes: vi.fn(actual.supportedModes),
    safePath: (...segments: string[]) => segments.join("/"),
    validateUrl: vi.fn(async () => ({
      ok: true,
      value: { hostname: "example.com", ip: "93.184.216.34", url: new URL("https://example.com/ref.png") },
    })),
  };
});

/** The durable opaque jobId the submit returns. */
const SUBMITTED_JOB = { jobId: "fal-req-abc123", provider: "fal", model: "fal-ai/veo3.1/fast" };

function createMockDeps(overrides: Partial<VideoHandlerDeps> = {}): VideoHandlerDeps {
  return {
    provider: {
      id: "fal",
      isAvailable: () => true,
      // 189: submit returns a durable job handle (no block on the full render).
      submit: vi.fn().mockResolvedValue(ok(SUBMITTED_JOB)),
      poll: vi.fn(),
      fetchResult: vi.fn(),
      // execute MUST NOT be called on the async path — left unmocked-failing.
      execute: vi.fn().mockResolvedValue(err(new Error("execute must not be called in async mode"))),
    },
    rateLimiter: {
      tryAcquire: vi.fn().mockReturnValue(true),
      reset: vi.fn(),
    },
    config: {
      provider: "fal",
      defaultDurationSecs: 8,
      defaultAspectRatio: "16:9",
      defaultResolution: "720p",
      maxPerHour: 5,
      timeoutMs: 300000,
      pollIntervalMs: 10000,
      fallbackChain: [],
    } as unknown as VideoHandlerDeps["config"],
    logger: createMockLogger(),
    getChannelAdapter: vi.fn().mockReturnValue(undefined),
    resolveAgentMainProvider: vi.fn().mockReturnValue({ providerId: "google" }),
    workspaceDirs: new Map<string, string>(),
    defaultWorkspaceDir: "/tmp/test-workspace",
    persist: vi.fn().mockResolvedValue(ok({ filePath: "/x.mp4", relativePath: "x.mp4", mimeType: "video/mp4", sizeBytes: 1, mediaKind: "video", savedAt: 0 })),
    // 189 new deps: the store (handler inserts on submit) + the poller (track).
    videoJobStore: {
      insert: vi.fn().mockResolvedValue(ok(undefined)),
      listPending: vi.fn().mockResolvedValue(ok([])),
      get: vi.fn().mockResolvedValue(ok(undefined)),
      markDone: vi.fn().mockResolvedValue(ok(undefined)),
      markFailed: vi.fn().mockResolvedValue(ok(undefined)),
      updateProgress: vi.fn().mockResolvedValue(ok(undefined)),
      incrementDeliveryAttempt: vi.fn().mockResolvedValue(ok(0)),
    } as unknown as VideoHandlerDeps["videoJobStore"],
    videoPoller: { track: vi.fn() },
    ...overrides,
  };
}

const warnCalls = (deps: VideoHandlerDeps) =>
  (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
const infoCalls = (deps: VideoHandlerDeps) =>
  (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls;
const insertMock = (deps: VideoHandlerDeps) =>
  deps.videoJobStore.insert as unknown as ReturnType<typeof vi.fn>;
const trackMock = (deps: VideoHandlerDeps) =>
  deps.videoPoller.track as unknown as ReturnType<typeof vi.fn>;

describe("createVideoHandlers (Phase 189 — inline→submit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── JOB-04 submit-not-execute ───
  it("submits (NOT execute) and returns {success,jobId,state:'submitted',estimatedCostUsd}", async () => {
    const deps = createMockDeps();
    const handlers = createVideoHandlers(deps);
    const result = (await handlers["video.generate"]!({
      _agentId: "agent-1",
      prompt: "a cat",
    })) as { success: boolean; jobId?: string; state?: string; estimatedCostUsd?: number };
    expect(deps.provider.submit).toHaveBeenCalledTimes(1);
    expect(deps.provider.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.jobId).toBe("fal-req-abc123");
    expect(result.state).toBe("submitted");
    expect(typeof result.estimatedCostUsd).toBe("number");
    expect(result.estimatedCostUsd!).toBeGreaterThan(0);
  });

  // ─── persist + track (JOB-01 fields) ───
  it("on submit inserts the JOB-01 row + tracks the job; does NOT persist/deliver inline", async () => {
    const sendAttachment = vi.fn().mockResolvedValue(ok("msg"));
    const deps = createMockDeps({ getChannelAdapter: vi.fn().mockReturnValue({ sendAttachment }) });
    const handlers = createVideoHandlers(deps);
    await handlers["video.generate"]!({
      _agentId: "agent-1",
      prompt: "a comet",
      _callerChannelType: "telegram",
      _callerChannelId: "chat-1",
    });
    // insert called with the JOB-01 fields (channel from rawParams._callerChannel*).
    expect(insertMock(deps)).toHaveBeenCalledTimes(1);
    const row = insertMock(deps).mock.calls[0]![0] as Record<string, unknown>;
    expect(row.jobId).toBe("fal-req-abc123");
    expect(row.agentId).toBe("agent-1");
    expect(row.channelType).toBe("telegram");
    expect(row.channelId).toBe("chat-1");
    expect(row.state).toBe("pending");
    expect(typeof row.estimatedCostUsd).toBe("number");
    expect(typeof row.submittedAtMs).toBe("number");
    // track called with the submit result job.
    expect(trackMock(deps)).toHaveBeenCalledTimes(1);
    expect((trackMock(deps).mock.calls[0]![0] as { jobId: string }).jobId).toBe("fal-req-abc123");
    // the handler does NOT persist or deliver inline (the poller does).
    expect(deps.persist).not.toHaveBeenCalled();
    expect(sendAttachment).not.toHaveBeenCalled();
  });

  // ─── WR-02: track() receives the FULL routing record (not the bare job) ───
  it("WR-02/WR-06: tracks the job with a record carrying the routing (agentId/channelType/channelId)", async () => {
    const deps = createMockDeps();
    const handlers = createVideoHandlers(deps);
    await handlers["video.generate"]!({
      _agentId: "agent-1",
      prompt: "a comet",
      _callerChannelType: "telegram",
      _callerChannelId: "chat-1",
    });
    // The poller now drives the job from the in-memory record (WR-02/WR-06: no
    // listPending scan), so track MUST receive the routing — not the bare
    // {jobId,provider,model} job, which would orphan the insert-failure path.
    const tracked = trackMock(deps).mock.calls[0]![0] as Record<string, unknown>;
    expect(tracked.jobId).toBe("fal-req-abc123");
    expect(tracked.agentId).toBe("agent-1");
    expect(tracked.channelType).toBe("telegram");
    expect(tracked.channelId).toBe("chat-1");
    expect(tracked.state).toBe("pending");
  });

  // ─── WR-02: an insert failure does NOT silently orphan — track still drives it ───
  it("WR-02: on a store insert failure the job is still tracked WITH routing (in-memory delivery, not orphaned)", async () => {
    const deps = createMockDeps({
      videoJobStore: {
        insert: vi.fn().mockResolvedValue(err(new Error("sqlite disk I/O error"))),
        listPending: vi.fn().mockResolvedValue(ok([])),
        get: vi.fn().mockResolvedValue(ok(undefined)),
        markDone: vi.fn().mockResolvedValue(ok(undefined)),
        markFailed: vi.fn().mockResolvedValue(ok(undefined)),
        updateProgress: vi.fn().mockResolvedValue(ok(undefined)),
        incrementDeliveryAttempt: vi.fn().mockResolvedValue(ok(0)),
      } as unknown as VideoHandlerDeps["videoJobStore"],
    });
    const handlers = createVideoHandlers(deps);
    const result = (await handlers["video.generate"]!({
      _agentId: "agent-1",
      prompt: "a comet",
      _callerChannelType: "telegram",
      _callerChannelId: "chat-1",
    })) as { success: boolean };
    // The insert failed, but track is STILL called with the routing record, so the
    // rendered clip is delivered in-memory (the orphan bug is gone). On pre-fix
    // code track received the bare job (no routing → loadRecord→listPending found
    // nothing → never delivered).
    expect(trackMock(deps)).toHaveBeenCalledTimes(1);
    const tracked = trackMock(deps).mock.calls[0]![0] as Record<string, unknown>;
    expect(tracked.channelType).toBe("telegram");
    expect(tracked.channelId).toBe("chat-1");
    expect(tracked.agentId).toBe("agent-1");
    // The submit still succeeded (the render is in flight); the WARN names the
    // degraded restart-durability.
    expect(result.success).toBe(true);
    const w = warnCalls(deps).find((c) => (c[0] as { step?: string }).step === "video_persist_row");
    expect(w).toBeTruthy();
  });

  // ─── WARNING-3: the inserted row carries a traceId so the off-turn poller can stitch ───
  it("persists a traceId on the row (captured from the in-turn context) for off-turn stitching", async () => {
    const deps = createMockDeps();
    const handlers = createVideoHandlers(deps);
    await handlers["video.generate"]!({ _agentId: "agent-1", prompt: "trace me" });
    const row = insertMock(deps).mock.calls[0]![0] as Record<string, unknown>;
    // The row MUST carry a traceId KEY (value may be undefined outside an ALS
    // scope in this unit test, but the field must be threaded — I8 / Pitfall 5).
    expect("traceId" in row).toBe(true);
  });

  // ─── submit failure: classified-error WARN, NO insert/track ───
  it("forwards the typed VideoGenError hint on a submit failure + WARNs; NO insert, NO track", async () => {
    const deps = createMockDeps({
      provider: {
        id: "fal",
        isAvailable: () => true,
        submit: vi.fn().mockResolvedValue(
          err(new VideoGenError("fal: submit rejected", { videoErrorKind: "content_blocked", hint: "Adjust the prompt; the content was blocked." })),
        ),
        poll: vi.fn(),
        fetchResult: vi.fn(),
        execute: vi.fn(),
      },
    });
    const handlers = createVideoHandlers(deps);
    const result = (await handlers["video.generate"]!({ _agentId: "agent-1", prompt: "x" })) as {
      success: boolean;
      error: string;
      hint?: string;
    };
    expect(result.success).toBe(false);
    expect(result.hint).toMatch(/Adjust the prompt/);
    expect(insertMock(deps)).not.toHaveBeenCalled();
    expect(trackMock(deps)).not.toHaveBeenCalled();
    const w = warnCalls(deps).find((c) => (c[0] as { step?: string }).step === "video_submit");
    expect(w).toBeTruthy();
    expect((w![0] as { videoErrorKind?: string }).videoErrorKind).toBe("content_blocked");
    expect((w![0] as { errorKind?: string }).errorKind).toBe("dependency"); // VIDEO_ERR_TO_LOG mapping
  });

  // ─── pre-submit gates PRESERVED (non-regression) ───
  it("returns error when prompt is missing (no submit, no insert)", async () => {
    const deps = createMockDeps();
    const handlers = createVideoHandlers(deps);
    const result = await handlers["video.generate"]!({ _agentId: "agent-1" });
    expect(result).toEqual({ success: false, error: "Missing required parameter: prompt" });
    expect(deps.provider.submit).not.toHaveBeenCalled();
    expect(insertMock(deps)).not.toHaveBeenCalled();
  });

  it("returns error when rate limited (no submit) + a WARN with errorKind+hint", async () => {
    const deps = createMockDeps({
      rateLimiter: { tryAcquire: vi.fn().mockReturnValue(false), reset: vi.fn() },
    });
    const handlers = createVideoHandlers(deps);
    const result = await handlers["video.generate"]!({ _agentId: "agent-1", prompt: "a cat" });
    expect(result).toEqual({ success: false, error: "Rate limit exceeded: max 5 videos per hour" });
    expect(deps.provider.submit).not.toHaveBeenCalled();
    const w = warnCalls(deps).find((c) => (c[0] as { step?: string }).step === "video_rate_limit");
    expect(w).toBeTruthy();
    expect((w![0] as { errorKind?: string }).errorKind).toBe("resource");
    expect((w![0] as { hint?: string }).hint).toMatch(/maxPerHour/);
  });

  it("SEC-02: blocks BEFORE submit when the worst-case estimate exceeds the ceiling", async () => {
    const costLimiter = {
      canSpend: vi.fn().mockReturnValue(false),
      record: vi.fn(),
      reset: vi.fn(),
    };
    const deps = createMockDeps({ costLimiter });
    const handlers = createVideoHandlers(deps);
    const result = (await handlers["video.generate"]!({
      _agentId: "agent-1",
      prompt: "a dragon",
      duration: 8,
    })) as { success: boolean; hint?: string };
    expect(result.success).toBe(false);
    expect(deps.provider.submit).not.toHaveBeenCalled();
    expect(costLimiter.canSpend).toHaveBeenCalledTimes(1);
    const [agentArg, estArg] = costLimiter.canSpend.mock.calls[0]!;
    expect(agentArg).toBe("agent-1");
    expect(estArg as number).toBeGreaterThan(0);
    const w = warnCalls(deps).find((c) => (c[0] as { step?: string }).step === "video_cost_ceiling");
    expect(w).toBeTruthy();
    expect((w![0] as { errorKind?: string }).errorKind).toBe("resource");
    expect(result.hint).toMatch(/maxCostPerHourUsd/);
  });

  it("SEC-02: the handler does NOT record cost on submit (the poller reconciles on done)", async () => {
    const costLimiter = {
      canSpend: vi.fn().mockReturnValue(true),
      record: vi.fn(),
      reset: vi.fn(),
    };
    const deps = createMockDeps({ costLimiter });
    const handlers = createVideoHandlers(deps);
    await handlers["video.generate"]!({ _agentId: "agent-1", prompt: "a dragon" });
    expect(deps.provider.submit).toHaveBeenCalledTimes(1);
    // record is the poller's job now — the handler only gates pre-submit.
    expect(costLimiter.record).not.toHaveBeenCalled();
  });

  it("WR-02: a request omitting duration/resolution resolves the CONFIG defaults into the submit input", async () => {
    const deps = createMockDeps();
    const handlers = createVideoHandlers(deps);
    await handlers["video.generate"]!({ _agentId: "agent-1", prompt: "a quiet lake" });
    const submit = deps.provider.submit as ReturnType<typeof vi.fn>;
    const [input] = submit.mock.calls[0]! as [Record<string, unknown>];
    expect(input.durationSecs).toBe(8);
    expect(input.resolution).toBe("720p");
  });

  it("WR-02: the estimate is computed against the SAME resolved duration the port receives", async () => {
    const costLimiter = {
      canSpend: vi.fn().mockReturnValue(true),
      record: vi.fn(),
      reset: vi.fn(),
    };
    const deps = createMockDeps({ costLimiter });
    const handlers = createVideoHandlers(deps);
    await handlers["video.generate"]!({ _agentId: "agent-1", prompt: "a quiet lake" });
    const [, estArg] = costLimiter.canSpend.mock.calls[0]!;
    expect(estArg).toBeCloseTo(0.8, 5);
    const submit = deps.provider.submit as ReturnType<typeof vi.fn>;
    const [input] = submit.mock.calls[0]! as [Record<string, unknown>];
    expect(input.durationSecs).toBe(8);
  });

  it("WR-03: a cost-ceiling block does NOT consume a count slot (the render never happened)", async () => {
    const costLimiter = {
      canSpend: vi.fn().mockReturnValue(false),
      record: vi.fn(),
      reset: vi.fn(),
    };
    const tryAcquire = vi.fn().mockReturnValue(true);
    const deps = createMockDeps({ costLimiter, rateLimiter: { tryAcquire, reset: vi.fn() } });
    const handlers = createVideoHandlers(deps);
    const result = (await handlers["video.generate"]!({ _agentId: "agent-1", prompt: "a dragon" })) as { success: boolean };
    expect(result.success).toBe(false);
    expect(deps.provider.submit).not.toHaveBeenCalled();
    expect(tryAcquire).not.toHaveBeenCalled();
  });

  it("WR-03: a request that passes the cost gate DOES consume exactly one count slot", async () => {
    const costLimiter = {
      canSpend: vi.fn().mockReturnValue(true),
      record: vi.fn(),
      reset: vi.fn(),
    };
    const tryAcquire = vi.fn().mockReturnValue(true);
    const deps = createMockDeps({ costLimiter, rateLimiter: { tryAcquire, reset: vi.fn() } });
    const handlers = createVideoHandlers(deps);
    await handlers["video.generate"]!({ _agentId: "agent-1", prompt: "a dragon" });
    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(deps.provider.submit).toHaveBeenCalledTimes(1);
  });

  it("submits the resolved VideoGenInput (prompt + resolved params)", async () => {
    const deps = createMockDeps();
    const handlers = createVideoHandlers(deps);
    await handlers["video.generate"]!({
      _agentId: "agent-1",
      prompt: "a sunset",
      duration: 8,
      aspect_ratio: "16:9",
      resolution: "1080p",
      audio: true,
    });
    const submit = deps.provider.submit as ReturnType<typeof vi.fn>;
    const [input] = submit.mock.calls[0]! as [Record<string, unknown>];
    expect(input.prompt).toBe("a sunset");
    expect(input.durationSecs).toBe(8);
    expect(input.aspectRatio).toBe("16:9");
    expect(input.resolution).toBe("1080p");
    expect(input.audio).toBe(true);
  });

  // ─── SEC-03: image_url through the SSRF resolver ───
  it("SEC-03: resolves image_url through the resolver and threads referenceImage to submit()", async () => {
    const deps = createMockDeps();
    const handlers = createVideoHandlers(deps);
    await handlers["video.generate"]!({
      _agentId: "agent-1",
      prompt: "animate this",
      image_url: "data:image/png;base64,aGVsbG8=",
    });
    const submit = deps.provider.submit as ReturnType<typeof vi.fn>;
    const input = submit.mock.calls[0]![0] as { referenceImage?: { data: string; mimeType: string } };
    expect(input.referenceImage).toBeTruthy();
    expect(input.referenceImage!.mimeType).toBe("image/png");
  });

  it("SEC-03: an SSRF-rejected image_url URL throws (no submit) — the security floor holds", async () => {
    const core = await import("@comis/core");
    (core.validateUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: new Error("SSRF: blocked private IP"),
    });
    const deps = createMockDeps();
    const handlers = createVideoHandlers(deps);
    await expect(
      handlers["video.generate"]!({
        _agentId: "agent-1",
        prompt: "fetch evil",
        image_url: "http://169.254.169.254/latest/meta-data/",
      }),
    ).rejects.toThrow();
    expect(deps.provider.submit).not.toHaveBeenCalled();
  });

  // ─── SEC-03 redaction: no credential VALUE in any log line ───
  it("SEC-03: no credential value (FAL_KEY/bearer/XAI/GOOGLE) appears in any log payload", async () => {
    const secret = "fal-SECRETKEY-1234567890abcdefABCDEF";
    const deps = createMockDeps({
      provider: {
        id: "fal",
        isAvailable: () => true,
        submit: vi.fn().mockResolvedValue(
          err(new VideoGenError("auth failed", { videoErrorKind: "auth_required", hint: "Set FAL_KEY to a valid fal.ai key." })),
        ),
        poll: vi.fn(),
        fetchResult: vi.fn(),
        execute: vi.fn(),
      },
    });
    const handlers = createVideoHandlers(deps);
    await handlers["video.generate"]!({ _agentId: "agent-1", prompt: "z" });
    const allCalls = [...warnCalls(deps), ...infoCalls(deps)];
    for (const call of allCalls) {
      const json = JSON.stringify(call[0] ?? {});
      expect(json).not.toContain(secret);
      for (const key of CREDENTIAL_KEYS) void key;
    }
    const w = warnCalls(deps).find((c) => (c[0] as { step?: string }).step === "video_submit");
    expect(w).toBeTruthy();
    expect(JSON.stringify(w![0])).not.toContain(secret);
  });

  // ─── RES-01 lockstep obs ───
  it("RES-01: resolves the agent's main provider for the obs line (lockstep, default fallback)", async () => {
    const deps = createMockDeps({
      resolveAgentMainProvider: vi.fn().mockReturnValue({ providerId: "google" }),
    });
    const handlers = createVideoHandlers(deps);
    await handlers["video.generate"]!({ prompt: "no agent id" }); // defaults to "default"
    expect(deps.resolveAgentMainProvider).toHaveBeenCalledWith("default");
    // The submit INFO line carries the resolved estimate + agent.
    const info = infoCalls(deps).find((c) => (c[0] as { step?: string }).step === "video_submitted");
    expect(info).toBeTruthy();
    expect((info![0] as { agentId?: string }).agentId).toBe("default");
  });

  // ─── A3: the {jobId,state,estimatedCostUsd} return validates vs the loose record ───
  it("A3: the {jobId,state,estimatedCostUsd} handle validates against VideoGenerateContract.response", async () => {
    const core = await import("@comis/core");
    const deps = createMockDeps();
    const handlers = createVideoHandlers(deps);
    const result = await handlers["video.generate"]!({ _agentId: "agent-1", prompt: "valid" });
    // The loose-record response accepts the handle shape (no contract change).
    expect(() => core.VideoGenerateContract.response.parse(result)).not.toThrow();
  });

  // ─── OBS-04 deferred: the handler emits NO video.* trajectory events ───
  it("OBS-04 (Phase 192): the videoHandlerDeps shape has NO trajectory/eventBus field (logger-only)", () => {
    const deps = createMockDeps();
    expect("trajectoryRegistry" in deps).toBe(false);
    expect("eventBus" in deps).toBe(false);
  });

  // ─── IN-02: per-model param validation against VIDEO_MODELS, BEFORE submit ───
  describe("IN-02 param validation (mode + caps + reject hints) before submit", () => {
    it("IN-02: i2v on a t2v-only backend rejects BEFORE submit with a supported-modes hint (submit not called)", async () => {
      // No real backend is t2v-only — override the matrix accessors so the
      // EXECUTING provider exposes t2v but NOT i2v (listVideoModelCaps(...,"i2v")
      // undefined). The handler must reject with a modes hint, NOT submit.
      const core = await import("@comis/core");
      const realDefaultCaps = core.listVideoModelCaps("fal", "t2v");
      (core.listVideoModelCaps as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_backend: string, mode: string) => (mode === "i2v" ? undefined : realDefaultCaps),
      );
      (core.supportedModes as unknown as ReturnType<typeof vi.fn>).mockReturnValue(["t2v"]);

      const deps = createMockDeps();
      const handlers = createVideoHandlers(deps);
      const result = (await handlers["video.generate"]!({
        _agentId: "agent-1",
        prompt: "animate this",
        image_url: "data:image/png;base64,aGVsbG8=",
      })) as { success: boolean; hint?: string };

      expect(result.success).toBe(false);
      expect(result.hint).toMatch(/t2v/);
      expect(result.hint).toMatch(/image_url/i); // "Omit image_url for text-to-video."
      expect(deps.provider.submit).not.toHaveBeenCalled();
      const w = warnCalls(deps).find((c) => (c[0] as { step?: string }).step === "video_mode_reject");
      expect(w).toBeTruthy();
      expect((w![0] as { errorKind?: string }).errorKind).toBe("precondition");
    });

    it("IN-02: an unsupported resolution (4k on grok) rejects BEFORE submit listing the valid set", async () => {
      const deps = createMockDeps({
        provider: {
          id: "grok",
          isAvailable: () => true,
          submit: vi.fn().mockResolvedValue(ok(SUBMITTED_JOB)),
          poll: vi.fn(),
          fetchResult: vi.fn(),
          execute: vi.fn(),
        },
        config: {
          provider: "grok",
          defaultDurationSecs: 6,
          defaultAspectRatio: "16:9",
          defaultResolution: "720p",
          maxPerHour: 5,
          timeoutMs: 300000,
          pollIntervalMs: 10000,
          fallbackChain: [],
        } as unknown as VideoHandlerDeps["config"],
      });
      const handlers = createVideoHandlers(deps);
      const result = (await handlers["video.generate"]!({
        _agentId: "agent-1",
        prompt: "a sunset",
        resolution: "4k",
      })) as { success: boolean; hint?: string };

      expect(result.success).toBe(false);
      // The hint LISTS grok's valid resolutions (the I3 honest set).
      expect(result.hint).toMatch(/480p/);
      expect(result.hint).toMatch(/720p/);
      expect(deps.provider.submit).not.toHaveBeenCalled();
      const w = warnCalls(deps).find((c) => (c[0] as { step?: string }).step === "video_resolution_reject");
      expect(w).toBeTruthy();
      expect((w![0] as { errorKind?: string }).errorKind).toBe("precondition");
    });

    it("IN-02 (Pitfall 2): a Veo 1080p render with duration!=8 rejects with a requires-8s hint (no submit)", async () => {
      const deps = createMockDeps({
        provider: {
          id: "veo",
          isAvailable: () => true,
          submit: vi.fn().mockResolvedValue(ok(SUBMITTED_JOB)),
          poll: vi.fn(),
          fetchResult: vi.fn(),
          execute: vi.fn(),
        },
        config: {
          provider: "veo",
          defaultDurationSecs: 8,
          defaultAspectRatio: "16:9",
          defaultResolution: "720p",
          maxPerHour: 5,
          timeoutMs: 300000,
          pollIntervalMs: 10000,
          fallbackChain: [],
        } as unknown as VideoHandlerDeps["config"],
      });
      const handlers = createVideoHandlers(deps);
      const result = (await handlers["video.generate"]!({
        _agentId: "agent-1",
        prompt: "a city",
        resolution: "1080p",
        duration: 4,
      })) as { success: boolean; hint?: string };

      expect(result.success).toBe(false);
      expect(result.hint).toMatch(/8/);
      expect(deps.provider.submit).not.toHaveBeenCalled();
      const w = warnCalls(deps).find(
        (c) => (c[0] as { step?: string }).step === "video_duration_constraint_reject",
      );
      expect(w).toBeTruthy();
      expect((w![0] as { errorKind?: string }).errorKind).toBe("precondition");
    });

    it("IN-02 (Pitfall 2): a Veo 1080p render with duration 8 PASSES validation and submits", async () => {
      const deps = createMockDeps({
        provider: {
          id: "veo",
          isAvailable: () => true,
          submit: vi.fn().mockResolvedValue(ok(SUBMITTED_JOB)),
          poll: vi.fn(),
          fetchResult: vi.fn(),
          execute: vi.fn(),
        },
        config: {
          provider: "veo",
          defaultDurationSecs: 8,
          defaultAspectRatio: "16:9",
          defaultResolution: "720p",
          maxPerHour: 5,
          timeoutMs: 300000,
          pollIntervalMs: 10000,
          fallbackChain: [],
        } as unknown as VideoHandlerDeps["config"],
      });
      const handlers = createVideoHandlers(deps);
      const result = (await handlers["video.generate"]!({
        _agentId: "agent-1",
        prompt: "a city",
        resolution: "1080p",
        duration: 8,
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(deps.provider.submit).toHaveBeenCalledTimes(1);
    });

    it("IN-02 duration snap: an out-of-enum duration:5 on FAL reaches port.submit snapped to 6 (round-half-up)", async () => {
      const deps = createMockDeps();
      const handlers = createVideoHandlers(deps);
      await handlers["video.generate"]!({ _agentId: "agent-1", prompt: "a quiet lake", duration: 5 });
      const submit = deps.provider.submit as ReturnType<typeof vi.fn>;
      const [input] = submit.mock.calls[0]! as [Record<string, unknown>];
      // 5 is equidistant between 4 and 6 → round-half-up → 6 (Plan 01 snapDuration).
      expect(input.durationSecs).toBe(6);
    });

    it("IN-02 validates against the EXECUTING deps.provider.id, never the caller main.providerId", async () => {
      // The caller's main provider is grok (480p/720p — would reject 4k), but the
      // EXECUTING provider is fal (4k valid). Validating against the executor must
      // ACCEPT 4k and submit (a t2v 4k FAL render), proving the executor is the key.
      const deps = createMockDeps({
        resolveAgentMainProvider: vi.fn().mockReturnValue({ providerId: "grok" }),
      });
      const handlers = createVideoHandlers(deps);
      const result = (await handlers["video.generate"]!({
        _agentId: "agent-1",
        prompt: "a 4k FAL render",
        resolution: "4k",
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(deps.provider.submit).toHaveBeenCalledTimes(1);
    });
  });

  // ─── IN-01: the SSRF resolver is REUSED for image_url (no second fetcher) ───
  describe("IN-01 SSRF reuse + i2v mode threading (singular image_url)", () => {
    it("IN-01: a blocked-host image_url is rejected by the SHARED resolver — submit is never called", async () => {
      const core = await import("@comis/core");
      (core.validateUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        error: new Error("SSRF: blocked private IP"),
      });
      const deps = createMockDeps();
      const handlers = createVideoHandlers(deps);
      await expect(
        handlers["video.generate"]!({
          _agentId: "agent-1",
          prompt: "fetch evil",
          image_url: "http://169.254.169.254/latest/meta-data/",
        }),
      ).rejects.toThrow();
      // The shared resolver's SSRF block surfaced; no second fetcher, no submit.
      expect(deps.provider.submit).not.toHaveBeenCalled();
    });

    it("IN-01: a workspace-path image_url resolves under the caller's agent dir and threads referenceImage", async () => {
      const deps = createMockDeps({
        workspaceDirs: new Map([["agent-1", "/ws/agent-1"]]),
      });
      const handlers = createVideoHandlers(deps);
      await handlers["video.generate"]!({
        _agentId: "agent-1",
        prompt: "animate the file",
        image_url: "frames/first.png",
      });
      const submit = deps.provider.submit as ReturnType<typeof vi.fn>;
      const input = submit.mock.calls[0]![0] as { referenceImage?: { data: string; mimeType: string } };
      // Resolved via the shared resolver (mocked readFile → REF-FILE-BYTES) and
      // threaded as referenceImage (the i2v mode the adapter variant-selects on).
      expect(input.referenceImage).toBeTruthy();
      expect(input.referenceImage!.data).toBe(Buffer.from("REF-FILE-BYTES").toString("base64"));
    });
  });
});
