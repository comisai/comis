# Generic agent runtime redesign implementation specification

Status: reviewed implementation specification. The identity/storage correctness work, canonical context and turn preparation, prompt compilation, locale resolution, and config tri-state/registration contracts are implemented. Contribution conversion, provider extraction, outcome evaluation, strategy extraction, and distribution work remain target-state requirements.

This document turns the [generic agent architecture](./generic-agent-architecture.md) into an executable redesign. The architecture guide remains the concise normative boundary that every production change must read. This specification defines the target contracts, package responsibilities, delivery order, tests, and removal criteria needed to make that boundary true in the runtime itself.

Nothing described as proposed in this document exists merely because it is named here. Each contract must be introduced test-first, with a concrete caller, and must replace an existing responsibility rather than becoming a parallel abstraction.

## Intended outcome

Comis becomes a generic, security-first agent runtime with a small stable kernel and a uniform contribution system. The kernel owns universal execution and trust mechanisms. Linked contributions provide executable capability definitions; explicitly enabled contribution instances provide live capabilities. Skills provide opt-in expertise and procedures. Typed operator configuration provides identity and routing policy; workspace policy provides deployment-specific persona, scope, and business policy.

The completed runtime has these properties:

- conversation, principal, endpoint, and memory authority are distinct, explicit, and enforced before storage lookup or ranking;
- channels, model providers, tools, RPC methods, configuration namespaces, lifecycle hooks, health probes, and event schemas enter the host through typed contribution contracts;
- the daemon composes registered contributions without branching on concrete channel or provider names;
- contribution definitions are distinct from configured instances, so one adapter can safely serve multiple accounts or endpoints;
- provider catalogs, vendor defaults, and integration-specific behavior live with their adapters, not in the kernel;
- prompt compilation consumes typed inputs and an immutable workspace-policy snapshot without parsing generated prose to recover runtime state;
- one turn-preparation path combines typed prompt compilation with one canonical conversation assembler, without reparsing either output;
- optional learning, media, scheduling, and workflow strategies do not enlarge the always-on kernel;
- the web client can call only generated RPC method names with matching request and response types;
- the headless runtime package does not install every channel SDK, media SDK, browser engine, observability exporter, and user interface dependency;
- outcome evaluation uses the exact turn policy snapshot and content-free evidence provenance;
- application-specific expertise ships as an opt-in skill when it does not require new executable authority.

## Scope

This redesign covers:

- runtime identity and storage isolation;
- normalized endpoint, principal, and routing-policy resolution;
- memory visibility and scoped retrieval;
- linked contribution registration, activation, health, and shutdown;
- channel, provider, tool, RPC, config, event, and observability extension points;
- prompt and context assembly boundaries;
- package dependency direction and distribution shape;
- the classification of specialization as kernel mechanism, contribution, skill, or workspace policy;
- test, security, observability, and documentation gates for the new architecture.

The redesign does not add a new business workflow, persona, preferred language, provider recommendation, or industry policy. It does not make arbitrary external code executable from configuration. External contribution loading requires a separate threat model and a concrete caller; the first implementation supports explicitly linked, in-repository contributions only.

## Architectural decisions

The following decisions are normative for implementation:

1. `tenantId` and `agentId` are required authority fields for every conversation, session, context, memory, approval, delivery, and durable execution lookup. An unresolved ingress context may exist, but it cannot reach a store or privileged action until resolution succeeds.
2. The endpoint that received a request, the authenticated platform assertion mapped to an internal principal, and the conversation partition selected from typed routing policy are separate contracts. A principal is included in conversation authority only when the selected partition policy requires it; free-form prose and adapter metadata never select authority.
3. Human-readable session-key strings are not an authority boundary. Storage uses a strict `ConversationScope`, an opaque reference derived from its complete canonical representation, and scoped predicates on every read and mutation.
4. Global maintenance operations never arise from omitted scope. A host-only maintenance authority is explicit and is unavailable to user or contribution handlers unless the composition root grants it.
5. Memory visibility is explicit at write time and widening requires typed permission plus capability enforcement. Agent-shared memory is never inferred from a missing principal or conversation field.
6. Search scope is applied inside FTS and vector candidate generation, before ranking and limiting. Derived indexes carry the authority fields needed to pre-filter and are updated atomically with their source rows.
7. The contribution registry replaces static platform registries and concrete daemon construction branches. It does not extend the hook-only `PluginRegistryApi` with unrelated optional methods.
8. The first contribution loader is an explicit in-process list assembled by the composition root. Filesystem package discovery and arbitrary module execution remain out of scope.
9. A linked contribution, a registered capability definition, and an enabled runtime instance have different identities and lifecycles. One contribution may create multiple isolated instances.
10. Registration is synchronous, definition-only, and receives no authority-bearing dependencies. I/O or started work is a contract violation enforced by review and architecture gates, not an in-process sandbox property. Activation binds implementations to pre-registered definitions, and active views are published atomically after the activation plan completes: a structurally invalid plan publishes nothing, while a leaf instance's runtime start failure is recorded as a failed instance rather than aborting the host.
11. Every contribution declares the surfaces it provides. The registry rejects undeclared bindings, duplicate ownership, invalid namespaces, missing dependencies, and dependency cycles. Independent contributions use a documented stable topological tie-break; independence is not an error.
12. Core owns capability semantics and approval enforcement. Contributions may request capabilities and declare a minimum side-effect class; they cannot grant authority, lower a classifier result, or weaken policy.
13. Core owns provider-neutral model execution contracts, not provider names, model catalogs, prices, authentication flows, aliases, or SDK-specific prompt behavior.
14. The context store and one canonical conversation assembler are mandatory runtime services. Missing durable storage may be satisfied by an explicit in-memory adapter, never by silently switching to another assembly algorithm.
15. Configuration defaults resolve once during schema composition. Semantically meaningful `auto` versus `on` versus `off` behavior is represented in the schema rather than recovered from raw pre-parse data, and consumers do not invent local fallbacks.
16. The existing API contract model, generator, browser artifact, and parity gates remain authoritative. The full aggregate moves outward as contracts move beside their host or contribution owner; no parallel RPC schema model or registry is introduced.
17. Skills remain non-authoritative prompt context. A shipped skill is opt-in unless an operator explicitly selects it through policy or configuration.
18. Outcome evaluation receives the immutable policy snapshot or fails to an `unknown` verdict; a hash lookup miss never silently evaluates against less policy.
19. Install isolation and import isolation are separate requirements. Dynamic imports improve startup cost but do not make package dependencies optional; a lean install requires a separate package dependency closure.
20. No dual readers, compatibility aliases, default-to-old behavior, or permanent transition flags are added. Callers and persisted contracts move to one current representation in the same concern-sized change.

## Implementation state and remaining evidence

The redesign starts from useful foundations: hexagonal ports and adapters, `Result<T, E>`, capability gates, secret isolation, request context, typed events, immutable workspace-policy snapshots, optional OpenTelemetry wiring, generated web contracts, and a functioning skill registry. Rows marked implemented describe contracts that are now enforced by tests; the remaining rows identify subsequent work.

