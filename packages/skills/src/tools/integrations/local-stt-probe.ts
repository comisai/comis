// SPDX-License-Identifier: Apache-2.0
/**
 * One-shot boot probe for the keyless local STT engine (LOCAL-02).
 *
 * `detectLocalSttEngine` answers, ONCE at daemon boot, the question the
 * Phase-193 resolver predicate `localEngineAvailable()` needs: can the `local`
 * STT rung actually transcribe? It NEVER throws and it NEVER downloads a model
 * — it only checks cheap signals (a short-timeout reachability fetch to a
 * configured server, OR engine-importability + ffmpeg presence). The boolean
 * result is captured by the daemon wiring and closed over as a synchronous
 * `() => boolean` (Plan 03), so the resolver does no per-call I/O.
 *
 * Availability rule (CONTEXT decision I6):
 *   1. `baseUrl` set + reachable  → available, mode "baseUrl" (the in-process
 *      engine is NOT consulted — a reachable local OpenAI-compatible whisper
 *      server is sufficient).
 *   2. else, in-process path: ffmpeg present AND `@huggingface/transformers`
 *      importable → available, mode "in-process".
 *   3. otherwise → not available, mode "none".
 *
 * Security: the `baseUrl` reachability is a short-timeout fetch wrapped in a try
 * (loopback-default; any error → not-reachable). This is ONLY the loopback seam
 * — the full SSRF / DNS-rebinding guard is Phase 197 (do not build it here). No
 * credential-bearing URL is logged.
 *
 * @module
 */

import { systemSetTimeout, systemClearTimeout } from "@comis/core";

/** Default reachability-probe timeout (ms). */
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

/** Result of the one-shot local STT boot probe. */
export interface LocalSttProbeResult {
  /** Whether the `local` STT rung can transcribe. */
  readonly available: boolean;
  /** Which mechanism made it available (or "none"). */
  readonly mode: "baseUrl" | "in-process" | "none";
}

/** Dependencies for the one-shot local STT boot probe. */
export interface LocalSttProbeDeps {
  /** Optional local OpenAI-compatible whisper server URL (LOCAL-03). */
  readonly baseUrl?: string;
  /** Whether ffmpeg is available (the in-process path needs it to decode). */
  readonly ffmpegAvailable: boolean;
  /**
   * Reachability seam: resolves `true` if the baseUrl server is reachable.
   * Defaults to a short-timeout fetch. Injected in tests to avoid real I/O.
   */
  readonly fetchProbe?: (url: string) => Promise<boolean>;
  /**
   * Engine-importability seam: resolves `true` if `@huggingface/transformers`
   * imports. Defaults to a guarded lazy import (never throws, never downloads).
   * Injected in tests.
   */
  readonly canImportEngine?: () => Promise<boolean>;
  /** Reachability-probe timeout in ms (default 1500). */
  readonly timeoutMs?: number;
}

/**
 * Default reachability check: a short-timeout GET to the server root. Any error
 * (refused, DNS, timeout, non-2xx is still "reachable") resolves `false`.
 * Loopback-friendly only — the full SSRF guard is Phase 197.
 */
async function defaultReachable(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = systemSetTimeout(() => controller.abort(), timeoutMs);
  try {
    // A response of ANY status proves the server is up; only a network/abort
    // error means unreachable. We do not log the URL (it may carry creds).
    await fetch(url, { method: "GET", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    systemClearTimeout(timer);
  }
}

/**
 * Default engine-importability check: a guarded lazy `import()` that resolves
 * `true`/`false` and NEVER throws. Importability only — it does NOT build a
 * pipeline or download any model (same lazy discipline as the adapter).
 */
async function defaultCanImportEngine(): Promise<boolean> {
  try {
    await import("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

/**
 * Run an async boolean check, resolving `false` if it rejects. Keeps
 * `detectLocalSttEngine` total (never throws) without a dead initial
 * assignment.
 */
async function safeBoolean(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

/**
 * Detect whether the keyless local STT engine is usable. One-shot, never throws,
 * never downloads a model.
 */
export async function detectLocalSttEngine(
  deps: LocalSttProbeDeps,
): Promise<LocalSttProbeResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  // 1. A reachable configured server is sufficient (I6) — do NOT consult the
  //    in-process engine.
  const baseUrl = deps.baseUrl;
  if (baseUrl) {
    const reachableFn = deps.fetchProbe ?? ((url: string) => defaultReachable(url, timeoutMs));
    const reachable = await safeBoolean(() => reachableFn(baseUrl));
    if (reachable) {
      return { available: true, mode: "baseUrl" };
    }
  }

  // 2. In-process path: ffmpeg is required to decode the audio.
  if (!deps.ffmpegAvailable) {
    return { available: false, mode: "none" };
  }

  const importFn = deps.canImportEngine ?? defaultCanImportEngine;
  const importable = await safeBoolean(importFn);

  return importable
    ? { available: true, mode: "in-process" }
    : { available: false, mode: "none" };
}
