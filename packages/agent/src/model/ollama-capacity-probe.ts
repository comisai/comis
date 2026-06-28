// SPDX-License-Identifier: Apache-2.0
/**
 * Ollama Capacity Probe: boot-time probe of the served context window for
 * local Ollama providers.
 *
 * Queries GET /api/ps (loaded model context_length) then falls back to
 * POST /api/show (model info). Fail-open: any failure returns err() and
 * the caller falls back to the configured contextWindow + emits WARN.
 *
 * The production composition root (daemon.ts / bootAgents) passes
 * `globalThis.fetch` as `fetchFn`. In tests, a mock function is injected.
 *
 * Never call raw `fetch()` in this module — always use the injected `fetchFn`.
 *
 * @module
 */

import { systemNowMs, systemSetTimeout, systemClearTimeout } from "@comis/core";
import type { ErrorKind } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Dependencies for the Ollama capacity probe (injectable for testing). */
export interface OllamaCapacityProbeDeps {
  /** HTTP fetch function (injectable — never use raw fetch in this module). */
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  /** Probe timeout per provider in ms. */
  timeoutMs: number;
}

/** Successful probe result. */
export interface OllamaProbeResult {
  /** The discovered served num_ctx (context_length). */
  servedWindow: number;
  /** Which Ollama API endpoint provided the value. */
  source: "api/ps" | "api/show";
  /** Elapsed milliseconds for the full probe (AGENTS.md §2.7 INFO completion). */
  durationMs: number;
}

/** Probe failure. */
export interface OllamaProbeError {
  /** Human-readable failure message. */
  message: string;
  /** Structured error kind for logging. */
  errorKind: ErrorKind;
  /** Elapsed milliseconds at the point of failure (for observability). */
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Internal Ollama API response shapes
// ---------------------------------------------------------------------------

interface OllamaRunningModelEntry {
  name?: string;
  model?: string;
  context_length?: unknown;
}

interface OllamaRunningModels {
  models?: OllamaRunningModelEntry[];
}

interface OllamaShowResponse {
  details?: {
    context_length?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Strip the trailing /v1 or /v1/ path segment from a configured baseUrl to
 * obtain the native Ollama host URL.
 *
 * "http://localhost:11434"      → "http://localhost:11434"
 * "http://localhost:11434/v1"   → "http://localhost:11434"
 * "http://localhost:11434/v1/"  → "http://localhost:11434"
 */
export function deriveOllamaNativeBase(configuredBaseUrl: string): string {
  return configuredBaseUrl.replace(/\/v1\/?$/, "");
}

/**
 * Minimum plausible served context window. Anything smaller is treated as a
 * bogus third-party value (e.g. a bad Modelfile `PARAMETER num_ctx`) and
 * rejected so it cannot shrink every turn's budget (IN-02, Phase 176 review).
 * No model Ollama serves runs below 512 tokens.
 */
const MIN_PLAUSIBLE_SERVED_WINDOW = 512;

/**
 * IN-02 input hardening: validate + clamp a raw `context_length` value from
 * an Ollama API response before it drives the budget reconcile.
 * Returns the FLOORED integer when the value is a finite number within the
 * sane range; undefined otherwise (caller falls through to the /api/show
 * fallback, then to the existing fail-open err/WARN path).
 */
function sanitizeServedWindow(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < MIN_PLAUSIBLE_SERVED_WINDOW) {
    return undefined;
  }
  return Math.floor(raw);
}

// ---------------------------------------------------------------------------
// Single-provider probe
// ---------------------------------------------------------------------------

/**
 * Probe a single Ollama provider's served context window.
 *
 * Strategy:
 * 1. GET {nativeBaseUrl}/api/ps — running models; read context_length for modelId.
 * 2. If model not in /api/ps (cold start), POST {nativeBaseUrl}/api/show — model info.
 * 3. Any error → return err() with the appropriate errorKind (fail-open).
 *
 * @param nativeBaseUrl - Host-only URL (e.g. "http://localhost:11434").
 *   Always call deriveOllamaNativeBase() on the configured baseUrl first.
 * @param modelId - Model to probe (e.g. "qwen3.6:35b"). Empty string → accept any loaded model.
 * @param deps - Injectable fetchFn and timeoutMs.
 */
export async function probeOllamaServedWindow(
  nativeBaseUrl: string,
  modelId: string,
  deps: OllamaCapacityProbeDeps,
): Promise<Result<OllamaProbeResult, OllamaProbeError>> {
  const { fetchFn, timeoutMs } = deps;
  const startMs = systemNowMs();

  // ── Step 1: GET /api/ps ──────────────────────────────────────────────────
  const psUrl = `${nativeBaseUrl}/api/ps`;
  let psResponse: Response;

  try {
    const controller = new AbortController();
    const timer = systemSetTimeout(() => controller.abort(), timeoutMs);
    try {
      psResponse = await fetchFn(psUrl, { method: "GET", signal: controller.signal });
    } finally {
      systemClearTimeout(timer);
    }
  } catch (error: unknown) {
    const durationMs = systemNowMs() - startMs;
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.code === 20)
    ) {
      return err({ message: `Probe timeout after ${timeoutMs}ms`, errorKind: "timeout", durationMs });
    }
    const message = error instanceof Error ? error.message : String(error);
    return err({ message, errorKind: "dependency", durationMs });
  }

