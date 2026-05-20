// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal pino-compatible logger interface for the gateway.
 *
 * Lives in its own module so both the hono server and oauth-callback route
 * can import it without forming a cycle (the server imports the route's
 * factory; the route needs the logger type for its deps).
 */
export interface GatewayLogger {
  trace(msg: string): void;
  trace(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}
