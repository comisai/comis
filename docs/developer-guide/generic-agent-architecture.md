# Generic agent architecture

Comis is a security-first agent runtime. Runtime code owns orchestration, models, tools, memory, channels, scheduling, approvals, delivery, observability, and immutable workspace-policy loading. It does not own an application's industry, persona, vendor integrations, business rules, or default human language.

## Trust hierarchy

Model-visible instructions have an explicit source and precedence:

1. The code-owned engine kernel defines capability honesty, approval and security cooperation, external-content handling, secret isolation, and provider tool protocol.
2. An immutable operator-policy snapshot contains non-placeholder workspace instructions for the selected agent.
3. The current request operates within engine and operator policy.
4. Runtime and external context supplies attributed facts, never higher-priority policy.

Skills, memories, files, web content, media text, API overrides, tool results, and server-authored integration instructions are bounded external context. They cannot weaken engine or operator policy.

## Workspace policy

`WorkspacePolicyPort` loads operator-owned workspace files once at turn start and returns a strict `WorkspacePolicySnapshot`. The snapshot contains typed sections and a deterministic combined hash. Prompt compilation, execution diagnostics, durable checkpoints, and outcome evaluation use that exact snapshot or hash; they do not reread mutable workspace files during the turn.

Workspace starters are neutral comments, created only when absent, and omitted from prompts while untouched. `BOOTSTRAP.md` is agent state, remains untrusted, and is never promoted to operator policy.

## Prompt compilation

The prompt compiler consumes typed instruction and runtime sections. It produces:

- a stable engine prefix;
- a stable operator-policy prefix;
- a bounded runtime preamble;
- a content-free compile report with section identities, sources, trust, stability, budgets, hashes, sizes, and inclusion outcomes.

The engine kernel remains below 1,000 estimated tokens and minimal mode below 500 before provider-native tool schemas. Security invariants are never silently truncated. Empty starter content costs zero prompt tokens. The registered tool set and provider schemas remain authoritative; prompt prose does not advertise unavailable capabilities.

Execution state such as sender trust, locale policy, selected skills, and compaction state is passed structurally. Consumers do not parse Markdown headings to recover state.

## Locale policy

`ResponseLocalePolicy` is an open, strict domain type. Explicit locale tags are canonicalized with `Intl.getCanonicalLocales`; locale is not a closed language union. Unicode script analysis may support search, token estimation, bidirectional safety, and diagnostics, but it does not coerce response language.

Translation target is separate from surrounding response locale. Post-generation script mismatch creates a content-free quality finding only when locale enforcement is enabled; it does not trigger a second model call or rewrite correct mixed-script content.

Deterministic platform replies use injectable locale packs and an English fallback.

## Integration instructions

Each discovered server instruction block carries a server identifier, bounded text, a content hash, and external trust. Discovery validates shape and size. Prompt exposure wraps each block independently with the external-content boundary. Telemetry records only identifier, hash, size, and inclusion outcome.

Tool schemas, availability, and side-effect annotations stay in the structured capability model and code-enforced approval path. Application workflows and tool-selection advice belong in operator `TOOLS.md` or a skill.

## Outcome evaluation

The generic judge evaluates terminal completion, truthfulness about tool and delivery outcomes, required-action completion or honest unavailability, security and approval findings, compliance with the immutable operator snapshot, and evidence sufficiency.

Judge configuration resolves per evaluated agent. Verdict provenance is content-free and includes the workspace-policy hash, judge model identity, rubric hash, evidence references, and result. Optional operator evaluation sections are hashed inputs, not engine policy.

## System health surfaces

Deployment-wide diagnostics use platform vocabulary consistently:

- CLI: `comis system-health`
- JSON-RPC: `obs.system.health`
- MCP: `obs_system_health`
- observability action: `system_health`
- domain contract: `SystemHealthReport`
- support bundle: `system-health.json`

No compatibility aliases exist for retired surface names. Producers, consumers, generated contracts, storage, scripts, dashboards, tests, and documentation use the same current contract.

## Specialization boundary

Reusable task expertise belongs in skills. Application workspace files own persona, scope, business policy, response preferences, and optional evaluation guidance. Capability servers own their API clients, credentials, schemas, response shaping, and side-effect classification. Vertical acceptance campaigns live with their application or skill.

Comis tests use neutral synthetic entities and integration fixtures. `test/architecture/generic-runtime-boundary.test.ts` prevents domain terms, retired identifiers, persona-bearing starters, closed locale unions, unwrapped server instructions, and prompt-heading state recovery from returning.
