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

// The image.analyze `url` branch routes through the shared
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

// The daemon-side vision gate copies the setup-channels-media.ts
// dance — `isVisionCapable(getModel(provider, modelId))`. Mock both so the gate
// is deterministic without a live pi-ai catalog. getModel returns a sentinel
// object; isVisionCapable reads `visionCapableNext` (per-test override). By
// DEFAULT the main is NOT vision-capable → the registry path.
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
    // ok WITH a resolved value (hostname/ip/url) so the url branch can pin
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

/** A mock main-provider vision bridge. By default it succeeds
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
    // The main-provider vision wiring. Defaults: main = anthropic
    // (vision-capable controlled by `visionState.capable`, default false → the
    // registry path), the bridge succeeds when reached.
    resolveAgentMainProvider: vi.fn((_agentId: string) => ({ providerId: "anthropic" })),
    mainModelIdFor: vi.fn((_agentId: string) => "claude-sonnet-4-5"),
    mainProviderVision: makeMockMainProviderVision() as never,
    mediaConfig: {
      imageAnalysis: { maxFileSizeMb: 10 },
      vision: {
        scopeRules: [],
        defaultScopeAction: "allow",
      },
      transcription: {},
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
    // Default posture: main NOT vision-capable → registry path.
    // Individual tests flip these.
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

    // ─── The `url` source MUST route through the DNS-pinned SSRF ──────────────
    // fetcher (shared with image-handlers), not a bare fetch that re-resolves
    // DNS. This closes the rebinding TOCTOU gap for image.analyze too.

    it("a url source is fetched with a DNS-pinned dispatcher (no rebind window)", async () => {
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

    it("a url source that fails SSRF validation throws before any fetch", async () => {
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

    // ─── The provider-following vision ladder ─────────────────────────────────
    // main-vision FIRST → registry SECOND → honest-unavailable. The handler is a
    // CONSUMER of resolveVisionPath + deps.mainProviderVision.

    describe("vision ladder: main-vision first, registry second, honest-unavailable last", () => {
      it("routes to main-vision FIRST when the main model is vision-capable + has creds", async () => {
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
        // Path-log: a content-free line carries path:"main-vision".
        const logged = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls
          .concat((deps.logger.debug as ReturnType<typeof vi.fn>).mock.calls)
          .map((c) => c[0]);
        expect(logged.some((f) => f && (f as { path?: string }).path === "main-vision")).toBe(true);
      });

      it("succeeds via main-vision with NO separate vision-registry key (the bridge owns the cred)", async () => {
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

      it("NON-REGRESSION: a non-vision main takes the registry path unchanged (no bridge call)", async () => {
        visionState.capable = false; // the registry-only posture
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

      it("explicit defaultProvider OVERRIDES main-first (explicit config wins → registry)", async () => {
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

      it("main-vision RUNTIME failure falls back to the registry (its own keys, never throw-out)", async () => {
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

      it("honest-unavailable (errorKind) when neither main-vision nor a registry provider resolves", async () => {
        // main not vision-capable AND empty registry → honest-unavailable.
        visionState.capable = false;
        const deps = makeDeps({ visionRegistry: new Map() });
        const handlers = createMediaHandlers(deps);

        await expect(
          handlers["image.analyze"]!({ source_type: "base64", source: "abc", _agentId: "default" }),
        ).rejects.toThrow(/vision provider available/i);
      });

      it("the gate is conservative when getModel throws (model resolution failure → registry)", async () => {
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

    // -----------------------------------------------------------------------
    // The trajectory direct-emits (media.vision.{requested,
    // completed,failed}) via the per-session recorder (the daemon RPC context
    // has NO eventBus bridge — the same pattern as image-handlers). Resolve the
    // recorder by `_callerSessionKey`; a null/absent recorder no-ops. Payloads
    // are CONTENT-FREE (provider/mainProvider/model/path/costUsd/errorKind only —
    // never the buffer/base64/prompt/response text).
    // -----------------------------------------------------------------------
    describe("trajectory direct-emit (content-free)", () => {
      function makeRecorderMock() {
        const records: Array<{ type: string; data: Record<string, unknown> }> = [];
        const recordEvent = vi.fn((type: string, data: Record<string, unknown>) => {
          records.push({ type, data });
        });
        const getRecorder = vi.fn((_sessionKey: string) => ({ recordEvent }));
        return { records, recordEvent, getRecorder, trajectoryRegistry: { getRecorder } as never };
      }

      it("a successful main-vision turn records media.vision.requested + media.vision.completed{path:'main-vision',costUsd,outcome:'ok'}", async () => {
        visionState.capable = true;
        const rec = makeRecorderMock();
        const deps = makeDeps({ trajectoryRegistry: rec.trajectoryRegistry });
        const handlers = createMediaHandlers(deps);

        await handlers["image.analyze"]!({
          source_type: "base64",
          source: "abc",
          prompt: "what is this",
          _agentId: "default",
          _callerSessionKey: "default:u1:telegram:c1",
        });

        expect(rec.getRecorder).toHaveBeenCalledWith("default:u1:telegram:c1");
        const types = rec.records.map((r) => r.type);
        expect(types).toContain("media.vision.requested");
        expect(types).toContain("media.vision.completed");
        const completed = rec.records.find((r) => r.type === "media.vision.completed")!.data;
        expect(completed.path).toBe("main-vision");
        expect(completed.outcome).toBe("ok");
        expect(completed.costUsd).toBe(0.002);
        expect(completed.mainProvider).toBe("anthropic");
        // CONTENT-FREE: no buffer/base64/prompt/answer text in ANY recorded payload.
        const blob = JSON.stringify(rec.records);
        expect(blob).not.toContain("what is this");
        expect(blob).not.toContain("A dog on a skateboard");
        expect(blob).not.toMatch(/abc/); // the base64 source
      });

      it("the registry tier records media.vision.completed with path:'registry' and NO costUsd (registry providers report no cost)", async () => {
        visionState.capable = false; // → registry path
        const rec = makeRecorderMock();
        const deps = makeDeps({ trajectoryRegistry: rec.trajectoryRegistry });
        const handlers = createMediaHandlers(deps);

        await handlers["image.analyze"]!({
          source_type: "base64",
          source: "abc",
          _agentId: "default",
          _callerSessionKey: "default:u1:telegram:c1",
        });

        const completed = rec.records.find((r) => r.type === "media.vision.completed");
        expect(completed).toBeDefined();
        expect(completed!.data.path).toBe("registry");
        expect("costUsd" in completed!.data).toBe(false);
      });

      it("an honest-unavailable turn records media.vision.failed{errorKind,path}", async () => {
        visionState.capable = false;
        const rec = makeRecorderMock();
        const deps = makeDeps({ visionRegistry: new Map(), trajectoryRegistry: rec.trajectoryRegistry });
        const handlers = createMediaHandlers(deps);

        await expect(
          handlers["image.analyze"]!({
            source_type: "base64",
            source: "abc",
            _agentId: "default",
            _callerSessionKey: "default:u1:telegram:c1",
          }),
        ).rejects.toThrow(/vision provider available/i);

        const failed = rec.records.find((r) => r.type === "media.vision.failed");
        expect(failed).toBeDefined();
        expect(typeof failed!.data.errorKind).toBe("string");
        expect(failed!.data.path).toBe("unavailable");
      });

      it("when main-vision fails AND no registry can serve, the TERMINAL unavailable record carries the bridge's specific errorKind (not generic unsupported_provider)", async () => {
        // main-vision is the chosen path (sel.ok === true) and the bridge fails
        // with a SPECIFIC kind (auth_required — the main provider's key is
        // missing). With no registry provider, control reaches the honest-
        // unavailable terminal. The terminal record (path:"unavailable") and the
        // thrown error MUST preserve auth_required, not collapse to the generic
        // unsupported_provider (the `sel.ok === false ? …` ternary is always
        // false on the main-vision path).
        visionState.capable = true;
        const failingBridge = {
          describeImage: vi.fn(async () => ({
            ok: false as const,
            error: Object.assign(new Error("no key"), { errorKind: "auth_required" }),
          })),
        };
        const rec = makeRecorderMock();
        const deps = makeDeps({
          mainProviderVision: failingBridge as never,
          visionRegistry: new Map(), // no registry fallback
          trajectoryRegistry: rec.trajectoryRegistry,
        });
        const handlers = createMediaHandlers(deps);

        await expect(
          handlers["image.analyze"]!({
            source_type: "base64",
            source: "abc",
            _agentId: "default",
            _callerSessionKey: "default:u1:telegram:c1",
          }),
        ).rejects.toThrow(/vision provider available/i);

        const failedRecords = rec.records.filter((r) => r.type === "media.vision.failed");
        // Two failed records: the main-vision attempt + the terminal unavailable.
        const terminal = failedRecords.find((r) => r.data.path === "unavailable");
        expect(terminal).toBeDefined();
        // The terminal preserves the bridge's specific kind.
        expect(terminal!.data.errorKind).toBe("auth_required");
        // The §2.7 WARN for the terminal also carries the specific domain kind.
        const warnTerminal = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .find((f) => f && f.path === "unavailable");
        expect(warnTerminal).toBeDefined();
        expect(warnTerminal!.imageErrorKind).toBe("auth_required");
      });

      it("the resolver-skip path (sel.ok === false) still uses the resolver's own errorKind at the terminal", async () => {
        // Regression guard: when the resolver itself returns !ok (e.g. a
        // mediaKind/capability combination it refuses), the terminal must keep
        // honoring sel.errorKind — the bridge kind is preserved ONLY when there
        // was a bridge failure, never overriding a real resolver kind.
        visionState.capable = false; // not vision-capable → registry path, no bridge attempt
        const rec = makeRecorderMock();
        const deps = makeDeps({ visionRegistry: new Map(), trajectoryRegistry: rec.trajectoryRegistry });
        const handlers = createMediaHandlers(deps);

        await expect(
          handlers["image.analyze"]!({
            source_type: "base64",
            source: "abc",
            _agentId: "default",
            _callerSessionKey: "default:u1:telegram:c1",
          }),
        ).rejects.toThrow(/vision provider available/i);

        const terminal = rec.records.find(
          (r) => r.type === "media.vision.failed" && r.data.path === "unavailable",
        );
        expect(terminal).toBeDefined();
        // No bridge ran → the terminal kind is the resolver/handler default,
        // NOT a stale lastBridgeKind.
        expect(typeof terminal!.data.errorKind).toBe("string");
        expect(terminal!.data.errorKind).not.toBe("auth_required");
      });

      it("a registry-tier provider failure emits media.vision.failed{path:'registry'} + a §2.7 WARN before throwing", async () => {
        // §2.7: errorKind+hint on EVERY vision failure branch + the path label.
        // The registry provider returns !ok → the handler must record
        // media.vision.failed{path:"registry"} AND fire a content-free WARN
        // (path:"registry") carrying the classified errorKind BEFORE re-throwing.
        visionState.capable = false; // → registry path
        const failingProvider = {
          describeImage: vi.fn(async () => ({
            ok: false as const,
            error: Object.assign(new Error("registry boom"), { errorKind: "quota_exceeded" }),
          })),
          describeVideo: vi.fn(),
        };
        const rec = makeRecorderMock();
        const deps = makeDeps({
          visionRegistry: new Map([["gemini", failingProvider as never]]),
          trajectoryRegistry: rec.trajectoryRegistry,
        });
        const handlers = createMediaHandlers(deps);

        await expect(
          handlers["image.analyze"]!({
            source_type: "base64",
            source: "abc",
            prompt: "p",
            _agentId: "default",
            _callerSessionKey: "default:u1:telegram:c1",
          }),
        ).rejects.toThrow();

        const failed = rec.records.find(
          (r) => r.type === "media.vision.failed" && r.data.path === "registry",
        );
        expect(failed).toBeDefined();
        expect(failed!.data.errorKind).toBe("quota_exceeded");
        const warn = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .find((f) => f && f.path === "registry");
        expect(warn).toBeDefined();
        expect(warn!.imageErrorKind).toBe("quota_exceeded");
        expect(warn!.hint).toBeTruthy();
        // CONTENT-FREE: neither the prompt nor the base64 source in the records.
        const blob = JSON.stringify(rec.records);
        expect(blob).not.toContain("\"p\"");
        expect(blob).not.toContain("abc");
      });

      it("a main-vision RUNTIME failure records media.vision.failed for the bridge attempt, then media.vision.completed for the registry fallback", async () => {
        visionState.capable = true;
        const failingBridge = {
          describeImage: vi.fn(async () => ({
            ok: false as const,
            error: Object.assign(new Error("empty"), { errorKind: "empty_response" }),
          })),
        };
        const rec = makeRecorderMock();
        const deps = makeDeps({ mainProviderVision: failingBridge as never, trajectoryRegistry: rec.trajectoryRegistry });
        const handlers = createMediaHandlers(deps);

        await handlers["image.analyze"]!({
          source_type: "base64",
          source: "abc",
          _agentId: "default",
          _callerSessionKey: "default:u1:telegram:c1",
        });

        const types = rec.records.map((r) => r.type);
        // The bridge attempt failed (media.vision.failed, path main-vision)…
        expect(types).toContain("media.vision.failed");
        const failed = rec.records.find((r) => r.type === "media.vision.failed")!.data;
        expect(failed.path).toBe("main-vision");
        // …and the registry fallback then completed (path registry).
        const completed = rec.records.find((r) => r.type === "media.vision.completed")!.data;
        expect(completed.path).toBe("registry");
      });

      it("an absent recorder / absent _callerSessionKey no-ops (no crash)", async () => {
        visionState.capable = true;
        // No trajectoryRegistry wired AND no _callerSessionKey — the emits must be a no-op.
        const deps = makeDeps();
        const handlers = createMediaHandlers(deps);

        const result = (await handlers["image.analyze"]!({
          source_type: "base64",
          source: "abc",
          _agentId: "default",
        })) as { description: string };

        expect(result.description).toBe("A dog on a skateboard");
      });

      it("the §2.7 INFO completion line carries {visionProvider, mainProvider, model, path, durationMs, costUsd}", async () => {
        visionState.capable = true;
        const rec = makeRecorderMock();
        const deps = makeDeps({ trajectoryRegistry: rec.trajectoryRegistry });
        const handlers = createMediaHandlers(deps);

        await handlers["image.analyze"]!({
          source_type: "base64",
          source: "abc",
          prompt: "p",
          _agentId: "default",
          _callerSessionKey: "default:u1:telegram:c1",
        });

        const infoCalls = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
        const completeLine = infoCalls.find(
          (f) => f && (f as { step?: string }).step === "vision_complete" && (f as { path?: string }).path === "main-vision",
        ) as Record<string, unknown> | undefined;
        expect(completeLine).toBeDefined();
        expect(completeLine!.visionProvider).toBe("anthropic");
        expect(completeLine!.mainProvider).toBe("anthropic");
        expect(completeLine!.model).toBe("claude-sonnet-4-5");
        expect(completeLine!.costUsd).toBe(0.002);
        expect(typeof completeLine!.durationMs).toBe("number");
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

    it("media.transcribe on an unconfigured provider rejects with a structured Error the dispatch boundary converts, never an unhandled crash", async () => {
      // Regression PIN: when the keyless-first
      // resolution leaves the transcriber undefined (a Codex/OAuth-only main with
      // no audio key, or STT `auto` before the local engine lands), the on-demand
      // RPC handler `throw`s a typed Error. That throw is NOT an unhandled crash —
      // the JSON-RPC dispatch boundary (method-router.ts:2 / rpc-dispatch.ts:306-321)
      // catches it and converts it to a structured `{error:{code,message}}` response,
      // so the agent's text reply is never blocked. This test would FAIL if a future
      // change made the handler reject with a non-Error (a raw string / undefined)
      // that the json-rpc-2.0 library cannot envelope, or crash the dispatch.
      const deps = makeDeps({ transcriber: undefined });
      const handlers = createMediaHandlers(deps);

      // The handler returns a rejected Promise (awaited at the dispatch boundary),
      // never a synchronous throw that would escape the dispatch try/catch.
      const pending = handlers["media.transcribe"]!({ attachment_url: "tg-file://abc" });
      expect(pending).toBeInstanceOf(Promise);
      // The rejection is a real Error instance carrying an actionable message —
      // exactly what the dispatch boundary serializes into the JSON-RPC error
      // envelope (a bare string / undefined would break that conversion).
      await expect(pending).rejects.toBeInstanceOf(Error);
      await expect(pending).rejects.toThrow(/not configured/i);
    });

    it("tts.synthesize on an unconfigured adapter rejects with a structured Error, never an unhandled crash", async () => {
      // The TTS twin of the transcribe pin above: an honest-unavailable TTS resolution leaves
      // ttsAdapter undefined; the on-demand handler throw is converted to a
      // structured JSON-RPC error at the dispatch boundary, not a daemon crash.
      const deps = makeDeps({ ttsAdapter: undefined });
      const handlers = createMediaHandlers(deps);

      const pending = handlers["tts.synthesize"]!({ text: "Hello" });
      expect(pending).toBeInstanceOf(Promise);
      await expect(pending).rejects.toBeInstanceOf(Error);
      await expect(pending).rejects.toThrow(/not configured/i);
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
  // Voice obs wiring (media.transcribe / tts.synthesize /
  // media.test.stt) — record + §2.7 log via wireVoiceObs, the STT-vs-TTS
  // provider-reporting pin, the source rung + onSkip on the requested record,
  // and the credential no-leak guarantee.
  // -------------------------------------------------------------------------

  describe("voice observability wiring (records + completion logs)", () => {
    function makeRecorderMock() {
      const records: Array<{ type: string; data: Record<string, unknown> }> = [];
      const recordEvent = vi.fn((type: string, data: Record<string, unknown>) => {
        records.push({ type, data });
      });
      const getRecorder = vi.fn((_sessionKey: string) => ({ recordEvent }));
      return { records, recordEvent, getRecorder, trajectoryRegistry: { getRecorder } as never };
    }

    /** Deps with the STT config slice + a resolved keyless-local STT selection
     *  (the boot-resolved `source`/`keyless`/`onSkip` the daemon threads). */
    function voiceDeps(overrides?: Partial<MediaHandlerDeps>): MediaHandlerDeps {
      return makeDeps({
        mediaConfig: {
          imageAnalysis: { maxFileSizeMb: 10 },
          vision: { scopeRules: [], defaultScopeAction: "allow" },
          transcription: { provider: "local" },
          tts: { provider: "edge", autoMode: "off" as const, tagPattern: "\\[\\[tts\\]\\]" },
        },
        voiceSelection: {
          stt: { provider: "local", keyless: true, source: "keyless-local", onSkip: ['main "openai-codex" has no usable audio key'] },
          tts: { provider: "edge", keyless: true, source: "keyless-local" },
        },
        ...overrides,
      });
    }

    // ---- media.test.stt reads the STT provider, not the TTS provider ----
    it("media.test.stt reports the TRANSCRIPTION provider, not the TTS provider", async () => {
      // Config: transcription.provider = "local", tts.provider = "edge". The handler
      // must report the STT provider "local" — a regression would return "edge"
      // by reading deps.mediaConfig.tts.provider instead.
      const deps = voiceDeps();
      const handlers = createMediaHandlers(deps);

      const result = (await handlers["media.test.stt"]!({
        audio: Buffer.from("audio").toString("base64"),
        mimeType: "audio/ogg",
      })) as { provider: string };

      expect(result.provider).toBe("local");
    });

    // ---- media.transcribe records media.stt.completed + §2.7 INFO ----
    it("media.transcribe records media.stt.completed (provider/keyless/source) AND logs a §2.7 completion INFO", async () => {
      const rec = makeRecorderMock();
      const deps = voiceDeps({ trajectoryRegistry: rec.trajectoryRegistry });
      const handlers = createMediaHandlers(deps);

      await handlers["media.transcribe"]!({
        attachment_url: "tg-file://voice123",
        _agentId: "default",
        _callerSessionKey: "default:u1:telegram:c1",
      });

      // (a) the obs record fired via the helper.
      const completed = rec.records.find((r) => r.type === "media.stt.completed");
      expect(completed).toBeDefined();
      expect(completed!.data.provider).toBe("local");
      expect(completed!.data.keyless).toBe(true);
      expect(completed!.data.source).toBe("keyless-local");
      expect(completed!.data.outcome).toBe("ok");
      // (b) the §2.7 completion INFO carries provider/keyless/durationMs/audioBytes.
      const infoCall = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => typeof c[1] === "string" && /transcription completed/i.test(c[1] as string),
      );
      expect(infoCall).toBeDefined();
      expect((infoCall![0] as Record<string, unknown>).provider).toBe("local");
      expect((infoCall![0] as Record<string, unknown>).keyless).toBe(true);
      expect((infoCall![0] as Record<string, unknown>).durationMs).toBe(1500);
      expect((infoCall![0] as Record<string, unknown>).audioBytes).toBe(Buffer.from("image-data").byteLength);
    });

    // ---- media.transcribe failure → media.stt.failed + §2.7 WARN ----
    it("media.transcribe failure records media.stt.failed{errorKind} AND logs a §2.7 WARN with err/hint/errorKind/sttErrorKind", async () => {
      const rec = makeRecorderMock();
      const deps = voiceDeps({
        trajectoryRegistry: rec.trajectoryRegistry,
        transcriber: {
          transcribe: vi.fn(async () => ({
            ok: false as const,
            error: Object.assign(new Error("provider failed"), { errorKind: "network" }),
          })),
        } as never,
      });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.transcribe"]!({
          attachment_url: "tg-file://voice123",
          _agentId: "default",
          _callerSessionKey: "default:u1:telegram:c1",
        }),
      ).rejects.toThrow();

      const failed = rec.records.find((r) => r.type === "media.stt.failed");
      expect(failed).toBeDefined();
      expect(failed!.data.errorKind).toBe("network");
      expect(failed!.data.outcome).toBe("failed");

      const warnCall = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => typeof c[1] === "string" && /transcription failed/i.test(c[1] as string),
      );
      expect(warnCall).toBeDefined();
      const fields = warnCall![0] as Record<string, unknown>;
      expect(fields.err).toBeDefined();
      expect(fields.hint).toBeDefined();
      // STT_ERR_TO_LOG["network"] = "network" (the closed log union); sttErrorKind = the domain.
      expect(fields.errorKind).toBe("network");
      expect(fields.sttErrorKind).toBe("network");
    });

    // ---- the source rung + onSkip reach the live emit (requested) ----
    it("media.transcribe threads the resolved source rung AND onSkip reasons onto the recorded media.stt.requested", async () => {
      const rec = makeRecorderMock();
      const deps = voiceDeps({ trajectoryRegistry: rec.trajectoryRegistry });
      const handlers = createMediaHandlers(deps);

      await handlers["media.transcribe"]!({
        attachment_url: "tg-file://voice123",
        _agentId: "default",
        _callerSessionKey: "default:u1:telegram:c1",
      });

      const requested = rec.records.find((r) => r.type === "media.stt.requested");
      expect(requested).toBeDefined();
      // The selection observability lands on the live handler path.
      expect(requested!.data.source).toBe("keyless-local");
      expect(requested!.data.onSkip).toEqual(['main "openai-codex" has no usable audio key']);
    });

    // ---- tts.synthesize records media.tts.completed + §2.7 INFO ----
    it("tts.synthesize records media.tts.completed AND logs a §2.7 synthesis completion INFO", async () => {
      const rec = makeRecorderMock();
      const deps = voiceDeps({ trajectoryRegistry: rec.trajectoryRegistry });
      const handlers = createMediaHandlers(deps);

      await handlers["tts.synthesize"]!({
        text: "Hello world",
        _agentId: "default",
        _callerSessionKey: "default:u1:telegram:c1",
      });

      const completed = rec.records.find((r) => r.type === "media.tts.completed");
      expect(completed).toBeDefined();
      expect(completed!.data.provider).toBe("edge");
      expect(completed!.data.keyless).toBe(true);
      expect(completed!.data.outcome).toBe("ok");

      const infoCall = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => typeof c[1] === "string" && /speech synthesis completed/i.test(c[1] as string),
      );
      expect(infoCall).toBeDefined();
      expect((infoCall![0] as Record<string, unknown>).provider).toBe("edge");
    });

    // ---- no credential leaks into any emitted line ----
    it("a transcribe failure whose error carries a credential-bearing baseUrl leaks no Bearer/sentinel/full-URL in any line", async () => {
      const rec = makeRecorderMock();
      const leakyError = Object.assign(
        new Error("POST https://api.openai.com/v1/audio/transcriptions failed: Authorization: Bearer sk-proj-SECRETTOKEN1234567890 (ollama-no-auth)"),
        { errorKind: "network" },
      );
      const deps = voiceDeps({
        trajectoryRegistry: rec.trajectoryRegistry,
        transcriber: { transcribe: vi.fn(async () => ({ ok: false as const, error: leakyError })) } as never,
      });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.transcribe"]!({
          attachment_url: "tg-file://voice123",
          _agentId: "default",
          _callerSessionKey: "default:u1:telegram:c1",
        }),
      ).rejects.toThrow();

      // Scan every emitted log line + every recorded trajectory payload.
      const allLogged = JSON.stringify([
        ...(deps.logger.info as ReturnType<typeof vi.fn>).mock.calls,
        ...(deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls,
        ...(deps.logger.error as ReturnType<typeof vi.fn>).mock.calls,
        ...rec.records,
      ]);
      expect(allLogged).not.toContain("sk-proj-SECRETTOKEN1234567890");
      expect(allLogged).not.toContain("Bearer sk-");
      expect(allLogged).not.toContain("ollama-no-auth");
      expect(allLogged).not.toContain("/v1/audio/transcriptions");
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

    // ─── raw video → gemini-video tier (main-vision N/A) ──────────────────────

    it("routes raw video to the gemini-video tier; the main-vision bridge is NEVER called for video", async () => {
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
      // Path-log: a content-free line carries path:"gemini-video".
      const logged = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls
        .concat((deps.logger.debug as ReturnType<typeof vi.fn>).mock.calls)
        .map((c) => c[0]);
      expect(logged.some((f) => f && (f as { path?: string }).path === "gemini-video")).toBe(true);
    });

    it("honest-unavailable (errorKind, NOT an undefined-method call) when no video-capable provider exists", async () => {
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

    it("a gemini-video provider failure emits media.vision.failed{path:'gemini-video'} + a §2.7 WARN before throwing", async () => {
      // §2.7: errorKind+hint on EVERY vision failure branch + the path label.
      // describeVideo returns !ok → the handler must record
      // media.vision.failed{path:"gemini-video"} AND fire a content-free WARN
      // (path:"gemini-video") with the classified errorKind BEFORE re-throwing.
      const { selectVisionProvider } = await import("@comis/skills");
      const failingVideoProvider = {
        describeImage: vi.fn(),
        describeVideo: vi.fn(async () => ({
          ok: false as const,
          error: Object.assign(new Error("video boom"), { errorKind: "timeout" }),
        })),
      };
      (selectVisionProvider as ReturnType<typeof vi.fn>).mockReturnValue(failingVideoProvider);
      const records: Array<{ type: string; data: Record<string, unknown> }> = [];
      const recordEvent = vi.fn((type: string, data: Record<string, unknown>) => {
        records.push({ type, data });
      });
      const trajectoryRegistry = { getRecorder: vi.fn(() => ({ recordEvent })) } as never;
      const deps = makeDeps({ trajectoryRegistry });
      const handlers = createMediaHandlers(deps);

      await expect(
        handlers["media.describe_video"]!({
          attachment_url: "tg-file://vid",
          prompt: "secret-video-prompt",
          _agentId: "default",
          _callerSessionKey: "default:u1:telegram:c1",
        }),
      ).rejects.toThrow();

      const failed = records.find(
        (r) => r.type === "media.vision.failed" && r.data.path === "gemini-video",
      );
      expect(failed).toBeDefined();
      expect(failed!.data.errorKind).toBe("timeout");
      const warn = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((f) => f && f.path === "gemini-video");
      expect(warn).toBeDefined();
      expect(warn!.imageErrorKind).toBe("timeout");
      expect(warn!.hint).toBeTruthy();
      // CONTENT-FREE: the prompt never enters the records.
      expect(JSON.stringify(records)).not.toContain("secret-video-prompt");
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
