# Tool-First Replay Fixture

Reproduces the tool-first failure mode (model installs `pip install market-data-lib` despite a connected `finance-data` MCP server) so downstream regression tests can run against a deterministic, provider-neutral surface.

## Canonical test invocation

> WARNING: Always run `pnpm build` first. Vitest workspace aliases `@comis/*` to `packages/*/dist/index.js` (see `test/vitest.config.ts`). Stale `dist/` will silently mask `src/` changes and produce false greens.

```bash
pnpm build && pnpm test:integration -- tooling-config
```

For unit-test loops on this package only:

```bash
pnpm --filter @comis/agent build && pnpm --filter @comis/agent test
```

> WARNING: worth repeating: integration tests run against `dist/`, not `src/`. If a test passes after editing only `src/`, you forgot `pnpm build`.

## Files

| File | Purpose |
|------|---------|
| `messages.json` | pi-ai `Message[]` log of the recorded failure scenario. |
| `tooling-config.yaml` | Operator YAML (`finance-data` MCP hint with `replacesPackages`). |
| `stub-mcp-server.ts` | Programmatic 10-tool stub with `setConnected(bool)` toggle. |
| `fixture.test.ts` | Smoke test asserting fixture loads cleanly + invariants. |

## Downstream consumers

| Files used | What it asserts |
|-----------|-----------------|
| `tooling-config.yaml` | `ToolingConfigSchema` parses a real operator YAML without re-shaping. |
| `tooling-config.yaml`, `stub-mcp-server.ts` | Renderer groups `finance-data` tools under `data-fetching-financial` cluster. |
| `messages.json`, `tooling-config.yaml`, `stub-mcp-server.ts` | Install-detour parser detects `pip install market-data-lib` overlap with `finance-data`. |
| `stub-mcp-server.ts` | `getConnectedMcpServers()` filters by `setConnected(false)`. |
| All four | Full provider-gated replay round; tracks behavioral metrics. |
| All four (grep) | Architecture-grep test scans fixtures for forbidden tokens. |

## Why provider-neutral?

The pi-ai `Message` shape is the canonical provider-neutral wire format already used by `packages/agent/src/executor/overflow-recovery.ts:16`. Encoding the failure mode in this shape lets downstream replay tests run without binding to any single provider's transport (Anthropic, OpenAI, Google, etc.) — the `api`/`provider`/`model` fields on the assistant message are illustrative, not branching surfaces.
