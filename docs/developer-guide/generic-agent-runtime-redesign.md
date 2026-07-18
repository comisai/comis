<!-- generated-by: gsd-doc-writer -->
# Generic agent runtime redesign implementation specification

Status: implementation draft.

This document turns the [generic agent architecture](./generic-agent-architecture.md) into an executable redesign. The architecture guide remains the concise normative boundary that every production change must read. This specification defines the target contracts, package responsibilities, delivery order, tests, and removal criteria needed to make that boundary true in the runtime itself.

Nothing described as proposed in this document exists merely because it is named here. Each contract must be introduced test-first, with a concrete caller, and must replace an existing responsibility rather than becoming a parallel abstraction.

## Intended outcome

Comis becomes a generic, security-first agent runtime with a small stable kernel and a uniform contribution system. The kernel owns universal execution and trust mechanisms. Installed contributions provide executable capabilities. Skills provide opt-in expertise and procedures. Workspace policy provides deployment-specific identity and business policy.

The completed runtime has these properties:

- conversation and memory authority is explicit, complete, and enforced before storage lookup or ranking;
- channels, model providers, tools, RPC methods, configuration namespaces, lifecycle hooks, health probes, and event schemas enter the host through typed contribution contracts;
- the daemon composes registered contributions without branching on concrete channel or provider names;
- provider catalogs, vendor defaults, and integration-specific behavior live with their adapters, not in the kernel;
- prompt compilation consumes typed inputs and an immutable workspace-policy snapshot without parsing generated prose to recover runtime state;
- one context assembly path owns context selection and compaction behavior;
- optional learning, media, scheduling, and workflow strategies do not enlarge the always-on kernel;
- the web client can call only generated RPC method names with matching request and response types;
- the minimal headless distribution does not install every channel SDK, media SDK, browser engine, observability exporter, and user interface dependency;
- application-specific expertise ships as an opt-in skill when it does not require new executable authority.

## Scope

This redesign covers:

- runtime identity and storage isolation;
- memory visibility and scoped retrieval;
- contribution discovery, registration, activation, health, and shutdown;
- channel, provider, tool, RPC, config, event, and observability extension points;
- prompt and context assembly boundaries;
- package dependency direction and distribution shape;
- the classification of specialization as kernel mechanism, contribution, skill, or workspace policy;
- test, security, observability, and documentation gates for the new architecture.

The redesign does not add a new business workflow, persona, preferred language, provider recommendation, or industry policy. It does not make arbitrary external code executable from configuration. External contribution loading requires a separate threat model and a concrete caller; the first implementation supports explicitly linked, in-repository contributions only.

## Architectural decisions

The following decisions are normative for implementation:

1. `tenantId` and `agentId` are required authority fields for every conversation, session, context, memory, approval, delivery, and durable execution lookup.
2. Human-readable session-key strings are not an authority boundary. Storage uses structured scope columns and an opaque reference derived from the complete scope.
3. Memory visibility is explicit at write time. Agent-shared memory is never inferred from a missing participant field.
4. Search scope is applied during FTS and vector candidate generation, before ranking and limiting.
5. The contribution registry replaces static platform registries and concrete daemon construction branches. It does not extend the hook-only `PluginRegistryApi` with unrelated optional methods.
6. The first contribution loader is an explicit in-process list assembled by the composition root. Filesystem package discovery and arbitrary module execution remain out of scope.
7. Contribution registration is synchronous and side-effect free. External connections and background work begin only during activation.
8. Every contribution declares the surfaces it provides. The registry rejects undeclared registrations, duplicate names, invalid namespaces, dependency cycles, and activation-order ambiguity.
9. Core owns capability semantics and approval enforcement. Contributions may request capabilities and describe side effects; they cannot grant authority or weaken policy.
10. Core owns provider-neutral model execution contracts, not provider names, model catalogs, prices, authentication flows, aliases, or SDK-specific prompt behavior.
11. The context store and one canonical context assembler are mandatory runtime services. Missing durable storage may be satisfied by an explicit in-memory adapter, never by silently switching to another assembly algorithm.
12. Configuration defaults resolve once at schema composition. Consumers receive resolved config and do not invent local fallbacks.
13. Built-in and contribution RPC definitions are the source of truth for daemon dispatch and generated web types.
14. Skills remain non-authoritative prompt context. A shipped skill is opt-in unless an operator explicitly selects it through policy or configuration.
15. No dual readers, compatibility aliases, default-to-old behavior, or permanent transition flags are added. Callers and persisted contracts move to one current representation in the same concern-sized change.

## Current-state evidence

The redesign starts from useful foundations: hexagonal ports and adapters, `Result<T, E>`, capability gates, secret isolation, request context, typed events, immutable workspace-policy snapshots, optional OpenTelemetry wiring, generated web contracts, and a functioning skill registry. The work below preserves those strengths while removing places where composition is still closed around Comis-specific implementations.