  if (!psResponse.ok) {
    return err({
      message: `HTTP ${psResponse.status} from ${psUrl}`,
      errorKind: "dependency",
    });
  }

  // Parse /api/ps response
  let psBody: OllamaRunningModels;
  try {
    psBody = (await psResponse.json()) as OllamaRunningModels;
  } catch {
    return err({ message: "Failed to parse /api/ps JSON response", errorKind: "internal" });
  }

  if (!Array.isArray(psBody.models)) {
    return err({ message: "/api/ps response missing .models array", errorKind: "internal" });
  }

  // Find the model entry — match by name or model field
  const matchingEntry = psBody.models.find(
    (entry) =>
      !modelId ||
      entry.model === modelId ||
      entry.name === modelId,
  );

  // IN-05: distinguish a PRESENT-but-rejected value from an absent field so
  // the final err can name the right lever (a bogus Modelfile num_ctx vs a
  // genuinely missing context_length).
  let rejectedImplausible = false;

  if (matchingEntry !== undefined) {
    const contextLength = sanitizeServedWindow(matchingEntry.context_length);
    if (contextLength !== undefined) {
      return ok({ servedWindow: contextLength, source: "api/ps", durationMs: systemNowMs() - startMs });
    }
    if (matchingEntry.context_length !== undefined) rejectedImplausible = true;
  }

  // ── Step 2: POST /api/show (fallback when model not loaded or no context_length) ──
  const showUrl = `${nativeBaseUrl}/api/show`;
  let showResponse: Response;

  try {
    const controller = new AbortController();
    const timer = systemSetTimeout(() => controller.abort(), timeoutMs);
    try {
      showResponse = await fetchFn(showUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelId }),
        signal: controller.signal,
      });
    } finally {
      systemClearTimeout(timer);
    }
  } catch (error: unknown) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.code === 20)
    ) {
      return err({ message: `Probe timeout after ${timeoutMs}ms on /api/show`, errorKind: "timeout" });
    }
    const message = error instanceof Error ? error.message : String(error);
    return err({ message, errorKind: "dependency" });
  }

  if (!showResponse.ok) {
    return err({
      message: `HTTP ${showResponse.status} from ${showUrl}`,
      errorKind: "dependency",
    });
  }

  let showBody: OllamaShowResponse;
  try {
    showBody = (await showResponse.json()) as OllamaShowResponse;
  } catch {
    return err({ message: "Failed to parse /api/show JSON response", errorKind: "internal" });
  }

  const rawDetailsContextLength = showBody.details?.context_length;
  const detailsContextLength = sanitizeServedWindow(rawDetailsContextLength);
  if (detailsContextLength !== undefined) {
    return ok({ servedWindow: detailsContextLength, source: "api/show", durationMs: systemNowMs() - startMs });
  }
  if (rawDetailsContextLength !== undefined) rejectedImplausible = true;

  // Both endpoints exhausted. IN-05 (Phase 176 review): branch presence vs
  // absence — a value Ollama DID return but the IN-02 sanitization rejected
  // (e.g. a typo'd Modelfile PARAMETER num_ctx) is bad input ("validation"),
  // and reporting it as "not found" would send the operator to restart a
  // server that is up and answering. A genuinely absent field keeps the
  // original message + "internal".
  if (rejectedImplausible) {
    return err({
      message:
        `context_length present but implausible (non-numeric or < ${MIN_PLAUSIBLE_SERVED_WINDOW})` +
        " in /api/ps or /api/show — check the Modelfile 'PARAMETER num_ctx'",
      errorKind: "validation",
    });
  }
  return err({
    message: "No context_length found in /api/ps or /api/show",
    errorKind: "internal",
  });
}

