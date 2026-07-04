// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams health check for `comis doctor`.
 *
 * Teams is a webhook channel: it is exempt from the health monitor's stale-reap
 * (a webhook has no socket to go quiet), so a dead ingress would never surface
 * through the monitor. An operator therefore needs a one-command answer to "is
 * my Teams bot actually receiving?" — which this check provides via four probes:
 *
 *   1. creds-parse    — authMode-aware credential presence/resolution
 *                       (secret → appPassword resolved; certificate → certPath
 *                       present/readable; managedIdentity → clientId present).
 *   2. endpoint       — an UNAUTH request to the mounted
 *                       /channels/msteams/api/messages route: 401/405 means the
 *                       ingress is mounted and rejecting unauth (good); 404 means
 *                       the route is absent (misconfigured).
 *   3. recent-inbound — the INBOUND-ONLY lastInboundAt read over the channel-
 *                       status RPC. It is NEVER the conflated last-activity
 *                       signal: an outbound send bumps last-activity, so a
 *                       send-only bot would read as healthy on last-activity
 *                       while its ingress is dead. The
 *                       probe reads the dedicated inbound signal so that case is
 *                       caught.
 *   4. tenant-present — Teams requires a single-tenant directory (tenant) ID.
 *
 * The endpoint + recent-inbound probes degrade to `skip` when the daemon/gateway
 * is unreachable (mirrors the other daemon-dependent doctor checks). The probe
 * never calls the adapter directly — the daemon owns live adapter state and
 * surfaces it over RPC.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { ChannelsHealthContract, systemNowMs } from "@comis/core";
import type { DoctorCheck, DoctorContext, DoctorFinding, DoctorStatus } from "../types.js";
import { describeConfigUnavailable } from "../config-resolve.js";
import { isDaemonRunning } from "../../sync-tooling/daemon-guard.js";
import { withClient, callTyped } from "../../client/rpc-client.js";

const CATEGORY = "channels";
const CHANNEL_TYPE = "msteams";

/** The mounted inbound route (relative to the gateway origin). */
const MSTEAMS_ENDPOINT_PATH = "/channels/msteams/api/messages";

/** Endpoint-probe HTTP timeout. */
const ENDPOINT_PROBE_TIMEOUT_MS = 3_000;
/** Liveness-probe timeout before the recent-inbound RPC. */
const LIVENESS_PROBE_TIMEOUT_MS = 1_000;
/**
 * Recent-inbound recency window. A `warn` (never `fail`): a webhook bot may
 * legitimately be quiet, but zero inbound in a full day on a health check is
 * worth flagging as a possible dead ingress. The continuous, tunable liveness
 * monitor is a separate concern; this is the point-in-time doctor read.
 */
const RECENT_INBOUND_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_INBOUND_WINDOW_HOURS = RECENT_INBOUND_WINDOW_MS / 3_600_000;

/**
 * Minimal view of the resolved `channels.msteams` config block the probes read.
 * `appPassword` is `string | SecretRef` (a `${VAR}` string ref is substituted by
 * the shared resolution when it resolves; a SecretRef object is present as-is).
 */
interface MsTeamsConfigView {
  readonly enabled?: boolean;
  readonly authMode?: "secret" | "certificate" | "managedIdentity";
  readonly tenantId?: string;
  readonly certPath?: string;
  readonly managedIdentityClientId?: string;
  readonly appPassword?: unknown;
}

/** A credential value is blank when absent or all-whitespace. */
function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === "";
}

/**
 * appPassword is present when it is a non-blank string (an inline or resolved
 * `${VAR}`) or a SecretRef object (its resolution is a store concern, not
 * verifiable offline — presence of the object is what this probe asserts).
 */
function appPasswordPresent(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  return value !== undefined && value !== null;
}

/** Compact finding constructor (all msteams findings are non-repairable). */
function finding(
  status: DoctorStatus,
  check: string,
  message: string,
  suggestion?: string,
): DoctorFinding {
  return {
    category: CATEGORY,
    check,
    status,
    message,
    ...(suggestion !== undefined ? { suggestion } : {}),
    repairable: false,
  };
}

// ---------------------------------------------------------------------------
// Probe 1: creds-parse (authMode-aware)
// ---------------------------------------------------------------------------

