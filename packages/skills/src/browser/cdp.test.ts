import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  appendCdpPath,
  getCdpTargets,
  getCdpVersion,
  filterPageTargets,
  findTargetById,
  type CdpTarget,
} from "./cdp.js";

// ── Mock fetch ──────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── appendCdpPath ───────────────────────────────────────────────────

describe("appendCdpPath", () => {
  it("appends path to a base URL", () => {
    const result = appendCdpPath("http://127.0.0.1:9222", "/json/list");
    expect(result).toBe("http://127.0.0.1:9222/json/list");
  });

  it("handles trailing slash on base URL", () => {
    const result = appendCdpPath("http://127.0.0.1:9222/", "/json/list");
    expect(result).toBe("http://127.0.0.1:9222/json/list");
  });

  it("preserves existing base path", () => {
    const result = appendCdpPath(
      "http://127.0.0.1:9222/devtools",
      "/json/list",
    );
    expect(result).toBe("http://127.0.0.1:9222/devtools/json/list");
  });

  it("adds leading slash when path lacks one", () => {
    const result = appendCdpPath("http://127.0.0.1:9222", "json/list");
    expect(result).toBe("http://127.0.0.1:9222/json/list");
  });
});

// ── getCdpTargets ───────────────────────────────────────────────────

describe("getCdpTargets", () => {
  it("returns parsed CDP targets from fetch response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: "abc123",
          type: "page",
          title: "My Page",
          url: "https://example.com",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc123",
        },
      ],
    });

    const targets = await getCdpTargets("http://127.0.0.1:9222");

    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({
      id: "abc123",
      type: "page",
      title: "My Page",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc123",
      devtoolsFrontendUrl: undefined,
      description: undefined,
      faviconUrl: undefined,
    });
  });

  it("filters out entries without id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "valid", type: "page", title: "Page" },
        { id: "", type: "page", title: "Empty ID" },
        { type: "page", title: "No ID" },
        { id: "also-valid", type: "page", title: "Another" },
      ],
    });

    const targets = await getCdpTargets("http://127.0.0.1:9222");

    expect(targets).toHaveLength(2);
    expect(targets[0]!.id).toBe("valid");
    expect(targets[1]!.id).toBe("also-valid");
  });

  it("applies default values for missing fields", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "x" }],
    });

    const targets = await getCdpTargets("http://127.0.0.1:9222");

    expect(targets[0]).toEqual(
      expect.objectContaining({
        id: "x",
        type: "other",
        title: "",
        url: "",
      }),
    );
  });

  it("passes timeoutMs to abort controller via fetch signal", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await getCdpTargets("http://127.0.0.1:9222", 3000);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("throws on non-ok HTTP response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(getCdpTargets("http://127.0.0.1:9222")).rejects.toThrow(
      "HTTP 500",
    );
  });

  it("constructs the correct /json/list URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await getCdpTargets("http://127.0.0.1:9222");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9222/json/list",
      expect.any(Object),
    );
  });
});

// ── getCdpVersion ───────────────────────────────────────────────────

describe("getCdpVersion", () => {
  it("returns version object on success", async () => {
    const versionData = {
      Browser: "Chrome/120.0.6099.109",
      "Protocol-Version": "1.3",
      "User-Agent": "HeadlessChrome/120",
      "V8-Version": "12.0.267.17",
      "WebKit-Version": "537.36",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/xyz",
    };

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => versionData,
    });

    const result = await getCdpVersion("http://127.0.0.1:9222");

    expect(result).toEqual(versionData);
  });

  it("returns null on network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await getCdpVersion("http://127.0.0.1:9222");

    expect(result).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await getCdpVersion("http://127.0.0.1:9222");

    expect(result).toBeNull();
  });

  it("constructs the correct /json/version URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await getCdpVersion("http://127.0.0.1:9222");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9222/json/version",
      expect.any(Object),
    );
  });
});

// ── filterPageTargets ───────────────────────────────────────────────

describe("filterPageTargets", () => {
  const targets: CdpTarget[] = [
    { id: "1", type: "page", title: "Tab 1", url: "https://example.com" },
    { id: "2", type: "background_page", title: "Ext", url: "" },
    { id: "3", type: "service_worker", title: "SW", url: "" },
    { id: "4", type: "page", title: "Tab 2", url: "https://test.com" },
    { id: "5", type: "other", title: "Other", url: "" },
  ];

  it("keeps only page-type targets", () => {
    const result = filterPageTargets(targets);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("1");
    expect(result[1]!.id).toBe("4");
  });

  it("returns empty array for empty input", () => {
    expect(filterPageTargets([])).toEqual([]);
  });

  it("returns empty array when no page targets exist", () => {
    const nonPageTargets: CdpTarget[] = [
      { id: "1", type: "service_worker", title: "", url: "" },
      { id: "2", type: "other", title: "", url: "" },
    ];
    expect(filterPageTargets(nonPageTargets)).toEqual([]);
  });
});

// ── findTargetById ──────────────────────────────────────────────────

describe("findTargetById", () => {
  const targets: CdpTarget[] = [
    { id: "abc", type: "page", title: "First", url: "https://first.com" },
    { id: "def", type: "page", title: "Second", url: "https://second.com" },
    { id: "ghi", type: "other", title: "Third", url: "" },
  ];

  it("finds target by id", () => {
    const result = findTargetById(targets, "def");

    expect(result).toBeDefined();
    expect(result!.title).toBe("Second");
  });

  it("returns undefined when id not found", () => {
    expect(findTargetById(targets, "nonexistent")).toBeUndefined();
  });

  it("returns first match if duplicates exist", () => {
    const dupes: CdpTarget[] = [
      { id: "dup", type: "page", title: "First Dup", url: "" },
      { id: "dup", type: "other", title: "Second Dup", url: "" },
    ];

    const result = findTargetById(dupes, "dup");

    expect(result!.title).toBe("First Dup");
  });

  it("returns undefined for empty targets array", () => {
    expect(findTargetById([], "any")).toBeUndefined();
  });
});
