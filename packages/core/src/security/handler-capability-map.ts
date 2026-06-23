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
 *     agent origin (the `rpc-dispatch.ts` chokepoint rejects an `_agentId`-bearing
 *     call for every scopes:["admin"] method). 210-GAP populates this class with
 *     the message subset §3.5 keeps admin-only (edit/delete/fetch/attach) + the
 *     arbitrary-session lifecycle ops carrying an in-handler `_trustLevel`-admin
 *     check (session.delete/export/reset_conversation).
 *   - `"ungated"` — a read-only / lifecycle method governed by neither a cap
 *     nor deny-by-origin (agent-reachable, rpc-scoped contract).
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
  // the agentToAgent policy gate. The read/lifecycle ops split two ways
  // (210-GAP MD-01): list/compact/reset/history/run_status/search/status are
  // "ungated" (agent-reachable self-scoped reads, rpc-scoped contracts), while
  // delete/export/reset_conversation are "deny-by-origin" — they carry an
  // in-handler `_trustLevel === "admin"` check AND target an ARBITRARY session
  // by key (not the caller's own), so they are genuine control plane and stay
  // scopes:["admin"]; an agent origin is denied at the chokepoint.
  "session.spawn": "orch:spawn",
  "session.send": "ungated",
  "session.compact": "ungated",
  "session.delete": "deny-by-origin",
  "session.export": "deny-by-origin",
  "session.history": "ungated",
  "session.list": "ungated",
  "session.reset": "ungated",
  "session.reset_conversation": "deny-by-origin",
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

  // ── message ── 210-GAP / §3.5: `orch:message` exposes ONLY the
  // genuinely-outward send subset (send/reply/react). edit/delete/fetch/attach
  // are admin-only and NOT part of the cap → "deny-by-origin" (they stay
  // scopes:["admin"]; an agent origin is denied at the chokepoint, NOT
  // cap-gated). This corrects the prior over-broad gating that (a) put
  // edit/delete/attach behind a cap no profile grants and (b) made a
  // _capabilities-stripped admin gateway caller throw on the (undefined) cap.
  "message.send": "orch:message",
  "message.reply": "orch:message",
  "message.react": "orch:message",
  "message.edit": "deny-by-origin",
  "message.delete": "deny-by-origin",
  "message.attach": "deny-by-origin",
  "message.fetch": "deny-by-origin",

  // ── skills ── mutating set → orch:skill; skills.list is read-only.
  "skills.create": "orch:skill",
  "skills.update": "orch:skill",
  "skills.delete": "orch:skill",
  "skills.import": "orch:skill",
  "skills.upload": "orch:skill",
  "skills.list": "ungated",

  // ── capabilities ── INTRO-02 (Phase 215): capabilities.introspect (the
  // `whoami` read) is read-only + agent-reachable with NO cap — an agent queries
  // its OWN resolved caps + remaining budget/quota. It joins the read-only
  // "ungated" class (beside session.status); the handler enforces _agentId
  // self-scope, NOT a requireCapability gate. scopes:["rpc"], not admin.
  "capabilities.introspect": "ungated",
} as const satisfies Record<string, HandlerCapabilityClassification>;

/** The method-name keys of {@link HANDLER_CAPABILITY_MAP}. */
export type GatedMethodName = keyof typeof HANDLER_CAPABILITY_MAP;
