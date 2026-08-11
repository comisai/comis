// SPDX-License-Identifier: Apache-2.0
/** Full live E0 custody journey using the current installed Go composition. */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  chmodSync,
  existsSync,
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
import { EchoChannelAdapter } from "@comis/channels";
import { startTestDaemon, type TestDaemonHandle } from "../../../support/daemon-harness.js";
import { createFixtureRepository, waitForUnixSocket } from "../../../support/capability-service-vertical-harness.js";
import { getFreePort } from "../../../support/free-port.js";
import {
  CONTRIBUTION,
  CONTROL_SECRET,
  CONTROL_SECRET_NAME,
  LiaisonModelServer,
  PROVIDER_SECRET_NAME,
  SERVICE_INSTANCE_ID,
  acceptedReportDiagnostic,
  cli,
  makeConfig,
  normalizedMessage,
  pollUntil,
  runBinding,
  startInstalledService,
  stopDaemon,
  type LaunchPlan,
  type RunningService,
  type TaskStatusSnapshot,
} from "./wave4-join.test.js";

const E0_LAUNCHER = "/usr/local/bin/e0-codex-launcher";
const E0_ALLOW_ID = "codex-e0-confined";
const E0_TOKEN = "e0-reviewed";
const E0_PROFILE = "e0-live";
const E0_DECISION_ANSWER = "Proceed with the bounded developer intervention.";
const isFullJourney = process.env["COMIS_LIVE"] === "1"
  && process.env["COMIS_E0_FULL"] === "1"
  && process.platform === "linux";

interface ToolStep {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly capture?: (text: string) => void;
}

interface InjectableChannelManager {
  injectMessage(channelType: string, message: ReturnType<typeof normalizedMessage>): Promise<void>;
}

interface CandidateFixture {
  readonly configPath: string;
  readonly forge: ForgeFixtureServer;
}

interface PullTruth {
  readonly number: number;
  readonly branch: string;
}

class ForgeFixtureServer {
  private server: Server | undefined;
  private baseUrlValue = "";
  private pull: PullTruth | undefined;

  constructor(
    readonly gitExecutable: string,
    readonly remote: string,
  ) {}

