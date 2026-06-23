// SPDX-License-Identifier: Apache-2.0
/**
 * `createToolInvokeExecutor` — the daemon-side executor for the
 * `{kind:"executor"}` tools (Gap 1; Phase 212 Plan 02): the in-process builtins
 * `read`/`grep`/`find`/`ls`/`jq` (run under the agent's workspace) and the
 * daemon-side `web_search`/`web_fetch` (run on the daemon's network with the
 * DNS-pin — the jail stays `--unshare-net`).
 *
 * RED-first: written before `setup-tool-invoke-executor.ts` exists, so the
 * import fails and the suite is RED on pre-patch code.
 *
 * Security invariants tested:
 *   - WEB-02 (DNS-pin / TOCTOU): the autonomous web path resolves via
 *     `validateUrl` then fetches via `fetchPinned(url, validated.ip)` — the
 *     connection is pinned to the PRE-VALIDATED IP (asserted by capturing the
 *     2nd arg to the mocked fetchPinned). NOT impit, NOT a re-resolving fetch.
 *   - honest-degrade: a `validateUrl` err returns an SSRF-blocked error shape
 *     and NEVER fetches.
 *   - WEB-01/A7 budget seam: a `budgetHook` is called before/around the fetch
 *     (no meter — that is Phase 213).
 *   - REF (materialize): an over-threshold return is offloaded to a ResultRef
 *     via the injected `materialize` writer; an under-threshold return is inline.
 *   - READ-02 workspace scoping: the file builtins run under the agent's
 *     resolved workspace dir (the injected core receives the workspace ctx).
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ValidatedUrl } from "@comis/core";

// Mock @comis/core's validateUrl (preserve every other export — shouldMaterialize,
// safePath, the ResultRef thresholds all stay REAL so the over/under-threshold
// branch is exercised against the true 15 KB web_fetch threshold).
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return { ...actual, validateUrl: vi.fn() };
});

// Mock the @comis/skills/tools web primitives: fetchPinned (the DNS-pinned undici
// fetch) + extractReadableContent (the fetch-free readability extractor). The
// executor MUST use these on the autonomous path (WEB-02), so the test captures
// the IP fetchPinned is pinned to and the body handed to the extractor.
const { fetchPinnedMock, extractMock } = vi.hoisted(() => ({
  fetchPinnedMock: vi.fn(),
  extractMock: vi.fn(),
}));
vi.mock("@comis/skills/tools", () => ({
  fetchPinned: fetchPinnedMock,
  extractReadableContent: extractMock,
}));

import { validateUrl } from "@comis/core";
import { createToolInvokeExecutor } from "./setup-tool-invoke-executor.js";

const mockValidateUrl = vi.mocked(validateUrl);

function okUrl(over: Partial<ValidatedUrl> = {}): ValidatedUrl {
  return {
    hostname: "example.com",
    ip: "93.184.216.34",
    url: new URL("https://example.com/page"),
    ...over,
  };
}

/** A minimal undici-Response-shaped object the mocked fetchPinned returns. */
function htmlResponse(html: string, status = 200): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/html" }),
    text: async () => html,
  };
}

const LEASE = { agentId: "agent-7", caps: ["orch:read", "orch:web"] as const };

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    resolveWorkspace: vi.fn((agentId: string) => `/ws/${agentId}`),
    fileExecutors: {
      read: vi.fn(async () => ({ kind: "read", text: "file body" })),
      grep: vi.fn(async () => ({ kind: "grep", matches: [] })),
      find: vi.fn(async () => ({ kind: "find", paths: [] })),
      ls: vi.fn(async () => ({ kind: "ls", entries: [] })),
      jq: vi.fn(async () => ({ kind: "jq", value: 1 })),
    },
    webSearch: vi.fn(async () => ({ kind: "search", results: [] })),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  extractMock.mockResolvedValue({ text: "extracted readable text", title: "T" });
});

describe("createToolInvokeExecutor — web_fetch DNS-pin (WEB-02 / TOCTOU)", () => {
  it("resolves via validateUrl then fetches via fetchPinned PINNED to the validated IP", async () => {
    mockValidateUrl.mockResolvedValue({ ok: true, value: okUrl() });
    fetchPinnedMock.mockResolvedValue(htmlResponse("<html><body>hi</body></html>"));

    const exec = createToolInvokeExecutor(makeDeps());
    await exec("web_fetch", { url: "https://example.com/page" }, LEASE);

    // validateUrl ran on the requested URL.
    expect(mockValidateUrl).toHaveBeenCalledWith("https://example.com/page");
    // fetchPinned ran with the URL string + the PRE-VALIDATED IP (the pin).
    expect(fetchPinnedMock).toHaveBeenCalledTimes(1);
    const [pinnedUrl, pinnedIp] = fetchPinnedMock.mock.calls[0];
    expect(pinnedUrl).toBe("https://example.com/page");
    expect(pinnedIp).toBe("93.184.216.34"); // the validated IP — closes the rebind window
  });

  it("returns an SSRF-blocked error and NEVER fetches on a validateUrl failure", async () => {
    mockValidateUrl.mockResolvedValue({ ok: false, error: new Error("loopback range") });

    const exec = createToolInvokeExecutor(makeDeps());
    const result = (await exec("web_fetch", { url: "http://169.254.169.254/" }, LEASE)) as {
      error?: string;
    };

    expect(result.error).toMatch(/SSRF blocked/i);
    expect(fetchPinnedMock).not.toHaveBeenCalled(); // honest-degrade: no fetch attempted
  });

  it("calls the budgetHook seam around the web fetch (WEB-01/A7 — no meter)", async () => {
    mockValidateUrl.mockResolvedValue({ ok: true, value: okUrl() });
    fetchPinnedMock.mockResolvedValue(htmlResponse("<html>ok</html>"));
    const budgetHook = vi.fn();

    const exec = createToolInvokeExecutor(makeDeps({ budgetHook }));
    await exec("web_fetch", { url: "https://example.com/page" }, LEASE);

    expect(budgetHook).toHaveBeenCalledTimes(1);
    expect(budgetHook.mock.calls[0][0]).toMatchObject({ tool: "web_fetch" });
  });

  it("does NOT use impit on the autonomous path (the in-process tool keeps impit; this one is pinned undici)", async () => {
    // Belt-and-suspenders: the only fetch seam wired is fetchPinned. If the
    // executor regressed to the impit web-fetch tool, fetchPinned would not be
    // called. (The static `grep -c impit === 0` acceptance pins the source.)
    mockValidateUrl.mockResolvedValue({ ok: true, value: okUrl() });
    fetchPinnedMock.mockResolvedValue(htmlResponse("<html>ok</html>"));

    const exec = createToolInvokeExecutor(makeDeps());
    await exec("web_fetch", { url: "https://example.com/page" }, LEASE);

    expect(fetchPinnedMock).toHaveBeenCalled();
  });
});

