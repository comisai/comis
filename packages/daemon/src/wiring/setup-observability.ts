// SPDX-License-Identifier: Apache-2.0
/**
 * Observability subsystem setup: token tracking, latency recording,
 * cost aggregation, diagnostics, billing, channel activity, and
 * delivery tracing.
 * Extracted from daemon.ts steps 4 through 4.5 to isolate
 * cross-agent observability wiring from the main startup sequence.
 * @module
 */

import type { AppContainer, ActivityTheme, ClockPort, AppConfig } from "@comis/core";
import { systemSetInterval, getToolMetadata, parseFormattedSessionKey } from "@comis/core";
import { createActivityStream, type ActivityStream } from "@comis/observability";
import { createCostTracker, createCacheBreakDiffWriter, createSpendAccumulator } from "@comis/agent";
import type { SpendAccumulator, SpendScope } from "@comis/agent";
import type { createTokenTracker } from "../observability/token-tracker.js";
import type { TokenTracker } from "../observability/token-tracker.js";
import { createDiagnosticCollector } from "../observability/diagnostic-collector.js";
import type { DiagnosticCollector } from "../observability/diagnostic-collector.js";
import { createBillingEstimator } from "../observability/billing-estimator.js";
import type { BillingEstimator } from "../observability/billing-estimator.js";
import { createChannelActivityTracker } from "../observability/channel-activity-tracker.js";
import type { ChannelActivityTracker } from "../observability/channel-activity-tracker.js";
import { createDeliveryTracer } from "../observability/delivery-tracer.js";
import type { DeliveryTracer } from "../observability/delivery-tracer.js";

// ---------------------------------------------------------------------------
// The OTel extension seam contract (LOCAL, structural)
// ---------------------------------------------------------------------------

/**
 * The shape the daemon passes into the opt-in `@comis/observability-otel`
 * extension's `registerOtelExporter`. Declared LOCALLY (structurally) rather than
 * `import type`-ed from the extension so the daemon's `tsc` build needs NEITHER
 * the extension's `dist/*.d.ts` NOR a tsconfig project-reference — core/daemon
 * `build:clean` succeed with `packages/observability-otel/dist` ABSENT. It
 * mirrors the extension's exported `OtelExporterDeps`; structural assignability
 * does the rest at the dynamic-import call site (the extension validates the real
 * shape). The VALUE (`registerOtelExporter`) is reached ONLY via the config-gated
 * `await import()` below — never a static value-import (that would put the extension
 * back in the daemon's build graph).
 */
interface OtelExporterSeamDeps {
  eventBus: AppContainer["eventBus"];
  /**
   * The boot clock. OPTIONAL: some call shapes may not thread a
   * clock, and the extension never calls wall-clock APIs — so it is forwarded ONLY
   * when present (a conditional spread), never as `undefined as ClockPort` (an
   * unsound contract lie). The extension's own `OtelExporterDeps.clock` stays
   * required; structural assignability holds because we omit the key when absent.
   */
  clock?: ClockPort;
  observability: AppConfig["observability"];
  spendAccumulator?: SpendAccumulator;
  /** The daemon version label for `comis_build_info` (pkgJson.version). */
  version?: string;
  logger?: import("@comis/core").ComisLogger;
}

