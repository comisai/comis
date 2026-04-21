// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppContainer, ChannelPort, Attachment, NormalizedMessage } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCompositeResolver = {
  resolve: vi.fn(),
  schemes: ["tg://", "whatsapp://"],
};

vi.mock("@comis/channels", () => ({
  createWhatsAppResolver: vi.fn(() => ({ resolve: vi.fn(), schemes: ["whatsapp://"] })),
  createSlackResolver: vi.fn(() => ({ resolve: vi.fn(), schemes: ["slack://"] })),
  createIMessageResolver: vi.fn(() => ({ resolve: vi.fn(), schemes: ["imessage://"] })),
  audioPreflight: vi.fn(async () => ({ transcribed: true })),
}));

vi.mock("@comis/skills", () => ({
  createCompositeResolver: vi.fn(() => mockCompositeResolver),
  createMediaPersistenceService: vi.fn(() => ({ persist: vi.fn() })),
  preprocessMessage: vi.fn(async (_deps: any, msg: NormalizedMessage) => ({
    message: msg,
    imageContents: [],
    fileExtractions: [],
  })),
  sanitizeImageForApi: vi.fn(),
  createVisionProviderRegistry: vi.fn(() => ({})),
  selectVisionProvider: vi.fn(() => undefined),
}));

vi.mock("@comis/agent", () => ({
  isVisionCapable: vi.fn(() => false),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn(() => null),
}));

import { buildMediaPipeline, type MediaPipelineDeps } from "./setup-channels-media.js";
import {
  createWhatsAppResolver,
  createSlackResolver,
  createIMessageResolver,
  audioPreflight as audioPreflightFn,
} from "@comis/channels";
import { createCompositeResolver, preprocessMessage } from "@comis/skills";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as ComisLogger;
}

function makeContainer(overrides: Record<string, any> = {}): AppContainer {
  return {
    config: {
      agents: overrides.agents ?? { default: { name: "TestBot", provider: "anthropic", model: "claude-opus-4-6" } },
      channels: overrides.channels ?? {
        slack: { botToken: undefined },
      },
      integrations: {
        media: {
          persistence: { enabled: false, maxFileBytes: 10_000_000 },
          transcription: { autoTranscribe: false },
          tts: {},
          vision: { enabled: false, videoTimeoutMs: 30000, videoMaxDescriptionChars: 500 },
        },
      },
    },
    secretManager: {
      get: vi.fn(() => { throw new Error("not found"); }),
    },
    eventBus: { emit: vi.fn(), on: vi.fn() },
  } as unknown as AppContainer;
}

function makeDeps(overrides: Partial<MediaPipelineDeps> = {}): MediaPipelineDeps {
  return {
    container: makeContainer(overrides as any),
    channelsLogger: makeLogger(),
    adaptersByType: new Map<string, ChannelPort>(),
    ssrfFetcher: { fetch: vi.fn() } as any,
    linkRunner: { processMessage: vi.fn(async (text: string) => ({ enrichedText: text })) } as any,
    maxMediaBytes: 10_000_000,
    defaultAgentId: "default",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildMediaPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates compositeResolver with platform resolvers when adapters present", async () => {
    const whatsappAdapter = { sendMessage: vi.fn(), getRawMessage: vi.fn() } as unknown as ChannelPort;
    const slackAdapter = { sendMessage: vi.fn() } as unknown as ChannelPort;
    const adapters = new Map<string, ChannelPort>([
      ["whatsapp", whatsappAdapter],
      ["slack", slackAdapter],
    ]);

    const container = makeContainer({
      channels: { slack: { botToken: "xoxb-test" } },
    });
    const deps = makeDeps({ adaptersByType: adapters, container });
    const result = await buildMediaPipeline(deps);

    expect(createWhatsAppResolver).toHaveBeenCalled();
    expect(createSlackResolver).toHaveBeenCalled();
    expect(createCompositeResolver).toHaveBeenCalled();
    expect(result.compositeResolver).toBe(mockCompositeResolver);
  });

  it("resolveAttachment returns buffer on success", async () => {
    const buf = Buffer.from("image-data");
    mockCompositeResolver.resolve.mockResolvedValueOnce({ ok: true, value: { buffer: buf } });

    const deps = makeDeps();
    const result = await buildMediaPipeline(deps);
    const resolved = await result.resolveAttachment({ url: "tg://file/abc", type: "image" } as Attachment);

    expect(resolved).toBe(buf);
  });

  it("resolveAttachment returns null and warns on failure", async () => {
    mockCompositeResolver.resolve.mockResolvedValueOnce({ ok: false, error: new Error("timeout") });

    const deps = makeDeps();
    const result = await buildMediaPipeline(deps);
    const resolved = await result.resolveAttachment({ url: "tg://file/abc", type: "image" } as Attachment);

    expect(resolved).toBeNull();
    expect(deps.channelsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "network" }),
      "Media resolution failed",
    );
  });

  it("preprocessMessage calls linkRunner.processMessage when text present", async () => {
    const lr = { processMessage: vi.fn(async (t: string) => ({ enrichedText: `enriched: ${t}` })) };
    const deps = makeDeps({ linkRunner: lr as any });
    const result = await buildMediaPipeline(deps);

    const msg: NormalizedMessage = {
      id: "m1",
      channelId: "c1",
      channelType: "telegram",
      senderId: "u1",
      text: "hello https://example.com",
      timestamp: Date.now(),
      attachments: [],
    };

    await result.preprocessMessage(msg);
    expect(lr.processMessage).toHaveBeenCalledWith("hello https://example.com");
  });

  it("audioPreflight is defined when transcriber provided", async () => {
    const transcriber = { transcribe: vi.fn() } as any;
    const container = makeContainer({ agents: { bot1: { name: "Bot1", provider: "anthropic", model: "claude-opus-4-6" } } });
    const deps = makeDeps({ transcriber, container });
    const result = await buildMediaPipeline(deps);

    expect(result.audioPreflight).toBeDefined();
  });

  it("audioPreflight is undefined when no transcriber", async () => {
    const deps = makeDeps({ transcriber: undefined });
    const result = await buildMediaPipeline(deps);

    expect(result.audioPreflight).toBeUndefined();
  });

  it("creates Telegram resolver from tgPlugin handle", async () => {
    const mockTgResolver = { resolve: vi.fn(), schemes: ["tg://"] };
    const tgPlugin = { createResolver: vi.fn(() => mockTgResolver) } as any;
    const deps = makeDeps({ tgPlugin });
    await buildMediaPipeline(deps);

    expect(tgPlugin.createResolver).toHaveBeenCalledWith(
      expect.objectContaining({ ssrfFetcher: deps.ssrfFetcher, maxBytes: 10_000_000 }),
    );
    // The tg resolver should be passed to createCompositeResolver
    const compositeCall = vi.mocked(createCompositeResolver).mock.calls[0][0];
    expect(compositeCall.resolvers).toContainEqual(mockTgResolver);
  });

  it("calls createCompositeResolver with empty resolvers when no adapters", async () => {
    const deps = makeDeps({ adaptersByType: new Map() });
    await buildMediaPipeline(deps);

    const compositeCall = vi.mocked(createCompositeResolver).mock.calls[0][0];
    expect(compositeCall.resolvers).toHaveLength(0);
  });
});