| Area | Repository evidence | Required direction |
|---|---|---|
| Session identity | `packages/core/src/domain/session-key.ts` makes `agentId` optional and explicitly excludes it from `formatSessionKey()`. `packages/memory/src/schema.ts` keys `sessions` by `session_key` alone. | Replace `SessionKey` authority with a complete `ConversationScope`; persist required scope columns and include the agent in every uniqueness constraint. |
| Memory search | `packages/memory/src/hybrid-search.ts` performs FTS/vector ranking before applying tenant and agent filters. `packages/core/src/ports/memory.ts` exposes optional agent scoping on part of the read surface. | Require a typed `MemoryReadScope` and push its predicates into every candidate query before ranking and limiting. |
| Web RPC | `packages/web/src/api/rpc-client.ts` accepts `call<T>(method: string)`. `packages/web/src/state/polling-controller.ts` calls `agent.list` and `channel.list`, while the registered methods are `agents.list` and `channels.list`; its tests reproduce the same literals. | Generate a method map and make invalid method names a compile-time error; add server/client contract parity tests. |
| Plugins and channels | `packages/core/src/ports/plugin.ts` deliberately exposes hook registration only. `packages/channels/src/shared/channel-registry.ts` supports lookup after registration, while daemon channel wiring still constructs concrete adapters. | Keep lifecycle hooks focused. Introduce a separate contribution registry that owns typed factories and lets the daemon iterate registrations. |
| Providers | Provider IDs, aliases, authentication behavior, model quirks, and SDK details appear across `packages/core`, `packages/agent`, and `packages/daemon`. | Keep only provider-neutral execution and capability contracts in the runtime; move all concrete knowledge beside provider adapters. |
| Prompt assembly | `packages/agent/src/executor/prompt-assembly.ts` combines kernel policy, workspace policy, runtime state, recall, tools, integrations, and diagnostics in one large module. | Compile typed sections through small independent producers and a deterministic compiler. No consumer reparses prompt headings. |
| Context assembly | `packages/agent/src/context-engine/` and daemon wiring retain DAG and pipeline modes with silent fallback when dependencies are absent. | Select one canonical assembler and satisfy its ports explicitly. Startup or turn execution fails honestly when a required dependency is missing. |
| Config | `packages/core/src/config/schema.ts` owns a broad product-shaped schema, while consumers still apply local `??` defaults. | Compose kernel and contribution namespaces once, return resolved config, and prohibit semantic defaults at call sites. |
| Control plane | `packages/core/src/api-contracts/` and `packages/daemon/src/api/` form a large closed method surface. | Keep a small host control plane and register contribution-owned RPC namespaces with schemas and capability requirements. |
| Distribution | `packages/comis/package.json` aggregates the full package graph and a broad external dependency set. | Publish a lean headless runtime separately from the full daemon distribution and load heavy optional adapters only when configured. |
| Boundary enforcement | `test/architecture/generic-runtime-boundary.test.ts` protects selected terminology and prompt invariants, but it does not prove dependency direction, contribution ownership, or scoped persistence behavior. | Add structural and behavioral gates that encode the target architecture, while keeping allowlists shrink-only. |

## Target architecture

```text
Operator configuration and workspace policy
                    |
                    v
          +--------------------+
          |    Runtime host    |
          | composition only   |
          +---------+----------+
                    |
          registers | activates
                    v
 +------------------+------------------+
 |          Contribution registry      |
 | channels | providers | tools | RPC  |
 | config   | events    | health| hooks|
 +------------------+------------------+
                    |
                    v
 +------------------+------------------+
 |        Generic runtime kernel       |
 | scope and identity                  |
 | execution lifecycle and context     |
 | security, capabilities, approvals   |
 | prompt compilation and base events  |
 | storage and delivery ports          |
 +------------------+------------------+
                    |
                    v
 +------------------+------------------+
 |            Port adapters            |
 | SQLite | clocks | timers | network  |
 | secret store | file lock | telemetry|
 +-------------------------------------+

Skills --------------------> bounded, opt-in prompt expertise
Workspace policy ----------> operator authority snapshot
External content ----------> attributed, wrapped runtime context
```

The runtime host is the only layer that knows the complete installed set. The kernel knows contribution contracts and registered capabilities, never the names of concrete channels, providers, SDKs, or task domains.

## Ownership boundaries

| Concern | Kernel | Contribution | Skill | Workspace policy |
|---|---:|---:|---:|---:|
| Capability checks and approvals | Owns | Declares requirements | Cannot alter | May further restrict |
| Conversation and memory scope | Owns contract | Supplies attributed identifiers | Cannot alter | Selects routing policy |
| Execution loop and terminal truthfulness | Owns | Implements bounded capabilities | Advises procedure | Defines deployment expectations |
| Provider API client and auth flow | No | Owns | May explain usage | Selects configured provider |
| Channel SDK and message mapping | No | Owns | May explain operations | Selects configured channel |
| Tool implementation | Owns security envelope | Owns handler and schema | May teach tool use | Allows or denies |
| Business workflow and examples | No | Only when executable API behavior is required | Owns reusable expertise | Owns deployment-specific policy |
| Persona, tone, organization rules | No | No | Optional reusable style procedure | Owns |
| Stable engine security prompt | Owns | Cannot modify | Cannot override | Cannot weaken |
| Evaluation of generic completion | Owns base rubric | May provide evidence adapters | May provide task checklist | May add bounded criteria |

## Specialization decision rule

Every requested behavior is classified before production code changes:

```text
Does the behavior enforce a universal trust, execution, identity,
storage, or lifecycle invariant?
  yes -> kernel mechanism, backed by a port when it crosses a boundary
  no  -> does it execute code or talk to an external system?
           yes -> typed contribution or MCP integration
           no  -> is it reusable expertise or a repeatable procedure?
                    yes -> opt-in skill
                    no  -> operator workspace policy
```

Use a repository-shipped skill under `skills/<name>/SKILL.md` when the behavior is instruction-heavy and does not need new executable authority. Examples include a troubleshooting procedure, a research method, a review checklist, or guidance for combining already-registered tools. A skill may name required capabilities, but activation fails honestly when those capabilities are unavailable.

Use a contribution when code must implement an API client, channel transport, storage adapter, model protocol, media codec, RPC handler, scheduled service, health probe, or tool. A contribution may be accompanied by a skill that teaches effective use, but installing the code does not silently activate the skill for every agent.

## Core identity contracts

### Conversation scope

Create `packages/core/src/domain/conversation-scope.ts` as the only authority-bearing conversation identity.

```ts
export const ConversationScopeSchema = z.strictObject({
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
  participantId: z.string().min(1),
  endpoint: z.strictObject({
    channelType: z.string().min(1),
    channelInstanceId: z.string().min(1),
    conversationId: z.string().min(1),
    threadId: z.string().min(1).optional(),
  }),
});

export type ConversationScope = z.infer<typeof ConversationScopeSchema>;

export interface ConversationRef {
  readonly value: string;
}

export function createConversationRef(
  scope: ConversationScope,
): Result<ConversationRef, ConversationScopeError>;
```

