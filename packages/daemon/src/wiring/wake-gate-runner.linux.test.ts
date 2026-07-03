// SPDX-License-Identifier: Apache-2.0
/**
 * (Linux/VPS) real-jail acceptance for the pre-payload wake-gate runner. Mirrors
 * `orchestrate-jail.linux.test.ts` — drives the GENUINE {@link createWakeGateRunner}
 * end-to-end against a real `bwrap` jail + a cap-socket server (the newline-JSON
 * wire the capability endpoint speaks), proving on the production Linux host class
 * that:
 *   - a gate that `web_fetch`es a URL and prints `{"wake":false}` resolves to
 *     `{ wake: false }` — the acceptance IS the verdict; the no-model-turn wiring
 *     on a skip is covered by the macOS hook test (setup-schedulers.test.ts).
 *   - a gate whose script needs `orch:web`, run on an agent whose `web` surface is
 *     OFF, is DENIED at the cap gate — the bound is the minted lease's caps, NOT
 *     the job's tool policy; a denied fetch fails OPEN to wake (never a silent skip).
 *   - a host that cannot jail (`namespacePreflightOk: false`) degrades to
 *     `{ runAsToday: true }` — no lease minted, no jailed run.
 *
 * It MUST compile cleanly on macOS (`tsc --noEmit` passes) but the whole describe
 * block SKIPS on non-Linux / when bwrap is unavailable (mirrors
 * `orchestrate-jail.linux.test.ts`) — so the macOS `pnpm validate` floor reports
 * it skipped, never failed. On the VPS (`pnpm validate:full`) it runs as the
 * operator-verified containment gate.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemNowMs, createOutputGuard, type ClockPort, type ComisLogger, type PerAgentConfig } from "@comis/core";
import { createLeaseManager } from "@comis/infra";
import { detectSandboxProvider } from "@comis/skills";

import { createWakeGateRunner, type WakeGateRunner, type WakeGateRunnerDeps } from "./wake-gate-runner.js";

/** Linux + real bwrap gate (mirrors orchestrate-jail.linux.test.ts). */
function canJailRun(): boolean {
  if (process.platform !== "linux") return false;
  return detectSandboxProvider() !== undefined;
}

const jailAvailable = canJailRun();

function makeLogger(): ComisLogger {
  const noop = (): void => {};
  const logger: ComisLogger = {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    audit: noop,
    child: () => logger,
  };
  return logger;
}

/** An agents map whose sole agent resolves ENABLED autonomy; `web` toggles the
 *  `orch:web` surface (base `orch:read` + the web toggle → the minted lease's caps). */
function agentsWithWeb(web: boolean): WakeGateRunnerDeps["agents"] {
  return {
    "agent-1": { autonomy: { profile: "standard", capabilities: ["orch:read"], web } },
  } as unknown as Record<string, PerAgentConfig>;
}

