// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { PluginRegistry } from "./plugin-registry.js";
import type { TypedEventBus } from "../event-bus/index.js";
import type { RegisteredHook } from "../ports/plugin.js";
import { systemNowMs } from "../runtime/system-time.js";
import type {
  HookName,
  HookBeforeAgentStartEvent,
  HookBeforeAgentStartContext,
  HookBeforeAgentStartResult,
  HookBeforeCompactionEvent,
  HookBeforeCompactionContext,
  HookBeforeCompactionResult,
  HookAfterCompactionEvent,
  HookAfterCompactionContext,
  HookBeforeDeliveryEvent,
  HookBeforeDeliveryContext,
  HookBeforeDeliveryResult,
  HookAfterDeliveryEvent,
  HookAfterDeliveryContext,
  HookSessionStartEvent,
  HookSessionStartContext,
  HookSessionEndEvent,
  HookSessionEndContext,
  HookGatewayStartEvent,
  HookGatewayStartContext,
  HookGatewayStopEvent,
  HookGatewayStopContext,
} from "../ports/hook-types.js";
import {
  BeforeAgentStartResultSchema,
  BeforeCompactionResultSchema,
  BeforeDeliveryResultSchema,
  mergeBeforeAgentStart,
  mergeBeforeCompaction,
  mergeBeforeDelivery,
} from "./hook-strategies.js";

/**
 * The hook runner executes registered hooks at lifecycle points.
 *
 * Two execution modes:
 * - **Modifying hooks**: Run sequentially, return merged result objects
 * - **Void hooks**: Run in parallel, fire-and-forget
 *
 * Created via createHookRunner().
 */
export interface HookRunner {
  // Modifying hooks (sequential, return merged result)
  runBeforeAgentStart(
    event: HookBeforeAgentStartEvent,
    ctx: HookBeforeAgentStartContext,
  ): Promise<HookBeforeAgentStartResult | undefined>;

  runBeforeCompaction(
    event: HookBeforeCompactionEvent,
    ctx: HookBeforeCompactionContext,
  ): Promise<HookBeforeCompactionResult | undefined>;

  runBeforeDelivery(
    event: HookBeforeDeliveryEvent,
    ctx: HookBeforeDeliveryContext,
  ): Promise<HookBeforeDeliveryResult | undefined>;

  // Void hooks (parallel, fire-and-forget)
  runAfterCompaction(event: HookAfterCompactionEvent, ctx: HookAfterCompactionContext): Promise<void>;
  runAfterDelivery(event: HookAfterDeliveryEvent, ctx: HookAfterDeliveryContext): Promise<void>;
  runSessionStart(event: HookSessionStartEvent, ctx: HookSessionStartContext): Promise<void>;
  runSessionEnd(event: HookSessionEndEvent, ctx: HookSessionEndContext): Promise<void>;
  runGatewayStart(event: HookGatewayStartEvent, ctx: HookGatewayStartContext): Promise<void>;
  runGatewayStop(event: HookGatewayStopEvent, ctx: HookGatewayStopContext): Promise<void>;
}

/**
 * Options for creating a hook runner.
 *
 * The `hook:executed` observability event was removed (zero non-test
 * subscribers). The `eventBus` option remains for the live `audit:event`
 * emission via `emitAuditEvent` which fires when modifying hooks alter
 * agent prompts or delivery payloads.
 */
export interface HookRunnerOptions {
  /** Catch and log hook handler errors instead of propagating (default: true). */
  catchErrors?: boolean;
  /** Event bus for emitting audit:event entries on modifying-hook output. */
  eventBus?: TypedEventBus;
}

/**
 * Create a hook runner that executes hooks from the plugin registry.
 *
 * Modifying hooks run sequentially (for...of) with result merging.
 * Void hooks run in parallel (Promise.all) for maximum throughput.
 *
 * When catchErrors is true (default), individual hook handler errors are
 * caught and logged rather than propagating to the caller.
 */
