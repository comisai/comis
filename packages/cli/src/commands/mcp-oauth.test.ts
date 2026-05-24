// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the `comis mcp login` / `comis mcp logout` CLI subcommands
 * (Phase 66 OAUTH-10 / 66g — the CLI half of the operator-initiated login loop).
 *
 * The daemon-side `mcp.oauth_login` RPC returns `{ status, authUrl?,
 * portForwardHint? }`; the CLI is where `open` actually runs (resolved_scope
 * #1). These tests pin the four behaviors that carry a defined contract:
 *
 *   1. login authorized (no authUrl) → success message, exit 0, NO open() call.
 *   2. login with authUrl → the injected `open` spy is called ONCE with the URL.
 *   3. login headless_hint → the CLI PRINTS portForwardHint + authUrl, NO open().
 *   4. login failure (status:"failed" OR callTyped rejects) → error() + exit 1
 *      (the Phase 65 anti-pattern guard — commander would otherwise exit 0).
 *   5. logout cleared:true → confirmation, exit 0; cleared:false → exit 0 with
 *      an informative message.
 *   6. ensureGatewayToken ordering — a missing token throws BEFORE withClient
 *      opens a socket (T-66-28; mirrors the Phase 65 mcp.test ordering guard).
 *
 * Harness: `withClient` + `callTyped` are mocked (importOriginal) so no socket
 * opens; `open` is mocked to a no-op default export so no browser launches.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import {
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// ---------------------------------------------------------------------------
// Module-level mocks (ESM hoisting — declared before the SUT import).
// ---------------------------------------------------------------------------

// importOriginal so the un-mocked exports (ensureGatewayToken et al.) stay real
// while withClient + callTyped are scripted per-test.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(),
    callTyped: vi.fn(),
  };
});

// withSpinner must run its thunk synchronously (no real spinner) so the
// action body executes inside parseAsync.
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// The `open` package — default export. Mock to a no-op so an attempted browser
// launch is observable (spy) but never actually opens a browser.
vi.mock("open", () => ({ default: vi.fn() }));

// ---------------------------------------------------------------------------
// SUT + mocked-module references (dynamic import AFTER mocks).
// ---------------------------------------------------------------------------

const { registerMcpOauth } = await import("./mcp-oauth.js");
const { registerMcpCommand } = await import("./mcp.js");
const { withClient, callTyped } = await import("../client/rpc-client.js");
const open = (await import("open")).default;

/**
 * Build a program with ONLY the oauth subcommands wired so the action bodies
 * are reachable via parseAsync(["node","test","mcp","login",...]).
 */
function buildProgram(): Command {
  const program = new Command();
  const mcp = program.command("mcp").description("MCP server management");
  registerMcpOauth(mcp);
  return program;
}

/**
 * Make `withClient` invoke its callback with a sentinel client so the action
 * reaches `callTyped`. Returns the sentinel for entry assertions.
 */
function wireWithClient(): { entered: () => boolean } {
  let didEnter = false;
  vi.mocked(withClient).mockImplementation(async (fn) => {
    didEnter = true;
    return fn({} as never);
  });
  return { entered: () => didEnter };
}

describe("registerMcpOauth — subcommand registration", () => {
  it("registers login and logout under the mcp command group", () => {
    const program = buildProgram();
    const mcp = program.commands.find((c) => c.name() === "mcp");
    expect(mcp).toBeDefined();
    const names = mcp!.commands.map((c) => c.name());
    expect(names).toContain("login");
    expect(names).toContain("logout");
  });

  it("registerMcpCommand wires login/logout alongside the Phase 65 subcommands", () => {
    const program = new Command();
    registerMcpCommand(program);
    const mcp = program.commands.find((c) => c.name() === "mcp");
    const names = mcp!.commands.map((c) => c.name());
    for (const n of ["list", "status", "test", "login", "logout"]) {
      expect(names).toContain(n);
    }
  });
});

