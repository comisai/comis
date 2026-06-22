// SPDX-License-Identifier: Apache-2.0
/**
 * Emit the one-shot `config_posture` obs record at the end of boot.
 *
 * Extracted from daemon.ts (the §9.2 I3 snapshot) to keep that file under the
 * per-file line cap. Records the log-file-only posture FINDINGS — TLS-off,
 * stranded-secret COUNTS, canary-fallback, served-below-configured, chimeric
 * model / pricing-gap counts, and the proxy boot outcome — as a single
 * config_posture obs_diagnostics row so the fleet lens can query a daemon's
 * posture without grepping daemon.log.
 *
 * TLS-off is CONFIG-DERIVED here, not read from the gateway's own TLS decision:
 * `gateway.{tls,allowInsecureHttp}` is the INPUT the gateway acts on, but the
 * gateway's resolved `tls ? https : http` branch (hono-server.ts) is internal
 * and NOT exposed on GatewayServerHandle. This recompute matches the listener's
 * posture today (WR-02). canaryFallbackActive is a daemon-global presence proxy:
 * CANARY_SECRET is folded into mergedEnv store-wins, so this env read honors an
 * encrypted/file secret-store entry. True ⇒ no secret ⇒ deterministic fallback.
 *
 * @module
 */
import type { BootContext } from "../daemon-types.js";
import {
  buildConfigPostureRecord,
  countChimericModels,
  countPricingGaps,
  type ConfigPostureInputs,
} from "../observability/build-config-posture-record.js";

export function emitConfigPostureRecord(
  boot: BootContext,
  strandedFindings: ConfigPostureInputs["strandedFindings"],
): void {
  const gw = boot.container.config.gateway;
  const tlsOff = gw.tls === undefined && gw.allowInsecureHttp !== true;
  const allowInsecureHttp = gw.allowInsecureHttp === true;
  const canaryFallbackActive = !boot.env.get("CANARY_SECRET");
  // KNOB-03: derived from the SAME boot comparisons the KNOB-01 WARN used.
  const servedBelowConfiguredCount = [
    ...(boot.servedWindowComparisons?.values() ?? []),
  ].filter((c) => c.belowConfigured).length;
  // Thread the proxy boot posture into the record only when configured (zero-config gate).
  const proxyInstallerStatus =
    boot.proxyBootPosture?.configured === true
      ? {
          installerError: boot.proxyBootPosture.installerError ?? null,
          effectiveLoopbackMode: boot.proxyBootPosture.loopbackMode ?? "gateway-only",
        }
      : undefined;
  buildConfigPostureRecord(
    boot.obsStore,
    {
      tlsOff,
      allowInsecureHttp,
      strandedFindings,
      canaryFallbackActive,
      servedBelowConfiguredCount,
      chimericModelCount: countChimericModels(boot.container.config.agents),
      pricingGapCount: countPricingGaps(boot.container.config.agents),
      proxyInstallerStatus,
    },
    boot.clock,
  );
}
