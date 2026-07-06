// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix health check for `comis doctor`.
 *
 * Matrix is a polling channel: it authenticates to a homeserver over the
 * Client-Server API and long-polls `/sync` — there is no inbound webhook route
 * to probe. So an operator needs a one-command answer to "is my Matrix bot
 * healthy?", which this check provides via five polling-flavored probes:
 *
 *   1. creds-parse         — a homeserver URL plus a token (or a password with
 *                            a userId) are present, and any `${VAR}` reference
 *                            resolved. The token VALUE is never read or printed
 *                            — only an unresolved `${VAR}` name and its config
 *                            path surface in a finding.
 *   2. reachability        — the live adapter state + error over the
 *                            channel-status RPC. The probe NEVER touches the
 *                            adapter or the homeserver directly — the daemon
 *                            owns live adapter state and surfaces it over RPC.
 *   3. e2ee-backend        — end-to-end encryption is on by default, so an
 *                            enabled channel whose live entry carries no
 *                            verification block means the crypto backend failed
 *                            to initialize. Skipped when e2ee is off.
 *   4. device-verification — the cross-signing / device-verified booleans over
 *                            RPC. Unverified is a supported posture, so this is
 *                            a `warn` (loud), never a `fail` (fatal).
 *   5. state-dir           — the durable state directory (sync token + device
 *                            identity) is best-effort writable. A `warn`, never
 *                            a hard `fail`: the daemon may run on another host.
 *
 * The reachability / e2ee / device-verification probes degrade to `skip` when
 * the daemon is unreachable (mirrors the other daemon-dependent doctor checks) —
 * a down daemon is never reported healthy, so there is no silent false-OK. The
 * verification read is booleans only: no key material, device key, or crypto
 * store is ever touched.
 *
 * @module
 */

import { existsSync, accessSync, constants as FS } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ChannelsHealthContract } from "@comis/core";
import type { DoctorCheck, DoctorContext, DoctorFinding, DoctorStatus } from "../types.js";
import { describeConfigUnavailable } from "../config-resolve.js";
import { isDaemonRunning } from "../../sync-tooling/daemon-guard.js";
import { withClient, callTyped } from "../../client/rpc-client.js";

const CATEGORY = "channels";
const CHANNEL_TYPE = "matrix";

/** Liveness-probe timeout before the channel-status RPC read. */
const LIVENESS_PROBE_TIMEOUT_MS = 1_000;

/**
 * Minimal view of the resolved `channels.matrix` config block the probes read.
 * `accessToken` / `password` are `string | SecretRef` (a `${VAR}` string ref is
 * substituted by the shared resolution when it resolves; a SecretRef object is
 * present as-is). `e2ee` defaults to `true` in the schema, so absence means ON.
 */
interface MatrixConfigView {
  readonly enabled?: boolean;
  readonly e2ee?: boolean;
  readonly stateDir?: string;
  readonly homeserverUrl?: string;
  readonly userId?: string;
  readonly accessToken?: unknown;
  readonly password?: unknown;
}

/** The subset of the channel-status RPC entry the Matrix probes read. */
interface MatrixHealthEntry {
  readonly state?: string;
  readonly error?: string | null;
  readonly verification?: {
    readonly crossSigningReady: boolean;
    readonly deviceVerified: boolean;
  };
}

/** A string value is blank when absent or all-whitespace. */
function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === "";
}

/**
 * A credential (accessToken / password) is present when it is a non-blank
 * string (an inline or resolved `${VAR}`) or a SecretRef object (its resolution
 * is a store concern, not verifiable offline — presence of the object is what
 * this probe asserts).
 */
function credPresent(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  return value !== undefined && value !== null;
}

/** Compact finding constructor (all matrix findings are non-repairable). */
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

/** Outcome of the single channel-status RPC read shared by the live probes. */
type LiveRead =
  | { readonly kind: "daemon-down" }
  | { readonly kind: "rpc-error"; readonly message: string }
  | { readonly kind: "ok"; readonly entry: MatrixHealthEntry | undefined };

/**
 * Read the live Matrix adapter entry over the channel-status RPC, once, gated on
 * a liveness probe. The three live probes share this result so a single enabled
 * run makes at most one RPC call. Never throws — a down daemon or a failed RPC
 * degrades to a `skip`-shaped result the probes surface as `skip` (not `pass`).
 */