function credsParseFinding(
  msteams: MsTeamsConfigView,
  context: DoctorContext,
): DoctorFinding {
  const check = "Teams credentials";
  const authMode = msteams.authMode ?? "secret";

  if (authMode === "certificate") {
    if (isBlank(msteams.certPath)) {
      return finding(
        "fail",
        check,
        "certPath is empty but certificate mode requires a client certificate path",
        "Set channels.msteams.certPath to the client certificate path",
      );
    }
    // Best-effort readability. The daemon may run on a different host than the
    // CLI, so a not-found path is a warn (expected on split-host), not a fail.
    if (!existsSync(msteams.certPath!)) {
      return finding(
        "warn",
        check,
        `certPath is set (${msteams.certPath!}) but no readable file exists there on this host`,
        "If the daemon runs on another host this is expected; otherwise fix channels.msteams.certPath",
      );
    }
    return finding("pass", check, "certificate credentials present (certPath readable)");
  }

  if (authMode === "managedIdentity") {
    if (isBlank(msteams.managedIdentityClientId)) {
      return finding(
        "fail",
        check,
        "managedIdentityClientId is empty but managed-identity mode requires it",
        "Set channels.msteams.managedIdentityClientId to the managed-identity client ID",
      );
    }
    return finding("pass", check, "managed-identity credentials present");
  }

  // secret mode (default): appPassword must be present AND, if a ${VAR} ref, resolved.
  const unresolvedAppPassword = (context.configResolution?.unresolvedRefs ?? []).find(
    (ref) => ref.path.startsWith("channels.msteams.appPassword"),
  );
  if (unresolvedAppPassword !== undefined) {
    return finding(
      "fail",
      check,
      `Unresolved appPassword reference: \${${unresolvedAppPassword.varName}} at ${unresolvedAppPassword.path}` +
        " — not in env, ~/.comis/.env, or the encrypted secret store",
      "Set the variable in the environment or store it via comis secrets set",
    );
  }
  if (!appPasswordPresent(msteams.appPassword)) {
    return finding(
      "fail",
      check,
      "appPassword is empty but secret mode requires an app password / client secret",
      "Set channels.msteams.appPassword (or a ${VAR} ref resolvable via env or comis secrets set)",
    );
  }
  return finding("pass", check, "secret-mode credentials resolved");
}

// ---------------------------------------------------------------------------
// Probe 2: endpoint-reachable
// ---------------------------------------------------------------------------

async function endpointReachableFinding(
  gatewayUrl: string | undefined,
): Promise<DoctorFinding> {
  const check = "Teams endpoint";
  if (gatewayUrl === undefined) {
    return finding("skip", check, "Endpoint not checked — no gateway URL configured");
  }

  const url = `${gatewayUrl.replace(/\/+$/, "")}${MSTEAMS_ENDPOINT_PATH}`;
  let status: number;
  try {
    // Unauth probe: no Authorization header. The ingress rejects at its
    // bearer-presence pre-gate (401) BEFORE reading a body — no secret is sent
    // and no body is processed, so this reads only the status code.
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(ENDPOINT_PROBE_TIMEOUT_MS),
    });
    status = response.status;
  } catch {
    // Connection refused / timeout / DNS — the daemon or gateway is unreachable.
    return finding(
      "skip",
      check,
      `Endpoint not reachable at ${url} — daemon/gateway may be down`,
    );
  }

  if (status === 401 || status === 405) {
    return finding(
      "pass",
      check,
      `Ingress mounted at ${MSTEAMS_ENDPOINT_PATH} (rejects an unauthenticated request with ${status})`,
    );
  }
  if (status === 404) {
    return finding(
      "fail",
      check,
      `The inbound route ${MSTEAMS_ENDPOINT_PATH} returned 404 — the Teams ingress is not mounted`,
      "Ensure the Teams channel is enabled so the gateway mounts its ingress (check the daemon startup logs)",
    );
  }
  return finding(
    "warn",
    check,
    `The unauth probe to ${MSTEAMS_ENDPOINT_PATH} returned an unexpected ${status} (expected 401/405 mounted, or 404 absent)`,
    "Inspect the gateway route table and the daemon logs",
  );
}

// ---------------------------------------------------------------------------
// Probe 3: recent-inbound (INBOUND-ONLY lastInboundAt, never last-activity)
// ---------------------------------------------------------------------------

