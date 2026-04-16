import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  matchesUrl,
  injectCredential,
  createCredentialInjector,
  wrapWithCredentialInjection,
} from "./credential-injector.js";
import type { CredentialMapping } from "@comis/core";
import type { SecretManager } from "@comis/core";

// ---------------------------------------------------------------------------
// matchesUrl
// ---------------------------------------------------------------------------

describe("matchesUrl", () => {
  it("matches exact hostname", () => {
    expect(matchesUrl("https://api.example.com/v1/search", "api.example.com")).toBe(true);
  });

  it("rejects different hostname", () => {
    expect(matchesUrl("https://evil.com/api.example.com", "api.example.com")).toBe(false);
  });

  it("matches hostname + path prefix", () => {
    expect(matchesUrl("https://api.example.com/v1/search?q=test", "api.example.com/v1")).toBe(true);
  });

  it("rejects hostname match but wrong path", () => {
    expect(matchesUrl("https://api.example.com/v2/search", "api.example.com/v1")).toBe(false);
  });

  it("handles urlPattern without protocol", () => {
    expect(matchesUrl("https://api.example.com/foo", "api.example.com")).toBe(true);
  });

  it("handles urlPattern with protocol", () => {
    expect(matchesUrl("https://api.example.com/foo", "https://api.example.com")).toBe(true);
  });

  it("returns false for invalid URLs", () => {
    expect(matchesUrl("not-a-url", "api.example.com")).toBe(false);
  });

  it("case insensitive hostname", () => {
    expect(matchesUrl("https://API.Example.COM/path", "api.example.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// injectCredential
// ---------------------------------------------------------------------------

describe("injectCredential", () => {
  const baseUrl = new URL("https://api.example.com/v1/search");

  it("bearer_header sets Authorization header with Bearer prefix", () => {
    const mapping: CredentialMapping = {
      id: "m1",
      secretName: "API_KEY",
      injectionType: "bearer_header",
      urlPattern: "api.example.com",
    };

    const { init } = injectCredential({}, baseUrl, mapping, "sk-test-123");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer sk-test-123");
  });

  it("custom_header sets the specified header name", () => {
    const mapping: CredentialMapping = {
      id: "m2",
      secretName: "API_KEY",
      injectionType: "custom_header",
      injectionKey: "X-Api-Key",
      urlPattern: "api.example.com",
    };

    const { init } = injectCredential({}, baseUrl, mapping, "key-abc");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Api-Key")).toBe("key-abc");
  });

  it("query_param adds query parameter to URL", () => {
    const mapping: CredentialMapping = {
      id: "m3",
      secretName: "API_KEY",
      injectionType: "query_param",
      injectionKey: "api_key",
      urlPattern: "api.example.com",
    };

    const { url } = injectCredential({}, baseUrl, mapping, "key-xyz");
    expect(url.searchParams.get("api_key")).toBe("key-xyz");
  });

  it("basic_auth sets Authorization header with Base64-encoded value", () => {
    const mapping: CredentialMapping = {
      id: "m4",
      secretName: "API_KEY",
      injectionType: "basic_auth",
      urlPattern: "api.example.com",
    };

    const { init } = injectCredential({}, baseUrl, mapping, "user:pass");
    const headers = new Headers(init.headers);
    const expected = `Basic ${Buffer.from("user:pass").toString("base64")}`;
    expect(headers.get("Authorization")).toBe(expected);
  });

  it("custom_header throws if injectionKey is missing", () => {
    const mapping: CredentialMapping = {
      id: "m5",
      secretName: "API_KEY",
      injectionType: "custom_header",
      urlPattern: "api.example.com",
    } as CredentialMapping; // cast because Zod would normally catch this

    expect(() => injectCredential({}, baseUrl, mapping, "val")).toThrow(/injectionKey/);
  });

  it("query_param throws if injectionKey is missing", () => {
    const mapping: CredentialMapping = {
      id: "m6",
      secretName: "API_KEY",
      injectionType: "query_param",
      urlPattern: "api.example.com",
    } as CredentialMapping;

    expect(() => injectCredential({}, baseUrl, mapping, "val")).toThrow(/injectionKey/);
  });
});

// ---------------------------------------------------------------------------
// createCredentialInjector
// ---------------------------------------------------------------------------

describe("createCredentialInjector", () => {
  let mockSecretManager: SecretManager;
  let savedFetch: typeof fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;

    mockSecretManager = {
      get: vi.fn((key: string) => {
        if (key === "EXAMPLE_API_KEY") return "secret-value-123";
        return undefined;
      }),
      has: vi.fn(() => true),
      require: vi.fn((key: string) => {
        const val = mockSecretManager.get(key);
        if (!val) throw new Error(`Missing ${key}`);
        return val;
      }),
      keys: vi.fn(() => ["EXAMPLE_API_KEY"]),
    };
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it("injected fetch adds Authorization header for matching URL", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    // Replace globalThis.fetch so the injector captures it as realFetch
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const injector = createCredentialInjector({
      secretManager: mockSecretManager,
      mappings: [
        {
          id: "m1",
          secretName: "EXAMPLE_API_KEY",
          injectionType: "bearer_header",
          urlPattern: "api.example.com",
        },
      ],
    });

    // Mock validateUrl to succeed
    const coreMod = await import("@comis/core");
    vi.spyOn(coreMod, "validateUrl").mockResolvedValue({
      ok: true,
      value: {
        hostname: "api.example.com",
        ip: "93.184.216.34",
        url: new URL("https://api.example.com/v1/data"),
      },
    });

    const injectedFetch = injector.createInjectedFetch("web_fetch");
    await injectedFetch("https://api.example.com/v1/data");

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://api.example.com/v1/data");
    const headers = new Headers(calledInit.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret-value-123");
  });

  it("injected fetch passes through for non-matching URL", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const injector = createCredentialInjector({
      secretManager: mockSecretManager,
      mappings: [
        {
          id: "m1",
          secretName: "EXAMPLE_API_KEY",
          injectionType: "bearer_header",
          urlPattern: "api.example.com",
        },
      ],
    });

    const injectedFetch = injector.createInjectedFetch("web_fetch");
    await injectedFetch("https://other-api.com/v1/data");

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    // No headers manipulation -- called with original input
    const [calledInput, calledInit] = fetchMock.mock.calls[0];
    expect(calledInput).toBe("https://other-api.com/v1/data");
    expect(calledInit).toBeUndefined();
  });

  it("tool_name filtering works: mapping with toolName does NOT inject for other tools", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const injector = createCredentialInjector({
      secretManager: mockSecretManager,
      mappings: [
        {
          id: "m1",
          secretName: "EXAMPLE_API_KEY",
          injectionType: "bearer_header",
          urlPattern: "api.example.com",
          toolName: "web_search",
        },
      ],
    });

    // Call with a different tool name
    const injectedFetch = injector.createInjectedFetch("web_fetch");
    await injectedFetch("https://api.example.com/v1/data");

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    // Should have passed through without injection
    const [calledInput, calledInit] = fetchMock.mock.calls[0];
    expect(calledInput).toBe("https://api.example.com/v1/data");
    expect(calledInit).toBeUndefined();
  });

  it("missing secret passes through without injection", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const injector = createCredentialInjector({
      secretManager: mockSecretManager,
      mappings: [
        {
          id: "m1",
          secretName: "NONEXISTENT_KEY",
          injectionType: "bearer_header",
          urlPattern: "api.example.com",
        },
      ],
    });

    const injectedFetch = injector.createInjectedFetch("web_fetch");
    await injectedFetch("https://api.example.com/v1/data");

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    // Should have passed through without injection
    const [calledInput, calledInit] = fetchMock.mock.calls[0];
    expect(calledInput).toBe("https://api.example.com/v1/data");
    expect(calledInit).toBeUndefined();
  });

  it("emits secret:accessed events with correct outcome", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const events: Array<{ secretName: string; outcome: string }> = [];
    const mockEventBus = {
      emit: vi.fn((event: string, data: any) => {
        if (event === "secret:accessed") {
          events.push({ secretName: data.secretName, outcome: data.outcome });
        }
      }),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
    };

    const coreMod = await import("@comis/core");
    vi.spyOn(coreMod, "validateUrl").mockResolvedValue({
      ok: true,
      value: {
        hostname: "api.example.com",
        ip: "93.184.216.34",
        url: new URL("https://api.example.com/v1/data"),
      },
    });

    const injector = createCredentialInjector({
      secretManager: mockSecretManager,
      mappings: [
        {
          id: "m1",
          secretName: "EXAMPLE_API_KEY",
          injectionType: "bearer_header",
          urlPattern: "api.example.com",
        },
      ],
      eventBus: mockEventBus as any,
      agentId: "test-agent",
    });

    const injectedFetch = injector.createInjectedFetch("web_fetch");

    // Successful injection
    await injectedFetch("https://api.example.com/v1/data");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ secretName: "EXAMPLE_API_KEY", outcome: "success" });

    // Missing secret
    events.length = 0;
    const injector2 = createCredentialInjector({
      secretManager: mockSecretManager,
      mappings: [
        {
          id: "m2",
          secretName: "NONEXISTENT_KEY",
          injectionType: "bearer_header",
          urlPattern: "api.example.com",
        },
      ],
      eventBus: mockEventBus as any,
      agentId: "test-agent",
    });

    const injectedFetch2 = injector2.createInjectedFetch("web_fetch");
    await injectedFetch2("https://api.example.com/v1/data");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ secretName: "NONEXISTENT_KEY", outcome: "not_found" });
  });

  it("getMappings returns frozen copy", () => {
    const injector = createCredentialInjector({
      secretManager: mockSecretManager,
      mappings: [
        {
          id: "m1",
          secretName: "EXAMPLE_API_KEY",
          injectionType: "bearer_header",
          urlPattern: "api.example.com",
        },
      ],
    });

    const mappings = injector.getMappings();
    expect(mappings).toHaveLength(1);
    expect(Object.isFrozen(mappings)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wrapWithCredentialInjection
// ---------------------------------------------------------------------------

describe("wrapWithCredentialInjection", () => {
  let savedFetch: typeof fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it("replaces globalThis.fetch during execute and restores after", async () => {
    const originalFetch = globalThis.fetch;
    let fetchDuringExecute: typeof fetch | undefined;

    const mockTool = {
      name: "test_tool",
      description: "A test tool",
      parameters: {},
      async execute() {
        fetchDuringExecute = globalThis.fetch;
        return { content: "ok" };
      },
    };

    const mockInjector: any = {
      createInjectedFetch: vi.fn(() => {
        const injected = async () => new Response("injected");
        return injected;
      }),
      getMappings: () => [],
    };

    const wrapped = wrapWithCredentialInjection(mockTool as any, mockInjector);
    await wrapped.execute("call-1", {});

    // During execute, globalThis.fetch was replaced
    expect(fetchDuringExecute).not.toBe(originalFetch);
    expect(mockInjector.createInjectedFetch).toHaveBeenCalledWith("test_tool");

    // After execute, globalThis.fetch is restored
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("globalThis.fetch identity is restored exactly (concurrency safety)", async () => {
    // Captures a snapshot of globalThis.fetch before wrapping.
    // After execute(), the exact same function reference must be restored,
    // ensuring no fetch wrapper leaks between sequential tool calls.
    const preWrapFetch = globalThis.fetch;

    const mockTool = {
      name: "identity_tool",
      description: "Tests fetch identity",
      parameters: {},
      async execute() {
        // During execution, fetch should be the injected version
        expect(globalThis.fetch).not.toBe(preWrapFetch);
        return { content: "ok" };
      },
    };

    const mockInjector: any = {
      createInjectedFetch: vi.fn(() => async () => new Response("injected")),
      getMappings: () => [],
    };

    const wrapped = wrapWithCredentialInjection(mockTool as any, mockInjector);
    await wrapped.execute("call-1", {});

    // After execution, globalThis.fetch must be the exact same reference
    expect(globalThis.fetch).toBe(preWrapFetch);
  });

  it("restores globalThis.fetch even if execute throws", async () => {
    const originalFetch = globalThis.fetch;

    const mockTool = {
      name: "failing_tool",
      description: "A tool that throws",
      parameters: {},
      async execute() {
        throw new Error("tool failed");
      },
    };

    const mockInjector: any = {
      createInjectedFetch: vi.fn(() => async () => new Response("injected")),
      getMappings: () => [],
    };

    const wrapped = wrapWithCredentialInjection(mockTool as any, mockInjector);

    await expect(wrapped.execute("call-1", {})).rejects.toThrow("tool failed");

    // globalThis.fetch is restored even after error
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
