// SPDX-License-Identifier: Apache-2.0
/**
 * `rig-config.ts` — the THROWAWAY daemon-config writer + its load-bearing
 * constants, extracted from `rig.ts` so BOTH the in-process rig (`rig.ts`) and
 * the DETACHED-subprocess rig (`rig-daemon.ts`, Phase 208 Plan 08 — the
 * cold-shell Option-A stretch) share ONE config-shape source of truth.
 *
 * WHY A SEPARATE MODULE (the Option-A constraint). `rig.ts` statically imports
 * `@comis/core` (`validateLocalServerUrl`) — a BARE specifier that resolves only
 * under the vitest live-config alias map, NOT under the plain `tsx` the detached
 * subprocess runs as (a standalone `node_modules/@comis/core` has no `exports`
 * main → `ERR_PACKAGE_PATH_NOT_EXPORTED`). So the subprocess CANNOT import
 * `rig.ts`. This module carries ONLY `buildConfigYaml` + its plain-string
 * constants (ZERO `@comis/*` imports), so it imports cleanly under both vitest
 * AND a bare `tsx` subprocess. `rig.ts` re-exports these so its public surface is
 * unchanged.
 *
 * TEST-HARNESS — lives under the test tree, never the packages source-tree; ZERO
 * production code change.
 *
 * @module
 */

/**
 * The ≥32-char LITERAL gateway token the temp config carries.
 *
 * Pitfall 4 (RESEARCH / schema-gateway.ts:45 `z.string().min(32)`;
 * token-auth.ts `timingSafeEqual`): a literal must be ≥32 chars and an env-ref
 * does NOT resolve for the test gateway. This is the canonical 38-char
 * `config.test.yaml` literal — reused verbatim.
 */
export const GATEWAY_TOKEN = "test-secret-key-for-integration-tests";

/** The fake bot token grammy builds `/bot<token>/<method>` paths from (never hits real Telegram). */
export const FAKE_BOT_TOKEN = "1234567:emulator-fake-token";

/**
 * The isolated `memory.db` file name the throwaway config writes (under the rig's
 * `COMIS_DATA_DIR`). Threaded into both {@link buildConfigYaml} and the rig's
 * recorded `memoryDbPath` (the controller's `resetDeep()` wipes), so the YAML and
 * the recorded path can never drift.
 */
export const MEMORY_DB_FILE = "test-memory-channel-emu.db";

/**
 * Build the throwaway daemon YAML. Modeled on
 * `test/config/config.qwen36-local.test.yaml` (the canonical keyless-ollama
 * config) + a `channels.telegram` block carrying the dynamic `apiRoot` seam.
 *
 * - `channels.telegram.apiRoot = http://127.0.0.1:P` — THE integration (zero code
 *   change); `allowFrom: []` allows all senders; a fake `botToken` never reaches
 *   real Telegram.
 * - keyless `ollama` provider — `$0`/offline; the `/v1` suffix is required (pi-ai
 *   posts to `${baseUrl}/chat/completions`; bare ollama 404s without it). No
 *   secret entry (ollama is keyless → the daemon uses the `ollama-no-auth`
 *   sentinel; omitting the key avoids a "Missing env var" FATAL at boot).
 * - `gateway.tokens[0].secret` is the ≥32-char LITERAL (Pitfall 4).
 * - `dataDir: ""` resolves to `COMIS_DATA_DIR` (set per-rig by the caller).
 *
 * LEARNING (REACT-03 / Plan 206-03, GOTCHA C+D): the Verified-Learning loop is
 * byte-identical-OFF by default (setup-learning-reactions.ts:651-656,720). The
 * `agents.default` block ENABLES it (learningOutcome/learning) and grants
 * the reactor trust ≥ `known`
 * (`elevatedReply.defaultTrustLevel`), and the `memory` block sets
 * `memory.enabled` — so a 👍 on an agent reply persists an `outcome_events` row
 * (the `0.6 × trustWeight("known") 0.4 = 0.24 ≥ 0.05` write floor) and drives
 * synthesis. This is RIG-config ONLY — it does NOT flip a product default; the
 * scenario's git-porcelain guard re-asserts zero product source change.
 *
 * EXPORTED so the Task-1 config-shape test (`rig.test.ts`) can assert the gotchas
 * on the produced YAML (test-infra-only).
 */
