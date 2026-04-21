// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic, frozen test fixture data for CLI command tests.
 *
 * Provides sample data for all CLI test domains: config YAML, agents, sessions,
 * memory entries, channel status, and health checks. All data is deep-frozen
 * to guarantee determinism and prevent accidental mutation across test files.
 *
 * @module
 */

/**
 * Recursively freeze an object and all nested objects/arrays.
 * Returns the same object cast as Readonly<T>.
 */
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }

  Object.freeze(obj);

  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && value !== undefined && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }

  return obj as Readonly<T>;
}

/**
 * Frozen sample data for all CLI test domains.
 *
 * Usage:
 * ```typescript
 * import { FIXTURES } from '../test-fixtures.js';
 * // FIXTURES.agents, FIXTURES.sessions, etc.
 * ```
 */
export const FIXTURES = deepFreeze({
  /** Valid YAML string representing a realistic comis config. */
  configYaml: `tenantId: test-tenant
logLevel: debug
gateway:
  host: localhost
  port: 3100
  tokens:
    - name: test-token
      secret: test-secret-abc123
routing:
  agents:
    assistant:
      defaultProvider: anthropic
      defaultModel: claude-sonnet-4-5-20250929
`,

  /** Array of 2 agent objects matching the shape returned by config.get. */
  agents: [
    {
      name: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      bindings: ["channel:discord-main"],
    },
    {
      name: "moderator",
      provider: "openai",
      model: "gpt-4o",
      bindings: [] as string[],
    },
  ],

  /** Array of 3 session objects spanning different platforms. */
  sessions: [
    {
      key: "discord:guild-123:chan-456:user-789",
      channelId: "chan-456",
      userId: "user-789",
      createdAt: "2026-01-15T10:00:00Z",
      lastActivity: "2026-01-15T11:30:00Z",
      messageCount: 42,
    },
    {
      key: "telegram:chat-100:user-200",
      channelId: "chat-100",
      userId: "user-200",
      createdAt: "2026-01-14T08:00:00Z",
      lastActivity: "2026-01-14T09:00:00Z",
      messageCount: 7,
    },
    {
      key: "slack:workspace-1:channel-2:user-3",
      channelId: "channel-2",
      userId: "user-3",
      createdAt: "2026-01-13T14:00:00Z",
      lastActivity: "2026-01-13T14:05:00Z",
      messageCount: 1,
    },
  ],

  /** Array of 3 memory entries with varying scores and sources. */
  memoryEntries: [
    {
      id: "mem-001",
      content: "User prefers dark mode and compact layout",
      score: 0.92,
      timestamp: "2026-01-15T11:00:00Z",
      agentId: "assistant",
      metadata: { source: "conversation" },
    },
    {
      id: "mem-002",
      content: "Project deadline is March 15",
      score: 0.85,
      timestamp: "2026-01-14T09:30:00Z",
      agentId: "assistant",
      metadata: { source: "extraction" },
    },
    {
      id: "mem-003",
      content: "API key rotation scheduled for next week",
      score: 0.78,
      timestamp: "2026-01-13T16:00:00Z",
      agentId: "moderator",
      metadata: { source: "conversation" },
    },
  ],

  /** Array of 3 channel statuses covering connected/disconnected/error states. */
  channelStatus: [
    {
      id: "discord-main",
      type: "discord",
      status: "connected",
      connectedAt: "2026-01-15T08:00:00Z",
    },
    {
      id: "telegram-bot",
      type: "telegram",
      status: "disconnected",
      connectedAt: null,
    },
    {
      id: "slack-workspace",
      type: "slack",
      status: "error",
      connectedAt: null,
      error: "Invalid token",
    },
  ],

  /** Array of 3 health check results covering pass/fail/warn statuses. */
  healthChecks: [
    {
      category: "config",
      name: "Config file exists",
      status: "pass",
      message: "Config found at /etc/comis/config.yaml",
    },
    {
      category: "daemon",
      name: "Daemon process running",
      status: "fail",
      message: "No daemon process found",
    },
    {
      category: "gateway",
      name: "Gateway responding",
      status: "warn",
      message: "Gateway response slow (>500ms)",
    },
  ],
});