// ---------------------------------------------------------------------------
// Multi-provider orchestrator
// ---------------------------------------------------------------------------

/** Parameters for probing all Ollama providers at boot. */
export interface ProbeAllOllamaProvidersParams {
  /** Providers config entries (keyed by provider ID). */
  providerEntries: Record<string, {
    type?: string;
    /** Whether the provider is enabled. Disabled providers (enabled: false) are skipped. */
    enabled?: boolean;
    baseUrl?: string;
    capabilities?: { probeServedWindow?: boolean };
    defaultModel?: string;
    /** Configured models for this provider. `ProviderEntrySchema` stores the
     *  model under `models[].id` (there is NO `defaultModel` field), so the
     *  probe must read the model id from here for the /api/show cold-start path. */
    models?: Array<{ id?: string }>;
  }>;
  /** Injectable fetch function. */
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  /** Timeout per provider probe in ms. */
  timeoutMs: number;
  /**
   * IMP-2a (package-delivery-20260628): also fire a fire-and-forget LOAD-ONLY warm-up
   * (`prewarmOllamaModel`) per ollama provider so the model is resident before the first user
   * turn — a cold model's first inference can exceed the per-inference stall budget and abort the
   * first turn after a (re)start "request took too long". Default false (byte-identical when unset).
   */
  prewarm?: boolean;
  /** Logger for probe outcome (INFO on success, WARN on failure). */
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

/**
 * Single source for "which model did the probe use" (KNOB-01's served-window
 * comparator shares it — the 17fdd1e5 bug class was two sites deriving this
 * expression differently). ProviderEntrySchema has NO `defaultModel`; the
 * model lives under `models[].id`. Falling back to the first configured model
 * lets the /api/show cold-start path (boot, before any inference, when
 * /api/ps is empty) send a real model name instead of "" (which Ollama
 * rejects with HTTP 400 → served window never found).
 */
export function resolveProbedModelId(
  entry: { defaultModel?: string; models?: Array<{ id?: string }> } | undefined,
): string {
  return entry?.defaultModel ?? entry?.models?.[0]?.id ?? "";
}

/**
 * Probe all Ollama providers at boot and return a map of provider ID → served
 * context window.
 *
 * - Only probes providers where `entry.type === "ollama"`.
 * - Skips if `entry.capabilities?.probeServedWindow === false` (explicit opt-out).
 * - `undefined` probeServedWindow = opt-in (default for Ollama providers).
 * - Uses Promise.allSettled so one provider failure cannot crash boot.
 * - Fail-open: failed probes are absent from the map; callers fall back to
 *   the configured contextWindow.
 *
 * @returns Map<providerId, servedWindow>. Missing key → use configured window.
 */
/**
 * Generous default warm-up timeout — loading a multi-GB local model takes tens of seconds; unlike the
 * metadata probe (5s), the warm-up must NOT abort the load. Fire-and-forget, so a long run never blocks boot.
 */
const PREWARM_TIMEOUT_MS = 300_000;

/**
 * Fire-and-forget LOAD-ONLY warm-up: POST {nativeBaseUrl}/api/generate with the model + keep_alive and an
 * EMPTY prompt, which loads the model into memory WITHOUT generating (the Ollama preload idiom).
 *
 * Why (IMP-2a, package-delivery-20260628, local qwen3.6:35b): a cold local model's FIRST inference —
 * prompt-processing the full tool-corpus prompt — emits no tokens for a long time and can exceed the
 * per-inference stall budget (`agents.<id>.promptTimeout.promptTimeoutMs`, default 180s), so the FIRST
 * user turn after a daemon (re)start aborts "request took too long" BEFORE any tool call. Warming at boot
 * loads the model in parallel with the rest of boot so the first real turn runs warm.
 *
 * Best-effort + non-fatal (a failure just means the model loads on first use, as before). NEVER throws.
 */
export async function prewarmOllamaModel(
  nativeBaseUrl: string,
  modelId: string,
  deps: {
    fetchFn: (url: string, init: RequestInit) => Promise<Response>;
    timeoutMs?: number;
    logger?: { info(o: Record<string, unknown>, m: string): void; warn(o: Record<string, unknown>, m: string): void };
  },
): Promise<void> {
  if (!modelId) return; // empty = the probe's "any loaded model" sentinel — nothing specific to warm
  const url = `${nativeBaseUrl}/api/generate`;
  const controller = new AbortController();
  const timer = systemSetTimeout(() => controller.abort(), deps.timeoutMs ?? PREWARM_TIMEOUT_MS);
  try {
    await deps.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Empty prompt → Ollama loads the model and returns (done:true) WITHOUT generating.
      body: JSON.stringify({ model: modelId, prompt: "", stream: false, keep_alive: "30m" }),
      signal: controller.signal,
    });
    deps.logger?.info({ modelId, submodule: "ollama-prewarm" }, "Ollama model warm-up dispatched");
  } catch (error: unknown) {
    deps.logger?.warn(
      {
        modelId,
        err: error instanceof Error ? error.message : String(error),
        errorKind: "dependency" as const,
        hint: "best-effort warm-up failed; the model loads on first use (a cold first turn may be slow)",
        submodule: "ollama-prewarm",
      },
      "Ollama model warm-up failed (non-fatal)",
    );
  } finally {
    systemClearTimeout(timer);
  }
}

