// SPDX-License-Identifier: Apache-2.0
/** Deterministic E0 delivery, forge, recovery, and cleanup mechanics gate. */
import { execFile, execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemonHandle } from "../../../support/daemon-harness.js";
import { createFixtureRepository, waitForUnixSocket } from "../../../support/capability-service-vertical-harness.js";
import { getFreePort } from "../../../support/free-port.js";
import {
  createTgEmulator,
  type ChatRef,
  type TgEmulator,
} from "../../emulators/telegram/tg-emulator.js";
import { FAKE_BOT_TOKEN } from "../../harness/rig-config.js";
import {
  CONTRIBUTION,
  CONTROL_SECRET,
  CONTROL_SECRET_NAME,
  LiaisonModelServer,
  PROVIDER_SECRET_NAME,
  SERVICE_INSTANCE_ID,
  cli,
  makeConfig,
  pollUntil,
  runBinding,
  startInstalledService,
  stopDaemon,
  type RunningService,
} from "./wave4-join.test.js";

const MECHANICS_LAUNCHER = "/usr/local/bin/e0-codex-launcher";
const MECHANICS_ALLOW_ID = "codex-e0-confined";
const MECHANICS_TOKEN = "e0-reviewed";
const MECHANICS_PROFILE = "e0-live";
const isMechanicsGate = process.env["COMIS_E0_MECHANICS"] === "1" && process.platform === "linux";
const TELEGRAM_CHAT: ChatRef = Object.freeze({ chatId: 424_242 });
const TELEGRAM_USER = Object.freeze({ id: 678_314_278, firstName: "Capability", username: "capability_user" });

interface ToolStep {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly capture?: (text: string) => void;
}

interface PullTruth {
  readonly number: number;
  readonly branch: string;
}

function attachmentDiagnostic(databasePath: string, runtimeRoot: string, dataDir: string): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    const row = db.prepare("SELECT handle FROM tasks ORDER BY created_at DESC LIMIT 1").get() as
      | { handle: string }
      | undefined;
    if (row === undefined) return "attachment diagnostic: no durable task exists";
    const sourcePath = join(runtimeRoot, row.handle, "attachment.sock");
    if (!existsSync(sourcePath)) {
      return `attachment diagnostic: source is absent; runtimeRoot=${runtimeRoot}; dataDir=${dataDir}`;
    }
    const stat = lstatSync(sourcePath, { bigint: true });
    return `attachment diagnostic: ${JSON.stringify({
      runtimeRoot,
      runtimeRootCanonical: realpathSync(runtimeRoot),
      dataDir,
      dataDirCanonical: realpathSync(dataDir),
      sourcePath,
      sourceCanonical: realpathSync(sourcePath),
      isSocket: stat.isSocket(),
      isSymbolicLink: stat.isSymbolicLink(),
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      birthtimeNs: stat.birthtimeNs.toString(),
    })}`;
  } finally {
    db.close();
  }
}

class DeterministicForgeServer {
  private server: Server | undefined;
  private baseUrlValue = "";
  private pull: PullTruth | undefined;
  private readonly checkGate: Promise<void>;
  private releaseCheckGate: (() => void) | undefined;
  private checkRequestObservedValue = false;
  private pullCreateCountValue = 0;

  constructor(
    readonly gitExecutable: string,
    readonly remote: string,
    readonly baseBranch: string,
  ) {
    this.checkGate = new Promise<void>((resolve) => {
      this.releaseCheckGate = resolve;
    });
  }

  get baseUrl(): string {
    return this.baseUrlValue;
  }

  get checkRequestObserved(): boolean {
    return this.checkRequestObservedValue;
  }

  get pullCreateCount(): number {
    return this.pullCreateCountValue;
  }

