// SPDX-License-Identifier: Apache-2.0
import net from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import {
  CAPABILITY_SERVICE_ERROR_DEFINITIONS,
  CAPABILITY_SERVICE_LIMITS,
  CAPABILITY_SERVICE_METHODS,
  CAPABILITY_SERVICE_PROTOCOL_ID,
  CapabilityAbandonResponseSchema,
  CapabilityActivateResponseSchema,
  CapabilityHandshakeResponseSchema,
  CapabilityHealthResponseSchema,
  CapabilityReportResponseSchema,
  CapabilityServiceRequestSchema,
  OperationIdSchema,
  type CapabilityServiceErrorKind,
  type CapabilityServiceRequest,
} from "@comis/capability-service-sdk";
import { safePath, type ClockPort } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { createCapabilityServiceProtocolFixtureHost } from "./capability-service-protocol-fixture-host.js";
import { parseStrictJson } from "./capability-service-strict-json.js";

const SOCKET_NAME = "capability-service.sock";
const MAXIMUM_UNIX_SOCKET_PATH_BYTES = 103;
const TRANSPORT_KEYS = ["bearer", "id", "jsonrpc", "method", "params"] as const;

const ERROR_TEXT = {
  bundle_digest_mismatch: ["Bundle digest does not match", "Use the exact pinned bundle"],
  deadline_exceeded: ["Request deadline elapsed", "Retry with the same operation identity"],
  internal_error: ["Fixture host could not produce a valid response", "Inspect the fixture host"],
  invalid_params: ["Request parameters are invalid", "Validate against the pinned request schema"],
  invalid_request: ["Request envelope is invalid", "Send one strict authenticated JSON-RPC line"],
  method_not_found: ["Method is not in the closed catalog", "Use a method from the pinned manifest"],
  precondition_failed: ["Instance precondition is not satisfied", "Request only configured scopes"],
  protocol_mismatch: ["Protocol identifier does not match", "Use the exact pinned protocol"],
  rate_limited: ["In-flight request limit reached", "Retry after an active request completes"],
  replay_conflict: ["Idempotency identity was reused with altered input", "Reuse the original input or mint a new identity"],
  size_limit_exceeded: ["Request exceeds a manifest size limit", "Reduce the request to the pinned limit"],
  unauthorized_instance: ["Capability-service instance authentication failed", "Use the configured instance credential"],
} as const satisfies Readonly<Record<CapabilityServiceErrorKind, readonly [string, string]>>;

export interface CapabilityServiceProtocolFixtureServerOptions {
  readonly activeScopes: readonly ("health" | "report")[];
  readonly bundleDigest: string;
  readonly clock: ClockPort;
  readonly directoryPath: string;
  readonly expectedBearer: string;
  readonly requestDeadlineMs: number;
  readonly serviceInstanceId: string;
}

export interface CapabilityServiceProtocolFixtureServerReady {
  readonly socketPath: string;
}

export interface CapabilityServiceProtocolFixtureServer {
  start(): Promise<Result<CapabilityServiceProtocolFixtureServerReady>>;
  close(): Promise<Result<void>>;
}

interface OperationReplay {
  readonly canonical: string;
  readonly response: unknown;
}

interface ReportReplay {
  readonly canonical: string;
  readonly result: unknown;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function authenticates(candidate: unknown, expectedDigest: Buffer): boolean {
  const isString = typeof candidate === "string";
  const candidateDigest = createHash("sha256").update(isString ? candidate : "", "utf8").digest();
  return isString && timingSafeEqual(candidateDigest, expectedDigest);
}

function requestId(value: unknown): string | null {
  return OperationIdSchema.safeParse(value).success ? value as string : null;
}

function errorResponse(kind: CapabilityServiceErrorKind, id: string | null): unknown {
  const definition = CAPABILITY_SERVICE_ERROR_DEFINITIONS.find((candidate) => candidate.kind === kind);
  // eslint-disable-next-line security/detect-object-injection -- kind is the SDK's closed CapabilityServiceErrorKind union
  const [message, hint] = ERROR_TEXT[kind];
  if (!definition) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32_603,
        kind: "internal_error",
        retryable: true,
        message: ERROR_TEXT.internal_error[0],
        hint: ERROR_TEXT.internal_error[1],
      },
    };
  }
  return { jsonrpc: "2.0", id, error: { ...definition, message, hint } };
}