export async function probeAllOllamaProviders(
  params: ProbeAllOllamaProvidersParams,
): Promise<Map<string, number>> {
  const { providerEntries, fetchFn, timeoutMs, logger, prewarm } = params;
  const resultMap = new Map<string, number>();

  const tasks: Array<Promise<void>> = [];

  for (const [providerId, entry] of Object.entries(providerEntries)) {
    // Only probe Ollama-native providers
    if (entry.type !== "ollama") continue;

    // Skip disabled providers — no boot-time network attempt for disabled entries
    if (entry.enabled === false) continue;

    // Skip if explicitly opted out
    if (entry.capabilities?.probeServedWindow === false) continue;

    const nativeBase = deriveOllamaNativeBase(entry.baseUrl ?? "http://localhost:11434");
    const modelId = resolveProbedModelId(entry);

    // IMP-2a: fire-and-forget LOAD-ONLY warm-up (NOT awaited — must not block boot; the model loads in
    // the background so the first user turn runs warm). Non-fatal; detached from the probe `tasks`.
    if (prewarm) {
      void prewarmOllamaModel(nativeBase, modelId, { fetchFn, logger }).catch(() => {
        /* prewarmOllamaModel never throws; this .catch is belt-and-suspenders for the void promise */
      });
    }

    const task = probeOllamaServedWindow(nativeBase, modelId, { fetchFn, timeoutMs }).then(
      (result) => {
        if (result.ok) {
          resultMap.set(providerId, result.value.servedWindow);
          logger.info(
            {
              providerId,
              servedWindow: result.value.servedWindow,
              source: result.value.source,
              durationMs: result.value.durationMs,
              submodule: "ollama-capacity-probe",
            },
            "Ollama served context window discovered",
          );
        } else {
          // W12 (obs-llm-troubleshooting): branch the hint by failure class. An
          // HTTP status means Ollama responded — "start Ollama" points the
          // operator away from the real cause (live: HTTP 400 from /api/show
          // while the server was up; the model name/payload was the suspect).
          // IN-05: errorKind "validation" means Ollama responded WITH a value
          // that the sanitizer rejected as implausible — the lever is the
          // Modelfile num_ctx, not the server, and not the probe opt-out.
          const isHttpStatusFailure = result.error.message.startsWith("HTTP ");
          const isRejectedValue = result.error.errorKind === "validation";
          const hint = isHttpStatusFailure
            ? `Ollama is reachable but rejected the probe — verify the model '${modelId}' exists (ollama list) and the /api/show payload; falling back to configured contextWindow`
            : isRejectedValue
              ? `Ollama returned a context_length for model '${modelId}' but it was rejected as implausible — check the Modelfile 'PARAMETER num_ctx'; falling back to configured contextWindow`
              : "Falling back to configured contextWindow; start Ollama or set capabilities.probeServedWindow: false to suppress";
          logger.warn(
            {
              provider: providerId,
              err: result.error.message,
              errorKind: result.error.errorKind,
              durationMs: result.error.durationMs,
              hint,
              submodule: "ollama-capacity-probe",
            },
            "Ollama capacity probe failed — using configured contextWindow",
          );
        }
      },
    );

    tasks.push(task);
  }

  // Fan-out: probe all providers concurrently; failures don't block others
  await Promise.allSettled(tasks);

  return resultMap;
}
