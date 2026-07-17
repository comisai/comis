// SPDX-License-Identifier: Apache-2.0
/** Authoritative channel classification for otherwise-unparsed session records. */

import { readRegularFile } from "@comis/observability";
import { tryCatch } from "@comis/shared";

const MAX_POINTER_BYTES = 64 * 1024;
const MAX_TRAJECTORY_BYTES = 16 * 1024 * 1024;

export interface SessionMessageChannelClassification {
  classification: "authoritative" | "inferred" | "unresolved";
  channelType?: string;
  source: "trajectory_pointer" | "session_records" | "none";
}

export interface SessionMessageChannelReadPolicy {
  /** The trusted Comis data root containing the session and pointer files. */
  dataDir: string;
  /** Operator-configured root for relocated trajectory files. */
  trajectoryDir?: string;
}

/** Parse one JSON object without allowing arrays or primitives. */
function decodeObject(text: string): Record<string, unknown> | undefined {
  const decoded = tryCatch(() => JSON.parse(text) as unknown);
  if (
    !decoded.ok || decoded.value === null || typeof decoded.value !== "object" ||
    Array.isArray(decoded.value)
  ) return undefined;
  return decoded.value as Record<string, unknown>;
}

/**
 * Follow the co-located, fence-checked trajectory pointer and accept a unique
 * session.started channel declaration for the exact formatted session key.
 */
export function classifySessionChannelFromTrajectory(
  sessionFile: string,
  formattedSessionKey: string,
  expectedChannelId: string,
  policy: SessionMessageChannelReadPolicy,
): SessionMessageChannelClassification {
  const pointerRead = readRegularFile({
    path: `${sessionFile}.trajectory-path.json`,
    maxFileBytes: MAX_POINTER_BYTES,
    confinedBaseDir: policy.dataDir,
  });
  if (!pointerRead.ok) return { classification: "unresolved", source: "none" };
  const pointer = decodeObject(pointerRead.value.content.toString("utf8"));
  if (
    pointer?.["traceSchema"] !== "comis-trajectory-pointer" ||
    pointer["schemaVersion"] !== 1 ||
    pointer["sessionId"] !== formattedSessionKey ||
    typeof pointer["runtimeFile"] !== "string" ||
    pointer["runtimeFile"].length === 0
  ) return { classification: "unresolved", source: "none" };

  const permittedRoots = policy.trajectoryDir === undefined
    ? [policy.dataDir]
    : [policy.dataDir, policy.trajectoryDir];
  let trajectoryRead: ReturnType<typeof readRegularFile> | undefined;
  for (const confinedBaseDir of permittedRoots) {
    const attempt = readRegularFile({
      path: pointer["runtimeFile"],
      maxFileBytes: MAX_TRAJECTORY_BYTES,
      confinedBaseDir,
    });
    if (attempt.ok) {
      trajectoryRead = attempt;
      break;
    }
  }
  if (trajectoryRead === undefined || !trajectoryRead.ok) {
    return { classification: "unresolved", source: "none" };
  }

  const channelTypes = new Set<string>();
  for (const line of trajectoryRead.value.content.toString("utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const record = decodeObject(line);
    if (
      record?.["traceSchema"] !== "comis-trajectory" ||
      record["schemaVersion"] !== 1 ||
      record["type"] !== "session.started" ||
      record["sessionId"] !== formattedSessionKey
    ) continue;
    const data = record["data"];
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { classification: "unresolved", source: "none" };
    }
    const channelType = (data as Record<string, unknown>)["channelType"];
    const channelId = (data as Record<string, unknown>)["channelId"];
    if (
      typeof channelType !== "string" || channelType.length === 0 ||
      channelId !== expectedChannelId
    ) return { classification: "unresolved", source: "none" };
    channelTypes.add(channelType);
  }
  if (channelTypes.size !== 1) return { classification: "unresolved", source: "none" };
  return {
    classification: "authoritative",
    channelType: [...channelTypes][0]!,
    source: "trajectory_pointer",
  };
}

/** Session-record inference is explicit and never derived from path names. */
export function inferSessionChannel(
  channelTypes: ReadonlySet<string>,
): SessionMessageChannelClassification {
  if (channelTypes.size !== 1) return { classification: "unresolved", source: "none" };
  return {
    classification: "inferred",
    channelType: [...channelTypes][0]!,
    source: "session_records",
  };
}
