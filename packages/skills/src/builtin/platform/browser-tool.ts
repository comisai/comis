// SPDX-License-Identifier: Apache-2.0
/**
 * Browser platform tool: control a headless browser for web research,
 * form filling, and page interaction.
 *
 * Follows the established Comis platform tool pattern (same as
 * image-tool.ts, gateway-tool.ts). All browser logic lives in the
 * browser-service; this tool is a thin RPC delegation layer.
 *
 * Security: Navigate and open actions validate URLs through the SSRF guard
 * before delegating to rpcCall (improvement over Comis).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Result } from "@comis/shared";
import { validateUrl } from "@comis/core";
import { jsonResult, throwToolError, imageResult, dualImageResult, readStringParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";
import { BrowserToolSchema } from "./browser-tool-schema.js";
import type { SanitizedImage } from "../../integrations/image-sanitizer.js";
import type { MediaPersistenceService } from "../../media/media-persistence.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Dependencies for the browser tool factory. */
export interface BrowserToolDeps {
  /** RPC function for daemon communication. */
  rpcCall: RpcCall;
  /** Optional image sanitizer (when provided, screenshots are sanitized before return). */
  sanitizeImage?: (buffer: Buffer, mimeType: string) => Promise<Result<SanitizedImage, string>>;
  /** Optional media persistence service (when provided, screenshots are saved to workspace). */
  persistMedia?: MediaPersistenceService;
  /** Agent workspace directory (required when persistMedia is provided). */
  workspaceDir?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a browser platform tool that delegates to browser.* rpcCall methods.
 *
 * Actions: status, start, stop, profiles, tabs, open, focus, close,
 *          snapshot, screenshot, navigate, console, pdf, upload, dialog, act
 *
 * Accepts either a bare RpcCall (backward compat) or a BrowserToolDeps object
 * with optional sanitization and persistence support.
 *
 * @param depsOrRpcCall - RPC function or full deps object
 * @returns AgentTool implementing the browser control interface
 */
export function createBrowserTool(depsOrRpcCall: BrowserToolDeps | RpcCall): AgentTool<typeof BrowserToolSchema> {
  const deps: BrowserToolDeps = typeof depsOrRpcCall === "function"
    ? { rpcCall: depsOrRpcCall }
    : depsOrRpcCall;
  const { rpcCall } = deps;

  return {
    name: "browser",
    label: "Browser",
    description:
      "Control headless browser for web automation.",
    parameters: BrowserToolSchema,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as Record<string, unknown>;
        const action = readStringParam(p, "action");

        // SSRF validation for navigation actions before delegating to rpcCall
        if (action === "navigate" || action === "open") {
          const targetUrl = readStringParam(p, "targetUrl", false);
          if (targetUrl) {
            const urlCheck = await validateUrl(targetUrl);
            if (!urlCheck.ok) {
              throwToolError("permission_denied", `SSRF blocked: ${urlCheck.error.message}`);
            }
          }
        }

        const result = await rpcCall(`browser.${action}`, p);

        // Screenshot results: sanitize + persist + dual-content result
        if (action === "screenshot" && result && typeof result === "object") {
          const r = result as Record<string, unknown>;
          if (typeof r.base64 === "string" && typeof r.mimeType === "string") {
            // When sanitization deps are available, process screenshot
            if (deps.sanitizeImage) {
              const rawBuffer = Buffer.from(r.base64, "base64");
              const sanitized = await deps.sanitizeImage(rawBuffer, r.mimeType);

              if (sanitized.ok) {
                const sanitizedBase64 = sanitized.value.buffer.toString("base64");

                // When persistence deps are also available, save to workspace
                if (deps.persistMedia && deps.workspaceDir) {
                  const persistResult = await deps.persistMedia.persist(sanitized.value.buffer, {
                    mediaKind: "image",
                    mimeType: sanitized.value.mimeType,
                    subdirOverride: "screenshots",
                  });

                  if (persistResult.ok) {
                    return dualImageResult(
                      sanitizedBase64,
                      sanitized.value.mimeType,
                      persistResult.value.relativePath,
                      deps.workspaceDir,
                    );
                  }
                  // Persistence failed -- fall back to sanitized imageResult
                }
                // No persistence deps -- return sanitized imageResult (still a win: smaller base64)
                return imageResult(sanitizedBase64, sanitized.value.mimeType);
              }
              // Sanitization failed -- fall back to raw imageResult
            }
            // No sanitize deps -- fall back to raw imageResult (backward compat)
            return imageResult(r.base64, r.mimeType);
          }
        }

        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
