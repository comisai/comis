// SPDX-License-Identifier: Apache-2.0
// @allow-throw: fail-closed capability boundary. The deny branches (denylisted
// tool, invalid/expired/revoked/audience-mismatch lease) THROW as the
// authentication-boundary contract — the socket server's catch converts the
// throw to a content-free JSON error to the jailed client (mirrors how the
// dispatch sink + assertNotAgentOrigin throw their denials). ENDPOINT-02.
/**
 * `createCapabilityEndpoint` — the loopback capability endpoint that
 * authenticates the jailed script surface (ENDPOINT-01 / ENDPOINT-02; v8 §4.2).
 * A NEAR-CLONE of the in-process `createAgentRpcCall`: validate the bearer
 * (timing-safe, not-expired, not-revoked, audience-bound — 211-01) → STRIP the
 * attacker-controlled wire `_X` fields (ORIGIN-02) → inject `_capabilities` (from
 * the VALIDATED LEASE, not `resolveAutonomy`) + `_agentId` → dispatch through the
 * SAME `createRpcDispatch` sink. Unlike the in-process path it MUST strip before
 * injecting (the params are RAW WIRE BYTES, not typed tool args).
 *
 * The deny matrix is MOSTLY the automatic consequence of the two injections + a
 * denylist pre-check + validate (NOT new gate code): bad/expired/revoked/audience-
 * mismatch lease → validate null → deny; cap-not-held → the handler's
 * `requireCapability` throws (no second gate); denylisted tool → SUB_AGENT_TOOL_DENYLIST
 * pre-check; unknown method → the sink's `if (!handler) throw`; admin method →
 * `assertNotAgentOrigin` (because `_agentId` is injected). The strip-THEN-inject
 * order is load-bearing: a forged inbound `_X` is dropped first, so the injected
 * lease values are the ONLY ones the sink sees (the endpoint adds no new INTERNAL_FIELD_NAME).
 *
 * Phase 212 adds the `tool.invoke` ONE-ROUTE dispatch (`handleToolInvoke`): gates in
 * v8 §6.2 order — cap-map allow-list (unmapped → CapabilityDeniedError) → denylist →
 * deny-by-origin → requireCapability → route. The route split (Gap 1): `{kind:"rpc"}`
 * tools strip-then-inject to the SAME sink; `{kind:"executor"}` tools route to the
 * injected `toolInvokeExecutor`. The lease audience binds tool.invoke to
 * TOOL_CAPABILITY_MAP[innerTool] (Pitfall 2) — a captured lease cannot dispatch a
 * tool whose cap it lacks. Phase 216 (HIGH-1): an OUTWARD message method gets a
 * monotonic `_outwardStepIndex` allocated here (the exactly-once ledger key).
 *
 * @module
 */

import net from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import {
  SUB_AGENT_TOOL_DENYLIST,
  stripInternalFields,
  TOOL_CAPABILITY_MAP,
  TOOL_ROUTE_MAP,
  HANDLER_CAPABILITY_MAP,
  requireCapability,
  CapabilityDeniedError,
  type ResolvedAutonomy,
  type DurableRunPort,
} from "@comis/core";
import type { LeaseManager, LeaseInfo, ComisLogger } from "@comis/infra";
import type { RpcCall } from "@comis/skills/platform-tools";
import type { ExecuteToolInvoke } from "./setup-tool-invoke-executor.js";
import type { BoundedAutonomy } from "../autonomy/bounded-autonomy.js";
// AUDIT-01 (Phase 215): the per-cap audit emitter — the socket chokepoint has
// the REAL lease, so it emits the FULL tuple (leaseId + parentLeaseId present)
// for an allowed AND a denied tool.invoke (handleToolInvoke) + direct cap-gated
// method (dispatchAudited, CR-01). Reuses the shared helper (no asymmetry vs the
// in-process leg, which omits leaseId — G1).
import { emitCapabilityAudit, type EmitCapabilityAuditDeps } from "../api/shared/emit-capability-audit.js";

/**
 * Max bytes a single connection may buffer before a newline-terminated request
 * is seen (WR-01). The wire is one `{ bearer, method, params }` JSON line per
 * connection; a well-behaved client sends well under this. A client that
 * connects and never sends a `\n` would otherwise grow `buf` without bound
 * (memory pressure / OOM vector from a jailed client). On overflow the socket
 * is destroyed (fail-closed). 64 KiB is generous for the bearer + a small
 * params object yet bounds the per-connection footprint.
 */
const MAX_LINE_BYTES = 64 * 1024;

/**
 * The cron-MUTATION RPC methods the cap endpoint re-identifies to the lease's
 * agent (RATE-02 cron self-ownership) — the `orch:cron` audience set. The shared
 * `cron-handlers.ts` reads `agentId`/`_agentId` from params for BOTH the agent AND
 * the operator-gateway path, so forcing `agentId := lease.agentId` MUST happen
 * HERE (the only path where the lease is the authoritative identity) — never in
 * the handler (Pitfall 3: that would break operator `cron.list --agentId "*"`).
 * `cron.list` is NOT here: it is `ungated` (a read view) and out of the lease's
 * `orch:cron` audience, so a cap-lease cannot reach it at all (the validate denies
 * it) — there is nothing for the endpoint to re-identify.
 */
