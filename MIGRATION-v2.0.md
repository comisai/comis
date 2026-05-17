# Comis v2.0 — Breaking Changes Migration

This document lists every export removed from a `@comis/*` package's
public surface between v1.x and v2.0. Apply the replacement listed below
at each call site.

## Public Export Cleanup

Each package's `src/index.ts` is shrunk to "exports with at least one
in-repo consumer or an explicit supported-external-API policy entry."

### `@comis/agent`

The two backward-compat aliases that mirrored the canonical
session-lifecycle names are dropped. Every workspace consumer (3 files
in `packages/channels/src/shared/`) was retargeted to the canonical
names in the same atomic commit.

| Removed Export | Kind | Canonical Replacement | Notes |
|----------------|------|-----------------------|-------|
| `createSessionManager` | value | `createSessionLifecycle` | Renamed from `session-manager.ts` to `session-lifecycle.ts`; the alias is now removed. |
| `SessionManager` | type | `SessionLifecycle` | Same rename. Note: distinct `ComisSessionManager` / `createComisSessionManager` / `createEphemeralComisSessionManager` symbols remain unchanged. |

### `@comis/skills`

The skills re-export of a `@comis/shared` symbol was dead since
inception — every in-repo consumer (4 files in `packages/agent/src/`)
already imports from the canonical source.

| Removed Export | Kind | Canonical Replacement | Notes |
|----------------|------|-----------------------|-------|
| `extractMcpServerName` | value | Import directly from `@comis/shared` | The skills package re-exported this from `@comis/shared`; the re-export had zero in-repo consumers. The canonical `parseSanitizedMcpToolName` companion continues to live in `@comis/shared` as well. |

### `@comis/cli`

The `@comis/cli` public surface narrows to **exactly three documented
external-API entries**: `withClient` (RPC connection helper),
`credentialsStep` (wizard step exposed for integration tests and
embed-and-extend), and `RpcClient` (type — required by `withClient`'s
signature).

All `register*Command` factories and output utilities
(`success`/`error`/`warn`/`info`/`json`/`renderTable`/`renderKeyValue`/
`withSpinner`) remain accessible **to the `comis` bin only** via direct
source-module imports (`./commands/*.js`, `./output/*.js`). They are
**not** part of the documented `@comis/cli` external API and **must
not** be relied on for composing alternate CLIs from individual command
registrations — those use cases were never supported and break in v2.0.

| Removed Export | Kind | Canonical Replacement | Notes |
|----------------|------|-----------------------|-------|
| `createRpcClient` | value | Use `withClient(opts, fn)` for the embedding helper | `withClient` is the documented external-API entrypoint; `createRpcClient` was a lower-level factory with no documented external consumers. |
| `success`, `error`, `warn`, `info`, `json` | values | (bin-only) | Output-formatting utilities for the `comis` bin's stdout/stderr. Not intended for embedding code. |
| `renderTable`, `renderKeyValue` | values | (bin-only) | Same. |
| `withSpinner` | value | (bin-only) | Same. |
| `registerDaemonCommand`, `registerConfigCommand`, `registerAgentCommand`, `registerChannelCommand`, `registerMemoryCommand`, `registerSecurityCommand`, `registerDoctorCommand`, `registerInitCommand`, `registerConfigureCommand`, `registerStatusCommand`, `registerHealthCommand`, `registerModelsCommand`, `registerPm2Command`, `registerSessionsCommand`, `registerResetCommand`, `registerSignalSetupCommand`, `registerSecretsCommand`, `registerUninstallCommand` | values | (bin-only; access via `./commands/X.js` source paths if vendoring the CLI) | 18 Commander.js subcommand-registration factories. The `comis` bin (`packages/cli/src/cli.ts`) imports each directly from its source module; the umbrella re-exports were dead. |

Two additional `register*Command` factories — `registerAuthCommand`
and `registerProvidersCommand` — were never exported from
`@comis/cli/src/index.ts` in v1.x. They are bin-only in v2.0 by the
same pattern as the 18 factories above.

## Namespace surface (`comisai` umbrella)

The `comisai` umbrella package (`packages/comis/src/index.ts`) re-exports
each `@comis/*` package as a namespace
(`import * as cli from "@comis/cli"; export { cli };`). The namespace's
surface auto-reflects the underlying package's exports. After the
cleanup:

- `comisai.skills.extractMcpServerName` no longer resolves — use `comisai.shared.extractMcpServerName` (or import from `@comis/shared` directly).
- `comisai.agent.createSessionManager` and the `comisai.agent.SessionManager` type no longer resolve — use `comisai.agent.createSessionLifecycle` and `comisai.agent.SessionLifecycle`.
- `comisai.cli.createRpcClient` and all `comisai.cli.register*Command` and `comisai.cli.success`/`error`/`warn`/`info`/`json`/`renderTable`/`renderKeyValue`/`withSpinner` no longer resolve — these were bin-only. Use `comisai.cli.withClient` for daemon-RPC embedding and `comisai.cli.credentialsStep` for wizard embedding.

## Verification

Export closures are enforced programmatically:

- `test/architecture/public-export-consumers.test.ts` AST-walks every
  package's `src/index.ts` and fails on any orphan export (no consumer +
  no `test/support/public-api-policy.ts` entry).
- `test/architecture/allowlist-shrink.test.ts` enforces that
  `test/support/architecture-allowlist.ts` only shrinks across
  base..head commits — closures are accepted decreases.

Both tests run in `pnpm test`. The full v2.0 validation gate is
`pnpm build && pnpm test && pnpm lint:security`.