export function buildConfigYaml(apiRoot: string, gatewayPort: number, model: string): string {
  // The keyless leg uses ollama; an explicit non-keyless model string is passed
  // through as the provider model id (operator/live.env path).
  const providerModelId = model === "keyless" ? "qwen3.6:35b" : model;
  return `# THROWAWAY config — Phase 204 channel-emulation walking skeleton (rig.ts).
# Written AFTER the emulator starts so channels.telegram.apiRoot carries the
# kernel-allocated emulator port. The daemon reads this via COMIS_CONFIG_PATHS.
tenantId: "test"
logLevel: "debug"
dataDir: "" # Resolves to COMIS_DATA_DIR at runtime (set per-rig by the rig).

channels:
  telegram:
    enabled: true
    # A fake token — grammy builds /bot<token>/<method> paths from it but it
    # never reaches real Telegram (apiRoot redirects every call to the emulator).
    botToken: "${FAKE_BOT_TOKEN}"
    # THE redirect seam — the whole integration, zero production code change
    # (setup-channels-adapters.ts:90-110 passes this to validateBotToken + createTelegramPlugin).
    apiRoot: "${apiRoot}"
    allowFrom: [] # [] = allow all senders.

providers:
  entries:
    keyless-local:
      type: ollama
      # /v1 suffix required: pi-ai registers type=ollama as openai-completions and
      # posts to \`\${baseUrl}/chat/completions\` — bare Ollama 404s without /v1.
      baseUrl: "http://localhost:11434/v1"
      # Keyless — ollama is in KEYLESS_PROVIDER_TYPES; no secret entry needed; the
      # daemon registers the ollama-no-auth sentinel (omitting avoids a boot FATAL).
      models:
        - id: "${providerModelId}"
          input: ["text", "image"]
          contextWindow: 131072
          reasoning: true
          maxTokens: 2048

models:
  # defaultProvider keeps the agent on the keyless local provider ($0/offline).
  defaultProvider: ollama
  # defaultModel lets an ad-hoc agent resolve the custom-provider model.
  defaultModel: "keyless-local:${providerModelId}"

agents:
  default:
    name: "ChannelEmuTestAgent"
    provider: keyless-local
    model: "${providerModelId}"
    maxSteps: 6
    budgets:
      perExecution: 500000
      perHour: 5000000
      perDay: 50000000
    circuitBreaker:
      failureThreshold: 100
      resetTimeoutMs: 1000
    rag:
      enabled: false
    # REACT-03 GOTCHA C — learning is byte-identical-OFF until BOTH
    # memory.enabled (below) AND these per-agent toggles are on
    # (setup-learning-reactions.ts:651-656,720). Without learningOutcome the
    # reaction observe is gated off (and recordOutboundMessage is undefined → no
    # ReactionTrajectoryMap binding); without learning the reflection cron never runs.
    learningOutcome:
      enabled: true
    learning:
      enabled: true
    # REACT-03 GOTCHA D — the reactor trust floor (the #1 REACT-03 trap). The DM
    # reactor (fromUserId 111) defaults to "external"
    # (elevatedReply.defaultTrustLevel ?? "external"), and
    # 0.6 (REACTION_BASE_CONFIDENCE) x 0.05 (trustWeight external) = 0.03 <
    # 0.05 (REACTION_MIN_CONFIDENCE_TO_WRITE) -> the thumbs-up SILENTLY persists
    # no row. "known" -> 0.6 x 0.4 = 0.24 >= 0.05 (single-user DM; the group
    # spoof guard is Phase 208). Rig config ONLY — never a product-default flip.
    elevatedReply:
      defaultTrustLevel: "known"

gateway:
  enabled: true
  host: "127.0.0.1"
  port: ${gatewayPort}
  tokens:
    - id: "tg-live"
      # ≥32-char LITERAL (38 chars) — env-refs do NOT resolve for the test gateway
      # (schema-gateway.ts:45 z.string().min(32); token-auth.ts timingSafeEqual).
      secret: "${GATEWAY_TOKEN}"
      scopes: ["rpc", "ws", "admin"]
  rateLimit:
    windowMs: 60000
    maxRequests: 10000
  maxBatchSize: 50
  wsHeartbeatMs: 30000

memory:
  dbPath: "${MEMORY_DB_FILE}"
  # REACT-03 GOTCHA C — someLearningOn requires memory.enabled (the master
  # cost-feature switch, default ON but explicit here for the config-shape test);
  # without it learningOutcomeEnabled is false for every agent ->
  # recordOutboundMessage undefined -> no reaction map binding at all.
  enabled: true

security:
  agentToAgent:
    enabled: true

monitoring:
  disk:
    enabled: false
  resources:
    enabled: false
  systemd:
    enabled: false
  securityUpdates:
    enabled: false
  git:
    enabled: false
`;
}

