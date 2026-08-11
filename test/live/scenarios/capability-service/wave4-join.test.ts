// SPDX-License-Identifier: Apache-2.0
/** Live, Linux-only JOIN of Comis managed terminals and the committed Go service. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { EchoChannelAdapter } from "@comis/channels";
import type { CapabilityServiceContributionRegistration, NormalizedMessage } from "@comis/core";
import { startTestDaemon, type TestDaemonHandle } from "../../../support/daemon-harness.js";
import { createFixtureRepository, waitForUnixSocket } from "../../../support/capability-service-vertical-harness.js";
import { getFreePort } from "../../../support/free-port.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../../../..");
const REVIEWED_GO_COMMIT = process.env["COMIS_DEV_CREW_COMMIT"]
  ?? "1521c4445dca6eb6e26548dc5f8f6646796b2d01";
export const SERVICE_INSTANCE_ID = "service-instance-wave4-join";
export const MCP_SERVER_NAME = "devcrew";
export const CONTROL_SECRET_NAME = "WAVE4_CONTROL_BEARER";
export const PROVIDER_SECRET_NAME = "WAVE4_FIXTURE_PROVIDER_KEY";
export const CONTROL_SECRET = "wave4-control-bearer-0123456789abcdef";
const REVIEWED_LAUNCHER = "/usr/local/bin/wave4-codex-launcher";
const REVIEWED_ALLOW_ID = "codex-confined";
const REVIEWED_TOKEN = "wave4-reviewed";
const isLiveLinux = process.env["COMIS_LIVE"] === "1" && process.platform === "linux";
const REAL_WORKER_JOIN_TIMEOUT_MS = 180_000;
const isE0Journey = process.env["COMIS_E0_JOURNEY"] === "1";

const E0_MUTATION_BINDINGS = isE0Journey ? [
  {
    toolName: "handback_task",
    behavior: "run_command" as const,
    runHandleArgument: "taskHandle",
    actionClassification: "mutate" as const,
    invocationSideEffects: ["task.handback"],
  },
  {
    toolName: "cleanup_task",
    behavior: "run_command" as const,
    runHandleArgument: "taskHandle",
    actionClassification: "destructive" as const,
    invocationSideEffects: ["task.cleanup"],
  },
] : [];

export const CONTRIBUTION: CapabilityServiceContributionRegistration = {
  contributionId: "devcrew.wave4.join",
  configSections: [],
  serviceDefinitions: [{
    serviceDefinitionId: "devcrew.wave4.join",
    protocolId: "comis.capability-service/1" as const,
    mcpServerName: MCP_SERVER_NAME,
    managedToolBindings: [
      {
        toolName: "prepare_task",
        behavior: "prepare_run" as const,
        actionClassification: "mutate" as const,
        invocationSideEffects: ["task.prepare"],
      },
      ...E0_MUTATION_BINDINGS,
      ...["list_tasks", "get_task", "explain_task", "get_launch_plan"].map((toolName) => ({
        toolName,
        behavior: "read_only" as const,
        actionClassification: "read" as const,
        invocationSideEffects: [],
      })),
    ],
    requestedScopes: [
      "health",
      "report",
      ...(isE0Journey ? ["evidence" as const] : []),
      "workspace_lease",
      "terminal_events",
      "execution_attachment",
    ],
    evidencePolicies: isE0Journey ? [
      { kind: "candidate_bundle" as const, verificationLevel: "adapter_verified" as const, use: "outcome" as const },
      { kind: "delivery_reference" as const, verificationLevel: "adapter_verified" as const, use: "delivery_reference" as const },
      { kind: "report_artifact" as const, verificationLevel: "adapter_verified" as const, use: "delivery_attachment" as const },
    ] : [],
    dependsOn: [],
  }],
};

interface ToolStep {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly capture?: (text: string) => void;
}

interface PendingCall {
  readonly kind: "target" | "discovery";
  readonly step: ToolStep;
  readonly name: string;
}

function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string") {
      return (part as { text: string }).text;
    }
    return "";
  }).join("\n");
}

function responseChunk(model: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-wave4-join",
    object: "chat.completion.chunk",
    created: 1_786_300_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

export class LiaisonModelServer {
  private server: Server | undefined;
  private baseUrlValue = "";
  private steps: ToolStep[] = [];
  private pending: PendingCall | undefined;
  private discovered = new Map<string, string>();

  get baseUrl(): string {
    return this.baseUrlValue;
  }

  get idle(): boolean {
    return this.steps.length === 0 && this.pending === undefined;
  }

  setScript(steps: readonly ToolStep[]): void {
    if (!this.idle) {
      throw new Error(`liaison script is already active: pending=${this.pending?.name ?? "none"} steps=${this.steps.map((step) => step.tool).join(",")}`);
    }
    this.steps = [...steps];
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => this.respond(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>, response));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      this.server!.once("error", rejectListen);
      this.server!.listen(0, "127.0.0.1", resolveListen);
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("liaison fixture did not bind TCP");
    this.baseUrlValue = `http://127.0.0.1:${address.port}/v1`;
  }

  async close(): Promise<void> {
    if (this.server === undefined) return;
    await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose()));
    this.server = undefined;
  }

  private respond(body: Record<string, unknown>, response: ServerResponse): void {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1) as { role?: unknown } | undefined;
    if (last?.role === "tool" && this.pending !== undefined) {
      const text = messageText(last);
      if (this.pending.kind === "target") {
        this.pending.step.capture?.(text);
        this.steps.shift();
      } else {
        const discovered = /"name"\s*:\s*"([^"]+)"/u.exec(text)?.[1];
        if (discovered !== undefined) this.discovered.set(this.pending.step.tool, discovered);
      }
      this.pending = undefined;
    }

    const tools = Array.isArray(body.tools) ? body.tools : [];
    const toolNames = tools.flatMap((tool) => {
      const name = (tool as { function?: { name?: unknown } }).function?.name;
      return typeof name === "string" ? [name] : [];
    });
    const step = this.steps[0];
    let toolCall: { name: string; arguments: Record<string, unknown> } | undefined;
    let text = "LIAISON_TURN_DONE";
    if (step !== undefined) {
      const selected = toolNames.find((candidate) => candidate === step.tool || candidate.includes(step.tool))
        ?? this.discovered.get(step.tool);
      if (selected !== undefined) {
        toolCall = { name: selected, arguments: step.arguments };
        this.pending = { kind: "target", step, name: selected };
      } else {
        const discover = toolNames.find((candidate) => candidate === "discover_tools");
        if (discover === undefined) {
          response.statusCode = 500;
          response.end(`tool is unavailable: ${step.tool}`);
          return;
        }
        toolCall = {
          name: discover,
          arguments: { query: `select:mcp__${MCP_SERVER_NAME}--${step.tool}` },
        };
        this.pending = { kind: "discovery", step, name: discover };
      }
      text = "";
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const model = typeof body.model === "string" ? body.model : "fixture-model";
    if (toolCall !== undefined) {
      response.write(responseChunk(model, {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: `call-${randomUUID()}`,
          type: "function",
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
        }],
      }, null));
      response.write(responseChunk(model, {}, "tool_calls"));
    } else {
      response.write(responseChunk(model, { role: "assistant", content: text }, null));
      response.write(responseChunk(model, {}, "stop"));
    }
    response.end("data: [DONE]\n\n");
  }
}

export interface RunningService {
  readonly child: ChildProcess;
  readonly stderr: () => string;
  stop(): Promise<void>;
}

export interface TaskSummary {
  readonly taskHandle: string;
  readonly state: string;
}

export interface TaskStatusSnapshot {
  readonly completeness: string;
  readonly tasks: TaskSummary[];
}

export interface LaunchPlan {
  readonly schemaVersion: number;
  readonly completeness: string;
  readonly taskHandle: string;
  readonly state: string;
  readonly stateSource: string;
  readonly stateConfidence: string;
  readonly freshness: string;
  readonly workerProfileId: string;
  readonly terminalAllowEntryId: string;
  readonly briefRevisionHash: string;
  readonly attachmentTargetName: string;
}

export interface RunBinding {
  readonly managed_run_id: string;
  readonly workspace_lease_id: string;
  readonly canonical_path: string;
}

export function normalizedMessage(text: string): NormalizedMessage {
  return {
    id: randomUUID(),
    channelId: "wave4-conversation",
    channelType: "echo",
    senderId: "user_a",
    text,
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
  };
}

export async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string | (() => string),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      const timeoutLabel = typeof label === "function" ? label() : label;
      throw new Error(`${timeoutLabel} timed out`);
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
  }
}

export async function stopDaemon(handle: TestDaemonHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.cleanup();
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.includes("Daemon exit with code")) throw cause;
  }
}

export function startInstalledService(input: {
  readonly binary: string;
  readonly database: string;
  readonly operatorSocket: string;
  readonly mcpSocket: string;
  readonly runtimeRoot: string;
  readonly repository: ReturnType<typeof createFixtureRepository>;
  readonly controlSocket: string;
  readonly credentialFile: string;
  readonly candidateConfig?: string;
  readonly launcher?: string;
  readonly terminalAllowEntryId?: string;
}): RunningService {
  mkdirSync(dirname(input.database), { recursive: true, mode: 0o700 });
  mkdirSync(input.runtimeRoot, { recursive: true, mode: 0o700 });
  const arguments_ = [
    "--database", input.database,
    "--socket", input.operatorSocket,
    "--mcp-socket", input.mcpSocket,
    "--runtime-root", input.runtimeRoot,
    "--service-instance", SERVICE_INSTANCE_ID,
    "--git-executable", input.repository.gitExecutable,
    "--approved-root", input.repository.approvedRoot,
    "--repository-id", "fixture-repository",
    "--repository-primary", input.repository.primary,
    "--worktree-root", input.repository.worktreeRoot,
    "--repository-default-branch", "master",
    "--comis-socket", input.controlSocket,
    "--comis-credential-file", input.credentialFile,
    "--comis-handshake-operation", "wave4-handshake-operation",
    "--preparation-ttl", "10m",
    "--codex-profile", "codex-reviewed",
    "--codex-executable", input.launcher ?? REVIEWED_LAUNCHER,
    "--codex-version", "codex-cli 0.147.0",
    "--codex-model", process.env["COMIS_WAVE4_CODEX_MODEL"] ?? "gpt-5.5",
    "--codex-effort", "high",
    "--codex-terminal-allow-entry", input.terminalAllowEntryId ?? REVIEWED_ALLOW_ID,
    "--codex-network", "host",
    "--codex-concurrency", "2",
  ];
  if (input.candidateConfig !== undefined) {
    arguments_.push("--candidate-config", input.candidateConfig);
  }
  const child = spawn(input.binary, arguments_, { stdio: ["ignore", "ignore", "pipe"] });
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  return {
    child,
    stderr: () => Buffer.concat(stderr).toString("utf8"),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
        new Promise<void>((resolveTimeout) => setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          resolveTimeout();
        }, 3_000)),
      ]);
    },
  };
}

export function cli<T>(binary: string, socket: string, args: readonly string[]): T {
  const output = execFileSync(binary, ["--socket", socket, ...args], { encoding: "utf8" });
  return JSON.parse(output) as T;
}

function launcherHash(path = REVIEWED_LAUNCHER): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createCandidateConfig(scratch: string): string {
  const forgeRoot = join(scratch, "forge");
  const remote = join(forgeRoot, "fixture.git");
  const credentialDirectory = join(forgeRoot, "credentials");
  const readCredentialFile = join(forgeRoot, "read.credential");
  const pushCredentialFile = join(forgeRoot, "push.credential");
  const candidateConfig = join(forgeRoot, "candidate.json");
  mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  writeFileSync(readCredentialFile, "e0_read_identity", { mode: 0o600 });
  writeFileSync(pushCredentialFile, "e0_push_identity", { mode: 0o600 });
  writeFileSync(candidateConfig, JSON.stringify({
    programs: [{ id: "repository-check", executable: "/usr/bin/true" }],
    profiles: [{
      id: "wave4-live",
      localChecks: [{
        id: "repository-unit",
        programId: "repository-check",
        arguments: [{ kind: "literal", value: "--version" }],
        timeout: "30s",
        required: true,
      }],
      forgeChecks: [{ name: "ci/join", required: true }],
      artifactRules: [{
        kind: "regular_file",
        relativePath: "wave4-artifact.txt",
        mediaType: "text/plain",
        maxBytes: 16_384,
      }],
      evidenceTtl: "24h",
    }],
    maxOutputBytes: 65_536,
    pollInterval: "1m",
    forge: {
      apiBaseUrl: "http://127.0.0.1:1",
      owner: "fixture-owner",
      repository: "fixture-repository",
      remoteUrl: `file://${remote}`,
      readCredentialFile,
      pushCredentialFile,
      credentialDirectory,
      localFixtureRemoteRoot: forgeRoot,
    },
  }), { mode: 0o600 });
  return candidateConfig;
}

export function makeConfig(input: {
  readonly dataDir: string;
  readonly gatewayPort: number;
  readonly modelBaseUrl: string;
  readonly mcpBinary: string;
  readonly mcpSocket: string;
  readonly controlSocket: string;
  readonly workspaceRoot: string;
  readonly runtimeRoot: string;
  readonly launcher?: string;
  readonly allowId?: string;
  readonly reviewedToken?: string;
  readonly contextWindow?: number;
  readonly capabilityClass?: "frontier" | "mid" | "small" | "nano";
}): Record<string, unknown> {
  const launcher = input.launcher ?? REVIEWED_LAUNCHER;
  const allowId = input.allowId ?? REVIEWED_ALLOW_ID;
  const reviewedToken = input.reviewedToken ?? REVIEWED_TOKEN;
  return {
    tenantId: "test",
    logLevel: "warn",
    dataDir: input.dataDir,
    providers: { entries: { fixture: {
      type: "fixture-openai-compatible",
      baseUrl: input.modelBaseUrl,
      apiKeyName: PROVIDER_SECRET_NAME,
      maxRetries: 0,
      capabilities: { providerFamily: "openai" },
      models: [{
        id: "fixture-model",
        reasoning: false,
        contextWindow: input.contextWindow ?? 32_768,
        maxTokens: 2_048,
        input: ["text"],
      }],
    } } },
    models: { defaultModel: "fixture:fixture-model" },
    agents: { default: {
      name: "WaveFourLiaison",
      provider: "fixture",
      model: "fixture-model",
      ...(input.capabilityClass === undefined ? {} : { capabilityClass: input.capabilityClass }),
      thinkingLevel: "off",
      maxSteps: 16,
      budgets: { perExecution: 500_000, perHour: 5_000_000, perDay: 50_000_000 },
      circuitBreaker: { failureThreshold: 100, resetTimeoutMs: 1_000 },
      rag: { enabled: false },
      skills: { terminal: {
        enabled: true,
        worker: { maxSessions: 2, idleTtlMs: 900_000, ringBytes: 262_144, stuckMs: 30_000, maxConcurrentAttentionTurns: 2 },
        allow: [{
          id: allowId,
          match: { path: launcher, argsPrefix: [reviewedToken], hash: launcherHash(launcher) },
          scope: {
            filesystem: "workspace",
            network: "full",
        credentialPaths: ["~/.codex/auth.json", "/home/comis/.wave4-tools"],
            uid: "daemon",
          },
          autoAnswer: "none",
          consent: { acknowledgedRisk: true, acknowledgedAt: "2026-08-10T00:00:00Z" },
          backend: "tmux",
          hardening: "none",
        }],
      } },
      autonomy: {
        profile: "standard",
        durability: { enabled: true, staleHeartbeatMs: 120_000, keepAliveMs: 30_000, recoveryBudgetMs: 30_000 },
        mcp: { enabled: true, allow: { [MCP_SERVER_NAME]: {
          tools: [
            "prepare_task",
            ...(isE0Journey ? ["handback_task", "cleanup_task"] : []),
            "list_tasks", "get_task", "explain_task", "get_launch_plan",
          ],
          classification: "safe",
        } } },
      },
    } },
    gateway: {
      enabled: true,
      host: "127.0.0.1",
      port: input.gatewayPort,
      tokens: [{ id: "wave4-token", secret: "wave4-gateway-secret-for-integration-tests", scopes: ["rpc", "ws", "admin"] }],
      rateLimit: { windowMs: 60_000, maxRequests: 10_000 },
      maxBatchSize: 50,
      wsHeartbeatMs: 30_000,
    },
    embedding: { enabled: false },
    memory: { enabled: false, dbPath: "memory.db" },
    scheduler: {
      cron: { enabled: false },
      heartbeat: { intervalMs: 300_000, showOk: false, showAlerts: true },
      quietHours: { enabled: false, criticalBypass: true },
    },
    security: { agentToAgent: { enabled: true } },
    monitoring: {
      disk: { enabled: false }, resources: { enabled: false }, systemd: { enabled: false },
      securityUpdates: { enabled: false }, git: { enabled: false },
    },
    integrations: { mcp: {
      osvCheckEnabled: false,
      callToolTimeoutMs: 30_000,
      servers: [{
        name: MCP_SERVER_NAME,
        transport: "stdio",
        command: input.mcpBinary,
        args: ["--socket", input.mcpSocket, "--service-instance", SERVICE_INSTANCE_ID],
        toolAllowlist: [
          "prepare_task",
          ...(isE0Journey ? ["handback_task", "cleanup_task"] : []),
          "list_tasks", "get_task", "explain_task", "get_launch_plan",
        ],
        keepaliveIntervalMs: 0,
      }],
    } },
    capabilityServices: { instances: [{
      serviceInstanceId: SERVICE_INSTANCE_ID,
      serviceDefinitionId: "devcrew.wave4.join",
      enabled: true,
      mcpServerName: MCP_SERVER_NAME,
      control: { transport: "unix", socketPath: input.controlSocket, credentialRef: `secret://${CONTROL_SECRET_NAME}` },
      allowedAgents: ["default"],
      allowedWorkspaceRoots: [input.workspaceRoot],
      allowedRuntimeRoots: [input.runtimeRoot],
    }] },
  };
}

export function runBinding(dataDir: string, taskHandle: string): RunBinding {
  const digest = createHash("sha256").update(taskHandle).digest("hex");
  const db = new Database(join(dataDir, "memory.db"), { readonly: true });
  try {
    const row = db.prepare(`
      SELECT mr.managed_run_id, mr.workspace_lease_id, wl.canonical_path
      FROM managed_runs mr JOIN workspace_leases wl ON wl.managed_run_id = mr.managed_run_id
      WHERE mr.external_run_ref_digest = ?
    `).get(digest) as RunBinding | undefined;
    if (row === undefined) throw new Error(`managed binding is absent for ${taskHandle}`);
    return row;
  } finally {
    db.close();
  }
}

function reportCounts(dataDir: string, taskHandles: readonly string[]): number[] {
  const db = new Database(join(dataDir, "memory.db"), { readonly: true });
  try {
    return taskHandles.map((taskHandle) => {
      const digest = createHash("sha256").update(taskHandle).digest("hex");
      const row = db.prepare(`
        SELECT COUNT(*) AS count FROM managed_run_reports reports
        JOIN managed_runs runs ON runs.managed_run_id = reports.managed_run_id
        WHERE runs.external_run_ref_digest = ?
      `).get(digest) as { count: number };
      return row.count;
    });
  } finally {
    db.close();
  }
}

function launcherDiagnostic(worktree: string): string {
  try {
    return readFileSync(join(worktree, ".wave4-launch-error"), "utf8").trim();
  } catch {
    return "launcher did not write a failure marker";
  }
}

function runtimeContextDiagnostic(worktree: string): string {
  try {
    return readFileSync(join(worktree, ".wave4-runtime-context.json"), "utf8").trim();
  } catch {
    return "launcher did not write runtime context";
  }
}

function reporterDiagnostic(worktree: string): string {
  try {
    return readFileSync(join(worktree, ".wave4-reporter.log"), "utf8").trim();
  } catch {
    return "worker did not write reporter diagnostics";
  }
}

function clientDiagnostic(worktree: string): string {
  try {
    return readFileSync(join(worktree, ".wave4-client-diagnostic.log"), "utf8").trim();
  } catch {
    return "worker did not write runtime client diagnostics";
  }
}

function failedJoinDurableDiagnostic(databasePath: string, taskHandles: readonly string[]): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    const placeholders = taskHandles.map(() => "?").join(", ");
    const tasks = db.prepare(`
      SELECT
        tasks.handle AS taskHandle,
        tasks.state,
        tasks.state_version AS stateVersion,
        tasks.managed_run_id AS managedRunId,
        tasks.workspace_lease_id AS workspaceLeaseId,
        tasks.brief_revision AS briefRevision,
        tasks.brief_revision_hash AS briefRevisionHash,
        tasks.updated_at AS taskUpdatedAt,
        preparations.requested_workspace_root AS requestedWorkspaceRoot,
        bindings.terminal_session_id AS terminalSessionId,
        bindings.latest_transition AS latestTerminalTransition,
        bindings.running_observed AS terminalRunningObserved,
        bindings.updated_at AS terminalUpdatedAt
      FROM tasks
      LEFT JOIN task_preparations preparations ON preparations.task_handle = tasks.handle
      LEFT JOIN task_terminal_bindings bindings ON bindings.task_handle = tasks.handle
      WHERE tasks.handle IN (${placeholders})
      ORDER BY tasks.handle
    `).all(...taskHandles);
    const terminalEvents = db.prepare(`
      SELECT task_handle AS taskHandle, terminal_session_id AS terminalSessionId,
        transition, observed_at AS observedAt, operation_id AS operationId
      FROM task_terminal_events
      WHERE task_handle IN (${placeholders})
      ORDER BY observed_at, operation_id
    `).all(...taskHandles);
    const launchAcknowledgements = db.prepare(`
      SELECT operation_id AS operationId, task_handle AS taskHandle,
        managed_run_id AS managedRunId, workspace_lease_id AS workspaceLeaseId,
        working_directory AS workingDirectory, brief_revision AS briefRevision,
        brief_revision_hash AS briefRevisionHash, acknowledged_at AS acknowledgedAt
      FROM task_launch_acknowledgements
      WHERE task_handle IN (${placeholders})
      ORDER BY acknowledged_at, operation_id
    `).all(...taskHandles);
    const operations = db.prepare(`
      SELECT id, command, status, error_code AS errorCode,
        state_version AS stateVersion, created_at AS createdAt, updated_at AS updatedAt
      FROM operations
      WHERE command IN ('RecordTerminalEvent', 'AcknowledgeWorkerLaunch')
      ORDER BY state_version, id
    `).all();
    const operationReplayConflicts = db.prepare(`
      SELECT operation_id AS operationId, original_command AS originalCommand,
        presented_command AS presentedCommand
      FROM operation_replay_conflicts
      ORDER BY conflict_id
    `).all();
    return JSON.stringify({
      tasks,
      terminalEvents,
      task_launch_acknowledgements: launchAcknowledgements,
      operations,
      operation_replay_conflicts: operationReplayConflicts,
    });
  } catch (cause) {
    return `durable diagnostic failed: ${cause instanceof Error ? cause.message : String(cause)}`;
  } finally {
    db.close();
  }
}

export function acceptedReportDiagnostic(databasePath: string, taskHandles: readonly string[]): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    const placeholders = taskHandles.map(() => "?").join(", ");
    return JSON.stringify(db.prepare(`
      SELECT task_handle AS taskHandle, kind, external_key AS externalKey
      FROM reports
      WHERE task_handle IN (${placeholders})
      ORDER BY task_handle, accepted_at, local_report_id
    `).all(...taskHandles));
  } finally {
    db.close();
  }
}

export function acceptedReportCounts(databasePath: string, taskHandles: readonly string[]): number[] {
  const db = new Database(databasePath, { readonly: true });
  try {
    return taskHandles.map((taskHandle) => {
      const row = db.prepare("SELECT COUNT(*) AS count FROM reports WHERE task_handle = ?")
        .get(taskHandle) as { count: number };
      return row.count;
    });
  } finally {
    db.close();
  }
}

describe.skipIf(!isLiveLinux || process.env["COMIS_E0_FULL"] === "1")("wave-four real Codex capability-service JOIN", () => {
  it("confines two task-bound workers and preserves candidate custody across one terminal exit", async () => {
    expect(process.env["COMIS_DEV_CREW_COMMIT"]).toBe(REVIEWED_GO_COMMIT);
    const binaryRoot = process.env["COMIS_DEV_CREW_BIN_DIR"];
    if (binaryRoot === undefined) throw new Error("COMIS_DEV_CREW_BIN_DIR is required");
    const serviceBinary = join(binaryRoot, "devcrew-service");
    const mcpBinary = join(binaryRoot, "devcrew-mcp");
    const cliBinary = join(binaryRoot, "devcrew");
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "wave4-join-")));
    const dataDir = join(scratch, "data");
    const runtimeRoot = join(scratch, "runtime");
    const runDir = join(scratch, "run");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const canonicalDataDir = realpathSync(dataDir);
    const repository = createFixtureRepository(scratch);
    const controlSocket = join(canonicalDataDir, "control.sock");
    const mcpSocket = join(runDir, "mcp.sock");
    const operatorSocket = join(runDir, "operator.sock");
    const credentialFile = join(runDir, "control.credential");
    const configPath = join(scratch, "config.yaml");
    const goDatabase = join(scratch, "go-state", "devcrew.db");
    const candidateConfig = isE0Journey
      ? createCandidateConfig(scratch)
      : undefined;
    writeFileSync(credentialFile, CONTROL_SECRET, { mode: 0o600 });
    chmodSync(credentialFile, 0o600);

    const previousControl = process.env[CONTROL_SECRET_NAME];
    const previousProvider = process.env[PROVIDER_SECRET_NAME];
    process.env[CONTROL_SECRET_NAME] = CONTROL_SECRET;
    process.env[PROVIDER_SECRET_NAME] = "fixture-provider-key";
    const model = new LiaisonModelServer();
    let service: RunningService | undefined;
    let daemon: TestDaemonHandle | undefined;

    try {
      await model.start();
      service = startInstalledService({
        binary: serviceBinary,
        database: goDatabase,
        operatorSocket,
        mcpSocket,
        runtimeRoot,
        repository,
        controlSocket,
        credentialFile,
        candidateConfig,
      });
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
      })), { mode: 0o600 });
      daemon = await startTestDaemon({
        configPath,
        gatewayPort,
        overrides: { capabilityServiceContributions: [CONTRIBUTION] },
      });
      const echo = new EchoChannelAdapter({ channelId: "echo-main", channelType: "echo" });
      daemon.daemon.adapterRegistry.set("echo", echo);
      daemon.daemon.deliveryAdapters.set("echo", echo);
      const channelManager = daemon.daemon.channelManager;
      if (channelManager === undefined) throw new Error("channel manager is unavailable");
      expect(
        daemon.daemon.capabilityServices.runtime.getActiveView().instances,
        `capability service did not become active; service stderr: ${service.stderr()}`,
      ).toContainEqual(
        expect.objectContaining({ serviceInstanceId: SERVICE_INSTANCE_ID, state: "active" }),
      );
      expect(service.child.exitCode).toBeNull();

      const taskHandles: string[] = [];
      for (const identity of ["A", "B"] as const) {
        await pollUntil(() => model.idle, 10_000, `liaison idle before prepare ${identity}`);
        const deliveredBefore = echo.getSentMessages().filter(
          (message) => message.text.includes("LIAISON_TURN_DONE"),
        ).length;
        let taskHandle = "";
        model.setScript([{
          tool: "prepare_task",
          arguments: {
            shape: "scout",
            repositoryId: "fixture-repository",
            baseRevision: repository.baseRevision,
            acceptanceCriteria: [`Worker ${identity} reports only its protected task identity.`],
            constraints: ["Stop in validation custody; do not deliver."],
            validationProfile: "wave4-live",
            deliveryMode: "report",
            workerProfileId: "codex-reviewed",
          },
          capture: (text) => {
            taskHandle = /task-[a-f0-9]{24}/u.exec(text)?.[0] ?? "";
          },
        }]);
        await channelManager.injectMessage("echo", normalizedMessage(`PREPARE_WORKER_${identity}`));
        await pollUntil(
          () => model.idle && echo.getSentMessages().filter(
            (message) => message.text.includes("LIAISON_TURN_DONE"),
          ).length > deliveredBefore,
          30_000,
          `prepare ${identity} response`,
        );
        expect(taskHandle, `prepare ${identity} omitted its safe task handle; service stderr: ${service.stderr()}`)
          .toMatch(/^task-[a-f0-9]{24}$/u);
        taskHandles.push(taskHandle);
      }
      expect(new Set(taskHandles).size).toBe(2);
      const [taskA, taskB] = taskHandles as [string, string];
      const bindingA = runBinding(canonicalDataDir, taskA);
      const bindingB = runBinding(canonicalDataDir, taskB);
      expect(bindingA.managed_run_id).not.toBe(bindingB.managed_run_id);
      expect(bindingA.workspace_lease_id).not.toBe(bindingB.workspace_lease_id);
      expect(bindingA.canonical_path).not.toBe(bindingB.canonical_path);

      const planA = cli<LaunchPlan>(cliBinary, operatorSocket, ["task", "launch-plan", taskA, "--format", "json"]);
      const planB = cli<LaunchPlan>(cliBinary, operatorSocket, ["task", "launch-plan", taskB, "--format", "json"]);
      for (const [plan, handle] of [[planA, taskA], [planB, taskB]] as const) {
        expect(plan).toMatchObject({
          schemaVersion: 1,
          completeness: "complete",
          taskHandle: handle,
          state: "ready",
          stateSource: "durable_store",
          stateConfidence: "verified",
          freshness: "current",
          workerProfileId: "codex-reviewed",
          terminalAllowEntryId: REVIEWED_ALLOW_ID,
        });
        expect(JSON.stringify(plan)).not.toMatch(/executable|arguments|environment|workingDirectory|sourcePath/iu);
      }
      expect(planA.attachmentTargetName).not.toBe(planB.attachmentTargetName);

      writeFileSync(join(bindingA.canonical_path, ".wave4-identity"), taskA, { mode: 0o600 });
      writeFileSync(join(bindingB.canonical_path, ".wave4-identity"), taskB, { mode: 0o600 });
      writeFileSync(join(bindingA.canonical_path, ".wave4-sibling.json"), JSON.stringify({
        siblingPath: bindingB.canonical_path,
        siblingAttachment: planB.attachmentTargetName,
      }), { mode: 0o600 });
      writeFileSync(join(bindingB.canonical_path, ".wave4-sibling.json"), JSON.stringify({
        siblingPath: bindingA.canonical_path,
        siblingAttachment: planA.attachmentTargetName,
      }), { mode: 0o600 });

      let sessionA = "";
      let sessionB = "";
      let launchPlanAResult = "";
      let launchPlanBResult = "";
      let initialSessionList = "";
      await pollUntil(() => model.idle, 10_000, "liaison idle before launch");
      const deliveredBeforeLaunch = echo.getSentMessages().filter(
        (message) => message.text.includes("LIAISON_TURN_DONE"),
      ).length;
      model.setScript([
        { tool: "get_launch_plan", arguments: { taskHandle: taskA }, capture: (text) => { launchPlanAResult = text; } },
        { tool: "get_launch_plan", arguments: { taskHandle: taskB }, capture: (text) => { launchPlanBResult = text; } },
        {
          tool: "terminal_session_create",
          arguments: {
            allowId: planA.terminalAllowEntryId,
            command: REVIEWED_LAUNCHER,
            args: [],
            managedRunId: bindingA.managed_run_id,
            workspaceLeaseId: bindingA.workspace_lease_id,
          },
          capture: (text) => { sessionA = /"sessionId"\s*:\s*"([^"]+)"/u.exec(text)?.[1] ?? ""; },
        },
        {
          tool: "terminal_session_create",
          arguments: {
            allowId: planB.terminalAllowEntryId,
            command: REVIEWED_LAUNCHER,
            args: [],
            managedRunId: bindingB.managed_run_id,
            workspaceLeaseId: bindingB.workspace_lease_id,
          },
          capture: (text) => { sessionB = /"sessionId"\s*:\s*"([^"]+)"/u.exec(text)?.[1] ?? ""; },
        },
        { tool: "terminal_session_list", arguments: {}, capture: (text) => { initialSessionList = text; } },
      ]);
      await channelManager.injectMessage("echo", normalizedMessage("LAUNCH_BOTH_FROM_REVIEWED_PLANS"));
      await pollUntil(
        () => model.idle && echo.getSentMessages().filter(
          (message) => message.text.includes("LIAISON_TURN_DONE"),
        ).length > deliveredBeforeLaunch,
        60_000,
        "two terminal launch handles",
      );
      expect(
        sessionA,
        `worker A terminal launch failed (${launcherDiagnostic(bindingA.canonical_path)}); service stderr: ${service.stderr()}`,
      ).not.toBe("");
      expect(
        sessionB,
        `worker B terminal launch failed (${launcherDiagnostic(bindingB.canonical_path)}); service stderr: ${service.stderr()}`,
      ).not.toBe("");
      expect(launchPlanAResult).toContain(taskA);
      expect(launchPlanBResult).toContain(taskB);
      expect(launchPlanAResult).not.toMatch(/executable|workingDirectory|sourcePath/iu);
      expect(launchPlanBResult).not.toMatch(/executable|workingDirectory|sourcePath/iu);
      expect(sessionA).not.toBe(sessionB);
      expect(initialSessionList).toContain(sessionA);
      expect(initialSessionList).toContain(sessionB);

      writeFileSync(join(bindingA.canonical_path, ".wave4-start"), "go\n", { mode: 0o600 });
      writeFileSync(join(bindingB.canonical_path, ".wave4-start"), "go\n", { mode: 0o600 });
      await pollUntil(
        () => {
          try {
            return readFileSync(join(bindingA.canonical_path, ".wave4-real-codex-started"), "utf8") === ""
              && readFileSync(join(bindingB.canonical_path, ".wave4-real-codex-started"), "utf8") === "";
          } catch {
            return false;
          }
        },
        30_000,
        () => `two real Codex process starts; worker A: ${launcherDiagnostic(bindingA.canonical_path)}; worker B: ${launcherDiagnostic(bindingB.canonical_path)}; service stderr: ${service.stderr()}`,
      );

      let status = cli<TaskStatusSnapshot>(cliBinary, operatorSocket, ["status", "--format", "json"]);
      expect(status.completeness).toBe("partial");
      expect(new Set(status.tasks.map((task) => task.taskHandle))).toEqual(new Set([taskA, taskB]));
      try {
        await pollUntil(() => {
          status = cli<TaskStatusSnapshot>(cliBinary, operatorSocket, ["status", "--format", "json"]);
          return status.tasks.filter((task) => taskHandles.includes(task.taskHandle)).every((task) => task.state === "working");
        }, REAL_WORKER_JOIN_TIMEOUT_MS, `joined working state; observed ${JSON.stringify(status.tasks)}; service stderr: ${service.stderr()}`);
      } catch (error) {
        let workerAView = "terminal read was not attempted";
        let workerBView = "terminal read was not attempted";
        await pollUntil(() => model.idle, 10_000, "liaison idle before failed-join diagnostics");
        const deliveredBeforeDiagnostics = echo.getSentMessages().filter(
          (message) => message.text.includes("LIAISON_TURN_DONE"),
        ).length;
        model.setScript([
          {
            tool: "terminal_session_read",
            arguments: { sessionId: sessionA, scrollback: 100 },
            capture: (text) => { workerAView = text; },
          },
          {
            tool: "terminal_session_read",
            arguments: { sessionId: sessionB, scrollback: 100 },
            capture: (text) => { workerBView = text; },
          },
        ]);
        await channelManager.injectMessage("echo", normalizedMessage("READ_FAILED_JOIN_TERMINALS"));
        await pollUntil(
          () => model.idle && echo.getSentMessages().filter(
            (message) => message.text.includes("LIAISON_TURN_DONE"),
          ).length > deliveredBeforeDiagnostics,
          30_000,
          "failed-join terminal diagnostics",
        );
        const message = error instanceof Error ? error.message : String(error);
        const durableDiagnostic = failedJoinDurableDiagnostic(goDatabase, taskHandles);
        throw new Error(
          `${message}; durable: ${durableDiagnostic}; worker A context: ${runtimeContextDiagnostic(bindingA.canonical_path)}; worker B context: ${runtimeContextDiagnostic(bindingB.canonical_path)}; worker A client: ${clientDiagnostic(bindingA.canonical_path)}; worker B client: ${clientDiagnostic(bindingB.canonical_path)}; worker A reporter: ${reporterDiagnostic(bindingA.canonical_path)}; worker B reporter: ${reporterDiagnostic(bindingB.canonical_path)}; worker A terminal: ${workerAView}; worker B terminal: ${workerBView}`,
        );
      }
      await pollUntil(() => acceptedReportCounts(goDatabase, taskHandles).every((count) => count >= 2), 180_000, () =>
        `task-local progress and candidate reports; Go counts ${JSON.stringify(acceptedReportCounts(goDatabase, taskHandles))}; Comis counts ${JSON.stringify(reportCounts(canonicalDataDir, taskHandles))}; Go reports ${acceptedReportDiagnostic(goDatabase, taskHandles)}; worker A ${reporterDiagnostic(bindingA.canonical_path)}; worker B ${reporterDiagnostic(bindingB.canonical_path)}; service stderr ${service.stderr()}`);

      const evidenceA = JSON.parse(readFileSync(join(bindingA.canonical_path, ".wave4-confinement.json"), "utf8")) as Record<string, boolean>;
      const evidenceB = JSON.parse(readFileSync(join(bindingB.canonical_path, ".wave4-confinement.json"), "utf8")) as Record<string, boolean>;
      expect(evidenceA).toEqual({ siblingReadBlocked: true, siblingWriteBlocked: true, siblingAttachmentAbsent: true });
      expect(evidenceB).toEqual({ siblingReadBlocked: true, siblingWriteBlocked: true, siblingAttachmentAbsent: true });
      expect(readFileSync(join(bindingA.canonical_path, "wave4-artifact.txt"), "utf8")).toContain(taskA);
      expect(readFileSync(join(bindingA.canonical_path, "wave4-artifact.txt"), "utf8")).not.toContain(taskB);
      expect(readFileSync(join(bindingB.canonical_path, "wave4-artifact.txt"), "utf8")).toContain(taskB);
      expect(readFileSync(join(bindingB.canonical_path, "wave4-artifact.txt"), "utf8")).not.toContain(taskA);

      let postKillList = "";
      await pollUntil(() => model.idle, 10_000, "liaison idle before selective stop");
      model.setScript([
        { tool: "terminal_session_kill", arguments: { sessionId: sessionA } },
        { tool: "terminal_session_list", arguments: {}, capture: (text) => { postKillList = text; } },
      ]);
      await channelManager.injectMessage("echo", normalizedMessage("STOP_ONLY_WORKER_A"));
      await pollUntil(() => postKillList !== "", 30_000, "single-worker stop and task status read");
      expect(postKillList).not.toContain(sessionA);
      expect(postKillList).toContain(sessionB);
      status = cli<TaskStatusSnapshot>(cliBinary, operatorSocket, ["status", "--format", "json"]);
      expect(status.tasks.find((task) => task.taskHandle === taskA)?.state).toBe("validating");
      expect(status.tasks.find((task) => task.taskHandle === taskB)?.state).toBe("validating");

      await pollUntil(() => model.idle, 10_000, "liaison idle before final stop");
      model.setScript([{ tool: "terminal_session_kill", arguments: { sessionId: sessionB } }]);
      await channelManager.injectMessage("echo", normalizedMessage("STOP_REMAINING_WORKER_B"));
      console.log("WAVE4_CONFINEMENT_POSTURE=outer Docker bridge network shared; inner bwrap filesystem, PID, IPC, UTS, cgroup, and user namespaces isolated; task workspace and one protected attachment mounted per worker");
    } finally {
      await stopDaemon(daemon);
      await service?.stop();
      await model.close();
      if (previousControl === undefined) delete process.env[CONTROL_SECRET_NAME];
      else process.env[CONTROL_SECRET_NAME] = previousControl;
      if (previousProvider === undefined) delete process.env[PROVIDER_SECRET_NAME];
      else process.env[PROVIDER_SECRET_NAME] = previousProvider;
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 420_000);
});
