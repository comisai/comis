// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  deriveOllamaNativeBase,
  probeOllamaServedWindow,
  probeAllOllamaProviders,
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
  it("CWF-03-K-1: no suffix — passthrough unchanged", () => {
    expect(deriveOllamaNativeBase("http://localhost:11434")).toBe("http://localhost:11434");
  });

  it("CWF-03-K-2: strips /v1 suffix", () => {
    expect(deriveOllamaNativeBase("http://localhost:11434/v1")).toBe("http://localhost:11434");
  });

  it("CWF-03-K-3: strips /v1/ trailing-slash suffix", () => {
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

  it("CWF-03-probe-1: /api/ps returns context_length=32768 → ok({servedWindow:32768, source:'api/ps'})", async () => {
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

  it("CWF-03-probe-2: /api/ps empty; /api/show returns context_length=65536 → ok({servedWindow:65536, source:'api/show'})", async () => {
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

  it("CWF-03-J: /api/ps model not found; /api/show no context_length → err({errorKind:'internal'})", async () => {
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
  // IN-02 (Phase 176 review): third-party input hardening. The served value
  // drives EVERY turn's budget (the reconcile min race), so a buggy or
  // misconfigured Ollama returning a fractional or absurdly small
  // context_length (e.g. a bad Modelfile `PARAMETER num_ctx`) must not flow
  // in unclamped: floor to an integer; reject < 512 (fall through to the
  // /api/show fallback, then to the existing fail-open err/WARN path).
  // -------------------------------------------------------------------------

  it("IN-02-1: a fractional /api/ps context_length is floored to an integer servedWindow", async () => {
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

  it("IN-02-2: an absurdly small /api/ps context_length (<512) is rejected — the probe falls through to /api/show", async () => {
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

  it("IN-02-3: a fractional /api/show context_length is floored to an integer servedWindow", async () => {
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

  it("IN-02-4: bogus values at BOTH endpoints err out (the fail-open path) — a sub-512 window never escapes the probe", async () => {
    // IN-05 refined the failure classification: a PRESENT-but-rejected value
    // is "validation" (bad third-party input), no longer the absent-field
    // "internal" — see the IN-05 tests below for the message/hint contract.
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
  // IN-05 (Phase 176 review, iteration 2): a PRESENT-but-rejected
  // context_length must not be reported as ABSENT. The IN-02 sanitization
  // routed a bogus value (e.g. a typo'd Modelfile `PARAMETER num_ctx 100`)
  // into the both-endpoints-exhausted err, whose "No context_length found"
  // message + the orchestrator's "start Ollama" hint pointed the operator the
  // wrong way — Ollama was up and DID return a value; it was implausible.
  // -------------------------------------------------------------------------

  it("IN-05-1: a rejected-implausible context_length errs with the implausible-value message naming the Modelfile knob, never 'No context_length found'", async () => {
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

  it("IN-05-2: a genuinely ABSENT context_length keeps the byte-identical absent message and errorKind internal", async () => {
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
  // Fail-open matrix (CWF-03-C/D/E)
  // -------------------------------------------------------------------------

  it("CWF-03-C: fetch throws AbortError (timeout) → err({errorKind:'timeout'})", async () => {
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

  it("CWF-03-D: fetch throws TypeError ECONNREFUSED → err({errorKind:'dependency'})", async () => {
    const deps = makeDeps(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorKind).toBe("dependency");
    }
  });

  it("CWF-03-D-2: /api/ps returns HTTP 503 → err({errorKind:'dependency'})", async () => {
    const deps = makeDeps(async () => jsonResponse({ error: "Service Unavailable" }, 503));

    const result = await probeOllamaServedWindow("http://localhost:11434", "qwen3.6:35b", deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorKind).toBe("dependency");
    }
  });

  it("CWF-03-E: /api/ps returns HTTP 200 but invalid JSON → err({errorKind:'internal'})", async () => {
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

  it("CWF-03-E-2: /api/ps returns HTTP 200 valid JSON but missing .models → err({errorKind:'internal'})", async () => {
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

  it("CWF-03-I: probeServedWindow=false → no fetchFn call for that provider", async () => {
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

  it("CWF-03-modelid: resolves the probe model id from models[0].id when defaultModel is absent (real config shape)", async () => {
    // Live incident (v2.20 distillation validation, 2026-06-10): ProviderEntrySchema
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

  it("W12: an HTTP-status probe failure hints at the model/payload, not 'start Ollama' (the server responded)", async () => {
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

  it("IN-05-3: a rejected-implausible served value hints at the Modelfile num_ctx, not 'start Ollama' (the server responded with a value)", async () => {
    // IN-05 (Phase 176 review, iteration 2): the W12 hint-branching doctrine
    // extended to the rejected-value class — Ollama is up and returned a
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

  it("W12: a network-level probe failure keeps the start-Ollama hint", async () => {
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

  it("CWF-03-F: type='lm-studio' → not probed (no fetchFn call)", async () => {
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

  it("CWF-03-F-2: type='ollama', probeServedWindow=undefined → probe RUNS", async () => {
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

  it.skip("CWF-03-L: live: probe returns finite servedWindow ≤ native max — operator step", async () => {
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
// resolveProbedModelId — the single shared probed-model expression (KNOB-01)
// ---------------------------------------------------------------------------

describe("resolveProbedModelId", () => {
  it("KNOB-01-10: resolves defaultModel ?? models[0].id ?? '' — single source shared with the served-window comparator", async () => {
    // Dynamic import: in the RED state (export not yet present) only THIS test
    // fails — a static named import would break the whole file's module link
    // and take the existing probe tests down with it. The 17fdd1e5 bug class
    // was two sites deriving the probed-model expression differently; this pin
    // keeps the probe and the KNOB-01 comparator on ONE exported helper.
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
