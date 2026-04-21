// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway exposure security check.
 *
 * Analyzes gateway configuration for network exposure risks:
 * binding to all interfaces without TLS, missing auth tokens,
 * and overly permissive CORS origins.
 *
 * @module
 */

import type { SecurityCheck, SecurityFinding } from "../types.js";

/**
 * Gateway exposure check.
 *
 * Evaluates gateway.host, TLS config, token authentication,
 * and CORS origins for security risks.
 */
export const gatewayExposureCheck: SecurityCheck = {
  id: "gateway-exposure",
  name: "Gateway Exposure",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (!context.config?.gateway) {
      return findings;
    }

    const gw = context.config.gateway;

    // Check binding to all interfaces
    if (gw.host === "0.0.0.0") {
      if (!gw.tls) {
        findings.push({
          category: "gateway-exposure",
          severity: "critical",
          message: "Gateway bound to 0.0.0.0 without TLS encryption",
          remediation: "Configure TLS (gateway.tls.certPath/keyPath/caPath) or bind to 127.0.0.1",
          code: "SEC-GW-001",
        });
      } else {
        findings.push({
          category: "gateway-exposure",
          severity: "warning",
          message: "Gateway bound to 0.0.0.0 (all interfaces)",
          remediation: "Consider binding to specific interface for reduced attack surface",
          code: "SEC-GW-002",
        });
      }
    }

    // Check token authentication
    if (!gw.tokens || gw.tokens.length === 0) {
      findings.push({
        category: "gateway-exposure",
        severity: "critical",
        message: "No authentication tokens configured for gateway",
        remediation: "Add at least one token to gateway.tokens with appropriate scopes",
        code: "SEC-GW-003",
      });
    }

    // Check CORS origins
    if (gw.corsOrigins && gw.corsOrigins.some((origin) => origin === "*")) {
      findings.push({
        category: "gateway-exposure",
        severity: "warning",
        message: "CORS allows all origins (wildcard *)",
        remediation: "Restrict corsOrigins to specific trusted domains",
        code: "SEC-GW-004",
      });
    }

    return findings;
  },
};
