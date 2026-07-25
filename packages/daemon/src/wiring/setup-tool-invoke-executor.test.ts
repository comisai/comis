// SPDX-License-Identifier: Apache-2.0
/**
 * `createToolInvokeExecutor` — the daemon-side executor for the
 * `{kind:"executor"}` tools: the in-process builtins
 * `read`/`grep`/`find`/`ls`/`jq` (run under the agent's workspace) and the
 * daemon-side `web_search`/`web_fetch` (run on the daemon's network with the
 * DNS-pin — the jail stays `--unshare-net`).
 *
 * Security invariants tested:
 *   - DNS-pin / TOCTOU: the autonomous web path resolves via
 *     `validateUrl` then fetches via `fetchPinned(url, validated.ip)` — the
 *     connection is pinned to the PRE-VALIDATED IP (asserted by capturing the
 *     2nd arg to the mocked fetchPinned). NOT impit, NOT a re-resolving fetch.
 *   - honest-degrade: a `validateUrl` err returns an SSRF-blocked error shape
 *     and NEVER fetches.
 *   - budget seam: a `budgetHook` is called before/around the fetch (no meter).
 *   - ResultRef materialize: an over-threshold return is offloaded to a ResultRef
 *     via the injected `materialize` writer; an under-threshold return is inline.
 *   - workspace scoping: the file builtins run under the agent's
 *     resolved workspace dir (the injected core receives the workspace ctx).
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
// executor MUST use these on the autonomous path, so the test captures
// the IP fetchPinned is pinned to and the body handed to the extractor.
const { fetchPinnedMock, extractMock } = vi.hoisted(() => ({
  fetchPinnedMock: vi.fn(),
  extractMock: vi.fn(),
}));
// `sanitizeMcpToolResult` is a tiny pure NFKC + invisible-strip (the real
// `mcp-result-sanitizer.ts`), replicated inline so the mock does NOT load the
// heavy `@comis/skills/tools` barrel (browser/media/sharp) while still running
// the executor's REAL sanitize→wrap chain — the security-relevant boundary is
// the REAL `wrapExternalContent` from the (partially-real) `@comis/core` mock.
vi.mock("@comis/skills/tools", () => ({
  fetchPinned: fetchPinnedMock,
  extractReadableContent: extractMock,
  sanitizeMcpToolResult: (text: string): string =>
    text.length === 0
      ? ""
      : text
          .normalize("NFKC")
          .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u180E\uFEFF]/g, ""),
}));

import { validateUrl } from "@comis/core";
import { createToolInvokeExecutor } from "./setup-tool-invoke-executor.js";
import type { McpClientManager, McpToolCallResult } from "@comis/skills";

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

const LEASE = { agentId: "agent-7", caps: ["orch:read", "orch:web"] as const, trustLevel: "user" as const };

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    resolveWorkspace: vi.fn((agentId: string) => `/ws/${agentId}`),
    fileExecutors: {
      read: vi.fn(async () => ({ kind: "read", text: "file body" })),
      grep: vi.fn(async () => ({ kind: "grep", matches: [] })),
      find: vi.fn(async () => ({ kind: "find", paths: [] })),
      ls: vi.fn(async () => ({ kind: "ls", entries: [] })),
      jq: vi.fn(async () => ({ kind: "jq", value: 1 })),
      sql: vi.fn(async () => ({ kind: "sql", rows: [] })),
      jsonpath: vi.fn(async () => ({ kind: "jsonpath", value: 1 })),
      write: vi.fn(async () => ({ content: [{ type: "text", text: '{"path":"note.txt","created":true}' }] })),
    },
    webSearch: vi.fn(async () => ({ kind: "search", results: [] })),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  extractMock.mockResolvedValue({ text: "extracted readable text", title: "T" });
});

describe("createToolInvokeExecutor — web_fetch DNS-pin (TOCTOU)", () => {
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

  it("calls the budgetHook seam around the web fetch (no meter)", async () => {
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

describe("createToolInvokeExecutor — ResultRef materialize", () => {
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

  // web_search must be SYMMETRIC with web_fetch — an over-threshold
  // search result has to be offloaded to a ResultRef, otherwise the generated
  // SDK's `wrapResultRef(await invoke("web_search", …))` decorates a NON-ref
  // (no `.ref` field) and the in-jail `.grep/.jq/.read` helpers call
  // `invoke("grep", { path: undefined })` → a missing-path error, AND a large
  // search result re-enters context inline. `RESULT_REF_THRESHOLDS.web_search`
  // (15 KB) already exists for exactly this.
  it("materializes an OVER-threshold web_search return to a ResultRef (symmetric with web_fetch)", async () => {
    const ref = {
      ref: "results/ws-search.json",
      kind: "json" as const,
      bytes: 20_000,
      preview: "[…]",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const materialize = vi.fn(async () => ref);
    // A >15 KB stringified search result → over the web_search threshold.
    const bigResults = { kind: "search", results: Array.from({ length: 400 }, (_v, i) => ({
      title: `result ${i}`,
      url: `https://example.com/${i}`,
      snippet: "x".repeat(40),
    })) };
    const webSearch = vi.fn(async () => bigResults);

    const exec = createToolInvokeExecutor(makeDeps({ materialize, webSearch }));
    const result = await exec("web_search", { query: "comis" }, LEASE);

    expect(materialize).toHaveBeenCalledTimes(1);
    // The materialized payload is the stringified search result, tagged web_search.
    expect(materialize.mock.calls[0][1]).toBe("web_search");
    // The handle (the ResultRef) is what re-enters context — not the big body.
    expect(result).toEqual(ref);
  });

  it("returns an UNDER-threshold web_search return INLINE (no ResultRef)", async () => {
    const materialize = vi.fn(async () => undefined);
    const webSearch = vi.fn(async () => ({ kind: "search", results: [{ title: "one" }] }));

    const exec = createToolInvokeExecutor(makeDeps({ materialize, webSearch }));
    const result = (await exec("web_search", { query: "comis" }, LEASE)) as {
      kind?: string;
    };

    expect(materialize).not.toHaveBeenCalled(); // under threshold → inline
    expect(result.kind).toBe("search");
  });
});

describe("createToolInvokeExecutor — file builtins run workspace-scoped", () => {
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

  it("routes grep/find/ls/jq/sql/jsonpath to their injected cores", async () => {
    const deps = makeDeps();
    const exec = createToolInvokeExecutor(deps);

    await exec("grep", { pattern: "TODO" }, LEASE);
    await exec("find", { glob: "*.ts" }, LEASE);
    await exec("ls", { dir: "." }, LEASE);
    await exec("jq", { ref: "results/x.jsonl", expr: ".[0]" }, LEASE);
    // The sql + jsonpath query cores route through the SAME
    // workspace-scoped file-builtin dispatch as jq (daemon-side, not RPC).
    await exec("sql", { path: "results/x.jsonl", query: "SELECT 1" }, LEASE);
    await exec("jsonpath", { path: "results/x.json", expr: "$.items[0]" }, LEASE);

    expect(deps.fileExecutors.grep).toHaveBeenCalledTimes(1);
    expect(deps.fileExecutors.find).toHaveBeenCalledTimes(1);
    expect(deps.fileExecutors.ls).toHaveBeenCalledTimes(1);
    expect(deps.fileExecutors.jq).toHaveBeenCalledTimes(1);
    expect(deps.fileExecutors.sql).toHaveBeenCalledTimes(1);
    expect(deps.fileExecutors.jsonpath).toHaveBeenCalledTimes(1);
    // The sql core received the agent's resolved workspace ctx (workspace scoping).
    const [, sqlCtx] = deps.fileExecutors.sql.mock.calls[0];
    expect((sqlCtx as { workspaceDir: string }).workspaceDir).toBe("/ws/agent-7");
  });

  it("routes write to the injected workspace-confined write core under the agent's resolved workspace (MUT-01)", async () => {
    // The write tool is the first MUTATING {kind:"executor"} builtin. It rides the
    // SAME workspace-scoped file-builtin dispatch as read/grep (case "write" →
    // executeFileBuiltin("write", …)), so the injected core receives the args plus
    // the lease-resolved workspace ctx — the confinement root. The core itself
    // (safePath confinement + escape-denied) is proven against a real temp
    // workspace in orchestrate-executor-cores.test.ts; here we pin the ROUTING.
    // The write SURFACE must be opted-in (writeSurfaceEnabled) — see the
    // default-off pair below; here it is enabled so the routing is exercised.
    const deps = makeDeps({ writeSurfaceEnabled: () => true });
    const exec = createToolInvokeExecutor(deps);

    await exec(
      "write",
      { path: "note.txt", content: "hi" },
      { ...LEASE, checkpointId: "checkpoint-7" },
    );

    expect(deps.resolveWorkspace).toHaveBeenCalledWith("agent-7");
    expect(deps.fileExecutors.write).toHaveBeenCalledTimes(1);
    const [writeArgs, writeCtx] = deps.fileExecutors.write.mock.calls[0];
    expect(writeArgs).toMatchObject({ path: "note.txt", content: "hi" });
    expect(writeCtx).toMatchObject({ workspaceDir: "/ws/agent-7", runId: "checkpoint-7" });
  });

  it("refuses a write when the validated lease has no run identity", async () => {
    const deps = makeDeps({ writeSurfaceEnabled: () => true });
    const exec = createToolInvokeExecutor(deps);

    const result = (await exec("write", { path: "note.txt", content: "hi" }, LEASE)) as {
      error?: string;
    };

    expect(result.error).toMatch(/run identity/i);
    expect(deps.fileExecutors.write).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // MUT-02 / NG2 — the executor fail-CLOSES when no `writeSurfaceEnabled` predicate
  // is wired (defense-in-depth). orch:write is a FLOOR cap, and the boot wiring
  // now resolves the write surface default-ON (`autonomy.write !== false`, full
  // capability out of the box) — but the EXECUTOR must still deny when the predicate
  // dep is genuinely ABSENT (a mis-wire), mirroring the MCP allowlist's deny-by-
  // absence: a content-free deny that NEVER reaches the core. (Production always
  // wires the predicate; this guards the mis-wire path.)
  // -------------------------------------------------------------------------

  it("DENIES write when NO writeSurfaceEnabled predicate is wired — even though orch:write is held (fail-closed on absent dep)", async () => {
    // No writeSurfaceEnabled dep ⇒ fail-closed (absent ⇒ deny), mirroring the MCP
    // allowlist's deny-by-absence. The lease HOLDS orch:write (the floor cap).
    const deps = makeDeps();
    const exec = createToolInvokeExecutor(deps);

    const result = (await exec(
      "write",
      { path: "note.txt", content: "hi" },
      { agentId: "agent-7", caps: ["orch:read", "orch:web", "orch:write"] as const, trustLevel: "user" as const },
    )) as { error?: string };

    // A content-free, error-SHAPED deny (never a throw) — and the core is NEVER reached.
    expect(result.error).toMatch(/write surface/i);
    expect(deps.fileExecutors.write).not.toHaveBeenCalled();
  });

  it("REACHES the write core once the write surface IS enabled for the agent (opt-in)", async () => {
    const writeSurfaceEnabled = vi.fn(() => true);
    const deps = makeDeps({ writeSurfaceEnabled });
    const exec = createToolInvokeExecutor(deps);

    await exec(
      "write",
      { path: "note.txt", content: "hi" },
      {
        agentId: "agent-7",
        caps: ["orch:read", "orch:write"] as const,
        trustLevel: "user" as const,
        checkpointId: "checkpoint-7",
      },
    );

    // The surface predicate was consulted for THIS lease's agentId, then the core ran.
    expect(writeSurfaceEnabled).toHaveBeenCalledWith("agent-7");
    expect(deps.fileExecutors.write).toHaveBeenCalledTimes(1);
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

// ---------------------------------------------------------------------------
// case "mcp" — the daemon-side MCP dispatch (MCP-01/02/03). The whole path is
// web_fetch with a different daemon-side callee: gate on the per-agent inbound
// allowlist → callTool(qualifyToolName(server,tool)) on the DAEMON's network
// (the jail stays --unshare-net) → sanitize + wrapExternalContent(mcp_tool) →
// shouldMaterialize("mcp") offload. Proven here with a FAKE McpClientManager
// seam; the REAL jailed --unshare-net round-trip is the VPS `.linux` drive (232-07).
// Ground truth: the wrap is the REAL wrapExternalContent output (<<<UNTRUSTED_hex>>>),
// NOT a bare-JSON mock.
// ---------------------------------------------------------------------------
describe("createToolInvokeExecutor — case \"mcp\" (daemon-side MCP dispatch)", () => {
  const MCP_LEASE = { agentId: "agent-7", caps: ["orch:read", "orch:mcp"] as const, trustLevel: "user" as const };

  /** A fake McpClientManager whose ONLY exercised method is callTool (the seam). */
  function fakeMcpManager(callTool: ReturnType<typeof vi.fn>): McpClientManager {
    return { callTool } as unknown as McpClientManager;
  }

  /** An ok Result<McpToolCallResult> with a single text content block. */
  function okMcpResult(text: string, isError = false): { ok: true; value: McpToolCallResult } {
    return { ok: true, value: { content: [{ type: "text", text }], isError } };
  }

  it("DENIES an unlisted {server,tool} via the allowlist and NEVER calls callTool (MCP-02)", async () => {
    const callTool = vi.fn(async () => okMcpResult("should-not-run"));
    const permits = vi.fn(() => false); // unlisted ⇒ deny by absence (232-02 permitsMcpTool)
    const exec = createToolInvokeExecutor(
      makeDeps({ mcpClientManager: fakeMcpManager(callTool), mcpAllowlist: { permits } }),
    );

    const result = (await exec(
      "mcp",
      { server: "ctx7", tool: "search", args: { q: "x" } },
      MCP_LEASE,
    )) as { error?: string };

    expect(result.error).toBeTruthy(); // an error-SHAPED audited deny, not a throw
    expect(permits).toHaveBeenCalledWith("agent-7", "ctx7", "search");
    expect(callTool).not.toHaveBeenCalled(); // the deny short-circuits BEFORE any dispatch
  });

  it("DISPATCHES a permitted call via callTool with the COMPOSED qualified name (MCP-01)", async () => {
    const callTool = vi.fn(async () => okMcpResult("hello from mcp"));
    const exec = createToolInvokeExecutor(
      makeDeps({ mcpClientManager: fakeMcpManager(callTool), mcpAllowlist: { permits: () => true } }),
    );

    await exec("mcp", { server: "ctx7", tool: "search", args: { q: "comis" } }, MCP_LEASE);

    expect(callTool).toHaveBeenCalledTimes(1);
    // The qualified name is COMPOSED "mcp:{server}/{tool}" — NEVER a raw RPC method
    // (no path to mcp.connect / mcp.oauth_login).
    expect(callTool.mock.calls[0][0]).toBe("mcp:ctx7/search");
    expect(callTool.mock.calls[0][1]).toEqual({ q: "comis" });
  });

  it("WRAPS the MCP return as untrusted external content before it re-enters the script (MCP-03, INV-5)", async () => {
    const callTool = vi.fn(async () => okMcpResult("small mcp payload"));
    const exec = createToolInvokeExecutor(
      makeDeps({ mcpClientManager: fakeMcpManager(callTool), mcpAllowlist: { permits: () => true } }),
    );

    const result = (await exec("mcp", { server: "ctx7", tool: "search" }, MCP_LEASE)) as { text?: string };

    // The REAL wrapExternalContent(source:"mcp_tool") delimiter + label — data-not-control.
    expect(result.text).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    expect(result.text).toContain("Source: MCP tool result");
    expect(result.text).toContain("small mcp payload"); // the payload rides INSIDE the wrap
    expect(result.text).not.toBe("small mcp payload"); // NOT the raw payload
  });

  it("falls back to a 'no text content' marker when the MCP result carries ONLY non-text content", async () => {
    // An image/data/embedded-resource-only result: the text-only extraction yields
    // "" — without a fallback the jailed script gets an opaque wrapper around empty
    // with NO signal that content was present but dropped. Mirror the in-process
    // bridge's fallback so an all-non-text result is legible (diagnosability).
    const callTool = vi.fn(async () => ({
      ok: true as const,
      value: {
        content: [{ type: "image", data: "base64-bytes", mimeType: "image/png" }],
        isError: false,
      } as unknown as McpToolCallResult,
    }));
    const exec = createToolInvokeExecutor(
      makeDeps({ mcpClientManager: fakeMcpManager(callTool), mcpAllowlist: { permits: () => true } }),
    );

    const result = (await exec("mcp", { server: "ctx7", tool: "shot" }, MCP_LEASE)) as { text?: string };

    // The honest marker rides INSIDE the untrusted-content wrap (still data-not-control).
    expect(result.text).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    expect(result.text).toContain("no text content");
  });

  it("OFFLOADS an over-threshold (>15 KB) MCP return to a ResultRef handle (MCP-03)", async () => {
    const callTool = vi.fn(async () => okMcpResult("x".repeat(20_000)));
    const ref = {
      ref: "results/mcp-1.text",
      kind: "text" as const,
      bytes: 20_000,
      preview: "xxx",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    const materialize = vi.fn(async () => ref);
    const exec = createToolInvokeExecutor(
      makeDeps({
        mcpClientManager: fakeMcpManager(callTool),
        mcpAllowlist: { permits: () => true },
        materialize,
      }),
    );

    const result = await exec("mcp", { server: "ctx7", tool: "big" }, MCP_LEASE);

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0][1]).toBe("mcp"); // tagged "mcp" (the RESULT_REF_THRESHOLDS key)
    expect(result).toEqual(ref); // the handle re-enters context — NOT the 20 KB body
  });

  it("HONEST-DEGRADES a transport failure to an error-SHAPED result (never throws)", async () => {
    const callTool = vi.fn(async () => ({ ok: false as const, error: new Error("timed out") }));
    const exec = createToolInvokeExecutor(
      makeDeps({ mcpClientManager: fakeMcpManager(callTool), mcpAllowlist: { permits: () => true } }),
    );

    const result = (await exec("mcp", { server: "ctx7", tool: "search" }, MCP_LEASE)) as { error?: string };

    expect(result.error).toMatch(/MCP tool error/i);
  });

  it("HONEST-DEGRADES a tool-level isError result (never throws)", async () => {
    const callTool = vi.fn(async () => okMcpResult("boom", true)); // isError:true
    const exec = createToolInvokeExecutor(
      makeDeps({ mcpClientManager: fakeMcpManager(callTool), mcpAllowlist: { permits: () => true } }),
    );

    const result = (await exec("mcp", { server: "ctx7", tool: "search" }, MCP_LEASE)) as { error?: string };

    expect(result.error).toMatch(/reported an error/i);
  });

  it("honest-degrades to an error when NO mcpClientManager is wired (an un-wired daemon is safe, not crashy)", async () => {
    const exec = createToolInvokeExecutor(makeDeps({ mcpAllowlist: { permits: () => true } }));
    const result = (await exec("mcp", { server: "ctx7", tool: "search" }, MCP_LEASE)) as { error?: string };
    expect(result.error).toMatch(/not available/i);
  });

  it("runs DAEMON-side: the only egress is the injected callTool — the jail stays net-closed (real --unshare-net proof is the VPS .linux drive, 232-07)", async () => {
    const callTool = vi.fn(async () => okMcpResult("ok"));
    const exec = createToolInvokeExecutor(
      makeDeps({ mcpClientManager: fakeMcpManager(callTool), mcpAllowlist: { permits: () => true } }),
    );

    await exec("mcp", { server: "ctx7", tool: "search" }, MCP_LEASE);

    // Structural: the executor dispatches through the DAEMON-side manager (like
    // web_fetch runs on the daemon), and does NOT touch the web-fetch seam nor
    // spawn a jail. The bwrap --unshare-net round-trip is VPS-deferred (232-07).
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(fetchPinnedMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// case "checkpoint" / case "resume" — the durable specialized writing core
// (RESUME-01/05). checkpoint materializes the script-authored state as a
// longer-TTL kind:json ResultRef (the injected `materializeCheckpoint` seam,
// keyed on lease.rootRunId) and stamps ONLY the ref onto the run's durable row
// (upsertCheckpoint, never outward_step). resume reads the last checkpointRef
// back, loads the blob, and returns it WRAPPED (T-WS4-01 data-not-control) — the
// REAL wrapExternalContent(source:"orchestrate_checkpoint"), never eval'd. Both
// are gated by the deny-by-absence `orchestrateResumeEnabled` surface predicate
// (fail-closed) even though orch:write/orch:read are FLOOR caps.
//
// Ground truth: the materialize + load seams here are REAL fs round-trips over a
// per-test temp workspace (not a canned mock), so the wrap is applied to bytes
// that actually hit disk and came back — the mock-store trap the CLAUDE.md
// troubleshooting loop calls out is avoided.
// ---------------------------------------------------------------------------
describe("createToolInvokeExecutor — checkpoint/resume (durable specialized writing core)", () => {
  const RESUME_LEASE = {
    leaseId: "lease-7",
    agentId: "agent-7",
    caps: ["orch:read", "orch:write"] as const,
    sessionKey: "tenant-7:user-7:sub-agent:run-7",
    turnScope: {
      conversation: {
        tenantId: "tenant-7",
        agentId: "agent-7",
        partition: {
          kind: "endpoint-conversation-principal" as const,
          endpoint: {
            channelType: "sub-agent",
            channelInstanceId: "orchestrate",
            conversationId: "run-7",
            conversationKind: "direct" as const,
          },
          principalId: "user-7",
        },
      },
      principal: { principalId: "user-7" },
      endpoint: {
        channelType: "sub-agent",
        channelInstanceId: "orchestrate",
        conversationId: "run-7",
        conversationKind: "direct" as const,
      },
    },
    trustLevel: "admin" as const,
    rootRunId: "root-abc",
    checkpointId: "checkpoint-abc",
  };
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "comis-checkpoint-exec-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  /** REAL-fs materialize + load seams over the temp workspace (mirrors the store's ref shape). */
  function realFsSeams() {
    let seq = 0;
    const materializeCheckpoint = vi.fn(async (stateJson: string) => {
      const rel = `results/ckpt-${seq++}.json`;
      const abs = join(ws, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, stateJson);
      return {
        ref: rel,
        kind: "json" as const,
        bytes: Buffer.byteLength(stateJson, "utf8"),
        preview: stateJson.slice(0, 64),
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
    });
    const loadCheckpoint = vi.fn(async (ref: string) => {
      const abs = join(ws, ref);
      return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    });
    return { materializeCheckpoint, loadCheckpoint };
  }

  /**
   * A faithful in-memory durable-store slice (only upsertCheckpoint + getByCheckpoint are
   * used). COALESCE-preserve on checkpointRef so a partial upsert never clobbers a
   * prior ref (the real SQLite round-trip is proven
   * in durable-run-store.test.ts).
   */
  function memDurableRuns() {
    const rows = new Map<string, Record<string, unknown>>();
    const upsertCheckpoint = vi.fn(async (record: Record<string, unknown>) => {
      const key = record.checkpointId as string;
      const prev = rows.get(key) ?? {};
      rows.set(key, { ...prev, ...record, checkpointRef: record.checkpointRef ?? prev.checkpointRef });
      return { ok: true as const, value: undefined };
    });
    const getByCheckpoint = vi.fn(async (checkpointId: string) => ({
      ok: true as const,
      value: rows.get(checkpointId),
    }));
    return { upsertCheckpoint, getByCheckpoint, rows };
  }

  it("checkpoint persists ONLY checkpointRef on the durable row; resume returns the last state WRAPPED (real fs round-trip)", async () => {
    const { materializeCheckpoint, loadCheckpoint } = realFsSeams();
    const durableRuns = memDurableRuns();
    const durableBudgetState = vi.fn(() => ({
      startedAtMs: 123,
      tokensConsumed: 456,
      usdConsumed: 0.75,
    }));
    const exec = createToolInvokeExecutor(
      makeDeps({
        orchestrateResumeEnabled: () => true,
        materializeCheckpoint,
        loadCheckpoint,
        durableRuns,
        durableBudgetState,
      }),
    );

    const ack = await exec("checkpoint", { step: 3, cursor: "abc" }, RESUME_LEASE);
    expect(ack).toEqual({ ok: true });

    // The script-authored state was serialized to JSON and materialized (real disk).
    expect(materializeCheckpoint).toHaveBeenCalledTimes(1);
    expect(materializeCheckpoint.mock.calls[0][0]).toBe(JSON.stringify({ step: 3, cursor: "abc" }));

    // The durable row carries checkpointRef, keyed on rootRunId, status running.
    expect(durableRuns.upsertCheckpoint).toHaveBeenCalledTimes(1);
    const record = durableRuns.upsertCheckpoint.mock.calls[0][0] as Record<string, unknown>;
    expect(record.checkpointId).toBe("checkpoint-abc");
    expect(record.rootRunId).toBe("root-abc");
    expect(record.tenantId).toBe("tenant-7");
    expect(record.agentId).toBe("agent-7");
    expect(record.principalId).toBe("user-7");
    expect(record.conversationScope).toEqual(RESUME_LEASE.turnScope.conversation);
    expect(record.conversationRef).toMatch(/^cv_/);
    expect(record.checkpointRef).toBe("results/ckpt-0.json");
    expect(record.trustLevel).toBe("admin");
    expect(record.status).toBe("running");
    expect(record.rootBudget).toEqual({
      startedAtMs: 123,
      tokensConsumed: 456,
      usdConsumed: 0.75,
    });
    expect(record.budgetConsumed).toBe(0.75);
    expect(record.scriptRef).toBeNull();
    expect(durableBudgetState).toHaveBeenCalledWith("root-abc");
    // The outward-send ledger is never reset by a checkpoint.
    expect(record).not.toHaveProperty("stepIndex");

    // resume reads the last checkpointRef, loads the REAL bytes, wraps as untrusted DATA.
    const resumed = (await exec("resume", {}, RESUME_LEASE)) as string;
    expect(typeof resumed).toBe("string");
    // The REAL wrapExternalContent boundary marker — data-not-control (T-WS4-01).
    expect(resumed).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    // The state rides INSIDE the wrap, and the return is NOT the bare state (never eval'd).
    expect(resumed).toContain('"step":3');
    expect(resumed).not.toBe(JSON.stringify({ step: 3, cursor: "abc" }));
  });

  it("resume returns null when the run has no prior checkpoint", async () => {
    const { materializeCheckpoint, loadCheckpoint } = realFsSeams();
    const durableRuns = memDurableRuns();
    const exec = createToolInvokeExecutor(
      makeDeps({ orchestrateResumeEnabled: () => true, materializeCheckpoint, loadCheckpoint, durableRuns }),
    );

    const resumed = await exec("resume", {}, RESUME_LEASE);
    expect(resumed).toBeNull();
    expect(loadCheckpoint).not.toHaveBeenCalled(); // no checkpointRef → no blob load
  });

  it("DENIES checkpoint AND resume when the resume surface predicate is ABSENT (fail-closed)", async () => {
    const { materializeCheckpoint, loadCheckpoint } = realFsSeams();
    const durableRuns = memDurableRuns();
    // No orchestrateResumeEnabled dep ⇒ deny by absence (mirrors the write/mcp gates).
    const exec = createToolInvokeExecutor(
      makeDeps({ materializeCheckpoint, loadCheckpoint, durableRuns }),
    );

    const ckDeny = (await exec("checkpoint", { step: 1 }, RESUME_LEASE)) as { error?: string };
    const rsDeny = (await exec("resume", {}, RESUME_LEASE)) as { error?: string };

    // Content-free, error-SHAPED denies (never a throw), and NO dispatch happened.
    expect(ckDeny.error).toMatch(/resume surface/i);
    expect(rsDeny.error).toMatch(/resume surface/i);
    expect(materializeCheckpoint).not.toHaveBeenCalled();
    expect(loadCheckpoint).not.toHaveBeenCalled();
    expect(durableRuns.upsertCheckpoint).not.toHaveBeenCalled();
    expect(durableRuns.getByCheckpoint).not.toHaveBeenCalled();
  });

  it("DENIES both when orchestrateResumeEnabled returns false, consulting the lease agentId", async () => {
    const { materializeCheckpoint, loadCheckpoint } = realFsSeams();
    const durableRuns = memDurableRuns();
    const orchestrateResumeEnabled = vi.fn(() => false);
    const exec = createToolInvokeExecutor(
      makeDeps({ orchestrateResumeEnabled, materializeCheckpoint, loadCheckpoint, durableRuns }),
    );

    const ck = (await exec("checkpoint", { step: 1 }, RESUME_LEASE)) as { error?: string };
    expect(ck.error).toBeTruthy();
    expect(orchestrateResumeEnabled).toHaveBeenCalledWith("agent-7");
    expect(materializeCheckpoint).not.toHaveBeenCalled();
    expect(durableRuns.upsertCheckpoint).not.toHaveBeenCalled();
  });

  it("REFUSES checkpoint (content-free) when the store declines (over the per-file cap) — no durable write", async () => {
    const durableRuns = memDurableRuns();
    const materializeCheckpoint = vi.fn(async () => undefined); // over-cap refuse / failed write
    const exec = createToolInvokeExecutor(
      makeDeps({ orchestrateResumeEnabled: () => true, materializeCheckpoint, durableRuns }),
    );

    const refused = (await exec("checkpoint", { big: "x" }, RESUME_LEASE)) as { error?: string };
    expect(refused.error).toBeTruthy();
    // No ref was minted, so nothing is stamped onto the durable row.
    expect(durableRuns.upsertCheckpoint).not.toHaveBeenCalled();
  });

  it("honest-degrades (no throw) when the lease carries no durable run identity (rootRunId absent)", async () => {
    const { materializeCheckpoint, loadCheckpoint } = realFsSeams();
    const durableRuns = memDurableRuns();
    const exec = createToolInvokeExecutor(
      makeDeps({ orchestrateResumeEnabled: () => true, materializeCheckpoint, loadCheckpoint, durableRuns }),
    );

    // LEASE has no rootRunId — checkpoint cannot key a durable row → content-free error.
    const ck = (await exec("checkpoint", { step: 1 }, LEASE)) as { error?: string };
    expect(ck.error).toBeTruthy();
    expect(materializeCheckpoint).not.toHaveBeenCalled();
  });
});