Contract requirements:

- all fields that affect isolation are required and validated before a store call;
- the reference is deterministic for the complete canonical structure and is safe for logs, paths, and opaque API identifiers;
- no caller parses the opaque reference to reconstruct authority;
- stores persist the structured fields beside the reference and compare both when reading or mutating;
- `channelInstanceId` distinguishes multiple configured accounts of the same channel type;
- `conversationId` identifies the channel conversation, while `participantId` identifies the requesting principal;
- optional thread identity narrows scope and never broadens it;
- any channel-specific guild, room, or peer detail that affects routing is normalized into these generic endpoint fields or remains attributed metadata, not a new kernel union member.

### Session storage

Replace session APIs that accept a formatted string with APIs that accept `ConversationScope` or a store-issued `ConversationRef` plus the same structured authority.

The SQLite session table must use a uniqueness constraint containing at least:

```text
tenant_id
agent_id
channel_type
channel_instance_id
participant_id
conversation_id
thread_id (normalized for uniqueness)
```

The store may keep an opaque `conversation_ref` primary key for efficient references, but the ref never substitutes for the scoped predicate. Listing, deletion, checkpoints, approvals, delivery mirrors, context rows, session metadata, and cross-session messages use the same identity contract.

The implementation must build two agents against the same real `SessionStorePort` and the same tenant, participant, channel instance, conversation, and thread, then prove that their histories, metadata, approvals, and deletes remain isolated. Separate fake stores do not satisfy this contract.

### Memory scope and visibility

Create `packages/core/src/domain/memory-scope.ts` with closed visibility variants:

```ts
export type MemoryVisibility =
  | { readonly kind: "conversation"; readonly conversationRef: ConversationRef }
  | { readonly kind: "participant"; readonly participantId: string }
  | { readonly kind: "agent" };

export interface MemoryWriteScope {
  readonly tenantId: string;
  readonly agentId: string;
  readonly visibility: MemoryVisibility;
  readonly provenance: {
    readonly participantId?: string;
    readonly conversationRef?: ConversationRef;
  };
}

export interface MemoryReadScope {
  readonly tenantId: string;
  readonly agentId: string;
  readonly participantId: string;
  readonly conversationRef: ConversationRef;
  readonly includeAgentShared: boolean;
}
```

The write caller must select visibility explicitly. Conversation or participant content does not become agent-shared because a field is omitted. Provenance explains where a fact came from; it does not grant read authority.

Every FTS, vector, temporal, graph, usefulness, consolidation, lifecycle, export, delete, and inspect operation receives a required scope. Candidate SQL applies tenant, agent, and allowed visibility predicates before `MATCH`, vector KNN ranking, ordering, or `LIMIT`. Tests seed a large higher-ranked corpus outside the caller's scope and prove that in-scope recall quality and timing do not depend on it.

## Contribution model

### Separate lifecycle hooks from capability registration

`PluginRegistryApi` remains a lifecycle-hook mechanism until its callers are replaced. Do not add empty `registerTool`, `registerHttpRoute`, or `registerConfigSchema` methods to it. Introduce a new contribution contract whose name reflects its broader responsibility.

Proposed files:

- `packages/core/src/contributions/contribution.ts`
- `packages/core/src/contributions/registration.ts`
- `packages/core/src/contributions/registry.ts`
- co-located tests for validation, dependency ordering, activation, and shutdown

### Contribution manifest

```ts
export const ContributionKindSchema = z.enum([
  "channel",
  "model-provider",
  "tool-pack",
  "storage",
  "scheduler",
  "observability",
  "integration",
]);

export interface RuntimeContribution {
  readonly manifest: ContributionManifest;
  register(registry: ContributionRegistration): Result<void, ContributionError>;
  activate?(context: ContributionActivationContext): Promise<Result<void, Error>>;
  deactivate?(): Promise<Result<void, Error>>;
}

export interface ContributionManifest {
  readonly id: string;
  readonly kind: z.infer<typeof ContributionKindSchema>;
  readonly requires: readonly string[];
  readonly provides: readonly ContributionSurface[];
}

export type ContributionSurface =
  | "channel-factory"
  | "model-provider"
  | "tool-pack"
  | "rpc-namespace"
  | "config-namespace"
  | "event-namespace"
  | "health-probe"
  | "lifecycle-hook";
```

The manifest does not contain prompt instructions, credentials, executable strings, or dynamic import paths. Contribution IDs and namespaces use one validated identifier grammar. `requires` names contribution IDs only; service dependencies use typed activation context ports.

### Registration surface

Avoid a single interface with dozens of optional fields. Use a small facade with explicit subregistries:

```ts
export interface ContributionRegistration {
  readonly channels: ChannelFactoryRegistry;
  readonly providers: ModelProviderRegistry;
  readonly tools: ToolDefinitionRegistry;
  readonly rpc: RpcNamespaceRegistry;
  readonly config: ConfigNamespaceRegistry;
  readonly events: EventSchemaRegistry;
  readonly health: HealthProbeRegistry;
  readonly hooks: HookRegistry;
}
```

The facade is scoped to the registering contribution. It enforces:

- a contribution can register only surfaces declared in `manifest.provides`;
- all registered names are prefixed by or otherwise owned by the contribution namespace;
- duplicate registration returns `err()` with the conflicting owners;
- registration performs no I/O and starts no timers;
- dependencies form an acyclic graph;
- activation follows dependency order and deactivation follows reverse order;
- partial activation failure deactivates already-started contributions and returns one structured failure report;
- all ERROR/WARN paths include `hint` and `errorKind`, and lifecycle events contain only identifiers, states, counts, and durations.

