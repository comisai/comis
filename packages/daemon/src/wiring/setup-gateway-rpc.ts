// SPDX-License-Identifier: Apache-2.0
/**
 * RPC method registration for the gateway dynamic router.
 * This module registers all RPC methods on the gateway's DynamicMethodRouter
 * via passthrough to rpcCall (central dispatch). All business logic lives in
 * domain handler modules (rpc/*.ts); this file only wires method names and
 * trust scopes.
 * The sole inline handler is cron.add, which transforms frontend CronJobInput
 * params into the flat format expected by the cron handler.
 * Extracted from setup-gateway.ts.
 * @module
 */

import type { AppContainer } from "@comis/core";
import type { RpcCall } from "@comis/skills";
import type { DynamicMethodRouter } from "@comis/gateway";

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

/** Dependencies for RPC method registration. */
export interface RpcMethodDeps {
  /** Dynamic method router to register methods on. */
  dynamicRouter: DynamicMethodRouter;
  /** Bootstrap output (config, eventBus, secretManager, tenantId). */
  container: AppContainer;
  /** Active config file paths for gateway.status RPC. */
  configPaths: string[];
  /** RPC call dispatcher for session/cron bridge methods. */
  rpcCall: RpcCall;
}

// ---------------------------------------------------------------------------
// Passthrough helper
// ---------------------------------------------------------------------------

/**
 * Batch-register RPC methods that pass through to rpcCall with no transformation.
 * Admin-scoped methods automatically inject `_trustLevel: "admin"`.
 * Eliminates repetitive lambda definitions.
 */
