// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, normalize, relative, sep } from "node:path";
import type { z } from "zod";
import {
  CAPABILITY_SERVICE_ERROR_DEFINITIONS,
  CAPABILITY_SERVICE_LIMITS,
  CAPABILITY_SERVICE_PROTOCOL_ID,
  CapabilityAbandonRequestSchema,
  CapabilityAbandonResponseSchema,
  CapabilityActivateRequestSchema,
  CapabilityActivateResponseSchema,
  CapabilityHandshakeRequestSchema,
  CapabilityHealthRequestSchema,
  CapabilityPutEvidenceRequestSchema,
  CapabilityReleaseRequestSchema,
  CapabilityReportRequestSchema,
  CapabilityServiceErrorResponseSchema,
  type CapabilityServiceErrorKind,
} from "@comis/capability-service-sdk";
import {
  safePath,
  type CapabilityServiceAbandonAcknowledgement,
  type CapabilityServiceAbandonCommand,
  type CapabilityServiceActivateAcknowledgement,
  type CapabilityServiceActivateCommand,
  type CapabilityServiceControlFailure,
  type CapabilityServiceControlPort,
  type CapabilityServiceScope,
  type CapabilityServiceTerminalEventAcknowledgement,
  type CapabilityServiceTerminalEventCommand,
  type ClockPort,
  type ComisLogger,
  type PlannedCapabilityServiceDefinition,
  type PlannedCapabilityServiceInstance,
  type TimerHandle,
  type TimerPort,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import {
  type CapabilityServiceRuntimeActivator,
  type CapabilityServiceRuntimeHandle,
} from "./capability-service-runtime.js";
import type { ManagedRunReportBridge } from "./managed-run-report-bridge.js";
import type { ManagedRunEvidenceBridge } from "./managed-run-evidence-bridge.js";
import type { ManagedRunReleaseCoordinator } from "./managed-run-release-coordinator.js";
import {
  routeManagedRunEvidenceIngress,
  routeManagedRunReleaseIngress,
  routeManagedRunReportIngress,
} from "./capability-service-ingress-routes.js";
import { parseStrictJson } from "./capability-service-strict-json.js";
import { forwardTerminalEvent, sendEndpointTerminalEvent } from "./capability-service-terminal-event.js";

const MAXIMUM_UNIX_SOCKET_PATH_BYTES = 103;
const MAX_REPLAY_ENTRIES = 4_096;
const REQUEST_KEYS = ["bearer", "id", "jsonrpc", "method", "params"] as const;

const ERROR_TEXT = {
  bundle_digest_mismatch: ["Bundle digest does not match", "Use the exact configured protocol bundle"],
  deadline_exceeded: ["Request deadline elapsed", "Reconcile with the same operation identity before retrying"],
  internal_error: ["Capability-service request failed", "Inspect the managed-run store and capability-service health"],
  invalid_params: ["Request parameters are invalid", "Validate the request against the pinned schema"],
  invalid_request: ["Request envelope is invalid", "Send one strict authenticated JSON-RPC request line"],
  method_not_found: ["Method is not callable in this direction", "Use a service-to-Comis method from the pinned catalog"],
  precondition_failed: ["Request precondition is not satisfied", "Complete the exact instance handshake before retrying"],
  protocol_mismatch: ["Protocol identifier does not match", "Use the exact configured protocol identifier"],
  rate_limited: ["In-flight request limit reached", "Retry after an active request completes"],
  replay_conflict: ["Operation identity was reused with altered input", "Reuse the original input or mint a new operation identity"],
  size_limit_exceeded: ["Request exceeds a protocol size limit", "Reduce the request to the pinned manifest limit"],
  unauthorized_instance: ["Capability-service authentication failed", "Use the configured instance credential"],
} as const satisfies Readonly<Record<CapabilityServiceErrorKind, readonly [string, string]>>;

interface ConfiguredInstance {
  readonly definition: PlannedCapabilityServiceDefinition;
  readonly instance: PlannedCapabilityServiceInstance;
  readonly credential: () => string | undefined;
}

interface WireFailure extends CapabilityServiceControlFailure {
  readonly step: "request" | "response";
}

interface PendingControl<T = unknown> {
  readonly responseSchema: z.ZodType;
  readonly resolve: (result: Result<T, WireFailure>) => void;
  readonly timer: TimerHandle;
}

interface InboundReplay {
  readonly canonical: string;
  response?: unknown;
}

interface HandshakeWaiter {
  readonly resolve: (result: Result<{
    readonly protocolId: typeof CAPABILITY_SERVICE_PROTOCOL_ID;
    readonly serviceInstanceId: string;
    readonly activeScopes: readonly CapabilityServiceScope[];
  }, Error>) => void;
  readonly timer: TimerHandle;
}

export interface UnixCapabilityServiceHostRuntime {
  readonly activators: readonly CapabilityServiceRuntimeActivator[];
  readonly control: CapabilityServiceControlPort;
}

export interface UnixCapabilityServiceHostRuntimeDeps {
  readonly definitions: readonly PlannedCapabilityServiceDefinition[];
  readonly instances: readonly PlannedCapabilityServiceInstance[];
  readonly credentials: ReadonlyMap<string, () => string | undefined>;
  readonly bundleDigest: string;
  readonly socketRoot: string;
  readonly reportBridge: ManagedRunReportBridge;
  readonly evidenceBridge: ManagedRunEvidenceBridge;
  readonly releaseCoordinator: ManagedRunReleaseCoordinator;
  readonly requestDeadlineMs: number;
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly logger: ComisLogger;
}

interface Endpoint {
  readonly handle: CapabilityServiceRuntimeHandle;
  activate(command: CapabilityServiceActivateCommand): Promise<Result<
    CapabilityServiceActivateAcknowledgement,
    CapabilityServiceControlFailure
  >>;
  abandon(command: CapabilityServiceAbandonCommand): Promise<Result<
    CapabilityServiceAbandonAcknowledgement,
    CapabilityServiceControlFailure
  >>;
  terminalEvent(command: CapabilityServiceTerminalEventCommand): Promise<Result<
    CapabilityServiceTerminalEventAcknowledgement,
    CapabilityServiceControlFailure
  >>;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function authenticates(candidate: unknown, expected: string | undefined): boolean {
  const isString = typeof candidate === "string";
  const candidateDigest = createHash("sha256").update(isString ? candidate : "", "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected ?? "", "utf8").digest();
  return isString && expected !== undefined && expected.length > 0
    && timingSafeEqual(candidateDigest, expectedDigest);
}

function failureKind(kind: CapabilityServiceErrorKind): CapabilityServiceControlFailure["kind"] {
  switch (kind) {
    case "deadline_exceeded":
    case "internal_error":
      return "uncertain";
    case "rate_limited":
      return "unavailable";
    case "bundle_digest_mismatch":
    case "invalid_params":
    case "invalid_request":
    case "method_not_found":
    case "precondition_failed":
    case "protocol_mismatch":
    case "replay_conflict":
    case "size_limit_exceeded":
    case "unauthorized_instance":
      return "rejected";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function errorResponse(kind: CapabilityServiceErrorKind, id: string | null): unknown {
  const definition = CAPABILITY_SERVICE_ERROR_DEFINITIONS.find((candidate) => candidate.kind === kind);
  // eslint-disable-next-line security/detect-object-injection -- kind is the SDK's closed error discriminator
  const [message, hint] = ERROR_TEXT[kind];
  if (definition === undefined) {
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

function requestId(record: Readonly<Record<string, unknown>> | undefined): string | null {
  return typeof record?.["id"] === "string" ? record["id"] : null;
}

function canonical(value: unknown): Result<string, Error> {
  return tryCatch(() => JSON.stringify(value));
}

function verifySocketRoot(root: string): Result<void, Error> {
  if (!isAbsolute(root) || normalize(root) !== root) {
    return err(new Error("capability-service socket root must be absolute and canonical"));
  }
  const checked = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the composition root supplies this absolute confined root
    const stat = lstatSync(root);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonicality is checked against the same configured root
    const canonicalRoot = realpathSync(root);
    return { stat, canonicalRoot };
  });
  if (!checked.ok) return err(checked.error);
  if (
    !checked.value.stat.isDirectory()
    || checked.value.stat.isSymbolicLink()
    || (checked.value.stat.mode & 0o077) !== 0
    || checked.value.canonicalRoot !== root
  ) {
    return err(new Error("capability-service socket root must be a real owner-only directory"));
  }
  return ok(undefined);
}

function verifySocketPath(root: string, socketPath: string): Result<void, Error> {
  if (!isAbsolute(socketPath) || normalize(socketPath) !== socketPath) {
    return err(new Error("capability-service socket path must be absolute and normalized"));
  }
  const relativePath = relative(root, socketPath);
  if (
    relativePath.length === 0
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    return err(new Error("capability-service socket path must remain beneath the configured root"));
  }
  const reconstructed = tryCatch(() => safePath(root, ...relativePath.split(sep)));
  if (!reconstructed.ok || reconstructed.value !== socketPath) {
    return err(new Error("capability-service socket path failed confinement"));
  }
  if (Buffer.byteLength(socketPath, "utf8") > MAXIMUM_UNIX_SOCKET_PATH_BYTES) {
    return err(new Error("capability-service socket path exceeds the platform limit"));
  }
  const parent = dirname(socketPath);
  const checked = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- parent is derived from a safePath-confined socket path
    const stat = lstatSync(parent);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonicality is checked on the safePath-confined parent
    const canonicalParent = realpathSync(parent);
    return { stat, canonicalParent };
  });
  if (!checked.ok) return err(checked.error);
  if (
    !checked.value.stat.isDirectory()
    || checked.value.stat.isSymbolicLink()
    || (checked.value.stat.mode & 0o077) !== 0
    || checked.value.canonicalParent !== parent
  ) {
    return err(new Error("capability-service socket parent must be a real owner-only directory"));
  }
  return ok(undefined);
}

function removeStaleSocket(socketPath: string): Result<void, Error> {
  const existing = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- socketPath passed confinement and parent verification
    return lstatSync(socketPath);
  });
  if (!existing.ok) {
    return (existing.error as NodeJS.ErrnoException).code === "ENOENT"
      ? ok(undefined)
      : err(existing.error);
  }
  if (!existing.value.isSocket() || existing.value.isSymbolicLink()) {
    return err(new Error("capability-service socket path is occupied by a non-socket entry"));
  }
  const removed = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- removes only the verified stale socket at the confined path
    unlinkSync(socketPath);
  });
  return removed.ok ? ok(undefined) : err(removed.error);
}