  releaseChecks(): void {
    this.releaseCheckGate?.();
    this.releaseCheckGate = undefined;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.respond(request, response);
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      this.server!.once("error", rejectListen);
      this.server!.listen(0, "127.0.0.1", resolveListen);
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("deterministic forge did not bind TCP");
    this.baseUrlValue = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    this.releaseChecks();
    if (this.server === undefined) return;
    await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose()));
    this.server = undefined;
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.baseUrlValue);
    const prefix = "/repos/fixture-owner/fixture-repository";
    if (request.method === "GET" && url.pathname === `${prefix}/pulls`) {
      this.json(response, this.pull === undefined ? [] : [{ number: this.pull.number }]);
      return;
    }
    if (request.method === "POST" && url.pathname === `${prefix}/pulls`) {
      const body = await this.readJSON(request);
      const branch = typeof body["head"] === "string" ? body["head"] : "";
      if (!branch.startsWith("devcrew/") || body["base"] !== this.baseBranch) {
        this.json(response, { error: "invalid head" }, 422);
        return;
      }
      this.pullCreateCountValue += 1;
      this.pull = { number: 1, branch };
      this.json(response, { number: 1 }, 201);
      return;
    }
    if (request.method === "GET" && url.pathname === `${prefix}/pulls/1` && this.pull !== undefined) {
      const head = execFileSync(this.gitExecutable, [
        "--git-dir", this.remote, "rev-parse", `refs/heads/${this.pull.branch}`,
      ], { encoding: "utf8" }).trim();
      this.json(response, {
        number: 1,
        state: "open",
        html_url: "https://github.com/fixture-owner/fixture-repository/pull/1",
        head: { sha: head, ref: this.pull.branch },
        base: { ref: this.baseBranch },
      });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith(`${prefix}/commits/`) && url.pathname.endsWith("/check-runs")) {
      this.checkRequestObservedValue = true;
      await this.checkGate;
      if (response.destroyed) return;
      this.json(response, {
        check_runs: [{ name: "ci/e0", status: "completed", conclusion: "success" }],
      });
      return;
    }
    this.json(response, { error: "not found" }, 404);
  }

  private async readJSON(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  }

  private json(response: ServerResponse, body: unknown, status = 200): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  }
}

function createCandidateFixture(
  scratch: string,
  repository: ReturnType<typeof createFixtureRepository>,
): { readonly configPath: string; readonly forge: DeterministicForgeServer } {
  const forgeRoot = join(scratch, "forge");
  const remote = join(forgeRoot, "fixture.git");
  const credentialDirectory = join(forgeRoot, "credentials");
  const readCredentialFile = join(forgeRoot, "read.credential");
  const pushCredentialFile = join(forgeRoot, "push.credential");
  const configPath = join(forgeRoot, "candidate.json");
  mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
  execFileSync(repository.gitExecutable, ["init", "--bare", remote], { stdio: "pipe" });
  const forge = new DeterministicForgeServer(repository.gitExecutable, remote, repository.defaultBranch);
  writeFileSync(readCredentialFile, "e0_read_identity", { mode: 0o600 });
  writeFileSync(pushCredentialFile, "e0_push_identity", { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    programs: [{ id: "repository-check", executable: "/usr/bin/true" }],
    profiles: [{
      id: MECHANICS_PROFILE,
      localChecks: [{
        id: "repository-unit",
        programId: "repository-check",
        arguments: [{ kind: "literal", value: "--version" }],
        timeout: "30s",
        required: true,
      }],
      forgeChecks: [{ name: "ci/e0", required: true }],
      artifactRules: [{
        kind: "regular_file",
        relativePath: "report.md",
        mediaType: "text/markdown",
        maxBytes: 16_384,
      }],
      evidenceTtl: "24h",
    }],
    maxOutputBytes: 65_536,
    pollInterval: "100ms",
    forge: {
      apiBaseUrl: "FORGE_BASE_URL",
      owner: "fixture-owner",
      repository: "fixture-repository",
      remoteUrl: pathToFileURL(remote).href,
      readCredentialFile,
      pushCredentialFile,
      credentialDirectory,
      localFixtureRemoteRoot: forgeRoot,
    },
  }), { mode: 0o600 });
  return { configPath, forge };
}

