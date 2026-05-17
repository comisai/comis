// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createMediaTestController } from "./media-test-controller.js";

function makeHost(): ReactiveControllerHost & { _updates: number } {
  return {
    _updates: 0,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate(): void {
      (this as { _updates: number })._updates += 1;
    },
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost & { _updates: number };
}

describe("MediaTestController", () => {
  it("getProviders: invokes media.providers with no params + returns the info shape", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        stt: { provider: "openai", model: "whisper-1" },
        tts: { provider: "elevenlabs", voice: "rachel", format: "mp3" },
      };
    });
    const controller = createMediaTestController(host, rpc);
    const result = await controller.getProviders();
    expect((seen[0] as unknown[])[0]).toBe("media.providers");
    expect((seen[0] as unknown[]).length).toBe(1);
    expect(result.stt?.provider).toBe("openai");
    expect(result.tts?.voice).toBe("rachel");
  });

  it("testStt: forwards audio + mimeType to media.test.stt", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { text: "hello world", language: "en" };
    });
    const controller = createMediaTestController(host, rpc);
    const result = await controller.testStt({
      audio: "AAAA",
      mimeType: "audio/wav",
    });
    expect((seen[0] as unknown[])[0]).toBe("media.test.stt");
    expect((seen[0] as unknown[])[1]).toEqual({
      audio: "AAAA",
      mimeType: "audio/wav",
    });
    expect(result.text).toBe("hello world");
  });

  it("testTts: forwards text + optional voice to media.test.tts", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { audio: "BBBB", mimeType: "audio/mpeg" };
    });
    const controller = createMediaTestController(host, rpc);
    await controller.testTts({ text: "hi", voice: "alpha" });
    await controller.testTts({ text: "hi" });
    expect((seen[0] as unknown[])[0]).toBe("media.test.tts");
    expect((seen[0] as unknown[])[1]).toEqual({ text: "hi", voice: "alpha" });
    expect((seen[1] as unknown[])[1]).toEqual({ text: "hi" });
  });

  it("testVision / testDocument / testVideo: forward payloads with prompt option + mimeType", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createMediaTestController(host, rpc);
    await controller.testVision({
      image: "img",
      mimeType: "image/png",
      prompt: "describe",
    });
    await controller.testDocument({
      file: "doc",
      mimeType: "application/pdf",
      fileName: "spec.pdf",
    });
    await controller.testVideo({
      video: "vid",
      mimeType: "video/mp4",
      prompt: "summarize",
    });
    expect((seen[0] as unknown[])[0]).toBe("media.test.vision");
    expect((seen[0] as unknown[])[1]).toEqual({
      image: "img",
      mimeType: "image/png",
      prompt: "describe",
    });
    expect((seen[1] as unknown[])[0]).toBe("media.test.document");
    expect((seen[1] as unknown[])[1]).toEqual({
      file: "doc",
      mimeType: "application/pdf",
      fileName: "spec.pdf",
    });
    expect((seen[2] as unknown[])[0]).toBe("media.test.video");
    expect((seen[2] as unknown[])[1]).toEqual({
      video: "vid",
      mimeType: "video/mp4",
      prompt: "summarize",
    });
  });

  it("testLink: forwards url to media.test.link", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { title: "example", description: "" };
    });
    const controller = createMediaTestController(host, rpc);
    const result = await controller.testLink({ url: "https://example.com" });
    expect((seen[0] as unknown[])[0]).toBe("media.test.link");
    expect((seen[0] as unknown[])[1]).toEqual({ url: "https://example.com" });
    expect(result.title).toBe("example");
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("media handler offline");
    });
    const controller = createMediaTestController(host, rpc);
    await expect(controller.getProviders()).rejects.toThrow(
      "media handler offline",
    );
    await expect(
      controller.testStt({ audio: "a", mimeType: "audio/wav" }),
    ).rejects.toThrow("media handler offline");
    await expect(controller.testTts({ text: "x" })).rejects.toThrow(
      "media handler offline",
    );
    await expect(
      controller.testVision({ image: "i", mimeType: "image/png" }),
    ).rejects.toThrow("media handler offline");
    await expect(
      controller.testDocument({
        file: "f",
        mimeType: "application/pdf",
        fileName: "x.pdf",
      }),
    ).rejects.toThrow("media handler offline");
    await expect(
      controller.testVideo({ video: "v", mimeType: "video/mp4" }),
    ).rejects.toThrow("media handler offline");
    await expect(controller.testLink({ url: "x" })).rejects.toThrow(
      "media handler offline",
    );
  });

  it("hostConnected / hostDisconnected: are no-ops (view drives lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createMediaTestController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createMediaTestController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
