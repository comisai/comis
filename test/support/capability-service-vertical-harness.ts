// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, createConnection, type Server as NetServer, type Socket } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { safePath } from "@comis/core";

export interface FixtureRepository {
  readonly approvedRoot: string;
  readonly primary: string;
  readonly worktreeRoot: string;
  readonly defaultBranch: string;
  readonly baseRevision: string;
  readonly gitExecutable: string;
}

export interface LocalRequestRecord {
  readonly method: string;
  readonly operationId: string;
  readonly targetOperationId?: string;
  responseStatus?: string;
  responseCommand?: string;
  responseErrorCode?: string;
  responseErrorMessage?: string;
  responseErrorHint?: string;
}

export interface ModelRequestRecord {
  readonly body: Record<string, unknown>;
  readonly toolNames: readonly string[];
  readonly continuation: boolean;
}

export interface EmittedModelToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly continuation: boolean;
}

function validateFixturePath(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
    throw new Error("capability-service fixture path must be absolute and normalized");
  }
  return path;
}

function fixtureChildPath(base: string, ...segments: string[]): string {
  return safePath(validateFixturePath(base), ...segments);
}

function fixturePathExists(path: string): boolean {
  const validated = validateFixturePath(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validateFixturePath admits only absolute normalized test-harness paths
  return existsSync(validated);
}

function setFixturePathMode(path: string, mode: number): void {
  const validated = validateFixturePath(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validateFixturePath admits only absolute normalized test-harness paths
  chmodSync(validated, mode);
}

function ensureFixtureDirectory(path: string): void {
  const validated = validateFixturePath(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validateFixturePath admits only absolute normalized test-harness paths
  mkdirSync(validated, { recursive: true, mode: 0o700 });
}

function canonicalFixturePath(path: string): string {
  const validated = validateFixturePath(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validateFixturePath admits only absolute normalized test-harness paths
  return realpathSync(validated);
}

function writeFixtureFile(path: string, content: string): void {
  const validated = validateFixturePath(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validateFixturePath admits only absolute normalized test-harness paths
  writeFileSync(validated, content, { mode: 0o600 });
}

function readFixtureTextFile(path: string): string {
  const validated = validateFixturePath(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validateFixturePath admits only absolute normalized test-harness paths
  return readFileSync(validated, "utf8");
}

function removeSocket(path: string): void {
  const validated = validateFixturePath(path);
  if (fixturePathExists(validated)) rmSync(validated, { force: true });
}

function listenUnix(server: NetServer, socketPath: string): Promise<void> {
  const validatedSocketPath = validateFixturePath(socketPath);
  removeSocket(validatedSocketPath);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(validatedSocketPath, () => {
      server.off("error", reject);
      setFixturePathMode(validatedSocketPath, 0o600);
      resolve();
    });
  });
}

function closeNetServer(server: NetServer, socketPath: string): Promise<void> {
  const validatedSocketPath = validateFixturePath(socketPath);
  return new Promise((resolve) => {
    server.close(() => {
      removeSocket(validatedSocketPath);
      resolve();
    });
  });
}

function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`${label} timed out`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function collectOneLine(socket: Socket, onLine: (line: Buffer) => void): void {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) return;
    const line = buffered.subarray(0, newline + 1);
    socket.pause();
    onLine(line);
  });
}

export function buildGoFixtureBinary(
  goRepository: string,
  outputDirectory: string,
  name: "devcrew-service" | "devcrew-mcp",
): string {
  const output = fixtureChildPath(outputDirectory, name);
  execFileSync("go", ["build", "-trimpath", "-o", output, `./cmd/${name}`], {
    cwd: goRepository,
    stdio: "pipe",
  });
  return output;
}

export function createFixtureRepository(root: string): FixtureRepository {
  const fixtureRoot = validateFixturePath(root);
  const approvedRoot = fixtureChildPath(fixtureRoot, "repositories");
  const primary = fixtureChildPath(approvedRoot, "fixture-repository");
  const worktreeRoot = fixtureChildPath(approvedRoot, "worktrees");
  ensureFixtureDirectory(primary);
  ensureFixtureDirectory(worktreeRoot);
  const gitExecutable = canonicalFixturePath(
    execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
  );
  const runGit = (cwd: string, args: readonly string[]): string =>
    execFileSync(gitExecutable, args, { cwd, encoding: "utf8" }).trim();
  const defaultBranch = "main";
  runGit(primary, ["init", "--initial-branch", defaultBranch]);
  runGit(primary, ["config", "user.name", "Capability Fixture"]);
  runGit(primary, ["config", "user.email", "fixture@example.invalid"]);
  writeFixtureFile(fixtureChildPath(primary, "README.md"), "capability fixture\n");
  runGit(primary, ["add", "README.md"]);
  runGit(primary, ["commit", "-m", "fixture"]);
  const baseRevision = runGit(primary, ["rev-parse", "HEAD"]);
  return Object.freeze({
    approvedRoot: canonicalFixturePath(approvedRoot),
    primary: canonicalFixturePath(primary),
    worktreeRoot: canonicalFixturePath(worktreeRoot),
    defaultBranch,
    baseRevision,
    gitExecutable,
  });
}

function createServiceCandidateConfig(root: string): string {
  const configRoot = fixtureChildPath(root, "config");
  const credentialRoot = fixtureChildPath(root, "forge-credentials");
  ensureFixtureDirectory(configRoot);
  ensureFixtureDirectory(credentialRoot);
  const readCredential = fixtureChildPath(configRoot, "forge-read.credential");
  const pushCredential = fixtureChildPath(configRoot, "forge-push.credential");
  writeFixtureFile(readCredential, "fixture-forge-read-credential");
  writeFixtureFile(pushCredential, "fixture-forge-push-credential");
  const validationExecutable = canonicalFixturePath(
    execFileSync("which", ["sleep"], { encoding: "utf8" }).trim(),
  );
  const configPath = fixtureChildPath(configRoot, "candidate.json");
  writeFixtureFile(configPath, JSON.stringify({
    programs: [{ id: "repo-check", executable: validationExecutable }],
    profiles: [{
      id: "go-default",
      localChecks: [{
        id: "unit",
        programId: "repo-check",
        arguments: [{ kind: "literal", value: "0.2" }],
        timeout: "1m",
        required: true,
      }],
      forgeChecks: [],
      artifactRules: [{
        kind: "regular_file",
        relativePath: "report.md",
        mediaType: "text/markdown",
        maxBytes: 65_536,
      }],
      evidenceTtl: "24h",
    }],
    integrationPolicies: [{ id: "integration-default", strategy: "merge" }],
    maxOutputBytes: 65_536,
    pollInterval: "25ms",
    forge: {
      apiBaseUrl: "http://127.0.0.1:1",
      owner: "fixture-owner",
      repository: "fixture-repository",
      remoteUrl: `file://${fixtureChildPath(root, "fixture-remote.git")}`,
      readCredentialFile: readCredential,
      pushCredentialFile: pushCredential,
      credentialDirectory: credentialRoot,
      localFixtureRemoteRoot: root,
    },
  }));
  return configPath;
}

function createCodexFixtureExecutable(root: string): string {
  const binRoot = fixtureChildPath(root, "bin");
  ensureFixtureDirectory(binRoot);
  const executable = fixtureChildPath(binRoot, "codex");
  writeFixtureFile(executable, "#!/bin/sh\nprintf 'codex-cli 0.147.0\\n'\n");
  setFixturePathMode(executable, 0o700);
  return canonicalFixturePath(executable);
}

/** Delay one committed PrepareTask response so the Go facade must reconcile by operation ID. */
export class LocalDeadlineProxy {
  readonly records: LocalRequestRecord[] = [];
  private readonly server: NetServer;
  private firstPrepareDelayed = false;

  constructor(
    readonly socketPath: string,
    private readonly targetPath: string,
    private readonly delayMs = 5_250,
  ) {
    this.server = createNetServer((client) => this.accept(client));
  }

  async start(): Promise<void> {
    await listenUnix(this.server, this.socketPath);
  }

  async waitForReconciliation(timeoutMs = 15_000): Promise<void> {
    try {
      await waitUntil(() => {
        const methods = this.records.map((record) => record.method);
        return methods.filter((method) => method === "PrepareTask").length >= 2
          && methods.includes("GetOperation");
      }, timeoutMs, "local operation reconciliation");
    } catch (cause) {
      throw new Error(
        `local operation reconciliation timed out; requests=${JSON.stringify(this.records)}`,
        { cause },
      );
    }
  }

  async close(): Promise<void> {
    await closeNetServer(this.server, this.socketPath);
  }

  private accept(client: Socket): void {
    client.on("error", () => undefined);
    collectOneLine(client, (requestLine) => {
      const request = JSON.parse(requestLine.toString("utf8")) as {
        method?: string;
        operationId?: string;
        payload?: { operationId?: string };
      };
      const method = request.method ?? "";
      const operationId = request.operationId ?? "";
      const record: LocalRequestRecord = {
        method,
        operationId,
        ...(request.payload?.operationId === undefined
          ? {}
          : { targetOperationId: request.payload.operationId }),
      };
      this.records.push(record);
      const target = createConnection(this.targetPath);
      target.on("error", () => client.destroy());
      target.once("connect", () => target.write(requestLine));
      collectOneLine(target, (responseLine) => {
        const response = JSON.parse(responseLine.toString("utf8")) as {
          status?: string;
          error?: { code?: string; message?: string; hint?: string };
          result?: { command?: string };
        };
        record.responseStatus = response.status;
        record.responseCommand = response.result?.command;
        record.responseErrorCode = response.error?.code;
        record.responseErrorMessage = response.error?.message;
        record.responseErrorHint = response.error?.hint;
        const delayed = method === "PrepareTask" && !this.firstPrepareDelayed;
        if (delayed) this.firstPrepareDelayed = true;
        const send = (): void => {
          if (!client.destroyed) client.end(responseLine);
          target.destroy();
        };
        if (delayed) setTimeout(send, this.delayMs);
        else send();
      });
    });
  }
}

interface HeldReport {
  readonly source: Socket;
  readonly target: Socket;
  readonly line: Buffer;
}

/** Transparent control relay that can retain the first durable report across a daemon restart. */
export class RestartControlProxy {
  readonly records: Array<{ method: string }> = [];
  private readonly server: NetServer;
  private readonly sockets = new Set<Socket>();
  private held: HeldReport | undefined;
  private holdReports = true;

  constructor(readonly socketPath: string, private readonly targetPath: string) {
    this.server = createNetServer((source) => this.accept(source));
  }

  async start(): Promise<void> {
    await listenUnix(this.server, this.socketPath);
  }

  async waitForHeldReport(timeoutMs = 15_000): Promise<void> {
    try {
      await waitUntil(() => this.held !== undefined, timeoutMs, "held capability-service report");
    } catch (cause) {
      throw new Error(
        `held capability-service report timed out; control=${JSON.stringify(this.records)}`,
        { cause },
      );
    }
  }

  releaseReports(): void {
    this.holdReports = false;
    const held = this.held;
    this.held = undefined;
    if (held !== undefined && !held.source.destroyed && !held.target.destroyed) {
      held.target.write(held.line);
      held.source.resume();
    }
  }

  disconnectCurrentSession(): void {
    this.held = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  async close(): Promise<void> {
    this.disconnectCurrentSession();
    await closeNetServer(this.server, this.socketPath);
  }

  private accept(source: Socket): void {
    source.on("error", () => undefined);
    const target = createConnection(this.targetPath);
    target.on("error", () => source.destroy());
    this.sockets.add(source);
    this.sockets.add(target);
    const discard = (): void => {
      if (this.held?.source === source) this.held = undefined;
      source.destroy();
      target.destroy();
      this.sockets.delete(source);
      this.sockets.delete(target);
    };
    source.once("close", discard);
    target.once("close", discard);
    target.once("connect", () => {
      let buffered = Buffer.alloc(0);
      source.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (true) {
          const newline = buffered.indexOf(0x0a);
          if (newline < 0) break;
          const line = buffered.subarray(0, newline + 1);
          buffered = buffered.subarray(newline + 1);
          const parsed = JSON.parse(line.toString("utf8")) as { method?: string };
          const record = { method: parsed.method ?? "" };
          this.records.push(record);
          if (
            this.holdReports
            && parsed.method === "managedRuns.report"
            && this.held === undefined
          ) {
            this.held = { source, target, line };
            source.pause();
            continue;
          }
          target.write(line);
        }
      });
      target.on("data", (chunk) => source.write(chunk));
    });
  }
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
    id: "chatcmpl-capability-fixture",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** Deterministic OpenAI-compatible stream that chooses only the real MCP tools exposed to it. */
export class FixtureModelServer {
  readonly requests: ModelRequestRecord[] = [];
  readonly emittedToolCalls: EmittedModelToolCall[] = [];
  private server: HttpServer | undefined;
  private baseUrlValue = "";

  get baseUrl(): string {
    return this.baseUrlValue;
  }

  async start(): Promise<void> {
    this.server = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        this.respond(body, response);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("fixture model server did not bind TCP");
    this.baseUrlValue = `http://127.0.0.1:${address.port}/v1`;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }

  private respond(body: Record<string, unknown>, response: import("node:http").ServerResponse): void {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const toolNames = tools.flatMap((tool) => {
      const name = (tool as { function?: { name?: unknown } }).function?.name;
      return typeof name === "string" ? [name] : [];
    });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const allText = messages.map(messageText).join("\n");
    const last = messages[messages.length - 1] as { role?: string } | undefined;
    const priorContinuationCall = this.emittedToolCalls.findLast((call) => call.continuation);
    const continuation = allText.includes("A capability service reported an update")
      || (last?.role === "tool" && priorContinuationCall !== undefined);
    this.requests.push({ body, toolNames: Object.freeze([...toolNames]), continuation });

    let toolCall: { name: string; arguments: Record<string, unknown> } | undefined;
    let text: string | undefined;
    if (continuation) {
      if (last?.role === "tool" && priorContinuationCall?.name.includes("list_tasks") === true) {
        text = "CAPABILITY_VERTICAL_JOIN_COMPLETE";
      } else {
        const discoveredListName = priorContinuationCall?.name === "discover_tools"
          && last?.role === "tool"
          ? /"name":"([^"]*list_tasks)"/u.exec(messageText(last))?.[1]
          : undefined;
        const listName = toolNames.find((candidate) => candidate.includes("list_tasks"))
          ?? discoveredListName;
        const discoverName = toolNames.find((candidate) => candidate === "discover_tools");
        if (listName !== undefined) {
          toolCall = { name: listName, arguments: {} };
        } else if (priorContinuationCall === undefined && discoverName !== undefined) {
          toolCall = {
            name: discoverName,
            arguments: { query: "select:mcp__fixture-worker--list_tasks" },
          };
        } else {
          response.statusCode = 500;
          response.end("continuation fixture tool authority is incomplete");
          return;
        }
      }
      if (toolCall === undefined && text === undefined) {
        response.statusCode = 500;
        response.end("continuation fixture did not choose an outcome");
        return;
      }
    } else if (allText.includes("START_MANAGED_FIXTURE") && last?.role === "tool") {
      text = "Managed fixture accepted.";
    } else if (allText.includes("START_MANAGED_FIXTURE")) {
      const name = toolNames.find((candidate) => candidate.includes("prepare_task"));
      if (name === undefined) {
        response.statusCode = 500;
        response.end("prepare fixture tool is unavailable");
        return;
      }
      toolCall = {
        name,
        arguments: {
          shape: "scout",
          repositoryId: "fixture-repository",
          baseRevision: allText.match(/BASE_REVISION=([0-9a-f]{40})/u)?.[1] ?? "",
          acceptanceCriteria: ["Exercise the installed composition end to end."],
          constraints: ["Stop at a validation candidate."],
          validationProfile: "go-default",
          deliveryMode: "report",
          workerProfileId: "fixture-worker",
        },
      };
    } else if (allText.includes("NEWER_CONVERSATION")) {
      text = "Newer conversation acknowledged.";
    } else {
      text = "Fixture request acknowledged.";
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const model = typeof body.model === "string" ? body.model : "fixture-model";
    if (toolCall !== undefined) {
      this.emittedToolCalls.push({ ...toolCall, continuation });
      response.write(responseChunk(model, {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: `call-${this.emittedToolCalls.length}`,
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

export interface RunningFixtureService {
  readonly process: ChildProcess;
  readonly runtimeRoot: string;
  readonly stderr: () => string;
  stop(): Promise<void>;
}

export function startFixtureService(input: {
  readonly binary: string;
  readonly databasePath: string;
  readonly operatorSocket: string;
  readonly mcpSocket: string;
  readonly serviceInstanceId: string;
  readonly repository: FixtureRepository;
  readonly controlSocket: string;
  readonly credentialFile: string;
}): RunningFixtureService {
  const databasePath = validateFixturePath(input.databasePath);
  ensureFixtureDirectory(dirname(databasePath));
  const serviceRoot = canonicalFixturePath(dirname(databasePath));
  const shortRuntimeParent = canonicalFixturePath("/tmp");
  const runtimeRoot = canonicalFixturePath(mkdtempSync(
    fixtureChildPath(shortRuntimeParent, "cvr-"),
  ));
  const codexExecutable = createCodexFixtureExecutable(serviceRoot);
  const candidateConfig = createServiceCandidateConfig(serviceRoot);
  const child = spawn(input.binary, [
    "--database", databasePath,
    "--socket", input.operatorSocket,
    "--mcp-socket", input.mcpSocket,
    "--runtime-root", runtimeRoot,
    "--service-instance", input.serviceInstanceId,
    "--git-executable", input.repository.gitExecutable,
    "--approved-root", input.repository.approvedRoot,
    "--repository-id", "fixture-repository",
    "--repository-primary", input.repository.primary,
    "--worktree-root", input.repository.worktreeRoot,
    "--repository-default-branch", input.repository.defaultBranch,
    "--comis-socket", input.controlSocket,
    "--comis-credential-file", input.credentialFile,
    "--comis-handshake-operation", "fixture-handshake-operation",
    "--preparation-ttl", "10m",
    "--codex-profile", "codex-reviewed",
    "--codex-executable", codexExecutable,
    "--codex-version", "codex-cli 0.147.0",
    "--codex-model", "gpt-5.5-codex",
    "--codex-effort", "high",
    "--codex-terminal-allow-entry", "codex-confined",
    "--codex-network", "restricted",
    "--codex-concurrency", "1",
    "--max-concurrent-tasks", "1",
    "--max-concurrent-tasks-per-repository", "1",
    "--candidate-config", candidateConfig,
    "--fixture-worker",
    "--fixture-decision", "use the bounded fixture choice",
    "--fixture-artifact", "report.md",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  let stopped = false;
  return Object.freeze({
    process: child,
    runtimeRoot,
    stderr: () => Buffer.concat(stderrChunks).toString("utf8"),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        const forced = new Promise<void>((resolve) => setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          resolve();
        }, 3_000));
        await Promise.race([exited, forced]);
      }
      rmSync(runtimeRoot, { recursive: true, force: true });
    },
  });
}

function unixSocketAcceptsConnection(path: string): Promise<boolean> {
  const validatedPath = validateFixturePath(path);
  return new Promise((resolve) => {
    const socket = createConnection(validatedPath);
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function waitForUnixSocket(path: string, timeoutMs = 15_000): Promise<void> {
  const validatedPath = validateFixturePath(path);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (fixturePathExists(validatedPath) && await unixSocketAcceptsConnection(validatedPath)) return;
    if (Date.now() >= deadline) throw new Error(`Unix socket ${validatedPath} timed out`);
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
}

export function readLauncherPids(path: string): number[] {
  const validatedPath = validateFixturePath(path);
  if (!fixturePathExists(validatedPath)) return [];
  return readFixtureTextFile(validatedPath)
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { pid: number }).pid);
}