function writeLine(socket: net.Socket, value: unknown): Result<void, Error> {
  const serialized = canonical(value);
  if (!serialized.ok) return serialized;
  const framed = `${serialized.value}\n`;
  if (
    Buffer.byteLength(serialized.value, "utf8") > CAPABILITY_SERVICE_LIMITS.maxResponseBytes
    || Buffer.byteLength(framed, "utf8") > CAPABILITY_SERVICE_LIMITS.maxLineBytes
  ) {
    return err(new Error("capability-service response exceeds its protocol limit"));
  }
  const written = tryCatch(() => socket.write(framed));
  return written.ok ? ok(undefined) : err(written.error);
}

function createEndpoint(
  configured: ConfiguredInstance,
  deps: UnixCapabilityServiceHostRuntimeDeps,
  unregister: () => void,
): Promise<Result<Endpoint, Error>> {
  return (async () => {
    const pathCheck = verifySocketPath(deps.socketRoot, configured.instance.control.socketPath);
    if (!pathCheck.ok) return pathCheck;
    const removed = removeStaleSocket(configured.instance.control.socketPath);
    if (!removed.ok) return removed;

    const sockets = new Set<net.Socket>();
    const pending = new Map<string, PendingControl>();
    const replay = new Map<string, InboundReplay>();
    const inboundOperations = new Set<Promise<void>>();
    let inboundCount = 0;
    let boundSocket: net.Socket | undefined;
    let handshakeValue: {
      readonly protocolId: typeof CAPABILITY_SERVICE_PROTOCOL_ID;
      readonly serviceInstanceId: string;
      readonly activeScopes: readonly CapabilityServiceScope[];
    } | undefined;
    let handshakeWaiter: HandshakeWaiter | undefined;
    let closed = false;

    function finishPending(id: string, result: Result<unknown, WireFailure>): boolean {
      const entry = pending.get(id);
      if (entry === undefined) return false;
      pending.delete(id);
      entry.timer.cancel();
      entry.resolve(result);
      return true;
    }

    function failPending(reasonCode: string): void {
      for (const id of [...pending.keys()]) {
        finishPending(id, err({ kind: "uncertain", reasonCode, step: "response" }));
      }
    }

    function logWireRejection(kind: CapabilityServiceErrorKind): void {
      deps.logger.audit({
        decision: "deny",
        serviceInstanceId: configured.instance.serviceInstanceId,
        reasonCode: kind,
      }, "Capability-service control request rejected");
    }

    function reply(socket: net.Socket, value: unknown): void {
      const written = writeLine(socket, value);
      if (!written.ok) {
        deps.logger.warn({
          serviceInstanceId: configured.instance.serviceInstanceId,
          errorKind: "network" as const,
          hint: "Inspect the configured capability-service socket and reconnect the exact instance",
        }, "Capability-service response write failed");
        socket.destroy();
      }
    }

    function rejectRequest(
      socket: net.Socket,
      kind: CapabilityServiceErrorKind,
      id: string | null,
    ): void {
      logWireRejection(kind);
      reply(socket, errorResponse(kind, id));
    }

    function rememberResponse(operationId: string, response: unknown): void {
      const entry = replay.get(operationId);
      if (entry !== undefined) entry.response = response;
      while (replay.size > MAX_REPLAY_ENTRIES) {
        const oldest = replay.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        replay.delete(oldest);
      }
    }

    function beginReplay(
      operationId: string,
      request: unknown,
    ): Result<"new", "pending" | "replay_conflict" | { readonly response: unknown }> {
      const encoded = canonical(request);
      if (!encoded.ok) return err("replay_conflict");
      const previous = replay.get(operationId);
      if (previous === undefined) {
        replay.set(operationId, { canonical: encoded.value });
        return ok("new");
      }
      if (previous.canonical !== encoded.value) return err("replay_conflict");
      return previous.response === undefined
        ? err("pending")
        : err({ response: previous.response });
    }

    async function routeReport(socket: net.Socket, request: z.infer<typeof CapabilityReportRequestSchema>): Promise<void> {
      const operationId = request.params.operationId;
      const replayState = beginReplay(operationId, request);
      if (!replayState.ok) {
        if (typeof replayState.error === "object") reply(socket, replayState.error.response);
        else rejectRequest(socket, replayState.error === "pending" ? "rate_limited" : "replay_conflict", request.id);
        return;
      }
      if (inboundCount >= CAPABILITY_SERVICE_LIMITS.maxInFlightRequests) {
        replay.delete(operationId);
        rejectRequest(socket, "rate_limited", request.id);
        return;
      }
      inboundCount += 1;
      const routed = await routeManagedRunReportIngress(
        configured.instance.serviceInstanceId,
        request,
        deps,
      );
      inboundCount -= 1;
      const response = routed.errorKind === undefined
        ? { jsonrpc: "2.0", id: request.id, result: routed.response }
        : errorResponse(routed.errorKind, request.id);
      rememberResponse(operationId, response);
      reply(socket, response);
    }

    async function routeEvidence(
      socket: net.Socket,
      request: z.infer<typeof CapabilityPutEvidenceRequestSchema>,
    ): Promise<void> {
      const operationId = request.params.operationId;
      const replayState = beginReplay(operationId, request);
      if (!replayState.ok) {
        if (typeof replayState.error === "object") reply(socket, replayState.error.response);
        else rejectRequest(socket, replayState.error === "pending" ? "rate_limited" : "replay_conflict", request.id);
        return;
      }
      if (inboundCount >= CAPABILITY_SERVICE_LIMITS.maxInFlightRequests) {
        replay.delete(operationId);
        rejectRequest(socket, "rate_limited", request.id);
        return;
      }
      inboundCount += 1;
      const routed = await routeManagedRunEvidenceIngress(
        configured.instance.serviceInstanceId,
        request,
        deps,
      );
      inboundCount -= 1;
      const response = routed.errorKind === undefined
        ? { jsonrpc: "2.0", id: request.id, result: routed.response }
        : errorResponse(routed.errorKind, request.id);
      rememberResponse(operationId, response);
      reply(socket, response);
    }

    async function routeRelease(
      socket: net.Socket,
      request: z.infer<typeof CapabilityReleaseRequestSchema>,
    ): Promise<void> {
      const operationId = request.params.operationId;
      const replayState = beginReplay(operationId, request);
      if (!replayState.ok) {
        if (typeof replayState.error === "object") reply(socket, replayState.error.response);
        else rejectRequest(socket, replayState.error === "pending" ? "rate_limited" : "replay_conflict", request.id);
        return;
      }
      if (inboundCount >= CAPABILITY_SERVICE_LIMITS.maxInFlightRequests) {
        replay.delete(operationId);
        rejectRequest(socket, "rate_limited", request.id);
        return;
      }
      inboundCount += 1;
      const routed = await routeManagedRunReleaseIngress(
        configured.instance.serviceInstanceId,
        request,
        deps,
      );
      inboundCount -= 1;
      const response = routed.errorKind === undefined
        ? { jsonrpc: "2.0", id: request.id, result: routed.response }
        : errorResponse(routed.errorKind, request.id);
      rememberResponse(operationId, response);
      reply(socket, response);
    }

    function trackInbound(operation: Promise<void>): void {
      inboundOperations.add(operation);
      void operation.then(
        () => inboundOperations.delete(operation),
        () => {
          inboundOperations.delete(operation);
          deps.logger.error({
            serviceInstanceId: configured.instance.serviceInstanceId,
            errorKind: "internal" as const,
            hint: "Inspect the managed-run ingress bridges and durable stores before reconnecting the capability service",
          }, "Capability-service ingress routing failed unexpectedly");
        },
      );
    }

    function routeHandshake(
      socket: net.Socket,
      request: z.infer<typeof CapabilityHandshakeRequestSchema>,
    ): void {
      const operationId = request.params.operationId;
      const replayState = beginReplay(operationId, request);
      if (!replayState.ok) {
        if (typeof replayState.error === "object") reply(socket, replayState.error.response);
        else rejectRequest(socket, replayState.error === "pending" ? "rate_limited" : "replay_conflict", request.id);
        return;
      }
      if (
        request.params.serviceInstanceId !== configured.instance.serviceInstanceId
        || JSON.stringify([...request.params.requestedScopes].sort())
          !== JSON.stringify([...configured.definition.requestedScopes].sort())
      ) {
        const response = errorResponse("precondition_failed", request.id);
        rememberResponse(operationId, response);
        reply(socket, response);
        return;
      }
      if (boundSocket !== undefined && boundSocket !== socket && !boundSocket.destroyed) {
        const response = errorResponse("precondition_failed", request.id);
        rememberResponse(operationId, response);
        reply(socket, response);
        return;
      }
      boundSocket = socket;
      handshakeValue = Object.freeze({
        protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
        serviceInstanceId: configured.instance.serviceInstanceId,
        activeScopes: Object.freeze([...configured.definition.requestedScopes]),
      });
      const response = {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: deps.bundleDigest,
          serviceInstanceId: configured.instance.serviceInstanceId,
          activeScopes: configured.definition.requestedScopes,
          limits: CAPABILITY_SERVICE_LIMITS,
        },
      };
      rememberResponse(operationId, response);
      reply(socket, response);
      if (handshakeWaiter !== undefined) {
        handshakeWaiter.timer.cancel();
        handshakeWaiter.resolve(ok(handshakeValue));
        handshakeWaiter = undefined;
      }
      deps.logger.info({
        serviceInstanceId: configured.instance.serviceInstanceId,
        durationMs: 0,
      }, "Capability-service handshake completed");
    }

    function routeHealth(
      socket: net.Socket,
      request: z.infer<typeof CapabilityHealthRequestSchema>,
    ): void {
      if (
        boundSocket !== socket
        || request.params.serviceInstanceId !== configured.instance.serviceInstanceId
      ) {
        rejectRequest(socket, "precondition_failed", request.id);
        return;
      }
      const replayState = beginReplay(request.params.operationId, request);
      if (!replayState.ok) {
        if (typeof replayState.error === "object") reply(socket, replayState.error.response);
        else rejectRequest(socket, replayState.error === "pending" ? "rate_limited" : "replay_conflict", request.id);
        return;
      }
      const response = {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
          bundleDigest: deps.bundleDigest,
          serviceInstanceId: configured.instance.serviceInstanceId,
          status: "healthy",
          observedAtMs: deps.clock.now(),
          reasonCodes: [],
        },
      };
      rememberResponse(request.params.operationId, response);
      reply(socket, response);
    }

    function routeRequest(socket: net.Socket, frame: Readonly<Record<string, unknown>>): void {
      const id = requestId(frame);
      if (
        Object.keys(frame).length !== REQUEST_KEYS.length
        || REQUEST_KEYS.some((key) => !(key in frame))
      ) {
        rejectRequest(socket, "invalid_request", id);
        return;
      }
      if (!authenticates(frame["bearer"], configured.credential())) {
        rejectRequest(socket, "unauthorized_instance", null);
        return;
      }
      const params = asRecord(frame["params"]);
      if (params !== undefined) {
        if ("protocolId" in params && params["protocolId"] !== CAPABILITY_SERVICE_PROTOCOL_ID) {
          rejectRequest(socket, "protocol_mismatch", id);
          return;
        }
        if ("bundleDigest" in params && params["bundleDigest"] !== deps.bundleDigest) {
          rejectRequest(socket, "bundle_digest_mismatch", id);
          return;
        }
      }
      const request = {
        jsonrpc: frame["jsonrpc"],
        id: frame["id"],
        method: frame["method"],
        params: frame["params"],
      };
      if (frame["method"] === "capabilityServices.handshake") {
        const parsed = CapabilityHandshakeRequestSchema.safeParse(request);
        if (!parsed.success || parsed.data.id !== parsed.data.params.operationId) {
          rejectRequest(socket, "invalid_params", id);
          return;
        }
        routeHandshake(socket, parsed.data);
        return;
      }
      if (frame["method"] === "capabilityServices.health") {
        const parsed = CapabilityHealthRequestSchema.safeParse(request);
        if (!parsed.success || parsed.data.id !== parsed.data.params.operationId) {
          rejectRequest(socket, "invalid_params", id);
          return;
        }
        routeHealth(socket, parsed.data);
        return;
      }
      if (frame["method"] === "managedRuns.report") {
        if (boundSocket !== socket || !configured.definition.requestedScopes.includes("report")) {
          rejectRequest(socket, "precondition_failed", id);
          return;
        }
        const parsed = CapabilityReportRequestSchema.safeParse(request);
        if (!parsed.success || parsed.data.id !== parsed.data.params.operationId) {
          rejectRequest(socket, "invalid_params", id);
          return;
        }
        trackInbound(routeReport(socket, parsed.data));
        return;
      }
      if (frame["method"] === "managedRuns.putEvidence") {
        if (boundSocket !== socket || !configured.definition.requestedScopes.includes("evidence")) {
          rejectRequest(socket, "precondition_failed", id);
          return;
        }
        const parsed = CapabilityPutEvidenceRequestSchema.safeParse(request);
        if (!parsed.success || parsed.data.id !== parsed.data.params.operationId) {
          rejectRequest(socket, "invalid_params", id);
          return;
        }
        trackInbound(routeEvidence(socket, parsed.data));
        return;
      }
      if (frame["method"] === "managedRuns.release") {
        if (boundSocket !== socket || !configured.definition.requestedScopes.includes("workspace_lease")) {
          rejectRequest(socket, "precondition_failed", id);
          return;
        }
        const parsed = CapabilityReleaseRequestSchema.safeParse(request);
        if (!parsed.success || parsed.data.id !== parsed.data.params.operationId) {
          rejectRequest(socket, "invalid_params", id);
          return;
        }
        trackInbound(routeRelease(socket, parsed.data));
        return;
      }
      if (frame["method"] === "managedRuns.activate" || frame["method"] === "managedRuns.abandon") {
        rejectRequest(socket, "method_not_found", id);
        return;
      }
      rejectRequest(socket, "method_not_found", id);
    }

    function routeResponse(frame: Readonly<Record<string, unknown>>): void {
      const id = requestId(frame);
      if (id === null) return;
      const entry = pending.get(id);
      if (entry === undefined) return;
      const remoteError = CapabilityServiceErrorResponseSchema.safeParse(frame);
      if (remoteError.success) {
        finishPending(id, err({
          kind: failureKind(remoteError.data.error.kind),
          reasonCode: remoteError.data.error.kind,
          step: "response",
        }));
        return;
      }
      const parsed = entry.responseSchema.safeParse(frame);
      if (!parsed.success) {
        finishPending(id, err({ kind: "uncertain", reasonCode: "invalid_response", step: "response" }));
        return;
      }
      const response = asRecord(parsed.data);
      finishPending(id, response !== undefined && "result" in response
        ? ok(response["result"])
        : err({ kind: "uncertain", reasonCode: "invalid_response", step: "response" }));
    }

    function accept(socket: net.Socket): void {
      if (closed) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      let buffered = Buffer.alloc(0);
      let partialFrameTimer: TimerHandle | undefined;
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.byteLength > CAPABILITY_SERVICE_LIMITS.maxLineBytes) {
          partialFrameTimer?.cancel();
          partialFrameTimer = undefined;
          rejectRequest(socket, "size_limit_exceeded", null);
          socket.destroy();
          return;
        }
        let newline = buffered.indexOf(0x0a);
        while (newline >= 0) {
          partialFrameTimer?.cancel();
          partialFrameTimer = undefined;
          const line = buffered.subarray(0, newline);
          buffered = buffered.subarray(newline + 1);
          if (line.byteLength > CAPABILITY_SERVICE_LIMITS.maxRequestBytes) {
            rejectRequest(socket, "size_limit_exceeded", null);
          } else {
            const decoded = parseStrictJson(line.toString("utf8"));
            if (!decoded.ok) rejectRequest(socket, "invalid_request", null);
            else {
              const frame = asRecord(decoded.value);
              if (frame === undefined) rejectRequest(socket, "invalid_request", null);
              else if ("method" in frame) routeRequest(socket, frame);
              else routeResponse(frame);
            }
          }
          newline = buffered.indexOf(0x0a);
        }
        if (buffered.byteLength > 0 && partialFrameTimer === undefined && !socket.destroyed) {
          partialFrameTimer = deps.timers.setTimeout(() => {
            rejectRequest(socket, "deadline_exceeded", null);
            socket.destroy();
          }, deps.requestDeadlineMs);
          partialFrameTimer.unref();
        }
      });
      socket.once("close", () => {
        partialFrameTimer?.cancel();
        sockets.delete(socket);
        if (boundSocket === socket) {
          boundSocket = undefined;
          handshakeValue = undefined;
          failPending("connection_closed");
        }
      });
      socket.once("error", () => {
        if (boundSocket === socket) failPending("connection_failed");
      });
    }

    const server = net.createServer(accept);
    const listening = await fromPromise(new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen({ path: configured.instance.control.socketPath }, resolveListen);
    }));
    if (!listening.ok) return listening;
    const restricted = tryCatch(() => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- chmod targets only the just-bound confined socket
      chmodSync(configured.instance.control.socketPath, 0o600);
    });
    if (!restricted.ok) {
      await fromPromise(new Promise<void>((resolveClose) => server.close(() => resolveClose())));
      removeStaleSocket(configured.instance.control.socketPath);
      return err(restricted.error);
    }

    async function sendControl<T>(
      request: unknown,
      requestSchema: z.ZodType,
      responseSchema: z.ZodType,
    ): Promise<Result<T, WireFailure>> {
      const socket = boundSocket;
      if (closed || socket === undefined || socket.destroyed || handshakeValue === undefined) {
        return err({ kind: "unavailable", reasonCode: "service_not_connected", step: "request" });
      }
      if (pending.size >= CAPABILITY_SERVICE_LIMITS.maxInFlightRequests) {
        return err({ kind: "unavailable", reasonCode: "rate_limited", step: "request" });
      }
      const parsed = requestSchema.safeParse(request);
      if (!parsed.success) {
        return err({ kind: "rejected", reasonCode: "client_request_invalid", step: "request" });
      }
      const record = asRecord(parsed.data);
      if (record === undefined || typeof record["id"] !== "string") {
        return err({ kind: "rejected", reasonCode: "client_request_invalid", step: "request" });
      }
      const id = record["id"];
      if (pending.has(id)) {
        return err({ kind: "rejected", reasonCode: "operation_in_flight", step: "request" });
      }
      const credential = configured.credential();
      if (credential === undefined || credential.length === 0) {
        return err({ kind: "unavailable", reasonCode: "credential_unavailable", step: "request" });
      }
      const frame = { bearer: credential, ...record };
      const encoded = canonical(frame);
      if (!encoded.ok) {
        return err({ kind: "rejected", reasonCode: "client_request_invalid", step: "request" });
      }
      const framed = `${encoded.value}\n`;
      if (
        Buffer.byteLength(encoded.value, "utf8") > CAPABILITY_SERVICE_LIMITS.maxRequestBytes
        || Buffer.byteLength(framed, "utf8") > CAPABILITY_SERVICE_LIMITS.maxLineBytes
      ) {
        return err({ kind: "rejected", reasonCode: "size_limit_exceeded", step: "request" });
      }
      return new Promise((resolveControl) => {
        const timer = deps.timers.setTimeout(() => {
          finishPending(id, err({ kind: "uncertain", reasonCode: "deadline_exceeded", step: "response" }));
        }, deps.requestDeadlineMs);
        timer.unref();
        pending.set(id, { responseSchema, resolve: resolveControl as PendingControl["resolve"], timer });
        const written = tryCatch(() => socket.write(framed));
        if (!written.ok) {
          finishPending(id, err({ kind: "uncertain", reasonCode: "connection_failed", step: "response" }));
        }
      });
    }

    const handle: CapabilityServiceRuntimeHandle = {
      start: async () => {
        if (closed) return err(new Error("capability-service host endpoint is closed"));
        if (handshakeValue !== undefined) return ok(handshakeValue);
        if (handshakeWaiter !== undefined) {
          return err(new Error("capability-service handshake is already pending"));
        }
        return new Promise((resolveStart) => {
          const timer = deps.timers.setTimeout(() => {
            handshakeWaiter = undefined;
            resolveStart(err(new Error("capability-service handshake deadline elapsed")));
          }, deps.requestDeadlineMs);
          timer.unref();
          handshakeWaiter = { resolve: resolveStart, timer };
        });
      },
      close: async () => {
        if (closed) return ok(undefined);
        closed = true;
        unregister();
        if (handshakeWaiter !== undefined) {
          handshakeWaiter.timer.cancel();
          handshakeWaiter.resolve(err(new Error("capability-service host endpoint closed before handshake")));
          handshakeWaiter = undefined;
        }
        failPending("endpoint_closed");
        for (const socket of sockets) socket.pause();
        const drained = await fromPromise(Promise.all([...inboundOperations]).then(() => undefined));
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        const closedServer = await fromPromise(new Promise<void>((resolveClose, rejectClose) => {
          server.close((closeError) => closeError ? rejectClose(closeError) : resolveClose());
        }));
        const removedSocket = removeStaleSocket(configured.instance.control.socketPath);
        if (!drained.ok) return drained;
        if (!closedServer.ok) return closedServer;
        return removedSocket;
      },
    };

    return ok(Object.freeze({
      handle,
      activate: async (command: CapabilityServiceActivateCommand) => {
        const result = await sendControl<CapabilityServiceActivateAcknowledgement>({
          jsonrpc: "2.0",
          id: command.operationId,
          method: "managedRuns.activate",
          params: {
            operationId: command.operationId,
            managedRunId: command.managedRunId,
            externalRunRef: command.externalRunRef,
            registrationNonce: command.registrationNonce,
            ...(command.workspaceLeaseId === undefined ? {} : { workspaceLeaseId: command.workspaceLeaseId }),
            ...(command.executionAttachmentId === undefined ? {} : { executionAttachmentId: command.executionAttachmentId }),
            ...(command.attachmentTargetName === undefined ? {} : { attachmentTargetName: command.attachmentTargetName }),
          },
        }, CapabilityActivateRequestSchema, CapabilityActivateResponseSchema);
        return result.ok ? result : err({ kind: result.error.kind, reasonCode: result.error.reasonCode });
      },
      abandon: async (command: CapabilityServiceAbandonCommand) => {
        const result = await sendControl<CapabilityServiceAbandonAcknowledgement>({
          jsonrpc: "2.0",
          id: command.operationId,
          method: "managedRuns.abandon",
          params: {
            operationId: command.operationId,
            externalRunRef: command.externalRunRef,
            registrationNonce: command.registrationNonce,
            reason: command.reason,
            disposition: command.disposition,
          },
        }, CapabilityAbandonRequestSchema, CapabilityAbandonResponseSchema);
        return result.ok ? result : err({ kind: result.error.kind, reasonCode: result.error.reasonCode });
      },
      terminalEvent: async (command: CapabilityServiceTerminalEventCommand) => {
        return sendEndpointTerminalEvent(command, sendControl);
      },
    }));
  })();
}