### Loader boundary

The daemon composition root initially supplies an explicit set of linked factories:

```ts
const linkedResult = createLinkedContributionSet([
  coreToolContributionFactory,
  sqliteStorageContributionFactory,
  echoChannelContributionFactory,
  // The full distribution lists every contribution it ships.
]);
if (!linkedResult.ok) return linkedResult;
const linkedContributions = linkedResult.value;
```

The full distribution owns the list of linked factories. The minimal distribution links only kernel adapters and explicitly selected contributions. The generic host iterates factory descriptors and never switches on their concrete IDs.

Boot is intentionally split so configuration has no discovery cycle:

1. instantiate linked contributions without secrets, network access, timers, or resolved contribution config;
2. register manifests, config schemas, and surface definitions without starting handlers;
3. assemble and validate kernel config plus every linked contribution namespace;
4. resolve the enabled contribution set and validate its dependency graph;
5. activate enabled contributions with only their parsed namespace and least-authority ports;
6. publish the active tool, RPC, event, channel, provider, health, and hook views.

Linked but disabled contributions remain visible as installable inventory and keep enough config metadata to be enabled. They expose no active tools, handlers, background work, network connections, or model-visible instructions.

Arbitrary packages are not loaded from a config string. A future external loader must separately define provenance, package integrity, install authority, filesystem confinement, code-signing or pinning policy, update policy, and incident response before it can execute code.

## Contribution-specific contracts

### Channels

A channel contribution registers separate, cohesive surfaces rather than one optional-field-heavy object:

```ts
export interface ChannelFactoryDefinition<TConfig> {
  readonly channelType: string;
  readonly configSchema: z.ZodType<TConfig>;
  create(
    config: TConfig,
    deps: ChannelFactoryDeps,
  ): Result<ChannelPort, ChannelFactoryError>;
}
```

Optional channel tools, media resolvers, delivery renderers, and history readers are separate registrations keyed to the same channel type. The registry validates that their owner also registered the base channel factory.

Daemon setup becomes:

1. parse all channel namespaces through registered schemas;
2. ask the channel registry for a factory by configured `channelType`;
3. construct the adapter with generic dependencies;
4. register lifecycle and health surfaces;
5. start through the contribution lifecycle;
6. report an unknown channel type as a configuration error with the list of installed types.

There is no daemon `switch`, `if` chain, or static tool map keyed by concrete platform names. The first vertical proof uses the existing Echo channel because it exercises lifecycle and message flow without an external SDK. A second proof uses one networked channel to cover credentials, retry, delivery, media, and shutdown.

### Model providers

Core defines only the model execution boundary:

```ts
export interface ModelProviderPort {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  listModels(): Promise<Result<readonly ModelDescriptor[], Error>>;
  execute(
    request: ModelExecutionRequest,
  ): Promise<Result<ModelExecutionStream, ModelProviderError>>;
}

export interface ModelExecutionStream {
  readonly events: AsyncIterable<Result<ModelExecutionEvent, ModelProviderError>>;
  cancel(): Result<void, Error>;
}
```

`ProviderCapabilities` describes generic facts such as streaming, tool calls, image input, structured output, cache reporting, and served context window. It does not enumerate provider families.

Provider contributions own:

- SDK construction and network transport;
- authentication and credential reference rules;
- model discovery, model ID normalization, aliases, and defaults;
- pricing metadata and token accounting peculiarities;
- provider-native tool schema conversion;
- cache semantics, retry classification, and response normalization;
- provider-specific diagnostics and health probes.

The runtime executor selects a registered provider by opaque ID and consumes only `ModelProviderPort`. Provider names and model catalogs must not appear in core config schemas, the stable engine prompt, or daemon conditionals. An OpenAI-compatible protocol adapter is a suitable first extraction because it proves that protocol-specific behavior can remain outside the kernel while supporting multiple configured endpoints.

### Tools

Use one typed `ToolDefinition` source for model exposure, policy, approval classification, execution, observability, and RPC or MCP export eligibility:

```ts
export interface ToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly sideEffect: "none" | "local-read" | "local-write" | "external-read" | "external-write";
  readonly requiredCapabilities: readonly AgentCapability[];
  execute(input: TInput, context: ToolExecutionContext): Promise<Result<TOutput, ToolError>>;
}
```

Contribution tools pass through the same action classifier, capability gate, approval path, external-content wrapper, audit logger, timeout, cancellation, and output guard as kernel tools. Registration metadata cannot lower a code-enforced classification. Tool instructions remain bounded descriptions; longer procedures belong in a skill.

### RPC and web contracts

Each host or contribution namespace exports method definitions containing request schema, response schema, required gateway scope, required agent capability where applicable, and the handler factory. The daemon dispatch table and generated web contracts are produced from those definitions.

The web client becomes method-keyed:

```ts
export interface RpcMethodMap {
  "agents.list": RpcMethod<AgentsListParams, AgentsListResult>;
  "channels.list": RpcMethod<ChannelsListParams, ChannelsListResult>;
  // generated entries
}

export interface RpcClient {
  call<M extends keyof RpcMethodMap>(
    method: M,
    params: RpcMethodMap[M]["params"],
  ): Promise<RpcMethodMap[M]["result"]>;
}
```

Methods without parameters use a canonical empty-object input so overloads remain simple. Tests must fail compilation for an unknown method and fail runtime contract validation for malformed responses. The polling controller regression is fixed by changing production and test literals to `agents.list` and `channels.list`; generated typing then prevents recurrence.

The base host owns only runtime-wide methods such as health, installed contribution inventory, and safe configuration inspection. Channel, provider, scheduler, memory-maintenance, media, and observability RPC namespaces live with their owning contributions.

### Events

Core retains a compact event map for universal lifecycle and security events. Contributions register namespaced event schemas and emit through a validating event port.

