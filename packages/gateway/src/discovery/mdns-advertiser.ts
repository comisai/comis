// SPDX-License-Identifier: Apache-2.0
/**
 * mDNS/Bonjour service advertiser for gateway discovery.
 *
 * Uses @homebridge/ciao to advertise the gateway on the local network
 * via mDNS (RFC 6762/6763). Clients on the LAN can automatically
 * discover the gateway for zero-config setup.
 */

import ciao from "@homebridge/ciao";
import type { CiaoService, Responder } from "@homebridge/ciao";

/**
 * Dependencies for the mDNS advertiser.
 */
export interface MdnsAdvertiserDeps {
  /** Gateway port to advertise */
  port: number;
  /** Service name (default: "Comis Gateway") */
  name?: string;
  /** Version string for TXT record (default: "0.0.1") */
  version?: string;
  /** Logger for info/error messages */
  logger: {
    info(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

/**
 * Handle returned by createMdnsAdvertiser for lifecycle management.
 */
export interface MdnsAdvertiserHandle {
  /** Start mDNS advertisement */
  advertise(): Promise<void>;
  /** Stop advertisement and clean up responder */
  stop(): Promise<void>;
  /** Returns whether the service is currently advertising */
  isAdvertising(): boolean;
}

/**
 * Create an mDNS/Bonjour service advertiser.
 *
 * Uses ciao's getResponder() singleton to create and manage a service
 * that advertises the gateway on the local network. The service includes
 * TXT records with version, API path, and capability information.
 *
 * Shutdown is best-effort: errors during stop are caught and logged
 * but not re-thrown, following the 61-02 pattern for cleanup operations.
 */
export function createMdnsAdvertiser(
  deps: MdnsAdvertiserDeps,
): MdnsAdvertiserHandle {
  const { port, logger } = deps;
  const name = deps.name ?? "Comis Gateway";
  const version = deps.version ?? "0.0.1";

  const responder: Responder = ciao.getResponder();
  const service: CiaoService = responder.createService({
    name,
    type: "http",
    port,
    txt: {
      version,
      path: "/v1",
      openai_compat: "true",
      acp: "stdio",
    },
  });

  let advertising = false;

  return {
    async advertise(): Promise<void> {
      await service.advertise();
      advertising = true;
      logger.info({ name, port, version }, "mDNS service advertised");
    },

    async stop(): Promise<void> {
      if (!advertising) {
        return;
      }

      try {
        await service.end();
        await responder.shutdown();
        advertising = false;
        logger.info({ name }, "mDNS service stopped");
      } catch (error: unknown) {
        // Shutdown must be best-effort (per 61-02 pattern)
        advertising = false;
        logger.error({ err: error, hint: "mDNS shutdown is best-effort; the service may already be stopped", errorKind: "network" as const }, "Failed to stop mDNS service cleanly");
      }
    },

    isAdvertising(): boolean {
      return advertising;
    },
  };
}
