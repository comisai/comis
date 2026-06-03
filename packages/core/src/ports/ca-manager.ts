// SPDX-License-Identifier: Apache-2.0
/**
 * CaManagerPort: hexagonal boundary for TLS CA management.
 *
 * NodeMitmBroker accepts an optional CaManagerPort; when undefined, the broker
 * passes the TCP stream opaque (no TLS termination). The concrete NodeCaManager
 * adapter lives in @comis/infra.
 *
 * Type-only file — no runtime values. Adapter lives in @comis/infra.
 *
 * @module
 */
import type { SecureContext } from "node:tls";

export interface CaManagerPort {
  /** Returns a TLS SecureContext for MITM-terminating this hostname,
   *  or undefined if TLS termination is not available (pass-through). */
  serverContextForHost(host: string): Promise<SecureContext | undefined>;
}
