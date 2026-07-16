// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Browser automation RPC handler methods.
 * Covers 13 methods:
 *   browser.status, browser.start, browser.stop, browser.navigate,
 *   browser.snapshot, browser.screenshot, browser.pdf, browser.act,
 *   browser.tabs, browser.open, browser.focus, browser.close, browser.console
 *
 * Uses the `@comis/core` contract registry. Method keys are
 * computed-property names (`[BrowserStatusContract.method]:`) so the
 * bidirectional 1:1 architecture test resolves them through
 * `defineContract({ method, ... })` declarations in
 * `packages/core/src/api-contracts/workspace.ts` (the workspace umbrella
 * file groups all 5 handlers that share the `WorkspaceApiDeps` slice).
 * The dispatcher-injected `_X` internal fields are stripped via
 * `stripInternalFields` BEFORE `contract.request.parse(...)` — internal
 * fields are never modeled in the contract schema.
 * The handler resolves `_agentId` from the RAW params BEFORE stripping
 * (the agent identity lives on the internals object, never on the
 * user-facing request).
 *
 * @module
 */
import type { ActParams } from "@comis/skills";
import {
  BrowserStatusContract,
  BrowserStartContract,
  BrowserStopContract,
  BrowserNavigateContract,
  BrowserSnapshotContract,
  BrowserScreenshotContract,
  BrowserPdfContract,
  BrowserActContract,
  BrowserTabsContract,
  BrowserOpenContract,
  BrowserFocusContract,
  BrowserCloseContract,
  BrowserConsoleContract,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";

import type { RpcHandler } from "./types.js";

// Aliased from the cluster slice in api/types.ts.
// Single source of truth: WorkspaceApiDeps (shared with workspace, approval,
// mcp, skill, notification handlers).
import type { WorkspaceApiDeps as BrowserHandlerDeps } from "./types.js";
import { ValidationError } from "./errors.js";
export type { BrowserHandlerDeps };

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

/**
 * Create browser automation RPC handlers.
 * @param deps - Injected dependencies (browser service resolver)
 * @returns Record mapping method names to handler functions
 */
export function createBrowserHandlers(deps: BrowserHandlerDeps): Record<string, RpcHandler> {
  return {
    [BrowserStatusContract.method]: async (rawParams) => {
      // Resolve agent identity from internals BEFORE stripping (handler
      // body never sees `_agentId` after the strip step).
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      BrowserStatusContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      const result = await service.status();
      if (IS_DEV) BrowserStatusContract.response.parse(result);
      return result;
    },

    [BrowserStartContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      BrowserStartContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      await service.start();
      const result = { started: true as const };
      if (IS_DEV) BrowserStartContract.response.parse(result);
      return result;
    },

    [BrowserStopContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      BrowserStopContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      await service.stop();
      const result = { stopped: true as const };
      if (IS_DEV) BrowserStopContract.response.parse(result);
      return result;
    },

    [BrowserNavigateContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      const params = BrowserNavigateContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      const result = await service.navigate({
        url: params.targetUrl,
        targetId: params.targetId,
      });
      if (IS_DEV) BrowserNavigateContract.response.parse(result);
      return result;
    },

    [BrowserSnapshotContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      const params = BrowserSnapshotContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      const result = await service.snapshot({
        targetId: params.targetId,
        interactive: params.interactive,
        maxDepth: params.depth,
        compact: params.compact,
        selector: params.selector,
        maxChars: params.maxChars,
      });
      if (IS_DEV) BrowserSnapshotContract.response.parse(result);
      return result;
    },

    [BrowserScreenshotContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      const params = BrowserScreenshotContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      const captured = await service.screenshot({
        targetId: params.targetId,
        fullPage: params.fullPage,
        ref: params.ref,
        element: params.element,
        type: params.type,
      });
      // Convert Buffer to base64 for browser tool's imageResult detection
      const result = {
        base64: captured.buffer.toString("base64"),
        mimeType: captured.mimeType,
      };
      if (IS_DEV) BrowserScreenshotContract.response.parse(result);
      return result;
    },

    [BrowserPdfContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      const params = BrowserPdfContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      const captured = await service.pdf({ targetId: params.targetId });
      const result = {
        base64: captured.buffer.toString("base64"),
        mimeType: captured.mimeType,
      };
      if (IS_DEV) BrowserPdfContract.response.parse(result);
      return result;
    },

    [BrowserActContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      // Bespoke pre-Zod for missing-request operator error (matches
      // existing browser-handlers.test.ts expectations).
      if (!rawParams.request) throw new ValidationError("request parameter is required for browser.act");
      const userParams = stripInternalFields(rawParams);
      const params = BrowserActContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      const result = await service.act(params.request as ActParams);
      if (IS_DEV) BrowserActContract.response.parse(result);
      return result;
    },

    [BrowserTabsContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      BrowserTabsContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      const result = { tabs: await service.tabs() };
      if (IS_DEV) BrowserTabsContract.response.parse(result);
      return result;
    },

    [BrowserOpenContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      const params = BrowserOpenContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      const url = params.targetUrl ?? "about:blank";
      const result = await service.openTab({ url });
      if (IS_DEV) BrowserOpenContract.response.parse(result);
      return result;
    },

    [BrowserFocusContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      // Bespoke pre-Zod for missing-targetId operator error.
      if (!rawParams.targetId) throw new Error("targetId is required for browser.focus");
      const userParams = stripInternalFields(rawParams);
      const params = BrowserFocusContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      await service.focusTab({ targetId: params.targetId });
      const result = { focused: true as const, targetId: params.targetId };
      if (IS_DEV) BrowserFocusContract.response.parse(result);
      return result;
    },

    [BrowserCloseContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      const params = BrowserCloseContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      await service.closeTab({ targetId: params.targetId });
      const result = { closed: true as const };
      if (IS_DEV) BrowserCloseContract.response.parse(result);
      return result;
    },

    [BrowserConsoleContract.method]: async (rawParams) => {
      const agentId = (rawParams._agentId as string) ?? deps.defaultAgentId;
      const userParams = stripInternalFields(rawParams);
      const params = BrowserConsoleContract.request.parse(userParams);
      const service = deps.getAgentBrowserService(agentId);
      const result = {
        messages: await service.console({
          level: params.level,
          targetId: params.targetId,
        }),
      };
      if (IS_DEV) BrowserConsoleContract.response.parse(result);
      return result;
    },
  };
}
