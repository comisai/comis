// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import net from "node:net";
import type { z } from "zod";
import {
  CAPABILITY_SERVICE_LIMITS,
  CAPABILITY_SERVICE_PROTOCOL_ID,
  CapabilityAbandonRequestSchema,
  CapabilityAbandonResponseSchema,
  CapabilityActivateRequestSchema,
  CapabilityActivateResponseSchema,
  CapabilityHandshakeRequestSchema,
  CapabilityHandshakeResponseSchema,
  CapabilityServiceErrorResponseSchema,
  type CapabilityServiceErrorKind,
} from "@comis/capability-service-sdk";
import {
  type CapabilityServiceControlFailure,
  type CapabilityServiceControlPort,
  type ComisLogger,
  type PlannedCapabilityServiceDefinition,
  type PlannedCapabilityServiceInstance,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import {
  type CapabilityServiceRuntimeActivator,
  type CapabilityServiceRuntimeHandle,
} from "./capability-service-runtime.js";
import { parseStrictJson } from "./capability-service-strict-json.js";

interface ConfiguredInstance {
  readonly instance: PlannedCapabilityServiceInstance;
  readonly credential: string;
}

interface WireFailure extends CapabilityServiceControlFailure {
  readonly step: "connect" | "request" | "response";
}

export interface UnixCapabilityServiceClientRuntime {
  readonly activators: readonly CapabilityServiceRuntimeActivator[];
  readonly control: CapabilityServiceControlPort;
}

export interface UnixCapabilityServiceClientRuntimeDeps {
  readonly definitions: readonly PlannedCapabilityServiceDefinition[];
  readonly instances: readonly PlannedCapabilityServiceInstance[];
  readonly credentials: ReadonlyMap<string, string>;
  readonly bundleDigest: string;
  readonly requestDeadlineMs: number;
  readonly nowMs: () => number;
  readonly logger: ComisLogger;
}

type ResponseEnvelope<T> = {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result: T;
};

function operationId(kind: "handshake", serviceInstanceId: string): string {
  const identity = createHash("sha256").update(serviceInstanceId, "utf8").digest("hex");
  return `${kind}-${identity.slice(0, 32)}`;
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

function asWireFailure(
  kind: CapabilityServiceControlFailure["kind"],
  reasonCode: string,
  step: WireFailure["step"],
): WireFailure {
  return { kind, reasonCode, step };
}

async function callUnix<T>(
  configured: ConfiguredInstance,
  request: unknown,
  requestSchema: z.ZodType,
  responseSchema: z.ZodType<ResponseEnvelope<T>>,
  deadlineMs: number,
): Promise<Result<T, WireFailure>> {
  const requestParsed = requestSchema.safeParse(request);
  if (!requestParsed.success) {
    return err(asWireFailure("rejected", "client_request_invalid", "request"));
  }
  if (
    typeof requestParsed.data !== "object"
    || requestParsed.data === null
    || !("id" in requestParsed.data)
    || typeof requestParsed.data.id !== "string"
  ) {
    return err(asWireFailure("rejected", "client_request_invalid", "request"));
  }
  const requestData = requestParsed.data;
  const frame = { bearer: configured.credential, ...requestData };
  const serialized = tryCatch(() => `${JSON.stringify(frame)}\n`);
  if (!serialized.ok) {
    return err(asWireFailure("rejected", "client_request_invalid", "request"));
  }
  const encodedBytes = Buffer.byteLength(serialized.value, "utf8");
  if (
    encodedBytes > CAPABILITY_SERVICE_LIMITS.maxLineBytes
    || encodedBytes - 1 > CAPABILITY_SERVICE_LIMITS.maxRequestBytes
  ) {
    return err(asWireFailure("rejected", "size_limit_exceeded", "request"));
  }
  const socketResult = tryCatch(() => net.createConnection(configured.instance.control.socketPath));
  if (!socketResult.ok) {
    return err(asWireFailure("unavailable", "connection_failed", "connect"));
  }
  const socket = socketResult.value;
  return new Promise((resolveResult) => {
    let settled = false;
    let requestWritten = false;
    let buffer = Buffer.alloc(0);

    const finish = (result: Result<T, WireFailure>): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveResult(result);
    };
    socket.setTimeout(deadlineMs);
    socket.once("connect", () => {
      requestWritten = true;
      socket.write(serialized.value);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > CAPABILITY_SERVICE_LIMITS.maxLineBytes) {
        finish(err(asWireFailure("uncertain", "size_limit_exceeded", "response")));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (buffer.subarray(newline + 1).some((byte) => byte > 0x20)) {
        finish(err(asWireFailure("uncertain", "multiple_responses", "response")));
        return;
      }
      const text = buffer.subarray(0, newline).toString("utf8");
      const decoded = parseStrictJson(text);
      if (!decoded.ok) {
        finish(err(asWireFailure("uncertain", "invalid_response", "response")));
        return;
      }
      const remoteError = CapabilityServiceErrorResponseSchema.safeParse(decoded.value);
      if (remoteError.success) {
        finish(err(asWireFailure(
          failureKind(remoteError.data.error.kind),
          remoteError.data.error.kind,
          "response",
        )));
        return;
      }
      const response = responseSchema.safeParse(decoded.value);
      if (!response.success || response.data.id !== requestData.id) {
        finish(err(asWireFailure("uncertain", "invalid_response", "response")));
        return;
      }
      finish(ok(response.data.result));
    });
    socket.once("timeout", () => finish(err(asWireFailure(
      requestWritten ? "uncertain" : "unavailable",
      "deadline_exceeded",
      requestWritten ? "response" : "connect",
    ))));
    socket.once("error", () => finish(err(asWireFailure(
      requestWritten ? "uncertain" : "unavailable",
      "connection_failed",
      requestWritten ? "response" : "connect",
    ))));
    socket.once("end", () => {
      if (!settled) finish(err(asWireFailure(
        requestWritten ? "uncertain" : "unavailable",
        "connection_closed",
        requestWritten ? "response" : "connect",
      )));
    });
  });
}

function reportFailure(
  deps: UnixCapabilityServiceClientRuntimeDeps,
  serviceInstanceId: string,
  failure: WireFailure,
  operation: "abandon" | "activate" | "handshake",
): void {
  deps.logger.warn({
    serviceInstanceId,
    operation,
    step: failure.step,
    reasonCode: failure.reasonCode,
    errorKind: failure.kind === "rejected" ? "precondition" as const : "dependency" as const,
    hint: "Check the capabilityServices instance socket, credential reference, and exact protocol bundle before retrying",
  }, "Capability-service Unix request failed");
}

/** Create exact-protocol runtime activators and instance-scoped control routing. */
export function createUnixCapabilityServiceClientRuntime(
  deps: UnixCapabilityServiceClientRuntimeDeps,
): Result<UnixCapabilityServiceClientRuntime, Error> {
  const definitions = new Map<string, PlannedCapabilityServiceDefinition>();
  for (const definition of deps.definitions) {
    if (definitions.has(definition.serviceDefinitionId)) {
      return err(new Error("capability-service client received duplicate definitions"));
    }
    definitions.set(definition.serviceDefinitionId, definition);
  }
  const instances = new Map<string, ConfiguredInstance>();
  for (const instance of deps.instances) {
    if (instances.has(instance.serviceInstanceId)) {
      return err(new Error("capability-service client received duplicate instances"));
    }
    const credential = deps.credentials.get(instance.serviceInstanceId);
    if (credential === undefined || credential.length === 0) {
      return err(new Error(`capability-service credential is unavailable for ${instance.serviceInstanceId}`));
    }
    instances.set(instance.serviceInstanceId, { instance, credential });
  }

  const activators = [...definitions.values()].map((definition): CapabilityServiceRuntimeActivator => ({
    serviceDefinitionId: definition.serviceDefinitionId,
    construct: async (instance) => {
      const configured = instances.get(instance.serviceInstanceId);
      if (
        configured === undefined
        || configured.instance.serviceDefinitionId !== definition.serviceDefinitionId
      ) {
        return err(new Error("capability-service runtime instance is not configured for this definition"));
      }
      let closed = false;
      const handle: CapabilityServiceRuntimeHandle = {
        start: async () => {
          if (closed) return err(new Error("capability-service runtime handle is closed"));
          const startedAtMs = deps.nowMs();
          const id = operationId("handshake", instance.serviceInstanceId);
          deps.logger.debug({
            serviceInstanceId: instance.serviceInstanceId,
            step: "capability-service-handshake",
          }, "Starting capability-service handshake");
          const handshake = await callUnix(
            configured,
            {
              jsonrpc: "2.0",
              id,
              method: "capabilityServices.handshake",
              params: {
                protocolId: CAPABILITY_SERVICE_PROTOCOL_ID,
                bundleDigest: deps.bundleDigest,
                operationId: id,
                serviceInstanceId: instance.serviceInstanceId,
                requestedScopes: definition.requestedScopes,
              },
            },
            CapabilityHandshakeRequestSchema,
            CapabilityHandshakeResponseSchema,
            deps.requestDeadlineMs,
          );
          if (!handshake.ok) {
            reportFailure(deps, instance.serviceInstanceId, handshake.error, "handshake");
            return err(new Error(`capability-service handshake failed: ${handshake.error.reasonCode}`));
          }
          if (
            handshake.value.protocolId !== CAPABILITY_SERVICE_PROTOCOL_ID
            || handshake.value.bundleDigest !== deps.bundleDigest
            || handshake.value.serviceInstanceId !== instance.serviceInstanceId
          ) {
            return err(new Error("capability-service handshake identity did not match configuration"));
          }
          deps.logger.info({
            serviceInstanceId: instance.serviceInstanceId,
            durationMs: Math.max(0, deps.nowMs() - startedAtMs),
          }, "Capability-service handshake completed");
          return ok({
            protocolId: handshake.value.protocolId,
            serviceInstanceId: handshake.value.serviceInstanceId,
            activeScopes: Object.freeze([...handshake.value.activeScopes]),
          });
        },
        close: async () => {
          closed = true;
          return ok(undefined);
        },
      };
      return ok(handle);
    },
  }));

  const control: CapabilityServiceControlPort = {
    activate: async (command) => {
      const configured = instances.get(command.serviceInstanceId);
      if (configured === undefined) {
        return err({ kind: "unavailable", reasonCode: "instance_not_configured" });
      }
      const startedAtMs = deps.nowMs();
      deps.logger.debug({
        serviceInstanceId: command.serviceInstanceId,
        managedRunId: command.managedRunId,
        step: "capability-service-activate",
      }, "Sending capability-service activation");
      const activated = await callUnix(
        configured,
        {
          jsonrpc: "2.0",
          id: command.operationId,
          method: "managedRuns.activate",
          params: {
            operationId: command.operationId,
            managedRunId: command.managedRunId,
            externalRunRef: command.externalRunRef,
            registrationNonce: command.registrationNonce,
          },
        },
        CapabilityActivateRequestSchema,
        CapabilityActivateResponseSchema,
        deps.requestDeadlineMs,
      );
      if (!activated.ok) {
        reportFailure(deps, command.serviceInstanceId, activated.error, "activate");
        return err({ kind: activated.error.kind, reasonCode: activated.error.reasonCode });
      }
      deps.logger.info({
        serviceInstanceId: command.serviceInstanceId,
        managedRunId: command.managedRunId,
        durationMs: Math.max(0, deps.nowMs() - startedAtMs),
      }, "Capability-service activation call completed");
      return activated;
    },
    abandon: async (command) => {
      const configured = instances.get(command.serviceInstanceId);
      if (configured === undefined) {
        return err({ kind: "unavailable", reasonCode: "instance_not_configured" });
      }
      const startedAtMs = deps.nowMs();
      deps.logger.debug({
        serviceInstanceId: command.serviceInstanceId,
        step: "capability-service-abandon",
      }, "Sending capability-service preparation abandon");
      const abandoned = await callUnix(
        configured,
        {
          jsonrpc: "2.0",
          id: command.operationId,
          method: "managedRuns.abandon",
          params: {
            operationId: command.operationId,
            externalRunRef: command.externalRunRef,
            registrationNonce: command.registrationNonce,
            reason: command.reason,
          },
        },
        CapabilityAbandonRequestSchema,
        CapabilityAbandonResponseSchema,
        deps.requestDeadlineMs,
      );
      if (!abandoned.ok) {
        reportFailure(deps, command.serviceInstanceId, abandoned.error, "abandon");
        return err({ kind: abandoned.error.kind, reasonCode: abandoned.error.reasonCode });
      }
      deps.logger.info({
        serviceInstanceId: command.serviceInstanceId,
        durationMs: Math.max(0, deps.nowMs() - startedAtMs),
      }, "Capability-service abandon call completed");
      return abandoned;
    },
  };

  return ok(Object.freeze({
    activators: Object.freeze(activators),
    control: Object.freeze(control),
  }));
}
