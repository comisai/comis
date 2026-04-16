/**
 * Gateway health check for comis doctor.
 *
 * Verifies that the gateway is reachable by attempting a TCP connection
 * to the configured gateway URL. Skips if no gateway URL is configured.
 *
 * @module
 */

import * as net from "node:net";
import type { DoctorCheck, DoctorFinding } from "../types.js";

const CATEGORY = "gateway";
const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Parse host and port from a gateway URL.
 *
 * Handles URLs like "http://localhost:3000", "https://gw.example.com:443",
 * or bare "host:port" format.
 */
function parseHostPort(url: string): { host: string; port: number } | null {
  try {
    // Try as full URL first
    if (url.startsWith("http://") || url.startsWith("https://")) {
      const parsed = new URL(url);
      const port = parsed.port
        ? Number(parsed.port)
        : parsed.protocol === "https:" ? 443 : 80;
      return { host: parsed.hostname, port };
    }

    // Try as host:port
    const colonIdx = url.lastIndexOf(":");
    if (colonIdx > 0) {
      const host = url.slice(0, colonIdx);
      const port = Number(url.slice(colonIdx + 1));
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        return { host, port };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Doctor check: gateway connectivity.
 *
 * Attempts a TCP connection to the gateway URL to verify reachability.
 */
export const gatewayHealthCheck: DoctorCheck = {
  id: "gateway-health",
  name: "Gateway",
  run: async (context) => {
    const findings: DoctorFinding[] = [];

    if (!context.gatewayUrl) {
      findings.push({
        category: CATEGORY,
        check: "Gateway URL",
        status: "skip",
        message: "No gateway URL configured",
        repairable: false,
      });
      return findings;
    }

    const hostPort = parseHostPort(context.gatewayUrl);
    if (!hostPort) {
      findings.push({
        category: CATEGORY,
        check: "Gateway URL",
        status: "fail",
        message: `Invalid gateway URL: ${context.gatewayUrl}`,
        repairable: false,
      });
      return findings;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(
          { host: hostPort.host, port: hostPort.port, timeout: CONNECTION_TIMEOUT_MS },
          () => {
            socket.destroy();
            resolve();
          },
        );
        socket.on("timeout", () => {
          socket.destroy();
          reject(new Error("Connection timed out"));
        });
        socket.on("error", (err) => {
          socket.destroy();
          reject(err);
        });
      });

      findings.push({
        category: CATEGORY,
        check: "Gateway reachable",
        status: "pass",
        message: `Gateway is reachable at ${context.gatewayUrl}`,
        repairable: false,
      });
    } catch {
      findings.push({
        category: CATEGORY,
        check: "Gateway reachable",
        status: "fail",
        message: `Gateway is not responding at ${context.gatewayUrl}`,
        suggestion: "Gateway is not responding -- check daemon logs",
        repairable: false,
      });
    }

    return findings;
  },
};