```ts
export interface EventDefinition<TPayload> {
  readonly name: string;
  readonly payloadSchema: z.ZodType<TPayload>;
  readonly sensitivity: "content-free" | "bounded-content";
}
```

Built-in TypeScript consumers receive generated known-event types, while runtime dispatch validates all payloads. A contribution event cannot masquerade as a core event or publish unbounded message content. Observability bridges subscribe through definitions instead of importing a product-wide closed union into core.

### Configuration

Split configuration into:

- a small kernel schema for data directory, security, runtime limits, contribution selection, and generic execution policy;
- registered contribution namespaces with schemas, defaults, immutable keys, UI metadata, and secret-reference declarations;
- per-agent selection of installed capabilities by opaque IDs.

Config assembly registers every linked namespace before parsing, then validates contribution selection and dependencies before activation. Unknown namespaces, missing linked contributions, or invalid defaults return configuration errors at startup. Schema defaults are applied once. Runtime consumers accept resolved active types without `??` semantic fallbacks.

The config editor and generated reference read from the same registry metadata. A contribution cannot redirect config changes to a tool unless that tool is registered by the same contribution and its schema is available.

## Prompt and context redesign

### Typed prompt compilation

Preserve the trust hierarchy in the architecture guide and split prompt production by source:

```ts
export interface PromptCompilationInput {
  readonly enginePolicy: EnginePolicySection;
  readonly workspacePolicy: WorkspacePolicySnapshot;
  readonly request: RequestSection;
  readonly runtimeState: RuntimeStateSection;
  readonly capabilities: CapabilitySection;
  readonly selectedSkills: readonly SkillSection[];
  readonly externalContext: readonly ExternalContextSection[];
}
```

Each section producer returns a typed section or `Result` and owns its budget. The compiler owns order, delimiters, omission, stable hashing, and the content-free compile report. Section producers do not append directly to a shared string.

Required implementation rules:

- the engine policy contains only universal trust and execution invariants;
- workspace policy is loaded once at turn start and no prompt consumer rereads files;
- runtime state carries locale, trust, compaction, selected skills, available tools, and execution mode structurally;
- MCP or server instructions are individually bounded, attributed, hashed, and wrapped as external content;
- tool availability comes from the registered tool set, never prompt prose;
- unchanged workspace starters remain absent;
- truncation never drops security invariants;
- diagnostics contain section identity, source, trust, size, hash, budget, and inclusion outcome, never content;
- no module parses `USER.md`, prompt headings, XML blocks, or generated prose to recover control state.

Split `prompt-assembly.ts` into cohesive section producers and a small compiler. The file-size gate applies to every resulting production file without a new allowlist entry.

### One context assembler

Use `ContextStorePort` as the lossless conversation store and retain one context assembler that produces the model-visible window. The DAG implementation becomes the canonical algorithm only after its parity tests cover all required behaviors currently owned elsewhere.

Remove the mode selector and silent pipeline fallback. A deployment without durable context uses an explicit in-memory `ContextStorePort`; a missing store is a startup precondition failure. The same assembler handles:

- fresh tail retention;
- tool call/result pairing;
- security-pinned messages;
- compaction and summaries;
- token budgets and minimum visible output;
- cache-aware stable prefixes;
- recall lanes and provenance;
- sub-agent and execution-graph context;
- diagnostics and deterministic replay.

Before deleting the alternate path, a parity suite runs the same scenario corpus through the canonical assembler and proves ordering, pin retention, tool pairing, budget bounds, cache stability, failure behavior, and content-free telemetry. After cutover, no production file branches on `contextEngine.version`, and comments and docs describe only the current assembler.

### Learning and workflow strategies

The kernel retains memory ports, evidence/provenance types, feedback events, and safe write validation. Strategies such as reflection, consolidation, dialectic comparison, learned procedure generation, or ahead-of-need capability suggestions are optional contributions when they execute code or mutate stores.

Instruction-only strategies become built-in skills. For example, a repeatable reflection checklist that uses existing memory tools belongs in a skill; a background consolidation worker that reads and writes memory belongs in a contribution. Neither is enabled for every agent merely because it ships in the full distribution.

## Package responsibilities

The redesign changes responsibilities before introducing package splits. Move code only when the target boundary has a real contract and caller.

| Package | Target responsibility |
|---|---|
| `@comis/shared` | `Result`, dependency-free utilities, and no runtime integrations. |
| `@comis/core` | Generic domain contracts, scopes, ports, security, capabilities, base events, prompt section contracts, contribution contracts, and pure registries. No provider SDKs or concrete channel knowledge. |
| `@comis/agent` | Provider-neutral turn execution, tool loop, canonical context assembly, prompt compilation, and safety enforcement through core ports. No observability implementation and no provider catalogs. |
| `@comis/orchestrator` | Generic inbound coordination, routing, queues, execution coordination, and delivery coordination through core ports. No imports of concrete channel implementations. |
| `@comis/channels` | In-repository channel contributions, normalized message adapters, delivery renderers, and channel-specific tools. |
| `@comis/skills` | Skill discovery and validation, generic tool security envelope, built-in tool contributions, MCP integration, and optional media contributions. It must not import agent implementation types. |
| `@comis/memory` | Scoped storage contributions implementing context, session, memory, credential, delivery, and observability storage ports. |
| `@comis/scheduler` | Scheduler contribution and generic scheduler ports; no default business schedules. |
| `@comis/observability` | Content-free diagnostics contribution consuming event and telemetry ports. |
| `@comis/observability-otel` | Optional exporter contribution loaded only when configured. |
| `@comis/gateway` | Generic transport, authentication, JSON-RPC framing, WebSocket, and HTTP boundaries. Method ownership comes from registered definitions. |
| `@comis/daemon` | Runtime host and composition root. Imports concrete in-repository contributions but contains no concrete channel/provider construction branches. |
| `@comis/web` | Browser UI using generated RPC contracts and browser-local runtime adapters. It does not import server runtime implementations. |
| `comis` | Full operator distribution and namespace exports; no longer the only practical way to consume the runtime. |