/**
 * Build the throwaway daemon YAML for a SIGNAL rig (CHAN2-02, Phase 209-05). The
 * Signal sibling of {@link buildConfigYaml}: identical in every respect EXCEPT
 * the channel block — it writes a `channels.signal` block carrying the dynamic
 * `baseUrl` redirect seam instead of `channels.telegram` with `apiRoot`.
 *
 * - `channels.signal = { enabled:true, baseUrl: "http://127.0.0.1:P" }` — THE
 *   integration (zero production code change). The verified seam:
 *   `setup-channels-adapters.ts:216-227` reads `signal.baseUrl` →
 *   `validateSignalConnection({ baseUrl })` (the boot `GET /api/v1/check`) →
 *   `createSignalPlugin({ baseUrl })`, so the REAL Signal adapter's JSON-RPC +
 *   SSE hit the loopback emulator with NO product change. `schema-channel.ts`
 *   already has `signal.baseUrl` (default `http://127.0.0.1:8080`).
 * - NO `account` — the daemon boot is the health-check ONLY (the adapter's
 *   `validateSignalConnection` skips `listAccounts` when no account is
 *   configured, `credential-validator.ts:56`), so the rig boots account-less
 *   ($0/offline/isolated — no real Signal account, no real network, T-209-12).
 * - keyless `ollama` provider, `models.defaultProvider: ollama`, the
 *   `agents.default` learning block, and the ≥32-char LITERAL `gateway` token —
 *   ALL byte-identical to {@link buildConfigYaml} (the only difference is the
 *   channel block). The learning gotchas (REACT-03) carry over unchanged.
 *
 * CONSTRAINT (the same as {@link buildConfigYaml}): this module — and therefore
 * this writer — stays `@comis/*`-FREE (the detached `rig-daemon.ts` imports it
 * under a bare `tsx`; a `@comis/*` import would break that AND is a
 * published-graph concern, T-209-13). It is plain-string only.
 *
 * EXPORTED so the Task-1 config-shape test (`rig.test.ts`) asserts the seam +
 * the no-account posture on the produced YAML, and so `rig.ts`'s channel→factory
 * map registers it as the Signal config writer (the ONE-LINE registration).
 */
