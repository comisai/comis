// SPDX-License-Identifier: Apache-2.0
/** Non-gating real-Codex E0 journey observation using the installed Go composition. */
import { execFile, execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
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
import { performance } from "node:perf_hooks";
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
  type RecordedOutbound,
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
  acceptedReportDiagnostic,
  cli,
  makeConfig,
  pollUntil,
  runBinding,
  startInstalledService,
  stopDaemon,
  type LaunchPlan,
  type RunningService,
  type TaskStatusSnapshot,
} from "./wave4-join.test.js";
import { E0_CODEX_LAUNCHER_REQUIREMENT } from "./reviewed-launcher-requirements.js";

const E0_LAUNCHER = E0_CODEX_LAUNCHER_REQUIREMENT.path;
const E0_ALLOW_ID = "codex-e0-confined";
const E0_TOKEN = E0_CODEX_LAUNCHER_REQUIREMENT.reviewedToken;
const E0_PROFILE = "e0-live";
const E0_DECISION_ANSWER = "Proceed with the bounded developer intervention.";
const isFullJourney = process.env["COMIS_LIVE"] === "1"
  && process.env["COMIS_E0_OBSERVE"] === "1"
  && process.platform === "linux";
const TELEGRAM_CHAT: ChatRef = Object.freeze({ chatId: 424_242 });
const TELEGRAM_USER = Object.freeze({ id: 678_314_278, firstName: "Capability", username: "capability_user" });

interface ToolStep {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly capture?: (text: string) => void;
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
  private readonly checkGate: Promise<void>;
  private releaseCheckGate: (() => void) | undefined;
  private checkRequestObservedValue = false;
  private pullCreateCountValue = 0;
  private readonly requestsValue: string[] = [];

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

