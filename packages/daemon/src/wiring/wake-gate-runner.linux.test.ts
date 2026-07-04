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

/** The resolved lease caps for a web-toggled agent: base `orch:read` + optional
 *  `orch:web`. Mirrors {@link agentsWithWeb} → resolveAutonomy, so the fake cap
 *  gate enforces the SAME caps the runner mints the per-fire lease with. */
function capsForWeb(web: boolean): readonly string[] {
  return web ? ["orch:read", "orch:web"] : ["orch:read"];
}

/** The cap a jailed gate tool requires at the endpoint (the enforced binding). */
function requiredCapFor(tool: string): string {
  return tool === "web_fetch" ? "orch:web" : "orch:read";
}

/**
 * Wrap a tool responder in the cap binding the real endpoint enforces: a call
 * whose required cap is in `leaseCaps` is served; one whose cap the lease lacks
 * is DENIED. This makes the deny CAP-DRIVEN (denied BECAUSE the web-off lease
 * lacks `orch:web`) — distinguishable from an unconditional error — so the same
 * handler + same tool yields opposite outcomes purely from the lease's caps.
 */
function capBoundHandler(
  leaseCaps: readonly string[],
  serve: (tool: string, args: Record<string, unknown>) => unknown,
): (tool: string, args: Record<string, unknown>) => unknown {
  return (tool, args) => {
    const cap = requiredCapFor(tool);
    if (!leaseCaps.includes(cap)) return { error: `capability denied: ${cap}` };
    return serve(tool, args);
  };
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
      // orch:web IS in this lease → the cap gate SERVES web_fetch (the same
      // cap-bound handler DENIES it when orch:web is absent, below); the gate
      // reads the body and decides skip.
      server = await startCapServer(
        capBoundHandler(capsForWeb(true), (tool) =>
          tool === "web_fetch" ? { status: 200, body: "all green" } : null,
        ),
      );
      const gate = {
        script: [
          // The jailed SDK is an ESM export copied beside the script — it must be
          // imported (it is NOT a global), the same pattern an orchestrate script uses.
          "import { comis_tools } from \"./comis_tools.js\";",
          "const res = await comis_tools.web_fetch({ url: \"https://example.com/status\" });",
          "console.log(JSON.stringify({ wake: /green/.test(res.body ?? \"\") ? false : true }));",
        ].join("\n"),
        language: "js" as const,
        timeoutSeconds: 20,
      };
      const outcome = await makeRunner({ web: true }).runWakeGate(gate, {
        agentId: "agent-1",
        jobId: "job-web-fetch",
        sessionKey: "main:agent-1",
      });
      // runWakeGate returns the richer WakeGateOutcome — the wake decision is
      // nested under `.verdict`, beside the durationMs + toolCalls counts.
      expect(outcome).toMatchObject({ verdict: { wake: false } });
    },
  );

  it(
    "a gate needing orch:web on a web-OFF agent is denied at the cap gate (bound = the lease caps)",
    { timeout: 20_000 },
    async () => {
      // The web-off agent's minted lease carries ["orch:read"] — NOT orch:web.
      // The SAME cap-bound handler that SERVES web_fetch when orch:web is present
      // (the acceptance test above) DENIES it here because this lease lacks it —
      // so the deny is CAP-DRIVEN (the bound is the lease caps, not the job's tool
      // policy), not an unconditional error. A gate that cannot complete its check
      // fails OPEN to wake (never a silent skip).
      server = await startCapServer(
        capBoundHandler(capsForWeb(false), (tool) =>
          tool === "web_fetch" ? { status: 200, body: "all green" } : null,
        ),
      );
      const gate = {
        script: [
          // Import the jailed SDK (ESM export, not a global) so the DENY is the
          // cap gate rejecting web_fetch — not a ReferenceError masquerading as one.
          "import { comis_tools } from \"./comis_tools.js\";",
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
      const outcome = await makeRunner({ web: false }).runWakeGate(gate, {
        agentId: "agent-1",
        jobId: "job-web-denied",
        sessionKey: "main:agent-1",
      });
      // The denied fetch cannot resolve a skip — the model wakes (fail-open),
      // the verdict nested under the richer WakeGateOutcome.
      expect(outcome).toMatchObject({ verdict: { wake: true } });
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