Add `@comis/runtime` only when a concrete headless embedding caller exists. Until then, the headless entry point may live in `@comis/daemon` behind a dependency-light export. A package split must reduce dependency weight and improve direction; it must not merely rename current coupling.

Required dependency changes:

- orchestrator consumes an `AgentRuntimePort` and channel/delivery ports from core rather than importing implementations;
- agent emits telemetry through core contracts rather than depending on `@comis/observability`;
- skills build tools against core tool contracts rather than importing agent types;
- web consumes generated contract artifacts without importing Node runtime helpers;
- daemon remains the only package allowed to import the full built-in contribution set.

## Delivery workstreams

```text
Scope correctness ------------------------------+
                                                 |
Typed RPC correctness --------+                  v
                              +--> Contribution registry --> Vertical proofs
                                                       |             |
                                                       v             v
                                              Built-in replacement   |
                                                       |             |
Prompt sections --> Canonical context assembler -------+-------------+
                                                       |
Config/events/control-plane registration --------------+
                                                       |
Optional strategy extraction --------------------------+
                                                       v
                                            Minimal distribution
                                                       |
                                                       v
                                        Delete old paths and tighten gates
```

Each workstream is concern-sized and follows Red → Green → Refactor. A test-only RED commit is preferred when it compiles against the current code. Pure documentation updates remain in the same behavior change that they describe.

### Immediate correctness work

Outcome: eliminate known authority and RPC mismatches before adding extension flexibility.

Implementation:

- add a web regression test that expects `agents.list` and `channels.list` against the real generated contract list;
- type `RpcClient.call()` from generated method definitions and remove response casts at polling call sites;
- introduce `ConversationScope` and replace formatted session authority across session, context, approval, delivery, and cross-session APIs;
- update SQLite uniqueness and predicates to include required tenant and agent scope;
- introduce explicit memory visibility and pre-scoped FTS/vector queries;
- update all call sites in the same changes; do not retain optional `agentId` overloads.

Acceptance:

- invalid RPC literals fail TypeScript compilation;
- two agents sharing every other conversation coordinate cannot read, overwrite, list, approve, or delete each other's session data in one real store;
- out-of-scope high-ranking memory rows cannot reduce in-scope recall;
- no production storage method infers tenant or agent from defaults.

### Contribution registry foundation

Outcome: establish a small registration and lifecycle kernel with no concrete integrations.

Implementation:

- add contribution manifest, registration facade, dependency graph, activation report, and shutdown behavior;
- scope each subregistry to the registering contribution;
- expose installed contribution and surface inventory for diagnostics;
- bridge existing hook plugins through a temporary in-tree adapter only while callers are converted, then delete the bridge;
- keep the explicit linked contribution list in daemon composition.

Acceptance:

- duplicate IDs, duplicate surfaces, namespace violations, undeclared surfaces, missing requirements, and cycles return typed errors;
- activation and shutdown order are deterministic and tested with fake clocks/timers;
- partial activation failure cleans up already-active contributions;
- registration cannot perform network I/O or obtain secrets;
- the registry has no knowledge of concrete channel, provider, or domain names.

### Vertical contribution proofs

Outcome: prove the abstraction with real behavior before broad conversion.

Implementation:

- convert Echo into a channel contribution covering config, factory, lifecycle, health, events, and message flow;
- convert one networked channel to cover credentials, retry, delivery, media, and shutdown;
- extract the OpenAI-compatible model protocol into a provider contribution;
- convert one read-only tool pack and one capability-gated side-effecting tool;
- register one contribution-owned RPC namespace and generate its web client types.

Acceptance:

- the converted features have end-to-end parity through the real daemon harness;
- removing a contribution removes its config schema, tools, RPC methods, events, and health probes from inventory without kernel edits;
- unknown configured contributions fail startup with an actionable error;
- security, approval, audit, and external-content handling are identical to kernel-owned tools.

### Built-in replacement

Outcome: remove concrete construction and static registries from the daemon and runtime packages.

Implementation:

- convert remaining channels, provider protocols, platform tool packs, media adapters, scheduler services, and exporter wiring;
- replace daemon branches with registry iteration;
- move integration-specific defaults and catalogs to their contribution packages;
- remove static platform tool unions and `as never` bridges by deriving types from definitions;
- split giant daemon dependency objects into cohesive host services and contribution activation contexts.

Acceptance:

- no daemon source branches on a concrete channel type or provider ID;
- adding an in-repository contribution requires only its package code and one full-distribution composition entry;
- core and agent do not import provider SDKs, channel SDKs, or integration-specific catalogs;
- contribution removal leaves no dead RPC, config, health, event, or UI contract.

### Prompt and context consolidation

Outcome: one typed prompt compiler and one deterministic context assembler.

Implementation:

- introduce typed prompt sections and independent section producers;
- preserve the immutable workspace snapshot and compile-report hashes;
- pass locale, trust, skills, tools, and compaction state structurally;
- complete canonical context parity tests;
- wire durable and in-memory context stores through the same port;
- delete alternate assembly branches, direct workspace rereads, and prompt-heading state recovery.

Acceptance:

- prompt output is deterministic for identical typed input;
- security and operator policy are never truncated;
- unchanged workspace starters add no tokens;
- no control state is recovered from Markdown or XML text;
- no production context mode selector or silent fallback remains;
- every prompt section producer and compiler file stays within the file-size gate.

### Config, event, and control-plane registration

Outcome: product-shaped control surfaces live with their owning contributions.

Implementation:

- reduce the kernel config schema and register contribution namespaces;
- produce UI field metadata, immutable keys, and config reference data from the same definitions;
- separate base runtime events from contribution schemas;
- register RPC namespaces with their authorization metadata;
- generate daemon dispatch types, web types, and documentation inputs from one method source;
- remove call-site semantic defaults after schema resolution.

