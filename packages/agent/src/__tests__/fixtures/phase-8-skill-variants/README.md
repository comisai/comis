# Skill Variant Fixtures

Three SKILL.md variants exercising the three capability-metadata source paths used by integration tests: operator-config hint, manifest `comis.capability` block, and SDK-fallback (no metadata). Plus a co-located operator YAML and a smoke test asserting fixture invariants.

## Canonical test invocation

> WARNING: Always run `pnpm build` first. Vitest workspace aliases `@comis/*` to `packages/*/dist/index.js` (see `test/vitest.config.ts`). Stale `dist/` will silently mask `src/` changes and produce false greens.

```bash
pnpm build && pnpm test:integration -- tooling-fixture-render
```

For unit-test loops on this package only:

```bash
pnpm --filter @comis/agent build && pnpm --filter @comis/agent test
```

> WARNING: repeating because CLAUDE.md repeats it twice and we paid for skipping it before: integration tests run against `dist/`, not `src/`. If a test passes after editing only `src/`, you forgot `pnpm build`.

## Files

| File | Purpose |
|------|---------|
| `operator-config-skill.md` | Variant A — SKILL.md with NO `comis.capability` block. Cluster comes from operator YAML hint. |
| `comis-capability-skill.md` | Variant B — SKILL.md with `comis.capability` block. Cluster comes from manifest metadata. |
| `sdk-fallback-skill.md` | Variant C — SKILL.md with NO `comis:` namespace. Cluster falls back to reserved `prompt-skills`. |
| `tooling-config.yaml` | Operator YAML declaring `tooling.skills.capabilityHints` for variant A only (preserves the `finance-data` MCP hint for install-detour reuse). |
| `fixture.test.ts` | Smoke test asserting fixture invariants (frontmatter shapes, YAML hint resolution, forbidden-token absence). |

## Capability-metadata source paths

The three variants exercise the documented resolution order:

1. **Operator hint** (highest precedence) — `tooling.skills.capabilityHints[<skill-name>].cluster` in `tooling-config.yaml`. Variant A relies on this.
2. **Manifest `comis.capability`** — frontmatter block in the SKILL.md itself. Variant B relies on this.
3. **Fallback `prompt-skills`** — reserved cluster used when neither source supplies a cluster. Variant C relies on this.

The operator YAML in this fixture declares a hint **only** for `operator-config-skill`. That asymmetry is the disambiguator: if downstream tests find variant B grouped under `data-fetching-financial`, the manifest path was honored; if variant C surfaces under `prompt-skills`, the fallback path was honored.

## Downstream consumers

| Consumer | Files used | What it asserts |
|----------|-----------|-----------------|
| Fixture smoke test | All five | Fixture invariants — three SKILL.md frontmatter shapes parse, YAML hint resolves, forbidden tokens absent. |
| Test config splice | `tooling-config.yaml` | Operator YAML composes into the daemon test-config shape. |
| Deterministic integration tests | All four content files | `tooling-fixture-render`, `install-detour-advise-e2e`, `install-detour-soft-stop-e2e`. |
| Metric aggregator | (referenced) | References the cluster IDs declared here. |
| Provider-gated `behavioral-metrics-e2e` suite | All four content files | Uses the three variants as the tracked surface. |

## Provider-gated suite cost note

`COMIS_E2E_TEST_PROVIDERS=anthropic,openai,google` (comma-separated) triggers the `behavioral-metrics-e2e` suite to run against real providers. Default `ROUNDS_PER_PROVIDER=10` × ~3 tool calls per round = ~30 calls per provider per run; cost grows linearly with the comma-separated list. CI does **not** set the variable — the suite is skipped via `describe.skipIf(!process.env.COMIS_E2E_TEST_PROVIDERS)`. Run locally only when measuring behavioral-metric deltas.

## Forbidden-token guard

The smoke test (`fixture.test.ts`) scans every file in this directory against a regex of excised identifiers and asserts zero matches. Authors editing this fixture: do not name those identifiers (see the regex in `fixture.test.ts`); the guard MUST stay green so the fixture surface can never leak the excised tool identifiers back into fixture content.
