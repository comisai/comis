// SPDX-License-Identifier: Apache-2.0
/**
 * `HANDLER_CAPABILITY_MAP` — the single auditable source-of-truth that
 * classifies every orchestration-core RPC method to its required
 * {@link AgentCapability} (CAP-04, v8 §3.7).
 *
 * Why a registry (not a fuzzy "every handler" scan): "gated" must be a
 * machine-checkable table, not a notion. Each orchestration method is one of
 * three classifications:
 *   - an `AgentCapability` ("orch:*") — the handler MUST call
 *     `requireCapability(rawParams._capabilities, <cap>)` near its top (the
 *     in-process gate, because the agent loop skips `checkScope`).
 *   - `"deny-by-origin"` — an admin/control-plane method un-grantable to an
 *     agent origin (Plan 05 enforces the `_agentId`-reject; NONE are listed
 *     here in 210 — this classification exists so the table is total and Plan
 *     05 can extend it).
 *   - `"ungated"` — a read-only / lifecycle method governed by neither a cap
 *     nor deny-by-origin in 210.
 *
 * This is consumed by two tests that keep the gate and the table from drifting:
 *   1. `test/architecture/gated-handlers-require-capability.test.ts` AST-asserts
 *      every `AgentCapability`-valued method's handler body calls
 *      `requireCapability` with that exact cap (mapped-but-ungated fails the
 *      build), AND derives the orchestration-mutating method set from
 *      `API_CONTRACTS_ORDERED` and asserts each is a KEY here (a new mutating
 *      method in an existing gated namespace forces an entry → forces a gate).
 *   2. `packages/core/src/security/handler-capability-map.test.ts` pins the
 *      anchor classifications + the no-typo'd-cap invariant.
 *
 * Phase 212's `tool.invoke` cap-map will REUSE this table (the gate and the
 * SDK draw from one source), so it lives in `security/` (importable by both
 * `@comis/daemon` handlers and `@comis/agent` tool-assembly with no package
 * cycle) and OUT of `api-contracts/` (the web-codegen surface).
 *
 * SCOPE (v8 / RESEARCH Open Q3): 210 classifies the orchestration-CORE methods
 * only — session.spawn plus the graph, cron, message and skills families. The
 * FULL §3.6 read/web/analyze/write/browse tool-surface map is Phase 212. Do NOT
 * enumerate the full tool surface here.
 *
 * @module
 */
import type { AgentCapability } from "./capability.js";

/** Three-way classification of an orchestration RPC method (see module doc). */
export type HandlerCapabilityClassification = AgentCapability | "deny-by-origin" | "ungated";

/**
 * Method → classification for the orchestration-core surface (the five gated
 * families + their read-only/lifecycle siblings). Every method in the
 * {session, graph, cron, message, skills} namespaces is classified so the
 * `API_CONTRACTS_ORDERED`-derived completeness assertion always finds a key —
 * an UNCLASSIFIED new method in a gated namespace fails that arch-test, forcing
 * a human to decide gated-vs-ungated.
 *
 * `as const satisfies` keeps the literal cap strings exact (so the no-typo'd-cap
 * invariant holds at the type level too) while typing the whole table as a
 * `Record<string, HandlerCapabilityClassification>`.
 */
export const HANDLER_CAPABILITY_MAP = {
  // ── session ── only session.spawn is an orch cap; session.send is governed by
  // the agentToAgent policy gate, the rest are read-only / lifecycle.
  "session.spawn": "orch:spawn",
  "session.send": "ungated",
  "session.compact": "ungated",
  "session.delete": "ungated",
  "session.export": "ungated",
  "session.history": "ungated",
  "session.list": "ungated",
  "session.reset": "ungated",
  "session.reset_conversation": "ungated",
  "session.run_status": "ungated",
  "session.search": "ungated",
  "session.status": "ungated",

  // ── graph ── mutating set → orch:graph; read-only views → ungated.
  "graph.define": "orch:graph",
  "graph.execute": "orch:graph",
  "graph.save": "orch:graph",
  "graph.load": "orch:graph",
  "graph.delete": "orch:graph",
  "graph.deleteRun": "orch:graph",
  "graph.cancel": "orch:graph",
  "graph.list": "ungated",
  "graph.status": "ungated",
  "graph.runs": "ungated",
  "graph.outputs": "ungated",

  // ── cron ── mutating/exec set → orch:cron; read-only views → ungated.
  "cron.add": "orch:cron",
  "cron.update": "orch:cron",
  "cron.remove": "orch:cron",
  "cron.run": "orch:cron",
  "cron.list": "ungated",
  "cron.status": "ungated",
  "cron.runs": "ungated",

  // ── message ── outward set → orch:message; message.fetch is read-only.
  "message.send": "orch:message",
  "message.reply": "orch:message",
  "message.react": "orch:message",
  "message.edit": "orch:message",
  "message.delete": "orch:message",
  "message.attach": "orch:message",
  "message.fetch": "ungated",

  // ── skills ── mutating set → orch:skill; skills.list is read-only.
  "skills.create": "orch:skill",
  "skills.update": "orch:skill",
  "skills.delete": "orch:skill",
  "skills.import": "orch:skill",
  "skills.upload": "orch:skill",
  "skills.list": "ungated",
} as const satisfies Record<string, HandlerCapabilityClassification>;

/** The method-name keys of {@link HANDLER_CAPABILITY_MAP}. */
export type GatedMethodName = keyof typeof HANDLER_CAPABILITY_MAP;
