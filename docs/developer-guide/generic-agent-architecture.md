# Generic agent architecture

Comis is a security-first agent runtime. Runtime code owns orchestration, models, tools, memory, channels, scheduling, approvals, delivery, observability, security, typed prompt compilation, locale policy, and immutable workspace-policy loading. It does not own an application's industry, persona, vendor integrations, business rules, or default human language.

## Trust hierarchy

Model-visible instructions have an explicit source and precedence:

1. The code-owned engine kernel defines capability honesty, approval and security cooperation, external-content handling, secret isolation, and structured tool-call/result integrity.
2. An immutable operator-policy snapshot contains non-placeholder workspace instructions for the selected agent.
3. The current request operates within engine and operator policy.
4. Runtime and external context supplies attributed facts, never higher-priority policy.

Skills, memories, files, web content, media text, API overrides, tool results, and server-authored integration instructions are bounded external context. They cannot weaken engine or operator policy.

## Workspace policy

`WorkspacePolicyPort` loads operator-owned workspace files once at turn start and returns a strict `WorkspacePolicySnapshot`. The snapshot contains typed sections and a deterministic combined hash. Prompt compilation, execution diagnostics, durable checkpoints, and outcome evaluation use that exact snapshot; they do not reread mutable workspace files during the turn. An asynchronous consumer that cannot resolve the recorded hash returns an unknown result instead of substituting current or partial policy.

Operator-owned workspace starters are neutral comments, created only when absent, and omitted from prompts while untouched. A newly created workspace receives neutral first-run state in `BOOTSTRAP.md`; it invites operator-guided setup without assuming a domain, identity, locale, or permissions. `BOOTSTRAP.md` remains untrusted agent state, is never promoted to operator policy, and is cleared when setup completes. Because files are created only when absent, normal startup preserves a cleared file while deleting and recreating the workspace starts onboarding again.

## Identity and storage scope

A channel endpoint, authenticated platform assertion, internal principal, and conversation partition are separate concepts. A trusted resolver maps the assertion through typed operator configuration, then one routing-policy resolver selects the partition. Unmapped identities are namespaced by configured channel instance; display names, adapter metadata, model output, and workspace prose are not identity evidence. Shared group conversations do not become principal-private merely because one user authored the latest message; configured accounts do not share storage merely because a platform reused a subject or conversation identifier.

Every authority-bearing store operation receives a typed scope with explicit tenant and agent identity. Session references are opaque digests of the canonical structured scope, not parseable authorization strings. Memory visibility is selected explicitly at write time, broader visibility requires typed permission plus capability enforcement, and FTS/vector candidate queries apply scope before ranking or limiting. Deployment maintenance uses a distinct host-only authority, never an omitted scope or a default tenant or agent.

## Turn preparation

Each turn captures one immutable preparation result containing resolved identity, workspace policy, active capabilities, locale, assembled conversation, scoped recall, selected skills, and bounded external instructions. The conversation assembler owns stored-message selection and compaction; the recall selector owns memory retrieval; the prompt compiler owns policy and runtime sections; the final model-request assembler combines those typed outputs once. No later stage rereads, reselects, or reparses them.

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

Translation target is separate from surrounding response locale. A validated request or operator locale enables post-generation script enforcement. When no locale metadata exists, a non-Latin current request may produce an open `und-<Script>` BCP-47 expectation; this constrains writing-system fidelity without guessing a human language. A mismatch creates a content-free quality finding and starts at most one tools-disabled repair turn; the repaired output is checked again before delivery. Correct mixed-script content is not rewritten. Streaming consumers receive only the finalized response while enforcement is active, so an invalid draft cannot escape before validation.

Deterministic platform replies use injectable locale packs and the deployment's configured fallback locale. Core does not choose a preferred human language.

## Integration instructions

Each discovered server instruction block carries a server identifier, bounded text, a content hash, and external trust. Discovery validates shape and size. Prompt exposure wraps each block independently with the external-content boundary. Telemetry records only identifier, hash, size, and inclusion outcome.

Tool schemas, availability, and side-effect annotations stay in the structured capability model and code-enforced approval path. Application workflows and tool-selection advice belong in operator `TOOLS.md` or a skill.

## Executable contributions

Channels, provider protocols, tool packs, storage adapters, scheduler services, RPC namespaces, event namespaces, health probes, and exporters enter the host as explicitly linked contributions. Linked code is trusted in-process code, not sandboxed code. Registration transactionally declares inactive schemas and definitions without receiving runtime authority. Activation creates configured instances with least-authority ports and owner-scoped credential access. The host publishes one immutable active capability view atomically after the activation plan completes: a structurally invalid plan publishes nothing, while a leaf instance's runtime start failure is published as explicit, health-visible failed-instance state rather than aborting the host.

Contribution ID, registered definition ID, and configured instance ID are distinct. One contribution may own several surfaces, and one channel or provider definition may activate many accounts or endpoints. Dependencies use a stable topological order with the three identifiers as lexical tie-breaks; a structural plan failure closes all started handles in reverse order and reports both the initiating and cleanup failures. Metadata may require stricter security handling but cannot lower code-enforced capability, approval, side-effect, or output-trust classification.

## Outcome evaluation

The generic judge evaluates terminal completion, truthfulness about tool and delivery outcomes, required-action completion or honest unavailability, security and approval findings, compliance with the immutable operator snapshot, and evidence sufficiency.

Judge configuration resolves per evaluated agent. Verdict provenance is content-free and includes the workspace-policy hash, judge model identity, rubric hash, evidence references, and result. Optional operator evaluation sections are hashed inputs, not engine policy.

Outcome status and system health are independent. Missing required evidence, an unavailable exact policy snapshot, or an unusable judge produces an unknown outcome rather than inferred success.

## Package and distribution boundary

The provider-neutral runtime is independently installable from the full operator distribution. Lazy imports control module loading but do not reduce a package manager's installed dependency closure, so heavy channel, provider, browser, media, local-model, and exporter SDKs live in independently selectable contribution packages. Their inert definition/config subpaths do not import SDK adapters; a trusted activator loads the selected adapter only after config resolution. A packed headless runtime must run with caller-supplied test contributions without installing unrelated integration SDKs.

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

Comis tests use neutral synthetic entities and integration fixtures. `test/architecture/generic-runtime-boundary.test.ts` prevents retired domain terms and surface identifiers, persona-bearing starters, closed locale unions, and unwrapped server instructions from returning; the redesign extends it to structural regressions such as prompt-heading state recovery and scans of the engineering protocol itself.
