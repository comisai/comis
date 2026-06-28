// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { AppConfigSchema } from "@comis/core";
import {
  resolveModelHealthMultilingual,
  buildImageHandlerDeps,
  buildMediaVisionBundle,
  resolveVisionApiKey,
} from "./main-helpers.js";
import type { BootContext } from "../daemon-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// EMB-01 — resolveModelHealthMultilingual: the provider-aware boot-snapshot
// helper extracted from daemon.ts (keeps the composition root under its line cap).
//
// Resolves the two advisory multilingual booleans for the model_health row. The
// embedder id is PROVIDER-AWARE (Pitfall 3 — never the legacy memory field); the
// reranker default bge-reranker-v2-m3 must classify multilingual (Pitfall 2).
// Advisory only — nothing here gates recall (I4).
// ---------------------------------------------------------------------------

type Config = BootContext["container"]["config"];

/** A fully-defaulted config, then the embedding/memory blocks overridden. */
function configWith(overrides: {
  embedding?: Record<string, unknown>;
  memory?: Record<string, unknown>;
}): Config {
  const base = AppConfigSchema.parse({}) as unknown as Config;
  return {
    ...base,
    embedding: { ...base.embedding, ...overrides.embedding } as Config["embedding"],
    memory: { ...base.memory, ...overrides.memory } as Config["memory"],
  };
}