function bindForgeBaseUrl(configPath: string, baseUrl: string): void {
  const contents = readFileSync(configPath, "utf8").replace("FORGE_BASE_URL", baseUrl);
  writeFileSync(configPath, contents, { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

function taskState(databasePath: string, taskHandle: string): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    const row = db.prepare("SELECT state FROM tasks WHERE handle = ?").get(taskHandle) as { state: string } | undefined;
    return row?.state ?? "missing";
  } finally {
    db.close();
  }
}

function evidenceDelivered(databasePath: string, taskHandles: readonly string[]): boolean {
  const db = new Database(databasePath, { readonly: true });
  try {
    return taskHandles.every((taskHandle) => {
      const row = db.prepare(`SELECT COUNT(*) AS total, COUNT(delivered_at) AS delivered
        FROM comis_evidence_outbox WHERE task_handle = ?`).get(taskHandle) as { total: number; delivered: number };
      return row.total === 2 && row.delivered === 2;
    });
  } finally {
    db.close();
  }
}

function comisEvidenceCounts(dataDir: string, managedRunIds: readonly string[]): number[] {
  const db = new Database(join(dataDir, "memory.db"), { readonly: true });
  try {
    return managedRunIds.map((managedRunId) => {
      const row = db.prepare("SELECT COUNT(*) AS count FROM managed_run_evidence WHERE managed_run_id = ?")
        .get(managedRunId) as { count: number };
      return row.count;
    });
  } finally {
    db.close();
  }
}

function managedRunContinuationsSettled(dataDir: string, managedRunIds: readonly string[]): boolean {
  const db = new Database(join(dataDir, "memory.db"), { readonly: true });
  try {
    const placeholders = managedRunIds.map(() => "?").join(", ");
    const row = db.prepare(`SELECT COUNT(*) AS count FROM managed_runs
      WHERE managed_run_id IN (${placeholders})
        AND pending_continuation = 0
        AND last_reduced_report_sequence = last_accepted_report_sequence`).get(...managedRunIds) as { count: number };
    return row.count === managedRunIds.length;
  } finally {
    db.close();
  }
}

function releasedLeaseCount(dataDir: string, leaseIds: readonly string[]): number {
  const db = new Database(join(dataDir, "memory.db"), { readonly: true });
  try {
    const placeholders = leaseIds.map(() => "?").join(", ");
    const row = db.prepare(`SELECT COUNT(*) AS count FROM workspace_leases
      WHERE workspace_lease_id IN (${placeholders}) AND state = 'released' AND release_disposition = 'reap_safe'`)
      .get(...leaseIds) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

interface CleanupSnapshot {
  readonly state: string;
  readonly openHolds: number;
  readonly operations: Array<{
    readonly operationId: string;
    readonly stage: string;
    readonly hostReleasedAt: string | null;
    readonly removalAuthorizedAt: string | null;
  }>;
}

function cleanupSnapshot(databasePath: string, taskHandle: string): CleanupSnapshot {
  const db = new Database(databasePath, { readonly: true });
  try {
    const task = db.prepare("SELECT state FROM tasks WHERE handle = ?").get(taskHandle) as { state: string };
    const hold = db.prepare(`SELECT COUNT(*) AS count FROM task_cleanup_holds
      WHERE task_handle = ? AND closed_at IS NULL`).get(taskHandle) as { count: number };
    const operations = db.prepare(`SELECT operation_id AS operationId, stage,
      host_released_at AS hostReleasedAt, removal_authorized_at AS removalAuthorizedAt
      FROM task_cleanup_operations WHERE task_handle = ? ORDER BY operation_id`).all(taskHandle) as CleanupSnapshot["operations"];
    return { state: task.state, openHolds: hold.count, operations };
  } finally {
    db.close();
  }
}

function releaseSnapshot(dataDir: string, managedRunId: string): string {
  const db = new Database(join(dataDir, "memory.db"), { readonly: true });
  try {
    return JSON.stringify({
      run: db.prepare(`SELECT status, pending_continuation AS pendingContinuation,
        last_accepted_report_sequence AS acceptedSequence, last_reduced_report_sequence AS reducedSequence
        FROM managed_runs WHERE managed_run_id = ?`).get(managedRunId),
      lease: db.prepare(`SELECT state, release_disposition AS releaseDisposition, released_at_ms AS releasedAtMs
        FROM workspace_leases WHERE managed_run_id = ?`).get(managedRunId),
    });
  } finally {
    db.close();
  }
}

async function liaisonTurn(
  model: LiaisonModelServer,
  telegram: TgEmulator,
  message: string,
  steps: readonly ToolStep[],
): Promise<void> {
  await pollUntil(() => model.idle, 10_000, `liaison idle before ${message}`);
  const before = telegram.outbound(TELEGRAM_CHAT)
    .filter((entry) => entry.text?.includes("LIAISON_TURN_DONE") === true).length;
  model.setScript(steps);
  telegram.injectMessage(TELEGRAM_CHAT, TELEGRAM_USER, message);
  await pollUntil(
    () => model.idle && telegram.outbound(TELEGRAM_CHAT)
      .filter((entry) => entry.text?.includes("LIAISON_TURN_DONE") === true).length > before,
    60_000,
    `${message} response`,
  );
}

function cleanupFailure(binary: string, socket: string, taskHandle: string, operationId: string): string {
  const options: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8" };
  try {
    execFileSync(binary, [
      "--socket", socket, "task", "cleanup", taskHandle,
      "--operation", operationId, "--format", "json",
    ], options);
    return "";
  } catch (cause) {
    const error = cause as { stderr?: string; stdout?: string; message?: string };
    return `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`;
  }
}

async function cliAsync<T>(binary: string, socket: string, args: readonly string[]): Promise<T> {
  return new Promise<T>((resolveCall, rejectCall) => {
    execFile(binary, ["--socket", socket, ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        rejectCall(error);
        return;
      }
      try {
        resolveCall(JSON.parse(stdout) as T);
      } catch (cause) {
        rejectCall(cause);
      }
    });
  });
}

async function waitForInstalledService(service: RunningService, operatorSocket: string, mcpSocket: string): Promise<void> {
  try {
    await waitForUnixSocket(operatorSocket);
    await waitForUnixSocket(mcpSocket);
  } catch (cause) {
    throw new Error([
      cause instanceof Error ? cause.message : String(cause),
      `exit=${String(service.child.exitCode)}`,
      `signal=${String(service.child.signalCode)}`,
      `stderr=${service.stderr()}`,
    ].join("; "));
  }
}

describe.skipIf(!isMechanicsGate)("deterministic E0 production mechanics", () => {
  it("recovers held forge truth and delivers each candidate exactly once before safe cleanup", async () => {
    const binaryRoot = process.env["COMIS_DEV_CREW_BIN_DIR"];
    if (binaryRoot === undefined) throw new Error("COMIS_DEV_CREW_BIN_DIR is required");
    const serviceBinary = join(binaryRoot, "devcrew-service");
    const mcpBinary = join(binaryRoot, "devcrew-mcp");
    const cliBinary = join(binaryRoot, "devcrew");
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "e0-mechanics-")));
    const dataDir = join(scratch, "data");
    const runtimeRoot = join(scratch, "runtime");
    const runDir = join(scratch, "run");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const canonicalDataDir = realpathSync(dataDir);
    const repository = createFixtureRepository(scratch);
    const candidate = createCandidateFixture(scratch, repository);
    const controlSocket = join(canonicalDataDir, "control.sock");
    const mcpSocket = join(runDir, "mcp.sock");
    const operatorSocket = join(runDir, "operator.sock");
    const credentialFile = join(runDir, "control.credential");
    const configPath = join(scratch, "config.yaml");
    const goDatabase = join(scratch, "go-state", "devcrew.db");
    writeFileSync(credentialFile, CONTROL_SECRET, { mode: 0o600 });
    chmodSync(credentialFile, 0o600);

    const previousControl = process.env[CONTROL_SECRET_NAME];
    const previousProvider = process.env[PROVIDER_SECRET_NAME];
    process.env[CONTROL_SECRET_NAME] = CONTROL_SECRET;
    process.env[PROVIDER_SECRET_NAME] = "fixture-provider-key";
    const model = new LiaisonModelServer();
    const telegram = createTgEmulator({ botToken: FAKE_BOT_TOKEN });
    let service: RunningService | undefined;
    let daemon: TestDaemonHandle | undefined;

    const startService = (): RunningService => startInstalledService({
      binary: serviceBinary,
      database: goDatabase,
      operatorSocket,
      mcpSocket,
      runtimeRoot,
      repository,
      controlSocket,
      credentialFile,
      candidateConfig: candidate.configPath,
      launcher: MECHANICS_LAUNCHER,
      terminalAllowEntryId: MECHANICS_ALLOW_ID,
      additionalArguments: [
        "--fixture-worker",
        "--fixture-decision", "use the bounded deterministic choice",
        "--fixture-artifact", "report.md",
      ],
    });

    try {
      await candidate.forge.start();
      bindForgeBaseUrl(candidate.configPath, candidate.forge.baseUrl);
      await model.start();
      const telegramHandle = await telegram.start();
      const gatewayPort = await getFreePort();
      const daemonConfig = makeConfig({
        dataDir: canonicalDataDir,
        gatewayPort,
        modelBaseUrl: model.baseUrl,
        mcpBinary,
        mcpSocket,
        controlSocket,
        workspaceRoot: repository.worktreeRoot,
        runtimeRoot,
        launcher: MECHANICS_LAUNCHER,
        allowId: MECHANICS_ALLOW_ID,
        reviewedToken: MECHANICS_TOKEN,
        contextWindow: 131_072,
        capabilityClass: "frontier",
      });
      daemonConfig["channels"] = {
        telegram: {
          enabled: true,
          botToken: FAKE_BOT_TOKEN,
          apiRoot: telegramHandle.apiRoot,
          allowFrom: [],
        },
      };
      writeFileSync(configPath, stringify(daemonConfig), { mode: 0o600 });

      const bootDaemonAndService = async (): Promise<{
        handle: TestDaemonHandle;
        service: RunningService;
      }> => {
        process.env[CONTROL_SECRET_NAME] = CONTROL_SECRET;
        process.env[PROVIDER_SECRET_NAME] = "fixture-provider-key";
        const daemonOutcome = startTestDaemon({
          configPath,
          gatewayPort,
          overrides: { capabilityServiceContributions: [CONTRIBUTION] },
        }).then((handle) => ({ ok: true as const, handle }), (cause: unknown) => ({
          ok: false as const,
          cause,
        }));
        await waitForUnixSocket(controlSocket);
        const runningService = startService();
        service = runningService;
        await waitForInstalledService(runningService, operatorSocket, mcpSocket);
        const outcome = await daemonOutcome;
        if (!outcome.ok) {
          throw outcome.cause;
        }
        const handle = outcome.handle;
        expect(handle.daemon.adapterRegistry.get("telegram")).toMatchObject({ channelType: "telegram" });
        expect(handle.daemon.capabilityServices.runtime.getActiveView().instances).toContainEqual(
          expect.objectContaining({ serviceInstanceId: SERVICE_INSTANCE_ID, state: "active" }),
        );
        return { handle, service: runningService };
      };

      let boot = await bootDaemonAndService();
      daemon = boot.handle;
      service = boot.service;
      const handles: string[] = [];
      for (const [shape, deliveryMode] of [["ship", "pull_request"], ["scout", "report"]] as const) {
        let taskHandle = "";
        await liaisonTurn(model, telegram, `PREPARE_MECHANICS_${shape.toUpperCase()}`, [{
          tool: "prepare_task",
          arguments: {
            shape,
            repositoryId: "fixture-repository",
            baseRevision: repository.baseRevision,
            acceptanceCriteria: [`Exercise deterministic ${shape} delivery mechanics.`],
            constraints: ["Use the deterministic fixture worker and reviewed validation profile."],
            validationProfile: MECHANICS_PROFILE,
            deliveryMode,
            workerProfileId: "fixture-worker",
          },
          capture: (text) => { taskHandle = /task-[a-f0-9]{24}/u.exec(text)?.[0] ?? ""; },
        }]);
        expect(
          taskHandle,
          `${attachmentDiagnostic(goDatabase, runtimeRoot, canonicalDataDir)}; service=${service?.stderr() ?? ""}`,
        ).toMatch(/^task-[a-f0-9]{24}$/u);
        handles.push(taskHandle);
      }
      const [shipTask, scoutTask] = handles as [string, string];
      const shipBinding = runBinding(canonicalDataDir, shipTask);
      const scoutBinding = runBinding(canonicalDataDir, scoutTask);

      await pollUntil(
        () => candidate.forge.checkRequestObserved && taskState(goDatabase, shipTask) === "validating",
        30_000,
        () => `deterministic forge hold; ship=${taskState(goDatabase, shipTask)} scout=${taskState(goDatabase, scoutTask)} stderr=${service?.stderr() ?? ""}`,
      );
      expect(candidate.forge.pullCreateCount).toBe(1);
      expect(taskState(goDatabase, shipTask)).not.toBe("delivered");
      console.log("FORGE_TRUTH_HELD_BEFORE_RELEASE");

      console.log("RESTART_DAEMON_AND_SERVICE_MID_FLIGHT");
      await stopDaemon(daemon);
      daemon = undefined;
      await service.stop();
      candidate.forge.releaseChecks();
      boot = await bootDaemonAndService();
      daemon = boot.handle;
      service = boot.service;

      await pollUntil(
        () => taskState(goDatabase, shipTask) === "delivered"
          && taskState(goDatabase, scoutTask) === "delivered"
          && evidenceDelivered(goDatabase, handles)
          && comisEvidenceCounts(canonicalDataDir, [shipBinding.managed_run_id, scoutBinding.managed_run_id])
            .every((count) => count === 2)
          && managedRunContinuationsSettled(canonicalDataDir, [shipBinding.managed_run_id, scoutBinding.managed_run_id]),
        90_000,
        () => `deterministic delivery recovery; ship=${taskState(goDatabase, shipTask)} scout=${taskState(goDatabase, scoutTask)} stderr=${service?.stderr() ?? ""}`,
      );
      const deliveryMessages = telegram.outbound(TELEGRAM_CHAT);
      console.log(`TELEGRAM_WIRE_RESULT=${JSON.stringify(deliveryMessages.map((entry) => ({
        method: entry.method,
        messageId: entry.messageId,
        text: entry.text,
        caption: entry.caption,
      })))}`);
      expect(candidate.forge.pullCreateCount).toBe(1);
      expect(deliveryMessages.filter((entry) =>
        entry.text?.includes("https://github.com/fixture-owner/fixture-repository/pull/1") === true
      )).toHaveLength(1);
      expect(deliveryMessages.filter((entry) =>
        entry.method === "sendDocument" && entry.caption?.includes("LIAISON_TURN_DONE") === true
      )).toHaveLength(1);
      expect(existsSync(join(shipBinding.canonical_path, ".e0-real-codex-started"))).toBe(false);
      expect(existsSync(join(scoutBinding.canonical_path, ".e0-real-codex-started"))).toBe(false);
      console.log("EXACTLY_ONCE_SHIP_AND_SCOUT_DELIVERY");

      const holdDb = new Database(goDatabase);
      holdDb.prepare(`INSERT INTO task_cleanup_holds(task_handle, hold_id, reason, opened_at)
        VALUES (?, 'hold-e0-review', 'review remains open', ?)`).run(scoutTask, new Date().toISOString());
      holdDb.close();
      const heldFailure = cleanupFailure(cliBinary, operatorSocket, scoutTask, "cleanup-mechanics-scout-held");
      expect(heldFailure).not.toBe("");
      expect(cleanupSnapshot(goDatabase, scoutTask)).toEqual({
        state: "delivered",
        openHolds: 1,
        operations: [],
      });
      expect(existsSync(scoutBinding.canonical_path)).toBe(true);
      console.log("CLEANUP_HOLD_REFUSED");

      const closeHoldDb = new Database(goDatabase);
      closeHoldDb.prepare(`UPDATE task_cleanup_holds SET closed_at = ?
        WHERE task_handle = ? AND hold_id = 'hold-e0-review'`).run(new Date().toISOString(), scoutTask);
      closeHoldDb.close();
      writeFileSync(join(scoutBinding.canonical_path, "cleanup-dirty.txt"), "preserve me\n", { mode: 0o600 });
      const dirtyFailure = cleanupFailure(cliBinary, operatorSocket, scoutTask, "cleanup-mechanics-scout-dirty");
      expect(dirtyFailure).not.toBe("");
      expect(cleanupSnapshot(goDatabase, scoutTask)).toEqual({
        state: "cleanup_held",
        openHolds: 0,
        operations: [{
          operationId: "cleanup-mechanics-scout-dirty",
          stage: "prepared",
          hostReleasedAt: null,
          removalAuthorizedAt: null,
        }],
      });
      expect(existsSync(scoutBinding.canonical_path)).toBe(true);
      console.log("DIRTY_WORKTREE_CLEANUP_REFUSED");
      rmSync(join(scoutBinding.canonical_path, "cleanup-dirty.txt"));

      let cleanedScout: { state: string } | undefined;
      let cleanupReplayFailure = "none";
      await pollUntil(async () => {
        try {
          cleanedScout = await cliAsync<{ state: string }>(cliBinary, operatorSocket, [
            "task", "cleanup", scoutTask, "--operation", "cleanup-mechanics-scout-dirty", "--format", "json",
          ]);
          return cleanedScout.state === "cleaned";
        } catch (cause) {
          cleanupReplayFailure = cause instanceof Error ? cause.message : String(cause);
          return false;
        }
      }, 60_000, () => `deterministic scout cleanup replay; cleanup=${JSON.stringify(cleanupSnapshot(goDatabase, scoutTask))}; release=${releaseSnapshot(canonicalDataDir, scoutBinding.managed_run_id)}; lastFailure=${cleanupReplayFailure}; service=${service?.stderr() ?? ""}`);
      expect(cleanedScout?.state).toBe("cleaned");
      let cleanedShip: { state: string } | undefined;
      let shipCleanupFailure = "none";
      await pollUntil(async () => {
        try {
          cleanedShip = await cliAsync<{ state: string }>(cliBinary, operatorSocket, [
            "task", "cleanup", shipTask, "--operation", "cleanup-mechanics-ship", "--format", "json",
          ]);
          return cleanedShip.state === "cleaned";
        } catch (cause) {
          shipCleanupFailure = cause instanceof Error ? cause.message : String(cause);
          return false;
        }
      }, 60_000, () => `deterministic ship cleanup; cleanup=${JSON.stringify(cleanupSnapshot(goDatabase, shipTask))}; release=${releaseSnapshot(canonicalDataDir, shipBinding.managed_run_id)}; lastFailure=${shipCleanupFailure}; service=${service?.stderr() ?? ""}`);
      expect(cleanedShip?.state).toBe("cleaned");
      await pollUntil(
        () => taskState(goDatabase, shipTask) === "cleaned" && taskState(goDatabase, scoutTask) === "cleaned",
        30_000,
        "both deterministic task cleanups",
      );
      expect(existsSync(shipBinding.canonical_path)).toBe(false);
      expect(existsSync(scoutBinding.canonical_path)).toBe(false);
      expect(releasedLeaseCount(canonicalDataDir, [shipBinding.workspace_lease_id, scoutBinding.workspace_lease_id])).toBe(2);
      console.log("FINAL_CLEANUP_COMPLETED");

      console.log(`E0_MECHANICS_RESULT=${JSON.stringify({
        productionTelegramAdapter: true,
        telegramApiRootLoopback: telegramHandle.apiRoot.startsWith("http://127.0.0.1:"),
        telegramConversationId: String(TELEGRAM_CHAT.chatId),
        deterministicFixtureWorkers: true,
        forgeTruthGated: true,
        restartRecovered: true,
        shipDeliveredExactlyOnce: true,
        scoutDeliveredExactlyOnce: true,
        cleanupHoldRefused: true,
        dirtyCleanupRefused: true,
        cleanupCompleted: true,
      })}`);
    } finally {
      await stopDaemon(daemon);
      await service?.stop();
      await model.close();
      await telegram.stop();
      await candidate.forge.close();
      if (previousControl === undefined) delete process.env[CONTROL_SECRET_NAME];
      else process.env[CONTROL_SECRET_NAME] = previousControl;
      if (previousProvider === undefined) delete process.env[PROVIDER_SECRET_NAME];
      else process.env[PROVIDER_SECRET_NAME] = previousProvider;
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 300_000);
});
