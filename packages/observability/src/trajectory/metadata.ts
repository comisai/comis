// SPDX-License-Identifier: Apache-2.0
/**
 * trace.metadata payload assembly.
 *
 * Emitted once per session, immediately after session.started, by the
 * agent executor's bus bridge (packages/agent/src/bridge/pi-event-bridge.ts).
 * Direct emit — see DIRECT_EMIT_TRAJECTORY_TYPES in
 * test/architecture/trajectory-event-types-known.test.ts.
 *
 * The config field runs through sanitizeForPersistence — operators
 * never see apiKey/token/secret fields in the trajectory.
 *
 * @module
 */
import { sanitizeForPersistence } from "../redact/redact-secrets.js";
import { PAYLOAD_BOUNDS } from "../shared/bounded-payload.js";

export interface TraceMetadataParams {
  readonly harness: {
    readonly type: "comis";
    readonly version: string;
    readonly gitSha?: string;
    readonly os: string;
    readonly node: string;
    readonly instanceId?: string;
    readonly workspaceDir?: string;
  };
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
    readonly modelApi?: string | null;
    readonly fastMode?: boolean;
    readonly thinkLevel?: string;
  };
  readonly config: unknown; // raw — sanitized inside buildTraceMetadata
  readonly plugins: ReadonlyArray<{ readonly name: string; readonly version?: string }>;
  readonly skills: ReadonlyArray<{ readonly id: string; readonly version?: string }>;
  readonly toolInventory?: {
    /** Names assembled by the runtime before provider-specific deferral. */
    readonly names: ReadonlyArray<string>;
  };
  readonly prompting: {
    readonly systemPromptDigest?: string;
    readonly systemPromptByteLen?: number;
    readonly userPromptPrefixText?: string;
  };
  readonly redaction: { readonly policy: string };
}

export interface TraceMetadataInventory<T> {
  /** Total unique entries before the persistence-safe capture cap. */
  readonly count: number;
  /** Deterministic chunks; both the outer and inner arrays stay within the canonical array bound. */
  readonly chunks: ReadonlyArray<ReadonlyArray<T>>;
  /** True only when more entries existed than the chunk grid can retain. */
  readonly truncated: boolean;
}

export interface TraceMetadataPayload extends Record<string, unknown> {
  readonly harness: Record<string, unknown>;
  readonly model: Record<string, unknown>;
  readonly config: Record<string, unknown>;
  readonly plugins: TraceMetadataInventory<TraceMetadataParams["plugins"][number]>;
  readonly skills: TraceMetadataInventory<TraceMetadataParams["skills"][number]>;
  readonly toolInventory?: TraceMetadataInventory<string>;
  readonly prompting: Record<string, unknown>;
  readonly redaction: { policy: string };
}

/** Compact subobject — omits undefined keys so JSONL has no noise. */
function compactObject<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function buildInventory<T>(
  entries: ReadonlyArray<T>,
  keyOf: (entry: T) => string,
): TraceMetadataInventory<T> {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!byKey.has(key)) byKey.set(key, entry);
  }

  const sorted = [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
  const chunkSize = PAYLOAD_BOUNDS.maxArrayLength;
  const captureLimit = chunkSize * PAYLOAD_BOUNDS.maxArrayLength;
  const captured = sorted.slice(0, captureLimit);
  const chunks: T[][] = [];
  for (let offset = 0; offset < captured.length; offset += chunkSize) {
    chunks.push(captured.slice(offset, offset + chunkSize));
  }

  return {
    count: sorted.length,
    chunks,
    truncated: sorted.length > captureLimit,
  };
}

export function buildTraceMetadata(params: TraceMetadataParams): TraceMetadataPayload {
  // sanitizeForPersistence returns an object-shaped value (or sentinel object) for object input.
  // Cast is safe — the recorder constructor's same cast at runtime.ts:171 documents this contract.
  const sanitizedConfig = sanitizeForPersistence(params.config) as Record<string, unknown>;
  return {
    harness: compactObject(params.harness as unknown as Record<string, unknown>),
    model: compactObject(params.model as unknown as Record<string, unknown>),
    config: sanitizedConfig,
    plugins: buildInventory(
      params.plugins,
      (plugin) => `${plugin.name}\u0000${plugin.version ?? ""}`,
    ),
    skills: buildInventory(
      params.skills,
      (skill) => `${skill.id}\u0000${skill.version ?? ""}`,
    ),
    ...(params.toolInventory !== undefined
      ? {
          toolInventory: buildInventory(
            params.toolInventory.names,
            (name) => name,
          ),
        }
      : {}),
    prompting: compactObject(params.prompting as unknown as Record<string, unknown>),
    redaction: { policy: params.redaction.policy },
  };
}
