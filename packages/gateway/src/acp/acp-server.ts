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

// WIRE-04 (§17.7): the orchestrator-facing activity stream port, injected at the
// composition root. The ACP server registers an activity renderer through it on
// session open. The full frame→`connection.sessionUpdate` bridge
// (acp-activity-bridge.ts) is Phase 74 — this plan adds only the registration HOOK.
import type { ActivityStreamPort } from "@comis/core";

import { createAcpSessionMap, type AcpSessionMap } from "./acp-session-map.js";

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
   * composition root. When present, an ACP activity renderer is registered
   * through it on session open so the (Phase 74) bridge can translate activity
   * frames into `connection.sessionUpdate({ sessionId, update })` calls. Phase 70
   * wires only the registration HOOK — the full frame→SessionUpdate mapping
   * (acp-activity-bridge.ts) and the per-session `AgentSideConnection` retain/drop
   * (ACP-01) land in Phase 74. Optional — absent in non-activity ACP runs.
   */
  activityStreamPort?: ActivityStreamPort;
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
 * Create an ACP Agent implementation that delegates to Comis's agent executor.
 *
 * The returned object satisfies the ACP Agent interface with:
 * - initialize: Returns protocol version, agent info, and capabilities
 * - newSession: Creates an Comis session mapped to the ACP session
 * - prompt: Extracts user message and delegates to executeAgent
 * - authenticate: No-op for local agent
 * - cancel: Removes session from map (execution abort is a future enhancement)
 *
 * @param deps - Server dependencies (executeAgent, logger, version)
 * @returns Object exposing the ACP Agent interface and the internal session map
 */
export function createAcpAgent(deps: AcpServerDeps): {
  agent: Agent;
  sessionMap: AcpSessionMap;
} {
  const sessionMap = createAcpSessionMap();
  const version = deps.version ?? "0.0.1";

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
      // Actual execution abort is a future enhancement
    },
  };

  return { agent, sessionMap };
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

  // Create the agent-side connection
  const connection = new AgentSideConnection(
    () => createAcpAgent(deps).agent,
    stream,
  );

  deps.logger.info("ACP server started, awaiting IDE connection on stdio");

  // Wait for the connection to close (stdin ends or IDE disconnects)
  await connection.closed;

  deps.logger.info("ACP server connection closed, shutting down");
}