| Area | Repository evidence | Required direction |
|---|---|---|
| Ingress and session identity | Implemented: ingress resolves endpoint, authenticated principal, agent, and routing partition into `ResolvedTurnScope`; `ConversationScope` and its opaque reference carry authority. Formatted session strings are display/path projections and the public formatted-key parser is removed. | Retain the scope-isolation and generic-runtime boundary gates while later contribution-owned channels adopt the same normalization contract. |
| Channel normalization | `NormalizedMessage.metadata` is intentionally loose, while orchestrator routing still interprets platform keys such as `guildId`, `telegramChatType`, `slackThreadTs`, and `telegramThreadId`. `DeliveryOrigin` identifies the chat but not the configured account or adapter instance that received it. | Normalize a typed endpoint, principal, chat kind, and thread at the channel boundary. Adapter metadata remains attributed data and cannot drive kernel routing, authorization, or storage scope. |
| Scoped stores | Implemented: session, context, approval, delivery queue/mirror/observability, durable-run, memory, and control-plane operations carry explicit tenant, agent, conversation, principal, and endpoint authority as required by each contract. Deployment-wide scans require explicit host-owned scope. | Retain real-SQLite two-agent isolation tests and typed-operation architecture gates as later stores are added. |
| Memory search | Implemented: FTS, vector-only, and split-lane candidate generation constrain tenant, agent, and allowed visibility lanes before ranking and limiting. Deletes require tenant-and-agent authority and writes require explicit visibility. | Preserve statement-shape tests whenever recall indexes or ranking plans change. |
| Web RPC | Implemented: the generated artifact owns the method-keyed request/result map, the browser client exposes typed method dispatch, raw dispatch is private, polling uses registered plural methods, and failures reach observable state. | Keep contract-codegen drift and raw-method architecture gates green as contribution RPC namespaces are introduced. |
| Plugins and channels | `packages/core/src/ports/plugin.ts` deliberately exposes hook registration only. `packages/channels/src/shared/channel-registry.ts` supports registration and lookup, but production wiring builds a read-only registry over adapters constructed directly in daemon setup, one enabled-check per platform. | Keep lifecycle hooks focused. Introduce a separate contribution registry that owns typed factories and lets the daemon iterate registrations. |
| Boot lifecycle | `packages/core/src/bootstrap.ts` loads the monolithic config and creates the foundation `AppContainer`; daemon wiring then constructs most integrations through additional setup stages. The container has no atomic contribution-start transaction. | Extend the existing bootstrap contract with linked definition registration and activation planning, then start all configured instances through one abortable `AppContainer` lifecycle and one shutdown path. |
| Providers and media | Provider families, concrete media catalogs and selectors, OAuth/catalog resolution, and SDK-specific behavior appear across `packages/core`, `packages/agent`, and `packages/daemon`; core and agent manifests also carry provider SDK dependencies. Core owns no model-execution port: the executor consumes the external coding-agent SDK directly, while media, embedding, and vision wiring branch on concrete provider names. | Keep only provider-neutral execution and capability contracts in core/agent; move catalogs, protocol behavior, media selection, auth, and SDK dependencies beside provider or media contributions. |
| Tools | `packages/skills/src/platform-tools/registry.ts` returns a static descriptor array whose channel tools are keyed by concrete platform names and whose build callbacks bridge dependencies with `as never` casts; operational tool metadata registers separately through `registerToolMetadata` in `packages/core/src/tool-metadata.ts`. | Register tools as typed contribution-owned definitions that carry their own operational metadata, derive types from definitions, and delete the static registry and the metadata side channel. |
| Prompt assembly | Implemented for the execution path: typed section producers feed a deterministic bounded compiler; trusted operator policy, untrusted runtime context, section hashes, and cache-stable prefixes remain distinct. No consumer reparses prompt headings for control state. | Contribution-owned prompt inputs and outcome evaluation must consume the same typed result in later slices. |
| Context assembly | Implemented: one canonical durable-context assembler is mandatory, storeless deployments inject the in-memory adapter explicitly, and production has no context implementation selector or silent algorithm fallback. `PreparedTurn` resolves authoritative turn inputs once before model-request assembly. | Preserve the parity corpus and selector architecture gate as context features evolve. |
| Config | Partially implemented: rerank uses a schema-owned `auto | on | off` union with no raw-tree side channel; contribution namespaces register through the consolidated section registry; contribution activation topology is immutable through runtime mutation surfaces; migrated consumers use schema-resolved defaults. | Move remaining contribution-owned schemas beside their owners during built-in conversion and keep one composed config result. |
| Control plane | `packages/core/src/api-contracts/` is a large closed product surface and `packages/daemon/src/api/` owns handlers separately. Core event maps similarly contain optional media, scheduler, provider, and observability vocabularies. | Retain a small host control plane and base event set; relocate contribution-owned contracts and schemas while preserving one build-time aggregate for dispatch, code generation, and parity checks. |
| Package direction | Agent imports the observability implementation and declares a scheduler dependency that production wiring satisfies by callback injection; orchestrator imports agent and channel implementation types/helpers; skills imports agent and observability; infra and memory import observability; observability-otel declares a memory dependency it never imports. | Introduce the missing core ports or move mechanisms to their owning package, then tighten the exact package graph. Do not hide implementation imports behind dynamic loading or type aliases. |
| Distribution | `@comis/daemon` depends on the full runtime graph, `@comis/skills` carries browser/media/ML dependencies, `@comis/memory` carries embedding-provider dependencies, and `comisai` aggregates nearly every SDK. | Publish a separate lean runtime package, move heavy SDKs into contribution package closures, and use dynamic import only as the additional startup-isolation mechanism it actually provides. |
| Boundary enforcement | `test/architecture/generic-runtime-boundary.test.ts` protects selected terminology and prompt invariants, targeted import-direction tests cover several package pairs, and an exact package-graph test pins today's edges — including the implementation edges this redesign removes — while leaving the observability, exporter, web, and umbrella packages unconstrained. Nothing proves contribution ownership or scoped persistence behavior. | Add structural and behavioral gates that encode the target architecture, while keeping allowlists shrink-only. |

## Target architecture

```text
Operator configuration and workspace policy
                    |
                    v
       +------------+-------------+
       |       Runtime host       |
       |   linked factories only  |
       +------------+-------------+
                    |
                    v
       +------------+-------------+
       | Definition registry      |
       | schemas | contracts      |
       | factories | dependencies |
       +------------+-------------+
                    |
             resolve config
             plan activation
                    |
                    v
       +------------+-------------+
       | Active capability views  |
       | instances | handlers     |
       | tools | events | health  |
       +------------+-------------+
                    |
                    v
 +------------------+------------------+
 |        Generic runtime kernel       |
 | endpoint, principal, and scope      |
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

The runtime host is the only layer that knows the complete linked set. The definition registry is safe to inspect before activation; active views expose live bindings only from successfully started instances and carry explicit failed-instance state for any enabled instance that failed to start. The kernel knows contribution contracts and registered capabilities, never the names of concrete channels, providers, SDKs, or task domains.

## Ownership boundaries

| Concern | Kernel | Contribution | Skill | Operator authority |
|---|---:|---:|---:|---:|
| Capability checks and approvals | Owns | Declares requirements | Cannot alter | May further restrict |
| Endpoint and principal normalization | Owns generic contract and resolver | Supplies authenticated platform assertions | Cannot alter | Typed config selects identity mappings |
| Conversation and memory scope | Owns resolution and enforcement | Cannot choose its own authority | Cannot alter | Typed config selects routing and visibility permissions |
| Execution loop and terminal truthfulness | Owns | Implements bounded capabilities | Advises procedure | Defines deployment expectations |
| Provider API client and auth flow | No | Owns | May explain usage | Selects configured provider |
| Channel SDK and message mapping | No | Owns | May explain operations | Selects configured channel |
| Tool implementation | Owns security envelope | Owns handler and schema | May teach tool use | Allows or denies |
| Business workflow and examples | No | Only when executable API behavior is required | Owns reusable expertise | Owns deployment-specific policy |
| Persona, tone, organization rules | No | No | Optional reusable style procedure | Owns |
| Stable engine security prompt | Owns | Cannot modify | Cannot override | Cannot weaken |
| Evaluation of generic completion | Owns base rubric | May provide evidence adapters | May provide task checklist | May add bounded criteria |

Here, operator authority has two typed inputs: validated configuration for authorization, routing, and persistence decisions; and the immutable workspace-policy snapshot for model-visible behavior and evaluation. The kernel never parses free-form workspace prose to construct an identity, broaden memory visibility, or choose a conversation partition.

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

### Endpoint, principal, and resolved turn scope

Create `packages/core/src/domain/conversation-scope.ts` and make the types below the only authority-bearing turn identity. The exact routing variants may be adjusted during the test-first implementation, but the separation between endpoint, principal, and selected partition is normative.

```ts
export const ChannelEndpointSchema = z.strictObject({
  channelType: z.string().min(1),
  channelInstanceId: z.string().min(1),
  conversationId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  conversationKind: z.enum(["direct", "shared"]),
});
export type ChannelEndpoint = z.infer<typeof ChannelEndpointSchema>;

export const PrincipalScopeSchema = z.strictObject({
  principalId: z.string().min(1),
});
export type PrincipalScope = z.infer<typeof PrincipalScopeSchema>;

export const PlatformPrincipalAssertionSchema = z.strictObject({
  channelType: z.string().min(1),
  channelInstanceId: z.string().min(1),
  platformSubjectId: z.string().min(1),
});
export type PlatformPrincipalAssertion = z.infer<typeof PlatformPrincipalAssertionSchema>;

export interface PrincipalResolverPort {
  resolve(
    tenantId: string,
    agentId: string,
    assertion: PlatformPrincipalAssertion,
  ): Result<PrincipalScope, PrincipalResolutionError>;
}

export const ConversationPartitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("agent") }),
  z.strictObject({ kind: z.literal("principal"), principalId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("channel-principal"),
    channelType: z.string().min(1),
    principalId: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("endpoint-conversation"), endpoint: ChannelEndpointSchema }),
  z.strictObject({
    kind: z.literal("endpoint-conversation-principal"),
    endpoint: ChannelEndpointSchema,
    principalId: z.string().min(1),
  }),
]);

export const ConversationScopeSchema = z.strictObject({
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
  partition: ConversationPartitionSchema,
});

export const ResolvedTurnScopeSchema = z.strictObject({
  conversation: ConversationScopeSchema,
  principal: PrincipalScopeSchema,
  endpoint: ChannelEndpointSchema,
});

export type ConversationScope = z.infer<typeof ConversationScopeSchema>;
export type ResolvedTurnScope = z.infer<typeof ResolvedTurnScopeSchema>;

export const ConversationRefSchema = z.string().regex(/^cv_[A-Za-z0-9_-]{43}$/).brand<"ConversationRef">();
export type ConversationRef = z.infer<typeof ConversationRefSchema>;

