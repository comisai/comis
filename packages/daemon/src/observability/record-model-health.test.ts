// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { DiagnosticRow, ObservabilityStore } from "@comis/memory";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { recordModelHealth } from "./record-model-health.js";

// ---------------------------------------------------------------------------
// recordModelHealth (boot-time model_health snapshot row)
//
// A one-shot direct insertDiagnostic at boot capturing the three in-process
// load-level signals (embedding availability / GGUF reranker load / reranker
// model presence) as booleans only. NOT an event — a point-in-time snapshot.
// ---------------------------------------------------------------------------

/**
 * Minimal ObservabilityStore stub exposing only the method the SUT calls
 * (insertDiagnostic), with that method spied. Everything else is a never —
 * recordModelHealth must touch nothing but insertDiagnostic.
 */
function createSpiedObsStore(): {
  obsStore: ObservabilityStore;
  insertDiagnostic: ReturnType<typeof vi.fn>;
} {
  const insertDiagnostic = vi.fn<(entry: DiagnosticRow) => void>();
  const obsStore = { insertDiagnostic } as unknown as ObservabilityStore;
  return { obsStore, insertDiagnostic };
}

describe("recordModelHealth", () => {
  it("writes a model_health row with severity info when embedding is available and details carry exactly the five advisory keys", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(1000);

    recordModelHealth(
      obsStore,
      {
        embeddingAvailable: true,
        rerankerModelPresent: true,
        rerankerBuilt: true,
        embeddingMultilingual: "unknown",
        rerankerMultilingual: true,
      },
      clock,
    );

    expect(insertDiagnostic).toHaveBeenCalledTimes(1);
    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    expect(row.timestamp).toBe(1000);
    expect(row.category).toBe("model_health");
    expect(row.severity).toBe("info");
    expect(row.message).toBe("model_health");

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    // EXACTLY the five booleans/"unknown" values — no extra keys, no free text,
    // no model paths/URIs (content-free contract).
    expect(details).toEqual({
      embeddingAvailable: true,
      rerankerModelPresent: true,
      rerankerBuilt: true,
      embeddingMultilingual: "unknown",
      rerankerMultilingual: true,
    });
  });

  it("uses severity warning when the embedding provider is unavailable", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(2000);

    recordModelHealth(
      obsStore,
      {
        embeddingAvailable: false,
        rerankerModelPresent: true,
        rerankerBuilt: false,
        embeddingMultilingual: false,
        rerankerMultilingual: "unknown",
      },
      clock,
    );

    expect(insertDiagnostic).toHaveBeenCalledTimes(1);
    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    expect(row.severity).toBe("warning");

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({
      embeddingAvailable: false,
      rerankerModelPresent: true,
      rerankerBuilt: false,
      embeddingMultilingual: false,
      rerankerMultilingual: "unknown",
    });
  });

  it("round-trips an \"unknown\" multilingual value in details as the string \"unknown\"", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(2500);

    recordModelHealth(
      obsStore,
      {
        embeddingAvailable: true,
        rerankerModelPresent: false,
        rerankerBuilt: false,
        embeddingMultilingual: "unknown",
        rerankerMultilingual: "unknown",
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.embeddingMultilingual).toBe("unknown");
    expect(details.rerankerMultilingual).toBe("unknown");
  });

  it("keeps severity driven by embeddingAvailable only — a non-multilingual but AVAILABLE embedder is info, not warning", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(2700);

    recordModelHealth(
      obsStore,
      {
        embeddingAvailable: true, // available...
        rerankerModelPresent: true,
        rerankerBuilt: true,
        embeddingMultilingual: false, // ...but English-leaning — must NOT escalate severity
        rerankerMultilingual: false,
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    expect(row.severity).toBe("info");
  });

  it("carries NO model URI / path / secret in details — only the five booleans/\"unknown\" keys (content-free)", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(2900);

    recordModelHealth(
      obsStore,
      {
        embeddingAvailable: true,
        rerankerModelPresent: true,
        rerankerBuilt: true,
        embeddingMultilingual: true,
        rerankerMultilingual: true,
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    // Exactly the expected key set — no modelUri / rerankerModel / path leaked.
    expect(Object.keys(details).sort()).toEqual([
      "embeddingAvailable",
      "embeddingMultilingual",
      "rerankerBuilt",
      "rerankerModelPresent",
      "rerankerMultilingual",
    ]);
    const serialized = row.details ?? "";
    expect(serialized).not.toContain("hf:");
    expect(serialized).not.toContain(".gguf");
    expect(serialized).not.toContain("modelUri");
  });

  it("no-ops without throwing when persistence is disabled (obsStore undefined)", () => {
    const clock = createFakeClock(3000);

    // The ?.-chained call must silently no-op — a disabled-persistence boot
    // cannot crash startup.
    expect(() =>
      recordModelHealth(
        undefined,
        {
          embeddingAvailable: true,
          rerankerModelPresent: false,
          rerankerBuilt: false,
          embeddingMultilingual: "unknown",
          rerankerMultilingual: "unknown",
        },
        clock,
      ),
    ).not.toThrow();
  });

  it("reads the timestamp from the injected clock, not wall-clock (no Date.now)", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(42);
    // Advance the fake clock so its value is unmistakably not a wall-clock epoch.
    clock.advance(8);

    recordModelHealth(
      obsStore,
      {
        embeddingAvailable: true,
        rerankerModelPresent: true,
        rerankerBuilt: true,
        embeddingMultilingual: "unknown",
        rerankerMultilingual: true,
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    // 42 + 8 = 50 — the fake clock's value, proving no Date.now() leak.
    expect(row.timestamp).toBe(50);
  });
});

describe("recordModelHealth vec rebuild reporting", () => {
  it("includes the boot vec-dimension rebuilds in details so the fleet drill-down confirms the heal ran", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(2000);

    recordModelHealth(
      obsStore,
      {
        embeddingAvailable: true,
        rerankerModelPresent: false,
        rerankerBuilt: false,
        embeddingMultilingual: true,
        rerankerMultilingual: "unknown",
        vecRebuilt: [{ table: "vec_memories", fromDimensions: 768, toDimensions: 1536 }],
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.vecRebuilt).toEqual([
      { table: "vec_memories", fromDimensions: 768, toDimensions: 1536 },
    ]);
  });

  it("omits the vecRebuilt key entirely when no rebuild happened this boot", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(2000);

    recordModelHealth(
      obsStore,
      {
        embeddingAvailable: true,
        rerankerModelPresent: false,
        rerankerBuilt: false,
        embeddingMultilingual: true,
        rerankerMultilingual: "unknown",
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect("vecRebuilt" in details).toBe(false);
  });
});
