// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat health check for `comis doctor`.
 *
 * Google Chat defaults to a Cloud Pub/Sub pull transport (no public IP) with an
 * opt-in Bearer-JWT-verified webhook mode. A webhook ingress is exempt from the
 * health monitor's stale-reap (a webhook has no socket to go quiet), so a dead
 * ingress would never surface through the monitor. An operator therefore needs a
 * one-command answer to "is my Google Chat app actually receiving?" — which this
 * check provides via four probes:
 *
 *   1. creds-parse    — the service-account key parses into a key JSON carrying
 *                       the two fields the outbound JWT mint needs (private_key
 *                       and client_email). Secret-safe: the raw key text is never
 *                       placed in a finding — only a missing field/requirement is
 *                       named. A ${VAR} reference that nothing resolved is named
 *                       (never its value).
 *   2. inbound path   — branches on transport mode. pubsub: an OFFLINE presence
 *                       check that the pull subscription is configured (a blank
 *                       subscription names the roles/pubsub.subscriber grant the
 *                       service account needs — no live Pub/Sub call is made).
 *                       webhook: an UNAUTH request to the mounted
 *                       /channels/googlechat route — 401/405 means the ingress is
 *                       mounted and rejecting unauth (good); 404 means the route
 *                       is absent (misconfigured).
 *   3. recent-inbound — the INBOUND-ONLY lastInboundAt read over the channel-
 *                       status RPC. It is NEVER a conflated last-activity signal:
 *                       an outbound send bumps last-activity, so a send-only app
 *                       would read as healthy on last-activity while its ingress
 *                       is dead. The probe reads the dedicated inbound signal so
 *                       that case is caught.
 *   4. allowlist lint — an email-shaped allowFrom entry surfaces a warn steering
 *                       the operator toward the immutable users/{id} resource id
 *                       (an email display id is mutable and spoofable).
 *
 * The webhook endpoint + recent-inbound probes degrade to `skip` when the
 * daemon/gateway is unreachable (mirrors the other daemon-dependent doctor
 * checks). The probe never calls the adapter directly — the daemon owns live
 * adapter state and surfaces it over RPC. This check is self-contained: it
 * inlines a secret-safe key parse and the email-shaped predicate rather than
 * importing channel code.
 *
 * @module
 */

import { ChannelsHealthContract, systemNowMs } from "@comis/core";
import type { DoctorCheck, DoctorContext, DoctorFinding, DoctorStatus } from "../types.js";
import { describeConfigUnavailable } from "../config-resolve.js";
import { isDaemonRunning } from "../../sync-tooling/daemon-guard.js";
import { withClient, callTyped } from "../../client/rpc-client.js";

const CATEGORY = "channels";
const CHANNEL_TYPE = "googlechat";

/** The mounted webhook inbound route (relative to the gateway origin). */
const GOOGLECHAT_ENDPOINT_PATH = "/channels/googlechat";

/** Endpoint-probe HTTP timeout. */
const ENDPOINT_PROBE_TIMEOUT_MS = 3_000;
/** Liveness-probe timeout before the recent-inbound RPC. */
const LIVENESS_PROBE_TIMEOUT_MS = 1_000;
/**
 * Recent-inbound recency window. A `warn` (never `fail`): a quiet channel may be
 * legitimate, but zero inbound in a full day on a health check is worth flagging
 * as a possible dead ingress. The continuous liveness monitor is a separate
 * concern; this is the point-in-time doctor read.
 */
const RECENT_INBOUND_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_INBOUND_WINDOW_HOURS = RECENT_INBOUND_WINDOW_MS / 3_600_000;

/**
 * Minimal view of the resolved `channels.googlechat` config block the probes
 * read. `serviceAccountKey` is `string | SecretRef`: a resolved `${VAR}` string
 * ref (or an inline JSON blob) is a string; a SecretRef object is present as-is
 * (its resolution is a store concern, not verifiable offline).
 */
interface GoogleChatConfigView {
  readonly enabled?: boolean;
  readonly mode?: "pubsub" | "webhook";
  readonly serviceAccountKey?: unknown;
  readonly subscriptionName?: string;
  readonly audienceType?: "project-number" | "app-url";
  readonly audience?: string;
  readonly allowFrom?: readonly string[];
}

/** A value is blank when absent or all-whitespace. */
function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === "";
}

/**
 * True when an allowlist entry looks like a bare email address rather than an
 * immutable resource id. Entries that are already an immutable `users/{id}` or
 * `spaces/{id}` are exempt.
 */
function isEmailShaped(entry: string): boolean {
  if (entry.startsWith("users/") || entry.startsWith("spaces/")) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry);
}

/** Compact finding constructor (all googlechat findings are non-repairable). */
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
// Probe 1: creds-parse (service-account key) — SECRET-SAFE
// ---------------------------------------------------------------------------

