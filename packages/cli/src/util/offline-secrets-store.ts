// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI entry point — errors propagate to Commander error handler.
/**
 * Thin adapter: re-exports offline secret store helpers from @comis/memory
 * for use by CLI commands when the daemon is not running.
 *
 * L11 allowlist: this is the ONLY permitted @comis/cli → @comis/memory
 * import site. All other CLI memory access routes through daemon RPC.
 *
 * @module
 */

import {
  offlineSecretSet as _offlineSecretSet,
  offlineSecretsList as _offlineSecretsList,
} from "@comis/memory";
import type { SecretMetadata } from "@comis/core";
import type { Result } from "@comis/shared";

export type { SecretMetadata };
export type { Result };

export const offlineSecretSet = _offlineSecretSet;
export const offlineSecretsList = _offlineSecretsList;
