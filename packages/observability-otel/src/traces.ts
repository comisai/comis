// SPDX-License-Identifier: Apache-2.0
/**
 * Per-turn / tool / graph span emission.
 *
 * Comis's `RequestContext.traceId` is a UUID, NOT an OTel 16-byte trace id:
 * the OTel SDK manages real trace/span ids; the Comis UUID rides as
 * the `comis.trace_id` span ATTRIBUTE (and as the Prometheus exemplar value
 * source where supported — it is not on 0.219.0). The drill-down keys on the
 * Comis `traceId` (what `obs.explain` accepts), not the OTel trace id.
 *
 * Content-free posture: the 3 GenAI content span attributes
 * (`gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions`)
 * are spec-`Opt-In` → OMITTED entirely unless `captureContent:true`. Even when
 * captured, Comis emits a CONTENT-FREE structural summary (message roles +
 * counts) — NEVER the raw message `content` body — and routes that summary
 * through `redactAttributes` (`sanitizeForPersistence` at the boundary) so a
 * planted secret in a stray field cannot reach an attribute. This is the honest
 * content-free realization: `captureContent` toggles the PRESENCE of the
 * structural attrs, not the egress of user content — the raw
 * body never leaves the daemon. The `genaiSemconv` flag selects the attribute
 * NAMESPACE (latest `gen_ai.provider.name` vs the pre-stable `gen_ai.system`).
 *
 * @module
 */
import type { Tracer } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import { redactAttributes } from "./redact-attributes.js";

/** A chat message a caller MAY pass; bodies are dropped unless captureContent + re-redacted. */
export interface SpanMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly [k: string]: unknown;
}

/** Arguments for {@link emitTurnSpan} — the per-turn GenAI span. */
export interface TurnSpanArgs {
  /** The Comis AsyncLocalStorage traceId (a UUID) — rides as the comis.trace_id attribute. */
  readonly comisTraceId?: string;
  /** The provider id (a config id — content-free). */
  readonly provider: string;
  /** The model id (a config id — content-free). */
  readonly model: string;
  /** The GenAI operation (e.g. "chat"). */
  readonly operation: string;
  /** Token counts (content-free). */
  readonly tokens: { prompt: number; completion: number; total: number };
  /** The turn duration in milliseconds. */
  readonly durationMs: number;
  /** Opt into the latest (pre-stable) GenAI semconv namespace. */
  readonly genaiSemconv?: boolean;
  /** Capture the 3 content attrs (spec Opt-In; re-redacted even when on). */
  readonly captureContent?: boolean;
  /** Input messages (bodies dropped unless captureContent; re-redacted). */
  readonly inputMessages?: readonly SpanMessage[];
  /** Output messages (bodies dropped unless captureContent; re-redacted). */
  readonly outputMessages?: readonly SpanMessage[];
  /** System instructions (dropped unless captureContent; re-redacted). */
  readonly systemInstructions?: unknown;
}

// GenAI semconv attribute names (resolved from @opentelemetry/semantic-conventions
// /incubating; inlined as the literal strings the spec defines so the production
// surface does not import the large incubating module at runtime).
const ATTR_GEN_AI_PROVIDER_NAME = "gen_ai.provider.name"; // latest
const ATTR_GEN_AI_SYSTEM = "gen_ai.system"; // pre-stable
const ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
const ATTR_GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
const ATTR_GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const ATTR_GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";
const ATTR_GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";
const ATTR_GEN_AI_SYSTEM_INSTRUCTIONS = "gen_ai.system_instructions";

/**
 * Build the content-free GenAI attribute bag for a turn span. The `genaiSemconv`
 * flag selects the provider-name namespace (latest vs pre-stable). NEVER includes
 * a message body — that is the separate captureContent path (re-redacted).
 */
function contentFreeGenAiAttrs(args: TurnSpanArgs): Record<string, string | number> {
  const providerKey = args.genaiSemconv ? ATTR_GEN_AI_PROVIDER_NAME : ATTR_GEN_AI_SYSTEM;
  return {
    [providerKey]: args.provider,
    [ATTR_GEN_AI_OPERATION_NAME]: args.operation,
    [ATTR_GEN_AI_REQUEST_MODEL]: args.model,
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: args.tokens.prompt,
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: args.tokens.completion,
  };
}

/** Keys whose values are raw user/model CONTENT — never emitted, even captured. */
const CONTENT_BODY_KEYS = new Set(["content", "text", "parts", "message", "body"]);

/**
 * Reduce a message list to a CONTENT-FREE structural summary: the role of each
 * message + the count. NEVER the `content` body. The summary is then routed
 * through `redactAttributes` so a planted secret in a stray non-content
 * field cannot survive, and serialised. Returns undefined when there is nothing
 * structural to emit.
 */
function contentFreeMessageSummary(messages: readonly SpanMessage[] | undefined): string | undefined {
  if (messages === undefined || messages.length === 0) return undefined;
  const roles = messages.map((m) => (typeof m.role === "string" ? m.role : "unknown"));
  // Strip every content-body key defensively before re-redaction (belt); the
  // summary carries roles + count only.
  const summary = redactAttributes({ count: messages.length, roles });
  // Guard: ensure no content-body key sneaks through (it never should).
  for (const key of CONTENT_BODY_KEYS) delete (summary as Record<string, unknown>)[key];
  return JSON.stringify(summary);
}

/**
 * System instructions are pure content → with captureContent we emit only the
 * content-free fact that they were present + their length, never the text. The
 * length sentinel is routed through redaction for uniformity.
 */
function systemInstructionSummary(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return JSON.stringify(redactAttributes({ present: true, length: str.length }));
}

/**
 * Emit a per-turn GenAI span. Sets `comis.trace_id` (the Comis UUID, as an
 * attribute), the content-free GenAI attrs, and — ONLY when `captureContent` —
 * the 3 content attrs re-redacted through {@link redactAttributes}.
 */
export function emitTurnSpan(tracer: Tracer, args: TurnSpanArgs): void {
  const span = tracer.startSpan(`${args.operation} ${args.model}`);
  // The Comis UUID as an attribute (NOT the OTel trace id).
  if (args.comisTraceId !== undefined) {
    span.setAttribute("comis.trace_id", args.comisTraceId);
  }
  // Content-free GenAI metadata.
  for (const [k, v] of Object.entries(contentFreeGenAiAttrs(args))) {
    span.setAttribute(k, v);
  }
  span.setAttribute("comis.duration_ms", args.durationMs);

  // The 3 content attrs — spec Opt-In; OMITTED unless captureContent. Even when
  // captured, Comis emits a CONTENT-FREE structural summary (roles + counts),
  // never the raw body, re-redacted at the boundary. A planted secret or a
  // message body cannot reach an attribute.
  if (args.captureContent === true) {
    const input = contentFreeMessageSummary(args.inputMessages);
    if (input !== undefined) span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, input);
    const output = contentFreeMessageSummary(args.outputMessages);
    if (output !== undefined) span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, output);
    const sys = systemInstructionSummary(args.systemInstructions);
    if (sys !== undefined) span.setAttribute(ATTR_GEN_AI_SYSTEM_INSTRUCTIONS, sys);
  }

  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}