function credsParseFinding(
  gc: GoogleChatConfigView,
  context: DoctorContext,
): DoctorFinding {
  const check = "Google Chat credentials";

  // A ${VAR} reference nothing resolved: name the reference, never its value.
  const unresolvedKey = (context.configResolution?.unresolvedRefs ?? []).find((ref) =>
    ref.path.startsWith("channels.googlechat.serviceAccountKey"),
  );
  if (unresolvedKey !== undefined) {
    return finding(
      "fail",
      check,
      `Unresolved serviceAccountKey reference: \${${unresolvedKey.varName}} at ${unresolvedKey.path}` +
        " — not in env, ~/.comis/.env, or the encrypted secret store",
      "Store the service-account key JSON via comis secrets set, or set the variable in the environment",
    );
  }

  const key = gc.serviceAccountKey;
  if (key === undefined || key === null) {
    return finding(
      "fail",
      check,
      "serviceAccountKey is not set — Google Chat requires a service-account key JSON",
      "Set channels.googlechat.serviceAccountKey (or a ${VAR} ref resolvable via env or comis secrets set)",
    );
  }

  // A SecretRef object resolves at daemon boot; its content is not verifiable
  // offline, so presence of the object is what this probe asserts.
  if (typeof key !== "string") {
    return finding(
      "pass",
      check,
      "serviceAccountKey present as a secret reference (parse verified at daemon boot)",
    );
  }
  if (isBlank(key)) {
    return finding(
      "fail",
      check,
      "serviceAccountKey is empty — Google Chat requires a service-account key JSON",
      "Set channels.googlechat.serviceAccountKey to the downloaded service-account key JSON",
    );
  }

  // Parse the service-account key. A parse failure is caught locally and turned
  // into a message that names the requirement — the raw string is never placed
  // in the message, so no key material can leak through the failure path.
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return finding(
      "fail",
      check,
      "serviceAccountKey did not parse as JSON — it must be a service-account key JSON",
      "Paste the full service-account key JSON downloaded from the Google Cloud console",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    return finding(
      "fail",
      check,
      "serviceAccountKey must be a service-account key JSON object",
      "Use the full service-account key JSON (an object with client_email and private_key)",
    );
  }

  // Assert the two fields the outbound JWT mint requires. The message names the
  // missing field only — its value is never read into the message.
  const fields = parsed as { private_key?: unknown; client_email?: unknown };
  const privateKey = typeof fields.private_key === "string" ? fields.private_key : undefined;
  const clientEmail = typeof fields.client_email === "string" ? fields.client_email : undefined;
  if (isBlank(privateKey)) {
    return finding(
      "fail",
      check,
      "serviceAccountKey is missing 'private_key'",
      "Use the full service-account key JSON downloaded from the Google Cloud console",
    );
  }
  if (isBlank(clientEmail)) {
    return finding(
      "fail",
      check,
      "serviceAccountKey is missing 'client_email'",
      "Use the full service-account key JSON downloaded from the Google Cloud console",
    );
  }
  return finding("pass", check, "service-account key parsed (private_key + client_email present)");
}

// ---------------------------------------------------------------------------
// Probe 2: inbound path — pubsub subscription presence OR webhook endpoint
// ---------------------------------------------------------------------------

async function subscriptionOrIngressFinding(
  gc: GoogleChatConfigView,
  gatewayUrl: string | undefined,
): Promise<DoctorFinding> {
  const check = "Google Chat inbound path";

  if (gc.mode === "webhook") {
    // Webhook mode receives inbound over the mounted gateway ingress.
    if (gatewayUrl === undefined) {
      return finding("skip", check, "Ingress not checked — no gateway URL configured");
    }
    const url = `${gatewayUrl.replace(/\/+$/, "")}${GOOGLECHAT_ENDPOINT_PATH}`;
    let status: number;
    try {
      // Unauth probe: no Authorization header. The ingress rejects at its
      // Bearer-JWT pre-gate (401) BEFORE reading a body — no secret is sent and
      // no body is processed, so this reads only the status code.
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
        `Ingress not reachable at ${url} — daemon/gateway may be down`,
      );
    }
    if (status === 401 || status === 405) {
      return finding(
        "pass",
        check,
        `Ingress mounted at ${GOOGLECHAT_ENDPOINT_PATH} (rejects an unauthenticated request with ${status})`,
      );
    }
    if (status === 404) {
      return finding(
        "fail",
        check,
        `The inbound route ${GOOGLECHAT_ENDPOINT_PATH} returned 404 — the Google Chat ingress is not mounted`,
        "Ensure webhook mode is enabled with the gateway running so it mounts the ingress (check the daemon startup logs)",
      );
    }
    return finding(
      "warn",
      check,
      `The unauth probe to ${GOOGLECHAT_ENDPOINT_PATH} returned an unexpected ${status} (expected 401/405 mounted, or 404 absent)`,
      "Inspect the gateway route table and the daemon logs",
    );
  }

  // pubsub mode (default): offline presence check of the pull subscription. No
  // live Pub/Sub call is made — a blank subscription names the IAM grant.
  if (isBlank(gc.subscriptionName)) {
    return finding(
      "fail",
      check,
      "subscriptionName is not set — pubsub mode pulls inbound from a Pub/Sub subscription",
      "Set channels.googlechat.subscriptionName to your pull subscription (projects/{project}/subscriptions/{name}) and grant the service account roles/pubsub.subscriber on it",
    );
  }
  return finding(
    "pass",
    check,
    "Pub/Sub pull subscription configured (grant the service account roles/pubsub.subscriber if inbound never arrives)",
  );
}

