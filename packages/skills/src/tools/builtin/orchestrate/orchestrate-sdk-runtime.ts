// SPDX-License-Identifier: Apache-2.0
/**
 * `orchestrate-sdk-runtime` — the cap-socket CLIENT the in-jail autonomy surface
 * speaks. {@link callCapSocket} is the generalized wire primitive: one
 * `{ bearer, method, params }` newline-JSON line over the lease-authenticated
 * unix cap socket for an ARBITRARY method, resolving the `{ result }` (or
 * rejecting the `{ error }`). {@link invoke} is its `tool.invoke` specialization
 * — the stable `./orchestrate-sdk-runtime.js` contract the generated
 * `comis_tools.js` imports (`invoke` + `wrapResultRef`), where each typed SDK
 * method delegates to {@link invoke}. `comis-agent`'s direct-method subcommands
 * (CLI-04) ride {@link callCapSocket} directly so they can dispatch a non-tool
 * method (`session.spawn`, `graph.execute`, …) without the `tool.invoke`
 * envelope. Both speak the exact wire the Phase-211 capability endpoint serves
 * (`setup-capability-endpoint.ts` — one `{ bearer, method, params }` line per
 * connection → one `{ result }` / `{ error }` line back).
 *
 * Containment context (why this is tiny + dependency-free, AGENTS.md §2.3): this
 * module runs INSIDE the orchestrate jail (`--unshare-net`, `~/.comis` masked).
 * The cap socket bound into the jail is the ONLY reachable egress; the lease
 * (`COMIS_CAP_LEASE`) authenticates every call, audience-bound at the endpoint.
 * So the runtime needs nothing but `node:net` + JSON — there is deliberately NO
 * WebSocket / gateway client: that loopback gateway transport is unreachable
 * from the `--unshare-net` jail and is the very wire CLI-04 forbids.
 *
 * Globals rule (AGENTS.md §2.2): this runtime executes INSIDE the jail, which has
 * NO `node_modules` — so it MUST be self-contained (node built-ins only). It
 * therefore reads the two lease env vars via a local `process.env` accessor rather
 * than importing `@comis/core`'s `systemGetEnv` seam: that import is unreachable
 * from the jail and would make EVERY `comis_tools` import fail `ERR_MODULE_NOT_FOUND`
 * (live VPS finding 2026-06-23 — guarded by `orchestrate-sdk-self-contained.test.ts`).
 *
 * @module
 */
import * as net from "node:net";

// Type-only import — fully erased at build, so the emitted .js carries NO @comis/*
// reference (the jail cannot resolve one). The value half (systemGetEnv) is inlined below.
import type { ResultRef } from "@comis/core";

/**
 * Read an env var inside the jail. Inlined (not `@comis/core`'s `systemGetEnv`)
 * because the jailed runtime has no `node_modules` to resolve it from; `process.env`
 * is the only env access available here.
 */
// eslint-disable-next-line no-restricted-syntax -- jailed runtime: process.env is the sole env source (no @comis/core seam reachable in the jail)
const systemGetEnv = (name: string): string | undefined => process.env[name];

/** The method the runtime always sends — the one-route dispatch (v8 §6.2). */
const TOOL_INVOKE_METHOD = "tool.invoke" as const;

/** The lease env var the cap socket authenticates each call with. */
const ENV_CAP_LEASE = "COMIS_CAP_LEASE";
/** The unix-socket path the cap endpoint listens on (bound into the jail). */
const ENV_ORCH_SOCKET = "COMIS_ORCH_SOCKET";

/**
 * The wire reply shape: exactly one of `result` / `error` is present (the
 * endpoint emits `{ result }` on success, `{ error }` on any deny/failure).
 */
interface CapReply {
  result?: unknown;
  error?: unknown;
}

/**
 * A ResultRef decorated with the §23.9 in-jail extraction helpers (REF-02). The
 * big (untrusted) payload stays materialized on the jailed workspace as DATA;
 * these helpers slice it IN-JAIL via the `orch:read`-gated read/grep/jq tools so
 * only the relevant rows/lines re-enter context — the full payload never does.
 */
export interface WrappedResultRef extends ResultRef {
  /** Grep the materialized file for `pattern`; returns the matching lines (orch:read). */
  grep(pattern: string): Promise<string>;
  /** Run a jq `expr` over the materialized JSON/JSONL; returns the result (orch:read). */
  jq(expr: string): Promise<unknown>;
  /** Read a bounded slice of the materialized file (`offset`/`limit`) (orch:read). */
  read(offset?: number, limit?: number): Promise<string>;
}

