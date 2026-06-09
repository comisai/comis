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
}

/** Probe failure. */
export interface OllamaProbeError {
  /** Human-readable failure message. */
  message: string;
  /** Structured error kind for logging. */
  errorKind: ErrorKind;
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
    void durationMs; // timing info available to callers via logs
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.code === 20)
    ) {
      return err({ message: `Probe timeout after ${timeoutMs}ms`, errorKind: "timeout" });
    }
    const message = error instanceof Error ? error.message : String(error);
    return err({ message, errorKind: "dependency" });
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

  if (matchingEntry !== undefined) {
    const contextLength = matchingEntry.context_length;
    if (typeof contextLength === "number" && isFinite(contextLength) && contextLength > 0) {
      return ok({ servedWindow: contextLength, source: "api/ps" });
    }
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

  const detailsContextLength = showBody.details?.context_length;
  if (
    typeof detailsContextLength === "number" &&
    isFinite(detailsContextLength) &&
    detailsContextLength > 0
  ) {
    return ok({ servedWindow: detailsContextLength, source: "api/show" });
  }

  // Both endpoints exhausted — no usable context_length found
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
    baseUrl?: string;
    capabilities?: { probeServedWindow?: boolean };
    defaultModel?: string;
  }>;
  /** Injectable fetch function. */
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  /** Timeout per provider probe in ms. */
  timeoutMs: number;
  /** Logger for probe outcome (INFO on success, WARN on failure). */
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
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
export async function probeAllOllamaProviders(
  params: ProbeAllOllamaProvidersParams,
): Promise<Map<string, number>> {
  const { providerEntries, fetchFn, timeoutMs, logger } = params;
  const resultMap = new Map<string, number>();

  const tasks: Array<Promise<void>> = [];

  for (const [providerId, entry] of Object.entries(providerEntries)) {
    // Only probe Ollama-native providers
    if (entry.type !== "ollama") continue;

    // Skip if explicitly opted out
    if (entry.capabilities?.probeServedWindow === false) continue;

    const nativeBase = deriveOllamaNativeBase(entry.baseUrl ?? "http://localhost:11434");
    const modelId = entry.defaultModel ?? "";

    const task = probeOllamaServedWindow(nativeBase, modelId, { fetchFn, timeoutMs }).then(
      (result) => {
        if (result.ok) {
          resultMap.set(providerId, result.value.servedWindow);
          logger.info(
            {
              providerId,
              servedWindow: result.value.servedWindow,
              source: result.value.source,
              submodule: "ollama-capacity-probe",
            },
            "Ollama served context window discovered",
          );
        } else {
          logger.warn(
            {
              provider: providerId,
              err: result.error.message,
              errorKind: result.error.errorKind,
              hint: "Falling back to configured contextWindow; start Ollama or set capabilities.probeServedWindow: false to suppress",
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
