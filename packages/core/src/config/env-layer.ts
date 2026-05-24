// SPDX-License-Identifier: Apache-2.0
/**
 * Operational env-var → config-layer projection.
 *
 * Bridges container/systemd/pm2 deployments to layered config without a
 * config.yaml. Currently supported:
 *
 *   COMIS_GATEWAY_HOST → gateway.host (e.g. "0.0.0.0" inside the Docker image)
 *   COMIS_GATEWAY_PORT → gateway.port
 *   COMIS_TRAJECTORY_DIR → observability.trajectory.dirOverride (POINTER-02)
 *
 * The returned object is a partial config layer fed to mergeLayered() at
 * lower priority than YAML files: schema defaults < env layer < config.yaml.
 * This keeps explicit user config authoritative — a `gateway.host: 127.0.0.1`
 * in config.yaml is never silently broadened to 0.0.0.0 by an inherited env
 * var, preserving the secure-by-default contract on `gateway.host`.
 *
 * Empty-string host and non-numeric / out-of-range ports are dropped so a
 * typo never silently relocates the daemon. Same drop semantics apply to
 * COMIS_TRAJECTORY_DIR so an empty-string env var doesn't override the default.
 *
 * @module
 */

/** Subset of env vars consumed by this projection. */
export interface GatewayEnvSource {
  COMIS_GATEWAY_HOST?: string | undefined;
  COMIS_GATEWAY_PORT?: string | undefined;
  /** Relocates runtime trajectory JSONL files to a custom directory (POINTER-02). */
  COMIS_TRAJECTORY_DIR?: string | undefined;
}

/**
 * Build a partial config layer from env vars. Returns an empty object when
 * no relevant env vars are set (callers can pass through to mergeLayered
 * unconditionally without affecting precedence).
 */
export function buildGatewayEnvLayer(env: GatewayEnvSource): Record<string, unknown> {
  const gateway: Record<string, unknown> = {};

  const rawHost = env.COMIS_GATEWAY_HOST;
  if (typeof rawHost === "string" && rawHost.length > 0) {
    gateway["host"] = rawHost;
  }

  const rawPort = env.COMIS_GATEWAY_PORT;
  if (typeof rawPort === "string" && rawPort.length > 0) {
    const parsed = Number.parseInt(rawPort, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65_535) {
      gateway["port"] = parsed;
    }
  }

  // POINTER-02: project COMIS_TRAJECTORY_DIR → observability.trajectory.dirOverride.
  // Drop empty / whitespace-only values so a typo never silently relocates trajectory files.
  let observability: Record<string, unknown> | undefined;
  const rawTrajectoryDir = env.COMIS_TRAJECTORY_DIR;
  if (typeof rawTrajectoryDir === "string") {
    const trimmed = rawTrajectoryDir.trim();
    if (trimmed.length > 0) {
      observability = { trajectory: { dirOverride: trimmed } };
    }
  }

  return {
    ...(Object.keys(gateway).length > 0 ? { gateway } : {}),
    ...(observability !== undefined ? { observability } : {}),
  };
}
