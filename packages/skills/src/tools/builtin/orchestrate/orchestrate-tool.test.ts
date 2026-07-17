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

import { runWithContext } from "@comis/core";
import type { AgentCapability, ComisLogger, DurableRunRecord, DurableRunResumeClaimOutcome, RequestContext } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

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
import type { OrchestrateDurableRuns } from "./orchestrate-durable.js";
import { estimateSavings } from "./savings-estimate.js";
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

function makeApprovalContext(): RequestContext {
  return {
    tenantId: "default",
    userId: "test-user",
    agentId: "test-agent",
    sessionKey: "default:test-user:chat-1",
    traceId: "10000000-0000-4000-8000-000000000001",
    startedAt: 1,
    trustLevel: "guest",
    channelType: "telegram",
    deliveryOrigin: Object.freeze({
      tenantId: "default", userId: "test-user", channelType: "telegram", channelId: "chat-1",
    }),
  };
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
    // A fixture SDK-assets dir holding the files the runner copies into the
    // jail. (In production this dir is the built module dir, which carries the
    // committed comis_tools.{d.ts,js,py} + the compiled orchestrate-sdk-runtime.js;
    // the source dir lacks the compiled .js, so the unit suite injects a fixture.)
    // comis_tools.py MUST be written too: it is in SDK_ASSETS, so the runner's
    // unconditional copy loop would ENOENT without it.
    sdkAssetsDir = mkdtempSync(join(tmpdir(), "comis-orch-sdk-"));
    writeFileSync(join(sdkAssetsDir, "comis_tools.d.ts"), "// d.ts\n");
    writeFileSync(join(sdkAssetsDir, "comis_tools.js"), "// js\n");
    writeFileSync(join(sdkAssetsDir, "comis_tools.py"), "# py\n");
    writeFileSync(join(sdkAssetsDir, "orchestrate-sdk-runtime.js"), "// runtime\n");
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(sdkAssetsDir, { recursive: true, force: true });
  });

  function makeDeps(over?: {
    spawnFn?: OrchestrateSpawnFn;
    resolveJailNodeFn?: () => { mode: "path" } | { mode: "bind"; execPath: string } | { mode: "unavailable"; hint: string };
    resolveJailPythonFn?: () => { mode: "path"; pythonBin: string } | { mode: "unavailable"; hint: string };
    resolveJailAgentCliFn?: () => { mode: "bind"; binPath: string } | { mode: "unavailable"; hint: string };
    logger?: ComisLogger;
    cleanupRun?: ReturnType<typeof vi.fn>;
    baseEnv?: Record<string, string | undefined>;
    loadSeccompFdFn?: () => number | null;
    mintRunLease?: (runId: string, timeoutMs: number) => { leaseId: string; bearer: string };
    eventBus?: { emit: (event: string, payload: Record<string, unknown>) => unknown };
    runAggregate?: (ctx: { workspacePath: string; runId: string }) => { count: number; bytes: number };
    rootRunId?: string;
    sessionKey?: string;
    trustLevel?: "admin" | "user" | "guest";
    // Drop the broker lease env so the child gets NO COMIS_CAP_LEASE (the
    // lease_absent run_summary case).
    dropBrokerSpawnEnv?: boolean;
    // The static pre-flight seams (allowedCaps/approvalGate) + the declared repair
    // contract (capabilityClass/repairSeam — unused by the pre-flight tests,
    // consumed by the one-shot repair path). Conditional-spread like mintRunLease/eventBus.
    allowedCaps?: readonly AgentCapability[];
    approvalGate?: {
      requestApproval: (req: {
        toolName: string;
        action: string;
        params: Record<string, unknown>;
        fingerprintParams: Record<string, unknown>;
        agentId: string;
        sessionKey: string;
        trustLevel: "admin" | "user" | "guest";
        channelType?: string;
      }) => Promise<{ approved: boolean; reason?: string }>;
    };
    capabilityClass?: "frontier" | "mid" | "small" | "nano";
    repairSeam?: (input: {
      script: string;
      language: "ts" | "js" | "py";
      stderrTail: string;
      describeDigest: string;
    }) => Promise<string | undefined>;
    // The durable-run store seam (threaded ONLY when orchestrateResume is on).
    // Present ⇒ the run registers a resumable row + honors resumeRunId + skips
    // cleanupRun on a timeout. Conditional-spread like mintRunLease/eventBus.
    durableRuns?: OrchestrateDurableRuns;
  }) {
    const cleanupRun = over?.cleanupRun ?? vi.fn(async () => {});
    const durableTrust = over?.trustLevel ?? "user";
    const durableSessionKey = over?.sessionKey ?? "tenant-a:user-a:chat-a";
    return {
      deps: {
        logger: over?.logger ?? makeLogger(),
        trustLevel: durableTrust,
        workspaceResolver: () => workspacePath,
        capSocketPath,
        sandbox: new BwrapProvider(),
        sdkAssetsDir,
        ...(over?.dropBrokerSpawnEnv
          ? {}
          : {
              brokerSpawnEnv: {
                placeholders: {
                  COMIS_CAP_LEASE: "lease-xyz",
                  COMIS_ORCH_SOCKET: capSocketPath,
                },
              },
            }),
        store: {
          materialize: vi.fn(),
          gcRun: vi.fn(async () => {}),
          cleanupRun,
          ...(over?.runAggregate ? { runAggregate: over.runAggregate } : {}),
        },
        spawnFn: over?.spawnFn ?? ((): OrchestrateSpawnedChild => makeFakeChild("ok-output\n")),
        resolveJailNodeFn: over?.resolveJailNodeFn ?? (() => ({ mode: "path" as const })),
        // Default to a resolved host python3 so a language:"py" run selects the
        // interpreter by its absolute path unless a test overrides it.
        resolveJailPythonFn:
          over?.resolveJailPythonFn ??
          (() => ({ mode: "path" as const, pythonBin: "/usr/bin/python3" })),
        // Default to a bound comis-agent so the CLI surface is on unless a test
        // overrides it (the default keeps unrelated tests' env/args stable).
        resolveJailAgentCliFn:
          over?.resolveJailAgentCliFn ??
          (() => ({ mode: "bind" as const, binPath: "/jail/comis-agent-entry.js" })),
        loadSeccompFdFn: over?.loadSeccompFdFn ?? (() => null),
        now: () => 1_700_000_000_000,
        baseEnv: over?.baseEnv ?? { PATH: "/usr/bin", HOME: "/home/x" },
        ...(over?.mintRunLease ? { mintRunLease: over.mintRunLease } : {}),
        ...(over?.eventBus ? { eventBus: over.eventBus } : {}),
        ...(over?.rootRunId !== undefined ? { rootRunId: over.rootRunId } : {}),
        ...(over?.sessionKey !== undefined ? { sessionKey: over.sessionKey } : {}),
        ...(over?.allowedCaps !== undefined ? { allowedCaps: over.allowedCaps } : {}),
        ...(over?.approvalGate ? { approvalGate: over.approvalGate } : {}),
        ...(over?.capabilityClass !== undefined ? { capabilityClass: over.capabilityClass } : {}),
        ...(over?.repairSeam ? { repairSeam: over.repairSeam } : {}),
        ...(over?.durableRuns
          ? {
              durableRuns: over.durableRuns,
              durablePrincipal: {
                agentId: "agent-a",
                sessionKey: durableSessionKey,
                ownerTenantId: "tenant-a",
                ownerUserId: "user-a",
                deliveryOrigin: null,
                trustLevel: durableTrust,
                caps: over.allowedCaps ?? [],
              },
            }
          : {}),
      },
      cleanupRun,
    };
  }

  /**
   * A fake durable-run store: captures every upsert + serves a canned
   * getByCheckpoint, so the resumable-row writes + the resume lookup are assertable
   * without a real sqlite store.
   */
  function makeFakeDurableRuns(over?: {
    getRow?: DurableRunRecord;
    upsertError?: Error;
  }): OrchestrateDurableRuns & {
    upserts: DurableRunRecord[];
    completed: string[];
    orphaned: Array<{ checkpointId: string; reason: string }>;
    claimForResume: ReturnType<typeof vi.fn>;
  } {
    const upserts: DurableRunRecord[] = [];
    const completed: string[] = [];
    const orphaned: Array<{ checkpointId: string; reason: string }> = [];
    return {
      upserts,
      completed,
      orphaned,
      upsertCheckpoint: vi.fn(async (record: DurableRunRecord): Promise<Result<void, Error>> => {
        upserts.push(record);
        return over?.upsertError ? err(over.upsertError) : ok(undefined);
      }),
      getByCheckpoint: vi.fn(
        async (): Promise<Result<DurableRunRecord | undefined, Error>> => ok(over?.getRow),
      ),
      claimForResume: vi.fn(
        async (): Promise<Result<DurableRunResumeClaimOutcome, Error>> =>
          over?.getRow
            ? ok({ kind: "claimed", record: over.getRow })
            : ok({ kind: "not_found" }),
      ),
      markCompleted: vi.fn(async (checkpointId: string): Promise<Result<void, Error>> => {
        completed.push(checkpointId);
        return ok(undefined);
      }),
      markOrphaned: vi.fn(async (checkpointId: string, reason: string): Promise<Result<void, Error>> => {
        orphaned.push({ checkpointId, reason });
        return ok(undefined);
      }),
    };
  }

  /** A recording eventBus stub — captures every emit for run_summary assertions. */
  function makeEventBusSpy(): {
    eventBus: { emit: (event: string, payload: Record<string, unknown>) => unknown };
    emitted: Array<{ event: string; payload: Record<string, unknown> }>;
  } {
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    return {
      emitted,
      eventBus: {
        emit(event: string, payload: Record<string, unknown>) {
          emitted.push({ event, payload });
          return undefined;
        },
      },
    };
  }

  /** A fake child that spawns then hangs forever (never closes) — the timeout trip. */
  function makeHangingChild(): OrchestrateSpawnedChild {
    const child = new EventEmitter() as unknown as OrchestrateSpawnedChild & EventEmitter;
    (child as { stdout: EventEmitter }).stdout = new EventEmitter();
    (child as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as { kill: () => void }).kill = () => {};
    // Never emits "close"/"error" — the run can only settle via the timeout timer.
    return child;
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

  it("writes <workspace>/<runId>.<language> + the comis_tools SDK (js/dts/py) + the runtime before spawning (SDK-write)", async () => {
    let writtenAtSpawn:
      | { script: boolean; sdkJs: boolean; sdkDts: boolean; sdkPy: boolean; runtime: boolean }
      | undefined;
    const spawnFn: OrchestrateSpawnFn = (_bin, args) => {
      // The bash command is `node <scriptName>`; capture the workspace file state
      // NOW (the runner must have written all SDK assets before spawning).
      const scriptName = scriptNameFromArgs(args);
      writtenAtSpawn = {
        script: scriptName !== "" && existsSync(join(workspacePath, scriptName)),
        sdkJs: existsSync(join(workspacePath, "comis_tools.js")),
        sdkDts: existsSync(join(workspacePath, "comis_tools.d.ts")),
        sdkPy: existsSync(join(workspacePath, "comis_tools.py")),
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
    // comis_tools.py is copied into the jail on EVERY run (like the js-unused .d.ts).
    expect(writtenAtSpawn!.sdkPy).toBe(true);
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

  // -------------------------------------------------------------------------
  // The "py" language path: a language:"py" run writes <runId>.py, resolves the
  // RO-bound host python3 via resolveJailPython (2-mode: {path,pythonBin} |
  // {unavailable,hint}), and invokes it by its ABSOLUTE path. An unavailable
  // interpreter REFUSES the run with NO spawn — a missing interpreter must never
  // fall through to a silent unjailed run (fail-closed). The jail envelope is
  // identical to js/ts — no new sandbox primitive.
  // -------------------------------------------------------------------------
  describe("language: 'py' runner path (interpreter selection + fail-closed refuse)", () => {
    it("invokes the resolved absolute pythonBin for a language:'py' run (not a bare python3, not node)", async () => {
      let spawnArgs: string[] | undefined;
      const spawnFn: OrchestrateSpawnFn = (_bin, args) => {
        spawnArgs = args;
        return makeFakeChild("py-out\n");
      };
      const pythonBin = "/usr/bin/python3";
      const { deps } = makeDeps({
        spawnFn,
        resolveJailPythonFn: () => ({ mode: "path", pythonBin }),
      });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "print(1)", language: "py" });

      // Read the RAW `/bin/bash -c` command — NOT scriptNameFromArgs, which only
      // matches `node <script>` and would miss a `<pythonBin> <script>` command.
      const cmdIdx = spawnArgs!.indexOf("-c");
      const command = spawnArgs![cmdIdx + 1] ?? "";
      // The interpreter is the resolved ABSOLUTE pythonBin, and the script is <runId>.py.
      expect(command.startsWith(`${pythonBin} `)).toBe(true);
      const scriptToken = command.slice(pythonBin.length + 1);
      expect(scriptToken.endsWith(".py")).toBe(true);
      // NOT run under node (the ts/js interpreter) and NOT a bare `python3`.
      expect(command).not.toMatch(/^node\s/);
      expect(command).not.toMatch(/^python3\s/);
      // Identical jail envelope — general IP egress is still cut (--unshare-net).
      expect(spawnArgs).toContain("--unshare-net");
    });

    it("honest-degrades a language:'py' run when python is unavailable — throws, NO spawn (never a silent unjailed run)", async () => {
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() => makeFakeChild(""));
      const { deps } = makeDeps({
        spawnFn,
        resolveJailPythonFn: () => ({ mode: "unavailable", hint: "no python3 inside the jail" }),
      });
      const tool = createOrchestrateTool(deps);

      await expect(tool.execute("c", { script: "print(1)", language: "py" })).rejects.toThrow(
        /not_implemented|unavailable|python|no python3 inside the jail/i,
      );
      // The fail-closed safety net: an absent interpreter must NEVER fall through
      // to a silent unjailed run — the spawn seam is never called.
      expect(spawnFn).not.toHaveBeenCalled();
    });

    it("uses the DEFAULT jail-python resolver for a language:'py' run when none is injected (resolves the host python3 by absolute path)", async () => {
      // Every other py test injects resolveJailPythonFn; this one OMITS it so the
      // real defaultResolveJailPython runs — it probes the ABSOLUTE host interpreter
      // bin paths (/usr/bin/python3, /bin/python3, /usr/local/bin/python3), which are
      // present on the dev + CI hosts (macOS has /usr/bin/python3; the Docker image
      // apt-installs python3). The run then proceeds with the injected fake spawn,
      // proving the default resolver returned a usable "path" mode and the interpreter
      // is invoked by its absolute python3 path (never a bare `python3` → exit 127,
      // never node). On a host genuinely missing python3 this would honest-degrade
      // instead; that path is covered by the explicit-unavailable refuse test above.
      let spawnArgs: string[] | undefined;
      const spawnFn: OrchestrateSpawnFn = (_bin, args) => {
        spawnArgs = args;
        return makeFakeChild("py-default-ok\n");
      };
      const { deps } = makeDeps({ spawnFn });
      // Drop the injected python resolver so the production default is used.
      delete (deps as { resolveJailPythonFn?: unknown }).resolveJailPythonFn;
      const tool = createOrchestrateTool(deps);

      const result = await tool.execute("c", { script: "print(1)", language: "py" });

      const text = result.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
      expect(text).toContain("py-default-ok");
      const cmdIdx = spawnArgs!.indexOf("-c");
      const command = spawnArgs![cmdIdx + 1] ?? "";
      // Invoked by an ABSOLUTE python3 path (…/python3 <script>.py) — not node, not bare.
      expect(command).toMatch(/\/python3 \S+\.py$/);
      expect(command).not.toMatch(/^node\s/);
    });
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
  // Per-run child lease. When the daemon threads a
  // `mintRunLease(runId, timeoutMs)` seam, the runner mints a per-run CHILD
  // bearer and injects it as COMIS_CAP_LEASE — OVERRIDING the assembly bearer
  // that rides brokerSpawnEnv.placeholders. Every in-jail cap call for the run
  // then audits under that run's leaseId. Two sequential
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

  // -------------------------------------------------------------------------
  // The per-run child lease TTL must cover the one-shot repair window.
  // The child lease is minted ONCE, before the run engine. When auto-repair is
  // enabled for a run (a repair-eligible class AND a wired repairSeam), the
  // engine awaits ONE utility-model completion — bounded by the seam's ~120s
  // abort ceiling — BETWEEN the initial run and the repaired re-run, all under
  // that SAME lease. A lease sized to the tight `timeoutMs` therefore expires
  // during a slow repair, so the repaired re-run's in-jail cap calls
  // authenticate with a dead lease and are denied at the endpoint (fails closed,
  // but the repair silently no-ops for exactly the slow/local small models the
  // feature targets). The runner must SIZE the child-lease TTL to
  // `timeoutMs + repairBudget` when repair is enabled, and keep the tight
  // `timeoutMs` when it is not — minting the lease exactly ONCE (single-leaseId
  // attribution preserved), sized to the real window.
  // -------------------------------------------------------------------------
  describe("child-lease TTL sizing for the one-shot repair window", () => {
    const importError = "ImportError: cannot import name 'foo' from 'comis_tools'";

    /**
     * A fake lease store keyed by a test-local virtual clock: `mintRunLease`
     * records the bearer's expiry as `clock + ttlMs`; `advance(ms)` moves the
     * clock forward to simulate a slow utility-model repair completion between the
     * two runs; `validAtNow(bearer)` reports whether the lease is unexpired at the
     * current clock — sampled at the re-run's spawn, the exact moment its in-jail
     * cap calls would authenticate. Independent of the runner's own `deps.now`
     * (the real LeaseManager tracks expiry against its own clock; the runner only
     * passes a TTL number).
     */
    function makeLeaseClock(): {
      mintRunLease: ReturnType<typeof vi.fn>;
      advance: (ms: number) => void;
      validAtNow: (bearer: string | undefined) => boolean;
    } {
      let clockMs = 0;
      const leases = new Map<string, { expiresAt: number }>();
      let n = 0;
      const mintRunLease = vi.fn((_runId: string, ttlMs: number) => {
        n += 1;
        const bearer = `child-bearer-${n}`;
        leases.set(bearer, { expiresAt: clockMs + ttlMs });
        return { leaseId: `child-lease-${n}`, bearer };
      });
      return {
        mintRunLease,
        advance: (ms) => {
          clockMs += ms;
        },
        validAtNow: (bearer) => {
          if (bearer === undefined) return false;
          const lease = leases.get(bearer);
          return lease !== undefined && lease.expiresAt > clockMs;
        },
      };
    }

    it("keeps the re-run's lease valid across a slow repair completion when auto-repair is enabled", async () => {
      const timeoutMs = 60_000;
      const clock = makeLeaseClock();

      // The repair seam consumes 90s of wall-clock — PAST the tight `timeoutMs`
      // (60s) lease, but well within a repair-sized `timeoutMs + ~120s` lease.
      const repairSeam = vi.fn(async () => {
        clock.advance(90_000);
        return "const fixed = 1;\n";
      });

      // Sample the re-run's lease validity at the moment its child is spawned.
      let reRunLeaseValidAtSpawn: boolean | undefined;
      let spawnCount = 0;
      const spawnFn = vi.fn<OrchestrateSpawnFn>((_bin, _args, opts) => {
        spawnCount += 1;
        if (spawnCount === 2) {
          reRunLeaseValidAtSpawn = clock.validAtNow(opts?.env?.COMIS_CAP_LEASE);
        }
        return spawnCount === 1
          ? makeFakeChild("", 1, importError)
          : makeFakeChild("repaired-ok\n");
      });

      const { deps } = makeDeps({
        spawnFn,
        capabilityClass: "small",
        repairSeam,
        mintRunLease: clock.mintRunLease,
      });
      const tool = createOrchestrateTool(deps);

      const result = await tool.execute("c", { script: "import x", language: "ts", timeoutMs });

      // The repaired re-run actually ran (its stdout came back) ...
      const text = result.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
      expect(text).toContain("repaired-ok");
      // ... and its lease was STILL VALID when it spawned, so its in-jail cap
      // calls would authenticate. Pre-fix: the tight 60s lease had
      // already expired at t=90s → cap calls denied → silent repair no-op.
      expect(reRunLeaseValidAtSpawn).toBe(true);
      // The lease was minted exactly ONCE (sized, never re-minted — single-leaseId
      // attribution preserved), with a TTL that EXCEEDS the tight run timeout.
      expect(clock.mintRunLease).toHaveBeenCalledTimes(1);
      expect(clock.mintRunLease.mock.calls[0]![1]).toBeGreaterThan(timeoutMs);
    });

    it("keeps the tight timeoutMs TTL when auto-repair is class-gated OFF (frontier)", async () => {
      const timeoutMs = 60_000;
      const clock = makeLeaseClock();
      const repairSeam = vi.fn(async () => "const fixed = 1;\n");
      const { deps } = makeDeps({
        spawnFn: () => makeFakeChild("ok\n"),
        capabilityClass: "frontier",
        repairSeam,
        mintRunLease: clock.mintRunLease,
      });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts", timeoutMs });

      // Repair is OFF for a frontier model — no repair window to cover — so the
      // child lease stays sized to the tight run timeout (TTL unchanged).
      expect(clock.mintRunLease).toHaveBeenCalledTimes(1);
      expect(clock.mintRunLease.mock.calls[0]![1]).toBe(timeoutMs);
    });

    it("keeps the tight timeoutMs TTL when no repair seam is wired even under a small class", async () => {
      const timeoutMs = 45_000;
      const clock = makeLeaseClock();
      const { deps } = makeDeps({
        spawnFn: () => makeFakeChild("ok\n"),
        capabilityClass: "small",
        // No repairSeam → nothing to cover → tight TTL.
        mintRunLease: clock.mintRunLease,
      });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts", timeoutMs });

      expect(clock.mintRunLease).toHaveBeenCalledTimes(1);
      expect(clock.mintRunLease.mock.calls[0]![1]).toBe(timeoutMs);
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

  // ---------------------------------------------------------------------------
  // Static pre-flight gate (fail-fast cap check + reused approval fire).
  // The runner scans the model's script for its capability footprint BEFORE the
  // spawn: a cap the agent lacks fails fast pre-spawn with a cap-named error
  // (no jail burned), and — when an approval gate is wired (approvals.enabled) —
  // one approval fires on the whole cap footprint. The pre-flight is ADVISORY UX
  // only. A script that dodges the static scan (a dynamic/computed call → empty
  // footprint) still proceeds here; the authoritative cap-socket endpoint
  // (unchanged this phase) remains the sole boundary.
  // ---------------------------------------------------------------------------
  describe("static pre-flight gate (fail-fast cap check + approval fire + advisory-only)", () => {
    it("rejects a script needing a cap the agent lacks BEFORE spawning, naming the missing orch:* cap (no child spawned)", async () => {
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() => makeFakeChild("ok\n"));
      // Held caps = orch:read only; the script calls web_fetch (which needs orch:web).
      const { deps } = makeDeps({ spawnFn, allowedCaps: ["orch:read"] });
      const tool = createOrchestrateTool(deps);

      await expect(
        tool.execute("c", {
          script: "await comis_tools.web_fetch({url:'https://x'});",
          language: "ts",
        }),
      ).rejects.toThrow(/orch:web/);

      // Fail-fast: the missing-cap rejection fires PRE-SPAWN — no jail is burned.
      expect(spawnFn).not.toHaveBeenCalled();
    });

    it("when approvals are configured (approved): fires requestApproval ONCE on the exact sorted cap set, then proceeds to spawn", async () => {
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() => makeFakeChild("ok\n"));
      const requestApproval = vi.fn(async () => ({ approved: true }));
      const { deps } = makeDeps({
        spawnFn,
        allowedCaps: ["orch:web"],
        approvalGate: { requestApproval },
      });
      const tool = createOrchestrateTool(deps);

      await runWithContext(makeApprovalContext(), () =>
        tool.execute("c", {
          script: "await comis_tools.web_fetch({url:'https://x'});",
          language: "ts",
        }),
      );

      // The approval fires exactly once, on the exact cap footprint.
      expect(requestApproval).toHaveBeenCalledTimes(1);
      const req = requestApproval.mock.calls[0]![0] as {
        toolName: string;
        action: string;
        params: { caps?: unknown };
        fingerprintParams: { caps?: unknown };
      };
      expect(req.toolName).toBe("orchestrate");
      // The action string encodes the exact (sorted) cap set.
      expect(req.action).toContain("orch:web");
      expect(req.params.caps).toEqual(["orch:web"]);
      expect(req.fingerprintParams.caps).toEqual(["orch:web"]);
      expect((req as { trustLevel?: string }).trustLevel).toBe("guest");
      expect((req as { agentId?: string }).agentId).toBe("test-agent");
      // Approved → the run proceeds to spawn.
      expect(spawnFn).toHaveBeenCalledTimes(1);
    });

    it("when approvals are configured (denied): a !approved resolution refuses the run with the reason in the hint — no child spawned", async () => {
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() => makeFakeChild("ok\n"));
      const requestApproval = vi.fn(async () => ({ approved: false, reason: "operator said no" }));
      const { deps } = makeDeps({
        spawnFn,
        allowedCaps: ["orch:web"],
        approvalGate: { requestApproval },
      });
      const tool = createOrchestrateTool(deps);

      const err = await runWithContext(makeApprovalContext(), () => tool
        .execute("c", {
          script: "await comis_tools.web_fetch({url:'https://x'});",
          language: "ts",
        }))
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );

      expect(requestApproval).toHaveBeenCalledTimes(1);
      expect(err).toBeInstanceOf(Error);
      // The denial refuses the run; the resolution reason rides the hint.
      expect(err!.message).toMatch(/denied by the approval workflow/i);
      expect(err!.message).toContain("operator said no");
      // Denied → fail-fast, no spawn.
      expect(spawnFn).not.toHaveBeenCalled();
    });

    it("fails closed before approval submission when the resolved agent identity is absent", async () => {
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() => makeFakeChild("ok\n"));
      const requestApproval = vi.fn(async () => ({ approved: true }));
      const { deps } = makeDeps({
        spawnFn,
        allowedCaps: ["orch:web"],
        approvalGate: { requestApproval },
      });
      const tool = createOrchestrateTool(deps);

      await expect(tool.execute("c", {
        script: "await comis_tools.web_fetch({url:'https://x'});",
        language: "ts",
      })).rejects.toThrow(/resolved request identity/i);

      expect(requestApproval).not.toHaveBeenCalled();
      expect(spawnFn).not.toHaveBeenCalled();
    });

    it("advisory-only: a script whose static footprint is EMPTY (a dynamic/computed call) passes pre-flight and proceeds to spawn — the endpoint stays the sole gate", async () => {
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() => makeFakeChild("dodged\n"));
      // Held caps = orch:read only. The script reaches web_fetch through a computed
      // member (comis_tools[m]) the token scan cannot see → empty footprint. The
      // pre-flight must NOT reject on a missing cap (it is fail-fast UX, NOT the
      // security gate); the authoritative cap-socket endpoint (default-deny by
      // absence, unchanged this phase) denies orch:web at runtime.
      const { deps } = makeDeps({ spawnFn, allowedCaps: ["orch:read"] });
      const tool = createOrchestrateTool(deps);

      const result = await tool.execute("c", {
        script: "const m = 'web_fetch'; await comis_tools[m]({});",
        language: "ts",
      });

      const text = result.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
      expect(text).toContain("dodged");
      // Advisory: the run proceeded to spawn despite calling a cap the agent lacks.
      expect(spawnFn).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // One-shot auto-repair (class-gated, bounded to exactly one attempt).
  // On a non-zero exit whose bounded stderr tail matches a known-recoverable
  // class (a bad import / comis_tools misuse / TypeError), the runner does ONE
  // utility-model re-prompt (the injected repairSeam) to regenerate the script
  // and re-runs it EXACTLY once. Class-gated: ON for weaker models (small/nano),
  // OFF for stronger (frontier/mid). The repair resolves the FINAL outcome BEFORE
  // the terminal run_summary emit, so a repaired-then-succeeded run emits exactly
  // ONE (success) summary — never a failure+success pair. A repaired-then-failed
  // run surfaces the ORIGINAL bounded error; there is no loop. The regenerated
  // script re-runs in the identical jail/cap/lease envelope (same blast radius);
  // the cap-socket endpoint stays the sole authoritative boundary.
  // ---------------------------------------------------------------------------
  describe("one-shot repair (class-gated auto-repair, bounded to one, single run_summary)", () => {
    const importError = "ImportError: cannot import name 'foo' from 'comis_tools'";

    /** The run_summary payloads captured by an event-bus spy. */
    function runSummaries(
      emitted: Array<{ event: string; payload: Record<string, unknown> }>,
    ): Array<Record<string, unknown>> {
      return emitted
        .filter((e) => e.event === "orchestrate:run_summary")
        .map((e) => e.payload);
    }

    it("repairs a recoverable non-zero exit once under a small-class profile then succeeds with the regenerated script's stdout", async () => {
      // First spawn fails with a recoverable (bad-import) stderr; the second spawn
      // — the single repaired re-run — succeeds. makeFakeChild is called LAZILY
      // inside spawnFn so each child's emit is scheduled only once its listeners
      // are attached (a pre-created child would emit "close" to zero listeners).
      let spawnCount = 0;
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() => {
        spawnCount += 1;
        return spawnCount === 1
          ? makeFakeChild("", 1, importError)
          : makeFakeChild("repaired-ok\n");
      });
      const repairSeam = vi.fn(
        async (_input: {
          script: string;
          language: "ts" | "js" | "py";
          stderrTail: string;
          describeDigest: string;
        }): Promise<string | undefined> => "const fixed = 1;\n",
      );
      const { eventBus, emitted } = makeEventBusSpy();
      const script = "import { bad } from 'nope';\n";
      const { deps } = makeDeps({ spawnFn, capabilityClass: "small", repairSeam, eventBus });
      const tool = createOrchestrateTool(deps);

      const result = await tool.execute("c", { script, language: "ts" });

      // The seam fired EXACTLY once and the child was spawned twice (initial run +
      // the single repaired re-run).
      expect(repairSeam).toHaveBeenCalledTimes(1);
      expect(spawnFn).toHaveBeenCalledTimes(2);
      // The tool RESULT is the repaired run's stdout.
      const text = result.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
      expect(text).toContain("repaired-ok");
      // The seam received the STRUCTURED stderr tail (a field on the failure, not
      // re-parsed from the "exited with code N" message), the ORIGINAL script, the
      // language, and a non-empty describe digest.
      const input = repairSeam.mock.calls[0]![0];
      expect(input.stderrTail).toContain("ImportError");
      expect(input.stderrTail).not.toContain("exited with code");
      expect(input.script).toBe(script);
      expect(input.language).toBe("ts");
      expect(input.describeDigest).toContain("comis_tools");
      // Exactly ONE run_summary — the final (success) outcome, never a failure+success pair.
      const summaries = runSummaries(emitted);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.exitCode).toBe(0);
      expect(summaries[0]!.failureClass).toBeUndefined();
    });

    it("does not repair under a frontier-class profile and surfaces the original bounded error with one failure run_summary", async () => {
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() => makeFakeChild("", 1, importError));
      const repairSeam = vi.fn(async () => "const fixed = 1;\n");
      const { eventBus, emitted } = makeEventBusSpy();
      const { deps } = makeDeps({ spawnFn, capabilityClass: "frontier", repairSeam, eventBus });
      const tool = createOrchestrateTool(deps);

      await expect(tool.execute("c", { script: "import x", language: "ts" })).rejects.toThrow(
        /exited with code 1|ImportError/,
      );

      // A stronger model is not auto-repaired: the seam is never consulted, the
      // child spawns exactly once, and a single failure run_summary is emitted.
      expect(repairSeam).not.toHaveBeenCalled();
      expect(spawnFn).toHaveBeenCalledTimes(1);
      const summaries = runSummaries(emitted);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.failureClass).toBe("nonzero_exit");
    });

    it("does not repair a non-recoverable stderr even under a small-class profile (no seam call, original error surfaced)", async () => {
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() =>
        makeFakeChild("", 1, "Segmentation fault (core dumped)"),
      );
      const repairSeam = vi.fn(async () => "const fixed = 1;\n");
      const { deps } = makeDeps({ spawnFn, capabilityClass: "small", repairSeam });
      const tool = createOrchestrateTool(deps);

      await expect(tool.execute("c", { script: "boom", language: "ts" })).rejects.toThrow(
        /exited with code 1/,
      );

      // classifyRecoverableStderr → undefined for a segfault → the repair branch is
      // skipped even though the class is repair-eligible.
      expect(repairSeam).not.toHaveBeenCalled();
      expect(spawnFn).toHaveBeenCalledTimes(1);
    });

    it("is bounded to exactly one attempt: a repaired-then-failed run surfaces the original bounded error and emits one run_summary", async () => {
      // Both spawns fail with a recoverable stderr; the seam returns a (still-broken)
      // script. The repair must NOT loop — exactly one re-run, then the ORIGINAL error.
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() => makeFakeChild("", 1, importError));
      const repairSeam = vi.fn(async () => "const still_broken = 1;\n");
      const { eventBus, emitted } = makeEventBusSpy();
      const { deps } = makeDeps({ spawnFn, capabilityClass: "small", repairSeam, eventBus });
      const tool = createOrchestrateTool(deps);

      await expect(tool.execute("c", { script: "import x", language: "ts" })).rejects.toThrow(
        /exited with code 1/,
      );

      // The seam fired ONCE (no loop), the child spawned exactly twice (initial +
      // the single re-run), and exactly ONE (failure) run_summary was emitted.
      expect(repairSeam).toHaveBeenCalledTimes(1);
      expect(spawnFn).toHaveBeenCalledTimes(2);
      const summaries = runSummaries(emitted);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.failureClass).toBe("nonzero_exit");
    });

    it("honest-degrades when the repair seam gives up (returns undefined) with no re-run and one run_summary", async () => {
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() => makeFakeChild("", 1, importError));
      const repairSeam = vi.fn(async () => undefined);
      const { eventBus, emitted } = makeEventBusSpy();
      const { deps } = makeDeps({ spawnFn, capabilityClass: "small", repairSeam, eventBus });
      const tool = createOrchestrateTool(deps);

      await expect(tool.execute("c", { script: "import x", language: "ts" })).rejects.toThrow(
        /exited with code 1|ImportError/,
      );

      // The seam was consulted once; with no regenerated script there is NO re-run
      // (spawned once) and a single failure run_summary.
      expect(repairSeam).toHaveBeenCalledTimes(1);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(runSummaries(emitted)).toHaveLength(1);
    });

    it("treats an absent capabilityClass as repair-eligible (fail-safe default on) then repairs once and succeeds", async () => {
      // No capabilityClass threaded (older wiring / unresolved) must default to the
      // repair-eligible class so a keyless small-target deployment still gets the fix.
      let spawnCount = 0;
      const spawnFn = vi.fn<OrchestrateSpawnFn>(() => {
        spawnCount += 1;
        return spawnCount === 1 ? makeFakeChild("", 1, importError) : makeFakeChild("fixed\n");
      });
      const repairSeam = vi.fn(async () => "const fixed = 1;\n");
      // capabilityClass intentionally omitted.
      const { deps } = makeDeps({ spawnFn, repairSeam });
      const tool = createOrchestrateTool(deps);

      const result = await tool.execute("c", { script: "import x", language: "ts" });

      expect(repairSeam).toHaveBeenCalledTimes(1);
      const text = result.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
      expect(text).toContain("fixed");
    });
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

  // -------------------------------------------------------------------------
  // Durable-resumable runs: a durable-registered run registers a resumable row
  // at start; on a TIMEOUT it re-affirms the row + SKIPS cleanupRun so the
  // pinned script + checkpoint survive; a `resumeRunId` re-spawns the PINNED
  // stored bytes and IGNORES a differing `script` param (no new bytes on
  // resume). All gated on the injected durableRuns seam (default-off).
  // -------------------------------------------------------------------------
  describe("durable-resumable runs", () => {
    it("registers a FLAT resumable durable row carrying scriptRef at run start", async () => {
      const durableRuns = makeFakeDurableRuns();
      const { deps } = makeDeps({ durableRuns, rootRunId: "root-reg" });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "console.log(1)", language: "ts" });

      // The row is registered from the start with a unique checkpoint identity,
      // tree root, flat spawn tree, and pinned script reference.
      expect(durableRuns.upserts.length).toBeGreaterThanOrEqual(1);
      const row = durableRuns.upserts[0]!;
      expect(row.rootRunId).toBe("root-reg");
      expect(row.status).toBe("running");
      expect(row.spawnTree).toEqual([]);
      expect(row.scriptRef).toMatch(/^orch-.*\.ts$/);
      expect(row.checkpointId).toMatch(/^orch-/);
      expect(row.agentId).toBe("agent-a");
    });

    it("a durable-registered run that TIMES OUT marks the row resumable and SKIPS cleanupRun", async () => {
      const cleanupRun = vi.fn(async () => {});
      const durableRuns = makeFakeDurableRuns();
      const { deps } = makeDeps({
        spawnFn: () => makeHangingChild(),
        durableRuns,
        rootRunId: "root-timeout",
        cleanupRun,
      });
      const tool = createOrchestrateTool(deps);

      await expect(
        tool.execute("c", { script: "1", language: "ts", resumeRunId: undefined, timeoutMs: 1 }),
      ).rejects.toThrow(/timeout/i);

      // R7: the resumable timeout must NOT wipe results/ (the checkpoint lives there).
      expect(cleanupRun).not.toHaveBeenCalled();
      // The row was re-affirmed resumable (status running, scriptRef set) on timeout.
      const last = durableRuns.upserts.at(-1)!;
      expect(last.rootRunId).toBe("root-timeout");
      expect(last.status).toBe("running");
      expect(last.scriptRef).toMatch(/^orch-.*\.ts$/);
    });

    it("a durable-registered run that SUCCEEDS still calls cleanupRun (skip-clean is timeout-only)", async () => {
      const cleanupRun = vi.fn(async () => {});
      const durableRuns = makeFakeDurableRuns();
      const { deps } = makeDeps({ durableRuns, rootRunId: "root-ok", cleanupRun });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts" });

      expect(cleanupRun).toHaveBeenCalledTimes(1);
    });

    it("a SUCCESSFUL resumable-enabled run marks the durable row COMPLETED and cleans the pinned script", async () => {
      // Without a terminal write the row stays status='running' forever + the
      // pinned <runId>.<language> script (at the workspace ROOT, which cleanupRun
      // does NOT touch) leaks, so listResumable re-surfaces the completed run and
      // the orphan sweep false-orphans it on every boot.
      const durableRuns = makeFakeDurableRuns();
      const { deps } = makeDeps({ durableRuns, rootRunId: "root-done" });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "console.log(1)", language: "ts" });

      // The row is marked terminal (no leaked 'running' row).
      expect(durableRuns.completed).toContain(durableRuns.upserts[0]!.checkpointId);
      // The pinned script at the workspace ROOT is cleaned on a non-resumable
      // completion (only a resumable timeout keeps it — see below).
      const pinnedScriptRef = durableRuns.upserts[0]!.scriptRef!;
      expect(existsSync(join(workspacePath, pinnedScriptRef))).toBe(false);
    });

    it("a NON-timeout failure marks the durable row COMPLETED too (a dead run is not resumable)", async () => {
      // A non-timeout failure is terminal-and-dead (only a timeout is resumable),
      // so its row must not linger 'running' either.
      const durableRuns = makeFakeDurableRuns();
      const { deps } = makeDeps({
        spawnFn: () => makeFakeChild("", 1, "boom"),
        durableRuns,
        rootRunId: "root-fail-term",
      });
      const tool = createOrchestrateTool(deps);

      await expect(tool.execute("c", { script: "1", language: "ts" })).rejects.toThrow();

      expect(durableRuns.completed).toContain(durableRuns.upserts[0]!.checkpointId);
    });

    it("a TIMED-OUT resumable run is NOT marked completed and KEEPS its pinned script (only a genuine timeout stays resumable)", async () => {
      const durableRuns = makeFakeDurableRuns();
      const { deps } = makeDeps({
        spawnFn: () => makeHangingChild(),
        durableRuns,
        rootRunId: "root-to",
      });
      const tool = createOrchestrateTool(deps);

      await expect(
        tool.execute("c", { script: "1", language: "ts", timeoutMs: 1 }),
      ).rejects.toThrow(/timeout/i);

      // A resumable timeout must leave the row resumable (never completed) and keep
      // the pinned script for a later resume.
      expect(durableRuns.completed).not.toContain(durableRuns.upserts[0]!.checkpointId);
      const pinnedScriptRef = durableRuns.upserts[0]!.scriptRef!;
      expect(existsSync(join(workspacePath, pinnedScriptRef))).toBe(true);
    });

    it("a durable-registered run that fails NON-timeout still calls cleanupRun", async () => {
      const cleanupRun = vi.fn(async () => {});
      const durableRuns = makeFakeDurableRuns();
      const { deps } = makeDeps({
        spawnFn: () => makeFakeChild("", 1, "boom"),
        durableRuns,
        rootRunId: "root-fail",
        cleanupRun,
      });
      const tool = createOrchestrateTool(deps);

      await expect(tool.execute("c", { script: "1", language: "ts" })).rejects.toThrow();

      // Only a timeout is resumable; a nonzero-exit still cleans as before.
      expect(cleanupRun).toHaveBeenCalledTimes(1);
    });

    it("resumeRunId re-spawns the PINNED stored bytes and IGNORES a differing script param", async () => {
      const pinnedBytes = 'console.log("PINNED-RESUME-BYTES");\n';
      const scriptRef = "orch-oldrun-abc.ts";
      // The pinned script lives at the workspace ROOT (cleanupRun is results/-only,
      // so it survives) — pre-write it so the default fs seam reads it back.
      writeFileSync(join(workspacePath, scriptRef), pinnedBytes);
      const durableRuns = makeFakeDurableRuns({
        getRow: {
          checkpointId: "checkpoint-resume",
          rootRunId: "root-resume",
          agentId: "agent-a",
          sessionKey: "tenant-a:user-a:chat-a",
          ownerTenantId: "tenant-a",
          ownerUserId: "user-a",
          deliveryOrigin: null,
          spawnTree: [],
          caps: [],
          leaseIds: [],
          budgetConsumed: 0,
          cronOrigin: null,
          trustLevel: "user",
          status: "running",
          lastHeartbeatAt: 1,
          scriptRef,
        },
      });
      let writtenScript: string | undefined;
      const spawnFn: OrchestrateSpawnFn = (_bin, args) => {
        const scriptName = scriptNameFromArgs(args);
        writtenScript = readFileSync(join(workspacePath, scriptName), "utf8");
        return makeFakeChild("resumed\n");
      };
      const mintRunLease = vi.fn(() => ({ leaseId: "resumed-lease", bearer: "resumed-bearer" }));
      const { deps } = makeDeps({
        spawnFn,
        durableRuns,
        rootRunId: "root-resume",
        mintRunLease,
      });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", {
        script: 'console.log("DIFFERENT-PARAM-BYTES");',
        language: "ts",
        resumeRunId: "checkpoint-resume",
      });

      // The re-spawned script is the PINNED bytes — never the differing param.
      expect(writtenScript).toBe(pinnedBytes);
      expect(writtenScript).not.toContain("DIFFERENT-PARAM-BYTES");
      expect(durableRuns.claimForResume).toHaveBeenCalledWith(
        expect.objectContaining({
          checkpointId: "checkpoint-resume",
          replacementCheckpointId: expect.stringMatching(/^orch-/),
        }),
      );
      expect(durableRuns.getByCheckpoint).not.toHaveBeenCalled();
      expect(mintRunLease).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Number),
        expect.objectContaining({
          rootRunId: "root-resume",
          sourceCheckpointId: "checkpoint-resume",
          trustLevel: "user",
        }),
      );
    });

    it("orphans and reclaims a claimed replacement when its checkpoint-scoped lease cannot be minted", async () => {
      const scriptRef = "orch-claimed-source.ts";
      writeFileSync(join(workspacePath, scriptRef), "console.log('pinned');\n");
      const durableRuns = makeFakeDurableRuns({
        getRow: {
          checkpointId: "checkpoint-claimed-source",
          rootRunId: "root-claimed-source",
          agentId: "agent-a",
          sessionKey: "tenant-a:user-a:chat-a",
          ownerTenantId: "tenant-a",
          ownerUserId: "user-a",
          deliveryOrigin: null,
          spawnTree: [],
          caps: [],
          leaseIds: [],
          rootBudget: { startedAtMs: 1, tokensConsumed: 7, usdConsumed: 0.5 },
          budgetConsumed: 0.5,
          cronOrigin: null,
          trustLevel: "user",
          status: "running",
          lastHeartbeatAt: 1,
          scriptRef,
          checkpointRef: null,
        },
      });
      const cleanupRun = vi.fn(async () => {});
      const { deps } = makeDeps({
        durableRuns,
        rootRunId: "root-claimed-source",
        cleanupRun,
        // No mintRunLease: the claim succeeds, then the pre-start requirement fails.
      });

      await expect(
        createOrchestrateTool(deps).execute("c", {
          script: "IGNORED",
          language: "ts",
          resumeRunId: "checkpoint-claimed-source",
        }),
      ).rejects.toThrow(/checkpoint-scoped lease mint/i);

      const replacementId = durableRuns.claimForResume.mock.calls[0]![0].replacementCheckpointId;
      expect(durableRuns.orphaned).toContainEqual({
        checkpointId: replacementId,
        reason: "resume_prestart_failed",
      });
      expect(cleanupRun).toHaveBeenCalledWith({
        workspacePath,
        runId: "checkpoint-claimed-source",
      });
      expect(existsSync(join(workspacePath, scriptRef))).toBe(false);
    });

    it("refuses to spawn when the claimed replacement is rejected by a concurrent revoke", async () => {
      const scriptRef = "orch-revoked-source.ts";
      writeFileSync(join(workspacePath, scriptRef), "console.log('pinned');\n");
      const durableRuns = makeFakeDurableRuns({
        getRow: {
          checkpointId: "checkpoint-revoked-source",
          rootRunId: "root-revoked",
          agentId: "agent-a",
          sessionKey: "tenant-a:user-a:chat-a",
          ownerTenantId: "tenant-a",
          ownerUserId: "user-a",
          deliveryOrigin: null,
          spawnTree: [],
          caps: [],
          leaseIds: [],
          budgetConsumed: 0,
          cronOrigin: null,
          trustLevel: "user",
          status: "running",
          lastHeartbeatAt: 1,
          scriptRef,
        },
        upsertError: new Error("durable root root-revoked is revoked"),
      });
      const spawnFn = vi.fn(() => makeFakeChild("must-not-run\n"));
      const { deps } = makeDeps({
        spawnFn,
        durableRuns,
        rootRunId: "root-revoked",
        mintRunLease: () => ({ leaseId: "unused-lease", bearer: "unused-bearer" }),
      });

      await expect(
        createOrchestrateTool(deps).execute("c", {
          script: "IGNORED",
          language: "ts",
          resumeRunId: "checkpoint-revoked-source",
        }),
      ).rejects.toThrow(/replacement/i);
      expect(spawnFn).not.toHaveBeenCalled();
    });

    it("REFUSES a resumeRunId when the durable-resume surface is OFF (fail-closed, never the caller's script)", async () => {
      // With no durableRuns seam (surface off / older wiring) a resumeRunId must be
      // REFUSED, never silently fall through to spawning the caller-supplied `script`
      // bytes — a resume never accepts fresh bytes, even when the surface is off.
      let spawned = false;
      const spawnFn: OrchestrateSpawnFn = () => {
        spawned = true;
        return makeFakeChild("SHOULD-NOT-RUN\n");
      };
      const { deps } = makeDeps({ spawnFn }); // NO durableRuns
      const tool = createOrchestrateTool(deps);

      await expect(
        tool.execute("c", {
          script: "console.log('caller-supplied bytes')",
          language: "ts",
          resumeRunId: "root-x",
        }),
      ).rejects.toThrow(/resume/i);
      // Fail-closed: the caller's script was NEVER executed.
      expect(spawned).toBe(false);
    });
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

  // ---------------------------------------------------------------------------
  // orchestrate:run_summary emit — the content-free per-run observability signal
  // carrying saved-context estimates and the per-run child leaseId.
  // ---------------------------------------------------------------------------

  describe("orchestrate:run_summary emit", () => {
    // The EXACT content-free key set on a MATERIALIZED-run SUCCESS emit (leaseId +
    // sessionKey present; failureClass ABSENT; savings PRESENT because the run
    // materialized ResultRefs), never a stderr tail, script, or params.
    const SUCCESS_KEYS = [
      "durationMs",
      "estSavedTokens",
      "exitCode",
      "language",
      "leaseId",
      "resultRefBytes",
      "resultRefCount",
      "rootRunId",
      "runId",
      "savedRatio",
      "sessionKey",
      "stdoutBytesRaw",
      "stdoutCharsReentered",
      "timestamp",
    ];
    // The key set on a ZERO-materialization SUCCESS: savings (estSavedTokens /
    // savedRatio) is carried ONLY when the run materialized ResultRefs (the
    // documented contract + the fold's omit-branch), so both keys are ABSENT here.
    const SUCCESS_KEYS_NO_SAVINGS = SUCCESS_KEYS.filter(
      (k) => k !== "estSavedTokens" && k !== "savedRatio",
    );

    it("a successful run emits one content-free summary with its child lease and savings before cleanup", async () => {
      const { eventBus, emitted } = makeEventBusSpy();
      const runAggregate = vi.fn(() => ({ count: 3, bytes: 122_880 }));
      // cleanupRun asserts the emit ALREADY fired (Pitfall 3 — before results/ is wiped).
      const cleanupRun = vi.fn(async () => {
        expect(emitted).toHaveLength(1);
      });
      const mintRunLease = vi.fn(() => ({ leaseId: "child-lease-1", bearer: "bearer-1" }));
      const { deps } = makeDeps({
        eventBus,
        runAggregate,
        cleanupRun,
        mintRunLease,
        rootRunId: "root-agent-1",
        sessionKey: "tenant:user:channel",
        spawnFn: () => makeFakeChild("ok-output\n"),
      });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts" });

      expect(emitted).toHaveLength(1);
      const { event, payload } = emitted[0]!;
      expect(event).toBe("orchestrate:run_summary");
      expect(payload.exitCode).toBe(0);
      expect(payload.failureClass).toBeUndefined();
      expect(payload.leaseId).toBe("child-lease-1");
      expect(payload.rootRunId).toBe("root-agent-1");
      expect(payload.sessionKey).toBe("tenant:user:channel");
      expect(payload.language).toBe("ts");
      expect(payload.resultRefCount).toBe(3);
      expect(payload.resultRefBytes).toBe(122_880);
      // stdoutCharsReentered = the POST-bounce char count of "ok-output\n" (10).
      expect(payload.stdoutCharsReentered).toBe(10);
      expect(payload.stdoutBytesRaw).toBe("ok-output\n".length);
      // The estimate is exactly estimateSavings(materializedBytes, reentered).
      const expected = estimateSavings(122_880, 10);
      expect(payload.estSavedTokens).toBe(expected.estSavedTokens);
      expect(payload.savedRatio).toBe(expected.savedRatio);
      // runAggregate was consulted (real counts, not 0) — proves capture-before-cleanup.
      expect(runAggregate).toHaveBeenCalledWith({
        workspacePath,
        runId: expect.stringMatching(/^orch-/),
      });
      // The payload key set is exactly the declared content-free fields —
      // savings PRESENT because this run materialized 3 ResultRefs.
      expect(Object.keys(payload).sort()).toEqual(SUCCESS_KEYS);
      expect("estSavedTokens" in payload).toBe(true);
      expect("savedRatio" in payload).toBe(true);
    });

    it("a ZERO-materialization SUCCESS OMITS the savings keys (savings carried only when the run materialized ResultRefs)", async () => {
      // No runAggregate → agg={count:0,bytes:0}: the run materialized nothing, so
      // estimateSavings would return {estSavedTokens:0, savedRatio:0}. Per the
      // documented contract (orchestrate.mdx / json-rpc.mdx), the fold's omit-branch,
      // and the schema test, the emit must OMIT both savings keys rather than carry a
      // phantom 0 — mirroring the sibling optional leaseId / sessionKey spreads.
      const { eventBus, emitted } = makeEventBusSpy();
      const mintRunLease = vi.fn(() => ({ leaseId: "child-lease-1", bearer: "bearer-1" }));
      const { deps } = makeDeps({
        eventBus,
        mintRunLease,
        rootRunId: "root-agent-1",
        sessionKey: "tenant:user:channel",
        spawnFn: () => makeFakeChild("ok-output\n"),
      });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts" });

      expect(emitted).toHaveLength(1);
      const { payload } = emitted[0]!;
      expect(payload.exitCode).toBe(0);
      expect(payload.resultRefCount).toBe(0);
      expect(payload.resultRefBytes).toBe(0);
      // Savings keys ABSENT on a zero-materialization success (not carried as 0).
      expect("estSavedTokens" in payload).toBe(false);
      expect("savedRatio" in payload).toBe(false);
      expect(Object.keys(payload).sort()).toEqual(SUCCESS_KEYS_NO_SAVINGS);
    });

    it("carries the content-free ordered toolSequence (the pre-flight footprint) + the turn traceId, populated under a request context", async () => {
      // A cap-mapped script: web_search, jq, jq, web_fetch → the source-ordered
      // call-site sequence with jq TWICE (its call count). The descriptor rides the
      // emit as toolSequence (names only). The turn traceId — distinct from
      // runId/rootRunId (the orchestrate-run ids) — rides it so a later learning
      // ledger can key the descriptor row on the turn trajectory.
      const TURN_TRACE_ID = "7f1c9a2e-3b4d-4c5e-8a6f-0d1e2f3a4b5c";
      const PROC_SCRIPT =
        'await comis_tools.web_search({q:1}); await comis_tools.jq({a:1}); await comis_tools.jq({b:2}); await comis_tools.web_fetch({url:"x"});';
      const { eventBus, emitted } = makeEventBusSpy();
      const { deps } = makeDeps({
        eventBus,
        rootRunId: "root-agent-1",
        sessionKey: "tenant:user:channel",
        spawnFn: () => makeFakeChild("ok\n"),
      });
      const tool = createOrchestrateTool(deps);

      const ctx: RequestContext = {
        tenantId: "default",
        userId: "test-user",
        sessionKey: "tenant:user:channel",
        traceId: TURN_TRACE_ID,
        startedAt: 1_700_000_000_000,
        trustLevel: "admin",
      };
      await runWithContext(ctx, () =>
        tool.execute("c", { script: PROC_SCRIPT, language: "ts" }),
      );

      expect(emitted).toHaveLength(1);
      const { event, payload } = emitted[0]!;
      expect(event).toBe("orchestrate:run_summary");
      // The ordered call-site sequence + counts (repeats preserved), sourced from
      // extractCapabilityFootprint(script).sequence — content-free (names only).
      expect(payload.toolSequence).toEqual(["web_search", "jq", "jq", "web_fetch"]);
      // The owning turn's trace correlator, distinct from runId/rootRunId.
      expect(payload.traceId).toBe(TURN_TRACE_ID);
      // Names, counts, and a correlator only — never the script body or call args.
      const json = JSON.stringify(payload);
      expect(json).not.toContain("web_fetch({url");
      expect(json).not.toContain("q:1");
    });

    it("a NON-ZERO exit emits failureClass nonzero_exit + the real exit code (no stderr tail on the bus)", async () => {
      const { eventBus, emitted } = makeEventBusSpy();
      const { deps } = makeDeps({
        eventBus,
        rootRunId: "root-2",
        spawnFn: () => makeFakeChild("", 3, "TypeError: boom on stderr"),
      });
      const tool = createOrchestrateTool(deps);

      await expect(tool.execute("c", { script: "1", language: "ts" })).rejects.toThrow(/code 3/);

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.payload.failureClass).toBe("nonzero_exit");
      expect(emitted[0]!.payload.exitCode).toBe(3);
      // The stderr tail rides the tool-error surface only, never the bus.
      const json = JSON.stringify(emitted[0]!.payload);
      expect(json).not.toContain("boom on stderr");
      expect("stderrTail" in emitted[0]!.payload).toBe(false);
    });

    it("a TIMEOUT emits failureClass timeout", async () => {
      const { eventBus, emitted } = makeEventBusSpy();
      const { deps } = makeDeps({
        eventBus,
        rootRunId: "root-3",
        spawnFn: () => makeHangingChild(),
      });
      const tool = createOrchestrateTool(deps);

      await expect(
        tool.execute("c", { script: "1", language: "ts", timeoutMs: 1 }),
      ).rejects.toThrow(/timeout/i);

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.payload.failureClass).toBe("timeout");
    });

    it("a SPAWN failure emits failureClass spawn_fail", async () => {
      const { eventBus, emitted } = makeEventBusSpy();
      const spawnFn: OrchestrateSpawnFn = () => {
        throw new Error("spawn boom");
      };
      const { deps } = makeDeps({ eventBus, rootRunId: "root-4", spawnFn });
      const tool = createOrchestrateTool(deps);

      await expect(tool.execute("c", { script: "1", language: "ts" })).rejects.toThrow(/spawn boom/);

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.payload.failureClass).toBe("spawn_fail");
    });

    it("a STDOUT hard-cap trip emits failureClass stdout_cap", async () => {
      const { eventBus, emitted } = makeEventBusSpy();
      const spawnFn: OrchestrateSpawnFn = () => {
        const child = new EventEmitter() as unknown as OrchestrateSpawnedChild & EventEmitter;
        const out = new EventEmitter();
        (child as { stdout: EventEmitter }).stdout = out;
        (child as { stderr: EventEmitter }).stderr = new EventEmitter();
        (child as { kill: () => void }).kill = () => {};
        setImmediate(() => {
          out.emit("data", Buffer.alloc(STDOUT_HARD_CAP_BYTES + 1, 0x41));
          child.emit("close", 0);
        });
        return child;
      };
      const { deps } = makeDeps({ eventBus, rootRunId: "root-5", spawnFn });
      const tool = createOrchestrateTool(deps);

      await expect(
        tool.execute("c", { script: "1", language: "ts" }),
      ).rejects.toThrow(/hard cap|exceeded/i);

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.payload.failureClass).toBe("stdout_cap");
    });

    it("a run with NO lease emits failureClass lease_absent", async () => {
      const { eventBus, emitted } = makeEventBusSpy();
      // No brokerSpawnEnv AND no mintRunLease → childEnv has no COMIS_CAP_LEASE.
      const { deps } = makeDeps({
        eventBus,
        rootRunId: "root-6",
        dropBrokerSpawnEnv: true,
        spawnFn: () => makeFakeChild("ok\n"),
      });
      const tool = createOrchestrateTool(deps);

      await tool.execute("c", { script: "1", language: "ts" });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.payload.failureClass).toBe("lease_absent");
      expect(emitted[0]!.payload.exitCode).toBe(0);
    });

    it("does NOT emit (and does not throw) when no eventBus is wired — the emit is opt-in", async () => {
      // The default makeDeps injects NO eventBus; a run must not throw for the
      // absent emit channel (the ?. guard on deps.eventBus).
      const { deps } = makeDeps({ spawnFn: () => makeFakeChild("ok\n") });
      const tool = createOrchestrateTool(deps);
      await expect(tool.execute("c", { script: "1", language: "ts" })).resolves.toBeDefined();
    });

    it("a THROWING run_summary subscriber does NOT flip a successful run to a failed tool call (emit never throws into the run)", async () => {
      // EventEmitter.emit invokes subscribers synchronously and PROPAGATES a
      // throwing one. If the success emit threw into the run's try, the catch would
      // fire, re-classify the emit error as spawn_fail, re-emit a FAILURE summary
      // (double record), and surface a SUCCESSFUL run as a failed tool call. The
      // emit must swallow+log a throwing subscriber so it can never perturb the run.
      const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
      const eventBus = {
        emit(event: string, payload: Record<string, unknown>) {
          emitted.push({ event, payload });
          throw new Error("subscriber boom");
        },
      };
      const { deps } = makeDeps({
        eventBus,
        rootRunId: "root-throw",
        spawnFn: () => makeFakeChild("THE-ANSWER\n"),
      });
      const tool = createOrchestrateTool(deps);

      // The run RESOLVES (success) despite the throwing subscriber — NOT flipped to
      // a failed tool call, and the thrown subscriber error does not escape.
      const result = await tool.execute("c", { script: "1", language: "ts" });
      const text = result.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
      expect(text).toContain("THE-ANSWER");

      // Exactly ONE emit attempt (the success emit) — swallowing prevents the catch
      // from re-emitting a second (failure) summary (no double-record).
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.event).toBe("orchestrate:run_summary");
      expect(emitted[0]!.payload.exitCode).toBe(0);
      expect(emitted[0]!.payload.failureClass).toBeUndefined();
    });
  });
});
