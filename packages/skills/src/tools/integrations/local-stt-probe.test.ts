// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the one-shot local STT boot probe.
 *
 * `detectLocalSttEngine` must NEVER throw and must compute availability cheaply
 * (importability + ffmpeg presence, optional baseUrl reachability) WITHOUT ever
 * downloading a model. The reachability fetch and the engine-import check are
 * injected via the `fetchProbe` / `canImportEngine` seams so these tests do no
 * real I/O.
 *
 * Coverage: baseUrl-reachable → mode "baseUrl" (in-process engine NOT consulted);
 * no baseUrl + engine importable + ffmpeg → "in-process"; engine import fails →
 * unavailable; ffmpeg absent → unavailable; both unavailable → "none";
 * never-throws on the worst-case path; the probe triggers no model download.
 */
import { describe, it, expect, vi } from "vitest";
import { detectLocalSttEngine } from "./local-stt-probe.js";

describe("detectLocalSttEngine", () => {
  it("reports available with mode 'baseUrl' and does NOT consult the in-process engine when the baseUrl is reachable", async () => {
    const fetchProbe = vi.fn(async () => true);
    const canImportEngine = vi.fn(async () => true);

    const result = await detectLocalSttEngine({
      baseUrl: "http://127.0.0.1:8000",
      ffmpegAvailable: true,
      fetchProbe,
      canImportEngine,
    });

    expect(result).toMatchObject({ available: true, mode: "baseUrl" });
    expect(fetchProbe).toHaveBeenCalledTimes(1);
    // A reachable server short-circuits — the in-process engine probe is skipped.
    expect(canImportEngine).not.toHaveBeenCalled();
  });

  it("reports available with mode 'in-process' when no baseUrl but the engine is importable and ffmpeg is present", async () => {
    const canImportEngine = vi.fn(async () => true);

    const result = await detectLocalSttEngine({
      ffmpegAvailable: true,
      canImportEngine,
    });

    expect(result).toMatchObject({ available: true, mode: "in-process" });
    expect(canImportEngine).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable when the engine import fails even with ffmpeg present", async () => {
    const canImportEngine = vi.fn(async () => false);

    const result = await detectLocalSttEngine({
      ffmpegAvailable: true,
      canImportEngine,
    });

    expect(result).toMatchObject({ available: false, mode: "none" });
  });

  it("reports unavailable when ffmpeg is absent even if the engine is importable (decode is impossible)", async () => {
    const canImportEngine = vi.fn(async () => true);

    const result = await detectLocalSttEngine({
      ffmpegAvailable: false,
      canImportEngine,
    });

    expect(result).toMatchObject({ available: false, mode: "none" });
    // No baseUrl and no ffmpeg → the engine importability is irrelevant.
    expect(canImportEngine).not.toHaveBeenCalled();
  });

  it("reports unavailable with mode 'none' when there is no baseUrl and the engine is not importable", async () => {
    const result = await detectLocalSttEngine({
      ffmpegAvailable: true,
      canImportEngine: async () => false,
    });

    expect(result).toMatchObject({ available: false, mode: "none" });
  });

  it("treats an unreachable baseUrl as not-reachable and falls through to the in-process path", async () => {
    const fetchProbe = vi.fn(async () => false);
    const canImportEngine = vi.fn(async () => true);

    const result = await detectLocalSttEngine({
      baseUrl: "http://127.0.0.1:8000",
      ffmpegAvailable: true,
      fetchProbe,
      canImportEngine,
    });

    expect(fetchProbe).toHaveBeenCalledTimes(1);
    // baseUrl unreachable → consult the in-process engine.
    expect(result).toMatchObject({ available: true, mode: "in-process" });
    expect(canImportEngine).toHaveBeenCalledTimes(1);
  });

  it("never throws on the worst-case path where every injected check rejects", async () => {
    await expect(
      detectLocalSttEngine({
        baseUrl: "http://127.0.0.1:8000",
        ffmpegAvailable: true,
        fetchProbe: async () => {
          throw new Error("connection refused");
        },
        canImportEngine: async () => {
          throw new Error("engine load blew up");
        },
      }),
    ).resolves.toMatchObject({ available: false });
  });

  it("does not download a model — the probe checks importability only, never loads a pipeline", async () => {
    const canImportEngine = vi.fn(async () => true);

    await detectLocalSttEngine({ ffmpegAvailable: true, canImportEngine });

    // The seam is importability-only; no pipeline/loadEngine call exists here.
    expect(canImportEngine).toHaveBeenCalledTimes(1);
    expect(canImportEngine).toHaveBeenCalledWith();
  });

  // ---------------------------------------------------------------------------
  // SEC-02 (Surface A): the reachability check is SSRF-guarded BEFORE the fetch.
  // A non-loopback / unconfigured baseUrl must be treated as not-reachable
  // (the guard rejects it before any fetch fires); a loopback baseUrl still
  // resolves to mode "baseUrl". validateLocalServerUrl runs first.
  // ---------------------------------------------------------------------------
  describe("SEC-02 SSRF guard on the baseUrl reachability (Surface A)", () => {
    it("treats a cloud-metadata baseUrl as NOT reachable and never invokes the reachability fetch", async () => {
      const fetchProbe = vi.fn(async () => true);
      const canImportEngine = vi.fn(async () => true);

      const result = await detectLocalSttEngine({
        baseUrl: "http://169.254.169.254",
        ffmpegAvailable: true,
        fetchProbe,
        canImportEngine,
      });

      // The guard rejected the URL → the reachability fetch was NEVER called
      // (guard-before-fetch), and the probe fell through to the in-process path.
      expect(fetchProbe).not.toHaveBeenCalled();
      expect(result).toMatchObject({ available: true, mode: "in-process" });
    });

    it("treats a non-loopback private baseUrl as NOT reachable (no fetch) and falls through", async () => {
      const fetchProbe = vi.fn(async () => true);
      const canImportEngine = vi.fn(async () => false);

      const result = await detectLocalSttEngine({
        baseUrl: "http://10.0.0.5:9000",
        ffmpegAvailable: true,
        fetchProbe,
        canImportEngine,
      });

      expect(fetchProbe).not.toHaveBeenCalled();
      // No engine importable either → none.
      expect(result).toMatchObject({ available: false, mode: "none" });
    });

    it("ALLOWS a loopback baseUrl through the guard and reports mode 'baseUrl' when reachable", async () => {
      const fetchProbe = vi.fn(async () => true);
      const canImportEngine = vi.fn(async () => true);

      const result = await detectLocalSttEngine({
        baseUrl: "http://127.0.0.1:8000",
        ffmpegAvailable: true,
        fetchProbe,
        canImportEngine,
      });

      // Loopback passes the guard → the reachability fetch runs → mode "baseUrl".
      expect(fetchProbe).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ available: true, mode: "baseUrl" });
    });

    it("never throws on a malformed baseUrl — the guard rejects it and the probe falls through", async () => {
      const result = await detectLocalSttEngine({
        baseUrl: "not a url",
        ffmpegAvailable: true,
        canImportEngine: async () => false,
      });

      expect(result).toMatchObject({ available: false, mode: "none" });
    });
  });
});
