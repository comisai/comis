// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock node:child_process and node:fs/promises
// ---------------------------------------------------------------------------
const mockExecFile = vi.fn();
const mockReadFile = vi.fn();
const mockUnlink = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  unlink: mockUnlink,
}));

// Import AFTER mocks are registered
const { createAudioConverter } = await import("./audio-converter.js");

// ---------------------------------------------------------------------------
// Helper: simulate execFile callback behavior
// ---------------------------------------------------------------------------
type ExecCallback = (
  error: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

function setupExecFileSuccess(stdout = "", stderr = ""): void {
  mockExecFile.mockImplementation(
    (
      _binary: string,
      _args: string[],
      _opts: Record<string, unknown>,
      callback: ExecCallback,
    ) => {
      callback(null, { stdout, stderr });
    },
  );
}

function setupExecFilePerBinary(
  behaviors: Record<string, { stdout?: string; stderr?: string; error?: Error }>,
): void {
  mockExecFile.mockImplementation(
    (
      binary: string,
      _args: string[],
      _opts: Record<string, unknown>,
      callback: ExecCallback,
    ) => {
      const b = behaviors[binary];
      if (b?.error) {
        callback(b.error);
      } else {
        callback(null, { stdout: b?.stdout ?? "", stderr: b?.stderr ?? "" });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Shared logger spy
describe("AudioConverter", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockExecFile.mockReset();
    mockReadFile.mockReset();
    mockUnlink.mockReset();
    logger = createMockLogger();
  });

  describe("toOggOpus", () => {
    it("calls ffmpeg with correct arguments", async () => {
      // First call: ffmpeg encode (succeeds)
      // Second call: ffprobe duration (returns "3.456")
      let callCount = 0;
      mockExecFile.mockImplementation(
        (
          _binary: string,
          _args: string[],
          _opts: Record<string, unknown>,
          callback: ExecCallback,
        ) => {
          callCount++;
          if (callCount === 1) {
            // ffmpeg encode
            callback(null, { stdout: "", stderr: "" });
          } else {
            // ffprobe duration
            callback(null, { stdout: "3.456\n", stderr: "" });
          }
        },
      );

      const converter = createAudioConverter({ logger });
      const result = await converter.toOggOpus("/tmp/input.mp3", "/tmp/output.ogg");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.codec).toBe("opus");
      expect(result.value.outputPath).toBe("/tmp/output.ogg");

      // Verify ffmpeg was called with correct encode args
      const firstCall = mockExecFile.mock.calls[0];
      expect(firstCall[0]).toBe("ffmpeg");
      expect(firstCall[1]).toEqual([
        "-y", "-i", "/tmp/input.mp3",
        "-c:a", "libopus", "-b:a", "64k",
        "-threads", "1",
        "/tmp/output.ogg",
      ]);
    });

    it("returns err when ffmpeg fails", async () => {
      const ffmpegError = new Error("ffmpeg encode failed");
      (ffmpegError as unknown as { stderr: string }).stderr = "Error: codec not found";

      mockExecFile.mockImplementation(
        (
          _binary: string,
          _args: string[],
          _opts: Record<string, unknown>,
          callback: ExecCallback,
        ) => {
          callback(ffmpegError);
        },
      );

      const converter = createAudioConverter({ logger });
      const result = await converter.toOggOpus("/tmp/input.mp3", "/tmp/output.ogg");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toBe("ffmpeg encode failed");

      // Verify logger.error was called with hint and errorKind
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: expect.stringContaining("ffmpeg failed to convert audio"),
          errorKind: "dependency",
        }),
        "ffmpeg process failed",
      );
    });

    it("logs conversion details at DEBUG", async () => {
      // First call: ffmpeg encode, second: ffprobe duration
      let callCount = 0;
      mockExecFile.mockImplementation(
        (
          _binary: string,
          _args: string[],
          _opts: Record<string, unknown>,
          callback: ExecCallback,
        ) => {
          callCount++;
          if (callCount === 1) {
            callback(null, { stdout: "", stderr: "" });
          } else {
            callback(null, { stdout: "2.5\n", stderr: "" });
          }
        },
      );

      const converter = createAudioConverter({ logger });
      await converter.toOggOpus("/data/music/input.mp3", "/data/music/output.ogg");

      // Verify conversion details
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          inputFormat: "mp3",
          outputFormat: "ogg/opus",
        }),
        "Audio conversion complete",
      );

      // Verify ffmpeg process lifecycle
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          binary: "ffmpeg",
          exitCode: 0,
        }),
        "ffmpeg process completed",
      );
    });
  });

  describe("extractWaveform", () => {
    it("produces 256 samples as base64", async () => {
      // Mock ffmpeg to succeed
      setupExecFileSuccess();

      // Create a buffer with 1024 Int16 samples (2048 bytes)
      const int16Buf = Buffer.alloc(2048);
      for (let i = 0; i < 1024; i++) {
        // Write varying amplitude values
        int16Buf.writeInt16LE(Math.floor(Math.sin(i / 10) * 16384), i * 2);
      }
      mockReadFile.mockResolvedValue(int16Buf);
      mockUnlink.mockResolvedValue(undefined);

      const converter = createAudioConverter({ logger });
      const result = await converter.extractWaveform("/tmp/input.ogg", "/tmp");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sampleCount).toBe(256);
      // Verify it's valid base64
      const decoded = Buffer.from(result.value.waveformBase64, "base64");
      expect(decoded.length).toBe(256);
      // Verify cleanup was called
      expect(mockUnlink).toHaveBeenCalled();
    });
  });

  describe("getDuration", () => {
    it("parses ffprobe output", async () => {
      setupExecFileSuccess("3.456\n");

      const converter = createAudioConverter({ logger });
      const result = await converter.getDuration("/tmp/audio.ogg");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(3456);
    });
  });

  describe("verifyOpusCodec", () => {
    it("returns true for opus", async () => {
      setupExecFileSuccess("opus\n");

      const converter = createAudioConverter({ logger });
      const result = await converter.verifyOpusCodec("/tmp/audio.ogg");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(true);
    });

    it("returns false for vorbis", async () => {
      setupExecFileSuccess("vorbis\n");

      const converter = createAudioConverter({ logger });
      const result = await converter.verifyOpusCodec("/tmp/audio.ogg");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(false);
    });
  });
});
