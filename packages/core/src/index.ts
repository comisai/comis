// SPDX-License-Identifier: Apache-2.0
// @comis/core - Core domain logic, ports, security, config, and bootstrap
//
// Export groups are organized by concern for navigability.
// External consumers import from "@comis/core" which resolves here.

export * from "./exports/domain.js";
export * from "./exports/ports.js";
export * from "./exports/activity.js";
export * from "./exports/security.js";
export * from "./exports/logging.js";
export * from "./exports/event-bus.js";
export * from "./exports/config.js";
export * from "./exports/hooks.js";
export * from "./exports/bootstrap.js";
export * from "./exports/delivery.js";
export * from "./exports/runtime.js";
export * from "./exports/oauth.js";
export * from "./exports/model.js";
export * from "./exports/workspace.js";
export * from "./exports/media.js";
export * from "./exports/text.js";
export * from "./api-contracts/index.js";

// Durability-resume engine — the durable-run + outward-send-ledger ports and
// the DurableRunRecord domain type. Re-exported here so downstream packages
// (@comis/memory adapters, @comis/daemon wiring) can import them.
export * from "./ports/durable-run.js";
export * from "./ports/outward-send-ledger.js";
export * from "./domain/durable-run.js";
