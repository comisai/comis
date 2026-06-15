// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { AppConfigSchema } from "@comis/core";
import { resolveModelHealthMultilingual, buildImageHandlerDeps } from "./main-helpers.js";
import type { BootContext } from "../daemon-types.js";

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
    const result = resolveModelHealthMultilingual(
      configWith({ memory: { rerankerModel: "hf:org/some-english-reranker.gguf" } }),
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
