// SPDX-License-Identifier: Apache-2.0
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_SERVICE_LIMITS,
  CAPABILITY_SERVICE_PROTOCOL_ID,
  CapabilityServiceErrorResponseSchema,
  type CapabilityServiceErrorKind,
} from "@comis/capability-service-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createCapabilityServiceProtocolFixtureServer } from "./capability-service-protocol-fixture-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(here, "../../../..");
const BUNDLE_DIGEST = "94ec7bd173cd20f0de2cb4e9ab719d392f240236ac80d56e3a7ea1abe4e20cb8";
const EXPECTED_BEARER = "fixture-bearer-0000000000000000000000000001";
const SERVICE_INSTANCE_ID = "service-instance_a";
const NOW_MS = 1_800_000_000_000;
const temporaryDirectories: string[] = [];

interface WireError {
  readonly error: { readonly kind: CapabilityServiceErrorKind };
  readonly id: string | null;
  readonly jsonrpc: "2.0";
}

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cph-")));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function request(
  id: string,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, method, params };
}

function authenticatedFrame(
  payload: Readonly<Record<string, unknown>>,
  bearer = EXPECTED_BEARER,
): string {
  return JSON.stringify({ bearer, ...payload });
}

function callSocket(socketPath: string, line: string): Promise<unknown> {
  return new Promise((resolveCall, rejectCall) => {
    const client = net.connect(socketPath);
    let response = "";
    client.on("error", rejectCall);
    client.on("connect", () => client.write(`${line}\n`));
    client.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      const newline = response.indexOf("\n");
      if (newline === -1) return;
      client.end();
      try {
        resolveCall(JSON.parse(response.slice(0, newline)) as unknown);
      } catch (error) {
        rejectCall(error);
      }
    });
  });
}

function expectWireError(response: unknown, kind: CapabilityServiceErrorKind): WireError {
  const parsed = CapabilityServiceErrorResponseSchema.parse(response);
  expect(parsed.error.kind).toBe(kind);
  return parsed;
}

function makeServer(directoryPath: string, requestDeadlineMs = 2_000) {
  return createCapabilityServiceProtocolFixtureServer({
    activeScopes: [
      "health",
      "report",
      "workspace_lease",
      "terminal_events",
      "execution_attachment",
    ],
    attachmentPreparationRefs: ["external-run_a"],
    bundleDigest: BUNDLE_DIGEST,
    clock: createFakeClock(NOW_MS),
    directoryPath,
    expectedBearer: EXPECTED_BEARER,
    requestDeadlineMs,
    serviceInstanceId: SERVICE_INSTANCE_ID,
    workspacePreparationRefs: ["external-run_a"],
  });
}