async function recentInboundFinding(): Promise<DoctorFinding> {
  const check = "Teams recent inbound";

  // Only probe a daemon that is actually up — a down daemon is the daemon
  // check's signal, not a recent-inbound verdict.
  const daemonUp = await isDaemonRunning(LIVENESS_PROBE_TIMEOUT_MS);
  if (!daemonUp) {
    return finding("skip", check, "Recent-inbound not checked — daemon not reachable");
  }

  let lastInboundAt: number | null | undefined;
  let found = false;
  try {
    const health = await withClient((client) =>
      callTyped(client, ChannelsHealthContract, {}),
    );
    const entry = health.channels.find((c) => c.channelType === CHANNEL_TYPE);
    if (entry !== undefined) {
      found = true;
      lastInboundAt = entry.lastInboundAt;
    }
  } catch (e) {
    return finding(
      "skip",
      check,
      `Recent-inbound not checked — channel-status RPC failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!found) {
    return finding(
      "warn",
      check,
      "No Teams adapter is reporting health — the channel may be enabled in config but not running",
      "Check that the Teams adapter started (see the daemon/channel doctor findings and the daemon logs)",
    );
  }

  if (lastInboundAt === null || lastInboundAt === undefined) {
    // Null even when last-activity may be fresh: a send-only bot. Webhook
    // channels are stale-reap-exempt, so this inbound-only signal — not
    // last-activity — is the liveness check for a dead ingress.
    return finding(
      "warn",
      check,
      "No inbound Teams activity recorded — the ingress has received nothing. This inbound-only signal (not last-activity) is the liveness check, since a webhook channel is exempt from stale detection.",
      `Verify the Bot Framework messaging endpoint points at this gateway's ${MSTEAMS_ENDPOINT_PATH} route`,
    );
  }

  const ageMs = systemNowMs() - lastInboundAt;
  if (ageMs > RECENT_INBOUND_WINDOW_MS) {
    return finding(
      "warn",
      check,
      `Last inbound Teams activity was ${Math.floor(ageMs / 60_000)} min ago, beyond the ${RECENT_INBOUND_WINDOW_HOURS}h recency window`,
      "If you expect steady inbound traffic, the ingress may be dead — verify the messaging endpoint and the app registration",
    );
  }

  return finding(
    "pass",
    check,
    `Recent inbound Teams activity within the last ${RECENT_INBOUND_WINDOW_HOURS}h`,
  );
}

// ---------------------------------------------------------------------------
// Probe 4: tenant-present
// ---------------------------------------------------------------------------

function tenantPresentFinding(msteams: MsTeamsConfigView): DoctorFinding {
  const check = "Teams tenant";
  if (isBlank(msteams.tenantId)) {
    return finding(
      "fail",
      check,
      "tenantId is not set — Teams requires a single-tenant directory (tenant) ID",
      "Set channels.msteams.tenantId to your Entra directory (tenant) ID",
    );
  }
  return finding("pass", check, "tenantId present");
}

/**
 * Doctor check: Microsoft Teams health.
 *
 * Never throws — every probe returns a finding (or degrades to `skip` when the
 * daemon/gateway is unreachable). Returns a single `skip` when Teams is not
 * enabled or the config did not resolve.
 */
export const msteamsHealthCheck: DoctorCheck = {
  id: "msteams-health",
  name: "Microsoft Teams",
  run: async (context) => {
    const channels = context.config?.channels as
      | { msteams?: MsTeamsConfigView }
      | undefined;
    const msteams = channels?.msteams;

    if (msteams === undefined) {
      // A valid config always carries a channels section (schema defaults), so
      // reaching here means the config itself did not resolve — say WHY.
      const why = describeConfigUnavailable(context.configResolution);
      return [
        finding(
          "skip",
          "Teams config",
          why !== undefined
            ? `Teams health not checked — ${why}`
            : "Microsoft Teams not configured",
        ),
      ];
    }

    if (msteams.enabled !== true) {
      return [finding("skip", "Teams enabled", "Microsoft Teams channel not enabled")];
    }

    return [
      credsParseFinding(msteams, context),
      tenantPresentFinding(msteams),
      await endpointReachableFinding(context.gatewayUrl),
      await recentInboundFinding(),
    ];
  },
};
