// SPDX-License-Identifier: Apache-2.0
// @comis/cli — CLI management tool for Comis daemon
//
// Phase 29 (PUB-EXPORTS-01 + PUB-EXPORTS-02): public surface narrowed to
// the embedding-code helpers. All register*Command factories and output
// utilities (success/error/warn/info/json/renderTable/renderKeyValue/
// withSpinner) remain importable from their source modules
// (./commands/*.js, ./output/*.js) for the bin entry point cli.ts and
// are NOT part of the documented @comis/cli external API. The dual-CLI
// divergence (registerAuthCommand + registerProvidersCommand absent
// from prior index.ts) is resolved by formalizing the bin-only pattern:
// cli.ts imports every register*Command from ./commands/X.js directly.

// RPC client (embedding-code helper for daemon connections)
export { withClient } from "./client/rpc-client.js";
export type { RpcClient } from "./client/rpc-client.js";

// Wizard step — exported for integration tests in
// test/integration/oauth-login.test.ts which dynamically imports
// credentialsStep to drive the wizard-state assertion end-to-end.
export { credentialsStep } from "./wizard/steps/04-credentials.js";