async function readMatrixEntry(): Promise<LiveRead> {
  const daemonUp = await isDaemonRunning(LIVENESS_PROBE_TIMEOUT_MS);
  if (!daemonUp) return { kind: "daemon-down" };
  try {
    const health = await withClient((client) =>
      callTyped(client, ChannelsHealthContract, {}),
    );
    const entry = health.channels.find((c) => c.channelType === CHANNEL_TYPE) as
      | MatrixHealthEntry
      | undefined;
    return { kind: "ok", entry };
  } catch (e) {
    return { kind: "rpc-error", message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Probe 1: creds-parse
// ---------------------------------------------------------------------------

/**
 * The Matrix credential config paths that may carry a `${VAR}` SecretRef — an
 * unresolved ref on any of them is a login-blocking misconfiguration the offline
 * creds probe names early.
 */
const MATRIX_CREDENTIAL_PATHS = [
  "channels.matrix.accessToken",
  "channels.matrix.password",
  "channels.matrix.recoveryKey",
] as const;

/**
 * Presence + resolution of the login credentials. Mirrors the field-presence
 * preconditions the adapter enforces (homeserver required; a token OR a
 * password; a password login also needs a userId) and additionally flags an
 * UNRESOLVED `${VAR}` reference on any credential (accessToken / password /
 * recoveryKey). The credential VALUE is never read — only the `${VAR}` name and
 * the config path appear in the finding.
 */
function credsParseFinding(matrix: MatrixConfigView, context: DoctorContext): DoctorFinding {
  const check = "Matrix credentials";

  // Any of the three Matrix credential fields can carry a ${VAR} SecretRef; an
  // unresolved ref on ANY of them is an offline failure worth naming early, not
  // just accessToken (a password-login or recovery-key ref that fails to resolve
  // would otherwise only surface later at the live reachability probe).
  const unresolved = (context.configResolution?.unresolvedRefs ?? []).find((ref) =>
    MATRIX_CREDENTIAL_PATHS.some((path) => ref.path.startsWith(path)),
  );
  if (unresolved !== undefined) {
    return finding(
      "fail",
      check,
      `Unresolved credential reference: \${${unresolved.varName}} at ${unresolved.path}` +
        " — not in env, ~/.comis/.env, or the encrypted secret store",
      "Set the variable in the environment or store it via comis secrets set",
    );
  }

  if (isBlank(matrix.homeserverUrl)) {
    return finding(
      "fail",
      check,
      "homeserverUrl is empty but Matrix requires a homeserver base URL to authenticate",
      "Set channels.matrix.homeserverUrl to the homeserver's Client-Server API base URL",
    );
  }

  if (!credPresent(matrix.accessToken) && !credPresent(matrix.password)) {
    return finding(
      "fail",
      check,
      "no access token or password is set — Matrix needs one credential to authenticate",
      "Set channels.matrix.accessToken (or a ${VAR} ref resolvable via env or comis secrets set), or a password",
    );
  }

  if (credPresent(matrix.password) && isBlank(matrix.userId)) {
    return finding(
      "fail",
      check,
      "userId is empty but a password login requires the full bot MXID",
      "Set channels.matrix.userId to the bot's full MXID (for example @bot:example.org)",
    );
  }

  return finding("pass", check, "homeserver and login credentials resolved");
}

// ---------------------------------------------------------------------------
// Probe 2: reachability (live adapter state over RPC)
// ---------------------------------------------------------------------------

/**
 * The live adapter state, read over the channel-status RPC. A connected,
 * syncing adapter proves the credentials reached the homeserver and the login
 * (whoami) succeeded; an errored/disconnected adapter surfaces its error.
 */
function reachabilityFinding(read: LiveRead): DoctorFinding {
  const check = "Matrix reachability";

  if (read.kind === "daemon-down") {
    return finding("skip", check, "Reachability not checked — daemon not reachable");
  }
  if (read.kind === "rpc-error") {
    return finding(
      "skip",
      check,
      `Reachability not checked — channel-status RPC failed: ${read.message}`,
    );
  }

  const entry = read.entry;
  if (entry === undefined) {
    return finding(
      "warn",
      check,
      "No Matrix adapter is reporting health — the channel may be enabled in config but not running",
      "Check that the Matrix adapter started (see the daemon/channel doctor findings and the daemon logs)",
    );
  }

  const state = entry.state ?? "unknown";
  const errorSuffix = isBlank(entry.error ?? undefined) ? "" : ` (${entry.error})`;

  if (state === "errored" || state === "disconnected") {
    return finding(
      "fail",
      check,
      `The Matrix adapter is ${state}${errorSuffix}`,
      "Verify the homeserver URL and access token, then inspect the daemon logs for the sync failure",
    );
  }

  if (state === "healthy" || state === "idle" || state === "startup-grace") {
    return finding("pass", check, `The Matrix adapter is connected and syncing (state: ${state})`);
  }

  return finding(
    "warn",
    check,
    `The Matrix adapter state is ${state}${errorSuffix}`,
    "Inspect the daemon logs and the channel health findings",
  );
}

// ---------------------------------------------------------------------------
// Probe 3: e2ee backend loads (e2ee defaults true → gate on !== false)
// ---------------------------------------------------------------------------

/**
 * Whether the end-to-end-encryption crypto backend actually initialized. The
 * live entry carries a `verification` block only when a crypto backend is
 * active; e2ee is on by default, so an enabled channel with no verification
 * block means the backend failed to load. Skipped when e2ee is off.
 */
function e2eeBackendFinding(matrix: MatrixConfigView, read: LiveRead): DoctorFinding {
  const check = "Matrix e2ee";

  if (matrix.e2ee === false) {
    return finding("skip", check, "End-to-end encryption is disabled — crypto backend not checked");
  }
  if (read.kind === "daemon-down") {
    return finding("skip", check, "E2EE backend not checked — daemon not reachable");
  }
  if (read.kind === "rpc-error") {
    return finding(
      "skip",
      check,
      `E2EE backend not checked — channel-status RPC failed: ${read.message}`,
    );
  }

  const entry = read.entry;
  if (entry === undefined) {
    return finding("skip", check, "E2EE backend not checked — no live Matrix adapter is reporting");
  }

  if (entry.verification === undefined) {
    return finding(
      "warn",
      check,
      "End-to-end encryption is enabled but no crypto backend is active — the crypto store likely failed to initialize",
      "Check the daemon startup logs for a crypto-store init failure (state-directory permissions or a corrupt store)",
    );
  }

  return finding("pass", check, "the end-to-end encryption crypto backend is active");
}

// ---------------------------------------------------------------------------
// Probe 4: device-verification (booleans only; unverified is loud, not fatal)
// ---------------------------------------------------------------------------

/**
 * The device-trust posture, read as booleans over RPC — never any key material.
 * Unverified operation is fully supported, so an unverified device is a `warn`
 * (a trust-surface note), never a `fail`.
 */
function deviceVerificationFinding(matrix: MatrixConfigView, read: LiveRead): DoctorFinding {
  const check = "Matrix device verification";

  if (matrix.e2ee === false) {
    return finding("skip", check, "End-to-end encryption is disabled — device verification not applicable");
  }
  if (read.kind === "daemon-down") {
    return finding("skip", check, "Device verification not checked — daemon not reachable");
  }
  if (read.kind === "rpc-error") {
    return finding(
      "skip",
      check,
      `Device verification not checked — channel-status RPC failed: ${read.message}`,
    );
  }

  const entry = read.entry;
  if (entry === undefined || entry.verification === undefined) {
    return finding(
      "skip",
      check,
      "Device verification not checked — no active crypto backend is reporting verification state",
    );
  }

  const { crossSigningReady, deviceVerified } = entry.verification;
  if (crossSigningReady && deviceVerified) {
    return finding("pass", check, "the bot device is verified and cross-signing is ready");
  }

  const missing: string[] = [];
  if (!deviceVerified) missing.push("the device is not verified");
  if (!crossSigningReady) missing.push("cross-signing is not set up");
  return finding(
    "warn",
    check,
    `End-to-end encryption is active but ${missing.join(" and ")} — encrypted senders may see an unverified-device warning`,
    "Verify the bot device from an already-verified session (unverified operation is supported — this is a trust-surface note, not a failure)",
  );
}

// ---------------------------------------------------------------------------
// Probe 5: state-dir writable (best-effort — warn, never a hard fail)
// ---------------------------------------------------------------------------

/**
 * Best-effort writability of the durable state directory (sync token + device
 * identity). The daemon may run on a different host than the CLI, so an absent
 * or non-writable directory is a `warn`, never a hard `fail`.
 */
function stateDirFinding(matrix: MatrixConfigView): DoctorFinding {
  const check = "Matrix state directory";
  const stateDir = isBlank(matrix.stateDir)
    ? join(homedir(), ".comis", "matrix-state")
    : matrix.stateDir!;

  if (!existsSync(stateDir)) {
    return finding(
      "warn",
      check,
      `The state directory ${stateDir} does not exist on this host yet`,
      "If the daemon runs on another host this is expected; otherwise it is created on first start — verify channels.matrix.stateDir",
    );
  }

  try {
    accessSync(stateDir, FS.W_OK);
  } catch {
    return finding(
      "warn",
      check,
      `The state directory ${stateDir} exists but is not writable by this user`,
      "Fix the directory permissions so the daemon can persist the sync token and device identity",
    );
  }

  return finding("pass", check, `the state directory ${stateDir} is present and writable`);
}

/**
 * Doctor check: Matrix health.
 *
 * Never throws — every probe returns a finding (or degrades to `skip` when the
 * daemon is unreachable). Returns a single `skip` when Matrix is not enabled or
 * the config did not resolve.
 */
export const matrixHealthCheck: DoctorCheck = {
  id: "matrix-health",
  name: "Matrix",
  run: async (context) => {
    const channels = context.config?.channels as
      | { matrix?: MatrixConfigView }
      | undefined;
    const matrix = channels?.matrix;

    if (matrix === undefined) {
      // A valid config always carries a channels section (schema defaults), so
      // reaching here means the config itself did not resolve — say WHY.
      const why = describeConfigUnavailable(context.configResolution);
      return [
        finding(
          "skip",
          "Matrix config",
          why !== undefined ? `Matrix health not checked — ${why}` : "Matrix not configured",
        ),
      ];
    }

    if (matrix.enabled !== true) {
      return [finding("skip", "Matrix enabled", "Matrix channel not enabled")];
    }

    // Single channel-status RPC read shared by the live probes — the CLI never
    // touches the adapter, homeserver, or crypto store; the daemon owns live
    // state and surfaces booleans over RPC.
    const read = await readMatrixEntry();

    return [
      credsParseFinding(matrix, context),
      reachabilityFinding(read),
      e2eeBackendFinding(matrix, read),
      deviceVerificationFinding(matrix, read),
      stateDirFinding(matrix),
    ];
  },
};