  get requests(): readonly string[] {
    return this.requestsValue;
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
    if (address === null || typeof address === "string") throw new Error("forge fixture did not bind TCP");
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
    this.requestsValue.push(`${request.method ?? "UNKNOWN"} ${url.pathname}${url.search}`);
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
        total_count: 1,
        check_runs: [{
          id: 1,
          name: "ci/e0",
          status: "completed",
          conclusion: "success",
          started_at: "2026-01-01T00:00:00Z",
        }],
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
  const forge = new ForgeFixtureServer(repository.gitExecutable, remote, repository.defaultBranch);
  writeFileSync(readCredentialFile, "e0_read_identity", { mode: 0o600 });
  writeFileSync(pushCredentialFile, "e0_push_identity", { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    programs: [{ id: "repository-check", executable: "/usr/bin/sleep" }],
    profiles: [{
      id: E0_PROFILE,
      localChecks: [{
        id: "repository-unit",
        programId: "repository-check",
        arguments: [{ kind: "literal", value: "0.1" }],
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
    integrationPolicies: [{ id: "integration-default", strategy: "merge" }],
    maxOutputBytes: 65_536,
    // Keep test progress independent of the supervisor timer phase while still
    // exercising the installed service's durable polling path.
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
    const validation = db.prepare(`SELECT operation_id AS operationId, program_id AS programId,
      state, pid, executable_label AS executableLabel, exit_code AS exitCode
      FROM validation_processes WHERE task_handle = ? ORDER BY operation_id`).all(taskHandle);
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

function scoutDecisionFinding(databasePath: string, taskHandle: string): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    const row = db.prepare("SELECT finding FROM scout_decision_attestations WHERE task_handle = ?")
      .get(taskHandle) as { finding: string } | undefined;
    return row?.finding ?? "missing";
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

function approvalCallback(entry: RecordedOutbound): string | undefined {
  const markup = entry.replyMarkup as {
    inline_keyboard?: Array<Array<{ callback_data?: string }>>;
  } | undefined;
  return markup?.inline_keyboard
    ?.flat()
    .find((button) => button.callback_data?.startsWith("v1.approve.") === true)
    ?.callback_data;
}

async function approvedLiaisonTurn(
  model: LiaisonModelServer,
  telegram: TgEmulator,
  message: string,
  steps: readonly ToolStep[],
): Promise<void> {
  await pollUntil(() => model.idle, 10_000, `liaison idle before ${message}`);
  const outboundBefore = telegram.outbound(TELEGRAM_CHAT).length;
  const completedBefore = telegram.outbound(TELEGRAM_CHAT)
    .filter((entry) => entry.text?.includes("LIAISON_TURN_DONE") === true).length;
  model.setScript(steps);
  telegram.injectMessage(TELEGRAM_CHAT, TELEGRAM_USER, message);

  let approvalEntry: RecordedOutbound | undefined;
  let callbackData: string | undefined;
  await pollUntil(() => {
    approvalEntry = telegram.outbound(TELEGRAM_CHAT)
      .slice(outboundBefore)
      .find((entry) => approvalCallback(entry) !== undefined);
    callbackData = approvalEntry === undefined ? undefined : approvalCallback(approvalEntry);
    return callbackData !== undefined;
  }, 30_000, `${message} signed approval prompt`);
  telegram.injectCallback(TELEGRAM_CHAT, TELEGRAM_USER, approvalEntry!.messageId, callbackData!);

  await pollUntil(
    () => model.idle && telegram.outbound(TELEGRAM_CHAT)
      .filter((entry) => entry.text?.includes("LIAISON_TURN_DONE") === true).length > completedBefore,
    60_000,
    `${message} approved response`,
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

async function cliAsync<T>(binary: string, socket: string, args: readonly string[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    execFile(binary, ["--socket", socket, ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

async function waitForInstalledService(
  service: RunningService,
  operatorSocket: string,
  mcpSocket: string,
): Promise<void> {
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

describe.skipIf(!isFullJourney)("non-gating E0 real-worker custody journey observation", () => {
  it("delivers ship and scout work through restart, intervention, and fail-closed cleanup", async () => {
    const binaryRoot = process.env["COMIS_DEV_CREW_BIN_DIR"];
    if (binaryRoot === undefined) throw new Error("COMIS_DEV_CREW_BIN_DIR is required");
    const serviceBinary = join(binaryRoot, "devcrew-service");
    const mcpBinary = join(binaryRoot, "devcrew-mcp");
    const cliBinary = join(binaryRoot, "devcrew");
    const journeyStartedAt = performance.now();
    const stageDurationsMs: Record<string, number> = {};
    const finishStage = (stage: string, startedAt: number): void => {
      stageDurationsMs[stage] = Math.round(performance.now() - startedAt);
    };
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
      launcher: E0_LAUNCHER,
      terminalAllowEntryId: E0_ALLOW_ID,
    });

    try {
      await candidate.forge.start();
      bindForgeBaseUrl(candidate.configPath, candidate.forge.baseUrl);
      await model.start();
      const telegramHandle = await telegram.start();
      service = startService();
      await waitForInstalledService(service, operatorSocket, mcpSocket);
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
        launcher: E0_LAUNCHER,
        allowId: E0_ALLOW_ID,
        reviewedToken: E0_TOKEN,
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
      daemonConfig["approvals"] = { enabled: true, defaultTimeoutMs: 30_000, batchApprovalTtlMs: 0 };
      writeFileSync(configPath, stringify(daemonConfig), { mode: 0o600 });

      const bootDaemon = async (): Promise<{ handle: TestDaemonHandle }> => {
        // Each boot represents a fresh daemon process whose service manager
        // supplies credentials again after the prior process scrubbed them.
        process.env[CONTROL_SECRET_NAME] = CONTROL_SECRET;
        process.env[PROVIDER_SECRET_NAME] = "fixture-provider-key";
        const handle = await startTestDaemon({
          configPath,
          gatewayPort,
          overrides: { capabilityServiceContributions: [CONTRIBUTION] },
        });
        expect(handle.daemon.adapterRegistry.get("telegram")).toMatchObject({ channelType: "telegram" });
        const serviceDiagnostic = [
          `exit=${String(service?.child.exitCode)}`,
          `signal=${String(service?.child.signalCode)}`,
          `stderr=${service?.stderr() ?? "unavailable"}`,
        ].join("; ");
        expect(
          handle.daemon.capabilityServices.runtime.getActiveView().instances,
          `capability service did not become active; ${serviceDiagnostic}`,
        ).toContainEqual(
          expect.objectContaining({ serviceInstanceId: SERVICE_INSTANCE_ID, state: "active" }),
        );
        return { handle };
      };

      let boot = await bootDaemon();
      daemon = boot.handle;
      finishStage("startup", journeyStartedAt);
      const handles: string[] = [];
      const taskPrepareStartedAt = performance.now();
      for (const [shape, deliveryMode] of [["ship", "pull_request"], ["scout", "report"]] as const) {
        let taskHandle = "";
        const turnStartedAt = performance.now();
        await liaisonTurn(model, telegram, `PREPARE_E0_${shape.toUpperCase()}`, [{
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
        if (shape === "ship") finishStage("initialTurn", turnStartedAt);
        expect(taskHandle).toMatch(/^task-[a-f0-9]{24}$/u);
        handles.push(taskHandle);
      }
      finishStage("taskPrepare", taskPrepareStartedAt);
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
      const workerLaunchStartedAt = performance.now();
      await liaisonTurn(model, telegram, "LAUNCH_E0_SHIP_AND_SCOUT", [
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
      }, 180_000, () => `two E0 workers joined in status views; ${JSON.stringify({
        shipState: taskState(goDatabase, shipTask),
        scoutState: taskState(goDatabase, scoutTask),
        ship: workerJoinDiagnostic(shipBinding.canonical_path),
        scout: workerJoinDiagnostic(scoutBinding.canonical_path),
        service: service.stderr(),
      })}`);
      finishStage("workerLaunch", workerLaunchStartedAt);
      const candidateValidationStartedAt = performance.now();
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
      const deliveredBeforeAnswer = telegram.outbound(TELEGRAM_CHAT).length;
      telegram.injectMessage(
        TELEGRAM_CHAT,
        TELEGRAM_USER,
        `/attention ${attention.attentionId} ${E0_DECISION_ANSWER}`,
      );
      await pollUntil(
        () => {
          const status = attentionSnapshot(canonicalDataDir, shipBinding.managed_run_id)?.status;
          return (status === "response_pending" || status === "delivered")
            && telegram.outbound(TELEGRAM_CHAT).slice(deliveredBeforeAnswer)
              .some((entry) => entry.text === "Response recorded for attention request [REDACTED].");
        },
        30_000,
        () => `liaison decision answer binding; attention=${JSON.stringify(attentionSnapshot(canonicalDataDir, shipBinding.managed_run_id))}; replies=${JSON.stringify(telegram.outbound(TELEGRAM_CHAT).slice(deliveredBeforeAnswer).map((entry) => entry.text))}`,
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
      finishStage("candidateValidation", candidateValidationStartedAt);

      for (const binding of [shipBinding, scoutBinding]) {
        const evidence = JSON.parse(readFileSync(join(binding.canonical_path, ".e0-confinement.json"), "utf8")) as Record<string, boolean>;
        expect(evidence).toEqual({ siblingReadBlocked: true, siblingWriteBlocked: true, siblingAttachmentAbsent: true });
      }
      let selectiveList = "";
      await liaisonTurn(model, telegram, "STOP_E0_SHIP_ONLY", [
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
      const interventionRevalidationStartedAt = performance.now();
      await liaisonTurn(model, telegram, "HAND_BACK_DEVELOPER_WORK", [
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
        () => candidate.forge.checkRequestObserved && taskState(goDatabase, shipTask) === "validating",
        30_000,
        () => `ship validation blocked on forge truth; ship=${taskState(goDatabase, shipTask)} forge=${JSON.stringify(candidate.forge.requests)} git=${JSON.stringify({
          branch: git(repository, shipBinding.canonical_path, ["branch", "--show-current"]),
          head: git(repository, shipBinding.canonical_path, ["rev-parse", "HEAD"]),
          status: git(repository, shipBinding.canonical_path, ["status", "--porcelain=v2", "--untracked-files=all"]),
        })} diagnostic=${handbackDiagnostic(goDatabase, shipTask)} stderr=${service?.stderr() ?? ""}`,
      );
      finishStage("interventionRevalidation", interventionRevalidationStartedAt);
      expect(candidate.forge.pullCreateCount).toBe(1);
      await liaisonTurn(model, telegram, "STOP_E0_SCOUT", [
        { tool: "terminal_session_kill", arguments: { sessionId: scoutSession } },
      ]);
      await pollUntil(
        () => ["validating", "delivered"].includes(taskState(goDatabase, scoutTask))
          && ["exited", "released"].includes(terminalTransition(goDatabase, scoutTask)),
        30_000,
        () => `scout terminal settlement; task=${taskState(goDatabase, scoutTask)} terminal=${terminalTransition(goDatabase, scoutTask)}`,
      );
      console.log("RESTART_DAEMON_AND_SERVICE_MID_FLIGHT");
      const restartRecoveryStartedAt = performance.now();
      await stopDaemon(daemon);
      daemon = undefined;
      await service.stop();
      candidate.forge.releaseChecks();
      service = startService();
      await waitForInstalledService(service, operatorSocket, mcpSocket);
      boot = await bootDaemon();
      daemon = boot.handle;
      finishStage("restartRecovery", restartRecoveryStartedAt);
      const deliveryStartedAt = performance.now();
      await pollUntil(
        () => taskState(goDatabase, shipTask) === "delivered"
          && taskState(goDatabase, scoutTask) === "delivered"
          && evidenceDelivered(goDatabase, handles)
          && comisEvidenceCounts(canonicalDataDir, [shipBinding.managed_run_id, scoutBinding.managed_run_id]).every((count) => count === 2)
          && managedRunContinuationsSettled(canonicalDataDir, [shipBinding.managed_run_id, scoutBinding.managed_run_id]),
        150_000,
        () => `delivered custody and exact evidence recovery after restart; ship=${taskState(goDatabase, shipTask)} scout=${taskState(goDatabase, scoutTask)} diagnostic=${deliveryDiagnostic(
          goDatabase,
          canonicalDataDir,
          handles,
          [shipBinding.managed_run_id, scoutBinding.managed_run_id],
        )} stderr=${service?.stderr() ?? ""}`,
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
      expect(service.child.exitCode).toBeNull();
      finishStage("delivery", deliveryStartedAt);

      let reviewedScout = "";
      const cleanupStartedAt = performance.now();
      await liaisonTurn(model, telegram, "REVIEW_E0_SCOUT_DECISIONS", [{
        tool: "attest_scout_decisions",
        arguments: { taskHandle: scoutTask, finding: "no_open_decisions", openDecisionKeys: [] },
        capture: (text) => { reviewedScout = text; },
      }]);
      expect(reviewedScout).toContain(scoutTask);
      expect(scoutDecisionFinding(goDatabase, scoutTask)).toBe("no_open_decisions");

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
      let cleanedScout: { state: string } | undefined;
      let cleanupReplayFailure = "none";
      await pollUntil(async () => {
        try {
          cleanedScout = await cliAsync<{ state: string }>(cliBinary, operatorSocket, [
            "task", "cleanup", scoutTask, "--operation", "cleanup-e0-scout-dirty", "--format", "json",
          ]);
          return cleanedScout.state === "cleaned";
        } catch (cause) {
          cleanupReplayFailure = cause instanceof Error ? cause.message : String(cause);
          return false;
        }
      }, 60_000, () => {
        const processDiagnostic = `serviceExit=${String(service.child.exitCode)}; serviceSignal=${String(service.child.signalCode)}`;
        return `scout cleanup replay; ${cleanupDiagnostic(goDatabase, scoutTask)}; ${processDiagnostic}; lastFailure=${cleanupReplayFailure}; serviceStderr=${service.stderr()}`;
      });
      expect(cleanedScout?.state).toBe("cleaned");

      let cleanedShip = "";
      await approvedLiaisonTurn(model, telegram, "CLEANUP_E0_SHIP", [{
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
      finishStage("cleanup", cleanupStartedAt);

      console.log("NETWORK_CONFINEMENT_NOT_PROVEN=outer Docker bridge is shared; filesystem and sibling worktree refusal are bubblewrap-enforced");
      console.log(`E0_STAGE_DURATIONS_MS=${JSON.stringify(stageDurationsMs)}`);
      console.log(`E0_RESULT=${JSON.stringify({
        productionTelegramAdapter: true,
        telegramApiRootLoopback: telegramHandle.apiRoot.startsWith("http://127.0.0.1:"),
        telegramConversationId: String(TELEGRAM_CHAT.chatId),
        workersJoined: true,
        decisionRoundTrip: true,
        restartRecovered: true,
        shipDelivered: true,
        scoutDelivered: true,
        cleanupHoldRefused: true,
        dirtyCleanupRefused: true,
        cleanupApprovalGranted: true,
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
  }, 600_000);
});
