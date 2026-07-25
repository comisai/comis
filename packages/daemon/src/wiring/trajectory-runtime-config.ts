// SPDX-License-Identifier: Apache-2.0
import type { AppConfig } from "@comis/core";

export interface EffectiveTrajectoryConfig {
  readonly enabled: boolean;
  readonly dir?: string;
  readonly maxFileBytes: number;
  readonly eventTypes?: readonly string[];
}

export function resolveEffectiveTrajectoryConfig(
  config: AppConfig,
): EffectiveTrajectoryConfig;
export function resolveEffectiveTrajectoryConfig(
  config: Pick<AppConfig, "diagnostics" | "observability">,
): EffectiveTrajectoryConfig | undefined;
export function resolveEffectiveTrajectoryConfig(
  config: Pick<AppConfig, "diagnostics" | "observability">,
): EffectiveTrajectoryConfig | undefined {
  const trajectory = config.diagnostics?.trajectory;
  if (trajectory === undefined) return undefined;
  const dir = trajectory.dir ?? config.observability?.trajectory?.dirOverride;
  return {
    enabled: trajectory.enabled,
    ...(dir !== undefined ? { dir } : {}),
    maxFileBytes: trajectory.maxFileBytes,
    ...(trajectory.eventTypes !== undefined
      ? { eventTypes: trajectory.eventTypes }
      : {}),
  };
}
