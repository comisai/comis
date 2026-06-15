// SPDX-License-Identifier: Apache-2.0
/**
 * The VIS-01 keystone: the daemon-side provider-following VISION bridge.
 *
 * {@link createMainProviderVision} builds a `describeImage(buffer, prompt,
 * mimeType, agentId)` seam that routes image analysis through the agent's MAIN
 * vision-capable model via the pi-ai completion primitive, reusing the main
 * provider's credentials (no separate vision key — I7).
 *
 * It is a near-verbatim mirror of `createDialecticSeam`
 * (packages/agent/src/memory/memory-dialectic-seam.ts) — the ONE allowed
 * query-time `completeSimple` seam — with THREE deltas:
 *   1. the agent's MAIN model (resolved per-agentId via the injected
 *      `resolveModel`), NOT the cheap cron model;
 *   2. a multimodal `[TextContent, ImageContent]` user message (the seam uses a
 *      bare-string user message; pi-ai's `UserMessage.content` accepts
 *      `string | (TextContent | ImageContent)[]` — VERIFIED pi-ai
 *      types.d.ts:194, ImageContent:165-169);
 *   3. it returns a `Result<VisionResult & { costUsd? }, VisionUnavailable>`
 *      rather than abstaining — every failure branch is an honest `err`
 *      carrying an {@link ImageErrorKind}, NEVER a throw-out and NEVER a
 *      misroute to a different provider.
 *
 * Why daemon-hosted: `completeSimple`/`getModel` are already a daemon dependency
 * (graph-coordinator.ts:16, setup-channels-media.ts:35) and the bridge sits next
 * to the handler wiring + the cred closures. Do NOT host it in `@comis/agent`;
 * do NOT add `@earendil-works/pi-ai` to `@comis/skills` (the 183 pitfall).
 *
 * Security posture (the same discipline as the memory seams + 186 T-186-08):
 * - ONE bounded `completeSimple` per call — `maxTokens` (the cost cap) + an
 *   `AbortController` armed by the sanctioned-root `systemSetTimeout` (the
 *   wall-clock-free abort; the injected `clock` supplies the message timestamp).
 * - The resolved `apiKey` rides `SimpleStreamOptions.apiKey` ONLY — never
 *   interpolated into a string, a URL, a log, or the trajectory (T-187-01).
 * - CONTENT-FREE logging (T-187-02): a failure warns `{ agentId, errorKind,
 *   hint }` and NOTHING ELSE — the `buffer`, the base64, the `prompt`, the
 *   `content[]`, and the `response` text are NEVER in the log fields. Pino's
 *   `apiKey`/`token`/`authorization` redaction is the backstop, not the
 *   primary control.
 * - HONEST capability (T-187-03): a missing key, a model-resolution failure, or
 *   a non-"stop" completion returns `err` — the bridge never silently bills a
 *   different provider.
 *
 * @module
 */

import { systemSetTimeout, systemClearTimeout, IMAGE_ERR_TO_LOG } from "@comis/core";
import type { ClockPort, ComisLogger, ImageErrorKind, VisionResult } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { completeSimple, getModel } from "@earendil-works/pi-ai";

/** Hard abort ceiling per vision call (mirrors the memory-seam LLM timeout). */
const LLM_TIMEOUT_MS = 120_000;

/** Default per-call output bound — a description is short; this caps cost/latency. */
const DEFAULT_MAX_TOKENS = 1024;

/**
 * An honest-unavailable vision error. Carries a domain {@link ImageErrorKind}
 * (reused, not invented) so the Plan 02 handler can read `errorKind` off the
 * `err` and emit the VIS-04 obs. The hint (the `Error.message`) names the
 * actionable knob; it never carries image bytes or the prompt.
 */
export class VisionUnavailable extends Error {
  readonly errorKind: ImageErrorKind;
  constructor(errorKind: ImageErrorKind, hint: string) {
    super(hint);
    this.name = "VisionUnavailable";
    this.errorKind = errorKind;
  }
}

/** A successful vision result + the optional cost axis (VIS-04). */
export type MainProviderVisionResult = VisionResult & { costUsd?: number };