describe("resolveModelHealthMultilingual (EMB-01 provider-aware boot helper)", () => {
  it("classifies the DEFAULT install: nomic embedder -> \"unknown\", bge-reranker-v2-m3 reranker -> true (Pitfall 2)", () => {
    const result = resolveModelHealthMultilingual(AppConfigSchema.parse({}) as unknown as Config);
    expect(result.embeddingMultilingual).toBe("unknown"); // nomic-embed-text-v1.5, no hit
    expect(result.rerankerMultilingual).toBe(true); // the shipped multilingual reranker default
  });

  it("resolves the LOCAL embedder id from embedding.local.modelUri (provider auto/local — Pitfall 3)", () => {
    const result = resolveModelHealthMultilingual(
      configWith({ embedding: { provider: "local", local: { modelUri: "hf:org/bge-m3-GGUF:bge-m3.Q8_0.gguf" } } }),
    );
    expect(result.embeddingMultilingual).toBe(true); // bge-m3 hits the embedder regex
  });

  it("resolves the OPENAI embedder id from embedding.openai.model when provider === openai (Pitfall 3)", () => {
    const result = resolveModelHealthMultilingual(
      configWith({ embedding: { provider: "openai", openai: { model: "multilingual-e5-large" } } }),
    );
    expect(result.embeddingMultilingual).toBe(true); // reads openai.model, not local.modelUri
  });

  it("honors an explicit embedding.multilingual override (declared wins over the English-leaning default id)", () => {
    const result = resolveModelHealthMultilingual(configWith({ embedding: { multilingual: true } }));
    expect(result.embeddingMultilingual).toBe(true); // declared true over the nomic default
  });

  it("returns rerankerMultilingual \"unknown\" for a non-multilingual reranker id (no per-reranker config flag)", () => {
    // Phase 226: the reranker model lives under memory.recall — override the whole recall block.
    const base = AppConfigSchema.parse({}) as unknown as Config;
    const result = resolveModelHealthMultilingual(
      configWith({ memory: { recall: { ...base.memory.recall, rerankerModel: "hf:org/some-english-reranker.gguf" } } }),
    );
    expect(result.rerankerMultilingual).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// WR-04 (186) — buildImageHandlerDeps: the imageHandlerDeps slice extracted from
// daemon.ts (relieves the composition-root line cap). Characterization test for
// the disabled-image gate + the 1:1 field mapping (behavior-neutral extraction).
// ---------------------------------------------------------------------------

/** A minimal post-channels boot slice for buildImageHandlerDeps. The image-gen
 *  pair is overridable to drive the disabled gate; the rest are stub instances
 *  the helper only forwards (it never calls into them). */
function imageBootSlice(
  overrides: Partial<Parameters<typeof buildImageHandlerDeps>[0]> = {},
): Parameters<typeof buildImageHandlerDeps>[0] {
  const provider = { id: "openai", isAvailable: () => true, execute: vi.fn() };
  const adapter = { sendAttachment: vi.fn() };
  const slice = {
    imageGenProvider: provider,
    imageGenRateLimiter: { tryAcquire: vi.fn(), reset: vi.fn() },
    imageGenConfig: { provider: "openai", maxPerHour: 10, defaultSize: "1024x1024", safetyChecker: true },
    skillsLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    adaptersByType: new Map([["telegram", adapter]]),
    workspaceDirs: new Map([["a1", "/ws/a1"]]),
    defaultWorkspaceDir: "/ws/default",
    persistImage: vi.fn(),
    trajectoryRegistry: { getRecorder: vi.fn() },
    container: { eventBus: { emit: vi.fn() } },
    imageGenCostLimiter: { canSpend: vi.fn(), record: vi.fn(), reset: vi.fn() },
    ...overrides,
  };
  return slice as unknown as Parameters<typeof buildImageHandlerDeps>[0];
}

describe("buildImageHandlerDeps (WR-04 extracted imageHandlerDeps slice)", () => {
  const resolver = (agentId: string): { providerId: string } => ({ providerId: `main-${agentId}` });

  it("returns undefined when the image provider is absent (disabled-image gate)", () => {
    const deps = buildImageHandlerDeps(imageBootSlice({ imageGenProvider: undefined }), resolver);
    expect(deps).toBeUndefined();
  });

  it("returns undefined when the rate limiter is absent (disabled-image gate)", () => {
    const deps = buildImageHandlerDeps(imageBootSlice({ imageGenRateLimiter: undefined }), resolver);
    expect(deps).toBeUndefined();
  });

  it("maps every boot field onto the handler deps 1:1 when image generation is enabled", () => {
    const slice = imageBootSlice();
    const deps = buildImageHandlerDeps(slice, resolver);
    expect(deps).toBeDefined();
    expect(deps!.provider).toBe(slice.imageGenProvider);
    expect(deps!.rateLimiter).toBe(slice.imageGenRateLimiter);
    expect(deps!.config).toBe(slice.imageGenConfig);
    expect(deps!.persist).toBe(slice.persistImage);
    expect(deps!.trajectoryRegistry).toBe(slice.trajectoryRegistry);
    expect(deps!.costLimiter).toBe(slice.imageGenCostLimiter);
    expect(deps!.eventBus).toBe(slice.container.eventBus);
    expect(deps!.workspaceDirs).toBe(slice.workspaceDirs);
    expect(deps!.defaultWorkspaceDir).toBe("/ws/default");
    // RES-01: the resolver is forwarded; getChannelAdapter resolves by type.
    expect(deps!.resolveAgentMainProvider).toBe(resolver);
    expect(deps!.getChannelAdapter("telegram")).toBe(slice.adaptersByType.get("telegram"));
    expect(deps!.getChannelAdapter("irc")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VIS-01 (187-02) — resolveVisionApiKey: the cred-by-PROVIDER switch the vision
// bridge uses (mirrors resolveImageApiKey at pi-image-adapter.ts:279, but keyed
// by PROVIDER, since vision keys are OPENAI/ANTHROPIC/GOOGLE_API_KEY). Reads the
// SAME SecretManager the main completion path uses — never the raw environment.
// ---------------------------------------------------------------------------

describe("resolveVisionApiKey (VIS-01 cred-by-provider switch)", () => {
  const sm = (entries: Record<string, string>): { get(k: string): string | undefined } => ({
    get: (k: string) => entries[k],
  });

  it("maps openai -> OPENAI_API_KEY", () => {
    expect(resolveVisionApiKey("openai", sm({ OPENAI_API_KEY: "sk-o" }))).toBe("sk-o");
  });

  it("maps anthropic -> ANTHROPIC_API_KEY", () => {
    expect(resolveVisionApiKey("anthropic", sm({ ANTHROPIC_API_KEY: "sk-a" }))).toBe("sk-a");
  });

  it("maps google + google-vertex -> GOOGLE_API_KEY", () => {
    expect(resolveVisionApiKey("google", sm({ GOOGLE_API_KEY: "g" }))).toBe("g");
    expect(resolveVisionApiKey("google-vertex", sm({ GOOGLE_API_KEY: "g" }))).toBe("g");
  });

  it("returns undefined for an unknown / key-less provider (honest-unavailable upstream)", () => {
    expect(resolveVisionApiKey("openai-codex", sm({ OPENAI_API_KEY: "sk-o" }))).toBeUndefined();
    expect(resolveVisionApiKey("ollama", sm({}))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VIS-01 (187-02) — buildMediaVisionBundle: the wiring helper that closes over
// the SecretManager + the default agent's OAuth manager + resolveAgentModel and
// builds the mainProviderVision capability via createMainProviderVision (Plan 01).
// ---------------------------------------------------------------------------

/** A minimal boot container for buildMediaVisionBundle. The agents/models config
 *  drives the I4 resolveModel lockstep; the secretManager backs resolveApiKey. */
function visionBundleDeps(
  overrides: Partial<Parameters<typeof buildMediaVisionBundle>[0]> = {},
): Parameters<typeof buildMediaVisionBundle>[0] {
  const container = {
    config: {
      agents: {
        default: { provider: "anthropic", model: "claude-sonnet-4-5" },
        gpt: { provider: "openai", model: "gpt-4o" },
        codexer: { provider: "openai-codex", model: "gpt-5-codex" },
      },
      models: { defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" },
    },
    secretManager: { get: (k: string) => ({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" } as Record<string, string>)[k] },
  };
  const slice = {
    container,
    defaultAgentId: "default",
    skillsLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clock: { now: () => 1_700_000_000_000 },
    oauthManager: undefined,
    ...overrides,
  };
  return slice as unknown as Parameters<typeof buildMediaVisionBundle>[0];
}

describe("buildMediaVisionBundle (VIS-01 wiring helper)", () => {
  it("returns a capability with a callable describeImage (so the bridge is reachable)", () => {
    const { capability } = buildMediaVisionBundle(visionBundleDeps());
    expect(typeof capability.describeImage).toBe("function");
  });

  it("resolves the agent's main {provider, modelId} via resolveAgentModel (I4 lockstep) and its provider key", async () => {
    // The describeImage call exercises resolveModel (anthropic/claude) + resolveApiKey
    // (ANTHROPIC_API_KEY present) → it gets PAST the cred gate to the getModel step.
    // We assert it does NOT short-circuit on auth_required (the cred WAS resolved).
    const { capability } = buildMediaVisionBundle(visionBundleDeps());
    const r = await capability.describeImage(Buffer.from("img"), "what is this", "image/png", "default");
    // The real getModel/completeSimple may fail (no live provider in unit), but the
    // failure must NOT be auth_required — the ANTHROPIC_API_KEY resolved for "anthropic".
    if (!r.ok) {
      expect((r.error as { errorKind: string }).errorKind).not.toBe("auth_required");
    } else {
      expect(r.value).toBeDefined();
    }
  });

  it("honest-unavailable (auth_required) for a main provider whose key is absent", async () => {
    // The "gpt" agent → openai; OPENAI_API_KEY IS present in the mock → resolves.
    // Override to drop the openai key so the cred gate trips.
    const deps = visionBundleDeps({
      container: {
        config: {
          agents: { default: { provider: "openai", model: "gpt-4o" } },
          models: { defaultProvider: "openai", defaultModel: "gpt-4o" },
        },
        secretManager: { get: () => undefined },
      } as never,
    });
    const { capability } = buildMediaVisionBundle(deps);
    const r = await capability.describeImage(Buffer.from("img"), "p", "image/png", "default");
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.error as { errorKind: string }).errorKind).toBe("auth_required");
  });

  it("routes the openai-codex provider through the injected oauthManager.getApiKey", async () => {
    const getApiKey = vi.fn(async () => ({ ok: true as const, value: "codex-bearer" }));
    const deps = visionBundleDeps({
      container: {
        config: {
          agents: { default: { provider: "openai-codex", model: "gpt-5-codex" } },
          models: { defaultProvider: "openai-codex", defaultModel: "gpt-5-codex" },
        },
        secretManager: { get: () => undefined }, // no by-provider key → codex path only
      } as never,
      oauthManager: { getApiKey } as never,
    });
    const { capability } = buildMediaVisionBundle(deps);
    const r = await capability.describeImage(Buffer.from("img"), "p", "image/png", "default");
    // The codex OAuth manager was consulted (the cred path resolved a bearer →
    // NOT auth_required; the downstream getModel may still fail in unit).
    expect(getApiKey).toHaveBeenCalledWith("openai-codex", expect.anything());
    if (!r.ok) expect((r.error as { errorKind: string }).errorKind).not.toBe("auth_required");
  });
});

// ---------------------------------------------------------------------------
// VIS-01 (187-02) — built-but-not-wired SOURCE GUARD (mirror the 184 source
// guard). The resolver + bridge are useless unless daemon.ts CONSTRUCTS
// buildMediaVisionBundle and FOLDS `mainProviderVision` onto the MediaApiDeps
// literal. Assert the live daemon.ts wiring at the source level so a future
// refactor that drops the fold fails this test (not silently disables VIS-01).
// ---------------------------------------------------------------------------

describe("daemon.ts wires buildMediaVisionBundle into MediaApiDeps (built-but-not-wired guard)", () => {
  const daemonSrc = readFileSync(resolvePath(__dirname, "../daemon.ts"), "utf-8");

  it("constructs the vision bundle via buildMediaVisionBundle", () => {
    expect(daemonSrc).toMatch(/buildMediaVisionBundle\s*\(/);
  });

  it("folds mainProviderVision onto the deps literal (the bridge is reachable from the live handler)", () => {
    expect(daemonSrc).toMatch(/mainProviderVision\s*:/);
  });

  it("folds the resolveAgentMainProvider accessor onto the deps literal (the resolver input)", () => {
    // The MediaApiDeps top-level accessor (distinct from the imageHandlerDeps one).
    expect(daemonSrc).toMatch(/resolveAgentMainProvider\s*:\s*resolveAgentMainProviderFor/);
  });

  it("threads the mainModelIdFor accessor (the daemon-side vision gate's single source of truth)", () => {
    expect(daemonSrc).toMatch(/mainModelIdFor\s*:/);
  });
});
