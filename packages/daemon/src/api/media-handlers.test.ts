// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMediaHandlers } from "./media-handlers.js";
import type { MediaHandlerDeps } from "./media-handlers.js";
import { validateUrl } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock filesystem operations to avoid real disk I/O in tts.synthesize
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ mtimeMs: 0 })),
  unlink: vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.from("file-data")),
}));

// Deterministic UUID for file naming
vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234",
}));

// CR-01: the image.analyze `url` branch now routes through the shared
// DNS-pinned SSRF fetcher (ssrf-image-fetch.ts → undici Agent + fetch). Mock
// `undici` so Agent is a real class (constructor args captured) and `fetch`
// delegates to globalThis.fetch — NEVER the real network.
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

// Mock daemon-utils mime helpers (pure functions, stable returns)
vi.mock("../wiring/daemon-utils.js", () => ({
  guessMimeFromExtension: vi.fn(() => "image/png"),
  detectMimeFromMagicBytes: vi.fn(() => "image/jpeg"),
  mimeToExtension: vi.fn(() => "mp3"),
}));

// VIS-01 (187): the daemon-side vision gate copies the setup-channels-media.ts
// dance — `isVisionCapable(getModel(provider, modelId))`. Mock both so the gate
// is deterministic without a live pi-ai catalog. getModel returns a sentinel
// object; isVisionCapable reads `visionCapableNext` (per-test override). By
// DEFAULT the main is NOT vision-capable → the registry path (VIS-02 today).
const { getModelMock, isVisionCapableMock, visionState } = vi.hoisted(() => {
  const visionState = { capable: false, throwOnResolve: false };
  const getModelMock = vi.fn((_provider: string, _modelId: string) => {
    if (visionState.throwOnResolve) throw new Error("model resolution failed");
    return { input: visionState.capable ? ["text", "image"] : ["text"] };
  });
  const isVisionCapableMock = vi.fn((model: { input: string[] }) => model.input.includes("image"));
  return { getModelMock, isVisionCapableMock, visionState };
});
vi.mock("@comis/agent", () => ({ isVisionCapable: isVisionCapableMock }));
vi.mock("@earendil-works/pi-ai", () => ({ getModel: getModelMock }));

// Mock @comis/skills functions used by handlers
vi.mock("@comis/skills", () => ({
  selectVisionProvider: vi.fn(
    (registry: Map<string, unknown>, _mediaType: string, _preferred?: string) => {
      // Return first provider from registry
      const first = registry.values().next();
      return first.done ? undefined : first.value;
    },
  ),
  resolveVisionScope: vi.fn(() => "allow"),
  shouldAutoTts: vi.fn(() => ({ shouldSynthesize: false })),
  resolveOutputFormat: vi.fn(() => ({ openai: "mp3", mime: "audio/mpeg" })),
  parseTtsDirective: vi.fn((text: string) => ({ cleanText: text, directive: null })),
}));

// Mock @comis/core safePath + validateUrl while preserving the contract
// registry exports + stripInternalFields helper that the refactored handler
// imports from @comis/core.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    safePath: (...segments: string[]) => segments.join("/"),
    // ok WITH a resolved value (hostname/ip/url) so the CR-01 url branch can pin
    // DNS to the validated IP; SSRF-reject tests override per-call.
    validateUrl: vi.fn(async () => ({
      ok: true,
      value: { hostname: "example.com", ip: "93.184.216.34", url: new URL("https://example.com/i.jpg") },
    })),
  };
});

// ---------------------------------------------------------------------------
// Helpers
function makeMockVisionProvider() {
  return {
    describeImage: vi.fn(async () => ({
      ok: true as const,
      value: { text: "A beautiful image", provider: "gemini", model: "gemini-pro-vision" },
    })),
    describeVideo: vi.fn(async () => ({
      ok: true as const,
      value: { text: "A short video clip", provider: "gemini", model: "gemini-pro-vision" },
    })),
  };
}

/** VIS-01 (187): a mock main-provider vision bridge. By default it succeeds
 *  (the bridge resolved the main creds + ran a multimodal completion). Tests
 *  override `.describeImage` for the err→registry-fallback case. */
