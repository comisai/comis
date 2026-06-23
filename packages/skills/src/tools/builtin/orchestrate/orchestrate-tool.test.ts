// SPDX-License-Identifier: Apache-2.0
/**
 * macOS-unit tests for the `orchestrate` runner (ORCH-01/02). The Linux-gated
 * surface (real bwrap stdout-only / `~/.comis` mask) is proven in
 * `orchestrate-jail.linux.test.ts`; HERE we unit-test the pure / mockable parts
 * WITHOUT a real spawn: the SDK-write, the cap-socket arg construction (via the
 * genuine `BwrapProvider.buildArgs`), the `*KEY*/*TOKEN*/*SECRET*` env-scrub
 * (with the lease-var exemption), the honest-degrade-on-unavailable-jail, the
 * stdout size-bounce, and the run-end `cleanupRun` lifecycle.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import type { ComisLogger } from "@comis/core";

import { createOrchestrateTool, scrubSecretEnv } from "./orchestrate-tool.js";
import type {
  OrchestrateSpawnFn,
  OrchestrateSpawnedChild,
} from "./orchestrate-tool.js";
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

/**
 * A fake spawned child that emits a fixed stdout then closes with `exitCode`.
 * Mirrors the bits of `child_process.ChildProcess` the runner consumes
 * (`stdout`/`stderr` streams + `close`).
 */