const CRON_MUTATION_METHODS: ReadonlySet<string> = new Set(["cron.add", "cron.update", "cron.run", "cron.remove"]);

/** The OUTWARD message methods (Phase 216, HIGH-1) — the genuinely-outward subset
 *  (§3.5) that gets a monotonic `_outwardStepIndex` allocated HERE (the trusted
 *  chokepoint, stripped-then-re-injected per NEW-3) so a second send in one run
 *  gets a UNIQUE index (0 then 1) and the Plan-05 wrap does not collide+drop it
 *  (inverting ONCE-02). Mirrors the wrapOutwardSend call sites in message-handlers.ts. */
const OUTWARD_MESSAGE_METHODS: ReadonlySet<string> = new Set(["message.send", "message.reply", "message.react"]);

/**
 * The EXACT RPC methods dispatched by the 10 `SUB_AGENT_TOOL_DENYLIST` management
 * tools, mapped to the owning denylist TOOL name. Method-precise (not a coarse
 * namespace block) so the pre-check denies a management method WITHOUT
 * over-denying a sibling read/orchestration method on the same namespace. Most of
 * these are already admin (deny-by-origin) AND out of the lease's `orch:*`
 * audience; the LOAD-BEARING class is `skills.create/update/delete/import/upload`
 * (orch:skill, not admin → only `skills_manage` stops the SIGUSR2 skill mutations).
 * A coarse `skills.*`/`memory.*` block would wrongly deny `skills.list`/`memory.search`.
 *
 * DRIFT NOTE: mirrors the per-tool RPC method lists in
 * `packages/skills/src/platform-tools/tools/<tool>-tool.ts`. Every value is
 * asserted at module load to be a SUB_AGENT_TOOL_DENYLIST member (a rename fails loud).
 */
const DENYLISTED_RPC_METHODS: Readonly<Record<string, string>> = {
  // gateway (config.* + env.* + gateway.* — config persistence → SIGUSR2)
  "config.apply": "gateway",
  "config.diff": "gateway",
  "config.history": "gateway",
  "config.patch": "gateway",
  "config.read": "gateway",
  "config.rollback": "gateway",
  "config.schema": "gateway",
  "env.list": "gateway",
  "env.set": "gateway",
  "gateway.restart": "gateway",
  "gateway.status": "gateway",
  // channels_manage
  "channels.configure": "channels_manage",
  "channels.disable": "channels_manage",
  "channels.enable": "channels_manage",
  "channels.get": "channels_manage",
  "channels.list": "channels_manage",
  "channels.restart": "channels_manage",
  // agents_manage
  "agents.create": "agents_manage",
  "agents.delete": "agents_manage",
  "agents.get": "agents_manage",
  "agents.list": "agents_manage",
  "agents.resume": "agents_manage",
  "agents.suspend": "agents_manage",
  "agents.update": "agents_manage",
  // models_manage
  "models.list": "models_manage",
  "models.list_providers": "models_manage",
  "models.test": "models_manage",
  // providers_manage
  "providers.create": "providers_manage",
  "providers.delete": "providers_manage",
  "providers.disable": "providers_manage",
  "providers.enable": "providers_manage",
  "providers.get": "providers_manage",
  "providers.list": "providers_manage",
  "providers.update": "providers_manage",
  // tokens_manage
  "tokens.create": "tokens_manage",
  "tokens.list": "tokens_manage",
  "tokens.revoke": "tokens_manage",
  "tokens.rotate": "tokens_manage",
  // skills_manage — the LOAD-BEARING case: skills.{create,update,delete,import,upload}
  // are orch:skill (in-audience) + non-admin, so ONLY this denylist stops them.
  "skills.create": "skills_manage",
  "skills.delete": "skills_manage",
  "skills.import": "skills_manage",
  "skills.list": "skills_manage",
  "skills.update": "skills_manage",
  "skills.upload": "skills_manage",
  // sessions_manage (session purge/export is destructive)
  "session.compact": "sessions_manage",
  "session.delete": "sessions_manage",
  "session.export": "sessions_manage",
  "session.reset": "sessions_manage",
  // memory_manage (memory purge is destructive) — NOTE: memory.search/get/store
  // are NOT here (they are orchestration reads, governed by audience + caps).
  "memory.browse": "memory_manage",
  "memory.delete": "memory_manage",
  "memory.export": "memory_manage",
  "memory.flush": "memory_manage",
  "memory.pin": "memory_manage",
  "memory.stats": "memory_manage",
  "memory.unpin": "memory_manage",
  // heartbeat_manage
  "heartbeat.get": "heartbeat_manage",
  "heartbeat.states": "heartbeat_manage",
  "heartbeat.trigger": "heartbeat_manage",
  "heartbeat.update": "heartbeat_manage",
};