/** The deps the daemon injects (the model resolver + the cred closures, by value). */
export interface MainProviderVisionDeps {
  /**
   * The I4 lockstep resolver — maps an agentId to its resolved main
   * `{ provider, modelId }`. In Plan 02's wiring this is
   * `resolveAgentModel(cfgFor(agentId), config.models)`. Injected so the bridge
   * stays daemon-testable without the full config.
   */
  resolveModel: (agentId: string) => { provider: string; modelId: string };
  /**
   * Resolve the vision API key by PROVIDER (NOT by imagesApi — vision keys are
   * `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GOOGLE_API_KEY`). The daemon supplies
   * the SecretManager-backed closure. Returns undefined for an unknown /
   * key-less provider.
   */
  resolveApiKey: (provider: string) => string | undefined;
  /**
   * For provider `"openai-codex"`: resolve the bearer via
   * `oauthManager.getApiKey("openai-codex", { oauthProfiles })` (184 precedent),
   * unwrapped to `string | undefined`. Injected, optional.
   */
  resolveCodexKey?: (provider: string) => Promise<string | undefined>;
  /** Wall-clock reads — the per-message timestamp. NEVER a wall-clock global. */
  clock: ClockPort;
  /** Counts/ids-only logger (failures carry a hint + errorKind, never bodies). */
  logger: ComisLogger;
  /** Per-call output bound (the cost axis). Defaults to {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number;
  /** Hard abort ceiling. Defaults to {@link LLM_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The bridge handle the handler consumes. */
export interface MainProviderVision {
  describeImage(
    buffer: Buffer,
    prompt: string,
    mimeType: string,
    agentId: string,
  ): Promise<Result<MainProviderVisionResult, VisionUnavailable>>;
}

/**
 * Pull the concatenated text parts out of a pi-ai completeSimple response.
 * Copied VERBATIM from createDialecticSeam (memory-dialectic-seam.ts:77-94) —
 * the standard content-block walk.
 */
function extractResponseText(response: { content?: unknown[] }): string {
  let text = "";
  if (response.content && Array.isArray(response.content)) {
    for (const part of response.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as Record<string, unknown>).type === "text" &&
        "text" in part
      ) {
        text += (part as Record<string, unknown>).text;
      }
    }
  }
  return text;
}

/**
 * Map a non-"stop" stopReason onto a domain {@link ImageErrorKind}. pi-ai's
 * `StopReason` union is `"stop" | "length" | "toolUse" | "error" | "aborted"`
 * (VERIFIED types.d.ts:191) — there is no `content_filter` member, but a
 * content-safety refusal surfaced via a non-standard reason maps to
 * `content_blocked`; everything else non-stop is an `empty_response`.
 */
function classifyStopReason(stopReason: string): ImageErrorKind {
  if (stopReason === "content_filter" || stopReason === "content_blocked") {
    return "content_blocked";
  }
  return "empty_response";
}

/**
 * Build the provider-following VISION bridge from the daemon-injected deps.
 *
 * Returns `{ describeImage }`: it resolves the agent's main `{ provider,
 * modelId }`, resolves the key (the provider key OR the codex bearer), resolves
 * the model via the COPIED `getModel` try/catch guard, then issues ONE bounded
 * `completeSimple` with a multimodal `[text, image]` user message. A missing
 * key, a model-resolution failure, a thrown/aborted call, or a non-"stop"
 * completion returns an honest `err(VisionUnavailable)` — the bridge never
 * throws out and never misroutes.
 */