function registerRpcPassthrough(
  router: DynamicMethodRouter,
  rpcCall: RpcCall,
  methods: string[],
  scope: "rpc" | "admin",
): void {
  for (const method of methods) {
    if (scope === "admin") {
      router.registerMethod(method, "admin", async (params: Record<string, unknown> | undefined) =>
        rpcCall(method, { ...(params ?? {}), _trustLevel: "admin" }),
      );
    } else {
      router.registerMethod(method, "rpc", async (params: Record<string, unknown> | undefined) =>
        rpcCall(method, params ?? {}),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Register all RPC methods on the dynamic router.
 * All handlers live in domain modules (rpc/*.ts) and are dispatched via
 * rpcCall. This function only wires method names to trust scopes.
 */
export function registerRpcMethods(deps: RpcMethodDeps): void {
  const { dynamicRouter, rpcCall } = deps;

  // -------------------------------------------------------------------------
  // Infrastructure: ping, config, gateway, daemon (handlers in daemon-handlers + config-handlers)
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, ["system.ping"], "rpc");

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "config.read", "config.schema", "config.patch", "config.apply",
    "gateway.status", "gateway.restart",
    "daemon.setLogLevel",
  ], "admin");

  // -------------------------------------------------------------------------
  // Observability + cache stats
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "obs.diagnostics", "obs.billing.byProvider", "obs.billing.byAgent",
    "obs.billing.bySession", "obs.billing.total", "obs.billing.usage24h",
    "obs.channels.all", "obs.channels.stale", "obs.channels.get",
    "obs.delivery.recent", "obs.delivery.stats",
    "obs.context.pipeline", "obs.context.dag",
    "obs.reset", "obs.reset.table", "obs.getCacheStats",
    "agent.cacheStats", "memory.embeddingCache",
  ], "admin");

  // -------------------------------------------------------------------------
  // Bridge session/cron methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "session.send", "session.spawn", "session.status",
    "session.history", "session.search",
    "cron.list",
  ], "rpc");

  // cron.add: Transform frontend CronJobInput into flat params expected by handler
  dynamicRouter.registerMethod("cron.add", "rpc", async (params: Record<string, unknown> | undefined) => {
    const p = params ?? {};
    const schedule = p.schedule as Record<string, unknown> | undefined;
    const adapted: Record<string, unknown> = {
      name: p.name,
      schedule_kind: schedule?.kind ?? "cron",
      payload_kind: "agent_turn",
      payload_text: p.message,
      _agentId: p.agentId || undefined,  // Empty string -> undefined so handler uses defaultAgentId
      // Flat schedule params expected by buildCronSchedule
      schedule_expr: schedule?.expr,
      timezone: schedule?.tz,
      schedule_every_ms: schedule?.everyMs,
      schedule_at: schedule?.at,
    };
    return rpcCall("cron.add", adapted);
  });

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "cron.update", "cron.remove", "cron.status", "cron.runs", "cron.run",
  ], "rpc");

  // -------------------------------------------------------------------------
  // Context DAG recall bridge methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "context.search", "context.inspect", "context.recall", "context.expand",
  ], "rpc");

  // Context DAG operator (admin) methods
  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "context.conversations", "context.tree", "context.searchByConversation",
  ], "admin");

  // -------------------------------------------------------------------------
  // Browser bridge methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "browser.status", "browser.start", "browser.stop", "browser.navigate",
    "browser.snapshot", "browser.screenshot", "browser.pdf", "browser.act",
    "browser.tabs", "browser.open", "browser.focus", "browser.close",
    "browser.console",
  ], "rpc");

  // -------------------------------------------------------------------------
  // Audio + media
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, ["audio.transcribe"], "rpc");
  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "media.test.stt", "media.test.tts",
    "media.test.vision", "media.test.document",
    "media.test.video", "media.test.link",
    "media.providers",
  ], "admin");

  // -------------------------------------------------------------------------
  // Approval gate admin methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "admin.approval.pending", "admin.approval.resolve", "admin.approval.clearDenialCache",
  ], "admin");

  // -------------------------------------------------------------------------
  // Subagent management admin methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "subagent.list", "subagent.kill", "subagent.steer",
  ], "admin");

  // -------------------------------------------------------------------------
  // Agent management admin methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "agents.list", "agents.create", "agents.get", "agents.update",
    "agents.delete", "agents.suspend", "agents.resume",
  ], "admin");

  // -------------------------------------------------------------------------
  // Session management admin methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "session.list", "session.delete", "session.reset", "session.export", "session.compact",
  ], "admin");

  // -------------------------------------------------------------------------
  // Memory management admin methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "memory.stats", "memory.browse", "memory.delete",
    "memory.flush", "memory.export", "memory.store",
  ], "admin");

  // -------------------------------------------------------------------------
  // Model management admin methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, ["models.list", "models.test"], "admin");

  // -------------------------------------------------------------------------
  // Token management admin methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "tokens.list", "tokens.create", "tokens.revoke", "tokens.rotate",
  ], "admin");

  // -------------------------------------------------------------------------
  // Channel management admin methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "channels.list", "channels.get", "channels.enable",
    "channels.disable", "channels.restart",
  ], "admin");

  // -------------------------------------------------------------------------
  // Message send/reply/delete admin methods (message center UI)
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "message.send", "message.reply", "message.edit",
    "message.delete", "message.fetch", "message.react",
    "message.attach",
    "telegram.action", "discord.action", "slack.action", "whatsapp.action",
  ], "admin");

  // -------------------------------------------------------------------------
  // Channel health summary (read-only observability)
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "channels.health", "channels.capabilities",
  ], "rpc");

  // -------------------------------------------------------------------------
  // MCP server management admin methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "mcp.list", "mcp.status", "mcp.connect",
    "mcp.disconnect", "mcp.reconnect", "mcp.test",
  ], "admin");

  // -------------------------------------------------------------------------
  // Skills (rpc + admin)
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, ["skills.list"], "rpc");
  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "skills.upload", "skills.import", "skills.delete",
  ], "admin");

  // -------------------------------------------------------------------------
  // Workspace file + git management admin methods
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "workspace.status", "workspace.readFile", "workspace.listDir",
    "workspace.git.status", "workspace.git.log", "workspace.git.diff",
  ], "rpc");

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "workspace.writeFile", "workspace.deleteFile", "workspace.resetFile",
    "workspace.init",
    "workspace.git.commit", "workspace.git.restore",
  ], "admin");

  // -------------------------------------------------------------------------
  // Graph execution + named graph persistence
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "graph.define", "graph.execute", "graph.status", "graph.cancel",
    "graph.save", "graph.load", "graph.list", "graph.delete", "graph.outputs",
    "graph.runs", "graph.runDetail", "graph.deleteRun",
  ], "rpc");

  // -------------------------------------------------------------------------
  // Heartbeat state -- handlers in rpc-dispatch via createHeartbeatHandlers
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "heartbeat.states", "heartbeat.get", "heartbeat.update", "heartbeat.trigger",
  ], "admin");

  // -------------------------------------------------------------------------
  // Notification methods (Proactive v1)
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, ["notification.send"], "rpc");

  // -------------------------------------------------------------------------
  // Config history + git management
  // -------------------------------------------------------------------------

  registerRpcPassthrough(dynamicRouter, rpcCall, [
    "config.history", "config.diff", "config.rollback", "config.gc",
  ], "admin");
}