function reportCanonical(request: Extract<CapabilityServiceRequest, { method: "managedRuns.report" }>): string {
  const { operationId: _operationId, ...content } = request.params;
  return JSON.stringify(content);
}

function validateResponse(method: CapabilityServiceRequest["method"], response: unknown): boolean {
  switch (method) {
    case "capabilityServices.handshake":
      return CapabilityHandshakeResponseSchema.safeParse(response).success;
    case "capabilityServices.health":
      return CapabilityHealthResponseSchema.safeParse(response).success;
    case "managedRuns.abandon":
      return CapabilityAbandonResponseSchema.safeParse(response).success;
    case "managedRuns.activate":
      return CapabilityActivateResponseSchema.safeParse(response).success;
    case "managedRuns.report":
      return CapabilityReportResponseSchema.safeParse(response).success;
    default: {
      const _exhaustive: never = method;
      return _exhaustive;
    }
  }
}

/** Create the real test-only transport used by cross-language protocol fixtures. */
export function createCapabilityServiceProtocolFixtureServer(
  options: CapabilityServiceProtocolFixtureServerOptions,
): CapabilityServiceProtocolFixtureServer {
  const expectedBearerDigest = createHash("sha256").update(options.expectedBearer, "utf8").digest();
  const validator = createCapabilityServiceProtocolFixtureHost({ bundleDigest: options.bundleDigest });
  const operations = new Map<string, OperationReplay>();
  const reports = new Map<string, ReportReplay>();
  const openSockets = new Set<net.Socket>();
  let acceptedSequence = 0;
  let server: net.Server | undefined;
  let boundSocketPath: string | undefined;

  function dispatch(request: CapabilityServiceRequest): unknown {
    switch (request.method) {
      case "capabilityServices.handshake":
        return {
          jsonrpc: "2.0", id: request.id, result: {
            protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
            bundleDigest: options.bundleDigest,
            serviceInstanceId: options.serviceInstanceId,
            activeScopes: options.activeScopes,
            limits: CAPABILITY_SERVICE_LIMITS,
          },
        };
      case "capabilityServices.health":
        return {
          jsonrpc: "2.0", id: request.id, result: {
            protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
            bundleDigest: options.bundleDigest,
            serviceInstanceId: options.serviceInstanceId,
            status: "healthy",
            observedAtMs: options.clock.now(),
            reasonCodes: [],
          },
        };
      case "managedRuns.abandon":
        return { jsonrpc: "2.0", id: request.id, result: { externalRunRef: request.params.externalRunRef, state: "abandoned" } };
      case "managedRuns.activate":
        return {
          jsonrpc: "2.0", id: request.id, result: {
            managedRunId: request.params.managedRunId,
            externalRunRef: request.params.externalRunRef,
            state: "active",
            activatedAtMs: options.clock.now(),
          },
        };
      case "managedRuns.report": {
        const existing = reports.get(request.params.serviceReportId);
        if (existing) return { jsonrpc: "2.0", id: request.id, result: existing.result };
        acceptedSequence += 1;
        const result = {
          managedRunId: request.params.managedRunId,
          serviceReportId: request.params.serviceReportId,
          acceptedSequence,
          retainedUntilMs: options.clock.now() + CAPABILITY_SERVICE_LIMITS.reportRetentionDays * 86_400_000,
        };
        reports.set(request.params.serviceReportId, { canonical: reportCanonical(request), result });
        return { jsonrpc: "2.0", id: request.id, result };
      }
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  }

  function route(line: string): unknown {
    const decoded = parseStrictJson(line);
    if (!decoded.ok) return errorResponse("invalid_request", null);
    const frame = asRecord(decoded.value);
    if (!frame) return errorResponse("invalid_request", null);
    if (!authenticates(frame["bearer"], expectedBearerDigest)) {
      return errorResponse("unauthorized_instance", null);
    }
    if (
      Object.keys(frame).length !== TRANSPORT_KEYS.length ||
      TRANSPORT_KEYS.some((key) => !(key in frame))
    ) {
      return errorResponse("invalid_request", requestId(frame["id"]));
    }
    const id = requestId(frame["id"]);
    if (
      typeof frame["method"] !== "string" ||
      !CAPABILITY_SERVICE_METHODS.includes(frame["method"] as (typeof CAPABILITY_SERVICE_METHODS)[number])
    ) {
      return errorResponse("method_not_found", id);
    }
    const payload = {
      jsonrpc: frame["jsonrpc"],
      id: frame["id"],
      method: frame["method"],
      params: frame["params"],
    };
    const params = asRecord(frame["params"]);
    if (params?.["protocolId"] !== undefined && params["protocolId"] !== CAPABILITY_SERVICE_PROTOCOL_ID) {
      return errorResponse("protocol_mismatch", id);
    }
    if (params?.["bundleDigest"] !== undefined && params["bundleDigest"] !== options.bundleDigest) {
      return errorResponse("bundle_digest_mismatch", id);
    }
    if (frame["method"] === "managedRuns.report" && params) {
      const summaryBytes = typeof params["summary"] === "string"
        ? Buffer.byteLength(params["summary"], "utf8")
        : 0;
      const detailsBytes = typeof params["details"] === "string"
        ? Buffer.byteLength(params["details"], "utf8")
        : 0;
      if (summaryBytes + detailsBytes > CAPABILITY_SERVICE_LIMITS.maxReportBytes) {
        return errorResponse("size_limit_exceeded", id);
      }
    }
    const parsed = CapabilityServiceRequestSchema.safeParse(payload);
    if (!parsed.success) return errorResponse("invalid_params", id);
    if (parsed.data.id !== parsed.data.params.operationId) return errorResponse("invalid_request", id);
    if (
      (parsed.data.method === "capabilityServices.handshake" || parsed.data.method === "capabilityServices.health") &&
      parsed.data.params.serviceInstanceId !== options.serviceInstanceId
    ) {
      return errorResponse("unauthorized_instance", id);
    }
    if (
      parsed.data.method === "capabilityServices.handshake" &&
      parsed.data.params.requestedScopes.some((scope) => !options.activeScopes.includes(scope))
    ) {
      return errorResponse("precondition_failed", id);
    }
    if (parsed.data.method === "capabilityServices.health" && !options.activeScopes.includes("health")) {
      return errorResponse("precondition_failed", id);
    }
    if (parsed.data.method === "managedRuns.report" && !options.activeScopes.includes("report")) {
      return errorResponse("precondition_failed", id);
    }
    const canonical = JSON.stringify(parsed.data);
    const priorOperation = operations.get(parsed.data.params.operationId);
    if (priorOperation) {
      return priorOperation.canonical === canonical
        ? priorOperation.response
        : errorResponse("replay_conflict", id);
    }
    if (parsed.data.method === "managedRuns.report") {
      const priorReport = reports.get(parsed.data.params.serviceReportId);
      if (priorReport && priorReport.canonical !== reportCanonical(parsed.data)) {
        return errorResponse("replay_conflict", id);
      }
    }
    const validated = validator.validateRequest(payload);
    if (!validated.ok) return errorResponse(validated.error.kind, id);
    const response = dispatch(parsed.data);
    if (!validateResponse(parsed.data.method, response)) return errorResponse("internal_error", id);
    operations.set(parsed.data.params.operationId, { canonical, response });
    return response;
  }

  function endWith(socket: net.Socket, response: unknown): void {
    const encoded = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
    if (
      encoded.byteLength > CAPABILITY_SERVICE_LIMITS.maxLineBytes ||
      encoded.byteLength - 1 > CAPABILITY_SERVICE_LIMITS.maxResponseBytes
    ) {
      socket.end(`${JSON.stringify(errorResponse("internal_error", null))}\n`);
      return;
    }
    socket.end(encoded);
  }

  function accept(socket: net.Socket): void {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
    socket.on("error", () => openSockets.delete(socket));
    if (openSockets.size > CAPABILITY_SERVICE_LIMITS.maxInFlightRequests) {
      endWith(socket, errorResponse("rate_limited", null));
      return;
    }
    let buffered = Buffer.alloc(0);
    let settled = false;
    socket.setTimeout(options.requestDeadlineMs, () => {
      if (settled) return;
      settled = true;
      endWith(socket, errorResponse("deadline_exceeded", null));
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.byteLength >= CAPABILITY_SERVICE_LIMITS.maxLineBytes) {
          settled = true;
          endWith(socket, errorResponse("size_limit_exceeded", null));
        }
        return;
      }
      settled = true;
      if (newline + 1 > CAPABILITY_SERVICE_LIMITS.maxLineBytes || newline + 1 !== buffered.byteLength) {
        endWith(socket, errorResponse(newline + 1 > CAPABILITY_SERVICE_LIMITS.maxLineBytes ? "size_limit_exceeded" : "invalid_request", null));
        return;
      }
      const text = tryCatch(() => new TextDecoder("utf-8", { fatal: true }).decode(buffered.subarray(0, newline)));
      endWith(socket, text.ok ? route(text.value) : errorResponse("invalid_request", null));
    });
  }

  async function start(): Promise<Result<CapabilityServiceProtocolFixtureServerReady>> {
    if (server) return err(new Error("capability-service fixture server is already started"));
    if (
      options.requestDeadlineMs <= 0 ||
      options.expectedBearer.length === 0 ||
      !isAbsolute(options.directoryPath) ||
      normalize(options.directoryPath) !== options.directoryPath
    ) {
      return err(new Error("capability-service fixture server options are invalid"));
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller path is required to be absolute/canonical and is verified before socket binding
    const directory = await fromPromise(lstat(options.directoryPath));
    if (!directory.ok || !directory.value.isDirectory() || directory.value.isSymbolicLink()) {
      return err(new Error("capability-service fixture directory is not a real directory"));
    }
    if ((directory.value.mode & 0o077) !== 0) {
      return err(new Error("capability-service fixture directory is not owner-only"));
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolves the same caller directory to prove its supplied path is canonical
    const canonical = await fromPromise(realpath(options.directoryPath));
    if (!canonical.ok || canonical.value !== options.directoryPath) {
      return err(new Error("capability-service fixture directory is not canonical"));
    }
    const resolvedPath = tryCatch(() => safePath(options.directoryPath, SOCKET_NAME));
    if (!resolvedPath.ok || Buffer.byteLength(resolvedPath.value, "utf8") > MAXIMUM_UNIX_SOCKET_PATH_BYTES) {
      return err(new Error("capability-service fixture socket path is invalid"));
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath confines the fixed socket filename beneath the verified directory
    const existing = await fromPromise(lstat(resolvedPath.value));
    if (existing.ok || (existing.error as NodeJS.ErrnoException).code !== "ENOENT") {
      return err(new Error("capability-service fixture socket path already exists"));
    }
    const created = net.createServer(accept);
    created.on("error", () => {
      for (const socket of openSockets) socket.destroy();
    });
    const listening = await fromPromise(new Promise<void>((resolveListen, rejectListen) => {
      created.once("error", rejectListen);
      created.listen({ path: resolvedPath.value }, resolveListen);
    }));
    if (!listening.ok) return listening;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chmod targets only the socket just bound at the safePath-confined fixed path
    const restricted = await fromPromise(chmod(resolvedPath.value, 0o600));
    if (!restricted.ok) {
      await fromPromise(new Promise<void>((resolveClose) => created.close(() => resolveClose())));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- removes only the socket created at the safePath-confined fixed path
      await fromPromise(unlink(resolvedPath.value));
      return restricted;
    }
    server = created;
    boundSocketPath = resolvedPath.value;
    return ok({ socketPath: resolvedPath.value });
  }

  async function close(): Promise<Result<void>> {
    const active = server;
    server = undefined;
    for (const socket of openSockets) socket.destroy();
    openSockets.clear();
    if (active) {
      const closed = await fromPromise(new Promise<void>((resolveClose, rejectClose) => {
        active.close((closeError) => closeError ? rejectClose(closeError) : resolveClose());
      }));
      if (!closed.ok) return closed;
    }
    if (boundSocketPath) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- removes only the exact socket path retained after a successful bind
      const removed = await fromPromise(unlink(boundSocketPath));
      boundSocketPath = undefined;
      if (!removed.ok && (removed.error as NodeJS.ErrnoException).code !== "ENOENT") return removed;
    }
    return ok(undefined);
  }

  return { start, close };
}
