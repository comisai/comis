// SPDX-License-Identifier: Apache-2.0
/**
 * Characterization tests for the shared jailed-run core {@link runJailedScript}.
 *
 * These pin the SEAM contract that callers (the `orchestrate` tool and any other
 * jailed-run caller) rely on, WITHOUT a real spawn (the spawn + jail-node
 * resolution are injected seams; the real-bwrap containment is the Linux-gated
 * `orchestrate-jail.linux.test.ts` proof):
 *   - a clean child exit RESOLVES with the child's RAW stdout (never size-bounced
 *     — the caller shapes it);
 *   - the base env is secret-scrubbed BEFORE the lease placeholders are merged,
 *     so the lease vars survive by construction while `*KEY*` base vars are
 *     dropped;
 *   - a non-zero exit / a >4 MiB stdout flood / a wall-clock timeout all REJECT
 *     (fail-closed) — the reject contract a fail-open caller depends on;
 *   - the caller-supplied `runId` threads through the script filename + the store
 *     GC/cleanup; an omitted one is generated.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import type { ComisLogger } from "@comis/core";

import {
  runJailedScript,
  scrubSecretEnv,
  STDOUT_HARD_CAP_BYTES,
} from "./jailed-script-runner.js";
import type {
  JailedScriptSpawnFn,
  JailedScriptSpawnedChild,
} from "./jailed-script-runner.js";
import { BwrapProvider } from "../sandbox/bwrap-provider.js";

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

/** A fake child that emits a fixed stdout then closes with `exitCode`. */
function makeFakeChild(stdout: string, exitCode = 0, stderr = ""): JailedScriptSpawnedChild {
  const child = new EventEmitter() as unknown as JailedScriptSpawnedChild & EventEmitter;
  const out = new EventEmitter();
  const err = new EventEmitter();
  (child as { stdout: EventEmitter }).stdout = out;
  (child as { stderr: EventEmitter }).stderr = err;
  (child as { kill: () => void }).kill = () => {};
  setImmediate(() => {
    if (stdout) out.emit("data", Buffer.from(stdout));
    if (stderr) err.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

/** A fake child that attaches streams but NEVER closes (drives the timeout). */
function makeSilentChild(killSpy: () => void): JailedScriptSpawnedChild {
  const child = new EventEmitter() as unknown as JailedScriptSpawnedChild & EventEmitter;
  (child as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as { stderr: EventEmitter }).stderr = new EventEmitter();
  (child as { kill: () => void }).kill = killSpy;
  return child;
}

/** A fake child that emits ONE over-cap stdout chunk (the in-stream OOM guard). */
function makeFloodingChild(killSpy: () => void): JailedScriptSpawnedChild {
  const child = new EventEmitter() as unknown as JailedScriptSpawnedChild & EventEmitter;
  const out = new EventEmitter();
  const err = new EventEmitter();
  (child as { stdout: EventEmitter }).stdout = out;
  (child as { stderr: EventEmitter }).stderr = err;
  (child as { kill: () => void }).kill = killSpy;
  setImmediate(() => {
    out.emit("data", Buffer.alloc(STDOUT_HARD_CAP_BYTES + 1, 0x41));
    child.emit("close", 0);
  });
  return child;
}

describe("runJailedScript (shared jailed-run core)", () => {
  let workspacePath: string;
  let sdkAssetsDir: string;
  const capSocketPath = "/run/comis/cap-test.sock";

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "comis-jailed-runner-"));
    sdkAssetsDir = mkdtempSync(join(tmpdir(), "comis-jailed-sdk-"));
    writeFileSync(join(sdkAssetsDir, "comis_tools.d.ts"), "// d.ts\n");
    writeFileSync(join(sdkAssetsDir, "comis_tools.js"), "// js\n");
    writeFileSync(join(sdkAssetsDir, "orchestrate-sdk-runtime.js"), "// runtime\n");
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(sdkAssetsDir, { recursive: true, force: true });
  });

  function makeDeps(over?: {
    spawnFn?: JailedScriptSpawnFn;
    resolveJailNodeFn?: () => { mode: "path" } | { mode: "bind"; execPath: string } | { mode: "unavailable"; hint: string };
    resolveJailAgentCliFn?: () => { mode: "bind"; binPath: string } | { mode: "unavailable"; hint: string };
    logger?: ComisLogger;
    gcRun?: ReturnType<typeof vi.fn>;
    cleanupRun?: ReturnType<typeof vi.fn>;
    baseEnv?: Record<string, string | undefined>;
    brokerSpawnEnv?: { placeholders: Record<string, string> };
  }) {
    const gcRun = over?.gcRun ?? vi.fn(async () => {});
    const cleanupRun = over?.cleanupRun ?? vi.fn(async () => {});
    return {
      deps: {
        logger: over?.logger ?? makeLogger(),
        workspaceResolver: () => workspacePath,
        capSocketPath,
        sandbox: new BwrapProvider(),
        sdkAssetsDir,
        brokerSpawnEnv:
          over?.brokerSpawnEnv ??
          ({
            placeholders: {
              COMIS_CAP_LEASE: "lease-xyz",
              COMIS_ORCH_SOCKET: capSocketPath,
            },
          } as const),
        store: {
          materialize: vi.fn(),
          gcRun,
          cleanupRun,
        },
        spawnFn: over?.spawnFn ?? ((): JailedScriptSpawnedChild => makeFakeChild("ok-output\n")),
        resolveJailNodeFn: over?.resolveJailNodeFn ?? (() => ({ mode: "path" as const })),
        resolveJailAgentCliFn:
          over?.resolveJailAgentCliFn ??
          (() => ({ mode: "bind" as const, binPath: "/jail/comis-agent-entry.js" })),
        loadSeccompFdFn: (): number | null => null,
        now: () => 1_700_000_000_000,
        baseEnv: over?.baseEnv ?? { PATH: "/usr/bin", HOME: "/home/x" },
      },
      gcRun,
      cleanupRun,
    };
  }

  /** Extract `<scriptName>` from the jailed `node <scriptName>` bash command. */
  function scriptNameFromArgs(args: string[]): string {
    const cmdIdx = args.indexOf("-c");
    const command = cmdIdx >= 0 ? (args[cmdIdx + 1] ?? "") : "";
    const m = command.match(/node\s+(\S+)/);
    return m ? m[1] : "";
  }

  it("resolves with the jailed child's raw stdout on a clean exit", async () => {
    const { deps } = makeDeps({ spawnFn: () => makeFakeChild("hello-from-jail\n") });

    const stdout = await runJailedScript(deps, { script: "console.log(1)", language: "ts" });

    expect(stdout).toBe("hello-from-jail\n");
  });

  it("returns the FULL raw stdout unbounced (the caller owns any size-bounce)", async () => {
    // Distinguishes the core from the orchestrate tool: the runner returns the
    // raw stdout verbatim, even past the tool's 30k context cap — a caller
    // (orchestrate) size-bounces it; a different caller may parse it whole.
    const big = "L".repeat(200_000);
    const { deps } = makeDeps({ spawnFn: () => makeFakeChild(big) });

    const stdout = await runJailedScript(deps, { script: "1", language: "ts" });

    expect(stdout.length).toBe(big.length);
    expect(stdout).not.toMatch(/truncated/i);
  });

  it("scrubs a *KEY*-named base var while the lease placeholders survive the scrub", async () => {
    let childEnv: Record<string, string | undefined> | undefined;
    const spawnFn: JailedScriptSpawnFn = (_bin, _args, opts) => {
      childEnv = opts?.env;
      return makeFakeChild("z\n");
    };
    const { deps } = makeDeps({
      spawnFn,
      baseEnv: { PATH: "/usr/bin", DEPLOY_KEY: "leak", BAR_TOKEN: "leak2" },
    });

    await runJailedScript(deps, { script: "1", language: "ts" });

    expect(childEnv).toBeDefined();
    // The base secret-named vars are scrubbed...
    expect(childEnv!.DEPLOY_KEY).toBeUndefined();
    expect(childEnv!.BAR_TOKEN).toBeUndefined();
    // ...the benign base var passes through...
    expect(childEnv!.PATH).toBe("/usr/bin");
    // ...and the daemon-injected lease vars survive (merged after the scrub).
    expect(childEnv!.COMIS_CAP_LEASE).toBe("lease-xyz");
    expect(childEnv!.COMIS_ORCH_SOCKET).toBe(capSocketPath);
  });

  it("merges the lease placeholders AFTER the scrub (a secret-named placeholder is not dropped)", async () => {
    // Rigorous ordering proof of the host-secret-into-jail mitigation: the scrub
    // runs over the BASE env ONLY. A placeholder whose NAME matches the secret
    // pattern would be dropped if the scrub ran AFTER the merge; it survives here,
    // proving the scrub runs BEFORE the merge (the lease survives by construction).
    let childEnv: Record<string, string | undefined> | undefined;
    const spawnFn: JailedScriptSpawnFn = (_bin, _args, opts) => {
      childEnv = opts?.env;
      return makeFakeChild("z\n");
    };
    const { deps } = makeDeps({
      spawnFn,
      baseEnv: { PATH: "/usr/bin", SHARED_KEY: "base-value-dropped" },
      brokerSpawnEnv: { placeholders: { SHARED_KEY: "lease-value-kept", COMIS_CAP_LEASE: "lease-xyz" } },
    });

    await runJailedScript(deps, { script: "1", language: "ts" });

    // The base copy would be scrubbed; the placeholder copy (merged last) wins.
    expect(childEnv!.SHARED_KEY).toBe("lease-value-kept");
    expect(childEnv!.COMIS_CAP_LEASE).toBe("lease-xyz");
    // Sanity: the pure scrub alone would have dropped the base SHARED_KEY.
    expect(scrubSecretEnv({ SHARED_KEY: "base-value-dropped" }).SHARED_KEY).toBeUndefined();
  });

  it("threads the caller-supplied runId through the script filename and the store cleanup", async () => {
    let scriptName: string | undefined;
    const spawnFn: JailedScriptSpawnFn = (_bin, args) => {
      scriptName = scriptNameFromArgs(args);
      return makeFakeChild("ok\n");
    };
    const { deps, gcRun, cleanupRun } = makeDeps({ spawnFn });

    await runJailedScript(deps, { script: "1", language: "ts", runId: "run-supplied-123" });

    expect(scriptName).toBe("run-supplied-123.ts");
    expect(existsSync(join(workspacePath, "run-supplied-123.ts"))).toBe(true);
    expect((gcRun.mock.calls[0][0] as { runId: string }).runId).toBe("run-supplied-123");
    expect((cleanupRun.mock.calls[0][0] as { runId: string }).runId).toBe("run-supplied-123");
  });

  it("generates a runId when the caller omits one (non-empty, orch-prefixed)", async () => {
    const { deps, cleanupRun } = makeDeps();

    await runJailedScript(deps, { script: "1", language: "js" });

    const arg = cleanupRun.mock.calls[0][0] as { runId: string };
    expect(typeof arg.runId).toBe("string");
    expect(arg.runId.length).toBeGreaterThan(0);
    expect(arg.runId.startsWith("orch-")).toBe(true);
  });

  it("honest-degrades on an unavailable jail — throws WITHOUT spawning", async () => {
    const spawnFn = vi.fn<JailedScriptSpawnFn>(() => makeFakeChild(""));
    const { deps } = makeDeps({
      spawnFn,
      resolveJailNodeFn: () => ({ mode: "unavailable", hint: "no node inside the jail" }),
    });

    await expect(runJailedScript(deps, { script: "1", language: "ts" })).rejects.toThrow(
      /no node inside the jail|unavailable|jail/i,
    );
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("rejects and surfaces the stderr tail when the jailed child exits non-zero", async () => {
    const stderr = "TypeError: content.trim is not a function\n    at file:///w/run.ts:5:28";
    const { deps, cleanupRun } = makeDeps({ spawnFn: () => makeFakeChild("partial", 1, stderr) });

    await expect(runJailedScript(deps, { script: "1", language: "ts" })).rejects.toThrow(
      /exited with code 1[\s\S]*content\.trim is not a function/,
    );
    // The run lifecycle cleanup still runs in the finally on the failure path.
    expect(cleanupRun).toHaveBeenCalledTimes(1);
  });

  it("kills the child and rejects when the jailed stdout exceeds the hard cap", async () => {
    const killSpy = vi.fn();
    const { deps } = makeDeps({ spawnFn: () => makeFloodingChild(killSpy) });

    await expect(runJailedScript(deps, { script: "1", language: "ts" })).rejects.toThrow(
      /hard cap|exceeded|too large/i,
    );
    expect(killSpy).toHaveBeenCalled();
  });

  it("kills the child and rejects when the run exceeds its wall-clock timeout", async () => {
    const killSpy = vi.fn();
    const { deps, cleanupRun } = makeDeps({ spawnFn: () => makeSilentChild(killSpy) });

    // A tiny bounded timeout; the silent child never closes, so the SIGKILL-on-
    // timeout path is the only outcome (no timing race).
    await expect(
      runJailedScript(deps, { script: "1", language: "ts", timeoutMs: 25 }),
    ).rejects.toThrow(/timeout/i);
    expect(killSpy).toHaveBeenCalledWith("SIGKILL");
    expect(cleanupRun).toHaveBeenCalledTimes(1);
  });

  it("does not spawn when the caller abort signal is already closed", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawnFn = vi.fn<JailedScriptSpawnFn>(() => makeFakeChild("late\n"));
    const { deps, cleanupRun } = makeDeps({ spawnFn });

    await expect(
      runJailedScript(deps, {
        script: "1",
        language: "ts",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);

    expect(spawnFn).not.toHaveBeenCalled();
    expect(cleanupRun).not.toHaveBeenCalled();
  });

  it("kills the live jailed child and rejects when the caller aborts", async () => {
    const controller = new AbortController();
    const killSpy = vi.fn();
    const { deps, cleanupRun } = makeDeps({ spawnFn: () => makeSilentChild(killSpy) });

    const pending = runJailedScript(deps, {
      script: "1",
      language: "ts",
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/i);
    expect(killSpy).toHaveBeenCalledWith("SIGKILL");
    expect(cleanupRun).toHaveBeenCalledTimes(1);
  });

  it("rejects (surfacing the error) when the spawned child emits an 'error' event", async () => {
    const child = new EventEmitter() as unknown as JailedScriptSpawnedChild & EventEmitter;
    (child as { stdout: EventEmitter }).stdout = new EventEmitter();
    (child as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as { kill: () => void }).kill = () => {};
    setImmediate(() => child.emit("error", new Error("spawn ENOEXEC bwrap")));
    const { deps, cleanupRun } = makeDeps({ spawnFn: () => child });

    await expect(runJailedScript(deps, { script: "1", language: "ts" })).rejects.toThrow(
      /ENOEXEC|spawn|bwrap/i,
    );
    expect(cleanupRun).toHaveBeenCalledTimes(1);
  });

  it("degrades ONLY the comis-agent CLI surface when its resolver reports unavailable (the script still runs)", async () => {
    let childEnv: Record<string, string | undefined> | undefined;
    const spawnFn: JailedScriptSpawnFn = (_bin, _args, opts) => {
      childEnv = opts?.env;
      return makeFakeChild("script-surface-ok\n");
    };
    const { deps } = makeDeps({
      spawnFn,
      resolveJailAgentCliFn: () => ({ mode: "unavailable", hint: "comis-agent binary missing" }),
    });

    const stdout = await runJailedScript(deps, { script: "1", language: "ts" });

    // The run completes (the SCRIPT surface is independent of the CLI surface),
    // and COMIS_AGENT_BIN is never set on the degraded path (no silent bind).
    expect(stdout).toBe("script-surface-ok\n");
    expect(childEnv!.COMIS_AGENT_BIN).toBeUndefined();
  });
});