export function createConversationRef(
  scope: ConversationScope,
): Result<ConversationRef, ConversationScopeError>;
```

The channel contribution supplies a platform subject assertion only after channel authentication. `PrincipalResolverPort` maps it to the internal principal. Its safe unmapped behavior namespaces the platform subject by channel type and configured instance; cross-channel or cross-account identity linking requires an explicit typed operator mapping. Display names, message metadata, model output, and workspace prose are never identity evidence. Resolution is synchronous and pure over validated operator configuration by design: the authentication path performs no I/O. A future store-backed identity directory would materialize typed mappings into configuration rather than making resolution asynchronous.

The routing-policy resolver receives the normalized endpoint, resolved principal, tenant, selected agent, and parsed per-agent session policy, then returns `ConversationScope`. It is the only code allowed to choose a partition variant. A shared conversation always uses `endpoint-conversation`; direct-message modes map explicitly to agent, principal, channel-principal, or endpoint-conversation-principal partitions. Those variants correspond one-to-one to the per-agent direct-message scope modes the configuration already exposes, so the resolver subsumes the existing routing vocabulary instead of adding a second one. The kernel therefore supports intentional sharing without silently equating the latest sender with conversation authority or accidentally merging two configured accounts that reuse a platform conversation ID.

Contract requirements:

- all fields that affect isolation are required and validated before a store or privileged-action call;
- `channelInstanceId` identifies one configured account or endpoint, not merely a channel implementation type;
- the opaque reference is the `cv_`-prefixed base64url SHA-256 digest of one explicitly specified canonical scope encoding that is injective by construction — versioned, domain-separated, and length-delimited so no two distinct scopes can share an encoding; it contains no raw principal or endpoint value, is safe for logs, paths, and APIs, and is produced only by schema parse of that digest — the brand is never applied by cast;
- no caller parses the opaque reference to reconstruct authority;
- request context carries the resolved structured types; formatted strings are display identifiers only;
- a thread can only narrow the chosen endpoint partition;
- `ResolvedTurnScopeSchema` refines principal-bearing and endpoint-bearing partitions so their values exactly match the outer authenticated principal and normalized endpoint; channel-scoped partitions match the endpoint's channel type, and endpoint equality is exact over the thread-narrowed endpoint;
- adapter metadata remains available as attributed data but never supplies a routing or authorization field after normalization;
- scheduled, RPC, and internal entry points mint explicit generic endpoint and principal identifiers at their boundary rather than omitting identity;
- sub-agent and delegated executions inherit the parent turn's resolved scope and never mint a new conversation authority; delegation widens no memory visibility;
- single-tenant deployments inject their configured tenant explicitly at ingress; stores never default it.

Non-channel origins use the same contracts instead of bypassing them. Each internal origin kind — a scheduler tick, a control-plane execution request, a durable resume — mints one canonical generic endpoint whose channel type names the origin kind and whose instance and conversation identifiers name the configured source, plus an explicit configured or synthetic origin principal; the routing-policy resolver then selects the partition exactly as it does for channel ingress. The scheduler's current synthetic formatted-session fallback is replaced by this explicit minting, and no internal origin reaches a store with omitted identity.

### Session storage

Replace session APIs that accept a formatted string with APIs that accept `ConversationScope`. APIs that receive an opaque reference from a control-plane client also require an explicit tenant-and-agent query scope, load the stored structured scope, and authorize the operation before mutation.

The SQLite session table uses the following authority key:

```text
tenant_id
agent_id
conversation_ref
```

It also persists the canonical structured partition representation beside the reference. Every point lookup predicates on tenant, agent, and reference, then compares the stored canonical scope before returning or mutating. A collision or mismatch is an internal error, never a best-effort match. Partition-kind columns may be materialized for listing, but they do not replace the canonical scope.

Listing, deletion, context rows, session metadata, checkpoints, approvals, delivery mirrors, delivery queue attribution, observability correlation, durable runs, and cross-session messages carry the same tenant, agent, and conversation reference. Approval records additionally bind the exact principal allowed to resolve them. Delivery records additionally bind the destination endpoint snapshot. Durable-run records replace their formatted session key and owner-user fields with the conversation reference and principal, and their cross-field consistency refinements re-anchor on the canonical scope. Deployment-wide drain, retention, and repair jobs use a distinct, non-serializable authority minted only at the composition root instead of an optional or empty scope. RPC, tool, channel, and model-facing APIs never accept it.

The implementation must build two agents against the same real stores and the same tenant, principal, endpoint, conversation, and thread, then prove that histories, metadata, approvals, delivery records, durable runs, and deletes remain isolated. It must also prove that a shared partition is shared across two principals while a principal partition is not. Separate fake stores do not satisfy these contracts.

### Memory scope and visibility

Create `packages/core/src/domain/memory-scope.ts` with closed visibility variants:

```ts
export type MemoryVisibility =
  | { readonly kind: "conversation"; readonly conversationRef: ConversationRef }
  | { readonly kind: "principal"; readonly principalId: string }
  | { readonly kind: "agent" };

export interface MemoryWriteScope {
  readonly tenantId: string;
  readonly agentId: string;
  readonly visibility: MemoryVisibility;
  readonly provenance:
    | { readonly kind: "turn"; readonly principalId: string; readonly conversationRef: ConversationRef }
    | { readonly kind: "agent"; readonly sourceId: string }
    | { readonly kind: "external"; readonly sourceId: string; readonly conversationRef?: ConversationRef };
}

export interface MemoryReadScope {
  readonly tenantId: string;
  readonly agentId: string;
  readonly principalId: string;
  readonly conversationRef: ConversationRef;
  readonly includeAgentShared: boolean;
}
```

The write caller must select visibility explicitly. User- and model-facing inputs may request only a visibility kind; the kernel fills its identifiers from `PreparedTurn` and never accepts caller-supplied tenant, agent, principal, or conversation authority. A background contribution receives a pre-scoped memory service limited by its activation authority rather than constructing raw scope; `MemoryReadScope` models a turn read, and pre-scoped services derive narrower read shapes — for example principal-wide reads with no conversation lane — from their activation authority without ever reaching conversation-visible rows outside it. Widening a conversation-visible write to principal or agent visibility requires the corresponding typed operator permission and code-enforced capability; denial returns `err()` and emits an audit decision. External-provenance writes additionally carry a visibility ceiling: they default to conversation visibility, and raising externally sourced content to principal or agent visibility requires the same typed permission plus an explicit operator policy for external facts — a turn that holds the widening capability while ingesting untrusted content must not become a cross-principal poisoning path. Conversation or principal content does not become agent-shared because a field is omitted. Visibility is immutable for a memory ID; changing it creates a new entry and removes the old one under the original scope. Provenance explains where a fact came from and is a closed variant; it does not grant read authority.

Every FTS, vector, temporal, graph, usefulness, consolidation, lifecycle, export, delete, pin, unpin, stats, and inspect operation receives a required scope or the explicit host-maintenance authority. Candidate SQL applies tenant, agent, and allowed visibility predicates before `MATCH`, vector KNN ranking, ordering, or `LIMIT`.

For SQLite:

- FTS candidate generation is authority-aware. Use either a physically tenant-agent-partitioned FTS index or indexed opaque scope tokens in `MATCH` followed by scope-local lexical scoring. Visibility is part of the same candidate constraint, and every derived lexical index, including the trigram variant, follows the same rule — the context store's trigram indexes already carry per-agent isolation columns inside `MATCH` queries and prove the pattern in this repository. Unindexed authority columns plus a post-`MATCH` `WHERE` clause alone are not proof that out-of-scope corpus statistics or an early limit cannot influence ranked candidates;
- vec0 rows carry a collision-free tenant-agent partition ID from an authority table with a unique `(tenant_id, agent_id)` constraint, plus visibility metadata. The partition and visibility constraints are present in the KNN query. If the pinned vec0 query planner cannot express the complete allowed-visibility predicate in one KNN query, run one pre-filtered KNN lane per allowed visibility and merge those already-scoped lanes deterministically;
- an asynchronous embedding writer reads authority from the source memory row and copies it into vec0 in the same transaction as the vector insert. It never trusts scope supplied by a queue payload;
- source writes may exist without a derived vector row, but no derived row may exist with broader authority than its source.

The adapter must verify these queries against the repository-pinned sqlite-vec version. Upstream documents [partition keys and metadata columns](https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html) and [KNN filtering in the virtual-table query](https://alexgarcia.xyz/sqlite-vec/features/knn.html), but executable tests against the pinned build are the contract.

Tests seed a large, higher-ranked corpus in another tenant, agent, principal, and conversation, then prove in-scope candidate membership, limit use, and deterministic ranking do not depend on it. Query-plan, statement-shape, and ranking fixtures prove the predicates occur in candidate generation; timing alone is not sufficient evidence.

## Contribution model

### Separate lifecycle hooks from capability registration

`PluginRegistryApi` remains a lifecycle-hook mechanism until its callers are replaced. Do not add empty `registerTool`, `registerHttpRoute`, or `registerConfigSchema` methods to it. Introduce a new contribution contract whose name reflects its broader responsibility.

Proposed files:

- `packages/core/src/contributions/contribution.ts`
- `packages/core/src/contributions/registration.ts`
- `packages/core/src/contributions/registry.ts`
- co-located tests for validation, dependency ordering, activation, and shutdown

### Contribution manifest and lifecycle

```ts
export interface RuntimeContribution {
  readonly manifest: ContributionManifest;
  register(registry: ContributionRegistration): Result<void, ContributionError>;
}

export interface ActiveContribution {
  readonly contributionId: string;
  readonly bindings: readonly ActiveSurfaceBinding[];
  close(signal: AbortSignal): Promise<Result<void, ContributionError>>;
}

