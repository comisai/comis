// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `runComisAgent` (the in-jail `comis-agent`
 * argv→one-cap-socket-call parser + dispatch).
 *
 * Drives the parser over a FAKE `callCapSocket` (no real socket): asserts each
 * subcommand resolves to exactly one call — a `{kind:"tool"}` subcommand rides
 * `tool.invoke`, a `{kind:"method"}` subcommand sends the DIRECT method — that
 * `status list` aliases to `session.list`, that an unknown/admin/`skill` verb
 * exits non-zero WITHOUT touching the socket, and that a missing-lease reject
 * (the real primitive's loud-fail) surfaces as a non-zero exit + loud stderr
 * A final source-grep test pins the dependency-free / no-WebSocket
 * containment (AGENTS.md §2.3).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runComisAgent } from "./comis-agent-cli.js";

const here = dirname(fileURLToPath(import.meta.url));

/** A captured (method, params) the fake callCapSocket recorded. */
interface Captured {
  method: string;
  params: Record<string, unknown>;
}

/**
 * Build a test harness: a fake callCapSocket that records every call (and
 * resolves a fixed result, or rejects with a supplied error), plus captured
 * stdout/stderr buffers and the resolved exit code.
 */
function harness(opts?: { reject?: Error; result?: unknown }) {
  const calls: Captured[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const callCapSocket = vi.fn(
    (method: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, params });
      if (opts?.reject) return Promise.reject(opts.reject);
      return Promise.resolve(opts?.result ?? { ok: true });
    },
  );
  const deps = {
    callCapSocket,
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
  };
  return { calls, out, err, callCapSocket, deps };
}

describe("runComisAgent", () => {
  it("rides tool.invoke for a {kind:'tool'} subcommand (read --path …)", async () => {
    const h = harness();
    const code = await runComisAgent(["read", "--path", "/w/x.txt"], h.deps);
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({
      method: "tool.invoke",
      params: { tool: "read", args: { path: "/w/x.txt" } },
    });
  });

  it("sends the DIRECT method (not tool.invoke) for a {kind:'method'} subcommand (spawn …)", async () => {
    const h = harness();
    const code = await runComisAgent(
      ["spawn", "do the thing", "--async", "--worktree"],
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({
      method: "session.spawn",
      params: { task: "do the thing", async: true, worktree: true },
    });
  });

  it("maps send --to <peer> <message> → message.send { to, message }", async () => {
    const h = harness();
    const code = await runComisAgent(["send", "--to", "peer", "hello"], h.deps);
    expect(code).toBe(0);
    expect(h.calls[0]).toEqual({
      method: "message.send",
      params: { to: "peer", message: "hello" },
    });
  });

  it("maps run <graphId> → graph.execute, schedule <spec> → cron.add", async () => {
    const h = harness();
    await runComisAgent(["run", "my-graph"], h.deps);
    expect(h.calls[0].method).toBe("graph.execute");
    const h2 = harness();
    await runComisAgent(["schedule", "0 9 * * *", "--task", "standup"], h2.deps);
    expect(h2.calls[0].method).toBe("cron.add");
  });

  it("maps whoami --caps → capabilities.introspect", async () => {
    const h = harness();
    const code = await runComisAgent(["whoami", "--caps"], h.deps);
    expect(code).toBe(0);
    expect(h.calls[0].method).toBe("capabilities.introspect");
  });

  it("aliases the two-token `status list` → session.list (the list entry)", async () => {
    const h = harness();
    const code = await runComisAgent(["status", "list"], h.deps);
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({ method: "session.list", params: {} });
  });

  it("maps `status <runId>` → session.status (a single-token status)", async () => {
    const h = harness();
    const code = await runComisAgent(["status", "run-123"], h.deps);
    expect(code).toBe(0);
    expect(h.calls[0].method).toBe("session.status");
    // run-123 reached the params (as the run/session id positional).
    expect(JSON.stringify(h.calls[0].params)).toContain("run-123");
  });

  it("rejects `skill` as an absent verb — exits non-zero, NEVER calls the socket", async () => {
    const h = harness();
    const code = await runComisAgent(["skill", "create", "x"], h.deps);
    expect(code).not.toBe(0);
    expect(h.callCapSocket).not.toHaveBeenCalled();
    expect(h.err.join("")).toMatch(/no such subcommand/i);
  });

  it("rejects an unknown/admin verb (secrets/config/tokens) — exits non-zero, no socket call", async () => {
    for (const verb of ["secrets", "config", "tokens", "bogus"]) {
      const h = harness();
      const code = await runComisAgent([verb, "whatever"], h.deps);
      expect(code, `${verb} must exit non-zero`).not.toBe(0);
      expect(h.callCapSocket, `${verb} must not call the socket`).not.toHaveBeenCalled();
    }
  });

  it("exits non-zero with no subcommand at all (empty argv)", async () => {
    const h = harness();
    const code = await runComisAgent([], h.deps);
    expect(code).not.toBe(0);
    expect(h.callCapSocket).not.toHaveBeenCalled();
  });

  it("loud-fails (non-zero + stderr naming the env + jail) when callCapSocket rejects with the missing-lease error", async () => {
    const h = harness({
      reject: new Error(
        "comis-agent / orchestrate runtime requires COMIS_ORCH_SOCKET/COMIS_CAP_LEASE — only valid inside an orchestrate jail",
      ),
    });
    const code = await runComisAgent(["whoami"], h.deps);
    expect(code).not.toBe(0);
    const stderr = h.err.join("");
    expect(stderr).toMatch(/COMIS_ORCH_SOCKET|COMIS_CAP_LEASE/);
    expect(stderr).toMatch(/jail/i);
  });

  it("surfaces a content-free denial message on stderr without echoing the lease/socket", async () => {
    const h = harness({ reject: new Error("capability denied") });
    const code = await runComisAgent(["spawn", "task"], h.deps);
    expect(code).not.toBe(0);
    const stderr = h.err.join("");
    expect(stderr).toContain("capability denied");
    expect(stderr).not.toMatch(/COMIS_CAP_LEASE=|bearer/i);
  });

  it("prints the result to stdout on success", async () => {
    const h = harness({ result: { runId: "r-9" } });
    await runComisAgent(["spawn", "task"], h.deps);
    expect(h.out.join("")).toContain("r-9");
  });
});

describe("comis-agent-cli containment (dependency-free, no forbidden WebSocket wire)", () => {
  const cliSrc = readFileSync(resolve(here, "comis-agent-cli.ts"), "utf8");
  const entrySrc = readFileSync(resolve(here, "comis-agent-entry.ts"), "utf8");

  it("imports callCapSocket from the runtime + CLI_SUBCOMMAND_MAP from @comis/core ONLY", () => {
    expect(cliSrc).toMatch(/CLI_SUBCOMMAND_MAP/);
    expect(cliSrc).toMatch(/orchestrate-sdk-runtime/);
  });

  it("imports no WebSocket / gateway / commander (the forbidden weaker wire)", () => {
    for (const src of [cliSrc, entrySrc]) {
      expect(src).not.toMatch(/ws:\/\//);
      expect(src).not.toMatch(/from\s+["']ws["']/);
      expect(src).not.toMatch(/withClient/);
      expect(src).not.toMatch(/callTyped/);
      expect(src).not.toMatch(/commander/);
      expect(src).not.toMatch(/rpc-client/);
    }
  });

  it("the entrypoint is a #!/usr/bin/env node binary wiring the real callCapSocket", () => {
    expect(entrySrc.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(entrySrc).toMatch(/runComisAgent/);
    expect(entrySrc).toMatch(/callCapSocket/);
  });
});