describe("mcp login — open-vs-hint branching + exit codes", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(callTyped).mockReset();
    vi.mocked(open).mockReset();
    process.env["COMIS_GATEWAY_TOKEN"] = "test-token"; // skip the miss path here
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    delete process.env["COMIS_GATEWAY_TOKEN"];
  });

  it("Test 1: authorized with no authUrl → success, exit 0, does NOT open()", async () => {
    wireWithClient();
    vi.mocked(callTyped).mockResolvedValue({
      server_name: "notion",
      status: "authorized",
    } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "login", "notion"]);

    expect(open).not.toHaveBeenCalled();
    expect(exitSpy.spy).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toMatch(/notion/);
  });

  it("Test 2: CR-02: authorized with authUrl → does NOT call open() (URL state is spent)", async () => {
    // CR-02: When the daemon returns `status: "authorized"`, the token
    // exchange already completed server-side and the tokens are persisted —
    // `runOauthLogin` finished the second auth() call and the loopback
    // callback server is closed. The `authUrl` in the response is the
    // authorization URL built during the FIRST auth() pass; its `state`
    // parameter is spent (already used + consumed by the closed callback
    // server). Opening it now navigates the operator to a confusing
    // provider error page ("invalid_state" / "code already used") AND
    // exposes the spent state value to the browser's URL bar/history for
    // no benefit.
    //
    // The browser was already opened at the correct moment in the
    // non-headless branch of `runOauthLogin` (login.ts:openUrl(authUrl)
    // before waitForCode). The CLI's second open() on the "authorized"
    // response was redundant + misleading; the fix is to print success
    // only, no open().
    wireWithClient();
    const authUrl = "https://provider.example/authorize?client_id=abc&state=xyz";
    vi.mocked(callTyped).mockResolvedValue({
      server_name: "notion",
      status: "authorized",
      authUrl,
    } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "login", "notion"]);

    // The CLI must NOT open the (spent) authUrl on the authorized status.
    expect(open).not.toHaveBeenCalled();
    expect(exitSpy.spy).not.toHaveBeenCalled();
    // A success message is still printed (status:"authorized" is the success
    // surface — tokens are persisted, the server is reconnected).
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toMatch(/notion/);
  });

  it("Test 3: headless_hint → prints portForwardHint + authUrl, does NOT open()", async () => {
    wireWithClient();
    const portForwardHint = "ssh -L 5000:localhost:5000 vps";
    const authUrl = "https://provider.example/authorize?client_id=abc&state=xyz";
    vi.mocked(callTyped).mockResolvedValue({
      server_name: "notion",
      status: "headless_hint",
      portForwardHint,
      authUrl,
    } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "login", "notion"]);

    expect(open).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain(portForwardHint);
    expect(out).toContain(authUrl);
    expect(exitSpy.spy).not.toHaveBeenCalled();
  });

  it("Test 4a: status:\"failed\" → error() + exit 1 (commander anti-pattern guard)", async () => {
    wireWithClient();
    vi.mocked(callTyped).mockResolvedValue({
      server_name: "notion",
      status: "failed",
    } as never);

    const program = buildProgram();
    try {
      await program.parseAsync(["node", "test", "mcp", "login", "notion"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(open).not.toHaveBeenCalled();
    const err = getSpyOutput(consoleSpy.error);
    expect(err).toMatch(/notion/);
  });

  it("Test 4b: callTyped rejects → error() + exit 1", async () => {
    wireWithClient();
    vi.mocked(callTyped).mockRejectedValue(new Error("RPC connection failed"));

    const program = buildProgram();
    try {
      await program.parseAsync(["node", "test", "mcp", "login", "notion"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const err = getSpyOutput(consoleSpy.error);
    expect(err).toContain("RPC connection failed");
  });
});

describe("mcp logout", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(callTyped).mockReset();
    process.env["COMIS_GATEWAY_TOKEN"] = "test-token";
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
    delete process.env["COMIS_GATEWAY_TOKEN"];
  });

  it("Test 5a: cleared:true → confirmation, exit 0", async () => {
    wireWithClient();
    vi.mocked(callTyped).mockResolvedValue({
      server_name: "notion",
      cleared: true,
    } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "logout", "notion"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toMatch(/notion/);
  });

  it("Test 5b: cleared:false → exit 0 with an informative message", async () => {
    wireWithClient();
    vi.mocked(callTyped).mockResolvedValue({
      server_name: "notion",
      cleared: false,
    } as never);

    const program = buildProgram();
    await program.parseAsync(["node", "test", "mcp", "logout", "notion"]);

    expect(exitSpy.spy).not.toHaveBeenCalled();
    // Either log or info (stdout) carries the no-tokens message.
    const out = `${getSpyOutput(consoleSpy.log)}`;
    expect(out).toMatch(/notion/);
  });
});

describe("mcp login/logout — ensureGatewayToken ordering (T-66-28)", () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedToken: string | undefined;
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(async () => {
    // Point HOME at a fresh dir with NO .comis/.env so the token cannot be
    // resolved — ensureGatewayToken must throw BEFORE withClient is entered.
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    savedHome = process.env["HOME"];
    savedToken = process.env["COMIS_GATEWAY_TOKEN"];
    tmpHome = mkdtempSync(join(tmpdir(), "comis-mcp-oauth-test-"));
    process.env["HOME"] = tmpHome;
    delete process.env["COMIS_GATEWAY_TOKEN"];
    vi.mocked(withClient).mockReset();
    vi.mocked(callTyped).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedToken === undefined) delete process.env["COMIS_GATEWAY_TOKEN"];
    else process.env["COMIS_GATEWAY_TOKEN"] = savedToken;
    consoleSpy.restore();
    exitSpy.restore();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("Test 6: missing token → exit 1 and withClient NEVER entered", async () => {
    const wc = wireWithClient();

    const program = buildProgram();
    try {
      await program.parseAsync(["node", "test", "mcp", "login", "notion"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(wc.entered()).toBe(false);
    expect(vi.mocked(withClient)).not.toHaveBeenCalled();
    const err = getSpyOutput(consoleSpy.error);
    expect(err).toContain("COMIS_GATEWAY_TOKEN");
  });
});
