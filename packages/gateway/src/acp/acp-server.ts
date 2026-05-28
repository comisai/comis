// SPDX-License-Identifier: Apache-2.0
// @allow-throw: ACP HTTP server route handler; throws caught by Hono framework error-handler boundary.
/**
 * ACP Agent Server — Agent Communication Protocol implementation for IDE integration.
 *
 * Implements the ACP Agent interface from @agentclientprotocol/sdk, enabling
 * VS Code, JetBrains, Zed, and other ACP-compatible IDEs to connect to Comis
 * as an AI agent through the standardized Agent Communication Protocol.
 *
 * The ACP server runs as a standalone entry point that the IDE spawns as a subprocess,
 * communicating via ndJson over stdin/stdout.
 *
 * IMPORTANT: All logging MUST go to stderr (not stdout) to avoid corrupting the
 * ndJson protocol. The deps.logger is expected to be configured for stderr output
 * when running in ACP mode.
 */

import {
  AgentSideConnection,
  ndJsonStream,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
} from "@agentclientprotocol/sdk";

import type {
  AcpActivityBridge,
} from "./acp-activity-bridge.js";
import type { AcpApprovalBridge } from "./acp-approval-bridge.js";

// WIRE-04 (§17.7): the orchestrator-facing activity stream port + the read-only
// SEP plan port + the agent event bus, all injected at the composition root.
// startAcpServer (74-07) constructs the three ACP bridges from these seams.
import type {
  ActivityStreamPort,
  ExecutionPlanPort,
  TypedEventBus,
} from "@comis/core";

import { createAcpSessionMap, type AcpSessionMap } from "./acp-session-map.js";
import { createAcpActivityBridge } from "./acp-activity-bridge.js";
import { createAcpApprovalBridge } from "./acp-approval-bridge.js";
import { createAcpPlanBridge } from "./acp-plan-bridge.js";

/**
 * Dependency interface for the ACP server.
 * Uses function callbacks to keep the gateway decoupled from agent internals.
 */
export interface AcpServerDeps {
  /** Execute an agent turn and return the response. */
  executeAgent: (params: {
    message: string;
    sessionKey: { userId: string; channelId: string; peerId: string };
    onDelta?: (delta: string) => void;
  }) => Promise<{
    response: string;
    tokensUsed: { input: number; output: number; total: number };
    finishReason: string;
  }>;

