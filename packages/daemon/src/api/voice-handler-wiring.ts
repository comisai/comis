// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-02/03 (Phase 196): the daemon voice-handler wiring shim.
 *
 * `media-handlers.ts` is at its 800-line cap with ZERO allowlist cushion, so the
 * `media.transcribe` / `tts.synthesize` obs wiring lives HERE (a sibling), not
 * inline — each handler call-site becomes `const voice = wireVoiceForHandler(
 * rawParams, deps, "stt"|"tts")` + `voice.completed(...)` / `voice.failed(...)`.
 *
 * The shim resolves the OBS-03 selection (`provider`/`keyless`/`source` + the
 * `onSkip` reasons) from the boot-resolved `deps.voiceSelection` (the SAME
 * `SttSelection`/`TtsSelection` the adapter construction used — NO second source
 * of truth). When `voiceSelection` is absent (a boot mode without the audio
 * selector / a pre-193 test harness) it falls back to the config provider +
 * a keyless heuristic (`local`/`edge`) — an honest best effort, never a crash:
 * a concrete config provider is labeled `source:"explicit"`, but an unpinned
 * `auto`/`configured` is labeled `source:"fallback"` (WR-03 — never fabricate an
 * explicit rung the resolver never produced). It then delegates to `wireVoiceObs` (the
 * record + the §2.7 INFO/WARN line + the SEC-01 host-only redaction), so this
 * module adds NO logging/redaction of its own.
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";
import { safePath, systemNowMs, type SttErrorKind } from "@comis/core";
import * as fs from "node:fs/promises";
import { wireVoiceObs, type VoiceKind, type VoiceSource, type WiredVoiceObs } from "./voice-obs-emit.js";
import type { MediaApiDeps, ResolvedVoiceSelection } from "./types.js";

/**
 * Best-effort TTL prune of a TTS output dir: delete files older than one hour.
 * Extracted from the `tts.synthesize` handler (behavior-neutral) to keep
 * `media-handlers.ts` ≤800 after the voice-obs wiring. Never throws — a readdir
 * or per-file failure is swallowed (the synthesis already succeeded). The dir +
 * each entry are joined via `safePath` (workspace confinement, unchanged).
 */
export async function pruneTtsOutputDir(outputDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(outputDir);
    const cutoff = systemNowMs() - 3_600_000;
    for (const entry of entries) {
      try {
        const entryPath = safePath(outputDir, entry);
        const stat = await fs.stat(entryPath);
        if (stat.mtimeMs < cutoff) {
          // fs-safe-allowed: per-agent workspace media output (`<agentDir>/media/tts/<file>`); not ~/.comis/ directly
          await fs.unlink(entryPath);
        }
      } catch {
        // Individual file cleanup failure is non-fatal.
      }
    }
  } catch {
    // Cleanup failure is non-fatal.
  }
}

/** The minimal slice of `MediaHandlerDeps` the voice wiring reads. */
type VoiceWiringDeps = Pick<
  MediaApiDeps,
  | "mediaConfig"
  | "trajectoryRegistry"
  | "logger"
  | "defaultAgentId"
  | "resolveAgentMainProvider"
  | "voiceSelection"
  // OBS-04 (196): the obs store the voice_degraded fleet emit inserts into (already
  // on MediaApiDeps — no new dep). Optional; absent → the emit no-ops.
  | "obsStore"
>;

/** The closed set of providers that run keyless (no credential). Used only when
 *  `voiceSelection` is absent (the resolver already carries `keyless` otherwise). */
const KEYLESS_VOICE_PROVIDERS = new Set(["local", "edge"]);

/** Coerce an unknown thrown error's `errorKind` to the domain `SttErrorKind`,
 *  defaulting to `"dependency"` (the inbound-handler default) for an untyped
 *  error. Content-free — reads only the closed-union tag, never the message. */
