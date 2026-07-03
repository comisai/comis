// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestrator approval surface: the server-side InteractiveCallbackRouter
 * (parse → lookup → cross-session → expiry → verify → dispatch). Channels never
 * import this — they reach signing via the `@comis/core` primitive.
 *
 * @module
 */
export {
  createInteractiveCallbackRouter,
  type InteractiveCallbackRouter,
  type InteractiveCallbackRouterDeps,
  type InboundCallback,
  type CallbackResolution,
} from "./interactive-callback-router.js";