// ---------------------------------------------------------------------------
// Probe 3: recent-inbound (INBOUND-ONLY lastInboundAt, never last-activity)
// ---------------------------------------------------------------------------

async function recentInboundFinding(): Promise<DoctorFinding> {
  const check = "Google Chat recent inbound";

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
      "No Google Chat adapter is reporting health — the channel may be enabled in config but not running",
      "Check that the Google Chat adapter started (see the daemon/channel doctor findings and the daemon logs)",
    );
  }

  if (lastInboundAt === null || lastInboundAt === undefined) {
    // Null even when last-activity may be fresh: a send-only app. Webhook
    // channels are stale-reap-exempt, so this inbound-only signal — not
    // last-activity — is the liveness check for a dead ingress.
    return finding(
      "warn",
      check,
      "No inbound Google Chat activity recorded — the ingress has received nothing. This inbound-only signal (not last-activity) is the liveness check, since a webhook channel is exempt from stale detection.",
      "In pubsub mode verify the pull subscription and roles/pubsub.subscriber; in webhook mode verify the app's endpoint points at this gateway's /channels/googlechat route",
    );
  }

  const ageMs = systemNowMs() - lastInboundAt;
  if (ageMs > RECENT_INBOUND_WINDOW_MS) {
    return finding(
      "warn",
      check,
      `Last inbound Google Chat activity was ${Math.floor(ageMs / 60_000)} min ago, beyond the ${RECENT_INBOUND_WINDOW_HOURS}h recency window`,
      "If you expect steady inbound traffic, the ingress may be dead — verify the subscription (pubsub) or the app endpoint (webhook)",
    );
  }

  return finding(
    "pass",
    check,
    `Recent inbound Google Chat activity within the last ${RECENT_INBOUND_WINDOW_HOURS}h`,
  );
}

// ---------------------------------------------------------------------------
// Probe 4: email-shaped allowFrom lint
// ---------------------------------------------------------------------------

function emailAllowFromLintFindings(gc: GoogleChatConfigView): DoctorFinding[] {
  const check = "Google Chat allowlist";
  const entries = gc.allowFrom ?? [];
  const emailShaped = entries.filter(isEmailShaped);

  if (emailShaped.length === 0) {
    return [
      finding(
        "pass",
        check,
        "No email-shaped allowlist entries — allowFrom uses immutable resource ids (or is empty)",
      ),
    ];
  }

  return emailShaped.map((entry) =>
    finding(
      "warn",
      check,
      `allowFrom entry '${entry}' is an email display id, which is mutable and spoofable`,
      "Prefer the immutable users/{id} resource id in channels.googlechat.allowFrom",
    ),
  );
}

/**
 * Doctor check: Google Chat health.
 *
 * Never throws — every probe returns a finding (or degrades to `skip` when the
 * daemon/gateway is unreachable). Returns a single `skip` when Google Chat is
 * not enabled or the config did not resolve.
 */
export const googlechatHealthCheck: DoctorCheck = {
  id: "googlechat-health",
  name: "Google Chat",
  run: async (context) => {
    const channels = context.config?.channels as
      | { googlechat?: GoogleChatConfigView }
      | undefined;
    const gc = channels?.googlechat;

    if (gc === undefined) {
      // A valid config always carries a channels section (schema defaults), so
      // reaching here means the config itself did not resolve — say WHY.
      const why = describeConfigUnavailable(context.configResolution);
      return [
        finding(
          "skip",
          "Google Chat config",
          why !== undefined
            ? `Google Chat health not checked — ${why}`
            : "Google Chat not configured",
        ),
      ];
    }

    if (gc.enabled !== true) {
      return [finding("skip", "Google Chat enabled", "Google Chat channel not enabled")];
    }

    return [
      credsParseFinding(gc, context),
      await subscriptionOrIngressFinding(gc, context.gatewayUrl),
      await recentInboundFinding(),
      ...emailAllowFromLintFindings(gc),
    ];
  },
};