  get baseUrl(): string {
    return this.baseUrlValue;
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
    if (address === null || typeof address === "string") throw new Error("forge fixture did not bind TCP");
    this.baseUrlValue = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
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
      if (!branch.startsWith("devcrew/")) {
        this.json(response, { error: "invalid head" }, 422);
        return;
      }
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
        base: { ref: "master" },
      });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith(`${prefix}/commits/`) && url.pathname.endsWith("/check-runs")) {
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
): CandidateFixture {
  const forgeRoot = join(scratch, "forge");
  const remote = join(forgeRoot, "fixture.git");
  const credentialDirectory = join(forgeRoot, "credentials");
  const readCredentialFile = join(forgeRoot, "read.credential");
  const pushCredentialFile = join(forgeRoot, "push.credential");
  const configPath = join(forgeRoot, "candidate.json");
  mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
  execFileSync(repository.gitExecutable, ["init", "--bare", remote], { stdio: "pipe" });
  const forge = new ForgeFixtureServer(repository.gitExecutable, remote);
  writeFileSync(readCredentialFile, "e0_read_identity", { mode: 0o600 });
  writeFileSync(pushCredentialFile, "e0_push_identity", { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    programs: [{ id: "repository-check", executable: "/usr/bin/true" }],
    profiles: [{
      id: E0_PROFILE,
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
    pollInterval: "1m",
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

function ignoreJourneyDiagnostics(repository: ReturnType<typeof createFixtureRepository>): void {
  const common = execFileSync(repository.gitExecutable, [
    "-C", repository.primary, "rev-parse", "--path-format=absolute", "--git-common-dir",
  ], { encoding: "utf8" }).trim();
  const exclude = join(common, "info", "exclude");
  const current = readFileSync(exclude, "utf8");
  writeFileSync(exclude, `${current}\n.e0-*\n.wave4-*\n`, { mode: 0o600 });
}

function git(repository: ReturnType<typeof createFixtureRepository>, cwd: string, args: readonly string[]): string {
  return execFileSync(repository.gitExecutable, ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function commitFile(
  repository: ReturnType<typeof createFixtureRepository>,
  worktree: string,
  file: string,
  contents: string,
  message: string,
): string {
  writeFileSync(join(worktree, file), contents, { mode: 0o600 });
  git(repository, worktree, ["add", "--", file]);
  git(repository, worktree, [
    "-c", "user.name=E0 Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-m", message,
  ]);
  return git(repository, worktree, ["rev-parse", "HEAD"]);
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

function terminalTransition(databasePath: string, taskHandle: string): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    const row = db.prepare("SELECT latest_transition FROM task_terminal_bindings WHERE task_handle = ?")
      .get(taskHandle) as { latest_transition: string } | undefined;
    return row?.latest_transition ?? "missing";
  } finally {
    db.close();
  }
}

function handbackDiagnostic(databasePath: string, taskHandle: string): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    const task = db.prepare(`SELECT state, updated_at AS updatedAt, report_cursor AS reportCursor,
      state_version AS stateVersion, brief_revision AS briefRevision,
      brief_revision_hash AS briefRevisionHash, managed_run_id AS managedRunId,
      workspace_lease_id AS workspaceLeaseId, execution_attachment_id AS executionAttachmentId,
      attachment_target_name AS attachmentTargetName
      FROM tasks WHERE handle = ?`).get(taskHandle);
    const terminal = db.prepare(`SELECT latest_transition AS latestTransition,
      running_observed AS runningObserved, updated_at AS updatedAt
      FROM task_terminal_bindings WHERE task_handle = ?`).get(taskHandle);
    const validation = db.prepare(`SELECT COUNT(*) AS active
      FROM validation_processes WHERE task_handle = ? AND state <> 'exited'`).get(taskHandle);
    const handbacks = db.prepare(`SELECT operation_id AS operationId, observed_at AS observedAt,
      state_version AS stateVersion FROM task_handbacks WHERE task_handle = ? ORDER BY observed_at, operation_id`)
      .all(taskHandle);
    const candidateReports = db.prepare(`SELECT local_report_id AS localReportId,
      state_version AS stateVersion, accepted_at AS acceptedAt FROM reports
      WHERE task_handle = ? AND kind = 'candidate_complete' ORDER BY accepted_at, local_report_id`).all(taskHandle);
    return JSON.stringify({ observedAt: new Date().toISOString(), task, terminal, validation, handbacks, candidateReports });
  } finally {
    db.close();
  }
}

function cleanupDiagnostic(databasePath: string, taskHandle: string): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    const task = db.prepare("SELECT state, state_version AS stateVersion, updated_at AS updatedAt FROM tasks WHERE handle = ?")
      .get(taskHandle);
    const cleanups = db.prepare(`SELECT operation_id AS operationId, stage,
      release_operation_id AS releaseOperationId, released_at AS releasedAt,
      host_released_at AS hostReleasedAt, removal_authorized_at AS removalAuthorizedAt,
      completed_at AS completedAt FROM task_cleanup_operations WHERE task_handle = ? ORDER BY operation_id`)
      .all(taskHandle);
    return JSON.stringify({ task, cleanups });
  } finally {
    db.close();
  }
}

function reportKinds(databasePath: string, taskHandle: string): string[] {
  const db = new Database(databasePath, { readonly: true });
  try {
    return (db.prepare("SELECT kind FROM reports WHERE task_handle = ? ORDER BY accepted_at, local_report_id")
      .all(taskHandle) as Array<{ kind: string }>).map((row) => row.kind);
  } finally {
    db.close();
  }
}

function workerJoinDiagnostic(worktree: string): Record<string, string> {
  const read = (file: string): string => {
    try {
      return readFileSync(join(worktree, file), "utf8").trim();
    } catch {
      return "missing";
    }
  };
  return {
    launcher: read(".wave4-launcher.log"),
    reporter: read(".wave4-reporter.log"),
    client: read(".wave4-client-diagnostic.log"),
  };
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

interface AttentionSnapshot {
  readonly attentionId: string;
  readonly status: string;
  readonly responseRef: string | null;
}

function attentionSnapshot(dataDir: string, managedRunId: string): AttentionSnapshot | undefined {
  const db = new Database(join(dataDir, "memory.db"), { readonly: true });
  try {
    return db.prepare(`SELECT attention_id AS attentionId, status, response_ref AS responseRef
      FROM managed_run_attention WHERE managed_run_id = ? ORDER BY created_at_ms DESC LIMIT 1`)
      .get(managedRunId) as AttentionSnapshot | undefined;
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

function deliveryDiagnostic(
  goDatabasePath: string,
  dataDir: string,
  taskHandles: readonly string[],
  managedRunIds: readonly string[],
): string {
  const goDb = new Database(goDatabasePath, { readonly: true });
  const comisDb = new Database(join(dataDir, "memory.db"), { readonly: true });
  try {
    const taskSlots = taskHandles.map(() => "?").join(", ");
    const runSlots = managedRunIds.map(() => "?").join(", ");
    return JSON.stringify({
      goEvidence: goDb.prepare(`SELECT task_handle AS taskHandle, evidence_ref AS evidenceRef,
        delivery_kind AS deliveryKind, delivered_at AS deliveredAt
        FROM comis_evidence_outbox WHERE task_handle IN (${taskSlots})
        ORDER BY task_handle, evidence_ref`).all(...taskHandles),
      goReports: goDb.prepare(`SELECT reports.task_handle AS taskHandle, reports.kind,
        outbox.delivered_at AS deliveredAt
        FROM comis_report_outbox AS outbox
        JOIN reports ON reports.task_handle = outbox.task_handle
          AND reports.local_report_id = outbox.local_report_id
        WHERE reports.task_handle IN (${taskSlots})
        ORDER BY reports.task_handle, reports.state_version`).all(...taskHandles),
      comisRuns: comisDb.prepare(`SELECT managed_run_id AS managedRunId, status,
        last_accepted_report_sequence AS acceptedSequence,
        last_reduced_report_sequence AS reducedSequence,
        pending_continuation AS pendingContinuation
        FROM managed_runs WHERE managed_run_id IN (${runSlots})
        ORDER BY managed_run_id`).all(...managedRunIds),
      comisEvidence: comisDb.prepare(`SELECT managed_run_id AS managedRunId,
        evidence_ref AS evidenceRef, delivery_kind AS deliveryKind
        FROM managed_run_evidence WHERE managed_run_id IN (${runSlots})
        ORDER BY managed_run_id, evidence_ref`).all(...managedRunIds),
    });
  } finally {
    goDb.close();
    comisDb.close();
  }
}

async function liaisonTurn(
  model: LiaisonModelServer,
  channelManager: InjectableChannelManager,
  echo: EchoChannelAdapter,
  message: string,
  steps: readonly ToolStep[],
): Promise<void> {
  await pollUntil(() => model.idle, 10_000, `liaison idle before ${message}`);
  const before = echo.getSentMessages().filter((entry) => entry.text.includes("LIAISON_TURN_DONE")).length;
  model.setScript(steps);
  await channelManager.injectMessage("echo", normalizedMessage(message));
  await pollUntil(
    () => model.idle && echo.getSentMessages().filter((entry) => entry.text.includes("LIAISON_TURN_DONE")).length > before,
    60_000,
    `${message} response`,
  );
}

function cleanupFailure(
  cliBinary: string,
  operatorSocket: string,
  taskHandle: string,
  operationId: string,
): string {
  const options: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8" };
  try {
    execFileSync(cliBinary, [
      "--socket", operatorSocket, "task", "cleanup", taskHandle,
      "--operation", operationId, "--format", "json",
    ], options);
    return "";
  } catch (cause) {
    const error = cause as { stderr?: string; stdout?: string; message?: string };
    return `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`;
  }
}

describe.skipIf(!isFullJourney)("complete E0 real-worker custody journey", () => {
  it("delivers ship and scout work through restart, intervention, and fail-closed cleanup", async () => {
    const binaryRoot = process.env["COMIS_DEV_CREW_BIN_DIR"];
    if (binaryRoot === undefined) throw new Error("COMIS_DEV_CREW_BIN_DIR is required");
    const serviceBinary = join(binaryRoot, "devcrew-service");
    const mcpBinary = join(binaryRoot, "devcrew-mcp");
    const cliBinary = join(binaryRoot, "devcrew");
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "e0-journey-")));
    const dataDir = join(scratch, "data");
    const runtimeRoot = join(scratch, "runtime");
    const runDir = join(scratch, "run");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const canonicalDataDir = realpathSync(dataDir);
    const repository = createFixtureRepository(scratch);
    ignoreJourneyDiagnostics(repository);
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
      launcher: E0_LAUNCHER,
      terminalAllowEntryId: E0_ALLOW_ID,
    });

    try {
      await candidate.forge.start();
      bindForgeBaseUrl(candidate.configPath, candidate.forge.baseUrl);
      await model.start();
      service = startService();
      await waitForUnixSocket(operatorSocket);
      await waitForUnixSocket(mcpSocket);
      const gatewayPort = await getFreePort();
      writeFileSync(configPath, stringify(makeConfig({
        dataDir: canonicalDataDir,
        gatewayPort,
        modelBaseUrl: model.baseUrl,
        mcpBinary,
        mcpSocket,
        controlSocket,
        workspaceRoot: repository.worktreeRoot,
        runtimeRoot,
        launcher: E0_LAUNCHER,
        allowId: E0_ALLOW_ID,
        reviewedToken: E0_TOKEN,
        contextWindow: 131_072,
        capabilityClass: "frontier",
      })), { mode: 0o600 });

      const bootDaemon = async (): Promise<{
        handle: TestDaemonHandle;
        echo: EchoChannelAdapter;
        channelManager: InjectableChannelManager;
      }> => {
        // Each boot represents a fresh daemon process whose service manager
        // supplies credentials again after the prior process scrubbed them.
        process.env[CONTROL_SECRET_NAME] = CONTROL_SECRET;
        process.env[PROVIDER_SECRET_NAME] = "fixture-provider-key";
        const handle = await startTestDaemon({
          configPath,
          gatewayPort,
          overrides: { capabilityServiceContributions: [CONTRIBUTION] },
        });
        const echo = new EchoChannelAdapter({ channelId: "echo-main", channelType: "echo" });
        handle.daemon.adapterRegistry.set("echo", echo);
        handle.daemon.deliveryAdapters.set("echo", echo);
        const channelManager = handle.daemon.channelManager;
        if (channelManager === undefined) throw new Error("channel manager is unavailable");
        expect(handle.daemon.capabilityServices.runtime.getActiveView().instances).toContainEqual(
          expect.objectContaining({ serviceInstanceId: SERVICE_INSTANCE_ID, state: "active" }),
        );
        return { handle, echo, channelManager };
      };

      let boot = await bootDaemon();
      daemon = boot.handle;
      const handles: string[] = [];
      for (const [shape, deliveryMode] of [["ship", "pull_request"], ["scout", "report"]] as const) {
        let taskHandle = "";
        await liaisonTurn(model, boot.channelManager, boot.echo, `PREPARE_E0_${shape.toUpperCase()}`, [{
          tool: "prepare_task",
          arguments: {
            shape,
            repositoryId: "fixture-repository",
            baseRevision: repository.baseRevision,
            acceptanceCriteria: [`The ${shape} worker preserves exact task custody.`],
            constraints: ["Use only the reviewed E0 worker and validation profile."],
            validationProfile: E0_PROFILE,
            deliveryMode,
            workerProfileId: "codex-reviewed",
          },
          capture: (text) => { taskHandle = /task-[a-f0-9]{24}/u.exec(text)?.[0] ?? ""; },
        }]);
        expect(taskHandle).toMatch(/^task-[a-f0-9]{24}$/u);
        handles.push(taskHandle);
      }
      const [shipTask, scoutTask] = handles as [string, string];
      const shipBinding = runBinding(canonicalDataDir, shipTask);
      const scoutBinding = runBinding(canonicalDataDir, scoutTask);
      const shipPlan = cli<LaunchPlan>(cliBinary, operatorSocket, ["task", "launch-plan", shipTask, "--format", "json"]);
      const scoutPlan = cli<LaunchPlan>(cliBinary, operatorSocket, ["task", "launch-plan", scoutTask, "--format", "json"]);
      expect(shipPlan.terminalAllowEntryId).toBe(E0_ALLOW_ID);
      expect(scoutPlan.terminalAllowEntryId).toBe(E0_ALLOW_ID);

      commitFile(repository, scoutBinding.canonical_path, "report.md", `# Scout report\n\nTask: ${scoutTask}\n`, "add scout report");
      for (const [binding, task, role, sibling, siblingAttachment] of [
        [shipBinding, shipTask, "ship", scoutBinding, scoutPlan.attachmentTargetName],
        [scoutBinding, scoutTask, "scout", shipBinding, shipPlan.attachmentTargetName],
      ] as const) {
        writeFileSync(join(binding.canonical_path, ".e0-identity"), task, { mode: 0o600 });
        writeFileSync(join(binding.canonical_path, ".e0-role"), `${role}\n`, { mode: 0o600 });
        writeFileSync(join(binding.canonical_path, ".e0-sibling.json"), JSON.stringify({
          siblingPath: sibling.canonical_path,
          siblingAttachment,
        }), { mode: 0o600 });
      }

      let shipSession = "";
      let scoutSession = "";
      await liaisonTurn(model, boot.channelManager, boot.echo, "LAUNCH_E0_SHIP_AND_SCOUT", [
        { tool: "get_launch_plan", arguments: { taskHandle: shipTask } },
        { tool: "get_launch_plan", arguments: { taskHandle: scoutTask } },
        {
          tool: "terminal_session_create",
          arguments: {
            allowId: E0_ALLOW_ID,
            command: E0_LAUNCHER,
            args: [],
            managedRunId: shipBinding.managed_run_id,
            workspaceLeaseId: shipBinding.workspace_lease_id,
          },
          capture: (text) => { shipSession = /"sessionId"\s*:\s*"([^"]+)"/u.exec(text)?.[1] ?? ""; },
        },
        {
          tool: "terminal_session_create",
          arguments: {
            allowId: E0_ALLOW_ID,
            command: E0_LAUNCHER,
            args: [],
            managedRunId: scoutBinding.managed_run_id,
            workspaceLeaseId: scoutBinding.workspace_lease_id,
          },
          capture: (text) => { scoutSession = /"sessionId"\s*:\s*"([^"]+)"/u.exec(text)?.[1] ?? ""; },
        },
      ]);
      expect(shipSession).not.toBe("");
      expect(scoutSession).not.toBe("");
      writeFileSync(join(shipBinding.canonical_path, ".e0-start"), "go\n", { mode: 0o600 });
      writeFileSync(join(scoutBinding.canonical_path, ".e0-start"), "go\n", { mode: 0o600 });

      await pollUntil(() => {
        const status = cli<TaskStatusSnapshot>(cliBinary, operatorSocket, ["status", "--format", "json"]);
        return [shipTask, scoutTask].every((task) => status.tasks.some((entry) => entry.taskHandle === task && entry.state === "working"));
      }, 180_000, () => `two E0 workers joined in fleet views; ${JSON.stringify({
        shipState: taskState(goDatabase, shipTask),
        scoutState: taskState(goDatabase, scoutTask),
        ship: workerJoinDiagnostic(shipBinding.canonical_path),
        scout: workerJoinDiagnostic(scoutBinding.canonical_path),
        service: service.stderr(),
      })}`);
      await pollUntil(
        () => reportKinds(goDatabase, shipTask).includes("decision") && reportKinds(goDatabase, scoutTask).includes("candidate_complete"),
        180_000,
        () => `ship decision and scout candidate; ${acceptedReportDiagnostic(goDatabase, handles)}`,
      );

      await pollUntil(
        () => attentionSnapshot(canonicalDataDir, shipBinding.managed_run_id)?.status === "open"
          && managedRunContinuationsSettled(canonicalDataDir, [shipBinding.managed_run_id, scoutBinding.managed_run_id]),
        60_000,
        "decision request delivered through the originating liaison continuation",
      );
      const attention = attentionSnapshot(canonicalDataDir, shipBinding.managed_run_id);
      if (attention === undefined) throw new Error("ship attention request is absent after continuation settlement");
      const deliveredBeforeAnswer = boot.echo.getSentMessages().length;
      await boot.channelManager.injectMessage(
        "echo",
        normalizedMessage(`/attention ${attention.attentionId} ${E0_DECISION_ANSWER}`),
      );
      await pollUntil(
        () => attentionSnapshot(canonicalDataDir, shipBinding.managed_run_id)?.status === "response_pending"
          && boot.echo.getSentMessages().slice(deliveredBeforeAnswer)
            .some((entry) => entry.text === "Response recorded for attention request [REDACTED]."),
        30_000,
        () => `liaison decision answer binding; attention=${JSON.stringify(attentionSnapshot(canonicalDataDir, shipBinding.managed_run_id))}; replies=${JSON.stringify(boot.echo.getSentMessages().slice(deliveredBeforeAnswer).map((entry) => entry.text))}`,
      );
      writeFileSync(join(shipBinding.canonical_path, ".e0-answer"), `${E0_DECISION_ANSWER}\n`, { mode: 0o600 });
      await pollUntil(
        () => taskState(goDatabase, shipTask) === "paused"
          && ["validating", "delivered"].includes(taskState(goDatabase, scoutTask))
          && attentionSnapshot(canonicalDataDir, shipBinding.managed_run_id)?.status === "resolved"
          && managedRunContinuationsSettled(canonicalDataDir, [shipBinding.managed_run_id, scoutBinding.managed_run_id]),
        180_000,
        () => `ship pause and scout candidate state; ship=${taskState(goDatabase, shipTask)} scout=${taskState(goDatabase, scoutTask)}`,
      );
      expect(reportKinds(goDatabase, shipTask)).toEqual(expect.arrayContaining(["progress", "decision", "resolution", "paused"]));
      expect(reportKinds(goDatabase, scoutTask)).toEqual(expect.arrayContaining(["progress", "candidate_complete"]));

      for (const binding of [shipBinding, scoutBinding]) {
        const evidence = JSON.parse(readFileSync(join(binding.canonical_path, ".e0-confinement.json"), "utf8")) as Record<string, boolean>;
        expect(evidence).toEqual({ siblingReadBlocked: true, siblingWriteBlocked: true, siblingAttachmentAbsent: true });
      }
      let selectiveList = "";
      await liaisonTurn(model, boot.channelManager, boot.echo, "STOP_E0_SHIP_ONLY", [
        { tool: "terminal_session_kill", arguments: { sessionId: shipSession } },
        { tool: "terminal_session_list", arguments: {}, capture: (text) => { selectiveList = text; } },
      ]);
      expect(selectiveList).not.toContain(shipSession);
      expect(selectiveList).toContain(scoutSession);
      await pollUntil(
        () => taskState(goDatabase, shipTask) === "paused"
          && ["exited", "released"].includes(terminalTransition(goDatabase, shipTask)),
        30_000,
        () => `ship terminal settlement; task=${taskState(goDatabase, shipTask)} terminal=${terminalTransition(goDatabase, shipTask)}`,
      );

      commitFile(repository, shipBinding.canonical_path, "ship.txt", `Delivered ship task ${shipTask}\n`, "complete ship task");
      let handback = "";
      let postHandbackSessions = "";
      await liaisonTurn(model, boot.channelManager, boot.echo, "HAND_BACK_DEVELOPER_WORK", [
        {
          tool: "handback_task",
          arguments: { taskHandle: shipTask, action: "validate-developer-work" },
          capture: (text) => { handback = text; },
        },
        {
          tool: "terminal_session_list",
          arguments: {},
          capture: (text) => { postHandbackSessions = text; },
        },
      ]);
      expect(handback, handbackDiagnostic(goDatabase, shipTask)).toContain("validating");
      expect(postHandbackSessions).toContain(scoutSession);

      await pollUntil(
        () => taskState(goDatabase, shipTask) === "delivered" && taskState(goDatabase, scoutTask) === "delivered",
        150_000,
        () => `delivered tasks before restart; ship=${taskState(goDatabase, shipTask)} scout=${taskState(goDatabase, scoutTask)} diagnostic=${deliveryDiagnostic(
          goDatabase,
          canonicalDataDir,
          handles,
          [shipBinding.managed_run_id, scoutBinding.managed_run_id],
        )} stderr=${service?.stderr() ?? ""}`,
      );
      await pollUntil(
        () => evidenceDelivered(goDatabase, handles)
          && comisEvidenceCounts(canonicalDataDir, [shipBinding.managed_run_id, scoutBinding.managed_run_id]).every((count) => count === 2)
          && managedRunContinuationsSettled(canonicalDataDir, [shipBinding.managed_run_id, scoutBinding.managed_run_id]),
        60_000,
        "exact evidence delivery before restart",
      );

      await liaisonTurn(model, boot.channelManager, boot.echo, "STOP_E0_SCOUT", [
        { tool: "terminal_session_kill", arguments: { sessionId: scoutSession } },
      ]);
      console.log("RESTART_DAEMON_AND_SERVICE_AFTER_DELIVERY");
      await stopDaemon(daemon);
      daemon = undefined;
      await service.stop();
      service = startService();
      await waitForUnixSocket(operatorSocket);
      await waitForUnixSocket(mcpSocket);
      boot = await bootDaemon();
      daemon = boot.handle;
      await pollUntil(
        () => taskState(goDatabase, shipTask) === "delivered"
          && taskState(goDatabase, scoutTask) === "delivered"
          && evidenceDelivered(goDatabase, handles)
          && comisEvidenceCounts(canonicalDataDir, [shipBinding.managed_run_id, scoutBinding.managed_run_id]).every((count) => count === 2),
        30_000,
        "delivered custody and exact evidence recovery after restart",
      );
      expect(service.child.exitCode).toBeNull();

      const holdDb = new Database(goDatabase);
      holdDb.prepare(`INSERT INTO task_cleanup_holds(task_handle, hold_id, reason, opened_at)
        VALUES (?, 'hold-e0-review', 'review remains open', ?)`).run(scoutTask, new Date().toISOString());
      holdDb.close();
      expect(cleanupFailure(cliBinary, operatorSocket, scoutTask, "cleanup-e0-scout-held")).not.toBe("");
      expect(existsSync(scoutBinding.canonical_path)).toBe(true);

      const closeHoldDb = new Database(goDatabase);
      closeHoldDb.prepare(`UPDATE task_cleanup_holds SET closed_at = ?
        WHERE task_handle = ? AND hold_id = 'hold-e0-review'`).run(new Date().toISOString(), scoutTask);
      closeHoldDb.close();
      writeFileSync(join(scoutBinding.canonical_path, "cleanup-dirty.txt"), "preserve me\n", { mode: 0o600 });
      expect(cleanupFailure(cliBinary, operatorSocket, scoutTask, "cleanup-e0-scout-dirty")).not.toBe("");
      console.log("DIRTY_WORKTREE_CLEANUP_REFUSED");
      expect(existsSync(scoutBinding.canonical_path)).toBe(true);
      rmSync(join(scoutBinding.canonical_path, "cleanup-dirty.txt"));
      let cleanedScout: { state: string };
      try {
        cleanedScout = cli<{ state: string }>(cliBinary, operatorSocket, [
          "task", "cleanup", scoutTask, "--operation", "cleanup-e0-scout-dirty", "--format", "json",
        ]);
      } catch (cause) {
        const processDiagnostic = `serviceExit=${String(service.child.exitCode)}; serviceSignal=${String(service.child.signalCode)}`;
        throw new Error(
          `scout cleanup replay failed; ${cleanupDiagnostic(goDatabase, scoutTask)}; ${processDiagnostic}; serviceStderr=${service.stderr()}`,
          { cause },
        );
      }
      expect(cleanedScout.state).toBe("cleaned");

      let cleanedShip = "";
      await liaisonTurn(model, boot.channelManager, boot.echo, "CLEANUP_E0_SHIP", [{
        tool: "cleanup_task",
        arguments: { taskHandle: shipTask },
        capture: (text) => { cleanedShip = text; },
      }]);
      expect(cleanedShip).toContain("cleaned");
      await pollUntil(
        () => taskState(goDatabase, shipTask) === "cleaned" && taskState(goDatabase, scoutTask) === "cleaned",
        30_000,
        "both E0 task cleanups",
      );
      expect(existsSync(shipBinding.canonical_path)).toBe(false);
      expect(existsSync(scoutBinding.canonical_path)).toBe(false);
      expect(releasedLeaseCount(canonicalDataDir, [shipBinding.workspace_lease_id, scoutBinding.workspace_lease_id])).toBe(2);

      console.log("NETWORK_CONFINEMENT_NOT_PROVEN=outer Docker bridge is shared; filesystem and sibling worktree refusal are bubblewrap-enforced");
      console.log(`E0_RESULT=${JSON.stringify({
        workersJoined: true,
        decisionRoundTrip: true,
        restartRecovered: true,
        shipDelivered: true,
        scoutDelivered: true,
        cleanupHoldRefused: true,
        dirtyCleanupRefused: true,
        cleanupCompleted: true,
      })}`);
    } finally {
      await stopDaemon(daemon);
      await service?.stop();
      await model.close();
      await candidate.forge.close();
      if (previousControl === undefined) delete process.env[CONTROL_SECRET_NAME];
      else process.env[CONTROL_SECRET_NAME] = previousControl;
      if (previousProvider === undefined) delete process.env[PROVIDER_SECRET_NAME];
      else process.env[PROVIDER_SECRET_NAME] = previousProvider;
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 600_000);
});