export function createHookRunner(
  registry: PluginRegistry,
  options: HookRunnerOptions = {},
): HookRunner {
  const { catchErrors = true, eventBus } = options;

  /**
   * Emit an audit:event for hook modifications.
   */
  function emitAuditEvent(
    hookName: string,
    pluginId: string,
    metadata: Record<string, unknown>,
  ): void {
    if (eventBus) {
      eventBus.emit("audit:event", {
        timestamp: systemNowMs(),
        agentId: "hook-runner",
        tenantId: "system",
        actionType: "hook_modification",
        kind: "hook_blocked",
        outcome: "success",
        metadata: {
          hookName,
          pluginId,
          ...metadata,
        },
      });
    }
  }

  /**
   * Run void hooks in parallel. Errors are caught if catchErrors is true.
   */
  async function runVoidHook<K extends HookName>(
    hookName: K,
    event: unknown,
    ctx: unknown,
  ): Promise<void> {
    const registeredHooks = registry.getHooksByName(hookName);
    if (registeredHooks.length === 0) return;

    await Promise.all(
      registeredHooks.map(async (hook: RegisteredHook<K>) => {
        try {
          await (hook.handler as (e: unknown, c: unknown) => Promise<void> | void)(event, ctx);
        } catch (e) {
          if (!catchErrors) throw e;
        }
      }),
    );
  }

  /**
   * Run modifying hooks sequentially. Results are merged using the provided merge function.
   * Errors are caught if catchErrors is true (skipping the handler's contribution).
   * When a schema is provided, hook return values are validated before merging.
   */
  async function runModifyingHook<K extends HookName, TResult>(
    hookName: K,
    event: unknown,
    ctx: unknown,
    merge: (acc: TResult | undefined, next: TResult) => TResult,
    schema?: z.ZodType<TResult>,
  ): Promise<TResult | undefined> {
    const registeredHooks = registry.getHooksByName(hookName);
    if (registeredHooks.length === 0) return undefined;

    let result: TResult | undefined;

    for (const hook of registeredHooks) {
      try {
        const r = await (
          hook.handler as (e: unknown, c: unknown) => Promise<TResult | void> | TResult | void
        )(event, ctx);
        if (r) {
          // Validate hook return value against schema
          if (schema) {
            const parsed = schema.safeParse(r);
            if (!parsed.success) {
              continue; // Skip invalid results
            }
          }

          // Audit hook modifications
          auditHookResult(hookName, hook.pluginId, r);

          result = merge(result, r as TResult);
        }
      } catch (e) {
        if (!catchErrors) throw e;
      }
    }

    return result;
  }

  /**
   * Emit audit events for modifying hook results.
   * Only emits when the hook actually modifies values.
   */
  function auditHookResult(hookName: string, pluginId: string, r: unknown): void {
    if (hookName === "before_agent_start") {
      const result = r as HookBeforeAgentStartResult;
      if (result.systemPrompt !== undefined || result.prependContext !== undefined) {
        emitAuditEvent(hookName, pluginId, {
          systemPromptModified: result.systemPrompt !== undefined,
          prependContextModified: result.prependContext !== undefined,
        });
      }
    }

    if (hookName === "before_delivery") {
      const result = r as HookBeforeDeliveryResult;
      if (result.text !== undefined || result.cancel !== undefined) {
        emitAuditEvent(hookName, pluginId, {
          textModified: result.text !== undefined,
          cancelled: result.cancel === true,
          cancelReason: result.cancelReason,
        });
      }
    }
  }

  // ─── Public API ──────────────────────────────────────────────────

  return {
    // Modifying hooks (with Zod schema validation)
    runBeforeAgentStart: (event, ctx) =>
      runModifyingHook("before_agent_start", event, ctx, mergeBeforeAgentStart,
        BeforeAgentStartResultSchema as z.ZodType<HookBeforeAgentStartResult>),

    runBeforeCompaction: (event, ctx) =>
      runModifyingHook("before_compaction", event, ctx, mergeBeforeCompaction,
        BeforeCompactionResultSchema as z.ZodType<HookBeforeCompactionResult>),

    runBeforeDelivery: (event, ctx) =>
      runModifyingHook("before_delivery", event, ctx, mergeBeforeDelivery,
        BeforeDeliveryResultSchema as z.ZodType<HookBeforeDeliveryResult>),

    // Void hooks
    runAfterCompaction: (event, ctx) => runVoidHook("after_compaction", event, ctx),
    runAfterDelivery: (event, ctx) => runVoidHook("after_delivery", event, ctx),
    runSessionStart: (event, ctx) => runVoidHook("session_start", event, ctx),
    runSessionEnd: (event, ctx) => runVoidHook("session_end", event, ctx),
    runGatewayStart: (event, ctx) => runVoidHook("gateway_start", event, ctx),
    runGatewayStop: (event, ctx) => runVoidHook("gateway_stop", event, ctx),
  };
}
