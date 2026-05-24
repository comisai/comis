// SPDX-License-Identifier: Apache-2.0
/**
 * trace.metadata payload assembly (LIFE-01, design §5 D4).
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
  readonly prompting: {
    readonly systemPromptDigest?: string;
    readonly systemPromptByteLen?: number;
    readonly userPromptPrefixText?: string;
  };
  readonly redaction: { readonly policy: string };
}

export interface TraceMetadataPayload extends Record<string, unknown> {
  readonly harness: Record<string, unknown>;
  readonly model: Record<string, unknown>;
  readonly config: Record<string, unknown>;
  readonly plugins: TraceMetadataParams["plugins"];
  readonly skills: TraceMetadataParams["skills"];
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

export function buildTraceMetadata(params: TraceMetadataParams): TraceMetadataPayload {
  // sanitizeForPersistence returns an object-shaped value (or sentinel object) for object input.
  // Cast is safe — the recorder constructor's same cast at runtime.ts:171 documents this contract.
  const sanitizedConfig = sanitizeForPersistence(params.config) as Record<string, unknown>;
  return {
    harness: compactObject(params.harness as unknown as Record<string, unknown>),
    model: compactObject(params.model as unknown as Record<string, unknown>),
    config: sanitizedConfig,
    plugins: params.plugins,
    skills: params.skills,
    prompting: compactObject(params.prompting as unknown as Record<string, unknown>),
    redaction: { policy: params.redaction.policy },
  };
}