describe("standalone capability-service protocol fixture server", () => {
  it("binds a 0600 Unix socket and strictly dispatches all six pinned methods", async () => {
    const directory = temporaryDirectory();
    const server = makeServer(directory);
    const started = await server.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { socketPath } = started.value;

    try {
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);

      const handshake = await callSocket(socketPath, authenticatedFrame(request(
        "operation_handshake",
        "capabilityServices.handshake",
        {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: BUNDLE_DIGEST,
          operationId: "operation_handshake",
          serviceInstanceId: SERVICE_INSTANCE_ID,
          requestedScopes: ["health", "report"],
        },
      )));
      expect(handshake).toEqual({
        jsonrpc: "2.0",
        id: "operation_handshake",
        result: {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: BUNDLE_DIGEST,
          serviceInstanceId: SERVICE_INSTANCE_ID,
          activeScopes: [
            "health",
            "report",
            "workspace_lease",
            "terminal_events",
            "execution_attachment",
          ],
          limits: CAPABILITY_SERVICE_LIMITS,
        },
      });

      const activate = await callSocket(socketPath, authenticatedFrame(request(
        "operation_activate",
        "managedRuns.activate",
        {
          operationId: "operation_activate",
          managedRunId: "managed-run_a",
          externalRunRef: "external-run_a",
          registrationNonce: "registration-nonce_a",
          workspaceLeaseId: "workspace-lease_a",
          executionAttachmentId: "execution-attachment_a",
          attachmentTargetName: `attachment-${"a".repeat(32)}.sock`,
        },
      )));
      expect(activate).toEqual({
        jsonrpc: "2.0",
        id: "operation_activate",
        result: {
          managedRunId: "managed-run_a",
          externalRunRef: "external-run_a",
          state: "active",
          activatedAtMs: NOW_MS,
        },
      });

      const report = await callSocket(socketPath, authenticatedFrame(request(
        "operation_report",
        "managedRuns.report",
        {
          operationId: "operation_report",
          managedRunId: "managed-run_a",
          serviceReportId: "service-report_a",
          kind: "progress",
          summary: "Synthetic progress report",
        },
      )));
      expect(report).toEqual({
        jsonrpc: "2.0",
        id: "operation_report",
        result: {
          managedRunId: "managed-run_a",
          serviceReportId: "service-report_a",
          acceptedSequence: 1,
          retainedUntilMs: NOW_MS + CAPABILITY_SERVICE_LIMITS.reportRetentionDays * 86_400_000,
        },
      });

      const terminalEvent = await callSocket(socketPath, authenticatedFrame(request(
        "operation_terminal_created",
        "managedRuns.terminalEvent",
        {
          operationId: "operation_terminal_created",
          managedRunId: "managed-run_a",
          workspaceLeaseId: "workspace-lease_a",
          terminalSessionId: "terminal-session_a",
          transition: "created",
        },
      )));
      expect(terminalEvent).toEqual({
        jsonrpc: "2.0",
        id: "operation_terminal_created",
        result: {
          managedRunId: "managed-run_a",
          terminalSessionId: "terminal-session_a",
          transition: "created",
        },
      });

      const health = await callSocket(socketPath, authenticatedFrame(request(
        "operation_health",
        "capabilityServices.health",
        {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: BUNDLE_DIGEST,
          operationId: "operation_health",
          serviceInstanceId: SERVICE_INSTANCE_ID,
        },
      )));
      expect(health).toEqual({
        jsonrpc: "2.0",
        id: "operation_health",
        result: {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: BUNDLE_DIGEST,
          serviceInstanceId: SERVICE_INSTANCE_ID,
          status: "healthy",
          observedAtMs: NOW_MS,
          reasonCodes: [],
        },
      });

      const abandon = await callSocket(socketPath, authenticatedFrame(request(
        "operation_abandon",
        "managedRuns.abandon",
        {
          operationId: "operation_abandon",
          externalRunRef: "external-run_a",
          registrationNonce: "registration-nonce_a",
          reason: "owner_cancelled",
          disposition: "preserve",
        },
      )));
      expect(abandon).toEqual({
        jsonrpc: "2.0",
        id: "operation_abandon",
        result: {
          externalRunRef: "external-run_a",
          state: "abandoned",
          disposition: "preserve",
          terminalTransition: "unbound_preparation_abandoned",
        },
      });
    } finally {
      expect((await server.close()).ok).toBe(true);
    }
    expect(existsSync(socketPath)).toBe(false);
  });

  it("returns schema-valid closed errors for authentication routing and request rejection", async () => {
    const directory = temporaryDirectory();
    const server = makeServer(directory);
    const started = await server.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { socketPath } = started.value;

    const cases: ReadonlyArray<{
      readonly kind: CapabilityServiceErrorKind;
      readonly line: string;
    }> = [
      {
        kind: "unauthorized_instance",
        line: authenticatedFrame(request("operation_auth", "capabilityServices.health", {}), "forged-bearer"),
      },
      {
        kind: "method_not_found",
        line: authenticatedFrame(request("operation_method", "capabilityServices.unknown", {
          operationId: "operation_method",
        })),
      },
      {
        kind: "protocol_mismatch",
        line: authenticatedFrame(request("operation_protocol", "capabilityServices.handshake", {
          protocolId: "comis.capability-service/2",
          bundleDigest: BUNDLE_DIGEST,
          operationId: "operation_protocol",
          serviceInstanceId: SERVICE_INSTANCE_ID,
          requestedScopes: ["health"],
        })),
      },
      {
        kind: "bundle_digest_mismatch",
        line: authenticatedFrame(request("operation_digest", "capabilityServices.handshake", {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: "0".repeat(64),
          operationId: "operation_digest",
          serviceInstanceId: SERVICE_INSTANCE_ID,
          requestedScopes: ["health"],
        })),
      },
      {
        kind: "invalid_request",
        line: authenticatedFrame(request("operation_envelope", "managedRuns.activate", {
          operationId: "operation_other",
          managedRunId: "managed-run_a",
          externalRunRef: "external-run_a",
          registrationNonce: "registration-nonce_a",
        })),
      },
      {
        kind: "invalid_params",
        line: authenticatedFrame(request("operation_params", "managedRuns.activate", {
          operationId: "operation_params",
          managedRunId: "managed-run_a",
          externalRunRef: "contains spaces",
          registrationNonce: "registration-nonce_a",
        })),
      },
      {
        kind: "invalid_request",
        line: `{"bearer":"${EXPECTED_BEARER}","jsonrpc":"2.0","id":"operation_duplicate","id":"operation_other","method":"capabilityServices.health","params":{}}`,
      },
      {
        kind: "invalid_request",
        line: `{"bearer":"${EXPECTED_BEARER}","jsonrpc":"2.0","id":"operation_nested_duplicate","method":"capabilityServices.health","params":{"operationId":"operation_nested_duplicate","operationId":"operation_other"}}`,
      },
    ];

    try {
      for (const testCase of cases) {
        const response = await callSocket(socketPath, testCase.line);
        expectWireError(response, testCase.kind);
      }

      const oversized = authenticatedFrame(request(
        "operation_large",
        "managedRuns.report",
        {
          operationId: "operation_large",
          managedRunId: "managed-run_a",
          serviceReportId: "service-report_large",
          kind: "progress",
          summary: "x".repeat(CAPABILITY_SERVICE_LIMITS.maxReportBytes + 1),
        },
      ));
      expectWireError(await callSocket(socketPath, oversized), "size_limit_exceeded");
    } finally {
      expect((await server.close()).ok).toBe(true);
    }
  });

  it("rejects unsafe noncanonical broad and occupied fixture directories", async () => {
    const relative = makeServer("relative-fixture-directory");
    expect((await relative.start()).ok).toBe(false);

    const broad = temporaryDirectory();
    chmodSync(broad, 0o755);
    expect((await makeServer(broad).start()).ok).toBe(false);
    chmodSync(broad, 0o700);

    const symlinkTarget = temporaryDirectory();
    const symlinkParent = temporaryDirectory();
    const symlinkPath = join(symlinkParent, "linked");
    symlinkSync(symlinkTarget, symlinkPath);
    expect((await makeServer(symlinkPath).start()).ok).toBe(false);

    const occupied = temporaryDirectory();
    writeFileSync(join(occupied, "capability-service.sock"), "not a socket", { mode: 0o600 });
    expect((await makeServer(occupied).start()).ok).toBe(false);

    const longRoot = temporaryDirectory();
    const longDirectory = join(longRoot, "x".repeat(70));
    mkdirSync(longDirectory, { mode: 0o700 });
    expect((await makeServer(longDirectory).start()).ok).toBe(false);
  });

  it("returns original replay results and rejects altered operation or report reuse", async () => {
    const directory = temporaryDirectory();
    const server = makeServer(directory);
    const started = await server.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { socketPath } = started.value;
    const original = request("operation_replay", "managedRuns.report", {
      operationId: "operation_replay",
      managedRunId: "managed-run_a",
      serviceReportId: "service-report_replay",
      kind: "progress",
      summary: "First payload",
    });

    try {
      const accepted = await callSocket(socketPath, authenticatedFrame(original));
      expect(await callSocket(socketPath, authenticatedFrame(original))).toEqual(accepted);

      const changedOperation = request("operation_replay", "managedRuns.report", {
        ...(original["params"] as Record<string, unknown>),
        summary: "Altered payload",
      });
      expectWireError(
        await callSocket(socketPath, authenticatedFrame(changedOperation)),
        "replay_conflict",
      );

      const changedReport = request("operation_report_other", "managedRuns.report", {
        ...(original["params"] as Record<string, unknown>),
        operationId: "operation_report_other",
        summary: "Altered payload",
      });
      expectWireError(
        await callSocket(socketPath, authenticatedFrame(changedReport)),
        "replay_conflict",
      );
    } finally {
      expect((await server.close()).ok).toBe(true);
    }
  });

  it("bounds stalled requests by the manifest deadline and in-flight limits", async () => {
    const directory = temporaryDirectory();
    const server = makeServer(directory, 2_000);
    const started = await server.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { socketPath } = started.value;
    const stalled: net.Socket[] = [];

    try {
      for (let index = 0; index < CAPABILITY_SERVICE_LIMITS.maxInFlightRequests; index += 1) {
        const socket = net.connect(socketPath);
        stalled.push(socket);
        await new Promise<void>((resolveConnection, rejectConnection) => {
          socket.once("connect", resolveConnection);
          socket.once("error", rejectConnection);
        });
      }
      const limited = await callSocket(socketPath, authenticatedFrame(request(
        "operation_limited",
        "capabilityServices.health",
        {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: BUNDLE_DIGEST,
          operationId: "operation_limited",
          serviceInstanceId: SERVICE_INSTANCE_ID,
        },
      )));
      expectWireError(limited, "rate_limited");
    } finally {
      for (const socket of stalled) socket.destroy();
      expect((await server.close()).ok).toBe(true);
    }

    const deadlineDirectory = temporaryDirectory();
    const deadlineServer = makeServer(deadlineDirectory, 20);
    const deadlineStarted = await deadlineServer.start();
    expect(deadlineStarted.ok).toBe(true);
    if (!deadlineStarted.ok) return;
    try {
      const deadlineResponse = await new Promise<unknown>((resolveDeadline, rejectDeadline) => {
        const client = net.connect(deadlineStarted.value.socketPath);
        let response = "";
        client.on("error", rejectDeadline);
        client.on("data", (chunk: Buffer) => {
          response += chunk.toString("utf8");
          const newline = response.indexOf("\n");
          if (newline === -1) return;
          client.end();
          resolveDeadline(JSON.parse(response.slice(0, newline)) as unknown);
        });
      });
      expectWireError(deadlineResponse, "deadline_exceeded");
    } finally {
      expect((await deadlineServer.close()).ok).toBe(true);
    }
  });

  it("runs as a test-only process and prints only its socket and credential source", async () => {
    const directory = temporaryDirectory();
    const rootPackage = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const daemonPackage = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "packages/daemon/package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(rootPackage.scripts?.["capability-service-fixture-host"]).toBe(
      "pnpm --filter @comis/daemon capability-service-fixture-host",
    );
    expect(daemonPackage.scripts?.["capability-service-fixture-host"]).toBe(
      "node --import tsx src/__tests__/capability-service-protocol-fixture-host-entry.ts",
    );

    const entryPath = resolve(here, "capability-service-protocol-fixture-host-entry.ts");
    const child = spawn(process.execPath, ["--import", "tsx", entryPath, "--directory", directory], {
      cwd: REPOSITORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    try {
      const line = await firstOutputLine(child, (chunk) => {
        output += chunk;
      });
      const ready = JSON.parse(line) as {
        bundleDigest: string;
        credentialSource: { kind: string; path: string };
        protocolId: string;
        serviceInstanceId: string;
        socketPath: string;
      };
      const bearer = readFileSync(ready.credentialSource.path, "utf8").trim();
      expect(ready).toMatchObject({
        bundleDigest: BUNDLE_DIGEST,
        credentialSource: { kind: "file" },
        protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
        serviceInstanceId: SERVICE_INSTANCE_ID,
      });
      expect(statSync(ready.socketPath).mode & 0o777).toBe(0o600);
      expect(statSync(ready.credentialSource.path).mode & 0o777).toBe(0o600);
      expect(output).not.toContain(bearer);

      const response = await callSocket(ready.socketPath, authenticatedFrame(request(
        "operation_process_handshake",
        "capabilityServices.handshake",
        {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: BUNDLE_DIGEST,
          operationId: "operation_process_handshake",
          serviceInstanceId: SERVICE_INSTANCE_ID,
          requestedScopes: ["health", "report"],
        },
      ), bearer));
      expect(response).toMatchObject({
        id: "operation_process_handshake",
        result: { protocolId: CAPABILITY_SERVICE_PROTOCOL_ID, bundleDigest: BUNDLE_DIGEST },
      });

      child.kill("SIGTERM");
      expect(await childExit(child)).toEqual({ code: 0, signal: null });
      expect(existsSync(ready.socketPath)).toBe(false);
      expect(existsSync(ready.credentialSource.path)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);
});

function firstOutputLine(child: ChildProcess, observe: (chunk: string) => void): Promise<string> {
  return new Promise((resolveLine, rejectLine) => {
    let buffered = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      observe(chunk.toString("utf8"));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      observe(text);
      buffered += text;
      const newline = buffered.indexOf("\n");
      if (newline !== -1) resolveLine(buffered.slice(0, newline));
    });
    child.once("error", rejectLine);
    child.once("exit", (code, signal) => {
      rejectLine(new Error(`fixture host exited before readiness: code=${String(code)} signal=${String(signal)}`));
    });
  });
}

function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}