  /** Logger — MUST write to stderr when running in ACP mode. */
  logger: {
    info(...args: unknown[]): void;
    error(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };

  /** Agent version string. Defaults to "0.0.1". */
  version?: string;

  /**
   * Orchestrator-facing activity stream port (WIRE-04, §17.7), injected at the
   * composition root. When present, startAcpServer constructs the activity +
   * approval bridges (ACP-02 / ACP-04) from it (their `subscribe(ctx)` is the
   * per-turn live-IDE seam — see startAcpServer). Optional — absent in
   * non-activity ACP runs.
   */
  activityStreamPort?: ActivityStreamPort;

  /**
   * Read-only SEP plan accessor (ACP-03). This is the `ExecutionPlanHolder`
   * from `@comis/agent`, consumed here as a `@comis/core` `ExecutionPlanPort` —
   * the gateway never imports `@comis/agent` (hexagonal boundary). When present
   * (together with {@link eventBus}), startAcpServer constructs the plan bridge
   * so the IDE's native plan panel is driven from SEP. Optional — absent in
   * non-ACP-plan runs.
   */
  executionPlanPort?: ExecutionPlanPort;

  /**
   * Agent event bus for the ACP plan bridge (`sep:plan_extracted` +
   * `tool:executed`). Injected by the composition root alongside
   * {@link executionPlanPort}. When {@link executionPlanPort} is present but
   * this is absent, startAcpServer logs a single WARN and skips the plan bridge
   * (fail-safe: no frames rather than a raw leak — T-74-34). Optional.
   */
  eventBus?: TypedEventBus;
}

/**
 * Extract user text from ACP prompt content blocks.
 *
 * Collects all text-type content blocks from the prompt and joins them.
 * Non-text blocks (images, audio, resources) are skipped.
 */
function extractUserMessage(prompt: PromptRequest["prompt"]): string {
  const textParts: string[] = [];
  for (const block of prompt) {
    if ("type" in block && block.type === "text" && "text" in block) {
      textParts.push(block.text as string);
    }
  }
  return textParts.join("\n");
}

/**
 * Handle returned by {@link createAcpAgent} — the ACP Agent plus the seams the
 * Phase 74 bridges need to reach a live session.
 */
export interface AcpAgentHandle {
  /** The ACP Agent interface implementation. */
  agent: Agent;
  /** ACP session id → Comis SessionKey map. */
  sessionMap: AcpSessionMap;
  /**
   * Look up the retained `AgentSideConnection` for an ACP session id (ACP-01).
   * The Wave 2 bridges (acp-activity-bridge / acp-plan-bridge /
   * acp-approval-bridge) call this so `connection.sessionUpdate(...)` /
   * `connection.requestPermission(...)` target the right session from OUTSIDE
   * the request handler. Returns `undefined` for an unknown / dropped session.
   */
  getConnection(acpSessionId: string): AgentSideConnection | undefined;
  /**
   * Register the `AgentSideConnection` constructed in {@link startAcpServer}
   * (ACP-01). Sessions opened after this call are keyed to the connection, and
   * the registry is emptied when the connection's `signal` aborts (close).
   */
  registerConnection(connection: AgentSideConnection): void;
  /**
   * Constructed-but-not-yet-subscribed activity + approval bridges (ACP-02 /
   * ACP-04), present when {@link AcpServerDeps.activityStreamPort} was injected.
   * startAcpServer builds them once per connection from that port + this
   * handle's `getConnection`. Their `subscribe(ctx)` is the PER-TURN seam: it
   * must be invoked from the ACP turn lifecycle once a `TurnActivityContext`
   * exists. That per-turn invocation is the live-IDE rendering path covered by
   * the `human_needed` verification item (74-VERIFICATION.md) — the
   * construction (here) is what 74-07 wires and tests; no fabricated per-turn
   * ctx is invented. Undefined when no activityStreamPort was injected.
   */
  bridges?: {
    readonly activity: AcpActivityBridge;
    readonly approval: AcpApprovalBridge;
  };
}

/**
 * Create an ACP Agent implementation that delegates to Comis's agent executor.
 *
 * The returned object satisfies the ACP Agent interface with:
 * - initialize: Returns protocol version, agent info, and capabilities
 * - newSession: Creates an Comis session mapped to the ACP session and retains
 *   the active connection per session id (ACP-01)
 * - prompt: Extracts user message and delegates to executeAgent
 * - authenticate: No-op for local agent
 * - cancel: Removes session from the map AND drops the retained connection
 *
 * The connection itself is constructed in {@link startAcpServer} (the SDK's
 * `AgentSideConnection` is built there over the stdio stream). It is threaded
 * back in via {@link AcpAgentHandle.registerConnection} so `newSession` can key
 * it per ACP session id — giving the bridges a handle to push `sessionUpdate`.
 *
 * @param deps - Server dependencies (executeAgent, logger, version)
 * @returns Handle exposing the ACP Agent, the session map, and the connection
 *   registry accessors (ACP-01)
 */
export function createAcpAgent(deps: AcpServerDeps): AcpAgentHandle {
  const sessionMap = createAcpSessionMap();
  const version = deps.version ?? "0.0.1";

  // Per-session AgentSideConnection registry (ACP-01). Keyed by ACP sessionId
  // (which equals AcpSessionKey.peerId — see acp-session-map.ts). The bridges
  // (Wave 2) read it via getConnection; populated in newSession, dropped in
  // cancel and on connection-signal abort (close).
  const connections = new Map<string, AgentSideConnection>();
  // The connection registered by startAcpServer; sessions opened after
  // registration are keyed to it.
  let activeConnection: AgentSideConnection | undefined;

  const agent: Agent = {
    async initialize(params: InitializeRequest): Promise<InitializeResponse> {
      deps.logger.info(
        { protocolVersion: params.protocolVersion },
        "ACP initialize request received",
      );

      return {
        protocolVersion: params.protocolVersion,
        agentInfo: {
          name: "comis",
          title: "Comis",
          version,
        },
        agentCapabilities: {},
      };
    },

     
    async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
      const sessionId = crypto.randomUUID();
      sessionMap.create(sessionId);

      // ACP-01: retain the active connection per ACP session id so the bridges
      // (Wave 2) can push sessionUpdate / requestPermission from outside this
      // handler. Dropped in cancel and on connection-signal abort.
      if (activeConnection) {
        connections.set(sessionId, activeConnection);
      }

      // WIRE-04 hook: register an ACP activity renderer through the injected
      // ActivityStreamPort on session open so the activity pipe is reachable from
      // ACP. The full per-turn subscription + frame→`connection.sessionUpdate`
      // bridge (acp-activity-bridge.ts) is Phase 74; this plan only proves the
      // port is wired and reachable here (the registration seam).
      if (deps.activityStreamPort) {
        deps.logger.info(
          { sessionId, submodule: "acp-activity-renderer" },
          "ACP activity renderer registered for session (Structured strategy; bridge lands in Phase 74)",
        );
      }

      deps.logger.info({ sessionId }, "ACP session created");

      return { sessionId };
    },

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const sessionKey = sessionMap.get(params.sessionId);
      if (!sessionKey) {
        deps.logger.error(
          { sessionId: params.sessionId, hint: "Ensure newSession was called before prompt, or session was not cancelled", errorKind: "validation" as const },
          "ACP prompt for unknown session",
        );
        throw new Error(`Unknown ACP session: ${params.sessionId}`);
      }

      const message = extractUserMessage(params.prompt);

      try {
        await deps.executeAgent({ message, sessionKey });

        return { stopReason: "end_turn" };
      } catch (err) {
        deps.logger.error(
          { err, sessionId: params.sessionId, hint: "Check agent executor logs or LLM provider connectivity", errorKind: "dependency" as const },
          "ACP prompt execution failed",
        );
        return { stopReason: "end_turn" };
      }
    },