export function buildSignalConfigYaml(baseUrl: string, gatewayPort: number, model: string): string {
  // The keyless leg uses ollama; an explicit non-keyless model string is passed
  // through as the provider model id (operator/live.env path) — identical to
  // buildConfigYaml.
  const providerModelId = model === "keyless" ? "qwen3.6:35b" : model;
  return `# THROWAWAY config — Phase 209 channel-emulation, SIGNAL rig (rig.ts).
# Written AFTER the emulator starts so channels.signal.baseUrl carries the
# kernel-allocated emulator port. The daemon reads this via COMIS_CONFIG_PATHS.
tenantId: "test"
logLevel: "debug"
dataDir: "" # Resolves to COMIS_DATA_DIR at runtime (set per-rig by the rig).

channels:
  signal:
    enabled: true
    # THE redirect seam — the whole integration, zero production code change
    # (setup-channels-adapters.ts:216-227 reads signal.baseUrl → validateSignalConnection
    # → createSignalPlugin). The loopback emulator's apiRoot.
    baseUrl: "${baseUrl}"
    # NO account — validateSignalConnection skips listAccounts when no account is
    # set (credential-validator.ts:56), so the boot is the GET /api/v1/check
    # health-check only ($0/offline/isolated; no real Signal account, no network).

providers:
  entries:
    keyless-local:
      type: ollama
      # /v1 suffix required: pi-ai registers type=ollama as openai-completions and
      # posts to \`\${baseUrl}/chat/completions\` — bare Ollama 404s without /v1.
      baseUrl: "http://localhost:11434/v1"
      # Keyless — ollama is in KEYLESS_PROVIDER_TYPES; no secret entry needed; the
      # daemon registers the ollama-no-auth sentinel (omitting avoids a boot FATAL).
      models:
        - id: "${providerModelId}"
          input: ["text", "image"]
          contextWindow: 131072
          reasoning: true
          maxTokens: 2048

models:
  # defaultProvider keeps the agent on the keyless local provider ($0/offline).
  defaultProvider: ollama
  # defaultModel lets an ad-hoc agent resolve the custom-provider model.
  defaultModel: "keyless-local:${providerModelId}"

agents:
  default:
    name: "ChannelEmuTestAgent"
    provider: keyless-local
    model: "${providerModelId}"
    maxSteps: 6
    budgets:
      perExecution: 500000
      perHour: 5000000
      perDay: 50000000
    circuitBreaker:
      failureThreshold: 100
      resetTimeoutMs: 1000
    rag:
      enabled: false
    # REACT-03 GOTCHA C — learning is byte-identical-OFF until BOTH
    # memory.enabled (below) AND these per-agent toggles are on
    # (setup-learning-reactions.ts:651-656,720). Carried over from buildConfigYaml
    # so the Signal rig exercises the SAME learning bed.
    learningOutcome:
      enabled: true
    learning:
      enabled: true
    # REACT-03 GOTCHA D — the reactor trust floor (the #1 REACT-03 trap):
    # 0.6 (REACTION_BASE_CONFIDENCE) x 0.4 (trustWeight known) = 0.24 >=
    # 0.05 (REACTION_MIN_CONFIDENCE_TO_WRITE). Rig config ONLY — never a
    # product-default flip.
    elevatedReply:
      defaultTrustLevel: "known"

gateway:
  enabled: true
  host: "127.0.0.1"
  port: ${gatewayPort}
  tokens:
    - id: "chan-live"
      # ≥32-char LITERAL (38 chars) — env-refs do NOT resolve for the test gateway
      # (schema-gateway.ts:45 z.string().min(32); token-auth.ts timingSafeEqual).
      secret: "${GATEWAY_TOKEN}"
      scopes: ["rpc", "ws", "admin"]
  rateLimit:
    windowMs: 60000
    maxRequests: 10000
  maxBatchSize: 50
  wsHeartbeatMs: 30000

memory:
  dbPath: "${MEMORY_DB_FILE}"
  # REACT-03 GOTCHA C — someLearningOn requires memory.enabled (the master
  # cost-feature switch, default ON but explicit here for the config-shape test).
  enabled: true

security:
  agentToAgent:
    enabled: true

monitoring:
  disk:
    enabled: false
  resources:
    enabled: false
  systemd:
    enabled: false
  securityUpdates:
    enabled: false
  git:
    enabled: false
`;
}