export function createMainProviderVision(deps: MainProviderVisionDeps): MainProviderVision {
  const { resolveModel, resolveApiKey, resolveCodexKey, clock, logger } = deps;
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = deps.timeoutMs ?? LLM_TIMEOUT_MS;

  async function describeImage(
    buffer: Buffer,
    prompt: string,
    mimeType: string,
    agentId: string,
  ): Promise<Result<MainProviderVisionResult, VisionUnavailable>> {
    const { provider, modelId } = resolveModel(agentId);

    // 1. Resolve the key — reuse the main provider's creds (I7). The provider
    //    key first; the codex bearer for "openai-codex" (184 precedent).
    let apiKey = resolveApiKey(provider);
    if (!apiKey && provider === "openai-codex" && resolveCodexKey) {
      apiKey = await resolveCodexKey(provider);
    }
    if (!apiKey) {
      return err(
        new VisionUnavailable(
          "auth_required",
          provider === "openai-codex"
            ? `No credentials for main provider "openai-codex". Run \`comis mcp login\` / the codex OAuth flow.`
            : `No vision credentials for main provider "${provider}". Set the provider's API key (e.g. OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY).`,
        ),
      );
    }

    // 2. Resolve the model — the COPIED non-fatal guard (memory-dialectic-seam.ts:120-149),
    //    but the failure posture is `err` (honest-unavailable), not abstain.
    let model;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider/modelId are dynamic strings
      model = getModel(provider as any, modelId as any);
    } catch (modelErr) {
      logger.warn(
        {
          agentId,
          err: modelErr,
          errorKind: "dependency" as const,
          step: "vision" as const,
          hint: `could not resolve model ${provider}/${modelId}`,
        },
        "Main-provider vision model resolution failed",
      );
      return err(
        new VisionUnavailable(
          "unsupported_provider",
          `Could not resolve main model "${provider}/${modelId}" for vision.`,
        ),
      );
    }
    if (!model) {
      logger.warn(
        {
          agentId,
          errorKind: "dependency" as const,
          step: "vision" as const,
          hint: `model not found ${provider}/${modelId}`,
        },
        "Main-provider vision model not found",
      );
      return err(
        new VisionUnavailable(
          "unsupported_provider",
          `Main model "${provider}/${modelId}" not found for vision.`,
        ),
      );
    }

    // 3. ONE bounded completeSimple with the MULTIMODAL message (the keystone).
    const controller = new AbortController();
    // WR-02: track whether OUR timer was the abort trigger. pi-ai's completeSimple
    // RESOLVES (does not reject) on the abort event — the AssistantMessage then
    // carries stopReason:"aborted" and hits the non-"stop" branch below rather
    // than the catch. `timedOut` lets that branch classify a genuine wall-clock
    // timeout as `timeout` instead of mis-reading "aborted" as `empty_response`.
    // The bridge's own AbortController is the ONLY abort trigger on this path.
    let timedOut = false;
    const timer = systemSetTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await completeSimple(
        model,
        {
          messages: [
            {
              role: "user" as const,
              timestamp: clock.now(),
              content: [
                { type: "text", text: prompt },
                { type: "image", data: buffer.toString("base64"), mimeType },
              ],
            },
          ],
        },
        { apiKey, maxTokens, signal: controller.signal },
      );

      if (response.stopReason !== "stop") {
        // WR-02: a resolved-with-"aborted" stream means our timer fired (the
        // ONLY abort trigger on this path) — classify it as a timeout, not the
        // generic empty_response classifyStopReason would otherwise return.
        const abortedByTimeout =
          response.stopReason === "aborted" && (timedOut || controller.signal.aborted);
        const errorKind: ImageErrorKind = abortedByTimeout
          ? "timeout"
          : classifyStopReason(response.stopReason);
        logger.warn(
          {
            agentId,
            errorKind: IMAGE_ERR_TO_LOG[errorKind],
            imageErrorKind: errorKind,
            step: "vision" as const,
            stopReason: response.stopReason,
            hint: abortedByTimeout
              ? "vision completion timed out"
              : `vision completion ended with stopReason "${response.stopReason}"`,
          },
          "Main-provider vision completion did not finish cleanly",
        );
        return err(
          new VisionUnavailable(
            errorKind,
            abortedByTimeout
              ? "Vision completion timed out."
              : `Vision completion ended with stopReason "${response.stopReason}".`,
          ),
        );
      }

      return ok({
        text: extractResponseText(response),
        provider: response.provider,
        model: response.model,
        tokensUsed: response.usage?.totalTokens,
        costUsd: response.usage?.cost?.total,
      });
    } catch (llmErr) {
      // WR-02: prefer the explicit timedOut flag (our timer fired) and keep
      // controller.signal.aborted as the fallback — both indicate the bridge's
      // own abort, the only abort trigger on this path.
      const aborted = timedOut || controller.signal.aborted;
      logger.warn(
        {
          agentId,
          err: llmErr,
          errorKind: aborted ? ("timeout" as const) : ("dependency" as const),
          step: "vision" as const,
          hint: aborted ? "vision completion timed out" : "vision completion failed",
        },
        "Main-provider vision completion failed",
      );
      return err(
        new VisionUnavailable(
          aborted ? "timeout" : "empty_response",
          aborted ? "Vision completion timed out." : "Vision completion failed.",
        ),
      );
    } finally {
      systemClearTimeout(timer);
    }
  }

  return { describeImage };
}