export interface ContributionManifest {
  readonly id: string;
  readonly version: string;
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

The manifest does not contain prompt instructions, credentials, executable strings, or dynamic import paths. Contribution IDs and namespaces use one validated identifier grammar. `requires` names contribution IDs only; service dependencies use typed activation context ports. `version` is build inventory, not compatibility negotiation: the runtime supports exactly the linked contract and does not select alternate behavior by version. A contribution itself has no closed kind taxonomy — it is classified operationally by which of the closed surface set it provides, and one contribution may provide several.

`RuntimeContribution` is a linked definition provider, not a configured account and not a live singleton. Registered surface definitions own the activators used in the host's activation plan. `ActiveContribution` is the host-produced aggregate for one activation attempt, so tests and multiple embedded hosts do not mutate a process-global `deactivate()` target. It contains one binding per activated instance plus any explicitly registered contribution-wide lifecycle binding. `close()` is idempotent, bounded by the supplied abort signal, and owns every resource started by that activation.

`ContributionError`, registration conflicts, activation failures, cleanup failures, and lifecycle precondition failures are closed discriminated unions with exhaustive handling. Boundary causes are sanitized and retained as structured diagnostics; contracts do not fall back to generic `Error` or thrown control flow.

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

The facade is scoped to the registering contribution. Registration writes into an isolated staging transaction. The host commits all staged definitions only after `register()` returns `ok`; an error discards the entire contribution registration. The registry enforces:

- a contribution can register only surfaces declared in `manifest.provides`;
- every registered name has one recorded owner; event and RPC names are namespaced, while an intentionally stable flat tool name may be claimed by only one owner;
- duplicate registration returns `err()` with the conflicting owners;
- dependencies form an acyclic graph;
- the activation plan is a stable topological sort; otherwise independent nodes are ordered lexically by contribution ID, definition ID, then instance ID;
- activation follows dependency order, has an abort signal and deadline, and publishes no live binding before the activation transaction completes;
- a structural activation failure closes already-started handles in reverse order, continues cleanup after individual cleanup errors, publishes nothing, and returns one structured report containing the initiating and cleanup failures;
- normal shutdown closes all active handles in reverse activation order and is safe to retry;
- all ERROR/WARN paths include `hint` and `errorKind`, and lifecycle events contain only identifiers, states, counts, and durations.

In-process TypeScript cannot sandbox arbitrary module initialization or prove that a linked function performs no I/O. The enforceable boundary is narrower: only trusted, composition-root-linked code executes; registration receives no authority-bearing objects; contribution registration modules are architecture-tested against network, filesystem, timer, environment, and secret imports; and activation is the first phase that receives scoped runtime authority. Do not describe API deprivation as a security sandbox.

### Definitions and configured instances

Three identifiers remain distinct:

| Identifier | Meaning | Cardinality |
|---|---|---|
| `contributionId` | Linked code and its manifest, schemas, and activators | One per linked contribution |
| `definitionId` | A registered channel type, provider protocol, tool, RPC namespace, or other surface | One contribution can own many |
| `instanceId` | One operator-configured account, endpoint, provider base URL, or service instance | One definition can have many |

Config namespaces therefore store instance maps keyed by validated `instanceId`; they do not assume one channel account or provider endpoint per contribution. Instance IDs are non-sensitive operator-assigned slugs, not platform account addresses or credential references. They are unique within the owning definition and are present in endpoint identity, health, inventory, metrics, and shutdown reports.

Activation failures split by class. A structurally invalid plan — an unknown definition, a duplicate instance ID, a schema violation, a dependency cycle, or a failed instance that other enabled work depends on — fails the activation transaction and publishes nothing. An enabled leaf instance that fails to start for a runtime cause, such as rejected credentials or an unreachable endpoint, is published as an explicit failed instance with health findings instead of aborting unrelated instances; the deployment boots degraded and loudly, matching the operational reality that one bad account must not take down every other account. Nothing is silently omitted from the published view, and a failed instance never silently narrows a security control.

Definitions contain schemas, immutable metadata, and activation factories. They do not expose a live adapter created during registration. Activation receives only the parsed config for its instance, an owner-scoped credential resolver limited to the secret references declared by that namespace, and the minimal surface-specific dependency object. Avoid a universal activation context with dozens of optional services. Shared kernel resources such as the database handle stay kernel-owned: storage contributions receive scoped ports over them, and an instance's `close()` releases only what that instance started — never a shared handle.

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

The full distribution owns the list of linked factories. The headless runtime links only kernel adapters and caller-selected contributions. The generic host iterates factory descriptors and never switches on their concrete IDs.

Each linked factory comes from an inert, dependency-light definition subpath that exposes the manifest, schemas, and activators without importing the SDK adapter module or starting module-level work. After config resolution selects an instance, its trusted activator may dynamically import the adapter module from that same installed contribution package. The import target is code-owned by the linked factory, never a configuration string. Architecture tests import every definition and contract subpath in isolation and prove that disabled contributions do not load their SDK entry points.

Boot is intentionally split so configuration has no discovery cycle:

1. instantiate trusted linked contributions without passing secrets, network clients, timers, or resolved contribution config;
2. transactionally register manifests, config schemas, and inactive surface definitions;
3. assemble and validate kernel config plus every linked contribution namespace;
4. resolve enabled definitions and configured instances, then validate contribution dependencies and cross-instance references;
5. activate the stable plan with parsed instance config and least-authority, surface-specific ports;
6. atomically publish one immutable active view of tools, RPC handlers, events, channels, providers, health probes, and hooks.

During step 5, an activator can resolve only the already-started bindings of dependencies declared by its owning contribution. Those bindings live in a plan-local view and are not visible to ingress, tools, RPC, or background observers until step 6 succeeds.

Linked but disabled contributions remain visible as installable inventory and keep enough config metadata to be enabled. They expose no active tools, handlers, background work, network connections, or model-visible instructions.

Arbitrary packages are not loaded from a config string. A future external loader must separately define provenance, package integrity, install authority, filesystem confinement, code-signing or pinning policy, update policy, and incident response before it can execute code.

### Composition root and shutdown

Extend the existing `bootstrap(options) -> Result<AppContainer, ConfigError>` composition path instead of creating a second service locator. `BootstrapOptions` receives the explicit linked contribution factories plus the required environment and outer runtime adapters. The generic implementation in `packages/core/src/bootstrap.ts` performs transactional definition registration, config assembly, activation planning, and construction of an inactive container without importing a concrete contribution package. `@comis/runtime` and `@comis/daemon` select different linked factory sets and supply adapters; neither reproduces kernel wiring.

`AppContainer.start()` performs the abortable activation transaction and atomically publishes typed active views, returning a closed `Result` error type for runtime activation failures. Its one shutdown closure stops new ingress, aborts in-flight activation or execution as appropriate, closes active contribution bindings in reverse order, and then closes kernel-owned stores and adapters. Every step is attempted, and the returned structured result reports all failures. Daemon and headless callers invoke the same start and shutdown lifecycle. Do not add a parallel DI container, mutable global registry, or second shutdown path.

`start()` and the state machine are net-new: today the composition path wires eagerly and the container exposes only shutdown, so the daemon's post-bootstrap setup stages move into activation rather than being wrapped by it, and the container's raw-config side channel is deleted with them. Reconfiguring the linked set, an instance, or activation topology is a lifecycle restart — the existing graceful-restart signal path stops the container and a fresh bootstrap runs the next activation transaction; the active view is never partially mutated in place. Cross-restart session replay identifies sessions by canonical conversation scope, and per-agent capability selection remains runtime-mutable configuration that chooses from the published active view without altering it.

The container lifecycle is a closed state machine: `created -> starting -> active -> stopping -> stopped`, with failed activation moving through cleanup to `stopped`. Concurrent or repeated `start()` calls return a precondition error; shutdown is idempotent and may be called from any state, including while activation is being aborted.

## Contribution-specific contracts

### Channels

A channel contribution registers separate, cohesive surfaces rather than one optional-field-heavy object:

```ts
export interface ChannelFactoryDefinition<TConfig> {
  readonly channelType: string;
  readonly configSchema: z.ZodType<TConfig>;
  activate(
    instance: { readonly instanceId: string; readonly config: TConfig },
    deps: ChannelFactoryDeps,
    signal: AbortSignal,
  ): Promise<Result<ActiveChannelInstance, ChannelFactoryError>>;
}
```

Optional channel tools, media resolvers, delivery renderers, and history readers are separate registrations keyed to the same channel type. The registry validates that their owner also registered the base channel factory.

Daemon setup becomes:

1. parse all channel namespaces through registered schemas;
2. ask the channel registry for a factory by configured `channelType`;
3. activate one adapter per configured instance with generic dependencies;
4. stage its channel, lifecycle, health, and optional companion bindings in the plan-local active view;
5. publish them with the complete activation transaction;
6. report an unknown channel type or duplicate instance ID as a configuration error with the list of linked types.

Reconnection and backoff inside a running instance remain adapter-internal behavior surfaced through instance health; the host lifecycle owns activation and shutdown, not mid-run transport management.

There is no daemon `switch`, `if` chain, or static tool map keyed by concrete platform names. The first vertical proof uses the existing Echo channel because it exercises lifecycle and message flow without an external SDK. A second proof uses one networked channel to cover credentials, retry, delivery, media, and shutdown.

### Model providers

Core defines only the model execution boundary:

```ts
export interface ModelProviderPort {
  readonly providerInstanceId: string;
  readonly capabilities: ProviderCapabilities;
  listModels(signal: AbortSignal): Promise<Result<readonly ModelDescriptor[], ModelProviderError>>;
  execute(
    request: ModelExecutionRequest,
    signal: AbortSignal,
  ): Promise<Result<ModelExecutionStream, ModelProviderError>>;
}

export interface ModelExecutionStream {
  readonly events: AsyncIterable<Result<ModelExecutionEvent, ModelProviderError>>;
  cancel(): Result<void, ModelProviderError>;
}
```

Aborting the execution signal terminates `events`; `cancel()` releases the same underlying execution from the consumer side. Both are idempotent and converge on one terminal state.

`ProviderCapabilities` describes generic facts such as streaming, tool calls, image input, structured output, cache reporting, and served context window. It does not enumerate provider families. The name is currently taken: core's existing `ProviderCapabilities` is a static override schema keyed by a provider-family enumeration — the exact coupling this boundary removes. The redefinition, the relocation of family-keyed overrides into provider contribution instance config, and every consumer migration land in one change; an old and a new `ProviderCapabilities` never coexist in production.

Provider contributions own:

- SDK construction and network transport;
- authentication and credential reference rules;
- model discovery, model ID normalization, aliases, and defaults;
- pricing metadata and token accounting peculiarities;
- provider-native tool schema conversion;
- cache semantics, retry classification, and response normalization;
- provider-specific diagnostics and health probes.

The runtime executor selects a configured provider instance by opaque ID and consumes only `ModelProviderPort`. Provider names and model catalogs must not appear in core config schemas, the stable engine prompt, or daemon conditionals. A provider definition may activate many independent base URLs or accounts; their credentials, circuit state, models, health, and shutdown remain instance-scoped. An OpenAI-compatible protocol adapter is a suitable first extraction because it proves that protocol-specific behavior can remain outside the kernel while supporting multiple configured endpoints.

### Tools

Use one typed `ToolDefinition` source for model exposure, policy, approval classification, observability, and RPC or MCP export eligibility. Bind execution separately during activation:

```ts
export interface ToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly minimumSideEffect: "none" | "local-read" | "local-write" | "external-read" | "external-write";
  readonly minimumOutputTrust: "trusted-runtime" | "external";
  readonly requiredCapabilities: readonly AgentCapability[];
}

export interface ActiveToolBinding<TInput, TOutput> {
  readonly definition: ToolDefinition<TInput, TOutput>;
  execute(input: TInput, context: ToolExecutionContext): Promise<Result<TOutput, ToolError>>;
}
```

The definition also carries the tool's operational metadata — result-size bounds, concurrency safety, discovery hints, and action discrimination — replacing the separate tool-metadata registration path so exposure, policy, and metadata cannot drift apart. The agent package's internal SDK-shaped `ToolDefinition` interface is renamed or made package-private when this core contract lands; one exported name does not carry two shapes.

Contribution tools pass through the same action classifier, capability gate, approval path, external-content wrapper, audit logger, timeout, cancellation, and output guard as kernel tools. The effective side-effect class and output trust are the stricter of the registered minima and runtime classification; registration metadata can never lower either. Data returned by an external system is therefore wrapped before it reaches a prompt even when the tool itself is read-only. Tool instructions remain bounded descriptions; longer procedures belong in a skill.

Runtime-dynamic tool sources fit behind, not inside, the static registry. An MCP bridge contribution registers its own bounded surface — bridge tools, config namespace, events — at activation; the remote tools a connected server exposes are runtime data behind that surface, validated on every connect and change, classified and approval-gated like any external capability, and never merged into the immutable activation view. Registered definitions describe code the distribution ships; dynamic discovery stays inside the owning contribution's boundary.

### RPC and web contracts

Preserve the existing `ApiContract` shape — today method, request schema, response schema, and gateway scopes — plus the deterministic generator, generated browser artifact, and bidirectional parity gates; do not create a parallel RPC contract model. First extend the current definitions with owner, allowed origins or audiences, required agent capabilities where applicable, side-effect classification, and a separately bound handler.

As RPC-owning contributions are extracted, their inert public contract catalogs move with them. The full-distribution codegen entry point composes base host contracts and the explicitly linked contribution catalogs through the same registration validation used at runtime. At that cutover, the full `API_CONTRACTS_ORDERED` aggregate moves out of core; core retains only the generic `ApiContract` type, validation, and base runtime contracts. All generator, daemon, CLI/MCP policy, and architecture-test consumers retarget in the same change, and the old aggregate is deleted. Core never imports a contribution package, and there is never an old and new authoritative aggregate in production simultaneously.

Build-time generation sees every contribution linked into the full repository distribution. Runtime activation publishes handlers only for enabled instances. A contribution package exposes its inert `./contracts` subpath without importing or initializing its SDK adapter modules.

Raw string dispatch remains private to gateway framing. The generator produces the JSON-schema artifact already consumed by the browser plus method-keyed parameter and result mappings for each supported audience. The browser artifact stays dependency-free and imports neither Zod, core, nor Node modules. Existing bidirectional handler-contract parity tests remain authoritative and are extended to cover ownership, audience, inert contract subpaths, and active-handler binding; a second parity mechanism would create two sources of truth.

The web client becomes method-keyed:

```ts
export interface WebRpcMethodMap {
  "agents.list": RpcMethod<AgentsListParams, AgentsListResult>;
  "channels.list": RpcMethod<ChannelsListParams, ChannelsListResult>;
  // generated web-exposed entries
}

export interface RpcClient {
  call<M extends keyof WebRpcMethodMap>(
    method: M,
    params: WebRpcMethodMap[M]["params"],
  ): Promise<WebRpcMethodMap[M]["result"]>;
}
```

Methods without parameters use a canonical empty-object input so overloads remain simple. Tests must fail compilation for an unknown or wrong-audience method and fail runtime contract validation for malformed responses. The polling controller regression is fixed by changing production and test literals to `agents.list` and `channels.list`; generated typing then prevents recurrence, and the polling path stops swallowing its failures — a failed poll surfaces through the standard logging and health path instead of an empty catch. CLI-, MCP-, and host-maintenance-only methods stay out of the web method map even though they use the same authoritative definitions.

The method map is audience-prefixed because the gateway already owns a server-side `RpcMethodMap`; each audience map is generated beside its client, and the CLI client adopts its audience map the same way. The web client's existing name-only typed helper is replaced by the generated map rather than kept as a third calling convention. Existing gateway scopes remain authorization metadata; the new audience field is a separate dimension, and the `mcp-client` scope stops doing double duty as an audience marker.

The base host owns only runtime-wide methods such as health, installed contribution inventory, and safe configuration inspection. Channel, provider, scheduler, memory-maintenance, media, and observability RPC namespaces live with their owning contributions.

### Events

Core's `EventMap` today closes over media, scheduler, provider, and observability vocabularies; those namespaces move to their owning contributions, and core retains a compact base map for universal lifecycle and security events. Contributions register namespaced event schemas and emit through a validating event port.

```ts
export interface EventDefinition<TPayload> {
  readonly name: string;
  readonly payloadSchema: z.ZodType<TPayload>;
  readonly sensitivity: "content-free" | "bounded-content";
}
```

Registration records the owning contribution and grants it an owner-scoped emitter that cannot spell another namespace. Runtime dispatch validates every payload and emits a generic validated envelope to dynamic observers. Built-in TypeScript consumers receive generated known-event types, while external contributions remain runtime-validated. A contribution event cannot masquerade as a core event or publish unbounded message content. Observability bridges subscribe through definitions instead of importing a product-wide closed union into core. The gateway's server-sent-events endpoint, the activity buffer, and WebSocket notification push are the same kind of dynamic observer: they consume validated envelopes, and everything they stream is covered by the registered sensitivity classification.

### Configuration

Split configuration into:

- a small kernel schema for data directory, security, runtime limits, contribution selection, and generic execution policy;
- registered contribution namespaces with definition schemas, instance-map schemas, defaults, immutable keys, UI metadata, and secret-reference declarations;
- per-agent selection of installed capabilities by opaque IDs.

Config assembly registers every linked namespace before parsing, then validates contribution selection, instance references, and dependencies before activation. Unknown namespaces, missing linked contributions, duplicate instance IDs, or invalid defaults return configuration errors at startup. Schema defaults are applied once. Semantic tri-state settings use an explicit schema union such as `"auto" | "on" | "off"`; they do not preserve pre-Zod raw values in a side map. Runtime consumers accept resolved active types without `??` semantic fallbacks.

Contribution namespaces register through the kernel's existing consolidated section registry — the one source that already derives the serializer schemas, field metadata, and managed-section redirects — rather than introducing a second section-truth mechanism. Runtime configuration writes keep their current in-memory semantics; keys that select contribution instances or activation topology are immutable at runtime, and changing them takes effect only through a restart with a fresh activation transaction. Those keys join the immutable-key set, and every runtime mutation surface — including administrative management tools — enforces that set through one shared path; documentation alone is not enforcement.

The config editor and generated reference read from the same registry metadata. A contribution cannot redirect config changes to a tool unless that tool is registered by the same contribution and its schema is available.

## Prompt and context redesign

### One turn-preparation contract

The inbound coordinator resolves one immutable preparation snapshot before execution:

```ts
export interface PreparedTurn {
  readonly scope: ResolvedTurnScope;
  readonly workspacePolicy: WorkspacePolicySnapshot;
  readonly capabilities: ActiveCapabilitySnapshot;
  readonly locale: ResolvedLocale;
  readonly conversation: AssembledConversationWindow;
  readonly recall: RecallContext;
  readonly selectedSkills: readonly SkillSection[];
  readonly externalInstructions: readonly ExternalContextSection[];
}
```

Preparation loads the workspace snapshot once, captures one immutable active-capability inventory, resolves locale, asks the canonical conversation assembler for the lossless-store window plus the attributed current request, and asks one recall selector for the scoped memory lanes. The final `ModelRequestAssembler` combines the compiled policy/runtime sections, the assembled conversation, and the recall context into the provider-neutral request. The current request appears only in the conversation output. No later stage rereads workspace files, reselects memories, snapshots a different tool set, or parses generated prose.

The ownership split is strict:

- the conversation assembler owns stored-message selection, compaction, ordering, and tool-pair integrity;
- the recall selector owns volatile memory retrieval, lane fusion, provenance, and recall budgets;
- the prompt compiler owns trusted policy, bounded instructions, runtime-state sections, and their stable order;
- the model-request assembler combines those typed outputs exactly once and performs no selection of its own.

Failures return `Result` at the preparation boundary. A missing durable store, workspace snapshot, authority scope, or required capability view is not a reason to fall through to an older assembler or a partial prompt.

### Typed prompt compilation

Preserve the trust hierarchy in the architecture guide and split prompt production by source:

```ts
export interface PromptCompilationInput {
  readonly enginePolicy: EnginePolicySection;
  readonly workspacePolicy: WorkspacePolicySnapshot;
  readonly runtimeState: RuntimeStateSection;
  readonly capabilities: CapabilitySection;
  readonly selectedSkills: readonly SkillSection[];
  readonly externalInstructions: readonly ExternalContextSection[];
}
```

Each section producer returns a typed section or `Result` and owns its budget. The compiler owns order, delimiters, omission, stable hashing, and the content-free compile report. Section producers do not append directly to a shared string.

Required implementation rules:

- the engine policy contains only universal trust and execution invariants;
- workspace policy is loaded once at turn start and no prompt consumer rereads files;
- runtime state carries locale, trust, compaction, and execution mode structurally; selected skills and available tools come from their dedicated typed fields;
- MCP or server instructions are individually bounded, attributed, hashed, and wrapped as external content;
- tool availability comes from the registered tool set, never prompt prose;
- unchanged workspace starters remain absent;
- the stable engine section and the minimal safe prompt stay within the token budgets the architecture guide sets, measured by the repository token-estimation method; the engine budget keeps its asserting test and the minimal budget gains one;
- truncation never drops security invariants;
- diagnostics contain section identity, source, trust, size, hash, budget, and inclusion outcome, never content;
- no module parses `USER.md`, prompt headings, XML blocks, or generated prose to recover control state.

Split `prompt-assembly.ts` into cohesive section producers and a small compiler. The file-size gate applies to every resulting production file without a new allowlist entry.

### One context assembler

Use `ContextStorePort` as the lossless conversation store and retain one context assembler that produces the conversation portion of the model-visible window. The DAG implementation becomes the canonical algorithm only after its parity tests cover all required behaviors currently owned elsewhere.

Remove the mode selector and silent pipeline fallback. A deployment without durable context uses an explicit in-memory `ContextStorePort`; a missing store is a startup precondition failure. The same assembler handles:

- fresh tail retention;
- tool call/result pairing;
- security-pinned messages;
- compaction and summaries;
- token budgets and minimum visible output;
- cache-aware stable prefixes;
- sub-agent and execution-graph context;
- diagnostics and deterministic replay.

Before deleting the alternate path, a parity suite runs the same scenario corpus through the canonical assembler and proves ordering, pin retention, tool pairing, budget bounds, cache stability, failure behavior, and content-free telemetry. After cutover, no production file branches on `contextEngine.version`, and comments and docs describe only the current assembler.

### Locale as structured runtime state

Locale resolution remains provider- and domain-neutral. It uses a documented precedence of explicit user preference, validated channel locale metadata, recent high-confidence language evidence, and deployment default. Each result records source and confidence. A free-form language tag is validated and normalized according to the repository locale policy; core never contains a closed list of human languages or a preferred language.

`ResolvedLocale` is the per-turn resolution result produced under the existing open `ResponseLocalePolicy` domain type: the policy type remains the normative locale contract, and the resolved object carries its outcome plus source and confidence. Deterministic runtime replies such as approvals, denials, help, validation failures, and degraded-mode notices consume `ResolvedLocale` through one localization port. Model-facing locale guidance is generated from that same object. No component infers locale by parsing `USER.md`, a prior assistant reply, or a prompt heading.

### Outcome evaluation

Preserve the generic outcome-evaluation contract already represented by the outcome judge: rubric, evidence references, judge model, policy hash, rubric hash, confidence, and reason codes remain structured and auditable. Extract judge-model resolution — today it calls the external provider catalog and hand-builds an SDK-specific fallback model spec inside the evaluator layer — behind the model-provider boundary.

Evaluation receives the exact `WorkspacePolicySnapshot` used to prepare the turn, not merely a hash that may or may not resolve later. When a durable replay or asynchronous evaluator has only a hash and the matching snapshot cannot be loaded, the result is `unknown` with a closed reason code. It must never judge against a smaller or current policy snapshot. Durable and asynchronous evaluation therefore persists the exact snapshot, content-addressed by its hash, whenever evaluation can outlive the in-memory turn; the `unknown` verdict covers genuine loss, not a designed-in inability to resolve any snapshot. Missing required evidence similarly produces `unknown`; absence is not success.

The base rubric measures universal completion properties such as terminal-state truthfulness, required evidence presence, unresolved approvals, and tool-error handling. Deployment criteria come only from the immutable workspace snapshot, and task procedures may contribute bounded checklist evidence without gaining authority. Code-enforced confidence caps continue to dominate model self-confidence. Outcome evaluation remains separate from system health: a healthy runtime can fail a task, and a degraded runtime can still produce an honestly incomplete outcome.

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
| `@comis/infra` | Dependency-light runtime adapters for core logging, clock, environment, and timer contracts. No observability implementation, and the optional certificate-authority adapter family moves to a separately installable contribution. |
| `@comis/channels` | Shared channel contracts and lightweight adapter utilities during extraction; concrete SDK-backed channel contributions become independently installable packages. |
| `@comis/skills` | Dependency-light skill discovery, manifest validation, and prompt-skill loading. Tool enforcement remains in the agent kernel; MCP, browser, media, terminal, and other SDK-backed tool packs are contributions outside this package. |
| `@comis/memory` | Scoped SQLite storage contributions implementing context, session, memory, credential, delivery, and diagnostics storage ports. Embedding providers and local-model runtimes are separate contributions. |
| `@comis/scheduler` | Scheduler contribution and generic scheduler ports; no default business schedules. |
| `@comis/observability` | Content-free diagnostics contribution consuming event and telemetry ports. |
| `@comis/observability-otel` | Optional exporter contribution loaded only when configured. |
| `@comis/gateway` | Generic transport, authentication, JSON-RPC framing, WebSocket, and HTTP boundaries. Method ownership comes from registered definitions. |
| `@comis/runtime` | Dependency-light headless host entry. It supplies an explicit contribution set to core bootstrap and contains no full-distribution imports or integration SDK dependencies. |
| `@comis/daemon` | Full-distribution host entry. It supplies the built-in linked set to core bootstrap but contains no concrete channel/provider construction branches. |
| `@comis/web` | Browser UI using generated RPC contracts and browser-local runtime adapters. It does not import server runtime implementations. |
| `@comis/cli` | Operator command-line client over the generated control-plane contracts plus offline diagnostics readers. No channel, provider, or media SDK imports. |
| `comisai` (`packages/comis`) | Full operator distribution and namespace exports; no longer the only practical way to consume the runtime. |

Add `@comis/runtime` as a separate package. The headless acceptance application is its concrete caller. A dependency-light export inside `@comis/daemon` is insufficient because package managers install the daemon's complete declared dependency closure even when a heavy subpath is never imported. Dynamic import provides module-load and startup isolation only; it does not provide install isolation.

Contribution code with a heavy or unrelated SDK dependency must be independently installable. Channel, provider, browser, media, model-local, and exporter families may require one package per contribution or another measured split; keeping them behind dynamic imports in a monolithic package does not satisfy the headless install budget. Package moves follow working vertical contracts and preserve public-export discipline rather than creating empty shells.

Required dependency changes:

- orchestrator consumes an `AgentRuntimePort` and channel/delivery ports from core rather than importing implementations;
- agent emits telemetry through core contracts rather than depending on `@comis/observability`, receives scheduling behavior through core ports — replacing the declared scheduler dependency that production wiring already satisfies by callback injection — and removes provider/media SDKs and provider catalogs from its dependency closure;
- skills build tools against core tool contracts rather than importing agent types;
- core removes the concrete `pi-ai` provider dependency and provider-family/catalog knowledge;
- skills moves browser, media, speech, terminal, and SDK-backed tool dependencies into their owning contribution packages;
- memory moves OpenAI, local-model, and embedding-provider dependencies into provider contributions;
- infra and memory implement core ports without importing the observability implementation, and the optional certificate-authority adapter family leaves the headless infra closure;
- observability-otel consumes core telemetry and cache-stat contracts and drops its declared-but-unused memory dependency;
- web consumes generated contract artifacts without importing Node runtime helpers;
- the runtime package depends only on the provider-neutral kernel path; daemon and the `comis` distribution are the only packages allowed to import the full built-in contribution set.

Update the exact package-graph architecture test with the target edges in the same dependency-removal changes, and extend its exact set to every workspace package — the observability, exporter, web, and umbrella packages sit outside it today. Do not loosen it to a partial deny list.

## Delivery workstreams

```text
Immediate correctness work
(scope authority + typed web RPC)
              |
              v
Contribution registry foundation
              |
              v
Vertical contribution proofs
              |
     +--------+-----------------------------------+
     |                                            |
     v                                            v
Built-in replacement                 Turn preparation, prompt, and
Config, event, and                   context consolidation
control-plane registration           Locale and outcome correctness
     |                                            |
     +--------+-----------------------------------+
              |
              v
Optional strategy extraction
              |
              v
Distribution split
              |
              v
Removal and enforcement
```

After vertical proofs, two tracks proceed in parallel: converting the built-in integrations together with their control surfaces, and consolidating the execution path together with its locale and outcome consumers. The distribution split waits for both because the headless package boundary is only real once heavy integrations and optional strategies have left the kernel path.

Each workstream is a theme delivered as a sequence of concern-sized changes, each following Red → Green → Refactor. A test-only RED commit is preferred when it compiles against the current code. Pure documentation updates remain in the same behavior change that they describe.

### Immediate correctness work

Outcome: eliminate known authority and RPC mismatches before adding extension flexibility.

Implementation:

- add a web regression test that expects `agents.list` and `channels.list` against the real generated contract list;
- type `RpcClient.call()` from generated method definitions and remove response casts at polling call sites;
- introduce endpoint, principal, `ConversationScope`, and the routing-policy resolver; replace formatted session authority across session, context, approval, delivery, and cross-session APIs;
- update SQLite uniqueness and predicates to include required tenant and agent scope;
- introduce explicit memory visibility and pre-scoped FTS/vector queries;
- update all call sites in the same changes; do not retain optional `agentId` overloads;
- land the web RPC typing independently of the scope-authority work, and migrate scope store-by-store — each store family, its callers, and its tests move in one concern-sized change.

Acceptance:

- invalid and wrong-audience RPC literals fail TypeScript compilation;
- a failed web poll is observable through logs and health surfaces rather than silently caught;
- two agents sharing every other conversation coordinate cannot read, overwrite, list, approve, or delete each other's session data in one real store;
- two principals intentionally share a shared conversation partition and remain isolated under a principal partition;
- identical platform subject and conversation strings on two configured channel instances remain isolated unless typed principal mapping and routing policy explicitly join them;
- out-of-scope high-ranking memory rows cannot reduce in-scope recall;
- no production storage method infers tenant or agent from defaults.

### Contribution registry foundation

Outcome: establish a small registration and lifecycle kernel with no concrete integrations.

Implementation:

- add contribution manifest, transactional definition registration, definition/instance inventory, dependency graph, activation report, atomic active-view publication, and shutdown handles;
- scope each subregistry to the registering contribution;
- expose installed contribution and surface inventory for diagnostics;
- use the existing hook registry as the lifecycle-hook subregistry, convert its direct plugin callers in concern-sized changes, and add no compatibility adapter;
- keep the explicit linked contribution list in daemon composition.

Acceptance:

- duplicate IDs, duplicate surfaces, namespace violations, undeclared surfaces, missing requirements, and cycles return typed errors;
- activation uses stable topological order and shutdown uses its reverse, tested with fake clocks/timers and abort signals;
- a structural activation failure publishes no view and reports cleanup failures after attempting all cleanup; a leaf instance's runtime start failure yields a published failed-instance state without aborting unrelated instances;
- registration receives no network, filesystem, timer, environment, or secret authority, and architecture tests enforce those import boundaries;
- the registry has no knowledge of concrete channel, provider, or domain names.

### Vertical contribution proofs

Outcome: prove the abstraction with real behavior before broad conversion.

Implementation:

- convert Echo into a channel contribution covering instance config, factory, lifecycle, health, events, and message flow;
- convert one networked channel to cover credentials, retry, delivery, media, and shutdown;
- extract the OpenAI-compatible model protocol into a provider contribution;
- convert one read-only tool pack and one capability-gated side-effecting tool;
- register one contribution-owned RPC namespace and generate its web client types.

Acceptance:

- the converted features have end-to-end parity through the real daemon harness;
- two instances of one channel definition and two instances of one provider definition have isolated credentials, endpoints, health, routing, metrics, and shutdown;
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

### Turn preparation, prompt, and context consolidation

Outcome: one immutable turn-preparation result, one typed prompt compiler, and one deterministic context assembler.

Implementation:

- introduce one `PreparedTurn`, typed prompt sections, a scoped recall selector, independent section producers, and the final model-request assembler;
- preserve the immutable workspace snapshot and compile-report hashes;
- pass locale, trust, skills, tools, and compaction state structurally;
- complete canonical context parity tests;
- wire durable and in-memory context stores through the same port;
- delete alternate assembly branches, direct workspace rereads, and prompt-heading state recovery.

Acceptance:

- prompt output is deterministic for identical typed input;
- workspace policy, capability inventory, conversation selection, and memory recall are each resolved exactly once per turn;
- security and operator policy are never truncated;
- engine and minimal-safe prompt token budgets stay below their documented limits;
- unchanged workspace starters add no tokens;
- no control state is recovered from Markdown or XML text;
- no production context mode selector or silent fallback remains;
- every prompt section producer and compiler file stays within the file-size gate.

### Config, event, and control-plane registration

Outcome: product-shaped control surfaces live with their owning contributions.

Implementation:

- reduce the kernel config schema and register contribution definition and instance-map namespaces;
- produce UI field metadata, immutable keys, and config reference data from the same definitions;
- separate base runtime events from contribution schemas;
- register RPC namespaces with their authorization metadata;
- extend the current contract definitions and generator to produce daemon dispatch types, audience-specific client maps, browser schemas, and documentation inputs, then move the full aggregate to the full-distribution catalog as contribution contracts leave core;
- remove call-site semantic defaults after schema resolution.

Acceptance:

- config has one default source per field;
- semantic auto-detection is represented by a schema discriminator, never a raw pre-parse side channel;
- disabling a contribution removes its namespace from active runtime config and its active UI capability inventory while retaining installable config metadata; removing it from the distribution removes the namespace entirely;
- daemon handlers cannot register without input/output schemas and authorization metadata;
- every generated audience method has a registered server handler, and each active handler has an authoritative contract with explicit audience and authorization metadata;
- contribution events validate at emission and cannot collide with base events.

### Locale and outcome correctness

Outcome: deterministic runtime replies and completion judgments consume the same immutable turn state as execution.

Implementation:

- introduce `ResolvedLocale` provenance and route deterministic approval, denial, help, and error text through one localization port;
- remove locale recovery from workspace prose or prior messages;
- pass the exact workspace-policy snapshot and evidence set into outcome evaluation;
- move judge-provider resolution behind the model-provider port;
- preserve structured rubric, evidence, hashes, reason codes, and code-enforced confidence caps.

Acceptance:

- locale precedence is deterministic and does not encode a fixed language list or default language in core;
- deterministic and model-facing locale behavior derive from the same resolved object;
- a missing policy snapshot, missing required evidence, unavailable judge, or malformed judge result produces `unknown`, never success and never evaluation against current policy;
- outcome status and system health remain separately reported and tested.

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

- create the separate `@comis/runtime` package with explicit contribution injection;
- add every new runtime or contribution package to workspace, TypeScript project-reference, build-image, public-export, license, and package-graph inventories in the same change;
- keep CLI, web, all channels, media, browser, and exporters in the full distribution;
- split heavy contribution dependencies into independently installable package closures and dynamically import selected full-distribution contributions only after config resolution;
- expose inert definition and contract subpaths that do not import the contribution's SDK entry point;
- ensure package exports expose public contracts without internal cross-package paths;
- measure install size, startup imports, and cold-start time before and after each dependency move.

Acceptance:

- a headless test application can run an in-memory conversation with a test provider and Echo channel without installing unrelated integration SDKs;
- the packed headless test application's dependency tree contains no channel, media, browser, local-model, cloud-provider, or exporter SDK that it did not explicitly select;
- importing core or the runtime entry point does not load those modules;
- importing the full linked definition catalog does not load SDK adapter modules for disabled contributions;
- full distribution behavior remains covered by daemon integration tests;
- dependency-cycle, workspace/build-image parity, and public-export tests pass.

### Removal and enforcement

Outcome: the redesigned architecture is the only production path.

Delete only after callers and parity tests are complete:

- optional-agent session identity and formatted-string authority;
- post-ranking scope filters;
- static platform tool registries and the shared channel registry with its read-only production wrapper;
- concrete daemon channel/provider construction branches;
- direct plugin construction paths after their callers register through contributions;
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

- platform-principal mapping, conversation scope parse/refinement, canonical-ref encoding injectivity against adversarial near-miss scopes, routing-policy mapping, and storage predicate behavior;
- session/context store multi-agent isolation plus shared-versus-principal partition behavior in one database;
- memory visibility, derived-index authority copying, and pre-ranking scope;
- contribution transactional registration, definition/instance identity, stable dependency ordering, container state transitions, atomic publication, activation cleanup, and shutdown;
- channel, provider, tool, RPC, config, event, and health definition validation;
- prompt section budgeting and deterministic compilation;
- context assembler parity and failure behavior;
- locale precedence and deterministic-message localization;
- outcome evaluation with the exact policy snapshot and fail-unknown branches;
- headless runtime import and packed-install boundaries.

### Integration tests

Use real composition where wiring is the contract:

- daemon boot with a minimal explicit contribution set;
- daemon boot with the full built-in set;
- unknown or missing contribution failure;
- two configured instances of one channel and one provider definition;
- Echo inbound request through routing, execution, context persistence, and delivery;
- shared SQLite session and memory isolation;
- generated RPC client against the real dispatch registry;
- contribution activation failure followed by clean shutdown;
- shutdown racing an in-progress activation without leaked handles or a published partial view;
- real workspace layout and immutable policy snapshot through prompt compilation;
- policy-snapshot hash miss during asynchronous outcome evaluation;
- exporter absent/present import checks;
- a packed headless fixture installed in an empty temporary project with its dependency closure inspected.

Integration tests that inspect on-disk context or session layout must build the actual nested layout and call the real resolver, consistent with the repository's filesystem-layout testing rule.

### Architecture gates

Add focused tests instead of broad text deny lists where possible:

- `@comis/core` and `@comis/agent` cannot depend on channel or provider SDK packages;
- `@comis/orchestrator` cannot import concrete agent or channel implementations;
- `@comis/skills` cannot import agent implementation modules;
- the exact target package graph excludes agent-to-observability/scheduler, infra/memory-to-observability, and observability-otel-to-memory implementation edges;
- composition-root tests allow value imports of core `bootstrap` only from the daemon and headless runtime entry modules, and both supply factories without duplicating kernel wiring;
- registration modules cannot import network, filesystem, timer, environment, or secret adapters;
- daemon channel/provider setup cannot compare concrete IDs outside contribution packages;
- all session and memory storage operations require typed scope;
- FTS and vector statement-shape or query-plan tests prove scope is applied before ranking and limiting;
- web RPC literals are constrained to the generated method map;
- RPC generation uses the single composed full-distribution catalog, preserves the existing bidirectional handler parity, and excludes non-web audiences from the browser map;
- prompt assembly cannot parse headings for runtime state;
- production source cannot branch on a context implementation selector;
- generic-runtime scanning includes `AGENTS.md` and covers structural specialization regressions, not only selected words;
- architecture documentation and `test/architecture/file-size.test.ts` agree on one enforced maximum — today the test enforces 1,000 lines while its own description and the engineering protocol still state 800; the redesign picks one value and aligns the gate constant, its description, and the protocol text in the same change;
- the packed `@comis/runtime` dependency tree stays within a recorded install-size budget and excludes the full-distribution SDK deny set;
- shrink-only allowlists lose entries as oversized files, raw throws, optional dependency clusters, globals, and coverage gaps are repaired.

Do not add a new allowlist entry to land redesign work. If a new contract makes a file too large or a dependency object too broad, split the responsibility before merging.

## Security requirements

The contribution system increases composition flexibility, not authority.

- Only the composition root links executable contribution factories; this is trusted in-process code, not a plugin sandbox.
- Registration receives no secret manager, network client, filesystem handle, timer, process environment, or live adapter, and commits definitions transactionally.
- Activation receives surface-specific least-authority ports and an owner-scoped credential resolver limited to the secret references declared by that configured instance.
- Tool execution always enters the existing capability, action-classification, approval, audit, timeout, cancellation, and output-guard pipeline.
- Contribution config stores secret references, never resolved values.
- Platform secrets remain unavailable to user-facing secret-ref tools.
- RPC definitions declare allowed origin or audience, gateway scopes, side-effect class, and in-process agent capability when applicable; unlisted origins are denied.
- External instructions are bounded, attributed, hashed, wrapped, and non-authoritative.
- Health and lifecycle events are content-free.
- Unknown contribution, provider, tool, event, or RPC names fail closed.
- A structural activation failure publishes no active view; a runtime instance failure appears only as an explicit failed-instance state, never as a silently narrowed capability set, and never drops a security control.
- Dynamic external module loading is prohibited until separately designed and approved.

Threat-focused tests cover namespace collision, duplicate registration, partial-registration rollback, undeclared surface registration, dependency confusion, cross-instance identity or credential access, unauthorized memory-visibility widening, capability, side-effect, or output-trust downgrades, secret access during registration, malicious external instructions, wrong-origin RPC calls, malformed event payloads, partial activation, cleanup failure, and shutdown after failure.

## Observability requirements

Every contribution lifecycle and boundary operation must be reconstructable from logs and events.

Required content-free fields include:

- `contributionId`, `contributionVersion`, definition ID, configured instance ID when applicable, and surface name;
- lifecycle state and dependency IDs;
- `traceId` from request context where applicable;
- opaque conversation reference plus non-sensitive tenant, agent, definition, and operator-assigned instance IDs; never message text or raw platform principal/conversation identifiers;
- `durationMs`, result kind, retry count, and bounded item counts;
- `errorKind` and operator-actionable `hint` for every WARN/ERROR;
- activation inventory hash for reproducible startup diagnostics.

The inventory hash covers contribution IDs and versions, registered definition IDs, enabled instance IDs, dependency order, and a digest of non-secret resolved activation settings. It never includes credential values, secret references, message content, or raw endpoint/principal identifiers.

The host emits base lifecycle events for registration complete, activation complete, activation failed, and shutdown complete. Contributions emit their own namespaced operational events through registered schemas. Logs describe the failure; events announce the state change.

Registration, activation, degraded-boot, and failed-instance findings also surface through the deployment-wide health report and incident-explanation surfaces, not only through raw lifecycle events; a degraded boot is diagnosable from one health call.

## Data and runtime cutover

The scope work creates one canonical persisted representation, and moving to it is a breaking migration for every existing deployment — live production data included, not only development databases. Implement only that representation. Existing deployment data is backed up or explicitly discarded by the operator before the new daemon starts; the runtime does not contain dual readers, aliases, optional-agent overloads, or fallback parsing. Any retention of prior data is a one-time offline transformation in that same window: where an existing row cannot supply a required authority field, the operator supplies an explicit mapping in the offline step or discards the row. The runtime never infers missing authority at read time.

Apply storage changes atomically with their callers:

1. stop writers and take a verified backup;
2. build the new schema, canonical scope contracts, and source-memory visibility columns;
3. update all writers, readers, list operations, deletes, checkpoints, approvals, and diagnostics;
4. rebuild FTS and vector derived indexes from the authoritative source rows so every derived row receives the new scope columns;
5. run shared-store isolation, derived-index authority, and real-layout tests;
6. start the daemon only after schema and contribution inventory preflight passes;
7. verify session, memory, prompt, and delivery behavior through the real daemon harness.

For contribution conversion, keep behavior parity at the user boundary but never keep two active construction paths. Convert one vertical, switch its composition to the registry, and delete its old branch in the same behavior change.

## Risks and controls

| Risk | Control |
|---|---|
| A generic registry becomes a new god object | Keep subregistries cohesive, require concrete callers, and prevent optional-method clusters. |
| Contribution metadata is mistaken for authority | Enforce capabilities and approvals in code after registration; metadata may only request stricter handling. |
| Linked code is mistaken for sandboxed code | Treat linked factories as trusted code, deprive registration of authority, enforce import boundaries, and defer resource access to scoped activation. |
| Dynamic registration weakens TypeScript guarantees | Validate with Zod at runtime and generate known built-in maps for compile-time consumers. |
| Activation order creates hidden coupling | Require explicit contribution dependencies, use a stable lexical tie-break for independent nodes, reject cycles, and record the resolved inventory hash. |
| One misconfigured account downs the whole host | Structural plan errors are fatal; a leaf instance's runtime start failure publishes an explicit failed-instance state with health findings and aborts nothing unrelated. |
| Definition and instance identity are conflated | Keep contribution, definition, and instance IDs distinct in config, routing, credentials, health, metrics, and shutdown. |
| Scope replacement loses or mixes data | Use one structured scope, real shared-store tests, verified backups, and no dual-read ambiguity. |
| Search remains vulnerable to noisy neighbors | Apply scope inside FTS/vector candidate queries and test with dominant out-of-scope corpora. |
| Prompt split changes ordering or cache behavior | Pin byte-stable fixtures, section hashes, budgets, and cache-prefix tests before extraction. |
| Context consolidation drops edge behavior | Require scenario parity for tool pairing, pins, summaries, budgets, cache, and sub-agents before deletion; test recall separately at the turn-preparation boundary. |
| Optional features remain accidentally always-on | Inventory config, timers, dependencies, prompt sections, and jobs per contribution; absence tests must prove zero residue. |
| Full distribution and headless runtime drift | Run the same kernel contract suites against both compositions. |
| A lazy export still installs heavy dependencies | Verify the packed runtime in an empty fixture and inspect its dependency closure in CI. |
| Generated RPC contracts drift from handlers | Generate from the single composed catalog and enforce bidirectional parity and audience filtering in CI. |
| Asynchronous outcome evaluation uses different policy | Pass the exact snapshot or return `unknown` when its hash cannot be resolved. |
| Architecture tests turn into permanent exception catalogs | Refuse new redesign allowlist entries and remove entries with each split. |

## Verification commands

During implementation, run the smallest relevant RED/GREEN test first, then the package and architecture gates. Before completion run:

```bash
pnpm validate
```

`pnpm validate` composes the documentation check, clean-room build, both cycle checks, the security lint, and per-package coverage; run its component commands individually only while iterating.

For changes touching specialization boundaries, prompts, workspace policy, locale, integrations, health surfaces, or the contribution kernel, also run:

```bash
pnpm vitest run test/architecture/generic-runtime-boundary.test.ts
```

Add focused commands to the corresponding workstream documentation when a new contract suite is introduced.

## Completion criteria

The redesign is complete only when all of the following are true:

- endpoint, authenticated principal, and selected `ConversationScope` partition are distinct, and the scope is the sole session authority with required tenant and agent identity;
- real shared-store tests prove agent isolation across sessions, context, approvals, delivery, and deletion plus intentional shared/principal partition behavior;
- memory scope and visibility are required and applied before candidate ranking;
- contribution definitions register transactionally, configured instances activate with least authority, and one immutable active view is published atomically — structural plan failures publish nothing, and runtime instance failures appear only as explicit failed-instance state;
- core `bootstrap()` remains the generic composition path, while daemon and runtime supply different factory sets to the same `AppContainer.start()` and shutdown lifecycle;
- the daemon constructs channels, providers, tools, RPC namespaces, config namespaces, events, health probes, and optional services through registered contributions and instance activators;
- core contains no concrete provider catalog, vendor default, channel construction, or domain workflow;
- agent and orchestrator depend on core ports rather than observability, channel, or agent implementations;
- the existing RPC definition generator produces audience-specific method-keyed clients and preserves server/client parity;
- turn preparation resolves scope, policy, capabilities, locale, conversation, and recall once; prompt compilation consumes typed sections and the same immutable workspace-policy snapshot;
- one context assembler serves durable and in-memory stores without a mode selector or silent fallback;
- deterministic runtime replies use resolved locale, and outcome evaluation fails to `unknown` without its exact policy or required evidence;
- optional executable strategies are contributions and instruction-only specialization is an opt-in skill;
- the separate `@comis/runtime` package runs a headless composition and its packed dependency closure contains no unrelated integration dependencies;
- obsolete static registries, branches, fallback paths, duplicated defaults, and allowlist entries are deleted;
- architecture, security, unit, integration, documentation, and full validation gates pass;
- an unrelated Comis deployment can use the runtime without inheriting any application's persona, business vocabulary, provider workflow, preferred human language, or task-specific procedure.

## Implementation review checklist

Use this checklist for every redesign change:

- Is the behavior a universal runtime mechanism with a concrete caller?
- If it is specialization, should it be workspace policy, a skill, MCP, or a contribution?
- Does any identity or store lookup omit tenant, agent, principal, selected conversation partition, or explicit visibility authority?
- Is scope enforced before ranking, limiting, mutation, or deletion?
- Does the kernel learn a concrete provider, channel, SDK, workflow, or domain name?
- Can removing the contribution remove all of its config, RPC, events, health, tools, timers, and dependencies without editing the execution loop?
- Are contribution, definition, and configured-instance identities distinct?
- Are registration and activation separated, transactional, deterministic, abortable, and least-authority?
- Does activation publish atomically and clean up every started handle after failure?
- Does this RPC change extend the existing definition/code-generation path with explicit audience and authorization metadata?
- Are workspace policy, capability inventory, conversation selection, recall, and locale each resolved once per turn?
- Does package-level verification prove install isolation rather than only lazy import behavior?
- Does every failure return `Result` and produce actionable, content-free diagnostics?
- Is the test RED on the pre-change code and grounded in real composition where wiring or filesystem layout is the contract?
- Did the change delete the replaced path and shrink any relevant exception list?
- Would a completely unrelated agent inherit an assumption from the diff?

If the last answer is yes, the change is not a kernel change. Move it to the appropriate extension boundary before completion.
