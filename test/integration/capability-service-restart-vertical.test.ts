// SPDX-License-Identifier: Apache-2.0
/**
 * Restart-injected join of the real Comis capability-service path with the
 * committed Go fixture service. The Go repository is consumed read-only: its
 * two binaries are built into this test's private directory.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { EchoChannelAdapter } from "@comis/channels";
import type {
  CapabilityServiceContributionRegistration,
  EventMap,
  NormalizedMessage,
} from "@comis/core";
import {
  buildGoFixtureBinary,
  createFixtureRepository,
  FixtureModelServer,
  LocalDeadlineProxy,
  readLauncherPids,
  RestartControlProxy,
  startFixtureService,
  waitForUnixSocket,
  type RunningFixtureService,
} from "../support/capability-service-vertical-harness.js";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";
import { getFreePort } from "../support/free-port.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, "../..");
const GO_REPOSITORY = resolve(REPOSITORY_ROOT, "../../comis-dev-crew");
const MCP_LAUNCHER = resolve(
  TEST_DIRECTORY,
  "../support/capability-service-mcp-fixture-launcher.mjs",
);
const SERVICE_INSTANCE_ID = "service-instance-parity";
const MCP_SERVER_NAME = "fixture-worker";
const CONTROL_SECRET_NAME = "CAPABILITY_FIXTURE_BEARER";
const PROVIDER_SECRET_NAME = "CAPABILITY_FIXTURE_PROVIDER_KEY";
const CONTROL_SECRET = "fixture-control-bearer-0123456789abcdef";
const FINAL_RESPONSE = "CAPABILITY_VERTICAL_JOIN_COMPLETE";

const CONTRIBUTION: CapabilityServiceContributionRegistration = Object.freeze({
  contributionId: "fixture.service",
  configSections: Object.freeze([]),
  serviceDefinitions: Object.freeze([{
    serviceDefinitionId: "fixture.service",
    protocolId: "comis.capability-service/1",
    mcpServerName: MCP_SERVER_NAME,
    managedToolBindings: Object.freeze([
      {
        toolName: "prepare_task",
        behavior: "prepare_run",
        actionClassification: "mutate",
        invocationSideEffects: Object.freeze(["task.prepare"]),
      },
      ...["list_tasks", "get_task", "explain_task"].map((toolName) => Object.freeze({
        toolName,
        behavior: "read_only" as const,
        actionClassification: "read" as const,
        invocationSideEffects: Object.freeze([]),
      })),
    ]),
    requestedScopes: Object.freeze(["health", "report"]),
    dependsOn: Object.freeze([]),
  }]),
});

function normalizedMessage(channelId: string, senderId: string, text: string): NormalizedMessage {
  return {
    id: randomUUID(),
    channelId,
    channelType: "echo",
    senderId,
    text,
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
  };
}

async function stopDaemon(handle: TestDaemonHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.cleanup();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!message.includes("Daemon exit with code")) throw cause;
  }
}

async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }
}

function registerEcho(handle: TestDaemonHandle): EchoChannelAdapter {
  const echo = new EchoChannelAdapter({ channelId: "echo-main", channelType: "echo" });
  handle.daemon.adapterRegistry.set("echo", echo);
  handle.daemon.deliveryAdapters.set("echo", echo);
  return echo;
}

function makeConfig(input: {
  readonly dataDir: string;
  readonly gatewayPort: number;
  readonly modelBaseUrl: string;
  readonly launcherPidLog: string;
  readonly mcpBinary: string;
  readonly mcpProxySocket: string;
  readonly controlSocket: string;
  readonly workspaceRoot: string;
}): Record<string, unknown> {
  return {
    tenantId: "test",
    logLevel: "warn",
    dataDir: input.dataDir,
    providers: {
      entries: {
        fixture: {
          type: "fixture-openai-compatible",
          baseUrl: input.modelBaseUrl,
          apiKeyName: PROVIDER_SECRET_NAME,
          maxRetries: 0,
          capabilities: { providerFamily: "openai" },
          models: [{
            id: "fixture-model",
            reasoning: false,
            contextWindow: 32_768,
            maxTokens: 1_024,
            input: ["text"],
          }],
        },
      },
    },
    models: { defaultModel: "fixture:fixture-model" },
    agents: {
      default: {
        name: "CapabilityFixtureAgent",
        provider: "fixture",
        model: "fixture-model",
        thinkingLevel: "off",
        maxSteps: 8,
        budgets: {
          perExecution: 500_000,
          perHour: 5_000_000,
          perDay: 50_000_000,
        },
        circuitBreaker: { failureThreshold: 100, resetTimeoutMs: 1_000 },
        rag: { enabled: false },
        autonomy: {
          profile: "standard",
          durability: {
            enabled: true,
            staleHeartbeatMs: 120_000,
            keepAliveMs: 30_000,
            recoveryBudgetMs: 30_000,
          },
          mcp: {
            enabled: true,
            allow: {
              [MCP_SERVER_NAME]: {
                tools: ["prepare_task", "list_tasks", "get_task", "explain_task"],
                classification: "safe",
              },
            },
          },
        },
      },
    },
    gateway: {
      enabled: true,
      host: "127.0.0.1",
      port: input.gatewayPort,
      tokens: [{
        id: "fixture-token",
        secret: "fixture-gateway-secret-for-integration-tests",
        scopes: ["rpc", "ws", "admin"],
      }],
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
      disk: { enabled: false },
      resources: { enabled: false },
      systemd: { enabled: false },
      securityUpdates: { enabled: false },
      git: { enabled: false },
    },
    integrations: {
      mcp: {
        osvCheckEnabled: false,
        callToolTimeoutMs: 30_000,
        servers: [{
          name: MCP_SERVER_NAME,
          transport: "stdio",
          command: process.execPath,
          args: [
            MCP_LAUNCHER,
            "--binary", input.mcpBinary,
            "--socket", input.mcpProxySocket,
            "--service-instance", SERVICE_INSTANCE_ID,
            "--pid-log", input.launcherPidLog,
          ],
          toolAllowlist: ["prepare_task", "list_tasks", "get_task", "explain_task"],
          keepaliveIntervalMs: 0,
        }],
      },
    },
    capabilityServices: {
      instances: [{
        serviceInstanceId: SERVICE_INSTANCE_ID,
        serviceDefinitionId: "fixture.service",
        enabled: true,
        mcpServerName: MCP_SERVER_NAME,
        control: {
          transport: "unix",
          socketPath: input.controlSocket,
          credentialRef: `secret://${CONTROL_SECRET_NAME}`,
        },
        allowedAgents: ["default"],
        allowedWorkspaceRoots: [input.workspaceRoot],
      }],
    },
  };
}

describe("restart-injected capability-service vertical join", () => {
  it("preserves exact authority and delivers one coalesced continuation after facade replacement and daemon restart", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cv-")));
    const dataDir = join(scratch, "data");
    const runDir = join(scratch, "run");
    const binDir = join(scratch, "bin");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const canonicalDataDir = realpathSync(dataDir);
    const serviceBinary = buildGoFixtureBinary(GO_REPOSITORY, binDir, "devcrew-service");
    const mcpBinary = buildGoFixtureBinary(GO_REPOSITORY, binDir, "devcrew-mcp");
    const repository = createFixtureRepository(scratch);
    const controlSocket = join(canonicalDataDir, "control.sock");
    const controlProxySocket = join(runDir, "control-proxy.sock");
    const directMcpSocket = join(runDir, "direct-mcp.sock");
    const mcpProxySocket = join(runDir, "mcp-proxy.sock");
    const operatorSocket = join(runDir, "operator.sock");
    const credentialFile = join(runDir, "control.credential");
    const launcherPidLog = join(runDir, "mcp-pids.jsonl");
    const configPath = join(scratch, "config.yaml");
    const goDatabase = join(scratch, "go-state", "fixture.db");
    writeFileSync(credentialFile, CONTROL_SECRET, { mode: 0o600 });

    const priorControlSecret = process.env[CONTROL_SECRET_NAME];
    const priorProviderSecret = process.env[PROVIDER_SECRET_NAME];
    const model = new FixtureModelServer();
    const controlProxy = new RestartControlProxy(controlProxySocket, controlSocket);
    const localProxy = new LocalDeadlineProxy(mcpProxySocket, directMcpSocket);
    let service: RunningFixtureService | undefined;
    let firstDaemon: TestDaemonHandle | undefined;
    let secondDaemon: TestDaemonHandle | undefined;

    try {
      await model.start();
      await controlProxy.start();
      service = startFixtureService({
        binary: serviceBinary,
        databasePath: goDatabase,
        operatorSocket,
        mcpSocket: directMcpSocket,
        serviceInstanceId: SERVICE_INSTANCE_ID,
        repository,
        controlSocket: controlProxySocket,
        credentialFile,
      });
      await waitForUnixSocket(directMcpSocket);
      await waitForUnixSocket(operatorSocket);
      await localProxy.start();

      const gatewayPort = await getFreePort();
      writeFileSync(configPath, stringify(makeConfig({
        dataDir: canonicalDataDir,
        gatewayPort,
        modelBaseUrl: model.baseUrl,
        launcherPidLog,
        mcpBinary,
        mcpProxySocket,
        controlSocket,
        workspaceRoot: repository.worktreeRoot,
      })), { mode: 0o600 });
      process.env[CONTROL_SECRET_NAME] = CONTROL_SECRET;
      process.env[PROVIDER_SECRET_NAME] = "fixture-provider-key";

      const overrides = {
        capabilityServiceContributions: [CONTRIBUTION],
      } as Record<string, unknown>;
      firstDaemon = await startTestDaemon({ configPath, gatewayPort, overrides });
      const firstEcho = registerEcho(firstDaemon);
      const activated: EventMap["managed_run:activated"][] = [];
      const firstToolEvents: EventMap["tool:executed"][] = [];
      firstDaemon.daemon.container.eventBus.on("managed_run:activated", (event) => activated.push(event));
      firstDaemon.daemon.container.eventBus.on("tool:executed", (event) => firstToolEvents.push(event));
      const policy = await firstDaemon.daemon.container.workspacePolicyPort?.load("default");
      expect(policy?.ok).toBe(true);
      const policyHash = policy?.ok ? policy.value.combinedHash : "";

      const channelManager = firstDaemon.daemon.channelManager;
      expect(channelManager).toBeDefined();
      await channelManager!.injectMessage("echo", normalizedMessage(
        "conversation-origin",
        "user_a",
        `START_MANAGED_FIXTURE BASE_REVISION=${repository.baseRevision}`,
      ));
      await localProxy.waitForReconciliation();
      await controlProxy.waitForHeldReport();
      expect(activated).toHaveLength(1);
      await pollUntil(() => firstEcho.getSentMessages().some((message) => (
        message.channelId === "conversation-origin"
        && message.text.includes("Managed fixture accepted")
      )), 10_000, "initial managed fixture delivery");

      await channelManager!.injectMessage("echo", normalizedMessage(
        "conversation-newer",
        "user_b",
        "NEWER_CONVERSATION",
      ));
      await pollUntil(() => firstEcho.getSentMessages().some((message) => (
        message.channelId === "conversation-newer"
        && message.text.includes("Newer conversation acknowledged")
      )), 10_000, "newer conversation delivery");

      const firstPids = readLauncherPids(launcherPidLog);
      expect(firstPids.length).toBeGreaterThan(0);
      process.kill(firstPids[firstPids.length - 1]!, "SIGKILL");
      await stopDaemon(firstDaemon);
      firstDaemon = undefined;
      controlProxy.disconnectCurrentSession();
      const launcherPidsAfterFirstStop = readLauncherPids(launcherPidLog);

      process.env[CONTROL_SECRET_NAME] = CONTROL_SECRET;
      process.env[PROVIDER_SECRET_NAME] = "fixture-provider-key";
      secondDaemon = await startTestDaemon({ configPath, gatewayPort, overrides });
      const secondEcho = registerEcho(secondDaemon);
      const reports: EventMap["managed_run:report_accepted"][] = [];
      const continuations: EventMap["managed_run:continuation_completed"][] = [];
      const secondToolEvents: EventMap["tool:executed"][] = [];
      secondDaemon.daemon.container.eventBus.on("managed_run:report_accepted", (event) => reports.push(event));
      secondDaemon.daemon.container.eventBus.on("managed_run:continuation_completed", (event) => continuations.push(event));
      secondDaemon.daemon.container.eventBus.on("tool:executed", (event) => secondToolEvents.push(event));
      await controlProxy.waitForHeldReport();
      await pollUntil(
        () => readLauncherPids(launcherPidLog).length > launcherPidsAfterFirstStop.length,
        10_000,
        "MCP facade replacement",
      );
      let replacementCallableNames: string[] = [];
      await pollUntil(async () => {
        try {
          const status = await secondDaemon!.daemon.rpcCall("mcp.status", {
            server_name: MCP_SERVER_NAME,
            _trustLevel: "admin",
          }) as { status?: string; tools?: Array<{ name?: string; callableName?: string }> };
          const names = status.tools?.flatMap((tool) => (
            typeof tool.name === "string" ? [tool.name] : []
          )) ?? [];
          replacementCallableNames = status.tools?.flatMap((tool) => (
            typeof tool.callableName === "string" ? [tool.callableName] : []
          )) ?? [];
          return status.status === "connected"
            && ["prepare_task", "list_tasks", "get_task", "explain_task"]
              .every((name) => names.includes(name));
        } catch {
          return false;
        }
      }, 10_000, "replacement MCP tool catalog");
      const originToolNames = model.requests.find((request) => (
        request.toolNames.some((name) => name.includes("prepare_task"))
      ))?.toolNames ?? [];
      const originMcpToolNames = originToolNames.filter((name) => name.startsWith("mcp__"));
      const authorityDb = new Database(join(canonicalDataDir, "memory.db"), { readonly: true });
      try {
        const authority = authorityDb.prepare("SELECT captured_tool_ids FROM managed_runs").get() as {
          captured_tool_ids: string;
        };
        const captured = JSON.parse(authority.captured_tool_ids) as string[];
        expect(originToolNames
          .filter((name) => name !== "discover_tools")
          .every((name) => captured.includes(name))).toBe(true);
        expect(captured).toEqual([...new Set(captured)].sort());
      } finally {
        authorityDb.close();
      }
      expect(replacementCallableNames.sort()).toEqual([...originMcpToolNames].sort());
      controlProxy.releaseReports();

      await pollUntil(() => secondEcho.getSentMessages().some((message) => (
        message.channelId === "conversation-origin" && message.text.includes(FINAL_RESPONSE)
      )), 30_000, "managed continuation delivery");
      await pollUntil(() => reports.length === 4, 10_000, "managed report ingestion");
      await pollUntil(() => continuations.length > 0, 10_000, "managed continuation completion");

      const reconcile = localProxy.records.filter((record) => (
        record.method === "PrepareTask" || record.method === "GetOperation"
      ));
      expect(reconcile.slice(0, 3).map((record) => record.method)).toEqual([
        "PrepareTask",
        "GetOperation",
        "PrepareTask",
      ]);
      expect(reconcile[1]?.targetOperationId).toBe(reconcile[0]?.operationId);
      expect(reconcile[2]?.operationId).toBe(reconcile[0]?.operationId);

      const replacementPids = readLauncherPids(launcherPidLog);
      expect(new Set(replacementPids).size).toBe(replacementPids.length);
      expect(replacementPids.some((pid) => !firstPids.includes(pid))).toBe(true);
      expect(reports.map((report) => report.kind)).toEqual([
        "progress",
        "attention",
        "resolution",
        "candidate_complete",
      ]);
      expect(continuations).toHaveLength(1);
      expect(continuations[0]).toMatchObject({ throughReportSequence: 4, status: "succeeded" });

      const finalDeliveries = secondEcho.getSentMessages().filter((message) => message.text.includes(FINAL_RESPONSE));
      expect(finalDeliveries).toHaveLength(1);
      expect(finalDeliveries[0]?.channelId).toBe("conversation-origin");
      expect(secondEcho.getSentMessages().some((message) => message.channelId === "conversation-newer")).toBe(false);

      const db = new Database(join(canonicalDataDir, "memory.db"), { readonly: true });
      try {
        const run = db.prepare("SELECT * FROM managed_runs").get() as {
          managed_run_id: string;
          tenant_id: string;
          agent_id: string;
          principal_id: string;
          turn_scope: string;
          delivery_origin: string;
          workspace_policy_hash: string;
          captured_agent_capabilities: string;
          captured_tool_ids: string;
          workspace_lease_id: string | null;
          status: string;
          last_accepted_report_sequence: number;
          last_reduced_report_sequence: number;
          pending_continuation: number;
        };
        expect(run).toBeDefined();
        const turnScope = JSON.parse(run.turn_scope) as {
          endpoint: { channelInstanceId: string; conversationId: string };
          principal: { principalId: string };
        };
        const deliveryOrigin = JSON.parse(run.delivery_origin) as { channelId: string };
        const capturedTools = JSON.parse(run.captured_tool_ids) as string[];
        const capturedCapabilities = JSON.parse(run.captured_agent_capabilities) as string[];
        expect(run.tenant_id).toBe("test");
        expect(run.agent_id).toBe("default");
        expect(run.principal_id).not.toBe("forged-principal");
        expect(turnScope.principal.principalId).toBe(run.principal_id);
        expect(turnScope.endpoint).toMatchObject({
          channelInstanceId: "echo-main",
          conversationId: "conversation-origin",
        });
        expect(deliveryOrigin.channelId).toBe("conversation-origin");
        expect(run.workspace_policy_hash).toBe(policyHash);
        expect(capturedCapabilities).not.toContain("administrator");
        expect(run.workspace_lease_id).not.toBeNull();
        expect(run).toMatchObject({
          status: "succeeded",
          last_accepted_report_sequence: 4,
          last_reduced_report_sequence: 4,
          pending_continuation: 0,
        });

        const lease = db.prepare("SELECT * FROM workspace_leases WHERE managed_run_id = ?")
          .get(run.managed_run_id) as { canonical_path: string; workspace_lease_id: string };
        expect(lease.workspace_lease_id).toBe(run.workspace_lease_id);
        expect(lease.canonical_path).toBe(repository.workspace);
        expect(db.prepare("SELECT COUNT(*) AS count FROM managed_run_reports WHERE managed_run_id = ?")
          .get(run.managed_run_id)).toEqual({ count: 4 });
        const ledgerRows = db.prepare("SELECT * FROM outward_send_ledger WHERE root_run_id = ?")
          .all(run.managed_run_id) as Array<{ state: string }>;
        const allLedgerRows = db.prepare("SELECT * FROM outward_send_ledger WHERE channel_id = ?")
          .all("conversation-origin") as Array<{
            root_run_id: string;
            state: string;
            channel_type: string;
            platform_message_id: string | null;
          }>;
        expect(ledgerRows.length === 0 || ledgerRows.every((row) => row.state === "committed")).toBe(true);
        expect(allLedgerRows).toHaveLength(1);
        expect(allLedgerRows[0]).toMatchObject({
          state: "committed",
          channel_type: "echo",
        });
        expect(allLedgerRows[0]?.platform_message_id).toMatch(/^echo-msg-/u);

        const continuationRequests = model.requests.filter((request) => request.continuation);
        expect(continuationRequests.length).toBeGreaterThan(0);
        for (const request of continuationRequests) {
          expect(request.toolNames.every((toolName) => (
            toolName === "discover_tools" || capturedTools.includes(toolName)
          ))).toBe(true);
        }
      } finally {
        db.close();
      }

      const modelTools = model.emittedToolCalls.map((call) => call.name);
      expect(modelTools.some((name) => name.includes("prepare_task"))).toBe(true);
      expect(modelTools.some((name) => name.includes("list_tasks"))).toBe(true);
      expect(modelTools.every((name) => !/(?:^|[_:/-])(exec|shell|bash)(?:$|[_:/-])/iu.test(name))).toBe(true);
      expect(model.emittedToolCalls.every((call) => {
        const encodedArguments = JSON.stringify(call.arguments);
        return !encodedArguments.includes("devcrew ") && !("command" in call.arguments);
      })).toBe(true);
      expect([...firstToolEvents, ...secondToolEvents].every((event) => (
        !/(?:^|[_:/-])(exec|shell|bash)(?:$|[_:/-])/iu.test(event.toolName)
      ))).toBe(true);
    } finally {
      await stopDaemon(secondDaemon);
      await stopDaemon(firstDaemon);
      await service?.stop();
      await localProxy.close();
      await controlProxy.close();
      await model.close();
      if (priorControlSecret === undefined) delete process.env[CONTROL_SECRET_NAME];
      else process.env[CONTROL_SECRET_NAME] = priorControlSecret;
      if (priorProviderSecret === undefined) delete process.env[PROVIDER_SECRET_NAME];
      else process.env[PROVIDER_SECRET_NAME] = priorProviderSecret;
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
