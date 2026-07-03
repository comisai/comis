// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  deriveOllamaNativeBase,
  probeOllamaServedWindow,
  probeAllOllamaProviders,
  prewarmOllamaModel,
  type OllamaCapacityProbeDeps,
} from "./ollama-capacity-probe.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
): (url: string, init: RequestInit) => Promise<Response> {
  return handler;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// deriveOllamaNativeBase
// ---------------------------------------------------------------------------

describe("deriveOllamaNativeBase", () => {
  it("a bare host baseUrl passes through unchanged", () => {
    expect(deriveOllamaNativeBase("http://localhost:11434")).toBe("http://localhost:11434");
  });

  it("strips a trailing /v1 suffix", () => {
    expect(deriveOllamaNativeBase("http://localhost:11434/v1")).toBe("http://localhost:11434");
  });

  it("strips a /v1/ trailing-slash suffix", () => {
    expect(deriveOllamaNativeBase("http://localhost:11434/v1/")).toBe("http://localhost:11434");
  });
});

// ---------------------------------------------------------------------------
// probeOllamaServedWindow — happy paths
// ---------------------------------------------------------------------------

describe("probeOllamaServedWindow", () => {
  let fetchCalls: Array<{ url: string; init: RequestInit }>;

  beforeEach(() => {
    fetchCalls = [];
  });

  function makeDeps(
    handler: (url: string, init: RequestInit) => Promise<Response>,
  ): OllamaCapacityProbeDeps {
    return {
      fetchFn: createMockFetch(async (url, init) => {
        fetchCalls.push({ url, init });
        return handler(url, init);
      }),
      timeoutMs: 5000,
    };
  }

  it("/api/ps returns context_length=32768 → ok({servedWindow:32768, source:'api/ps'})", async () => {
    const deps = makeDeps(async (url) => {
      if (url.endsWith("/api/ps")) {
        return jsonResponse({
          models: [
            {
              name: "qwen3.6:35b",
              model: "qwen3.6:35b",
              context_length: 32768,
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servedWindow).toBe(32768);
      expect(result.value.source).toBe("api/ps");
    }
  });

  it("/api/ps empty; /api/show returns context_length=65536 → ok({servedWindow:65536, source:'api/show'})", async () => {
    const deps = makeDeps(async (url) => {
      if (url.endsWith("/api/ps")) {
        return jsonResponse({ models: [] });
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({ details: { context_length: 65536 } });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servedWindow).toBe(65536);
      expect(result.value.source).toBe("api/show");
    }
  });

  it("/api/ps model not found; /api/show no context_length → err({errorKind:'internal'})", async () => {
    const deps = makeDeps(async (url) => {
      if (url.endsWith("/api/ps")) {
        return jsonResponse({ models: [] });
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({ details: {} });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorKind).toBe("internal");
    }
  });

  // -------------------------------------------------------------------------
  // Third-party input hardening. The served value
  // drives EVERY turn's budget (the reconcile min race), so a buggy or
  // misconfigured Ollama returning a fractional or absurdly small
  // context_length (e.g. a bad Modelfile `PARAMETER num_ctx`) must not flow
  // in unclamped: floor to an integer; reject < 512 (fall through to the
  // /api/show fallback, then to the existing fail-open err/WARN path).
  // -------------------------------------------------------------------------

  it("a fractional /api/ps context_length is floored to an integer servedWindow", async () => {
    const deps = makeDeps(async (url) => {
      if (url.endsWith("/api/ps")) {
        return jsonResponse({
          models: [{ name: "qwen3.6:35b", model: "qwen3.6:35b", context_length: 32768.9 }],
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servedWindow).toBe(32768);
      expect(Number.isInteger(result.value.servedWindow)).toBe(true);
    }
  });

  it("an absurdly small /api/ps context_length (<512) is rejected — the probe falls through to /api/show", async () => {
    const deps = makeDeps(async (url) => {
      if (url.endsWith("/api/ps")) {
        return jsonResponse({
          models: [{ name: "qwen3.6:35b", model: "qwen3.6:35b", context_length: 1 }],
        });
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({ details: { context_length: 65536 } });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servedWindow).toBe(65536);
      expect(result.value.source).toBe("api/show");
    }
  });

  it("a fractional /api/show context_length is floored to an integer servedWindow", async () => {
    const deps = makeDeps(async (url) => {
      if (url.endsWith("/api/ps")) {
        return jsonResponse({ models: [] });
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({ details: { context_length: 65536.5 } });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servedWindow).toBe(65536);
      expect(result.value.source).toBe("api/show");
    }
  });

  it("bogus values at BOTH endpoints err out (the fail-open path) — a sub-512 window never escapes the probe", async () => {
    // Failure classification: a PRESENT-but-rejected value is "validation"
    // (bad third-party input), not the absent-field "internal" — see the
    // presence-vs-absence tests below for the message/hint contract.
    const deps = makeDeps(async (url) => {
      if (url.endsWith("/api/ps")) {
        return jsonResponse({
          models: [{ name: "qwen3.6:35b", model: "qwen3.6:35b", context_length: 0.5 }],
        });
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({ details: { context_length: 100 } });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorKind).toBe("validation");
    }
  });

  // -------------------------------------------------------------------------
  // A PRESENT-but-rejected context_length must not be reported as ABSENT.
  // The sanitization used to route a bogus value (e.g. a typo'd Modelfile
  // `PARAMETER num_ctx 100`) into the both-endpoints-exhausted err, whose
  // "No context_length found" message + the orchestrator's "start Ollama"
  // hint pointed the operator the wrong way — Ollama was up and DID return a
  // value; it was implausible.
  // -------------------------------------------------------------------------

  it("a rejected-implausible context_length errs with the implausible-value message naming the Modelfile knob, never 'No context_length found'", async () => {
    const deps = makeDeps(async (url) => {
      if (url.endsWith("/api/ps")) {
        return jsonResponse({
          models: [{ name: "qwen3.6:35b", model: "qwen3.6:35b", context_length: 100 }],
        });
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({ details: { context_length: 100 } });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/implausible/);
      expect(result.error.message).toContain("PARAMETER num_ctx");
      expect(result.error.message).not.toContain("No context_length found");
      expect(result.error.errorKind).toBe("validation");
    }
  });

  it("a genuinely ABSENT context_length keeps the byte-identical absent message and errorKind internal", async () => {
    const deps = makeDeps(async (url) => {
      if (url.endsWith("/api/ps")) {
        return jsonResponse({ models: [] }); // model not loaded — nothing present
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({ details: {} }); // field absent
      }
      return jsonResponse({}, 404);
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("No context_length found in /api/ps or /api/show");
      expect(result.error.errorKind).toBe("internal");
    }
  });

  // -------------------------------------------------------------------------
  // Fail-open matrix
  // -------------------------------------------------------------------------

  it("fetch throws AbortError (timeout) → err({errorKind:'timeout'})", async () => {
    const deps = makeDeps(async () => {
      const abortErr = new DOMException("The operation was aborted", "AbortError");
      throw abortErr;
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorKind).toBe("timeout");
    }
  });

  it("fetch throws TypeError ECONNREFUSED → err({errorKind:'dependency'})", async () => {
    const deps = makeDeps(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorKind).toBe("dependency");
    }
  });

  it("/api/ps returns HTTP 503 → err({errorKind:'dependency'})", async () => {
    const deps = makeDeps(async () => jsonResponse({ error: "Service Unavailable" }, 503));

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorKind).toBe("dependency");
    }
  });

  it("/api/ps returns HTTP 200 but invalid JSON → err({errorKind:'internal'})", async () => {
    const deps = makeDeps(async () => {
      return new Response("NOT JSON { invalid", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorKind).toBe("internal");
    }
  });

  it("/api/ps returns HTTP 200 valid JSON but missing .models → err({errorKind:'internal'})", async () => {
    const deps = makeDeps(async () => jsonResponse({ data: "unexpected" }));

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorKind).toBe("internal");
    }
  });

  it("never throws — all error paths return err()", async () => {
    // Ensure the function itself doesn't throw even on unexpected errors
    const deps = makeDeps(async () => {
      throw new Error("Completely unexpected error");
    });

    let threw = false;
    let result: Awaited<ReturnType<typeof probeOllamaServedWindow>> | undefined;
    try {
      result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// probeAllOllamaProviders — probe scope
// ---------------------------------------------------------------------------

describe("probeAllOllamaProviders", () => {
  let fetchCalls: Array<{ url: string; init: RequestInit }>;

  beforeEach(() => {
    fetchCalls = [];
  });

  const mockLogger = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
    child: function () { return this; },
  } as any;

  function makeFetchFn(
    handler: (url: string, init: RequestInit) => Promise<Response>,
  ): (url: string, init: RequestInit) => Promise<Response> {
    return async (url, init) => {
      fetchCalls.push({ url, init });
      return handler(url, init);
    };
  }

  it("probeServedWindow=false → no fetchFn call for that provider", async () => {
    const providerEntries = {
      myOllama: {
        type: "ollama",
        baseUrl: "http://localhost:11434",
        capabilities: { probeServedWindow: false },
        defaultModel: "qwen3.6:35b",
      },
    };

    const fetchFn = makeFetchFn(async () => jsonResponse({ models: [] }));
    await probeAllOllamaProviders({ providerEntries, fetchFn, timeoutMs: 5000, logger: mockLogger });

    expect(fetchCalls.length).toBe(0);
  });

  it("resolves the probe model id from models[0].id when defaultModel is absent (real config shape)", async () => {
    // Live incident: ProviderEntrySchema
    // has NO `defaultModel` field — the model lives under `models[].id`. The probe
    // read `entry.defaultModel ?? ""`, so modelId was ALWAYS "" → at cold-start (no
    // model loaded → /api/ps empty → /api/show fallback) Ollama returned HTTP 400
    // ("verify the model '' exists") and the daemon NEVER discovered the served
    // num_ctx. The probe must resolve the model id from models[0].id. (Earlier tests
    // rigged `defaultModel`, which the real config never sets — masking the bug.)
    const seenShowNames: string[] = [];
    const providerEntries = {
      myOllama: {
        type: "ollama",
        baseUrl: "http://localhost:11434",
        models: [{ id: "qwen3.6:35b" }],
        // NO defaultModel — exactly how providers.entries.* is shaped in production
      },
    };
    const fetchFn = makeFetchFn(async (url, init) => {
      if (url.endsWith("/api/ps")) return jsonResponse({ models: [] }); // cold start
      if (url.endsWith("/api/show")) {
        const name = (JSON.parse(String(init.body ?? "{}")) as { name?: string }).name ?? "";
        seenShowNames.push(name);
        // Ollama rejects an empty model name with HTTP 400 (the live failure).
        if (!name) return new Response("model name required", { status: 400 });
        return jsonResponse({ details: { context_length: 65536 } });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeAllOllamaProviders({ providerEntries, fetchFn, timeoutMs: 5000, logger: mockLogger });

    expect(seenShowNames).toContain("qwen3.6:35b"); // NOT "" — the model id was resolved
    expect(result.get("myOllama")).toBe(65536); // served window discovered (no fall-through to configured)
  });

  it("an HTTP-status probe failure hints at the model/payload, not 'start Ollama' (the server responded)", async () => {
    // Live: HTTP 400 from /api/show while Ollama was up — the hint said
    // "start Ollama", pointing the operator away from the actual cause.
    const warn = vi.fn();
    const logger = { info: () => {}, warn, debug: () => {}, error: () => {}, child() { return this; } } as any;
    const providerEntries = {
      myOllama: { type: "ollama", baseUrl: "http://localhost:11434", defaultModel: "qwen3.6:35b" },
    };
    const fetchFn = makeFetchFn(async () => new Response("bad request", { status: 400 }));
    await probeAllOllamaProviders({ providerEntries, fetchFn, timeoutMs: 5000, logger });

    const warnCall = warn.mock.calls.find((c) => c[1] === "Ollama capacity probe failed — using configured contextWindow");
    expect(warnCall).toBeDefined();
    const hint = (warnCall![0] as { hint: string }).hint;
    expect(hint).not.toContain("start Ollama");
    expect(hint).toContain("reachable");
    expect(hint).toContain("model");
  });

  it("a rejected-implausible served value hints at the Modelfile num_ctx, not 'start Ollama' (the server responded with a value)", async () => {
    // The hint-branching doctrine extended to the rejected-value class —
    // Ollama is up and returned a
    // context_length; it was rejected as implausible (< 512). "start Ollama"
    // points the operator away from the actual lever (the Modelfile).
    const warn = vi.fn();
    const logger = { info: () => {}, warn, debug: () => {}, error: () => {}, child() { return this; } } as any;
    const providerEntries = {
      myOllama: { type: "ollama", baseUrl: "http://localhost:11434", defaultModel: "qwen3.6:35b" },
    };
    const fetchFn = makeFetchFn(async (url) => {
      if (url.endsWith("/api/ps")) {
        return jsonResponse({
          models: [{ name: "qwen3.6:35b", model: "qwen3.6:35b", context_length: 100 }],
        });
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({ details: { context_length: 100 } });
      }
      return jsonResponse({}, 404);
    });
    await probeAllOllamaProviders({ providerEntries, fetchFn, timeoutMs: 5000, logger });

    const warnCall = warn.mock.calls.find((c) => c[1] === "Ollama capacity probe failed — using configured contextWindow");
    expect(warnCall).toBeDefined();
    const hint = (warnCall![0] as { hint: string }).hint;
    expect(hint).not.toContain("start Ollama");
    expect(hint).toContain("PARAMETER num_ctx");
    expect(hint).toContain("falling back to configured contextWindow");
  });

  it("a network-level probe failure keeps the start-Ollama hint", async () => {
    const warn = vi.fn();
    const logger = { info: () => {}, warn, debug: () => {}, error: () => {}, child() { return this; } } as any;
    const providerEntries = {
      myOllama: { type: "ollama", baseUrl: "http://localhost:11434", defaultModel: "qwen3.6:35b" },
    };
    const fetchFn = makeFetchFn(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    await probeAllOllamaProviders({ providerEntries, fetchFn, timeoutMs: 5000, logger });

    const warnCall = warn.mock.calls.find((c) => c[1] === "Ollama capacity probe failed — using configured contextWindow");
    expect(warnCall).toBeDefined();
    expect((warnCall![0] as { hint: string }).hint).toContain("start Ollama");
  });

  it("type='lm-studio' → not probed (no fetchFn call)", async () => {
    const providerEntries = {
      myLmStudio: {
        type: "lm-studio",
        baseUrl: "http://localhost:1234",
        capabilities: {},
        defaultModel: "llama3",
      },
    };

    const fetchFn = makeFetchFn(async () => jsonResponse({ models: [] }));
    await probeAllOllamaProviders({ providerEntries, fetchFn, timeoutMs: 5000, logger: mockLogger });

    expect(fetchCalls.length).toBe(0);
  });

  it("type='ollama', probeServedWindow=undefined → probe RUNS", async () => {
    const providerEntries = {
      myOllama: {
        type: "ollama",
        baseUrl: "http://localhost:11434",
        capabilities: {},
        defaultModel: "qwen3.6:35b",
      },
    };

    const fetchFn = makeFetchFn(async (url) => {
      if (url.endsWith("/api/ps")) {
        return jsonResponse({
          models: [{ name: "qwen3.6:35b", model: "qwen3.6:35b", context_length: 32768 }],
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeAllOllamaProviders({ providerEntries, fetchFn, timeoutMs: 5000, logger: mockLogger });

    // Should have made at least one fetch call
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(result.get("myOllama")).toBe(32768);
  });

  it("probe result map has servedWindow for successful ollama provider", async () => {
    const providerEntries = {
      primary: {
        type: "ollama",
        baseUrl: "http://localhost:11434/v1",
        capabilities: {},
        defaultModel: "qwen3.6:35b",
      },
    };

    const fetchFn = makeFetchFn(async (url) => {
      // /v1 should be stripped — the call must go to /api/ps (not /v1/api/ps)
      if (url.includes("/v1/")) {
        throw new Error("FATAL: /v1 was not stripped before native API call");
      }
      if (url.endsWith("/api/ps")) {
        return jsonResponse({
          models: [{ name: "qwen3.6:35b", model: "qwen3.6:35b", context_length: 16384 }],
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await probeAllOllamaProviders({ providerEntries, fetchFn, timeoutMs: 5000, logger: mockLogger });

    expect(result.get("primary")).toBe(16384);
  });

  it("failed probe → key absent from result map (fail-open)", async () => {
    const providerEntries = {
      failingProvider: {
        type: "ollama",
        baseUrl: "http://localhost:11434",
        capabilities: {},
        defaultModel: "qwen3.6:35b",
      },
    };

    const fetchFn = makeFetchFn(async () => {
      throw new TypeError("ECONNREFUSED");
    });

    const result = await probeAllOllamaProviders({ providerEntries, fetchFn, timeoutMs: 5000, logger: mockLogger });

    // Fail-open: missing key → caller falls back to configured window
    expect(result.has("failingProvider")).toBe(false);
  });

  it.skip("live: probe returns finite servedWindow ≤ native max — operator step", async () => {
    // Requires live Ollama instance. Run manually: OLLAMA_BASE=http://localhost:11434 pnpm test:integration
    const result = await probeOllamaServedWindow("http://localhost:11434", "", {
      fetchFn: fetch as unknown as (url: string, init: RequestInit) => Promise<Response>,
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servedWindow).toBeGreaterThan(0);
      expect(isFinite(result.value.servedWindow)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveProbedModelId — the single shared probed-model expression
// ---------------------------------------------------------------------------

describe("resolveProbedModelId", () => {
  it("resolves defaultModel ?? models[0].id ?? '' — single source shared with the served-window comparator", async () => {
    // Dynamic import: if the export goes missing only THIS test fails — a
    // static named import would break the whole file's module link and take
    // the existing probe tests down with it. Two sites once derived the
    // probed-model expression independently and disagreed; this pin keeps the
    // probe and the served-window comparator on ONE exported helper.
    const mod = (await import("./ollama-capacity-probe.js")) as unknown as {
      resolveProbedModelId?: (
        entry: { defaultModel?: string; models?: Array<{ id?: string }> } | undefined,
      ) => string;
    };
    const resolveProbedModelId = mod.resolveProbedModelId;
    expect(typeof resolveProbedModelId).toBe("function");
    expect(resolveProbedModelId?.({ defaultModel: "a", models: [{ id: "b" }] })).toBe("a");
    expect(resolveProbedModelId?.({ models: [{ id: "b" }] })).toBe("b");
    expect(resolveProbedModelId?.({})).toBe("");
  });
});

// ---------------------------------------------------------------------------
// prewarmOllamaModel — a cold local model's
// FIRST inference (prompt-processing the full tool-corpus prompt) can exceed the
// per-inference stall budget → the first user turn after a daemon (re)start aborts
// "request took too long" BEFORE any tool call. A boot-time load-only warm-up loads
// the model in the background so the first real turn runs warm.
// ---------------------------------------------------------------------------
describe("prewarmOllamaModel", () => {
  it("POSTs /api/generate with the model + keep_alive (load-only) to warm a cold model", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const fetchFn = createMockFetch(async (url, init) => {
      calls.push({ url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
      return jsonResponse({ done: true });
    });
    await prewarmOllamaModel("http://localhost:11434", "qwen3.6:35b", { fetchFn, timeoutMs: 5_000 });
    const gen = calls.find((c) => c.url.endsWith("/api/generate"));
    expect(gen, "should POST /api/generate to load the model").toBeDefined();
    expect(gen!.body!.model).toBe("qwen3.6:35b");
    expect(gen!.body!.keep_alive, "keep_alive keeps the model resident past the warm-up").toBeDefined();
  });

  it("is a no-op for an empty modelId (probe's 'any loaded model' sentinel — nothing specific to warm)", async () => {
    let called = false;
    const fetchFn = createMockFetch(async () => { called = true; return jsonResponse({}); });
    await prewarmOllamaModel("http://localhost:11434", "", { fetchFn, timeoutMs: 5_000 });
    expect(called).toBe(false);
  });

  it("is non-fatal on a fetch error (best-effort — never throws)", async () => {
    const fetchFn = createMockFetch(async () => { throw new Error("connection refused"); });
    await expect(
      prewarmOllamaModel("http://localhost:11434", "m", { fetchFn, timeoutMs: 5_000 }),
    ).resolves.toBeUndefined();
  });

  it("probeAllOllamaProviders({prewarm:true}) issues the warm-up for an ollama provider", async () => {
    const calls: string[] = [];
    const fetchFn = createMockFetch(async (url) => {
      calls.push(url);
      if (url.endsWith("/api/ps")) return jsonResponse({ models: [] });
      return jsonResponse({ done: true });
    });
    await probeAllOllamaProviders({
      providerEntries: { "local-ollama": { type: "ollama", baseUrl: "http://localhost:11434", models: [{ id: "qwen3.6:35b" }] } },
      fetchFn,
      timeoutMs: 5_000,
      prewarm: true,
      logger: { info() {}, warn() {} },
    });
    await Promise.resolve();
    expect(calls.some((u) => u.endsWith("/api/generate")), "prewarm:true must POST /api/generate").toBe(true);
  });

  it("probeAllOllamaProviders WITHOUT prewarm issues NO warm-up (flag unset → no warm-up traffic)", async () => {
    const calls: string[] = [];
    const fetchFn = createMockFetch(async (url) => {
      calls.push(url);
      if (url.endsWith("/api/ps")) return jsonResponse({ models: [] });
      return jsonResponse({});
    });
    await probeAllOllamaProviders({
      providerEntries: { "local-ollama": { type: "ollama", baseUrl: "http://localhost:11434", models: [{ id: "m" }] } },
      fetchFn,
      timeoutMs: 5_000,
      logger: { info() {}, warn() {} },
    });
    await Promise.resolve();
    expect(calls.some((u) => u.endsWith("/api/generate"))).toBe(false);
  });
});
