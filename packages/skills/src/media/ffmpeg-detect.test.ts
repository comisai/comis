// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------
const mockExecFile = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// Import AFTER mock is registered
const { detectFfmpeg } = await import("./ffmpeg-detect.js");

// ---------------------------------------------------------------------------
// Helper: make mockExecFile behave like the callback-style execFile
// that promisify wraps. Each call gets (binary, args, opts, callback).
// ---------------------------------------------------------------------------
function setupExecFile(
  ffmpegBehavior: "success" | "enoent" | "timeout",
  ffprobeBehavior: "success" | "enoent" | "timeout",
): void {
  mockExecFile.mockImplementation(
    (
      binary: string,
      _args: string[],
      _opts: Record<string, unknown>,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      const behavior = binary === "ffmpeg" ? ffmpegBehavior : ffprobeBehavior;

      if (behavior === "success") {
        const version =
          binary === "ffmpeg"
            ? "ffmpeg version 6.1.1 Copyright (c) 2000-2023"
            : "ffprobe version 6.1.1 Copyright (c) 2007-2023";
        callback(null, { stdout: `${version}\nbuilt with gcc`, stderr: "" });
      } else if (behavior === "enoent") {
        const error = new Error(`spawn ${binary} ENOENT`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        callback(error);
      } else {
        // timeout
        const error = new Error(`${binary} timed out`);
        (error as NodeJS.ErrnoException).code = "ERR_CHILD_PROCESS_TIMEOUT";
        callback(error);
      }
    },
  );
}

describe("detectFfmpeg", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("returns available when both ffmpeg and ffprobe exist", async () => {
    setupExecFile("success", "success");

    const caps = await detectFfmpeg();

    expect(caps.ffmpegAvailable).toBe(true);
    expect(caps.ffprobeAvailable).toBe(true);
    expect(caps.ffmpegVersion).toBe(
      "ffmpeg version 6.1.1 Copyright (c) 2000-2023",
    );
    expect(caps.ffprobeVersion).toBe(
      "ffprobe version 6.1.1 Copyright (c) 2007-2023",
    );
  });

  it("returns unavailable when ffmpeg not found", async () => {
    setupExecFile("enoent", "success");

    const caps = await detectFfmpeg();

    expect(caps.ffmpegAvailable).toBe(false);
    expect(caps.ffprobeAvailable).toBe(true);
    expect(caps.ffmpegVersion).toBeUndefined();
    expect(caps.ffprobeVersion).toBeDefined();
  });

  it("returns unavailable when ffprobe not found", async () => {
    setupExecFile("success", "enoent");

    const caps = await detectFfmpeg();

    expect(caps.ffmpegAvailable).toBe(true);
    expect(caps.ffprobeAvailable).toBe(false);
    expect(caps.ffmpegVersion).toBeDefined();
    expect(caps.ffprobeVersion).toBeUndefined();
  });

  it("returns both unavailable when neither exists", async () => {
    setupExecFile("enoent", "enoent");

    const caps = await detectFfmpeg();

    expect(caps.ffmpegAvailable).toBe(false);
    expect(caps.ffprobeAvailable).toBe(false);
    expect(caps.ffmpegVersion).toBeUndefined();
    expect(caps.ffprobeVersion).toBeUndefined();
  });

  it("handles timeout gracefully", async () => {
    setupExecFile("timeout", "timeout");

    const caps = await detectFfmpeg();

    expect(caps.ffmpegAvailable).toBe(false);
    expect(caps.ffprobeAvailable).toBe(false);
    expect(caps.ffmpegVersion).toBeUndefined();
    expect(caps.ffprobeVersion).toBeUndefined();
  });
});