describe("createToolInvokeExecutor — ResultRef materialize (REF-01)", () => {
  it("materializes an OVER-threshold web_fetch return to a ResultRef", async () => {
    mockValidateUrl.mockResolvedValue({ ok: true, value: okUrl() });
    fetchPinnedMock.mockResolvedValue(htmlResponse("<html>big</html>"));
    // 20 KB extracted text > the real 15 KB web_fetch threshold → materialize.
    extractMock.mockResolvedValue({ text: "x".repeat(20_000), title: "Big" });

    const ref = {
      ref: "results/ws-1.html",
      kind: "html" as const,
      bytes: 20_000,
      preview: "xxx",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const materialize = vi.fn(async () => ref);

    const exec = createToolInvokeExecutor(makeDeps({ materialize }));
    const result = await exec("web_fetch", { url: "https://example.com/page" }, LEASE);

    expect(materialize).toHaveBeenCalledTimes(1);
    // The ResultRef (the handle) is what re-enters context — not the 20 KB body.
    expect(result).toEqual(ref);
  });

  it("returns an UNDER-threshold web_fetch return INLINE (no ResultRef)", async () => {
    mockValidateUrl.mockResolvedValue({ ok: true, value: okUrl() });
    fetchPinnedMock.mockResolvedValue(htmlResponse("<html>small</html>"));
    extractMock.mockResolvedValue({ text: "small body", title: "S" });
    const materialize = vi.fn(async () => undefined);

    const exec = createToolInvokeExecutor(makeDeps({ materialize }));
    const result = (await exec("web_fetch", { url: "https://example.com/page" }, LEASE)) as {
      text?: string;
    };

    expect(materialize).not.toHaveBeenCalled(); // under threshold → never materialized
    expect(result.text).toBe("small body"); // inline
  });
});

describe("createToolInvokeExecutor — file builtins run workspace-scoped (READ-02)", () => {
  it("dispatches read to the injected core under the agent's resolved workspace", async () => {
    const deps = makeDeps();
    const exec = createToolInvokeExecutor(deps);

    await exec("read", { path: "notes.md", offset: 10, limit: 50 }, LEASE);

    // The workspace resolver was consulted for THIS lease's agentId.
    expect(deps.resolveWorkspace).toHaveBeenCalledWith("agent-7");
    // The read core ran with the args + a ctx carrying the resolved workspace dir.
    expect(deps.fileExecutors.read).toHaveBeenCalledTimes(1);
    const [calledArgs, ctx] = deps.fileExecutors.read.mock.calls[0];
    expect(calledArgs).toMatchObject({ path: "notes.md", offset: 10, limit: 50 });
    expect((ctx as { workspaceDir: string }).workspaceDir).toBe("/ws/agent-7");
  });

  it("routes grep/find/ls/jq to their injected cores", async () => {
    const deps = makeDeps();
    const exec = createToolInvokeExecutor(deps);

    await exec("grep", { pattern: "TODO" }, LEASE);
    await exec("find", { glob: "*.ts" }, LEASE);
    await exec("ls", { dir: "." }, LEASE);
    await exec("jq", { ref: "results/x.jsonl", expr: ".[0]" }, LEASE);

    expect(deps.fileExecutors.grep).toHaveBeenCalledTimes(1);
    expect(deps.fileExecutors.find).toHaveBeenCalledTimes(1);
    expect(deps.fileExecutors.ls).toHaveBeenCalledTimes(1);
    expect(deps.fileExecutors.jq).toHaveBeenCalledTimes(1);
  });

  it("routes web_search to the injected daemon-side search core", async () => {
    const deps = makeDeps();
    const exec = createToolInvokeExecutor(deps);

    await exec("web_search", { query: "comis" }, LEASE);

    expect(deps.webSearch).toHaveBeenCalledTimes(1);
    const [searchArgs] = deps.webSearch.mock.calls[0];
    expect(searchArgs).toMatchObject({ query: "comis" });
  });

  it("rejects an unknown executor tool (the dispatch allow-list is the gate, but the executor is defensive)", async () => {
    const exec = createToolInvokeExecutor(makeDeps());
    await expect(exec("not_a_tool", {}, LEASE)).rejects.toThrow();
  });
});