/**
 * Send one `{ bearer, method, params }` line over the cap socket for an ARBITRARY
 * method and resolve with the `{ result }` (or reject with the `{ error }`). One
 * connection per call mirrors the endpoint's per-connection request/response
 * framing exactly. The `method` and `params` are passed THROUGH verbatim — the
 * caller decides whether it is a `tool.invoke` (see {@link invoke}) or a direct
 * orchestration method (`session.spawn`, `graph.execute`, `cron.add`, …, the
 * `comis-agent` CLI-04 subcommands). The lease (`COMIS_CAP_LEASE`) authenticates
 * every call; the unix cap socket (`COMIS_ORCH_SOCKET`) is the only egress — this
 * is deliberately NOT the loopback gateway WebSocket (the wire CLI-04 forbids).
 *
 * @param method - The wire method (e.g. `"tool.invoke"`, `"session.spawn"`).
 * @param params - The method params, forwarded verbatim (no envelope wrapping).
 * @returns The endpoint's `result` field.
 * @throws When the lease env is absent (only valid inside an orchestrate jail),
 *   when the endpoint replies `{ error }`, or when the reply line is malformed /
 *   the connection closes before a complete reply (a containment fault).
 */
export function callCapSocket(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const socketPath = systemGetEnv(ENV_ORCH_SOCKET);
  const bearer = systemGetEnv(ENV_CAP_LEASE);
  if (!socketPath || !bearer) {
    return Promise.reject(
      new Error(
        `comis-agent / orchestrate runtime requires ${ENV_ORCH_SOCKET}/${ENV_CAP_LEASE} — ` +
          `only valid inside an orchestrate jail`,
      ),
    );
  }

  const payload = JSON.stringify({ bearer, method, params }) + "\n";

  return new Promise<unknown>((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buf = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      let reply: CapReply;
      try {
        reply = JSON.parse(line) as CapReply;
      } catch {
        finish(() => reject(new Error(`malformed response from cap socket: ${line.slice(0, 120)}`)));
        return;
      }
      if (reply.error !== undefined) {
        const message =
          typeof reply.error === "string" ? reply.error : "capability call failed";
        finish(() => reject(new Error(message)));
        return;
      }
      finish(() => resolve(reply.result));
    });
    socket.on("error", (err: Error) => {
      finish(() => reject(err));
    });
    // The endpoint `socket.end()`s after the reply line. If it closes without a
    // newline-terminated reply, surface a malformed/empty-response error rather
    // than hanging (a closed connection mid-protocol is a containment fault).
    socket.on("close", () => {
      finish(() => reject(new Error("cap socket closed before a complete response line")));
    });
  });
}

/**
 * Send one `{ bearer, method: "tool.invoke", params: { tool, args } }` line over
 * the cap socket and resolve with the `{ result }`. This is the `tool.invoke`
 * specialization of {@link callCapSocket} — the stable contract the generated
 * `comis_tools.js` imports; every typed SDK method delegates here.
 *
 * @param tool - The capability-mapped tool name (e.g. `"memory_search"`).
 * @param args - The tool's arguments (forwarded verbatim as `params.args`).
 * @returns The tool result (the endpoint's `result` field).
 * @throws When the lease env is absent (only valid inside an orchestrate jail),
 *   when the endpoint replies `{ error }`, or when the reply line is malformed.
 */
export function invoke(tool: string, args?: Record<string, unknown>): Promise<unknown> {
  return callCapSocket(TOOL_INVOKE_METHOD, { tool, args: args ?? {} });
}

/**
 * Decorate a {@link ResultRef} with the in-jail extraction helpers (REF-02). The
 * generated SDK calls this for the high-volume tool returns; the helpers route
 * through {@link invoke} to the `orch:read`-gated read/grep/jq tools over the
 * materialized `results/` file, so only the requested slice re-enters context.
 *
 * @param ref - The materialized result handle (from a tool return).
 * @returns The same handle plus `.read`/`.grep`/`.jq` extraction methods.
 */
export function wrapResultRef(ref: ResultRef): WrappedResultRef {
  return {
    ...ref,
    grep(pattern: string): Promise<string> {
      return invoke("grep", { path: ref.ref, pattern }) as Promise<string>;
    },
    jq(expr: string): Promise<unknown> {
      return invoke("jq", { path: ref.ref, expr });
    },
    read(offset?: number, limit?: number): Promise<string> {
      return invoke("read", { path: ref.ref, offset, limit }) as Promise<string>;
    },
  };
}
