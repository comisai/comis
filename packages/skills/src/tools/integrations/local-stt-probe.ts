// SPDX-License-Identifier: Apache-2.0
/**
 * One-shot boot probe for the keyless local STT engine.
 *
 * `detectLocalSttEngine` answers, ONCE at daemon boot, the question the
 * resolver predicate `localEngineAvailable()` needs: can the `local`
 * STT rung actually transcribe? It NEVER throws and it NEVER downloads a model
 * — it only checks cheap signals (a short-timeout reachability fetch to a
 * configured server, OR engine-importability + ffmpeg presence). The boolean
 * result is captured by the daemon wiring and closed over as a synchronous
 * `() => boolean`, so the resolver does no per-call I/O.
 *
 * Availability rule:
 *   1. `baseUrl` set + reachable  → available, mode "baseUrl" (the in-process
 *      engine is NOT consulted — a reachable local OpenAI-compatible whisper
 *      server is sufficient).
 *   2. else, in-process path: ffmpeg present AND `@huggingface/transformers`
 *      importable → available, mode "in-process".
 *   3. otherwise → not available, mode "none".
 *
 * Security: the configured `baseUrl` is validated by
 * `validateLocalServerUrl` (the inverse SSRF guard — ALLOW loopback + an
 * explicit allowlist, DENY public/private egress, keep the cloud-metadata deny)
 * BEFORE the reachability fetch fires. A non-loopback/unconfigured baseUrl is
 * treated as not-reachable (the guard rejects it and the probe falls through to
 * the in-process path) so a mis/maliciously-configured URL can never drive an
 * SSRF fetch from the boot probe. The reachability check itself is a
 * short-timeout fetch wrapped in a try (any error → not-reachable), and it
 * is PINNED to the IP the guard resolved (undici dispatcher) so a hostname that
 * passed as loopback cannot be rebound to a different IP at connect time
 * (DNS-rebinding/TOCTOU). No credential-bearing URL is logged.
 *
 * @module
 */

import { systemSetTimeout, systemClearTimeout, validateLocalServerUrl } from "@comis/core";
import { fetchPinned } from "./pinned-fetch.js";

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
  /** Optional local OpenAI-compatible whisper server URL. */
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
 * (refused, DNS, timeout, non-2xx is still "reachable") resolves `false`. The
 * SSRF guard (`validateLocalServerUrl`) has already run in `detectLocalSttEngine`
 * BEFORE this fetch — so this only ever fetches a loopback/explicitly-allowed
 * host.
 *
 * The fetch is PINNED to `pinnedIp` (the IP the guard already resolved)
 * via an undici dispatcher, so a hostname that resolved to loopback at
 * validation cannot be rebound to a different IP at connect time (the
 * DNS-rebinding/TOCTOU gap a plain re-resolving fetch left open). TLS SNI is
 * preserved because the original hostname stays in `url`.
 */
async function defaultReachable(url: string, pinnedIp: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = systemSetTimeout(() => controller.abort(), timeoutMs);
  try {
    // A response of ANY status proves the server is up; only a network/abort
    // error means unreachable. We do not log the URL (it may carry creds).
    await fetchPinned(url, pinnedIp, { method: "GET", signal: controller.signal });
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

  // 1. A reachable configured server is sufficient — do NOT consult the
  //    in-process engine. The baseUrl is SSRF-guarded BEFORE the
  //    reachability check fires (guard-before-fetch). validateLocalServerUrl
  //    ALLOWS loopback + an explicit allowlist and DENIES public/private egress
  //    (keeping the cloud-metadata deny); a rejected URL is treated as
  //    not-reachable so a mis/maliciously-configured baseUrl can never drive an
  //    SSRF fetch — the probe falls through to the in-process path. The guard
  //    also gates the injected `fetchProbe` test seam (it sits before the seam).
  const baseUrl = deps.baseUrl;
  if (baseUrl) {
    const guard = await validateLocalServerUrl(baseUrl);
    if (guard.ok) {
      // The default reachability fetch pins the connection to the IP the
      // guard just resolved (guard.value.ip). An injected `fetchProbe` test seam
      // bypasses the real fetch entirely (the guard still gates it above).
      const validatedIp = guard.value.ip;
      const reachableFn =
        deps.fetchProbe ?? ((url: string) => defaultReachable(url, validatedIp, timeoutMs));
      const reachable = await safeBoolean(() => reachableFn(baseUrl));
      if (reachable) {
        return { available: true, mode: "baseUrl" };
      }
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