    async authenticate(
       
      _params: AuthenticateRequest,
    ): Promise<AuthenticateResponse | void> {
      // No-op for local agent — no authentication required
    },

    async cancel(params: CancelNotification): Promise<void> {
      deps.logger.info(
        { sessionId: params.sessionId },
        "ACP cancel request received",
      );
      sessionMap.remove(params.sessionId);
      // ACP-01: drop the retained connection for this session so a cancelled
      // session is no longer reachable via getConnection (a dropped entry makes
      // the bridges no-op — T-74-01 / T-74-04).
      connections.delete(params.sessionId);
      // Actual execution abort is a future enhancement
    },
  };

  function getConnection(
    acpSessionId: string,
  ): AgentSideConnection | undefined {
    return connections.get(acpSessionId);
  }

  function registerConnection(connection: AgentSideConnection): void {
    activeConnection = connection;
    // Drop every retained connection when this connection closes (the SDK
    // aborts connection.signal on close — acp.d.ts:150). A closed/aborted
    // connection must never be used to write to a dead session (T-74-01).
    connection.signal.addEventListener("abort", () => {
      connections.clear();
      activeConnection = undefined;
    });
  }

  // ACP-02 / ACP-04: construct the activity + approval bridge FACTORIES once
  // (when the redacted ActivityStreamPort is injected) from that port + this
  // handle's getConnection. §19.6 M6: only the redacted port + getConnection
  // cross into the bridges — no raw event source. Their per-turn `subscribe(ctx)`
  // is invoked from the ACP turn lifecycle (the live-IDE seam, human_needed).
  const bridges = deps.activityStreamPort
    ? {
        // logger omitted: the narrow AcpServerDeps.logger ({info,error,warn})
        // is not a ComisLogger (no `.debug`); the bridges' DEBUG traces are
        // optional, so the construction stays type-honest without a cast.
        activity: createAcpActivityBridge({
          activityStreamPort: deps.activityStreamPort,
          getConnection,
        }),
        approval: createAcpApprovalBridge({
          activityStreamPort: deps.activityStreamPort,
          getConnection,
        }),
      }
    : undefined;

  return { agent, sessionMap, getConnection, registerConnection, bridges };
}

