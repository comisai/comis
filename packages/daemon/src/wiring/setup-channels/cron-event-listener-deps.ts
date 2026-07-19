// SPDX-License-Identifier: Apache-2.0
/** Composition-root dependencies captured by cron delivery listeners. */

import type {
  AppContainer,
  ChannelPort,
  ClockPort,
  DeliveryService,
  MemoryCausalStore,
  MemoryConsolidationStore,
  MemoryEntityStore,
  MemoryLifecyclePort,
  MemoryPort,
  MentalModelStorePort,
  OutcomeSignalPort,
  SessionKey,
  TranscriptionPort,
} from "@comis/core";
import type {
  ActiveRunRegistry,
  AgentExecutor,
  ComisSessionManager,
  createSessionLifecycle,
} from "@comis/agent";
import type { ComisLogger } from "@comis/infra";
import type { createSessionStore, MemoryApi } from "@comis/memory";
import type { ExecutionLogEntry } from "@comis/scheduler";

// @optional-field-count: 19 optional fields — this is the composition-root
// dependency bag for opt-in channel, media, and offline-memory cron paths.
export interface CronEventListenerDeps {
  container: AppContainer;
  executors: Map<string, AgentExecutor>;
  defaultAgentId: string;
  sessionManager: ReturnType<typeof createSessionLifecycle>;
  sessionStore: ReturnType<typeof createSessionStore>;
  logger: ComisLogger;
  clock: ClockPort;
  resolveAccessToken?: (agentId: string, provider: string) => Promise<string | undefined>;
  adaptersByType: Map<string, ChannelPort>;
  deliveryService: DeliveryService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool crosses the SDK boundary
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: SessionKey }) => Promise<any[]>;
  transcriber?: TranscriptionPort;
  workspaceDirs?: Map<string, string>;
  memoryAdapter?: MemoryPort;
  lcdStore?: import("@comis/core").ContextStorePort;
  contextBrowse?: import("@comis/core").ContextBrowsePort;
  entityStore?: MemoryEntityStore;
  causalStore?: MemoryCausalStore;
  consolidationStore?: MemoryConsolidationStore;
  memoryLifecycleStore?: MemoryLifecyclePort;
  outcomeStore?: OutcomeSignalPort;
  learnedSkillStore?: MentalModelStorePort;
  memoryApi?: MemoryApi;
  tenantId: string;
  piSessionAdapters?: Map<string, Pick<
    ComisSessionManager,
    "getSessionStats" | "destroySession" | "persistInboundMessage"
  >>;
  cronExecutionTrackers?: Map<string, { record(entry: ExecutionLogEntry): Promise<void> }>;
  activeRunRegistry?: ActiveRunRegistry;
}
