// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
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