function makeMockMainProviderVision() {
  return {
    describeImage: vi.fn(async () => ({
      ok: true as const,
      value: { text: "A dog on a skateboard", provider: "anthropic", model: "claude-sonnet-4-5", costUsd: 0.002 },
    })),
  };
}

function makeDeps(overrides?: Partial<MediaHandlerDeps>): MediaHandlerDeps {
  return {
    visionRegistry: new Map([["gemini", makeMockVisionProvider() as never]]),
    // VIS-01 (187): the main-provider vision wiring. Defaults: main = anthropic
    // (vision-capable controlled by `visionState.capable`, default false → the
    // registry path / VIS-02 today), the bridge succeeds when reached.
    resolveAgentMainProvider: vi.fn((_agentId: string) => ({ providerId: "anthropic" })),
    mainModelIdFor: vi.fn((_agentId: string) => "claude-sonnet-4-5"),
    mainProviderVision: makeMockMainProviderVision() as never,
    mediaConfig: {
      imageAnalysis: { maxFileSizeMb: 10 },
      vision: {
        scopeRules: [],
        defaultScopeAction: "allow",
      },
      tts: {
        autoMode: "off" as const,
        tagPattern: "\\[\\[tts\\]\\]",
      },
    },
    ttsAdapter: {
      synthesize: vi.fn(async () => ({
        ok: true as const,
        value: { audio: Buffer.from("audio-data"), mimeType: "audio/mpeg" },
      })),
    } as never,
    linkRunner: {
      processMessage: vi.fn(async () => ({
        enrichedText: "enriched text with link summaries",
        linksProcessed: 1,
        errors: [],
      })),
    } as never,
    workspaceDirs: new Map(),
    defaultWorkspaceDir: "/tmp/test-workspace",
    defaultAgentId: "default",
    logger: createMockLogger(),
    resolveAttachment: vi.fn(async () => Buffer.from("image-data")),
    transcriber: {
      transcribe: vi.fn(async () => ({
        ok: true as const,
        value: { text: "transcribed audio", language: "en", durationMs: 1500 },
      })),
    } as never,
    fileExtractor: {
      extract: vi.fn(async () => ({
        ok: true as const,
        value: {
          text: "extracted document text",
          fileName: "doc.pdf",
          mimeType: "application/pdf",
          extractedChars: 100,
          truncated: false,
          durationMs: 500,
        },
      })),
    } as never,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMediaHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // VIS-01 default posture: main NOT vision-capable → registry path (VIS-02
    // byte-identical to pre-187). Individual tests flip these.
    visionState.capable = false;
    visionState.throwOnResolve = false;
  });

  // -------------------------------------------------------------------------
  // image.analyze
  // -------------------------------------------------------------------------

  describe("image.analyze", () => {
    it("analyzes base64 source via vision provider", async () => {
      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);
      const provider = deps.visionRegistry!.get("gemini")!;

      const result = (await handlers["image.analyze"]!({
        source_type: "base64",
        source: Buffer.from("fake-png").toString("base64"),
        prompt: "Describe this",
      })) as { description: string; provider: string; model: string };

      expect(result.description).toBe("A beautiful image");
      expect(result.provider).toBe("gemini");
      expect(result.model).toBe("gemini-pro-vision");
      expect((provider as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage).toHaveBeenCalledOnce();
    });

    it("throws when no vision registry is available", async () => {
      const deps = makeDeps({ visionRegistry: undefined });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["image.analyze"]!({ source_type: "base64", source: "abc" }),
      ).rejects.toThrow("No vision provider available");
    });

    it("throws when vision registry is empty", async () => {
      const deps = makeDeps({ visionRegistry: new Map() });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["image.analyze"]!({ source_type: "base64", source: "abc" }),
      ).rejects.toThrow("No vision provider available");
    });

    it("resolves attachment_url source via resolveAttachment", async () => {
      const resolveAttachment = vi.fn(async () => Buffer.from("resolved-image"));
      const deps = makeDeps({ resolveAttachment });
      const handlers = createMediaHandlers(deps);

      const result = (await handlers["image.analyze"]!({
        attachment_url: "tg-file://abc123",
      })) as { description: string };

      expect(resolveAttachment).toHaveBeenCalledWith("tg-file://abc123");
      expect(result.description).toBe("A beautiful image");
    });

    it("returns deny message when vision scope rule denies", async () => {
      // Import and override the mock for resolveVisionScope
      const { resolveVisionScope } = await import("@comis/skills");
      (resolveVisionScope as ReturnType<typeof vi.fn>).mockReturnValueOnce("deny");

      const deps = makeDeps({
        mediaConfig: {
          imageAnalysis: { maxFileSizeMb: 10 },
          vision: {
            scopeRules: [{ pattern: "deny-all", action: "deny" }] as never,
            defaultScopeAction: "deny",
          },
          tts: { autoMode: "off" as const, tagPattern: "\\[\\[tts\\]\\]" },
        },
      });
      const handlers = createMediaHandlers(deps);

      const result = (await handlers["image.analyze"]!({
        source_type: "base64",
        source: "abc",
        _channelType: "telegram",
      })) as { description: string };

      expect(result.description).toBe("Vision analysis not available for this context.");
    });

    // ─── CR-01: the `url` source MUST route through the DNS-pinned SSRF ───────
    // fetcher (shared with image-handlers), not a bare fetch that re-resolves
    // DNS. This closes the rebinding TOCTOU gap for image.analyze too.

    it("CR-01: a url source is fetched with a DNS-pinned dispatcher (no rebind window)", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([9, 9, 9]));
            c.close();
          },
        }),
      } as unknown as Response);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      undiciAgentCtor.mockClear();
      try {
        const deps = makeDeps();
        const handlers = createMediaHandlers(deps);

        const result = (await handlers["image.analyze"]!({
          source_type: "url",
          source: "https://example.com/i.jpg",
          prompt: "Describe this",
        })) as { description: string };

        expect(validateUrl).toHaveBeenCalledWith("https://example.com/i.jpg");
        // The pinned Agent (dispatcher) was constructed → DNS pinning enforced.
        expect(undiciAgentCtor).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]! as [string, { redirect?: string; dispatcher?: unknown }];
        expect(url).toBe("https://example.com/i.jpg");
        expect(init.redirect).toBe("error");
        expect(init.dispatcher).toBeDefined();
        expect(result.description).toBe("A beautiful image");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("CR-01: a url source that fails SSRF validation throws before any fetch", async () => {
      (validateUrl as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        error: new Error("blocked private IP"),
      });
      const fetchMock = vi.fn();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      try {
        const deps = makeDeps();
        const handlers = createMediaHandlers(deps);

        await expect(
          handlers["image.analyze"]!({
            source_type: "url",
            source: "http://169.254.169.254/latest/meta-data",
          }),
        ).rejects.toThrow(/SSRF blocked/);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // ─── VIS-01/02/03 (187): the provider-following vision ladder ─────────────
    // main-vision FIRST → registry SECOND → honest-unavailable. The handler is a
    // CONSUMER of resolveVisionPath + deps.mainProviderVision (the 183 firewall).

    describe("VIS-01/02/03 vision ladder", () => {
      it("VIS-01: routes to main-vision FIRST when the main model is vision-capable + has creds", async () => {
        visionState.capable = true;
        const deps = makeDeps();
        const handlers = createMediaHandlers(deps);
        const registryProvider = deps.visionRegistry!.get("gemini")!;

        const result = (await handlers["image.analyze"]!({
          source_type: "base64",
          source: Buffer.from("png").toString("base64"),
          prompt: "what is this",
          _agentId: "default",
        })) as { description: string; provider: string; model: string };

        // The bridge ran; the registry was NOT consulted.
        expect((deps.mainProviderVision as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .toHaveBeenCalledWith(expect.any(Buffer), "what is this", expect.any(String), "default");
        expect((registryProvider as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .not.toHaveBeenCalled();
        expect(result).toEqual({ description: "A dog on a skateboard", provider: "anthropic", model: "claude-sonnet-4-5" });
        // VIS-03 path-log: a content-free line carries path:"main-vision".
        const logged = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls
          .concat((deps.logger.debug as ReturnType<typeof vi.fn>).mock.calls)
          .map((c) => c[0]);
        expect(logged.some((f) => f && (f as { path?: string }).path === "main-vision")).toBe(true);
      });

      it("VIS-01: succeeds via main-vision with NO separate vision-registry key (the bridge owns the cred)", async () => {
        // The registry is EMPTY (no separate vision provider/key), but the main
        // bridge succeeds (its cred came from the main provider).
        visionState.capable = true;
        const deps = makeDeps({ visionRegistry: new Map() });
        const handlers = createMediaHandlers(deps);

        const result = (await handlers["image.analyze"]!({
          source_type: "base64",
          source: "abc",
          _agentId: "default",
        })) as { description: string };

        expect(result.description).toBe("A dog on a skateboard");
        expect((deps.mainProviderVision as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .toHaveBeenCalledOnce();
      });

      it("VIS-02 NON-REGRESSION: a non-vision main is byte-identical to today (registry path, no bridge call)", async () => {
        visionState.capable = false; // the pre-187 world
        const deps = makeDeps();
        const handlers = createMediaHandlers(deps);
        const registryProvider = deps.visionRegistry!.get("gemini")!;

        const result = (await handlers["image.analyze"]!({
          source_type: "base64",
          source: "abc",
          prompt: "Describe this",
          _agentId: "default",
        })) as { description: string; provider: string; model: string };

        // The registry ran exactly as before; the bridge was NOT called.
        expect((registryProvider as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .toHaveBeenCalledWith({ image: expect.any(Buffer), prompt: "Describe this", mimeType: expect.any(String) });
        expect((deps.mainProviderVision as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .not.toHaveBeenCalled();
        expect(result).toEqual({ description: "A beautiful image", provider: "gemini", model: "gemini-pro-vision" });
      });

      it("VIS-02 explicit defaultProvider OVERRIDES main-first (A3 explicit wins → registry)", async () => {
        visionState.capable = true; // main COULD do vision...
        const deps = makeDeps({
          mediaConfig: {
            imageAnalysis: { maxFileSizeMb: 10 },
            vision: { scopeRules: [], defaultScopeAction: "allow", defaultProvider: "gemini" }, // ...but explicit wins
            tts: { autoMode: "off" as const, tagPattern: "\\[\\[tts\\]\\]" },
          },
        });
        const handlers = createMediaHandlers(deps);
        const registryProvider = deps.visionRegistry!.get("gemini")!;

        const result = (await handlers["image.analyze"]!({
          source_type: "base64",
          source: "abc",
          _agentId: "default",
        })) as { description: string };

        expect((deps.mainProviderVision as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .not.toHaveBeenCalled();
        expect((registryProvider as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .toHaveBeenCalledOnce();
        expect(result.description).toBe("A beautiful image");
      });

      it("VIS-01 main-vision RUNTIME failure falls back to the registry (its own keys, never throw-out)", async () => {
        visionState.capable = true;
        const failingBridge = {
          describeImage: vi.fn(async () => ({
            ok: false as const,
            error: Object.assign(new Error("empty"), { errorKind: "empty_response" }),
          })),
        };
        const deps = makeDeps({ mainProviderVision: failingBridge as never });
        const handlers = createMediaHandlers(deps);
        const registryProvider = deps.visionRegistry!.get("gemini")!;

        const result = (await handlers["image.analyze"]!({
          source_type: "base64",
          source: "abc",
          _agentId: "default",
        })) as { description: string };

        expect(failingBridge.describeImage).toHaveBeenCalledOnce();
        expect((registryProvider as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .toHaveBeenCalledOnce();
        expect(result.description).toBe("A beautiful image"); // the registry's result
      });

      it("VIS-03 honest-unavailable (errorKind) when neither main-vision nor a registry provider resolves", async () => {
        // main not vision-capable AND empty registry → honest-unavailable.
        visionState.capable = false;
        const deps = makeDeps({ visionRegistry: new Map() });
        const handlers = createMediaHandlers(deps);

        await expect(
          handlers["image.analyze"]!({ source_type: "base64", source: "abc", _agentId: "default" }),
        ).rejects.toThrow(/vision provider available/i);
      });

      it("VIS-03 the gate is conservative when getModel throws (model resolution failure → registry)", async () => {
        visionState.capable = true;
        visionState.throwOnResolve = true; // getModel throws → visionCapable=false
        const deps = makeDeps();
        const handlers = createMediaHandlers(deps);
        const registryProvider = deps.visionRegistry!.get("gemini")!;

        await handlers["image.analyze"]!({ source_type: "base64", source: "abc", _agentId: "default" });

        expect((deps.mainProviderVision as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .not.toHaveBeenCalled();
        expect((registryProvider as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .toHaveBeenCalledOnce();
      });

      it("security floor RETAINED: a denied scope short-circuits BEFORE any tier (no bridge, no registry)", async () => {
        visionState.capable = true;
        const { resolveVisionScope } = await import("@comis/skills");
        (resolveVisionScope as ReturnType<typeof vi.fn>).mockReturnValueOnce("deny");
        const deps = makeDeps({
          mediaConfig: {
            imageAnalysis: { maxFileSizeMb: 10 },
            vision: { scopeRules: [{ pattern: "x", action: "deny" }] as never, defaultScopeAction: "deny" },
            tts: { autoMode: "off" as const, tagPattern: "\\[\\[tts\\]\\]" },
          },
        });
        const handlers = createMediaHandlers(deps);
        const registryProvider = deps.visionRegistry!.get("gemini")!;

        const result = (await handlers["image.analyze"]!({
          source_type: "base64",
          source: "abc",
          _channelType: "telegram",
          _agentId: "default",
        })) as { description: string };

        expect(result.description).toBe("Vision analysis not available for this context.");
        expect((deps.mainProviderVision as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .not.toHaveBeenCalled();
        expect((registryProvider as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .not.toHaveBeenCalled();
      });

      it("security floor RETAINED: the buffer size cap still fires on the main-vision path", async () => {
        visionState.capable = true;
        const deps = makeDeps({
          mediaConfig: {
            imageAnalysis: { maxFileSizeMb: 0.000001 }, // ~1 byte limit → any image exceeds
            vision: { scopeRules: [], defaultScopeAction: "allow" },
            tts: { autoMode: "off" as const, tagPattern: "\\[\\[tts\\]\\]" },
          },
        });
        const handlers = createMediaHandlers(deps);

        await expect(
          handlers["image.analyze"]!({
            source_type: "base64",
            source: Buffer.from("a much larger payload than one byte").toString("base64"),
            _agentId: "default",
          }),
        ).rejects.toThrow(/exceeds limit/);
        expect((deps.mainProviderVision as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
          .not.toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // tts.synthesize
  // -------------------------------------------------------------------------

  describe("tts.synthesize", () => {
    it("synthesizes text and returns filePath/mimeType/sizeBytes", async () => {
      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);

      const result = (await handlers["tts.synthesize"]!({
        text: "Hello world",
      })) as { filePath: string; mimeType: string; sizeBytes: number };

      expect(result.filePath).toContain("tts-test-uuid-1234.mp3");
      expect(result.mimeType).toBe("audio/mpeg");
      expect(result.sizeBytes).toBe(Buffer.from("audio-data").byteLength);
      expect(
        (deps.ttsAdapter as unknown as { synthesize: ReturnType<typeof vi.fn> }).synthesize,
      ).toHaveBeenCalledOnce();
    });

    it("throws when TTS adapter is not configured", async () => {
      const deps = makeDeps({ ttsAdapter: undefined });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["tts.synthesize"]!({ text: "Hello" }),
      ).rejects.toThrow("TTS not configured");
    });

    it("creates output directory via fs.mkdir", async () => {
      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);

      await handlers["tts.synthesize"]!({ text: "Hello" });

      const fsMock = await import("node:fs/promises");
      expect(fsMock.mkdir).toHaveBeenCalledWith(
        expect.stringContaining("media/tts"),
        { recursive: true },
      );
    });
  });

  // -------------------------------------------------------------------------
  // tts.auto_check
  // -------------------------------------------------------------------------

  describe("tts.auto_check", () => {
    it("returns shouldSynthesize: false when autoMode is off", async () => {
      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);

      const result = (await handlers["tts.auto_check"]!({
        response_text: "Some response",
      })) as { shouldSynthesize: boolean; mode: string };

      expect(result.shouldSynthesize).toBe(false);
      expect(result.mode).toBe("off");
    });

    it("passes correct params to shouldAutoTts", async () => {
      const { shouldAutoTts } = await import("@comis/skills");
      (shouldAutoTts as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        shouldSynthesize: true,
        strippedText: "stripped",
      });

      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);

      const result = (await handlers["tts.auto_check"]!({
        response_text: "Hello [[tts]]",
        has_inbound_audio: true,
        has_media_url: false,
      })) as { shouldSynthesize: boolean; strippedText: string };

      expect(shouldAutoTts).toHaveBeenCalledWith(
        { autoMode: "off", tagPattern: "\\[\\[tts\\]\\]" },
        { responseText: "Hello [[tts]]", hasInboundAudio: true, hasMediaUrl: false },
      );
      expect(result.shouldSynthesize).toBe(true);
      expect(result.strippedText).toBe("stripped");
    });
  });

  // -------------------------------------------------------------------------
  // link.process
  // -------------------------------------------------------------------------

  describe("link.process", () => {
    it("processes message text and returns enriched result", async () => {
      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);

      const result = (await handlers["link.process"]!({
        text: "Check this link: https://example.com",
      })) as { enrichedText: string; linksProcessed: number; errors: unknown[] };

      expect(result.enrichedText).toBe("enriched text with link summaries");
      expect(result.linksProcessed).toBe(1);
      expect(result.errors).toEqual([]);
      expect(
        (deps.linkRunner as unknown as { processMessage: ReturnType<typeof vi.fn> }).processMessage,
      ).toHaveBeenCalledWith("Check this link: https://example.com");
    });
  });

  // -------------------------------------------------------------------------
  // media.transcribe
  // -------------------------------------------------------------------------

  describe("media.transcribe", () => {
    it("resolves attachment and transcribes audio", async () => {
      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);

      const result = (await handlers["media.transcribe"]!({
        attachment_url: "tg-file://voice123",
      })) as { text: string; language: string; durationMs: number };

      expect(deps.resolveAttachment).toHaveBeenCalledWith("tg-file://voice123");
      expect(result.text).toBe("transcribed audio");
      expect(result.language).toBe("en");
      expect(result.durationMs).toBe(1500);
    });

    it("throws when transcriber is not configured", async () => {
      const deps = makeDeps({ transcriber: undefined });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.transcribe"]!({ attachment_url: "tg-file://abc" }),
      ).rejects.toThrow("Transcription service not configured");
    });

    it("throws when resolveAttachment is not available", async () => {
      const deps = makeDeps({ resolveAttachment: undefined });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.transcribe"]!({ attachment_url: "tg-file://abc" }),
      ).rejects.toThrow("Attachment resolution not available");
    });

    it("throws when attachment resolution returns null", async () => {
      const deps = makeDeps({
        resolveAttachment: vi.fn(async () => null),
      });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.transcribe"]!({ attachment_url: "tg-file://missing" }),
      ).rejects.toThrow("Failed to resolve attachment");
    });
  });

  // -------------------------------------------------------------------------
  // media.describe_video
  // -------------------------------------------------------------------------

  describe("media.describe_video", () => {
    it("resolves attachment and describes video", async () => {
      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);

      const result = (await handlers["media.describe_video"]!({
        attachment_url: "tg-file://video456",
        prompt: "What is happening?",
      })) as { description: string; provider: string; model: string };

      expect(deps.resolveAttachment).toHaveBeenCalledWith("tg-file://video456");
      expect(result.description).toBe("A short video clip");
      expect(result.provider).toBe("gemini");
    });

    it("throws when no vision registry is available", async () => {
      const deps = makeDeps({ visionRegistry: undefined });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.describe_video"]!({ attachment_url: "tg-file://vid" }),
      ).rejects.toThrow("No vision provider available");
    });

    it("throws when no video-capable provider exists", async () => {
      // Provider without describeVideo method
      const { selectVisionProvider } = await import("@comis/skills");
      (selectVisionProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        describeImage: vi.fn(),
        // No describeVideo
      });

      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.describe_video"]!({ attachment_url: "tg-file://vid" }),
      ).rejects.toThrow("No video-capable vision provider available");
    });

    it("throws when resolveAttachment is not available", async () => {
      const deps = makeDeps({ resolveAttachment: undefined });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.describe_video"]!({ attachment_url: "tg-file://vid" }),
      ).rejects.toThrow("Attachment resolution not available");
    });

    // ─── VIS-03 (187): raw video → gemini-video tier (main-vision N/A) ─────────

    it("VIS-03 routes raw video to the gemini-video tier (UNCHANGED); the main-vision bridge is NEVER called for video", async () => {
      visionState.capable = true; // even a vision-capable main does NOT serve video
      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);

      const result = (await handlers["media.describe_video"]!({
        attachment_url: "tg-file://video456",
        prompt: "what is happening",
        _agentId: "default",
      })) as { description: string; provider: string };

      expect(result.description).toBe("A short video clip");
      expect((deps.mainProviderVision as unknown as { describeImage: ReturnType<typeof vi.fn> }).describeImage)
        .not.toHaveBeenCalled();
      // VIS-03 path-log: a content-free line carries path:"gemini-video".
      const logged = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls
        .concat((deps.logger.debug as ReturnType<typeof vi.fn>).mock.calls)
        .map((c) => c[0]);
      expect(logged.some((f) => f && (f as { path?: string }).path === "gemini-video")).toBe(true);
    });

    it("VIS-03 honest-unavailable (errorKind, NOT an undefined-method call) when no video-capable provider exists", async () => {
      const { selectVisionProvider } = await import("@comis/skills");
      // A provider WITHOUT describeVideo → the registry is "available" but cannot
      // serve video. The handler must surface an honest error, not call undefined.
      (selectVisionProvider as ReturnType<typeof vi.fn>).mockReturnValue({ describeImage: vi.fn() });
      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.describe_video"]!({ attachment_url: "tg-file://vid", _agentId: "default" }),
      ).rejects.toThrow(/video-capable vision provider/i);
    });
  });

  // -------------------------------------------------------------------------
  // media.extract_document
  // -------------------------------------------------------------------------

  describe("media.extract_document", () => {
    it("resolves attachment and extracts document content", async () => {
      const deps = makeDeps();
      const handlers = createMediaHandlers(deps);

      const result = (await handlers["media.extract_document"]!({
        attachment_url: "tg-file://doc789",
      })) as {
        text: string;
        fileName: string;
        mimeType: string;
        extractedChars: number;
        truncated: boolean;
        durationMs: number;
      };

      expect(deps.resolveAttachment).toHaveBeenCalledWith("tg-file://doc789");
      expect(result.text).toBe("extracted document text");
      expect(result.fileName).toBe("doc.pdf");
      expect(result.mimeType).toBe("application/pdf");
      expect(result.extractedChars).toBe(100);
      expect(result.truncated).toBe(false);
      expect(result.durationMs).toBe(500);
    });

    it("throws when file extractor is not configured", async () => {
      const deps = makeDeps({ fileExtractor: undefined });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.extract_document"]!({ attachment_url: "tg-file://doc" }),
      ).rejects.toThrow("Document extraction service not configured");
    });

    it("throws when resolveAttachment is not available", async () => {
      const deps = makeDeps({ resolveAttachment: undefined });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.extract_document"]!({ attachment_url: "tg-file://doc" }),
      ).rejects.toThrow("Attachment resolution not available");
    });

    it("throws when attachment resolution returns null", async () => {
      const deps = makeDeps({
        resolveAttachment: vi.fn(async () => null),
      });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.extract_document"]!({ attachment_url: "tg-file://missing" }),
      ).rejects.toThrow("Failed to resolve attachment");
    });
  });
});
