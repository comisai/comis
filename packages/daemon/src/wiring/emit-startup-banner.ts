import { systemNowMs } from "@comis/core";
import type { BootContext } from "../daemon-types.js";
import { emitAutonomyBootLog } from "./emit-autonomy-boot-log.js";
import { emitDockerRestartPolicyWarn } from "../setup-docker-restart-warn.js";
import { hasAnyOAuthAgent, emitOAuthTlsPreflightWarn } from "./oauth-preflight.js";

/**
 * Emit the "Comis daemon started" INFO banner (+ the resolved-autonomy
 * boot log, the Docker restart-policy WARN, and the boot-time OAuth TLS preflight).
 * Extracted from daemon.ts `bootGateway` to keep daemon.ts within the ≤3000-line
 * architecture cap. Pure logging — no boot mutation, void return.
 *
 * NOTE: per-line-source order is preserved (daemon-lifecycle.test.ts log-sequence
 * assertions depend on it). `startupDurationMs` uses `systemNowMs()` (the
 * globals-gate-safe wall-clock; replaces the prior bare `Date.now()`).
 */
export function emitStartupBanner(deps: {
  container: BootContext["container"];
  daemonLogger: BootContext["daemonLogger"];
  daemonVersion: BootContext["daemonVersion"];
  agents: NonNullable<BootContext["agentsConfig"]>;
  adaptersByType: NonNullable<BootContext["adaptersByType"]>;
  configPaths: BootContext["configPaths"];
  db: BootContext["db"];
  secretStore: BootContext["secretStore"];
  cachedPort: BootContext["cachedPort"];
  ttsAdapter: BootContext["ttsAdapter"];
  visionRegistry: BootContext["visionRegistry"];
  startupStartMs: number;
  instanceId: string;
  /** Host preflight RESULT (see emitAutonomyBootLog). Defaults true when no namespace probe has run. */
  namespacePreflightOk?: boolean;
}): void {
  const {
    container, daemonLogger, daemonVersion, agents, adaptersByType, configPaths,
    db, secretStore, cachedPort, ttsAdapter, visionRegistry,
    startupStartMs, instanceId,
  } = deps;
  const gwConfig = container.config.gateway;
  // Inlined buildStartupBannerManifest: secrets/memory/agents/skills/gateway sub-object.
  const manifest: Record<string, unknown> = {
    secrets: { encrypted: !!secretStore },
    memory: { embedding: !!cachedPort, dbPath: db.name },
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, cfg]) => [id, { model: cfg.model }]),
    ),
    skills: {
      tts: !!ttsAdapter,
      vision: visionRegistry ? [...visionRegistry.keys()] : [],
      linkUnderstanding: container.config.integrations.media.linkUnderstanding.enabled,
    },
    gateway: {
      enabled: gwConfig.enabled,
      port: gwConfig.enabled ? gwConfig.port : undefined,
      tls: !!gwConfig.tls?.certPath,
    },
  };
  daemonLogger.info({
    version: daemonVersion, agents: Object.keys(agents),
    channels: Array.from(adaptersByType.keys()),
    port: gwConfig.enabled ? gwConfig.port : undefined, instanceId,
    startupDurationMs: systemNowMs() - startupStartMs, configPaths, dbPath: db.name,
    logLevel: container.config.logLevel ?? "debug", nodeVersion: process.versions.node,
    manifest,
  }, "Comis daemon started");
  // Legible resolved-autonomy boot logging (per-agent INFO + the
  // optional namespace-downshift WARN), extracted to emit-autonomy-boot-log.ts.
  emitAutonomyBootLog({ daemonLogger, agents, namespacePreflightOk: deps.namespacePreflightOk });
  // Docker-only: surface restart-policy requirement immediately after the
  // startup banner. No-op outside containers. Wired here so the WARN lands
  // in `docker logs` next to the banner, where operators look first.
  emitDockerRestartPolicyWarn(daemonLogger);
  // Boot-time TLS preflight against auth.openai.com.
  // Fire-and-forget -- daemon is already serving by this point; the WARN
  // is purely advisory. Skipped when no OAuth-using agent is configured.
  if (hasAnyOAuthAgent(container.config.agents)) {
    void emitOAuthTlsPreflightWarn(daemonLogger);
  }
}