// Soundness: every mapped tool name must be a member of the shipped denylist,
// so a rename of the denylist that misses this map fails loud at module load
// (rather than silently letting a denylisted tool through the pre-check).
for (const tool of Object.values(DENYLISTED_RPC_METHODS)) {
  if (!SUB_AGENT_TOOL_DENYLIST.has(tool)) {
    throw new Error(
      `setup-capability-endpoint: DENYLISTED_RPC_METHODS maps to "${tool}", absent from SUB_AGENT_TOOL_DENYLIST`,
    );
  }
}

/**
 * Derive the denylist tool name a specific RPC method belongs to (the
 * never-delegate management tool that dispatches it), or `undefined` when the
 * method is not a denylisted management method (orchestration/read methods,
 * governed instead by the lease audience + the per-handler requireCapability).
 */
function denylistToolForMethod(method: string): string | undefined {
  return DENYLISTED_RPC_METHODS[method];
}

/** Deps for {@link createCapabilityEndpoint}. */
export interface CapabilityEndpointDeps {
  /** The daemon-wide LeaseManager (211-01) — validates the bearer per call. */
  leaseManager: LeaseManager;
  /**
   * The single RPC dispatch sink (createRpcDispatch). Injecting `_agentId`
   * makes its `assertNotAgentOrigin` chokepoint fire for admin methods;
   * injecting `_capabilities` makes each handler's `requireCapability` fire.
   */
  rpcCall: RpcCall;
  /**
   * The daemon logger for socket-boundary observability (WR-02 / §2.7). A cap
   * socket is a boundary crossing, so a post-listen server error and a
   * per-connection error must be reconstructable from logs (with `err` +
   * `errorKind` + `hint`) rather than silently swallowed. Optional so the
   * deny-matrix unit tests can construct the endpoint without a logger; when
   * absent the handlers degrade to a no-op (the pre-WR-02 behavior).
   */
  logger?: ComisLogger;
  /**
   * The daemon-side executor for the `{kind:"executor"}` tools of `tool.invoke`
   * (read/grep/find/ls/jq + web_search/web_fetch — Gap 1, Phase 212). Constructed
   * + injected in Plan 05's wiring. Optional so the rpc-route + deny-matrix unit
   * tests can construct the endpoint without it; a `tool.invoke` whose route is
   * `{kind:"executor"}` requires it (a clear throw when absent — never a silent
   * no-op, since that would drop a legitimately-authorized call).
   */
  toolInvokeExecutor?: ExecuteToolInvoke;
  /**
   * The daemon-wide bounded-autonomy service (Phase 213). `handleCapCall`
   * consults it for the per-root + per-socket rate limit (RATE-01) and the cron
   * self-ownership cap via `cronCount` (RATE-02). Optional so the deny-matrix unit
   * tests can construct the endpoint without it (the rate-limit + cron-cap limbs
   * are then inert — the endpoint still validates + strips + dispatches).
   */
  boundedAutonomy?: BoundedAutonomy;
  /**
   * The resolved autonomy posture (Phase 213) — the `cronSelfMax` source the cron
   * self-ownership cap reads. Optional alongside {@link boundedAutonomy}.
   */
  autonomyConfig?: ResolvedAutonomy;
  /**
   * AUDIT-01 (Phase 215): the structural deps the per-cap audit emitter reads —
   * `container.eventBus` (for the audit:event + capability:audited emits) +
   * `container.config.tenantId` (the audit tenant scope). The daemon passes the
   * same `AppContainer` the dispatch sink already holds (the endpoint dispatches
   * THROUGH createRpcDispatch, so the bus is in scope). Optional so the
   * deny-matrix unit tests construct the endpoint without it — when absent the
   * per-cap audit is simply not emitted (the endpoint still validates +
   * strips + dispatches; the in-process leg's audit at the dispatch closure is
   * unaffected). NEVER fabricate when absent — degrade to no-audit, not a fake.
   */
  container?: EmitCapabilityAuditDeps["container"];
  /** Phase 216 (HIGH-1): the durable-run store — the SOLE source of the monotonic
   *  `_outwardStepIndex` (allocateOutwardStep). For an OUTWARD message method the
   *  endpoint allocates a UNIQUE per-root index + injects it beside `_agentId` so the
   *  Plan-05 wrap reads distinct `(rootRunId, stepIndex)` per send. Optional; absent ⇒
   *  no index injected → the wrap is a pass-through (byte-identical pre-216). */
  durableRuns?: DurableRunPort;
}

/** The minimal wire payload the jailed SDK sends over the cap socket. */
interface CapCallRequest {
  bearer: string;
  method: string;
  params?: Record<string, unknown>;
}