function makeFakeChild(stdout: string, exitCode = 0, stderr = ""): OrchestrateSpawnedChild {
  const child = new EventEmitter() as unknown as OrchestrateSpawnedChild & EventEmitter;
  const out = new EventEmitter();
  const err = new EventEmitter();
  (child as { stdout: EventEmitter }).stdout = out;
  (child as { stderr: EventEmitter }).stderr = err;
  (child as { kill: () => void }).kill = () => {};
  // Emit on the next tick so the runner has attached its listeners.
  setImmediate(() => {
    if (stdout) out.emit("data", Buffer.from(stdout));
    if (stderr) err.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

describe("orchestrate-tool", () => {
  let workspacePath: string;
  const capSocketPath = "/run/comis/cap-test.sock";

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "comis-orchestrate-"));
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  function makeDeps(over?: {
    spawnFn?: OrchestrateSpawnFn;
    resolveJailNodeFn?: () => { mode: "path" } | { mode: "bind"; execPath: string } | { mode: "unavailable"; hint: string };
    cleanupRun?: ReturnType<typeof vi.fn>;
    baseEnv?: Record<string, string | undefined>;
  }) {
    const cleanupRun = over?.cleanupRun ?? vi.fn(async () => {});
    return {
      deps: {
        logger: makeLogger(),
        workspaceResolver: () => workspacePath,
        capSocketPath,
        sandbox: new BwrapProvider(),
        brokerSpawnEnv: {
          placeholders: {
            COMIS_CAP_LEASE: "lease-xyz",
            COMIS_ORCH_SOCKET: capSocketPath,
          },
        },
        store: {
          materialize: vi.fn(),
          gcRun: vi.fn(async () => {}),
          cleanupRun,
        },
        spawnFn: over?.spawnFn ?? ((): OrchestrateSpawnedChild => makeFakeChild("ok-output\n")),
        resolveJailNodeFn: over?.resolveJailNodeFn ?? (() => ({ mode: "path" as const })),
        loadSeccompFdFn: () => null,
        now: () => 1_700_000_000_000,
        baseEnv: over?.baseEnv ?? { PATH: "/usr/bin", HOME: "/home/x" },
      },
      cleanupRun,
    };
  }

  it("registers as an AgentTool named 'orchestrate' with the script/language schema", () => {
    const { deps } = makeDeps();
    const tool = createOrchestrateTool(deps);
    expect(tool.name).toBe("orchestrate");
    expect(typeof tool.execute).toBe("function");
    expect(tool.parameters).toBeDefined();
  });

  it("writes <workspace>/<runId>.<language> + the comis_tools SDK + the runtime before spawning (SDK-write)", async () => {
    let writtenAtSpawn: { script: boolean; sdkJs: boolean; sdkDts: boolean; runtime: boolean } | undefined;
    const spawnFn: OrchestrateSpawnFn = (_bin, args) => {
      // The last positional arg the runner passes to bash is the jailed command,
      // which references `<runId>.ts`; capture the workspace file state NOW.
      const scriptArg = args.find((a) => /\.ts$|\.js$/.test(a));
      const runId = scriptArg ? scriptArg.replace(/.*\b([^/ ]+)\.(ts|js)\b.*/, "$1") : "";
      writtenAtSpawn = {
        script: existsSync(join(workspacePath, `${runId}.ts`)),
        sdkJs: existsSync(join(workspacePath, "comis_tools.js")),
        sdkDts: existsSync(join(workspacePath, "comis_tools.d.ts")),
        runtime: existsSync(join(workspacePath, "orchestrate-sdk-runtime.js")),
      };
      return makeFakeChild("done\n");
    };
    const { deps } = makeDeps({ spawnFn });
    const tool = createOrchestrateTool(deps);

    await tool.execute("call-1", { script: "console.log(1)", language: "ts" });

    expect(writtenAtSpawn).toBeDefined();
    expect(writtenAtSpawn!.script).toBe(true);
    expect(writtenAtSpawn!.sdkJs).toBe(true);
    expect(writtenAtSpawn!.sdkDts).toBe(true);
    expect(writtenAtSpawn!.runtime).toBe(true);
  });

  it("writes the model's script verbatim into the workspace", async () => {
    let scriptPath: string | undefined;
    const spawnFn: OrchestrateSpawnFn = (_bin, args) => {
      const scriptArg = args.find((a) => /\.ts$/.test(a));
      const runId = scriptArg ? scriptArg.replace(/.*\b([^/ ]+)\.ts\b.*/, "$1") : "";
      scriptPath = join(workspacePath, `${runId}.ts`);
      return makeFakeChild("x\n");
    };
    const { deps } = makeDeps({ spawnFn });
    const tool = createOrchestrateTool(deps);
    const script = 'import { comis_tools } from "./comis_tools.js";\nconsole.log("hi");\n';

    await tool.execute("c", { script, language: "ts" });

    expect(scriptPath && readFileSync(scriptPath, "utf8")).toBe(script);
  });

  it("builds the cap-socket jail args (--unshare-net + the cap-socket --bind)", async () => {
    let spawnArgs: string[] | undefined;
    const spawnFn: OrchestrateSpawnFn = (_bin, args) => {
      spawnArgs = args;
      return makeFakeChild("y\n");
    };
    const { deps } = makeDeps({ spawnFn });
    const tool = createOrchestrateTool(deps);

    await tool.execute("c", { script: "1", language: "ts" });

    expect(spawnArgs).toBeDefined();
    expect(spawnArgs).toContain("--unshare-net");
    // The cap socket is bound into the jail (--bind capSocketPath capSocketPath).
    const bindIdx = spawnArgs!.indexOf("--bind");
    expect(spawnArgs!).toContain(capSocketPath);
    expect(bindIdx).toBeGreaterThanOrEqual(0);
  });

  describe("scrubSecretEnv (ORCH-02 pure helper)", () => {
    it("drops every *KEY*/*TOKEN*/*SECRET* key (case-insensitive)", () => {
      const scrubbed = scrubSecretEnv({
        PATH: "/usr/bin",
        FOO_KEY: "secret1",
        BAR_TOKEN: "secret2",
        BAZ_SECRET: "secret3",
        aws_secret_access_key: "secret4",
        ANTHROPIC_API_KEY: "secret5",
        HOME: "/home/x",
      });
      expect(scrubbed.PATH).toBe("/usr/bin");
      expect(scrubbed.HOME).toBe("/home/x");
      expect(scrubbed.FOO_KEY).toBeUndefined();
      expect(scrubbed.BAR_TOKEN).toBeUndefined();
      expect(scrubbed.BAZ_SECRET).toBeUndefined();
      expect(scrubbed.aws_secret_access_key).toBeUndefined();
      expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("drops undefined-valued keys and keeps only string values", () => {
      const scrubbed = scrubSecretEnv({ A: "1", B: undefined, C: "3" });
      expect(scrubbed).toEqual({ A: "1", C: "3" });
    });
  });

  it("scrubs *KEY*/*TOKEN*/*SECRET* from the child env while the lease vars SURVIVE (placeholders merged last)", async () => {
    let childEnv: Record<string, string | undefined> | undefined;
    const spawnFn: OrchestrateSpawnFn = (_bin, _args, opts) => {
      childEnv = opts?.env;
      return makeFakeChild("z\n");
    };
    const { deps } = makeDeps({
      spawnFn,
      baseEnv: {
        PATH: "/usr/bin",
        FOO_KEY: "leak1",
        BAR_TOKEN: "leak2",
        BAZ_SECRET: "leak3",
      },
    });
    const tool = createOrchestrateTool(deps);

    await tool.execute("c", { script: "1", language: "ts" });

    expect(childEnv).toBeDefined();
    // The secrets are scrubbed from the base env...
    expect(childEnv!.FOO_KEY).toBeUndefined();
    expect(childEnv!.BAR_TOKEN).toBeUndefined();
    expect(childEnv!.BAZ_SECRET).toBeUndefined();
    // ...but the daemon-injected lease vars survive (they ride placeholders,
    // merged AFTER the scrub — Pitfall 4).
    expect(childEnv!.COMIS_CAP_LEASE).toBe("lease-xyz");
    expect(childEnv!.COMIS_ORCH_SOCKET).toBe(capSocketPath);
  });

  it("honest-degrades on an unavailable jail (no node/bwrap) — throws, NO spawn (S4)", async () => {
    const spawnFn = vi.fn<OrchestrateSpawnFn>(() => makeFakeChild(""));
    const { deps } = makeDeps({
      spawnFn,
      resolveJailNodeFn: () => ({ mode: "unavailable", hint: "no node inside the jail" }),
    });
    const tool = createOrchestrateTool(deps);

    await expect(tool.execute("c", { script: "1", language: "ts" })).rejects.toThrow(
      /no node inside the jail|unavailable|jail/i,
    );
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("size-bounces an oversized stdout (head+tail+marker) and returns ONLY the bounced stdout", async () => {
    const huge = "L".repeat(500_000);
    const spawnFn: OrchestrateSpawnFn = () => makeFakeChild(huge);
    const { deps } = makeDeps({ spawnFn });
    const tool = createOrchestrateTool(deps);

    const result = await tool.execute("c", { script: "1", language: "ts" });

    const text = result.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toMatch(/truncated/i);
  });

  it("returns ONLY stdout — stderr/intermediate output is not surfaced", async () => {
    const spawnFn: OrchestrateSpawnFn = () => makeFakeChild("THE-STDOUT\n", 0, "SECRET-STDERR-LEAK");
    const { deps } = makeDeps({ spawnFn });
    const tool = createOrchestrateTool(deps);

    const result = await tool.execute("c", { script: "1", language: "ts" });

    const text = result.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    expect(text).toContain("THE-STDOUT");
    expect(text).not.toContain("SECRET-STDERR-LEAK");
  });

  it("calls cleanupRun on the runId after the run completes (REF-03 lifecycle)", async () => {
    const { deps, cleanupRun } = makeDeps();
    const tool = createOrchestrateTool(deps);

    await tool.execute("c", { script: "1", language: "ts" });

    expect(cleanupRun).toHaveBeenCalledTimes(1);
    const arg = cleanupRun.mock.calls[0][0] as { workspacePath: string; runId: string };
    expect(arg.workspacePath).toBe(workspacePath);
    expect(typeof arg.runId).toBe("string");
    expect(arg.runId.length).toBeGreaterThan(0);
  });

  it("calls cleanupRun even when the jailed child fails (finally — REF-03)", async () => {
    const spawnFn: OrchestrateSpawnFn = () => makeFakeChild("partial", 1);
    const { deps, cleanupRun } = makeDeps({ spawnFn });
    const tool = createOrchestrateTool(deps);

    await tool.execute("c", { script: "1", language: "ts" }).catch(() => {});

    expect(cleanupRun).toHaveBeenCalledTimes(1);
  });
});