/** Create the daemon-owned bidirectional Unix control host for configured services. */
export function createUnixCapabilityServiceHostRuntime(
  deps: UnixCapabilityServiceHostRuntimeDeps,
): Result<UnixCapabilityServiceHostRuntime, Error> {
  const rootCheck = verifySocketRoot(deps.socketRoot);
  if (!rootCheck.ok) return rootCheck;
  const definitions = new Map<string, PlannedCapabilityServiceDefinition>();
  for (const definition of deps.definitions) {
    if (definitions.has(definition.serviceDefinitionId)) {
      return err(new Error("capability-service host received duplicate definitions"));
    }
    definitions.set(definition.serviceDefinitionId, definition);
  }
  const configured = new Map<string, ConfiguredInstance>();
  for (const instance of deps.instances) {
    if (configured.has(instance.serviceInstanceId)) {
      return err(new Error("capability-service host received duplicate instances"));
    }
    const definition = definitions.get(instance.serviceDefinitionId);
    const credential = deps.credentials.get(instance.serviceInstanceId);
    if (definition === undefined || credential === undefined || !credential()) {
      return err(new Error(`capability-service host dependencies are unavailable for ${instance.serviceInstanceId}`));
    }
    configured.set(instance.serviceInstanceId, { definition, instance, credential });
  }
  const endpoints = new Map<string, Endpoint>();
  const activators = [...definitions.values()].map((definition): CapabilityServiceRuntimeActivator => ({
    serviceDefinitionId: definition.serviceDefinitionId,
    construct: async (instance) => {
      const target = configured.get(instance.serviceInstanceId);
      if (target === undefined || target.definition.serviceDefinitionId !== definition.serviceDefinitionId) {
        return err(new Error("capability-service host instance is not configured for this definition"));
      }
      if (endpoints.has(instance.serviceInstanceId)) {
        return err(new Error("capability-service host instance is already constructed"));
      }
      const endpointHolder: { current?: Endpoint } = {};
      const created = await createEndpoint(target, deps, () => {
        if (endpoints.get(instance.serviceInstanceId) === endpointHolder.current) {
          endpoints.delete(instance.serviceInstanceId);
        }
      });
      if (!created.ok) return created;
      endpointHolder.current = created.value;
      endpoints.set(instance.serviceInstanceId, created.value);
      return ok(created.value.handle);
    },
  }));

  function reportControlFailure(
    serviceInstanceId: string,
    operation: "abandon" | "activate" | "terminal_event",
    failure: CapabilityServiceControlFailure,
  ): void {
    deps.logger.warn({
      serviceInstanceId,
      operation,
      reasonCode: failure.reasonCode,
      errorKind: failure.kind === "rejected" ? "precondition" as const : "dependency" as const,
      hint: "Check the capabilityServices socket, exact bundle, and bound service instance before reconciling the operation",
    }, "Capability-service control request failed");
  }

  const control: CapabilityServiceControlPort = {
    activate: async (command) => {
      const endpoint = endpoints.get(command.serviceInstanceId);
      if (endpoint === undefined) {
        return err({ kind: "unavailable", reasonCode: "instance_not_connected" });
      }
      const startedAtMs = deps.clock.now();
      deps.logger.debug({
        serviceInstanceId: command.serviceInstanceId,
        managedRunId: command.managedRunId,
        step: "capability-service-activate",
      }, "Sending capability-service activation");
      const result = await endpoint.activate(command);
      if (!result.ok) reportControlFailure(command.serviceInstanceId, "activate", result.error);
      else deps.logger.info({
        serviceInstanceId: command.serviceInstanceId,
        managedRunId: command.managedRunId,
        durationMs: Math.max(0, deps.clock.now() - startedAtMs),
      }, "Capability-service activation call completed");
      return result;
    },
    abandon: async (command) => {
      const endpoint = endpoints.get(command.serviceInstanceId);
      if (endpoint === undefined) {
        return err({ kind: "unavailable", reasonCode: "instance_not_connected" });
      }
      const startedAtMs = deps.clock.now();
      deps.logger.debug({
        serviceInstanceId: command.serviceInstanceId,
        step: "capability-service-abandon",
      }, "Sending capability-service preparation abandon");
      const result = await endpoint.abandon(command);
      if (!result.ok) reportControlFailure(command.serviceInstanceId, "abandon", result.error);
      else deps.logger.info({
        serviceInstanceId: command.serviceInstanceId,
        durationMs: Math.max(0, deps.clock.now() - startedAtMs),
      }, "Capability-service abandon call completed");
      return result;
    },
    terminalEvent: async (command) => {
      return forwardTerminalEvent({ command, endpoint: endpoints.get(command.serviceInstanceId), clock: deps.clock, logger: deps.logger, onFailure: (failure) => reportControlFailure(command.serviceInstanceId, "terminal_event", failure) });
    },
  };

  return ok(Object.freeze({ activators: Object.freeze(activators), control: Object.freeze(control) }));
}
