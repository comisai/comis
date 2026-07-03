// SPDX-License-Identifier: Apache-2.0
/**
 * macOS-unit tests for the `orchestrate` runner. The Linux-gated
 * surface (real bwrap stdout-only / `~/.comis` mask) is proven in
 * `orchestrate-jail.linux.test.ts`; HERE we unit-test the pure / mockable parts
 * WITHOUT a real spawn: the SDK-write, the cap-socket arg construction (via the
 * genuine `BwrapProvider.buildArgs`), the secret-named env-scrub (KEY/TOKEN/
 * SECRET, with the lease-var exemption), the honest-degrade-on-unavailable-jail,
 * the
 * stdout size-bounce, and the run-end `cleanupRun` lifecycle.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import type { ComisLogger } from "@comis/core";

import {
  createOrchestrateTool,
  scrubSecretEnv,
  clampTimeoutMs,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  STDOUT_HARD_CAP_BYTES,
} from "./orchestrate-tool.js";
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
  let sdkAssetsDir: string;
  const capSocketPath = "/run/comis/cap-test.sock";

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "comis-orchestrate-"));
    // A fixture SDK-assets dir holding the three files the runner copies into the
    // jail. (In production this dir is the built module dir, which carries the
    // committed comis_tools.{d.ts,js} + the compiled orchestrate-sdk-runtime.js;
    // the source dir lacks the compiled .js, so the unit suite injects a fixture.)
    sdkAssetsDir = mkdtempSync(join(tmpdir(), "comis-orch-sdk-"));
    writeFileSync(join(sdkAssetsDir, "comis_tools.d.ts"), "// d.ts\n");
    writeFileSync(join(sdkAssetsDir, "comis_tools.js"), "// js\n");
    writeFileSync(join(sdkAssetsDir, "orchestrate-sdk-runtime.js"), "// runtime\n");
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(sdkAssetsDir, { recursive: true, force: true });
  });

  function makeDeps(over?: {
    spawnFn?: OrchestrateSpawnFn;
    resolveJailNodeFn?: () => { mode: "path" } | { mode: "bind"; execPath: string } | { mode: "unavailable"; hint: string };
    resolveJailAgentCliFn?: () => { mode: "bind"; binPath: string } | { mode: "unavailable"; hint: string };
    logger?: ComisLogger;
    cleanupRun?: ReturnType<typeof vi.fn>;
    baseEnv?: Record<string, string | undefined>;
    loadSeccompFdFn?: () => number | null;
    mintRunLease?: (runId: string, timeoutMs: number) => { leaseId: string; bearer: string };
  }) {
    const cleanupRun = over?.cleanupRun ?? vi.fn(async () => {});
    return {
      deps: {
        logger: over?.logger ?? makeLogger(),
        workspaceResolver: () => workspacePath,
        capSocketPath,
        sandbox: new BwrapProvider(),
        sdkAssetsDir,
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
        // Default to a bound comis-agent so the CLI surface is on unless a test
        // overrides it (the default keeps unrelated tests' env/args stable).
        resolveJailAgentCliFn:
          over?.resolveJailAgentCliFn ??
          (() => ({ mode: "bind" as const, binPath: "/jail/comis-agent-entry.js" })),
        loadSeccompFdFn: over?.loadSeccompFdFn ?? (() => null),
        now: () => 1_700_000_000_000,
        baseEnv: over?.baseEnv ?? { PATH: "/usr/bin", HOME: "/home/x" },
        ...(over?.mintRunLease ? { mintRunLease: over.mintRunLease } : {}),
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

  /** Extract `<scriptName>` from the jailed `node <scriptName>` bash command. */
  function scriptNameFromArgs(args: string[]): string {
    const cmdIdx = args.indexOf("-c");
    const command = cmdIdx >= 0 ? (args[cmdIdx + 1] ?? "") : "";
    const m = command.match(/node\s+(\S+)/);
    return m ? m[1] : "";
  }

  it("writes <workspace>/<runId>.<language> + the comis_tools SDK + the runtime before spawning (SDK-write)", async () => {
    let writtenAtSpawn: { script: boolean; sdkJs: boolean; sdkDts: boolean; runtime: boolean } | undefined;
    const spawnFn: OrchestrateSpawnFn = (_bin, args) => {
      // The bash command is `node <scriptName>`; capture the workspace file state
      // NOW (the runner must have written all four files before spawning).
      const scriptName = scriptNameFromArgs(args);
      writtenAtSpawn = {
        script: scriptName !== "" && existsSync(join(workspacePath, scriptName)),
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
      const scriptName = scriptNameFromArgs(args);
      scriptPath = join(workspacePath, scriptName);
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

  // CI finding (#236 carry-over): in BIND mode the daemon's node is --ro-bind'd at
  // its absolute execPath but is NOT on the jail's scrubbed PATH (/usr/bin:/bin),
  // so the jailed `node <script>` was command-not-found → exit 127 on every real
  // run whose host node lives outside SYSTEM_RO_PATHS (the CI hostedtoolcache node).
  // The runner must invoke node by the resolved absolute path. (Passed every macOS
  // unit test because the default resolveJailNodeFn is PATH mode.)
  it("invokes node by its absolute execPath in BIND mode (not a bare `node` → exit 127)", async () => {
    let spawnArgs: string[] | undefined;
    const spawnFn: OrchestrateSpawnFn = (_bin, args) => {
      spawnArgs = args;
      return makeFakeChild("y\n");
    };
    const execPath = "/opt/hostedtoolcache/node/22.0.0/x64/bin/node";
    const { deps } = makeDeps({
      spawnFn,
      resolveJailNodeFn: () => ({ mode: "bind", execPath }),
    });
    const tool = createOrchestrateTool(deps);

    await tool.execute("c", { script: "1", language: "ts" });

    const cmdIdx = spawnArgs!.indexOf("-c");
    const command = spawnArgs![cmdIdx + 1] ?? "";
    expect(command.startsWith(`${execPath} `)).toBe(true);
    expect(command).not.toMatch(/^node\s/);
  });

  // The runner passes `tempDir: <workspace>/.tmp`
  // to BwrapProvider.buildArgs, which `--bind`s it into the jail — and bwrap
  // requires the bind SOURCE to exist. A runner that never creates `.tmp` makes
  // EVERY real jailed run die at construction with `bwrap: Can't find source path
  // .../.tmp: No such file or directory` → exit 1, breaking the orchestrate
  // happy-path. (Invisible to the macOS unit tests, which inject a fake spawn
  // that never runs bwrap.) The runner must create `.tmp` before spawning.
  it("creates the .tmp tempDir before spawning so bwrap can --bind it", async () => {
    let tmpExistsAtSpawn: boolean | undefined;
    const spawnFn: OrchestrateSpawnFn = () => {
      tmpExistsAtSpawn = existsSync(join(workspacePath, ".tmp"));
      return makeFakeChild("ok\n");
    };
    const { deps } = makeDeps({ spawnFn });
    const tool = createOrchestrateTool(deps);

    await tool.execute("c", { script: "1", language: "ts" });

    expect(tmpExistsAtSpawn).toBe(true);
  });

  describe("scrubSecretEnv (pure env-scrub helper)", () => {
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

    it("drops common credential names that contain no KEY/TOKEN/SECRET substring (defense-in-depth)", () => {
      // The base env is the credential-free execToolEnv today, so this is pure
      // defense-in-depth — but the scrub is the documented credential boundary,
      // so it must also drop the credential classes that name no
      // KEY/TOKEN/SECRET substring.
      const scrubbed = scrubSecretEnv({
        PATH: "/usr/bin",
        DB_PASSWORD: "p1",
        SSH_PASSPHRASE: "p2",
        AWS_CREDENTIALS: "p3",
        AWS_CREDENTIAL: "p3b",
        TLS_PRIVATE: "p4",
        GH_BEARER: "p5",
        PROXY_AUTH: "p6",
        GITHUB_PAT: "p7",
        DATABASE_DSN: "p8",
      });
      expect(scrubbed.PATH).toBe("/usr/bin");
      expect(scrubbed.DB_PASSWORD).toBeUndefined();
      expect(scrubbed.SSH_PASSPHRASE).toBeUndefined();
      expect(scrubbed.AWS_CREDENTIALS).toBeUndefined();
      expect(scrubbed.AWS_CREDENTIAL).toBeUndefined();
      expect(scrubbed.TLS_PRIVATE).toBeUndefined();
      expect(scrubbed.GH_BEARER).toBeUndefined();
      expect(scrubbed.PROXY_AUTH).toBeUndefined();
      expect(scrubbed.GITHUB_PAT).toBeUndefined();
      expect(scrubbed.DATABASE_DSN).toBeUndefined();
    });

    it("keeps the lease + benign env vars that must survive the scrub", () => {
      // Regression guard: broadening the pattern must NOT drop the lease vars or
      // benign names. COMIS_CAP_LEASE/COMIS_ORCH_SOCKET ride placeholders merged
      // AFTER the scrub, but PATH/HOME/LANG/TERM/NODE_ENV/TZ pass THROUGH it.
      const scrubbed = scrubSecretEnv({
        PATH: "/usr/bin",
        HOME: "/home/x",
        LANG: "en_US.UTF-8",
        TERM: "xterm",
        NODE_ENV: "production",
        TZ: "UTC",
      });
      expect(scrubbed).toEqual({
        PATH: "/usr/bin",
        HOME: "/home/x",
        LANG: "en_US.UTF-8",
        TERM: "xterm",
        NODE_ENV: "production",
        TZ: "UTC",
      });
    });
  });

  describe("clampTimeoutMs (bounded wall-clock)", () => {
    it("clamps a model-supplied timeout above MAX_TIMEOUT_MS down to the ceiling", () => {
      // A jailed script must not be able to pin a child for ~11.5 days
      // (timeoutMs: 999_999_999). The clamp caps it at MAX_TIMEOUT_MS.
      expect(clampTimeoutMs(999_999_999)).toBe(MAX_TIMEOUT_MS);
    });

    it("passes a sane in-range timeout through unchanged", () => {
      expect(clampTimeoutMs(30_000)).toBe(30_000);
    });

    it("falls back to DEFAULT_TIMEOUT_MS for a missing / non-positive value", () => {
      expect(clampTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
      expect(clampTimeoutMs(0)).toBe(DEFAULT_TIMEOUT_MS);
      expect(clampTimeoutMs(-5)).toBe(DEFAULT_TIMEOUT_MS);
    });

    it("keeps MAX_TIMEOUT_MS itself a bounded ceiling (not larger than 10 minutes)", () => {
      expect(MAX_TIMEOUT_MS).toBeLessThanOrEqual(10 * 60_000);
      expect(MAX_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
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
    // merged AFTER the scrub).
    expect(childEnv!.COMIS_CAP_LEASE).toBe("lease-xyz");
    expect(childEnv!.COMIS_ORCH_SOCKET).toBe(capSocketPath);
  });

  // -------------------------------------------------------------------------
  // Per-run child lease (D5, EXPLAIN-01). When the daemon threads a
  // `mintRunLease(runId, timeoutMs)` seam, the runner mints a per-run CHILD
  // bearer and injects it as COMIS_CAP_LEASE — OVERRIDING the assembly bearer
  // that rides brokerSpawnEnv.placeholders. Every in-jail cap call for the run
  // then audits under THAT run's leaseId (INV-1 correlator). Two sequential
  // runs on the same tool instance must mint TWICE (disjoint bearers). Absent
  // the seam (older wiring), the runner falls back to the assembly bearer —
  // never an unauthenticated run.
  // -------------------------------------------------------------------------
  describe("per-run child lease bearer (mintRunLease seam, D5)", () => {
    it("injects a DISJOINT per-run child bearer per run as COMIS_CAP_LEASE, called with (runId, timeoutMs)", async () => {
      // A mintRunLease stub: record each (runId, timeoutMs) + return a UNIQUE
      // {leaseId,bearer} per call (the daemon seam that mints the real child
      // lease is proven in setup-tools-autonomy.test.ts — HERE we prove the
      // RUNNER consumes it, once per run, and overrides the assembly bearer).
      const calls: Array<{ runId: string; timeoutMs: number }> = [];
      let n = 0;
      const mintRunLease = vi.fn((runId: string, timeoutMs: number) => {
        calls.push({ runId, timeoutMs });
        n += 1;
        return { leaseId: `child-lease-${n}`, bearer: `child-bearer-${n}` };
      });

      const envs: Array<Record<string, string | undefined>> = [];
      const spawnFn: OrchestrateSpawnFn = (_bin, _args, opts) => {
        envs.push(opts?.env ?? {});
        return makeFakeChild("ok\n");
      };
      const { deps } = makeDeps({ spawnFn, mintRunLease });
      const tool = createOrchestrateTool(deps);

      await tool.execute("call-1", { script: "1", language: "ts", timeoutMs: 42_000 });
      await tool.execute("call-2", { script: "2", language: "ts", timeoutMs: 42_000 });

      // Two sequential runs → the seam is invoked TWICE (per-run mint).
      expect(mintRunLease).toHaveBeenCalledTimes(2);
      // Each call carries the run's OWN runId + the resolved run timeout.
      expect(calls[0]!.timeoutMs).toBe(42_000);
      expect(calls[1]!.timeoutMs).toBe(42_000);
      // The two runIds are DISTINCT (per-run) → the two child leases are disjoint.
      expect(calls[0]!.runId).not.toBe(calls[1]!.runId);
      expect(calls[0]!.runId.length).toBeGreaterThan(0);
      // The per-run CHILD bearer rides COMIS_CAP_LEASE — NOT the assembly
      // bearer ("lease-xyz") from brokerSpawnEnv.placeholders.
      expect(envs[0]!.COMIS_CAP_LEASE).toBe("child-bearer-1");
      expect(envs[1]!.COMIS_CAP_LEASE).toBe("child-bearer-2");
      expect(envs[0]!.COMIS_CAP_LEASE).not.toBe("lease-xyz");
      // The cap socket still comes from the assembly placeholders (unchanged).
      expect(envs[0]!.COMIS_ORCH_SOCKET).toBe(capSocketPath);
    });

    it("clamps the child mint to the run timeout — passes the clamped timeoutMs (not the raw request)", async () => {
      // A model-supplied timeout above the ceiling is clamped BEFORE the mint,
      // so the child lease TTL can never exceed MAX_TIMEOUT_MS.
      let seenTimeoutMs: number | undefined;
      const mintRunLease = vi.fn((_runId: string, timeoutMs: number) => {
        seenTimeoutMs = timeoutMs;
        return { leaseId: "child-lease", bearer: "child-bearer" };
      });
      const { deps } = makeDeps({ mintRunLease });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts", timeoutMs: 999_999_999 });

      expect(seenTimeoutMs).toBe(MAX_TIMEOUT_MS);
    });

    it("falls back to the assembly bearer when NO mintRunLease seam is wired (never an unauthenticated run)", async () => {
      let childEnv: Record<string, string | undefined> | undefined;
      const spawnFn: OrchestrateSpawnFn = (_bin, _args, opts) => {
        childEnv = opts?.env;
        return makeFakeChild("ok\n");
      };
      // No mintRunLease injected — the older/non-seam wiring path.
      const { deps } = makeDeps({ spawnFn });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts" });

      // The assembly bearer from brokerSpawnEnv.placeholders still authenticates.
      expect(childEnv!.COMIS_CAP_LEASE).toBe("lease-xyz");
    });

    it("does NOT mint a child lease when the jail is unavailable (refuses before the mint)", async () => {
      // The mint happens at the childEnv build (step 5), AFTER the jail-node
      // honest-degrade (step 3). An unavailable jail throws first → no wasted mint.
      const mintRunLease = vi.fn(() => ({ leaseId: "l", bearer: "b" }));
      const { deps } = makeDeps({
        mintRunLease,
        resolveJailNodeFn: () => ({ mode: "unavailable", hint: "no node inside the jail" }),
      });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts" }).catch(() => {});

      expect(mintRunLease).not.toHaveBeenCalled();
    });
  });

  it("honest-degrades on an unavailable jail (no node/bwrap) — throws, NO spawn", async () => {
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

  // -- Bind the comis-agent binary + honest-degrade the CLI surface --

  describe("comis-agent CLI bind + honest-degrade", () => {
    const binPath = "/jail/comis-agent-entry.js";

    /** Capture the spawn bin/args + the child env (the runner's only spawn seam). */
    function captureSpawn(): {
      spawnFn: OrchestrateSpawnFn;
      captured: { args: string[]; env: Record<string, string | undefined> };
    } {
      const captured = { args: [] as string[], env: {} as Record<string, string | undefined> };
      const spawnFn: OrchestrateSpawnFn = (_bin, args, opts) => {
        captured.args = args;
        captured.env = opts?.env ?? {};
        return makeFakeChild("ok\n");
      };
      return { spawnFn, captured };
    }

    /** True iff `target` appears as an adjacent `--ro-bind src dest` triple. */
    function hasRoBind(args: string[], target: string): boolean {
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === "--ro-bind" && args[i + 1] === target && args[i + 2] === target) {
          return true;
        }
      }
      return false;
    }

    it("when the comis-agent binary resolves (bind): RO-binds it AND sets COMIS_AGENT_BIN", async () => {
      const { spawnFn, captured } = captureSpawn();
      const { deps } = makeDeps({
        spawnFn,
        resolveJailAgentCliFn: () => ({ mode: "bind", binPath }),
      });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts" });

      // The binary is RO-bound (read-only — a writable binary is a host-RCE vector).
      expect(hasRoBind(captured.args, binPath)).toBe(true);
      // COMIS_AGENT_BIN is set so the in-jail comis-agent CLI resolves; it is NOT
      // a secret, so it survives (set after the scrub, like the lease vars).
      expect(captured.env.COMIS_AGENT_BIN).toBe(binPath);
      // The lease vars still survive alongside it.
      expect(captured.env.COMIS_CAP_LEASE).toBe("lease-xyz");
    });

    it("when the comis-agent binary is unavailable: the jail STILL launches (script surface), NO bind, NO COMIS_AGENT_BIN", async () => {
      const { spawnFn, captured } = captureSpawn();
      const { deps } = makeDeps({
        spawnFn,
        resolveJailAgentCliFn: () => ({ mode: "unavailable", hint: "comis-agent binary missing" }),
      });
      const tool = createOrchestrateTool(deps);

      // A missing/tampered CLI binary degrades ONLY the CLI surface — the run
      // (the orchestrate SCRIPT surface) STILL completes (contrast: a node-
      // unavailable throws/refuses the whole jail).
      const result = await tool.execute("c", { script: "1", language: "ts" });
      const text = result.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
      expect(text).toContain("ok");

      // No comis-agent bind and no COMIS_AGENT_BIN env (never a silent bind).
      expect(captured.args).not.toContain(binPath);
      expect(captured.env.COMIS_AGENT_BIN).toBeUndefined();
    });

    it("emits a content-free WARN (errorKind precondition) naming the unavailable CLI surface, NOT the hash/bytes", async () => {
      const warnCalls: Array<{ fields: Record<string, unknown>; msg: string }> = [];
      const logger: ComisLogger = (() => {
        const noop = (): void => {};
        const base: ComisLogger = {
          level: "silent",
          trace: noop,
          debug: noop,
          info: noop,
          warn: (a?: unknown, b?: unknown) => {
            warnCalls.push({
              fields: (a ?? {}) as Record<string, unknown>,
              msg: typeof b === "string" ? b : "",
            });
          },
          error: noop,
          fatal: noop,
          audit: noop,
          child: () => base,
        };
        return base;
      })();
      const { deps } = makeDeps({
        logger,
        resolveJailAgentCliFn: () => ({
          mode: "unavailable",
          hint: "The comis-agent CLI binary was not found … CLI surface UNAVAILABLE",
        }),
      });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts" });

      const cliWarn = warnCalls.find((w) => /comis-agent/i.test(w.msg));
      expect(cliWarn, "expected a WARN naming the comis-agent CLI surface").toBeDefined();
      expect(cliWarn!.fields.errorKind).toBe("precondition");
      // The hint rides the WARN; it must NOT carry the raw hash digest / bytes.
      const hint = String(cliWarn!.fields.hint ?? "");
      expect(hint).not.toMatch(/[0-9a-f]{64}/);
    });
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

  it("calls cleanupRun on the runId after the run completes (run lifecycle)", async () => {
    const { deps, cleanupRun } = makeDeps();
    const tool = createOrchestrateTool(deps);

    await tool.execute("c", { script: "1", language: "ts" });

    expect(cleanupRun).toHaveBeenCalledTimes(1);
    const arg = cleanupRun.mock.calls[0][0] as { workspacePath: string; runId: string };
    expect(arg.workspacePath).toBe(workspacePath);
    expect(typeof arg.runId).toBe("string");
    expect(arg.runId.length).toBeGreaterThan(0);
  });

  it("calls cleanupRun even when the jailed child fails (runs in the finally)", async () => {
    const spawnFn: OrchestrateSpawnFn = () => makeFakeChild("partial", 1);
    const { deps, cleanupRun } = makeDeps({ spawnFn });
    const tool = createOrchestrateTool(deps);

    await tool.execute("c", { script: "1", language: "ts" }).catch(() => {});

    expect(cleanupRun).toHaveBeenCalledTimes(1);
  });

  // Diagnosability: if a failing orchestrate script surfaced ONLY "jailed child
  // exited with code 1", the child's stderr — the REAL cause, e.g.
  // `content.trim is not a function` when the model's script mishandles the
  // structured comis_tools.read result — would be read+discarded, and an
  // operator/agent could not diagnose WHY without re-running with try/catch.
  // The non-zero-exit error must carry a BOUNDED stderr tail. (Success path stays
  // stdout-only — the tail is surfaced ONLY on a non-zero exit.)
  it("surfaces the jailed child's stderr tail on a non-zero exit (diagnosability)", async () => {
    const stderr =
      "file:///w/run.ts:5\n  const lines = content.trim().split('\\n');\n" +
      "TypeError: content.trim is not a function\n    at file:///w/run.ts:5:28";
    const spawnFn: OrchestrateSpawnFn = () => makeFakeChild("", 1, stderr);
    const { deps } = makeDeps({ spawnFn });
    const tool = createOrchestrateTool(deps);

    await expect(tool.execute("c", { script: "1", language: "ts" })).rejects.toThrow(
      /content\.trim is not a function/,
    );
  });

  it("does NOT append stderr on a SUCCESSFUL run (stdout-only is preserved)", async () => {
    // A 0-exit run with noisy stderr must still return ONLY its stdout — the tail
    // is a failure-path diagnostic, never context pollution on success.
    const spawnFn: OrchestrateSpawnFn = () =>
      makeFakeChild("THE-ANSWER\n", 0, "warning: deprecation notice on stderr");
    const { deps } = makeDeps({ spawnFn });
    const tool = createOrchestrateTool(deps);

    const res = await tool.execute("c", { script: "1", language: "ts" });
    const text = JSON.stringify(res);
    expect(text).toContain("THE-ANSWER");
    expect(text).not.toContain("deprecation notice");
  });

  it("rejects (and surfaces the error) when the spawned child emits an 'error' event", async () => {
    // A child that successfully SPAWNS but then emits a runtime `error` event
    // (e.g. the bwrap exec itself fails post-fork) — distinct from a synchronous
    // spawn throw. The runner's `child.on("error")` handler must clear the
    // timeout and reject with that error (NEVER a silent success), and the
    // finally must still run cleanupRun.
    const child = new EventEmitter() as unknown as OrchestrateSpawnedChild & EventEmitter;
    (child as { stdout: EventEmitter }).stdout = new EventEmitter();
    (child as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as { kill: () => void }).kill = () => {};
    setImmediate(() => child.emit("error", new Error("spawn ENOEXEC bwrap")));
    const spawnFn: OrchestrateSpawnFn = () => child;
    const { deps, cleanupRun } = makeDeps({ spawnFn });
    const tool = createOrchestrateTool(deps);

    await expect(tool.execute("c", { script: "1", language: "ts" })).rejects.toThrow(
      /ENOEXEC|spawn|bwrap/i,
    );
    expect(cleanupRun).toHaveBeenCalledTimes(1);
  });

  it("uses the DEFAULT jail-node resolver when none is injected (resolves the daemon node, runs)", async () => {
    // Every other test injects resolveJailNodeFn; this one OMITS it so the real
    // defaultResolveJailNode runs — it probes SYSTEM_RO_PATHS for a node binary
    // and falls back to binding process.execPath (the node running vitest), which
    // exists on disk → a non-"unavailable" resolution. The run then proceeds with
    // the injected fake spawn, proving the default resolver returned a usable mode
    // (and exercising readExecPath). On a host genuinely missing node this would
    // honest-degrade instead; that path is covered by the explicit-unavailable test.
    let spawned = false;
    const spawnFn: OrchestrateSpawnFn = () => {
      spawned = true;
      return makeFakeChild("default-resolver-ok\n");
    };
    const { deps } = makeDeps({ spawnFn });
    // Drop the injected resolver so the production default is used.
    delete (deps as { resolveJailNodeFn?: unknown }).resolveJailNodeFn;
    const tool = createOrchestrateTool(deps);

    const result = await tool.execute("c", { script: "console.log(1)", language: "ts" });

    expect(spawned).toBe(true);
    const text = result.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    expect(text).toContain("default-resolver-ok");
  });

  // -------------------------------------------------------------------------
  // The parent's seccomp fd MUST be closed once the child has been
  // spawned. The fd is opened WITHOUT O_CLOEXEC (so the bwrap child inherits
  // it), so the daemon keeps its OWN copy after fork — leaking one descriptor
  // per orchestrate run exhausts the fd table on a long-running daemon
  // (seccomp-profile.ts documents this lifecycle as MANDATORY). On the
  // macOS unit path the real loader returns null (blob absent), so we inject a
  // REAL fd (a temp file stands in for the BPF blob) and prove the runner
  // releases the PARENT copy: fstatSync on it after the run must fail EBADF (a
  // leaked fd would still fstat cleanly). This is the property the production
  // (Linux) path relies on.
  // -------------------------------------------------------------------------
  describe("seccomp fd lifecycle (close in finally)", () => {
    let fdDir: string;
    let realFd: number;

    beforeEach(() => {
      fdDir = mkdtempSync(join(tmpdir(), "comis-orch-seccomp-fd-"));
      realFd = openSync(join(fdDir, "blob"), "w");
      writeSync(realFd, Buffer.from([0])); // make it a genuine, open fd
    });

    afterEach(() => {
      // Best-effort cleanup if a regression left the fd open.
      try {
        fstatSync(realFd);
        // still open → close so the test process does not leak it
        closeSync(realFd);
      } catch {
        /* already closed by the runner (the GREEN expectation) */
      }
      rmSync(fdDir, { recursive: true, force: true });
    });

    it("closes the parent's seccomp fd after a successful jailed run (no fd leak)", async () => {
      const { deps } = makeDeps({ loadSeccompFdFn: () => realFd });
      const tool = createOrchestrateTool(deps);

      // Pre-condition: the parent's copy is open before the run.
      expect(() => fstatSync(realFd)).not.toThrow();

      await tool.execute("c", { script: "1", language: "ts" });

      // The runner must have closed the PARENT's copy in its finally.
      let err: NodeJS.ErrnoException | undefined;
      try {
        fstatSync(realFd);
      } catch (e) {
        err = e as NodeJS.ErrnoException;
      }
      expect(err).toBeDefined();
      expect(err?.code).toBe("EBADF");
    });

    it("closes the parent's seccomp fd even when the spawn throws (finally on the error path)", async () => {
      const spawnFn: OrchestrateSpawnFn = () => {
        throw new Error("spawn EACCES");
      };
      const { deps } = makeDeps({ spawnFn, loadSeccompFdFn: () => realFd });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts" }).catch(() => {});

      // A spawn that throws still opened the parent's fd — the finally must
      // close it regardless (seccomp-profile.ts: "do NOT skip the finally on
      // the spawn error path").
      let err: NodeJS.ErrnoException | undefined;
      try {
        fstatSync(realFd);
      } catch (e) {
        err = e as NodeJS.ErrnoException;
      }
      expect(err).toBeDefined();
      expect(err?.code).toBe("EBADF");
    });
  });

  // -------------------------------------------------------------------------
  // The daemon-side stdout collector must be BYTE-CAPPED in-stream. The
  // STDOUT_MAX_CHARS bounce only runs AFTER the child exits, so without an
  // in-stream ceiling a jailed (attacker-controlled) script running
  // `while (true) console.log("A".repeat(1e6))` grows the daemon heap without
  // bound for the whole run. The fix fails CLOSED: stop appending past a hard
  // ceiling and SIGKILL the child.
  // -------------------------------------------------------------------------
  describe("stdout hard cap (in-stream OOM guard)", () => {
    /** A fake child that emits ONE over-cap stdout chunk, then would close. */
    function makeFloodingChild(killSpy: () => void): OrchestrateSpawnedChild {
      const child = new EventEmitter() as unknown as OrchestrateSpawnedChild & EventEmitter;
      const out = new EventEmitter();
      const err = new EventEmitter();
      (child as { stdout: EventEmitter }).stdout = out;
      (child as { stderr: EventEmitter }).stderr = err;
      (child as { kill: () => void }).kill = killSpy;
      setImmediate(() => {
        // One chunk strictly larger than the hard cap — must trip the guard on
        // the first `data` event, before any `close`.
        out.emit("data", Buffer.alloc(STDOUT_HARD_CAP_BYTES + 1, 0x41));
        // A close MAY follow; the guard must already have settled (rejected).
        child.emit("close", 0);
      });
      return child;
    }

    it("keeps STDOUT_HARD_CAP_BYTES a bounded ceiling (a few MiB, not unbounded)", () => {
      expect(STDOUT_HARD_CAP_BYTES).toBeGreaterThan(0);
      expect(STDOUT_HARD_CAP_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
    });

    it("kills the child and rejects when the jailed stdout exceeds the hard cap", async () => {
      const killSpy = vi.fn();
      const spawnFn: OrchestrateSpawnFn = () => makeFloodingChild(killSpy);
      const { deps } = makeDeps({ spawnFn });
      const tool = createOrchestrateTool(deps);

      await expect(
        tool.execute("c", { script: "1", language: "ts" }),
      ).rejects.toThrow(/hard cap|exceeded|too large/i);

      // Fail-closed: the runaway child is SIGKILLed.
      expect(killSpy).toHaveBeenCalled();
    });
  });
});
