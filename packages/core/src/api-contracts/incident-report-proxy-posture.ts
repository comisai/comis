// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-boot proxy posture shape shared by `IncidentReportSchema` (the
 * wire schema) and `IncidentSignals` (the assembler-side carrier). Split out of
 * incident-report.ts so that module stays under the per-file line cap.
 *
 * Content-free by construction: a configured flag + installer flag, the
 * `sanitizeProxyUrl()` masked URL (never a raw URL), and closed-enum/key
 * strings — the same redaction discipline as the rest of the report.
 *
 * @module
 */
import { z } from "zod";

/** The redaction-safe daemon-boot proxy posture (see incident-report.ts). */
export const IncidentProxyPostureSchema = z.object({
  /** true when a proxy was configured (env var or config.proxy.proxyUrl). */
  configured: z.boolean(),
  /** sanitizeProxyUrl() output — never the raw proxy URL. Absent when not configured. */
  maskedUrl: z.string().optional(),
  /** The effective loopback mode (from ProxyBootConfig.loopbackMode). */
  loopbackMode: z.string().optional(),
  /** Where the proxy URL was sourced (env var or config.yaml). */
  source: z.enum(["env", "config", "none"]).optional(),
  /** true when installGlobalProxyDispatcher() completed without error. */
  installerOk: z.boolean(),
  /** The configKey string from ProxyConfigError when installerOk is false. */
  installerError: z.string().optional(),
});

/** The daemon-boot proxy posture (see {@link IncidentProxyPostureSchema}). */
export type IncidentProxyPosture = z.infer<typeof IncidentProxyPostureSchema>;