describe.skipIf(!jailAvailable)("wake-gate runner real-jail acceptance (bwrap, Linux only)", () => {
  let workspacePath: string;
  let socketPath: string;
  let server: net.Server | undefined;
  const createdSockets: string[] = [];

  /** A cap server that answers a jailed gate's `tool.invoke` from a handler. */
  function startCapServer(
    handle: (tool: string, args: Record<string, unknown>) => unknown,
  ): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((conn) => {
        let buf = "";
        conn.setEncoding("utf8");
        conn.on("data", (chunk: string) => {
          buf += chunk;
          const nl = buf.indexOf("\n");
          if (nl === -1) return;
          const line = buf.slice(0, nl);
          try {
            const req = JSON.parse(line) as { params?: { tool?: string; args?: Record<string, unknown> } };
            const result = handle(req.params?.tool ?? "", req.params?.args ?? {});
            conn.end(JSON.stringify({ result }) + "\n");
          } catch (err) {
            conn.end(JSON.stringify({ error: String(err) }) + "\n");
          }
        });
      });
      srv.once("error", reject);
      srv.listen(socketPath, () => resolve(srv));
    });
  }

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "comis-wakegate-ws-"));
    mkdirSync(join(workspacePath, "results"), { recursive: true });
    socketPath = `/tmp/comis-wakegate-${systemNowMs()}.sock`;
    createdSockets.push(socketPath);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
    for (const p of createdSockets) {
      try {
        unlinkSync(p);
      } catch {
        /* gone — ok */
      }
    }
    rmSync(workspacePath, { recursive: true, force: true });
  });

  /** Build the REAL runner: real lease manager + output guard + detected bwrap. */
  function makeRunner(over: { web?: boolean; namespacePreflightOk?: boolean } = {}): WakeGateRunner {
    const clock = { now: () => Date.now(), nowDate: () => new Date() } as unknown as ClockPort;
    return createWakeGateRunner({
      logger: makeLogger(),
      leaseManager: createLeaseManager({ clock }),
      outputGuard: createOutputGuard(),
      capSocketPath: socketPath,
      registerRoot: () => {},
      sandbox: detectSandboxProvider()!,
      resolveWorkspace: () => workspacePath,
      agents: agentsWithWeb(over.web ?? true),
      baseEnv: { PATH: "/usr/bin:/bin", HOME: workspacePath },
      namespacePreflightOk: over.namespacePreflightOk ?? true,
    });
  }

  it(
    "a jailed gate that web_fetches and prints {\"wake\":false} resolves to wake:false",
    { timeout: 20_000 },
    async () => {
      // orch:web is present → the cap gate answers web_fetch; the gate decides skip.
      server = await startCapServer((tool) =>
        tool === "web_fetch" ? { status: 200, body: "all green" } : null,
      );
      const gate = {
        script: [
          "const res = await comis_tools.web_fetch({ url: \"https://example.com/status\" });",
          "console.log(JSON.stringify({ wake: /green/.test(res.body ?? \"\") ? false : true }));",
        ].join("\n"),
        language: "js" as const,
        timeoutSeconds: 20,
      };
      const verdict = await makeRunner({ web: true }).runWakeGate(gate, {
        agentId: "agent-1",
        jobId: "job-web-fetch",
        sessionKey: "main:agent-1",
      });
      expect(verdict).toEqual({ wake: false });
    },
  );

  it(
    "a gate needing orch:web on a web-OFF agent is denied at the cap gate (bound = the lease caps)",
    { timeout: 20_000 },
    async () => {
      // The web-off agent's minted lease lacks orch:web, so the cap gate DENIES
      // web_fetch — the bound is the lease caps, NOT the job's tool policy. A gate
      // that cannot complete its check fails OPEN to wake (never a silent skip).
      server = await startCapServer((tool) =>
        tool === "web_fetch" ? { error: "capability denied: orch:web" } : null,
      );
      const gate = {
        script: [
          "try {",
          "  const res = await comis_tools.web_fetch({ url: \"https://example.com/status\" });",
          "  if (res.error) throw new Error(res.error);",
          "  console.log(JSON.stringify({ wake: false }));",
          "} catch {",
          "  console.log(JSON.stringify({ wake: true, context: \"gate could not fetch (orch:web denied)\" }));",
          "}",
        ].join("\n"),
        language: "js" as const,
        timeoutSeconds: 20,
      };
      const verdict = await makeRunner({ web: false }).runWakeGate(gate, {
        agentId: "agent-1",
        jobId: "job-web-denied",
        sessionKey: "main:agent-1",
      });
      // The denied fetch cannot resolve a skip — the model wakes (fail-open).
      expect(verdict).toMatchObject({ wake: true });
    },
  );

  it("a host that cannot jail (namespacePreflightOk:false) degrades to runAsToday", async () => {
    const gate = {
      script: "console.log(JSON.stringify({ wake: false }));",
      language: "js" as const,
      timeoutSeconds: 20,
    };
    const verdict = await makeRunner({ namespacePreflightOk: false }).runWakeGate(gate, {
      agentId: "agent-1",
      jobId: "job-degrade",
      sessionKey: "main:agent-1",
    });
    expect(verdict).toEqual({ runAsToday: true });
  });
});
