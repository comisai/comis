// SPDX-License-Identifier: Apache-2.0
// @comis/infra - Infrastructure adapters
//
// The Pino-free structural ComisLogger contract + LogFields / ErrorKind /
// VALID_LOG_LEVELS / isValidLogLevel canonically live in @comis/core. They
// are re-exported here so daemon / skills / cli (which import
// `from "@comis/infra"` for the runtime Pino path) see no public-surface drift.

// Logging (Pino logger factory with credential redaction, audit level)
export { createLogger } from "./logging/index.js";
export type { LoggerOptions, ComisLogger } from "./logging/index.js";
export type { LogFields, ErrorKind } from "@comis/core";
export { isValidLogLevel, VALID_LOG_LEVELS } from "@comis/core";

// Runtime adapters for time/env/timer ports.
export { createSystemClock } from "./runtime/clock.js";
export { createSystemEnv } from "./runtime/env.js";
export { createSystemTimers } from "./runtime/timers.js";

// Credential broker (MITM proxy runtime + CA manager + capability lease)
export {
  createSessionManager,
  createLeaseManager,
  createMitmBroker,
  createNodeCaManager,
} from "./credential-broker/index.js";
export type {
  SessionManager,
  SessionManagerDeps,
  IssuedSession,
  SessionInfo,
  LeaseManager,
  LeaseManagerDeps,
  MintLeaseInput,
  IssuedLease,
  LeaseInfo,
  MitmBrokerPort,
  MitmBrokerDeps,
  NodeCaManagerDeps,
} from "./credential-broker/index.js";

// The fs-safe primitives (appendRegularFile + writeRegularFile +
// SymlinkParentRejected / PathEscapesConfinementError /
// FileSizeLimitExceeded sentinels + option/result types) live in
// @comis/observability/shared/fs-safe.ts. The package-deps arrow is
// one-direction: @comis/infra → @comis/observability (via the static
// re-export in logging/redact-transport.ts). The architecture invariant
// is locked by test/architecture/observability-package-isolation.test.ts.
