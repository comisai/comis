// SPDX-License-Identifier: Apache-2.0
/** Shared check registry and store-aware context for diagnostic commands. */

import { existsSync } from "node:fs";
import * as os from "node:os";
import {
  parseConfigPaths,
  resolveConfigRuntimePaths,
  safePath,
  systemGetEnv,
} from "@comis/core";
import { readCliVersion } from "../util/cli-version.js";
import { channelHealthCheck } from "./checks/channel-health.js";
import { configHealthCheck } from "./checks/config-health.js";
import { daemonHealthCheck } from "./checks/daemon-health.js";
import { gatewayHealthCheck } from "./checks/gateway-health.js";
import { lcdHealthCheck } from "./checks/lcd-health.js";
import { msteamsHealthCheck } from "./checks/msteams-health.js";
import { oauthHealthCheck } from "./checks/oauth-health.js";
import { secretsAuditHealthCheck } from "./checks/secrets-audit-health.js";
import { versionSkewHealthCheck } from "./checks/version-skew-health.js";
import { workspaceHealthCheck } from "./checks/workspace-health.js";
import {
  resolveDoctorConfig,
  type ResolveDoctorConfigDeps,
} from "./config-resolve.js";
import type { DoctorCheck, DoctorContext } from "./types.js";

/** Complete diagnostic registry, shared by `doctor` and `health`. */
export const DIAGNOSTIC_CHECKS: readonly DoctorCheck[] = [
  configHealthCheck,
  daemonHealthCheck,
  gatewayHealthCheck,
  versionSkewHealthCheck,
  channelHealthCheck,
  msteamsHealthCheck,
  workspaceHealthCheck,
  oauthHealthCheck,
  secretsAuditHealthCheck,
  lcdHealthCheck,
];

/** Resolve configured paths or the standard per-user and system locations. */
export function resolveDefaultDiagnosticConfigPaths(
  rawPaths: string | undefined = systemGetEnv("COMIS_CONFIG_PATHS"),
  homeDir: string = os.homedir(),
): string[] {
  if (rawPaths !== undefined && rawPaths.length > 0) {
    const configuredPaths = parseConfigPaths(rawPaths);
    if (configuredPaths.length > 0) return configuredPaths;
  }

  return [
    safePath(homeDir, ".comis", "config.yaml"),
    safePath(homeDir, ".comis", "config.local.yaml"),
    safePath("/etc", "comis", "config.yaml"),
    safePath("/etc", "comis", "config.local.yaml"),
  ].filter((path) => existsSync(path));
}

/** Injectable runtime seams for hermetic diagnostic and support-bundle tests. */
export interface BuildDiagnosticContextDeps extends ResolveDoctorConfigDeps {
  readonly homeDir?: string;
  readonly cliVersion?: string;
}

/**
 * Build one config view for every diagnostic check using the same config and
 * runtime-path resolution contracts as daemon startup.
 */
export function buildDiagnosticContext(
  configPaths: string[],
  deps: BuildDiagnosticContextDeps = {},
): DoctorContext {
  const homeDir = deps.homeDir ?? os.homedir();
  const defaultDataDir = deps.defaultDataDir ?? safePath(homeDir, ".comis");
  const resolutionDeps: ResolveDoctorConfigDeps = {
    ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
    ...(deps.getEnv !== undefined ? { getEnv: deps.getEnv } : {}),
    ...(deps.getStoreSecret !== undefined ? { getStoreSecret: deps.getStoreSecret } : {}),
    ...(deps.defaultDataDir !== undefined || deps.homeDir !== undefined
      ? { defaultDataDir }
      : {}),
  };
  const configResolution = Object.keys(resolutionDeps).length > 0
    ? resolveDoctorConfig(configPaths, resolutionDeps)
    : resolveDoctorConfig(configPaths);
  const config = configResolution.config;
  const getEnv = deps.getEnv ?? systemGetEnv;
  const envDataDir = getEnv("COMIS_DATA_DIR");
  const runtimeConfig = config === undefined
    ? undefined
    : resolveConfigRuntimePaths(
        config,
        { COMIS_DATA_DIR: envDataDir ?? defaultDataDir },
        defaultDataDir,
      );
  const dataDir = runtimeConfig?.dataDir ?? envDataDir ?? defaultDataDir;
  const memoryDbPath = runtimeConfig?.memory.dbPath ?? safePath(dataDir, "memory.db");

  let gatewayUrl: string | undefined;
  if (config?.gateway.enabled === true) {
    const bindHost = config.gateway.host;
    const host = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
    const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const protocol = config.gateway.tls === undefined ? "http" : "https";
    gatewayUrl = `${protocol}://${urlHost}:${config.gateway.port}`;
  }

  return {
    config,
    configResolution,
    configPaths,
    dataDir,
    daemonPidFile: safePath(dataDir, "daemon.pid"),
    memoryDbPath,
    gatewayUrl,
    cliVersion: deps.cliVersion ?? readCliVersion(),
  };
}
