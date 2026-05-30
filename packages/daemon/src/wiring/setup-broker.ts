// SPDX-License-Identifier: Apache-2.0
import "reflect-metadata"; // MUST be first import — createNodeCaManager uses @peculiar/x509 which needs tsyringe which needs Reflect.metadata
/**
 * Credential broker wiring for daemon startup.
 * Constructs NodeCaManager + SessionManager + MitmBroker and starts the
 * broker (TCP + unix socket at `socketPath`). Mirrors setup-background-tasks.ts.
 *
 * Conditional construction: callers should only invoke this when
 * `config.executor?.broker` is configured. A daemon with no broker config
 * does NOT call this function — no socket or port is opened.
 * @module
 */
import type { TypedEventBus, ClockPort, TimerPort, SecretManager, BrokerBinding } from "@comis/core";
import { safePath } from "@comis/core";
import type { ComisLogger, SessionManager, MitmBrokerPort } from "@comis/infra";
import { createNodeCaManager, createSessionManager, createMitmBroker } from "@comis/infra";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Dependencies for the credential broker setup. */
export interface SetupBrokerDeps {
  /** Daemon data directory — CA cert/key persisted here. */
  dataDir: string;
  /** Typed event bus for broker:* event emission. */
  eventBus: TypedEventBus;
  /** Bound module logger. */
  logger: ComisLogger;
  /** Wall-clock adapter (no Date.now()). */
  clock: ClockPort;
  /** Timer scheduling adapter. */
  timers: TimerPort;
  /** Secret manager — resolves per-binding secret refs per request. */
  secretManager: SecretManager;
  /** Broker bindings (empty array = no injection rules; broker rejects all CONNECT). */
  bindings: readonly BrokerBinding[];
  /** TCP listen port. 0 = ephemeral (kernel-assigned). Default: 0. */
  port?: number;
  /** Unix socket path for sandbox-to-broker communication.
   *  Defaults to safePath(dataDir, "broker.sock"). */
  socketPath?: string;
}

/**
 * Handle returned by setupBroker. Holds the live broker and its dependencies.
 * `stop()` tears down TCP + unix socket and unlinks the socket file.
 */
export interface BrokerHandle {
  /** The underlying SessionManager instance (for token issuance at spawn time). */
  sessionManager: SessionManager;
  /** The live MitmBrokerPort instance (TCP + optional unix socket). */
  broker: MitmBrokerPort;
  /** Resolved TCP port after broker.start(). Always > 0. */
  tcpPort: number;
  /** PEM path of the broker CA cert (for NODE_EXTRA_CA_CERTS in spawn envs). */
  caPath: string;
  /** Resolved unix socket path (broker.startUnixSocket was called on it). */
  socketPath: string;
  /** Tear down TCP + unix socket and unlink the socket file. Idempotent. */
  stop: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wire the credential broker subsystem from daemon-level dependencies.
 * Constructs NodeCaManager + SessionManager + MitmBroker, starts the broker
 * on TCP (ephemeral port if `port === 0`) and a Unix socket (`socketPath`).
 *
 * The `caPath` in the returned handle is the PEM file path of the broker CA
 * certificate on disk (`safePath(dataDir, "broker-ca.pem")`). The CA is
 * initialised lazily on first TLS CONNECT by `createNodeCaManager`; the path
 * exists after the first TLS handshake but callers should treat it as an
 * opaque path string and pass it in `NODE_EXTRA_CA_CERTS`.
 *
 * @param deps - Daemon-level dependencies
 * @returns BrokerHandle with live broker, port, socket path, and stop()
 */
export async function setupBroker(deps: SetupBrokerDeps): Promise<BrokerHandle> {
  const {
    dataDir,
    eventBus,
    logger,
    clock,
    timers,
    secretManager,
    bindings,
    port = 0,
  } = deps;

  // Resolve the unix socket path (caller override or default in dataDir)
  const socketPath = deps.socketPath ?? safePath(dataDir, "broker.sock");

  // Construct CA manager — persists broker-ca.key (0o600) + broker-ca.pem to dataDir
  const caManager = createNodeCaManager({ clock, dataDir });

  // Construct session manager — single-use token lifecycle, TTL reaper
  const sessionManager = createSessionManager({ clock });

  // Construct the MITM broker with all deps
  const broker = createMitmBroker({
    sessionManager,
    secretManager,
    bindings,
    eventBus,
    logger,
    clock,
    timers,
    caManager,
  });

  // Start TCP listener (resolves to bound port number)
  const tcpPort = await broker.start(port);

  // Start Unix socket listener (chmodSync(0o600) is called inside startUnixSocket)
  await broker.startUnixSocket(socketPath);

  // The CA cert PEM is at a fixed path relative to dataDir.
  // createNodeCaManager initialises it lazily on first TLS CONNECT; the path
  // is deterministic and safe to wire into spawn envs immediately.
  const caPath = safePath(dataDir, "broker-ca.pem");

  return {
    sessionManager,
    broker,
    tcpPort,
    caPath,
    socketPath,
    stop: () => broker.stop(),
  };
}
