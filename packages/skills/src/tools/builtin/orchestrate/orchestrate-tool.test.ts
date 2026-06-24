// SPDX-License-Identifier: Apache-2.0
/**
 * macOS-unit tests for the `orchestrate` runner (ORCH-01/02). The Linux-gated
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
    cleanupRun?: ReturnType<typeof vi.fn>;
    baseEnv?: Record<string, string | undefined>;
    loadSeccompFdFn?: () => number | null;
  }) {
    const cleanupRun = over?.cleanupRun ?? vi.fn(async () => {});
    return {
      deps: {
        logger: makeLogger(),
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
        loadSeccompFdFn: over?.loadSeccompFdFn ?? (() => null),
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

  // Live VPS finding (2026-06-23): the runner passes `tempDir: <workspace>/.tmp`
  // to BwrapProvider.buildArgs, which `--bind`s it into the jail — and bwrap
  // requires the bind SOURCE to exist. The runner never created `.tmp`, so EVERY
  // real jailed run died at construction with `bwrap: Can't find source path
  // .../.tmp: No such file or directory` → exit 1, breaking the orchestrate
  // happy-path. (Passed every macOS unit test because they inject a fake spawn
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

    it("drops common credential names that contain no KEY/TOKEN/SECRET substring (IN-01 defense-in-depth)", () => {
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

  describe("clampTimeoutMs (WR-02 — bounded wall-clock)", () => {
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
  // CR-01: the parent's seccomp fd MUST be closed once the child has been
  // spawned. The fd is opened WITHOUT O_CLOEXEC (so the bwrap child inherits
  // it), so the daemon keeps its OWN copy after fork — leaking one descriptor
  // per orchestrate run exhausts the fd table on a long-running daemon
  // (seccomp-profile.ts:21-43 documents this lifecycle as MANDATORY). On the
  // macOS unit path the real loader returns null (blob absent), so we inject a
  // REAL fd (a temp file stands in for the BPF blob) and prove the runner
  // releases the PARENT copy: fstatSync on it after the run must fail EBADF (a
  // leaked fd would still fstat cleanly). This is the property the production
  // (Linux) path relies on.
  // -------------------------------------------------------------------------
  describe("CR-01 seccomp fd lifecycle (close in finally)", () => {
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
  // WR-01: the daemon-side stdout collector must be BYTE-CAPPED in-stream. The
  // STDOUT_MAX_CHARS bounce only runs AFTER the child exits, so without an
  // in-stream ceiling a jailed (attacker-controlled) script running
  // `while (true) console.log("A".repeat(1e6))` grows the daemon heap without
  // bound for the whole run. The fix fails CLOSED: stop appending past a hard
  // ceiling and SIGKILL the child.
  // -------------------------------------------------------------------------
  describe("WR-01 stdout hard cap (in-stream OOM guard)", () => {
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
