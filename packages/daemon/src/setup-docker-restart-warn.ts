// SPDX-License-Identifier: Apache-2.0
/**
 * Boot-time WARN that fires inside Docker containers, telling the operator
 * that wizard "Restart" actions and any `gateway.*` config-reload action
 * (`gateway.restart`, `gateway.env_set`, `gateway.patch` on restart-triggering
 * paths) all rely on the container's restart policy to bring the daemon back.
 *
 * Without `--restart unless-stopped` (or compose `restart: unless-stopped`)
 * the container exits and stays exited the first time the user clicks
 * "Restart" in the wizard, producing a silent "comis status: offline" with
 * no breadcrumb in `docker logs` pointing at the missing flag. This WARN
 * is that breadcrumb.
 *
 * Pure function over an injected logger and an optional `isDocker` probe
 * (defaulting to the real one from `@comis/infra`) so it is unit-testable
 * without spinning up the daemon harness.
 *
 * @module
 */
import { isDocker as defaultIsDocker } from "@comis/infra";
import type { ComisLogger } from "@comis/infra";

export function emitDockerRestartPolicyWarn(
  logger: ComisLogger,
  opts: { isDocker?: () => boolean } = {},
): void {
  const probe = opts.isDocker ?? defaultIsDocker;
  if (!probe()) return;
  logger.warn(
    {
      hint:
        "Wizard 'Restart' actions, gateway.restart, gateway.env_set, and gateway.patch on restart-triggering paths all require the container to have --restart unless-stopped (or compose restart: unless-stopped). Verify from your host with: docker inspect <name> --format '{{.HostConfig.RestartPolicy.Name}}'",
      errorKind: "config" as const,
      module: "daemon" as const,
    },
    "Running in Docker — restart policy required for config-reload operations",
  );
}