Acceptance:

- config has one default source per field;
- disabling a contribution removes its namespace from active runtime config and its active UI capability inventory while retaining installable config metadata; removing it from the distribution removes the namespace entirely;
- daemon handlers cannot register without input/output schemas and authorization metadata;
- every generated client method has a registered server handler and every handler has a generated client contract unless explicitly marked server-internal;
- contribution events validate at emission and cannot collide with base events.

### Optional strategy extraction

Outcome: the always-on runtime contains mechanisms, not opinionated strategies.

Implementation:

- classify learning, reflection, consolidation, dialectic, media, and workflow modules using the specialization decision rule;
- retain universal storage, provenance, validation, and lifecycle ports in core;
- convert executable optional strategies to contributions;
- convert instruction-only procedures to opt-in repository skills;
- require explicit per-agent or operator activation and honest capability checks.

Acceptance:

- an unrelated deployment can run the kernel without inheriting an optional strategy's prompt text, config, timers, dependencies, or storage jobs;
- shipped skills remain bounded external context and cannot activate themselves;
- removing an optional contribution does not require conditionals in the execution loop.

### Distribution split

Outcome: a lean headless installation and a full operator distribution share the same kernel.

Implementation:

- define a dependency-light headless entry point with explicit contribution injection;
- keep CLI, web, all channels, media, browser, and exporters in the full distribution;
- dynamically import heavy in-repository contributions only after resolved config selects them;
- ensure package exports expose public contracts without internal cross-package paths;
- measure install size, startup imports, and cold-start time before and after each dependency move.

Acceptance:

- a headless test application can run an in-memory conversation with a test provider and Echo channel without installing unrelated integration SDKs;
- importing core or the headless entry point does not load channel, media, browser, or exporter modules;
- full distribution behavior remains covered by daemon integration tests;
- dependency-cycle and public-export tests pass.

### Removal and enforcement

Outcome: the redesigned architecture is the only production path.

Delete only after callers and parity tests are complete:

- optional-agent session identity and formatted-string authority;
- post-ranking scope filters;
- static platform tool registries;
- concrete daemon channel/provider construction branches;
- hook bridge used during contribution conversion;
- context mode switch and alternate assembler;
- direct workspace-policy rereads and prompt-heading parsing;
- provider catalogs and vendor defaults in core;
- untyped web RPC call surface;
- call-site config defaults that duplicate schema behavior;
- obsolete allowlist entries and whole-file exception annotations made unnecessary by the splits.

Then add or strengthen gates so these structures cannot return.

## Test strategy

### Contract tests

Every new port or registry receives a shared contract suite that all implementations run. Required suites include:

- conversation scope parse, canonical ref, and storage predicate behavior;
- session/context store multi-agent isolation in one database;
- memory visibility and pre-ranking scope;
- contribution registration, dependency ordering, activation cleanup, and shutdown;
- channel, provider, tool, RPC, config, event, and health definition validation;
- prompt section budgeting and deterministic compilation;
- context assembler parity and failure behavior;
- minimal distribution import boundaries.

### Integration tests

Use real composition where wiring is the contract:

- daemon boot with a minimal explicit contribution set;
- daemon boot with the full built-in set;
- unknown or missing contribution failure;
- Echo inbound request through routing, execution, context persistence, and delivery;
- shared SQLite session and memory isolation;
- generated RPC client against the real dispatch registry;
- contribution activation failure followed by clean shutdown;
- real workspace layout and immutable policy snapshot through prompt compilation;
- exporter absent/present import checks.

Integration tests that inspect on-disk context or session layout must build the actual nested layout and call the real resolver, consistent with the repository's filesystem-layout testing rule.

### Architecture gates

Add focused tests instead of broad text deny lists where possible:

- `@comis/core` and `@comis/agent` cannot depend on channel or provider SDK packages;
- `@comis/orchestrator` cannot import concrete agent or channel implementations;
- `@comis/skills` cannot import agent implementation modules;
- daemon channel/provider setup cannot compare concrete IDs outside contribution packages;
- all session and memory storage operations require typed scope;
- FTS and vector tests prove scope is applied before limiting;
- web RPC literals are constrained to the generated method map;
- prompt assembly cannot parse headings for runtime state;
- production source cannot branch on a context implementation selector;
- generic-runtime scanning includes `AGENTS.md` and covers structural specialization regressions, not only selected words;
- architecture documentation and `test/architecture/file-size.test.ts` agree on the enforced maximum;
- shrink-only allowlists lose entries as oversized files, raw throws, optional dependency clusters, globals, and coverage gaps are repaired.

Do not add a new allowlist entry to land redesign work. If a new contract makes a file too large or a dependency object too broad, split the responsibility before merging.

## Security requirements

The contribution system increases composition flexibility, not authority.

- Only the composition root supplies executable contribution instances.
- Registration receives no secret manager, network client, filesystem handle, timer, or process environment.
- Activation receives least-authority ports based on declared surfaces and configuration.
- Tool execution always enters the existing capability, action-classification, approval, audit, timeout, cancellation, and output-guard pipeline.
- Contribution config stores secret references, never resolved values.
- Platform secrets remain unavailable to user-facing secret-ref tools.
- RPC definitions declare both gateway scope and in-process agent capability when applicable; deny-by-origin remains enforced.
- External instructions are bounded, attributed, hashed, wrapped, and non-authoritative.
- Health and lifecycle events are content-free.
- Unknown contribution, provider, tool, event, or RPC names fail closed.
- Dependency or activation failure never silently drops a security control.
- Dynamic external module loading is prohibited until separately designed and approved.

Threat-focused tests cover namespace collision, duplicate registration, undeclared surface registration, dependency confusion, capability escalation, secret access during registration, malicious external instructions, malformed event payloads, partial activation, and shutdown after failure.

