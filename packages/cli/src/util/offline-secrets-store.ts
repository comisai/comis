// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI entry point — errors propagate to Commander error handler.
/**
 * Thin adapter: re-exports offline secret store helpers from @comis/memory
 * for use by CLI commands when the daemon is not running.
 *
 * Architecture boundary: this is the only permitted @comis/cli →
 * @comis/memory import site. All other CLI memory access routes through daemon
 * RPC.
 *
 * @module
 */

import {
  offlineSecretSet as _offlineSecretSet,
  offlineSecretsList as _offlineSecretsList,
  offlineSecretGet as _offlineSecretGet,
  offlineSecretGetForMode as _offlineSecretGetForMode,
  offlineOAuthProfileSet as _offlineOAuthProfileSet,
  openSqliteDatabase as _openSqliteDatabase,
  createObservabilityStore as _createObservabilityStore,
} from "@comis/memory";
import type { ObservabilityStore } from "@comis/memory";
import type { SecretMetadata } from "@comis/core";
import type { Result } from "@comis/shared";

export type { SecretMetadata };
export type { Result };
export type { ObservabilityStore };

export const offlineSecretSet = _offlineSecretSet;
export const offlineSecretsList = _offlineSecretsList;
// Daemon-free decrypted read — breaks the gateway-token chicken-and-egg
// (`secrets get COMIS_GATEWAY_TOKEN` would need the RPC that needs the token).
export const offlineSecretGet = _offlineSecretGet;
// Config diagnostics must select the same file/encrypted/env backend as daemon
// startup before resolving `${VAR}` references.
export const offlineSecretGetForMode = _offlineSecretGetForMode;
// OAuth profiles collected during `comis init` (encrypted mode, daemon down)
// are sealed into secrets.db through this same boundary.
export const offlineOAuthProfileSet = _offlineOAuthProfileSet;
// The offline obs fallback opens the local
// memory.db (WAL — concurrent with a live daemon) to feed the daemon's pure
// report assemblers when the gateway is unreachable. This file remains the
// only @comis/cli → @comis/memory import site.
export const openSqliteDatabase = _openSqliteDatabase;
export const createObservabilityStore = _createObservabilityStore;