/** The minimal shape of the dynamically-imported extension module the seam calls. */
interface OtelExtensionModule {
  registerOtelExporter(deps: OtelExporterSeamDeps): { shutdown(): Promise<void> };
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the observability setup phase. */
export interface ObservabilityResult {
  tokenTracker: TokenTracker;
  sharedCostTracker: ReturnType<typeof createCostTracker>;
  diagnosticCollector: DiagnosticCollector;
  billingEstimator: BillingEstimator;
  channelActivityTracker: ChannelActivityTracker;
  deliveryTracer: DeliveryTracer;
  /**
   * The canonical redacted `ActivityEvent` source (§17.7). Subscribes
   * to the EventBus at construction; the daemon injects it as the orchestrator-
   * facing `ActivityStreamPort` (via `ExecutionPipelineDeps.activityStreamPort`)
   * and the ACP renderer hook. It is NEVER imported directly by the orchestrator
   * — the composition root owns this DI seam (the core+observability→channels
   * boundary; §4.7).
   */
  activityStream: ActivityStream;
  /**
   * Drain + unsubscribe hook for {@link activityStream}. The
   * shutdown chain calls this to detach every EventBus handler and clear the
   * correlation index so per-turn bounded queues drain and no pending placeholder
   * is orphaned across a restart.
   */
  disposeActivityStream: () => void;
  /**
   * The single daemon-wide spend accumulator (the dollars
   * kill-switch enforcement state). CONSTRUCTED here beside the cross-agent
   * cost-tracker subscriber, with the live `recordSpend` subscriber registered
   * on `observability:token_usage`. The per-agent bridge guards hold a REFERENCE
   * to this SAME instance. REHYDRATION happens at the boot
   * composition root (daemon.ts) via {@link rehydrateSpendFromStore} once
   * `obsStore` exists. `undefined` when `clock`/`config` were not threaded
   * (e.g. test call shapes) — the spend path is then inert.
   */
  spendAccumulator?: SpendAccumulator;
  /**
   * The OTLP/Prometheus exporter registration handle — present ONLY
   * when `observability.otel.enabled || observability.prometheus.enabled` AND the
   * opt-in `@comis/observability-otel` extension loaded successfully. `shutdown()`
   * flushes + closes the OTel providers (and stops the `/metrics` listener); the
   * daemon shutdown chain calls it alongside {@link disposeActivityStream}.
   * `undefined` when both flags are off (the default — nothing is loaded) OR when
   * an enabled-but-unavailable extension WARNed and degraded (telemetry off, boot
   * NEVER crashes — the self-DoS guard, T-178-06).
   */
  otelHandle?: { shutdown(): Promise<void> };
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create the full observability subsystem: token tracker, shared cost
 * tracker with event-bus subscription, diagnostic collector, billing
 * estimator, channel activity tracker, and delivery tracer.
 * @param deps.eventBus - Typed event bus from bootstrap container
 * @param deps._createTokenTracker - Factory (overridable for tests)
 */
export async function setupObservability(deps: {
  eventBus: AppContainer["eventBus"];
  _createTokenTracker: typeof createTokenTracker;
  /**
   * Object-first logger for the cache-break INFO line and the diff-writer's
   * `warn`. Typed as the structural `ComisLogger` — the daemon already
   * passes `logLevelManager.getLogger("observability")`, whose object-first
   * `LogMethod`s are assignable to `createCacheBreakDiffWriter`'s
   * `{ warn: (obj, msg) => void }` requirement WITHOUT a cast. The prior
   * `{ info/warn: (...args: unknown[]) => void }` shape forced an unsafe `as`
   * assertion that the declared type did not guarantee. Mirrors the
   * `activityLogger` field's correct `ComisLogger` typing.
   */
  logger?: import("@comis/core").ComisLogger;
  /** Data directory for persistent observability files (e.g., cache-break diffs) */
  dataDir?: string;
  /**
   * Bound logger for the ActivityStream. Injected so the stream
   * never constructs its own logger; when absent the stream is silent. The
   * `ComisLogger` shape is structural — passing the daemon's
   * `logLevelManager.getLogger("activity-stream")` satisfies it.
   */
  activityLogger?: import("@comis/core").ComisLogger;
  /**
   * Operator home directory for the ActivityStream's `$HOME`→`~` path
   * compaction. Read once at this sanctioned composition root and injected; the
   * substrate performs no env reads of its own.
   */
  homeDir?: string;
  /**
   * Active operator theme for the ActivityStream (runtime reachability).
   * Resolved once at the daemon composition root from the DEFAULT agent's
   * `activity.theme` (`themeForName(name)`) and forwarded into
   * `createActivityStream`, so the four themes are reachable at runtime (the
   * subagent marker baked into `defaultLabel` follows the configured theme).
   * Optional — when absent the stream uses its DEFAULT_MARKERS (default-parity).
   */
  theme?: ActivityTheme;
  /**
   * The boot {@link ClockPort} (the SAME one threaded elsewhere, e.g.
   * daemon.ts:958/2544). Injected so the daemon-wide spend accumulator
   * is constructed here. Optional — when absent the spend accumulator is
   * NOT constructed (test call shapes stay byte-identical).
   */
  clock?: ClockPort;
  /**
   * The full app config. Read here for `observability.spend.*` (the spend
   * kill-switch ceilings) AND `observability.{otel,prometheus}` (the
   * exporter seam below). Optional — when absent (with `clock`) the accumulator
   * is not constructed and the OTel seam is skipped.
   */
  config?: AppConfig;
  /**
   * The daemon version (pkgJson.version) for the `comis_build_info{version}`
   * gauge. Optional — when absent the extension labels it "unknown".
   */
  version?: string;
}): Promise<ObservabilityResult> {
  const { eventBus, _createTokenTracker } = deps;

  // 4. Create token tracker
  const tokenTracker = _createTokenTracker(eventBus);

  // 4.5. Create observability modules (diagnostic events, billing, channel activity)
  // Shared CostTracker for cross-agent billing aggregation -- subscribes to
  // observability:token_usage events from ALL agents so the BillingEstimator
  // can provide accurate cross-agent billing summaries.
  const sharedCostTracker = createCostTracker();

  eventBus.on("observability:token_usage", (payload) => {
    sharedCostTracker.record(
      payload.agentId,
      payload.channelId,
      payload.executionId,
      {
        input: payload.tokens.prompt,
        output: payload.tokens.completion,
        totalTokens: payload.tokens.total,
        cost: payload.cost,
        provider: payload.provider,
        model: payload.model,
        // operationType flows through bridge's direct costTracker.record() call.
        // This secondary event-bus path defaults to "interactive" until the observability event
        // schema is extended to carry operationType (tracked as future enhancement).
        operationType: "interactive",
      },
    );
  });

  // The single daemon-wide spend accumulator — the dollars
  // kill-switch enforcement-state owner. CONSTRUCTED here beside the cross-agent
  // cost-tracker (the established daemon-wide subscriber seam); everything it
  // needs at construction is `clock` + `config.observability.spend` + `eventBus`.
  // REHYDRATION is deferred to the boot composition root (daemon.ts) via
  // `rehydrateSpendFromStore` because the persisted rolling-spend read lives on
  // `obsStore`, which is not reachable until obsStore is built ~60-90 lines after
  // this call (and only when persistence is enabled). When `clock`/`config` are
  // absent the accumulator is not constructed (test call shapes stay
  // byte-identical).
  let spendAccumulator: SpendAccumulator | undefined;
  // Defensive at the composition root: only construct when clock + the spend
  // config block are BOTH present. The real Zod-parsed config always defaults
  // `observability.spend`; the optional-chain guards a partial/hand-built config
  // (e.g. a boot stub) so a missing block degrades to "no accumulator" rather
  // than crashing boot.
  const spendCfg = deps.config?.observability?.spend;
  if (deps.clock && spendCfg) {
    spendAccumulator = createSpendAccumulator({
      clock: deps.clock,
      ceilings: {
        perAgentUsd: spendCfg.perAgentUsd,
        perTenantUsd: spendCfg.perTenantUsd,
        daemonGlobalUsd: spendCfg.daemonGlobalUsd,
        warnAtFraction: spendCfg.warnAtFraction,
      },
    });
    const acc = spendAccumulator;

    // Live increment from the SAME event the sharedCostTracker consumes (sees
    // in-flight spend, no per-check SQL re-sum). The token_usage payload carries
    // `sessionKey` but NO `tenantId`, so derive the tenant via the canonical
    // `parseFormattedSessionKey` (L1) — NOT `agentId`-as-tenant, NOT a bare
    // colon-split (which mishandles channelIds containing a colon) — so the
    // per-tenant counter stays isolated (the cross-tenant-DoS guard).
    eventBus.on("observability:token_usage", (payload) => {
      const tenantId = parseFormattedSessionKey(payload.sessionKey)?.tenantId ?? "default";
      const scope: SpendScope = { tenantId, agentId: payload.agentId };
      acc.recordSpend(scope, payload.cost.total);
    });
  }

  // The config-gated OTLP/Prometheus exporter seam.
  // The opt-in `@comis/observability-otel` extension is loaded ONLY when
  // `observability.otel.enabled || observability.prometheus.enabled` via a runtime
  // `await import()` (the daemon's documented optional-load pattern —
  // preflight-doctor.ts/better-sqlite3, config-export.ts/yaml). The static surface
  // is type-only (`import type { OtelExporterDeps }`), so core/daemon `build:clean`
  // succeed with the extension's `dist/` absent. The try/catch is mandatory:
  // an enabled-but-unavailable/throwing extension WARNs with a hint and DEGRADES
  // (telemetry off), NEVER crashing boot (the self-DoS guard).
  let otelHandle: { shutdown(): Promise<void> } | undefined;
  const otelCfg = deps.config?.observability?.otel;
  const promCfg = deps.config?.observability?.prometheus;
  if ((otelCfg?.enabled === true || promCfg?.enabled === true) && deps.config !== undefined) {
    const observability = deps.config.observability;
    // The `/metrics` pull surface has NO built-in auth (the OTel
    // PrometheusExporter serves the operational shape — metric names, labels,
    // series counts — unauthenticated; `prometheus.auth:'trusted-operator'` is
    // ADVISORY, realized by the loopback bind + the operator's reverse
    // proxy/firewall). A non-loopback bind is a VALID deliberate choice (e.g.
    // behind a reverse proxy), so we do NOT reject it — but it is a real exposure
    // an operator must opt into knowingly, so we WARN loudly and name both the
    // exposure and the configured host (the "name the knob" discipline).
    if (promCfg?.enabled === true) {
      const host = promCfg.host;
      const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
      if (!isLoopback) {
        deps.logger?.warn(
          {
            host,
            port: promCfg.port,
            errorKind: "config" as const,
            hint:
              `observability.prometheus.host is bound to a NON-loopback address ('${host}'); the /metrics ` +
              `endpoint serves operational shape (metric names, labels, series counts) UNAUTHENTICATED — the ` +
              `OTel PrometheusExporter has no built-in auth and 'auth: trusted-operator' is advisory. Put it ` +
              `behind a reverse proxy / firewall, or set observability.prometheus.host to '127.0.0.1' (the ` +
              `loopback default) to silence this.`,
          },
          "prometheus-non-loopback-bind",
        );
      }
    }
    try {
      // Runtime-resolved (the daemon does NOT statically depend on the extension
      // — N2). The specifier is held in a WIDENED `string` (not a string literal)
      // so `tsc` under moduleResolution:NodeNext does NOT statically resolve it:
      // core/daemon `build:clean` succeed with `packages/observability-otel/dist`
      // ABSENT (no `.d.ts` needed at compile, no tsconfig project-reference). The
      // result is typed against the LOCAL structural `OtelExtensionModule`. This
      // is the documented optional-load idiom (the extension may legitimately be
      // absent at build time — unlike the always-present better-sqlite3/yaml
      // dynamic-import precedents that tsc CAN resolve).
      const extensionSpecifier: string = "@comis/observability-otel";
      const mod = (await import(extensionSpecifier)) as unknown as OtelExtensionModule;
      otelHandle = mod.registerOtelExporter({
        eventBus,
        // Forward the boot clock ONLY when present (conditional spread) —
        // never `deps.clock as ClockPort` (which passes `undefined as ClockPort`
        // on a test call shape, an unsound contract lie). The extension
        // never calls wall-clock APIs, so omitting the key when absent is safe.
        ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
        observability,
        // The accumulator reference (the comis_spend_* gauge source). Omitted
        // when no accumulator was constructed (clock/config absent → the
        // exactOptionalPropertyTypes-safe conditional spread).
        ...(spendAccumulator !== undefined ? { spendAccumulator } : {}),
        // The daemon version label for comis_build_info.
        ...(deps.version !== undefined ? { version: deps.version } : {}),
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      });
    } catch (err) {
      deps.logger?.warn(
        {
          err,
          errorKind: "dependency" as const,
          hint: "observability.otel/prometheus is enabled but the @comis/observability-otel extension could not be loaded; telemetry export is disabled. Reinstall comisai (the extension is bundled) or set observability.otel.enabled/prometheus.enabled to false.",
        },
        "otel-extension-unavailable",
      );
    }
  }

  // Log cache break events for operational observability
  if (deps.logger) {
    eventBus.on("observability:cache_break", (payload) => {
      deps.logger!.info(
        {
          provider: payload.provider,
          reason: payload.reason,
          tokenDrop: payload.tokenDrop,
          tokenDropRelative: payload.tokenDropRelative,
          agentId: payload.agentId,
          sessionKey: payload.sessionKey,
          ttlCategory: payload.ttlCategory,
          toolsChanged: payload.toolsChanged.length,
          systemChanged: payload.changes.systemChanged,
          modelChanged: payload.changes.modelChanged,
        },
        "Cache break detected",
      );
    });
  }

  // Persist cache break diagnostics to ~/.comis/cache-breaks/
  if (deps.dataDir && deps.logger) {
    const diffWriter = createCacheBreakDiffWriter({
      outputDir: `${deps.dataDir}/cache-breaks`,
      // Confinement base for the fs-safe substrate — the resolved real
      // path of every diff artifact must stay inside the operator's data
      // root (closes the ancestor-symlink escape).
      dataDir: deps.dataDir,
      // ComisLogger's object-first `warn` (LogMethod) is structurally assignable
      // to the diff writer's `{ warn: (obj, msg) => void }` — no cast.
      logger: deps.logger,
    });
    eventBus.on("observability:cache_break", diffWriter);
  }

  // Construct the canonical ActivityStream substrate. It
  // subscribes to the EventBus immediately (tool:*/model:*/approval:*) and maps
  // each to a redacted ActivityEvent. The bound logger is injected (no
  // in-module getLogger); `getToolMetadata` (the @comis/core module registry)
  // honors per-tool `suppressActivity`; `homeDir` drives the $HOME→~
  // path compaction (read once here at the sanctioned composition root). The
  // returned port is the orchestrator-facing ActivityStreamPort.
  const activityStream = createActivityStream({
    eventBus,
    logger: deps.activityLogger,
    getToolMetadata,
    homeDir: deps.homeDir,
    // Forward the resolved operator theme so the subagent marker baked
    // into `defaultLabel` follows the configured theme (ascii strips emoji).
    ...(deps.theme !== undefined ? { theme: deps.theme } : {}),
  });

  const diagnosticCollector = createDiagnosticCollector({
    eventBus,
  });
  const billingEstimator = createBillingEstimator({
    costTracker: sharedCostTracker,
  });
  const channelActivityTracker = createChannelActivityTracker({
    eventBus,
  });
  const deliveryTracer = createDeliveryTracer({
    eventBus,
  });

  // Auto-prune observability data every 30 minutes, keeping last 24 hours.
  // Timer uses .unref() so it does not prevent process exit.
  const PRUNE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  const PRUNE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  const pruneTimer = systemSetInterval(() => {
    tokenTracker.prune(PRUNE_MAX_AGE_MS);
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  return {
    tokenTracker,
    sharedCostTracker,
    diagnosticCollector,
    billingEstimator,
    channelActivityTracker,
    deliveryTracer,
    activityStream,
    // Drain hook: dispose() detaches every EventBus handler and clears
    // the correlation index. The shutdown chain invokes this so pending per-turn
    // bounded queues drain and no placeholder is orphaned across restart.
    disposeActivityStream: () => activityStream.dispose(),
    // The daemon-wide spend accumulator. Threaded out so the boot
    // root rehydrates it (after obsStore exists) and the per-agent bridge guards
    // hold a reference to the SAME instance.
    spendAccumulator,
    // The OTLP/Prometheus exporter handle — undefined unless an
    // enabled extension loaded; the daemon threads otelHandle.shutdown() into the
    // shutdown chain alongside disposeActivityStream.
    otelHandle,
  };
}

// REHYDRATION lives in a SEPARATE module (setup-spend-rehydration.ts) because
// the persisted rolling-spend read is on obsStore, which the daemon builds AFTER
// this call. Re-exported here so existing import sites resolve from the barrel.
export { rehydrateSpendFromStore } from "./setup-spend-rehydration.js";