## Observability requirements

Every contribution lifecycle and boundary operation must be reconstructable from logs and events.

Required content-free fields include:

- `contributionId`, `contributionKind`, and surface name;
- lifecycle state and dependency IDs;
- `traceId` from request context where applicable;
- opaque conversation reference, never message text or raw identity fields unless already approved structured metadata;
- `durationMs`, result kind, retry count, and bounded item counts;
- `errorKind` and operator-actionable `hint` for every WARN/ERROR;
- activation inventory hash for reproducible startup diagnostics.

The host emits base lifecycle events for registration complete, activation complete, activation failed, and shutdown complete. Contributions emit their own namespaced operational events through registered schemas. Logs describe the failure; events announce the state change.

## Data and runtime cutover

The scope work creates one canonical persisted representation. Implement only that representation. Existing development data is backed up or discarded by the operator before deployment; the runtime does not contain dual readers, aliases, optional-agent overloads, or fallback parsing.

Apply storage changes atomically with their callers:

1. stop writers and take a verified backup;
2. build the new schema and canonical scope contracts;
3. update all writers, readers, list operations, deletes, checkpoints, approvals, and diagnostics;
4. run shared-store isolation and real-layout tests;
5. start the daemon only after schema and contribution inventory preflight passes;
6. verify session, memory, prompt, and delivery behavior through the real daemon harness.

For contribution conversion, keep behavior parity at the user boundary but never keep two active construction paths. Convert one vertical, switch its composition to the registry, and delete its old branch in the same behavior change.

## Risks and controls

| Risk | Control |
|---|---|
| A generic registry becomes a new god object | Keep subregistries cohesive, require concrete callers, and prevent optional-method clusters. |
| Contribution metadata is mistaken for authority | Enforce capabilities and approvals in code after registration; metadata may only request stricter handling. |
| Dynamic registration weakens TypeScript guarantees | Validate with Zod at runtime and generate known built-in maps for compile-time consumers. |
| Activation order creates hidden coupling | Require explicit contribution dependencies, reject cycles, and record the resolved inventory hash. |
| Scope replacement loses or mixes data | Use one structured scope, real shared-store tests, verified backups, and no dual-read ambiguity. |
| Search remains vulnerable to noisy neighbors | Apply scope inside FTS/vector candidate queries and test with dominant out-of-scope corpora. |
| Prompt split changes ordering or cache behavior | Pin byte-stable fixtures, section hashes, budgets, and cache-prefix tests before extraction. |
| Context consolidation drops edge behavior | Require scenario parity for tool pairing, pins, summaries, budgets, recall, cache, and sub-agents before deletion. |
| Optional features remain accidentally always-on | Inventory config, timers, dependencies, prompt sections, and jobs per contribution; absence tests must prove zero residue. |
| Full and minimal distributions drift | Run the same kernel contract suites against both compositions. |
| Generated RPC contracts drift from handlers | Generate both from one definition registry and enforce bidirectional parity in CI. |
| Architecture tests turn into permanent exception catalogs | Refuse new redesign allowlist entries and remove entries with each split. |

## Verification commands

During implementation, run the smallest relevant RED/GREEN test first, then the package and architecture gates. Before completion run:

```bash
pnpm build
pnpm test
pnpm lint:security
pnpm cycles
pnpm docs:check
pnpm validate
```

For changes touching specialization boundaries, prompts, workspace policy, locale, integrations, health surfaces, or the contribution kernel, also run:

```bash
pnpm vitest run test/architecture/generic-runtime-boundary.test.ts
```

Add focused commands to the corresponding workstream documentation when a new contract suite is introduced.

## Completion criteria

The redesign is complete only when all of the following are true:

- `ConversationScope` is the sole session authority and requires tenant and agent identity;
- real shared-store tests prove agent isolation across sessions, context, approvals, delivery, and deletion;
- memory scope and visibility are required and applied before candidate ranking;
- the daemon constructs channels, providers, tools, RPC namespaces, config namespaces, events, health probes, and optional services through registered contributions;
- core contains no concrete provider catalog, vendor default, channel construction, or domain workflow;
- agent and orchestrator depend on core ports rather than observability, channel, or agent implementations;
- the web RPC client is method-keyed and server/client parity is generated and tested;
- prompt compilation uses typed sections and one immutable workspace-policy snapshot;
- one context assembler serves durable and in-memory stores without a mode selector or silent fallback;
- optional executable strategies are contributions and instruction-only specialization is an opt-in skill;
- a minimal headless composition runs without unrelated integration dependencies;
- obsolete static registries, branches, fallback paths, duplicated defaults, and allowlist entries are deleted;
- architecture, security, unit, integration, documentation, and full validation gates pass;
- an unrelated Comis deployment can use the runtime without inheriting any application's persona, business vocabulary, provider workflow, preferred human language, or task-specific procedure.

## Implementation review checklist

Use this checklist for every redesign change:

- Is the behavior a universal runtime mechanism with a concrete caller?
- If it is specialization, should it be workspace policy, a skill, MCP, or a contribution?
- Does any identity or store lookup omit tenant, agent, participant, conversation, or explicit visibility authority?
- Is scope enforced before ranking, limiting, mutation, or deletion?
- Does the kernel learn a concrete provider, channel, SDK, workflow, or domain name?
- Can removing the contribution remove all of its config, RPC, events, health, tools, timers, and dependencies without editing the execution loop?
- Are registration and activation separated, deterministic, and least-authority?
- Does every failure return `Result` and produce actionable, content-free diagnostics?
- Is the test RED on the pre-change code and grounded in real composition where wiring or filesystem layout is the contract?
- Did the change delete the replaced path and shrink any relevant exception list?
- Would a completely unrelated agent inherit an assumption from the diff?

If the last answer is yes, the change is not a kernel change. Move it to the appropriate extension boundary before completion.
