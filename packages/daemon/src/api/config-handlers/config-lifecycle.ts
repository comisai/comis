// SPDX-License-Identifier: Apache-2.0
/** Post-persistence lifecycle containment for config mutation handlers. */
import { createHash } from "node:crypto";
import { ok, tryCatch, type Result } from "@comis/shared";
import type { ConfigHandlerDeps } from "./config-helpers.js";

export function runCommittedConfigLifecycle(
  deps: ConfigHandlerDeps,
  nextConfig: Parameters<NonNullable<ConfigHandlerDeps["onConfigPersisted"]>>[0],
  method: "config.patch" | "config.apply",
): Result<void, Error> {
  const hook = deps.onConfigPersisted;
  if (hook === undefined) return ok(undefined);
  const lifecycle = tryCatch(() => hook(nextConfig));
  if (!lifecycle.ok) {
    deps.logger.error({
      method,
      step: "committed_config_lifecycle",
      errorKind: "internal" as const,
      hint: "Inspect the daemon config lifecycle hook; the persisted config will still take effect at the scheduled restart",
    }, "Committed config lifecycle failed");
    deps.logger.debug({
      method,
      step: "committed_config_lifecycle",
      err: lifecycle.error,
    }, "Committed config lifecycle failure detail");
  }
  return lifecycle;
}

/** Content-free audit indicator that never exposes the mutated config value. */
export function valueChangeIndicator(
  value: unknown,
): { valueSha256: string; valueLength: number } {
  const str = value === undefined ? "" : JSON.stringify(value) ?? "";
  return {
    valueSha256: createHash("sha256").update(str).digest("hex").slice(0, 12),
    valueLength: str.length,
  };
}