export function toSttErrorKind(err: unknown): SttErrorKind {
  const kind = (err as { errorKind?: unknown } | null)?.errorKind;
  switch (kind) {
    case "no_keyless_engine":
    case "auth_required":
    case "model_load_failed":
    case "model_download_failed":
    case "timeout":
    case "network":
    case "dependency":
      return kind;
    default:
      return "dependency";
  }
}

/** Resolve the OBS-03 voice selection for `kind` from the boot-resolved
 *  `deps.voiceSelection`, falling back to the config provider + keyless heuristic. */
function resolveVoiceRequested(
  deps: VoiceWiringDeps,
  kind: VoiceKind,
): { provider: string; keyless: boolean; source: VoiceSource; onSkip?: string[] } {
  const resolved: ResolvedVoiceSelection | undefined =
    kind === "stt" ? deps.voiceSelection?.stt : deps.voiceSelection?.tts;
  if (resolved !== undefined) {
    return {
      provider: resolved.provider,
      keyless: resolved.keyless,
      source: resolved.source,
      ...(resolved.onSkip !== undefined ? { onSkip: resolved.onSkip } : {}),
    };
  }
  // Fallback (no selector ran): derive from config. Defensive `?.` — the obs path
  // must never crash the handler even if a config slice is unexpectedly absent.
  const provider =
    (kind === "stt" ? deps.mediaConfig.transcription?.provider : deps.mediaConfig.tts?.provider) ?? "configured";
  // WR-03 (196 review): be HONEST about the rung. A concrete config provider
  // (e.g. `local`/`edge`/`openai`) was used verbatim → that IS an explicit pin.
  // But `auto` / the `?? "configured"` placeholder is NOT an explicit choice —
  // the resolver never ran, so labeling it `explicit` would fabricate a selection
  // rung. Use `fallback` ("no resolver ran, derived from config") for those.
  // `keyless` is a best-effort heuristic on this degraded path (the resolver
  // carries the real value otherwise); `auto`/`configured` aren't in the keyless
  // set, so they default to keyed — honest as a conservative best effort.
  const isUnpinned = provider === "auto" || provider === "configured";
  const source: VoiceSource = isUnpinned ? "fallback" : "explicit";
  return { provider, keyless: KEYLESS_VOICE_PROVIDERS.has(provider), source };
}

/**
 * Build the wired voice-obs for a daemon voice handler. Resolves the OBS-03
 * selection, fires `media.${kind}.requested` (with `source` + `onSkip`), and
 * returns the {@link WiredVoiceObs} whose `.completed` / `.failed` each record the
 * trajectory event AND emit the one §2.7 line. The `provider`/`keyless`/`source`
 * are surfaced on the return so the handler does not re-derive them.
 */
export function wireVoiceForHandler(
  rawParams: Record<string, unknown>,
  deps: VoiceWiringDeps & { logger: ComisLogger },
  kind: VoiceKind,
): WiredVoiceObs & { provider: string; keyless: boolean; source: VoiceSource } {
  const agentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;
  const main = deps.resolveAgentMainProvider?.(agentId) ?? { providerId: "unknown" };
  const requested = resolveVoiceRequested(deps, kind);
  const wired = wireVoiceObs({
    sessionKey: rawParams._callerSessionKey as string | undefined,
    trajectoryRegistry: deps.trajectoryRegistry,
    logger: deps.logger,
    // OBS-04: thread the obsStore so a failure feeds the fleet voice_health finding.
    ...(deps.obsStore !== undefined ? { obsStore: deps.obsStore } : {}),
    agentId,
    kind,
    requested: { provider: requested.provider, mainProvider: main.providerId, source: requested.source, ...(requested.onSkip !== undefined ? { onSkip: requested.onSkip } : {}) },
    ...(typeof rawParams._channelType === "string" ? { logContext: { channelType: rawParams._channelType } } : {}),
  });
  return { ...wired, provider: requested.provider, keyless: requested.keyless, source: requested.source };
}
