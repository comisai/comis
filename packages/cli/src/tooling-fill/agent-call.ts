// SPDX-License-Identifier: Apache-2.0
/**
 * Local-daemon LLM caller for `comis config tooling-fill`.
 *
 * POSTs to http://127.0.0.1:<port>/api/chat with bearer auth, parses the
 * `{response: string}` field of the gateway's chat response, and returns a
 * typed `Result<{response}, AgentCallError>`. No SDK deps — `node:http`
 * only (no axios, no node-fetch).
 *
 * Failure modes (`AgentCallErrorKind`):
 * - `network`     — ECONNREFUSED / ENOTFOUND / EHOSTUNREACH; emits the
 *                   exact operator-facing string "Cannot reach Comis daemon —
 *                   gateway unreachable. Start the daemon and retry."
 * - `auth`        — HTTP 401; "Unauthorized — check COMIS_GATEWAY_TOKEN".
 * - `timeout`     — request exceeded `timeoutMs` (default 30s).
 * - `dependency`  — non-2xx with parseable body (server `error` string),
 *                   or any non-JSON response body.
 * - `validation`  — 2xx but the response JSON has no string `response`
 *                   field (the gateway contract is broken).
 *
 * The token comes from the caller — this module never reads the
 * environment directly. The Commander callback resolves the token via
 * `loadEnvFile` and passes it explicitly (credentials are never read from the environment directly by this module).
 *
 * @module
 */

import * as http from "node:http";
import { ok, err, type Result } from "@comis/shared";

/**
 * Discriminated error kind, drawn from the closed `LogFields.ErrorKind`
 * union in `@comis/infra`. Note the gateway's chat
 * response handler emits "internal" on agent errors — we surface those
 * to the caller as `dependency` (an upstream/external service failure
 * from the CLI's perspective).
 */
export type AgentCallErrorKind =
  | "network"
  | "auth"
  | "dependency"
  | "timeout"
  | "validation";

export interface AgentCallError {
  readonly kind: AgentCallErrorKind;
  /** HTTP status when an HTTP response was received; 0 for network/timeout. */
  readonly status: number;
  readonly message: string;
}

export interface AgentCallArgs {
  readonly port: number;
  readonly token: string;
  readonly prompt: string;
  readonly agentId?: string;
  /** Default 30_000 (30s). */
  readonly timeoutMs?: number;
  /** Default "127.0.0.1". The gateway is localhost-only by design. */
  readonly host?: string;
}

export interface AgentCallResponse {
  readonly response: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Exact operator-facing message — tests assert this literal string. */
const GATEWAY_UNREACHABLE_MSG =
  "Cannot reach Comis daemon — gateway unreachable. Start the daemon and retry.";

/**
 * POST `/api/chat` to the local daemon and parse the `{response}` field.
 *
 * Always resolves a `Result` — never throws. Network
 * errors and timeouts both produce `status: 0` because no HTTP response
 * was received.
 */
export async function callAgent(
  args: AgentCallArgs,
): Promise<Result<AgentCallResponse, AgentCallError>> {
  const host = args.host ?? "127.0.0.1";
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify({
    message: args.prompt,
    ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
  });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (
      r: Result<AgentCallResponse, AgentCallError>,
    ): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const req = http.request(
      {
        host,
        port: args.port,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${args.token}`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;
          if (status === 401) {
            settle(
              err({
                kind: "auth",
                status,
                message: "Unauthorized — check COMIS_GATEWAY_TOKEN",
              }),
            );
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            settle(
              err({
                kind: "dependency",
                status,
                message: "Invalid response body — not JSON",
              }),
            );
            return;
          }
          if (status >= 200 && status < 300) {
            const responseField = (parsed as { response?: unknown }).response;
            if (typeof responseField !== "string") {
              settle(
                err({
                  kind: "validation",
                  status,
                  message: "Response missing 'response' field",
                }),
              );
              return;
            }
            settle(ok({ response: responseField }));
            return;
          }
          // non-2xx with parseable JSON
          const serverErr = (parsed as { error?: unknown }).error;
          const message =
            typeof serverErr === "string" ? serverErr : `HTTP ${status}`;
          settle(err({ kind: "dependency", status, message }));
        });
        res.on("error", (e: Error) => {
          settle(
            err({
              kind: "dependency",
              status: res.statusCode ?? 0,
              message: `Response error: ${e.message}`,
            }),
          );
        });
      },
    );

    req.on("error", (e: NodeJS.ErrnoException) => {
      if (
        e.code === "ECONNREFUSED" ||
        e.code === "ENOTFOUND" ||
        e.code === "EHOSTUNREACH"
      ) {
        settle(
          err({
            kind: "network",
            status: 0,
            message: GATEWAY_UNREACHABLE_MSG,
          }),
        );
        return;
      }
      settle(
        err({
          kind: "network",
          status: 0,
          message: `Network error: ${e.message}`,
        }),
      );
    });

    req.on("timeout", () => {
      req.destroy();
      settle(
        err({
          kind: "timeout",
          status: 0,
          message: `Agent call exceeded ${timeoutMs}ms`,
        }),
      );
    });

    req.write(body);
    req.end();
  });

  // Note: `status` is captured at the moment of an event firing. The
  // server `error` field is surfaced verbatim — never logged elsewhere.
  // The token never appears in error.message; only the bearer header
  // carries it, and that is constructed inline above.
}

// Internal export so tests can assert the exact gateway-unreachable message.
export const __TOOLFILL_GATEWAY_UNREACHABLE_MSG = GATEWAY_UNREACHABLE_MSG;