/**
 * Start the ACP server with stdio transport.
 *
 * Creates an ndJson stream over stdin/stdout and establishes an AgentSideConnection.
 * The server runs until the IDE closes the connection (stdin ends).
 *
 * @param deps - Server dependencies (executeAgent, logger, version)
 */
export async function startAcpServer(deps: AcpServerDeps): Promise<void> {
  // Wrap stdout as a WritableStream<Uint8Array>
  const writableStdout = new WritableStream<Uint8Array>({
    write(chunk) {
      process.stdout.write(chunk);
    },
  });

  // Wrap stdin as a ReadableStream<Uint8Array>
  // Node.js >= 20 supports ReadableStream.from() on async iterables
  const fromStream = (ReadableStream as unknown as { from(source: NodeJS.ReadableStream): ReadableStream<Uint8Array> }).from;
  const readableStdin = fromStream(process.stdin);

  // Create ndJson stream for ACP communication
  const stream = ndJsonStream(writableStdout, readableStdin);

  // Build the ACP agent handle ONCE so the per-session connection registry
  // (ACP-01) survives for the life of the connection. The handle's agent is
  // handed to the SDK; the constructed connection is threaded back via
  // registerConnection so newSession can key it per ACP session id.
  const handle = createAcpAgent(deps);

  // Create the agent-side connection
  const connection = new AgentSideConnection(() => handle.agent, stream);

  // ACP-01: retain the connection in the per-session registry. Sessions opened
  // after this point are keyed to it; the registry empties on signal abort.
  handle.registerConnection(connection);

  // ACP-03: construct the plan bridge ONCE per connection when both the
  // read-only ExecutionPlanPort and the event bus are injected. The bridge
  // subscribes `sep:plan_extracted` + `tool:executed` on the bus and pushes a
  // `{ sessionUpdate: "plan", entries }` frame through the connection resolved
  // via handle.getConnection. §19.6 M6: ONLY the read-only port + getConnection
  // cross into the bridge — no raw plan ref / unredacted source. T-74-34: if the
  // port is present but the bus is absent, log a single WARN and skip (fail-safe
  // no-frames rather than fail-open). The activity + approval bridges are
  // constructed on the handle (handle.bridges) — their per-turn `subscribe(ctx)`
  // is the live-IDE seam invoked from the ACP turn lifecycle (human_needed).
  let unsubscribePlan: (() => void) | undefined;
  if (deps.executionPlanPort) {
    if (deps.eventBus) {
      unsubscribePlan = createAcpPlanBridge({
        eventBus: deps.eventBus,
        executionPlanPort: deps.executionPlanPort,
        getConnection: handle.getConnection,
      });
    } else {
      deps.logger.warn(
        {
          submodule: "acp-server",
          hint: "Inject AcpServerDeps.eventBus alongside executionPlanPort to enable the SEP plan bridge",
          errorKind: "config" as const,
        },
        "ACP executionPlanPort present but eventBus absent — plan bridge skipped",
      );
    }
  }

  deps.logger.info("ACP server started, awaiting IDE connection on stdio");

  // Wait for the connection to close (stdin ends or IDE disconnects)
  await connection.closed;

  // Teardown symmetry (RESEARCH Pattern 3 / 74-06 NOTE step 4): detach the plan
  // bridge's bus handlers so it stops re-emitting once the connection ends
  // (T-74-32 — no frame written to a dead/wrong session after close).
  unsubscribePlan?.();

  deps.logger.info("ACP server connection closed, shutting down");
}