/** The capability endpoint handle: the dispatch fn + the 0600 socket lifecycle. */
export interface CapabilityEndpoint {
  /**
   * Validate the bearer, then (on success) inject `_agentId` + `_capabilities`
   * and dispatch through the sink. Throws (fail-closed) on every deny branch.
   */
  handleCapCall(
    bearer: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  /** Start the 0600 owner-only unix socket server at `socketPath`. */
  startSocket(socketPath: string): Promise<void>;
  /** Stop the socket server and unlink the socket file. Idempotent. */
  stopSocket(): Promise<void>;
}

/**
 * Build the loopback capability endpoint over the daemon-wide LeaseManager and
 * the RPC dispatch sink. See the module doc for the deny-matrix soundness.
 */
export function createCapabilityEndpoint(deps: CapabilityEndpointDeps): CapabilityEndpoint {
  const { leaseManager, rpcCall, boundedAutonomy } = deps;
  // Scope a submodule logger for the socket boundary (WR-02). `child` is
  // undefined-safe via the optional chain — the deny-matrix unit tests omit the
  // logger, so the socket handlers degrade to no-ops there.
  const log = deps.logger?.child({ submodule: "capability-endpoint" });

  /**
   * RATE-01: consult the per-root + per-socket rate limiter for a validated
   * lease. Throws (fail-closed, content-free) when the limiter trips. Inert when
   * `boundedAutonomy` is absent (the deny-matrix unit tests). The cap socket is
   * the agent's only orchestrate egress, so this bounds a `for(;;) spawn()` /
   * cron-storm call rate at the boundary.
   */
  function consultRateLimit(lease: LeaseInfo, socketId: string): void {
    if (!boundedAutonomy) return;
    const gate = boundedAutonomy.tryCall(lease.rootRunId, socketId);
    if (!gate.ok) {
      log?.warn(
        { submodule: "capability-endpoint", errorKind: "resource" as const, hint: "cap-socket call rate exceeded (autonomy.rate.*); the agent is calling the orchestrate surface too fast — back off or raise the rate cap" },
        "Capability call rate-limited",
      );
      throw new Error("capability call rate-limited");
    }
  }

  /**
   * The `tool.invoke` one-route dispatch (DISPATCH-01/02; v8 §6.2) — the
   * generalization of `handleCapCall`'s per-method validate. It is NOT a second
   * gate: it reuses the lease validate (audience-bound to the INNER tool, Task 1)
   * + strip-then-inject (S2/CR-01) + the shipped sink, so deny-by-origin +
   * `requireCapability` fire automatically on the rpc route. The two NEW pieces
   * are the tool→cap allow-list lookup and the tool→route split (rpc vs the
   * daemon-side executor, Gap 1). Gates in ORDER:
   *   1. cap-map allow-list — an unmapped tool → CapabilityDeniedError (DISPATCH-02).
   *   2. denylist — defense-in-depth (no cap-mapped tool is denylisted by the
   *      Plan-01 module-load assertion, but the pre-check is kept).
   *   3. deny-by-origin — AUTOMATIC on the rpc route (the injected `_agentId`
   *      triggers `assertNotAgentOrigin` for any ADMIN_METHODS at the sink).
   *   4. requireCapability — the dispatch-layer gate (complementary to the
   *      lease-audience deny in validate).
   *   5. route — `{kind:"rpc"}` strips-then-injects and forwards to the sink;
   *      `{kind:"executor"}` calls the injected daemon-side executor.
   *
   * CRITICAL (S1): NO second capability gate beyond `requireCapability`, and the
   * MCP export-policy is NOT the gate (the anti-pattern — only 3 tools are the
   * `safe` policy, incl. browser; it would reject orch:read + admit browser). The
   * cap-map + the denylist are the gates.
   *
   * The allow-list (step 1) + denylist (step 2) ran in `handleCapCall` BEFORE the
   * lease validate (so an unmapped tool surfaces the typed default-deny, not the
   * generic audience-mismatch); `cap` is the resolved, non-undefined capability.
   * This function owns steps 4–5: the dispatch-layer `requireCapability` gate
   * (complementary to the lease audience) + the rpc/executor route.
   */
  async function handleToolInvoke(
    lease: LeaseInfo,
    tool: string,
    cap: (typeof TOOL_CAPABILITY_MAP)[keyof typeof TOOL_CAPABILITY_MAP],
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // 4. requireCapability (3 deny-by-origin is automatic on the rpc route): the
    //    plain membership gate — no wildcard, least-privilege by construction.
    //    AUDIT-01 (215): a CapabilityDeniedError here is a first-class audited
    //    deny carrying the FULL lease tuple (the socket path has the real lease).
    try {
      requireCapability(lease.caps, cap);
    } catch (denyErr) {
      if (deps.container !== undefined && denyErr instanceof CapabilityDeniedError) {
        emitCapabilityAudit({ container: deps.container }, {
          agentId: lease.agentId,
          capability: cap,
          tool,
          method: "tool.invoke",
          runId: lease.sessionKey,
          rootRunId: lease.rootRunId,
          leaseId: lease.leaseId,
          ...(lease.parentLeaseId !== undefined ? { parentLeaseId: lease.parentLeaseId } : {}),
          decision: "deny",
        });
      }
      throw denyErr;
    }
    // 5. Route.
    const route = TOOL_ROUTE_MAP[tool as keyof typeof TOOL_ROUTE_MAP];
    const result =
      route.kind === "rpc"
        ? // S2 strip-then-inject (CR-01): the inner args are FULLY attacker-controlled
          // (the jailed script). Strip every forged `_X` BEFORE injecting the trusted
          // lease-derived identity, so the lease's `_agentId` is the ONLY one the sink
          // sees (self-scoping) and deny-by-origin is sound for any ADMIN_METHODS.
          await rpcCall(route.method, {
            ...stripInternalFields(args),
            _agentId: lease.agentId,
            _capabilities: lease.caps,
          })
        : // Executor route (Gap 1): the in-process builtins + the daemon-side web pair.
          // The executor is injected (Plan 05 wires it); a legitimately-authorized call
          // must NOT silently no-op if it is absent — throw a clear wiring error.
          await (async () => {
            if (deps.toolInvokeExecutor === undefined) {
              throw new Error(
                `tool.invoke executor route for "${tool}" requires a toolInvokeExecutor (not wired)`,
              );
            }
            return deps.toolInvokeExecutor(tool, args, {
              agentId: lease.agentId,
              caps: lease.caps,
              // Thread the tree-stable rootRunId so the budgetHook charges the flat web
              // call against the right per-root meter (Phase 213 BUDGET-03).
              rootRunId: lease.rootRunId,
            });
          })();
    // AUDIT-01 (215): the call was authorized AND the route resolved — emit the
    // allow with the FULL lease tuple (the spawn-tree's per-node source with the
    // real parent edge). Content-free: tool NAME + cap + ids ONLY, never args.
    if (deps.container !== undefined) {
      emitCapabilityAudit({ container: deps.container }, {
        agentId: lease.agentId,
        capability: cap,
        tool,
        method: "tool.invoke",
        runId: lease.sessionKey,
        rootRunId: lease.rootRunId,
        leaseId: lease.leaseId,
        ...(lease.parentLeaseId !== undefined ? { parentLeaseId: lease.parentLeaseId } : {}),
        decision: "allow",
      });
    }
    return result;
  }

  /**
   * AUDIT-01 (215, CR-01): dispatch a DIRECT cap-gated method (the cron + final
   * direct branches of `handleCapCall`) THROUGH the sink while emitting the
   * per-cap audit at THIS socket chokepoint, mirroring `handleToolInvoke`. These
   * branches previously injected `_agentId` but no `_callerSessionKey`, so the
   * in-process dispatch-closure audit was structurally unreachable and a socket
   * session.spawn / graph.execute / cron mutation / message.send / skills mutation
   * produced NEITHER the durable `audit:event` NOR the `capability:audited` tree
   * record — the spawn-tree silently missed its key edges. The socket path has the
   * real lease, so it emits the FULL tuple (leaseId + parentLeaseId). Allow AND deny: a
   * `CapabilityDeniedError` from the per-handler `requireCapability` (downstream
   * of the sink) is recorded as a `deny` then rethrown unchanged (fail-closed);
   * other errors rethrow unaudited (no authorization decision reached). Content-
   * free: ids/caps/method/decision ONLY (a direct method has no inner tool, so
   * `tool` is absent). `capability` is `HANDLER_CAPABILITY_MAP[method]` — a non-
   * undefined `orch:*` cap here because the lease `validate` already required it
   * (RFC 8707); when absent it dispatches unaudited (the admin deny-by-origin
   * audit, when applicable, fires at the sink's `assertNotAgentOrigin`).
   */
  async function dispatchAudited(
    method: string,
    callParams: Record<string, unknown>,
    lease: LeaseInfo,
  ): Promise<unknown> {
    const capability = HANDLER_CAPABILITY_MAP[method as keyof typeof HANDLER_CAPABILITY_MAP];
    const isCapGated =
      typeof capability === "string" && capability !== "ungated" && capability !== "deny-by-origin";
    // No real capability decision to audit (or no container wired) → plain dispatch.
    if (!isCapGated || deps.container === undefined) {
      return rpcCall(method, callParams);
    }
    const auditDeps = { container: deps.container };
    const tuple = {
      agentId: lease.agentId,
      capability,
      method,
      runId: lease.sessionKey,
      rootRunId: lease.rootRunId,
      leaseId: lease.leaseId,
      ...(lease.parentLeaseId !== undefined ? { parentLeaseId: lease.parentLeaseId } : {}),
    } as const;
    try {
      const result = await rpcCall(method, callParams);
      emitCapabilityAudit(auditDeps, { ...tuple, decision: "allow" });
      return result;
    } catch (err) {
      // A cap-not-held denial (per-handler requireCapability, downstream) is an audited
      // deny with the FULL lease tuple; non-cap errors rethrow unaudited (fail-closed).
      if (err instanceof CapabilityDeniedError) emitCapabilityAudit(auditDeps, { ...tuple, decision: "deny" });
      throw err;
    }
  }

  async function handleCapCall(
    bearer: string,
    method: string,
    params: Record<string, unknown>,
    // RATE-01: a per-connection id from the socket handler (monotonic counter).
    // Defaults to a single shared key so the deny-matrix unit tests (which call
    // handleCapCall directly) still exercise the per-root limb.
    socketId = "default",
  ): Promise<unknown> {
    // Denylist pre-check (ENDPOINT-02): a *_manage / gateway tool is never
    // delegatable, independent of the lease's caps. Denied BEFORE validate so a
    // valid lease can never reach a management surface.
    const denylistTool = denylistToolForMethod(method);
    if (denylistTool !== undefined && SUB_AGENT_TOOL_DENYLIST.has(denylistTool)) {
      throw new Error(`Tool ${denylistTool} is denylisted and not reachable from the capability endpoint`);
    }

    // tool.invoke is the one-route dispatch (Phase 212): extract the inner
    // {tool, args} and thread the inner tool into the lease audience (Task 1 —
    // validate binds tool.invoke to TOOL_CAPABILITY_MAP[innerTool]).
    if (method === "tool.invoke") {
      const tool = typeof params.tool === "string" ? params.tool : "";
      // IN-02: an array passes `typeof === "object"`, so without the
      // `!Array.isArray` guard `args: [...]` would flow on as an index-keyed
      // object (`{0:…,1:…}`) the tool sink mis-reads. Treat a non-plain-object
      // `args` (array / null / scalar) as empty named args.
      const innerArgs =
        typeof params.args === "object" && params.args !== null && !Array.isArray(params.args)
          ? (params.args as Record<string, unknown>)
          : {};
      // 1. Allow-list FIRST (DISPATCH-02 default-deny): an unmapped tool is
      //    undispatchable → CapabilityDeniedError. This precedes the lease
      //    validate so an unmapped tool surfaces the dispatch default-deny (a
      //    typed capability denial) rather than the generic audience-mismatch
      //    Error — the cap-map is the authority on what is dispatchable; the
      //    lease audience (Task 1) is the complementary replay defense for a
      //    MAPPED tool whose cap the lease lacks.
      const cap = TOOL_CAPABILITY_MAP[tool as keyof typeof TOOL_CAPABILITY_MAP];
      if (cap === undefined) {
        throw new CapabilityDeniedError("orch:read");
      }
      // 2. Denylist (defense-in-depth) — also before validate, mirroring the
      //    direct-method denylist pre-check above.
      if (SUB_AGENT_TOOL_DENYLIST.has(tool)) {
        throw new Error(`Tool ${tool} is denylisted and not reachable from the capability endpoint`);
      }
      // 3. Validate the lease, AUDIENCE-bound to the inner tool's cap (Task 1) —
      //    a captured lease cannot dispatch a tool whose cap it lacks.
      const toolLease: LeaseInfo | null = leaseManager.validate(bearer, "tool.invoke", tool);
      if (!toolLease) {
        throw new Error("lease invalid/expired/revoked or audience mismatch");
      }
      // RATE-01: rate-limit AFTER the lease validate (so an unauthenticated call
      // is denied first) — bounds the per-root + per-socket call rate.
      consultRateLimit(toolLease, socketId);
      return handleToolInvoke(toolLease, tool, cap, innerArgs);
    }

    // Validate the bearer against the lease (timing-safe + not-expired +
    // not-revoked + AUDIENCE-bound to the requested method — 211-01). The
    // requested method is threaded into validate so a captured lease cannot be
    // replayed at a foreign method (RFC 8707).
    const lease: LeaseInfo | null = leaseManager.validate(bearer, method);
    if (!lease) {
      throw new Error("lease invalid/expired/revoked or audience mismatch");
    }

    // RATE-01: rate-limit AFTER the lease validate (an unauthenticated call is
    // denied first), per-root + per-socket — bounds a for(;;) spawn() / cron-storm.
    consultRateLimit(lease, socketId);
    // RATE-01: connection-churn cap (one request per connection, so this counts a
    // reconnect-storm per root). Denies a flood of fresh cap-socket connections.
    if (boundedAutonomy) {
      const churn = boundedAutonomy.tryChurn(lease.rootRunId);
      if (!churn.ok) {
        log?.warn(
          { submodule: "capability-endpoint", errorKind: "resource" as const, hint: "cap-socket connection churn exceeded (autonomy.rate.connectionChurnPerMin); the agent is opening orchestrate connections too fast" },
          "Capability connection churn-limited",
        );
        throw new Error("capability connection churn-limited");
      }
    }

    // RATE-02 cron self-ownership: a cron mutation is re-identified to the lease's
    // agent HERE (the only path where the lease is authoritative — Pitfall 3, the
    // shared cron-handlers.ts is NOT touched). Reject system_event (only agent_turn
    // is self-ownable), cap at cronSelfMax via the NAMED boundedAutonomy.cronCount
    // accessor (the provider daemon.ts binds to CronScheduler.getJobs().length —
    // the endpoint holds no cron store of its own), then forward with agentId AND
    // _agentId FORCED to the lease's identity (cron-handlers reads BOTH), which
    // also neutralizes a forged agentId:"*" / cross-agent id.
    if (CRON_MUTATION_METHODS.has(method)) {
      if (params.payload_kind === "system_event") {
        throw new CapabilityDeniedError("orch:cron");
      }
      const cronSelfMax = deps.autonomyConfig?.cronSelfMax;
      if (
        cronSelfMax !== undefined &&
        boundedAutonomy !== undefined &&
        boundedAutonomy.cronCount(lease.agentId) >= cronSelfMax
      ) {
        log?.warn(
          { submodule: "capability-endpoint", errorKind: "resource" as const, hint: "agent-authored cron cap reached (autonomy.cronSelfMax); remove an existing agent cron or raise cronSelfMax" },
          "Capability cron self-ownership cap reached",
        );
        throw new CapabilityDeniedError("orch:cron");
      }
      // AUDIT-01 (CR-01): via dispatchAudited so the socket cron mutation emits the per-cap audit (previously unaudited — no _callerSessionKey).
      return dispatchAudited(
        method,
        {
          ...stripInternalFields(params),
          // FORCE the lease's identity on BOTH fields (cron-handlers.ts reads both).
          agentId: lease.agentId,
          _agentId: lease.agentId,
          _capabilities: lease.caps,
        },
        lease,
      );
    }

    // ORIGIN-02 at the socket boundary (CR-01): the wire `params` are FULLY
    // attacker-controlled — the jailed/untrusted script is precisely what this
    // lease authenticates. STRIP every dispatcher-internal `_X` field
    // (INTERNAL_FIELD_NAMES) the wire carried BEFORE injecting the trusted ones,
    // mirroring how the external gateway path defends itself
    // (setup-gateway-api.ts: "after this strip the PRESENCE of `_agentId` is a
    // sound, unforgeable agent-origin signal — the prerequisite that makes
    // deny-by-origin sound"). Without the strip a forged `_trustLevel:"admin"`
    // (or `_userId`/`_callerChannelId`/…) would reach handler gates like
    // authorizeChannelAccess, and a forged `_agentId` would impersonate another
    // agent. The in-process createAgentRpcCall skips this strip safely only
    // because its params are typed in-process tool args, never raw wire bytes —
    // this boundary does NOT share that property, so it must strip here.
    //
    // Inject _agentId + _capabilities and dispatch through the shipped sink.
    // _agentId (Pitfall 2): makes assertNotAgentOrigin fire for admin methods.
    // _capabilities: makes each handler's requireCapability fire (no second gate
    // here — the endpoint passes the lease caps through verbatim and lets the
    // shipped per-handler gate decide). AUDIT-01 (CR-01): via dispatchAudited so a
    // direct cap-gated method (session.spawn/graph.execute/message.send/skills.*)
    // emits the per-cap audit (allow + a downstream cap-deny) with the real lease
    // tuple — previously unaudited (no _callerSessionKey → dispatch-closure audit
    // unreachable), silently dropping the spawn-tree's most important edges.
    // HIGH-1 (Phase 216): for an OUTWARD message method, allocate a UNIQUE monotonic
    // `_outwardStepIndex` (the SOLE source) + inject it beside `_agentId` (strip-then-
    // inject — stripInternalFields above dropped any forged inbound value, NEW-3). Two
    // sends in one run get 0 then 1; absent store / non-outward method ⇒ no index.
    const outwardStep = await allocateOutwardStepIfNeeded(method, lease.rootRunId);
    return dispatchAudited(
      method,
      {
        ...stripInternalFields(params),
        _agentId: lease.agentId,
        _capabilities: lease.caps,
        ...(outwardStep !== undefined ? { _outwardStepIndex: outwardStep } : {}),
      },
      lease,
    );
  }

  /** HIGH-1: allocate the monotonic outward-send index for an OUTWARD message method,
   *  else `undefined` (no index → pass-through). Best-effort — an allocation error
   *  WARN-logs + returns undefined (never blocks the send, never substitutes a colliding 0). */
  async function allocateOutwardStepIfNeeded(method: string, rootRunId: string): Promise<number | undefined> {
    if (!deps.durableRuns || !OUTWARD_MESSAGE_METHODS.has(method)) return undefined;
    const allocated = await deps.durableRuns.allocateOutwardStep(rootRunId);
    if (!allocated.ok) {
      log?.warn(
        { submodule: "capability-endpoint", method, err: allocated.error, hint: "outward-step allocation failed — the send proceeds un-ledgered", errorKind: "dependency" as const },
        "Capability endpoint: allocateOutwardStep failed (degrading to pass-through)",
      );
      return undefined;
    }
    return allocated.value;
  }

  // --- 0600 unix socket server (mirrors mitm-broker.startUnixSocket lifecycle) ---
  let server: net.Server | null = null;
  let boundSocketPath: string | null = null;
  // Track live connections so stopSocket can destroy them (WR-01): net.Server
  // .close() only stops accepting NEW connections and waits for existing ones to
  // drain — a single stuck client (connected, never sends a `\n`) would wedge
  // shutdown forever. Mirrors mitm-broker's `openSockets` set.
  const openSockets = new Set<net.Socket>();
  // RATE-01: a monotonic per-connection id is the per-socket rate-limit key. One
  // request per connection, so this distinguishes a burst of fresh connections.
  let connectionSeq = 0;

  function startSocket(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => {
        openSockets.add(socket);
        const socketId = `conn-${(connectionSeq += 1).toString(36)}`;
        socket.on("close", () => {
          openSockets.delete(socket);
        });
        // Minimal newline-delimited JSON wire: one `{ bearer, method, params }`
        // request per connection → one JSON `{ result }` / `{ error }` reply.
        // Phase 212 (the jailed SDK client) finalizes the wire format; for 211
        // the routing + the 0600 chmod is the deliverable.
        let buf = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buf += chunk;
          // WR-01: bound the per-connection receive buffer. A client that never
          // sends a newline would otherwise grow `buf` without bound (OOM vector
          // from a jailed client). Fail closed — destroy the socket on overflow.
          if (buf.length > MAX_LINE_BYTES) {
            log?.warn(
              { submodule: "capability-endpoint", errorKind: "validation" as const, hint: "cap socket request exceeded the max line size before a newline — connection destroyed", maxLineBytes: MAX_LINE_BYTES },
              "Capability socket receive buffer overflow",
            );
            socket.destroy();
            return;
          }
          const nl = buf.indexOf("\n");
          if (nl === -1) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let req: CapCallRequest;
          try {
            req = JSON.parse(line) as CapCallRequest;
          } catch {
            socket.end(JSON.stringify({ error: "malformed request" }) + "\n");
            return;
          }
          void handleCapCall(req.bearer, req.method, req.params ?? {}, socketId)
            .then((result) => {
              socket.end(JSON.stringify({ result }) + "\n");
            })
            .catch((err: unknown) => {
              // Content-free error to the jailed client: a fixed message, never
              // the bearer or param values (the denial is audited content-free
              // by the dispatch sink's assertNotAgentOrigin where applicable).
              const message = err instanceof Error ? err.message : "capability call failed";
              socket.end(JSON.stringify({ error: message }) + "\n");
            });
        });
        socket.on("error", (err: Error) => {
          // A jailed client that disconnects mid-write must not crash the daemon —
          // but the error must not vanish either (WR-02 / §2.7). Log at debug
          // (a client-side disconnect is routine, not a daemon fault) with the
          // canonical err/errorKind/hint so a boundary failure is reconstructable.
          log?.debug(
            { submodule: "capability-endpoint", err, errorKind: "network" as const, hint: "cap socket connection error (typically a jailed client disconnecting mid-write)" },
            "Capability socket connection error",
          );
        });
      });
      server = srv;
      // WR-02: a PERSISTENT server-error logger. `srv.on("error", reject)` below
      // is only meaningful until `listen` resolves (after that `reject` is a
      // settled no-op); a post-listen server error would otherwise be wholly
      // unobserved. Node fans an "error" event to BOTH listeners, so the
      // logging handler survives after the reject handler is spent. Mirrors
      // mitm-broker's attachServerHandlers error log.
      srv.on("error", (err: Error) => {
        log?.error(
          { submodule: "capability-endpoint", err, errorKind: "network" as const, hint: "cap socket server error" },
          "Capability socket server error",
        );
      });
      srv.on("error", reject);
      // Unlink stale socket before binding (prevents EADDRINUSE).
      try {
        unlinkSync(socketPath);
      } catch {
        /* not present — ok */
      }
      srv.listen({ path: socketPath }, () => {
        // Restrict the socket to owner-only (rw-------). The daemon umask (0o022)
        // would otherwise yield a world-accessible 0o755. Best-effort catch so a
        // non-POSIX FS does not block startup.
        try {
          chmodSync(socketPath, 0o600);
        } catch {
          /* non-POSIX FS — ok */
        }
        boundSocketPath = socketPath;
        log?.info({ submodule: "capability-endpoint", socketPath }, "Capability socket bound (0600 owner-only)");
        resolve();
      });
    });
  }

  function stopSocket(): Promise<void> {
    return new Promise((resolve) => {
      const srv = server;
      if (!srv) {
        resolve();
        return;
      }
      server = null;
      // WR-01: destroy every tracked connection FIRST so a stuck client (one
      // that connected but never sent a `\n`) cannot wedge `srv.close()` — which
      // otherwise waits for all open connections to drain. Mirrors mitm-broker's
      // stop(): destroy-then-close.
      for (const socket of openSockets) {
        socket.destroy();
      }
      openSockets.clear();
      srv.close(() => {
        if (boundSocketPath) {
          try {
            unlinkSync(boundSocketPath);
          } catch {
            /* already gone — ok */
          }
          boundSocketPath = null;
        }
        resolve();
      });
    });
  }

  return { handleCapCall, startSocket, stopSocket };
}
