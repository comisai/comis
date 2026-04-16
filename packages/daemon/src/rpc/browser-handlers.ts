/**
 * Browser automation RPC handler methods.
 * Covers 13 methods:
 *   browser.status, browser.start, browser.stop, browser.navigate,
 *   browser.snapshot, browser.screenshot, browser.pdf, browser.act,
 *   browser.tabs, browser.open, browser.focus, browser.close, browser.console
 * Extracted from daemon.ts rpcCallInner switch block
 * @module
 */

import type { BrowserService, ActParams } from "@comis/skills";

import type { RpcHandler } from "./types.js";

/** Dependencies required by browser handlers. */
export interface BrowserHandlerDeps {
  defaultAgentId: string;
  getAgentBrowserService: (agentId: string) => BrowserService;
}

/**
 * Create browser automation RPC handlers.
 * @param deps - Injected dependencies (browser service resolver)
 * @returns Record mapping method names to handler functions
 */
export function createBrowserHandlers(deps: BrowserHandlerDeps): Record<string, RpcHandler> {
  return {
    "browser.status": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      return await service.status();
    },

    "browser.start": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      await service.start();
      return { started: true };
    },

    "browser.stop": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      await service.stop();
      return { stopped: true };
    },

    "browser.navigate": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      const url = params.targetUrl as string;
      const targetId = params.targetId as string | undefined;
      return await service.navigate({ url, targetId });
    },

    "browser.snapshot": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      return await service.snapshot({
        targetId: params.targetId as string | undefined,
        interactive: params.interactive as boolean | undefined,
        maxDepth: params.depth as number | undefined,
        compact: params.compact as boolean | undefined,
        selector: params.selector as string | undefined,
        maxChars: params.maxChars as number | undefined,
      });
    },

    "browser.screenshot": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      const result = await service.screenshot({
        targetId: params.targetId as string | undefined,
        fullPage: params.fullPage as boolean | undefined,
        ref: params.ref as string | undefined,
        element: params.element as string | undefined,
        type: params.type as "png" | "jpeg" | undefined,
      });
      // Convert Buffer to base64 for browser tool's imageResult detection
      return { base64: result.buffer.toString("base64"), mimeType: result.mimeType };
    },

    "browser.pdf": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      const result = await service.pdf({ targetId: params.targetId as string | undefined });
      return { base64: result.buffer.toString("base64"), mimeType: result.mimeType };
    },

    "browser.act": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      const request = params.request as Record<string, unknown>;
      if (!request) throw new Error("request parameter is required for browser.act");
      return await service.act(request as ActParams);
    },

    "browser.tabs": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      return { tabs: await service.tabs() };
    },

    "browser.open": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      const url = (params.targetUrl as string) ?? "about:blank";
      return await service.openTab({ url });
    },

    "browser.focus": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      const targetId = params.targetId as string;
      if (!targetId) throw new Error("targetId is required for browser.focus");
      await service.focusTab({ targetId });
      return { focused: true, targetId };
    },

    "browser.close": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      await service.closeTab({ targetId: params.targetId as string | undefined });
      return { closed: true };
    },

    "browser.console": async (params) => {
      const agentId = (params._agentId as string) ?? deps.defaultAgentId;
      const service = deps.getAgentBrowserService(agentId);
      return {
        messages: await service.console({
          level: params.level as string | undefined,
          targetId: params.targetId as string | undefined,
        }),
      };
    },
  };
}
