# Coding Conventions

**Analysis Date:** 2026-04-17

## Naming Patterns

**Files:**
- `kebab-case.ts` — All source files use kebab-case (e.g., `secret-manager.ts`, `typed-event-bus.ts`, `context-engine.ts`)
- Schema definition files: `schema-{entity-name}.ts` (e.g., `schema-agent-model.ts`, `schema-delivery-timing.ts`)
- Test files: Co-located with source, suffix `.test.ts` (e.g., `context.test.ts` alongside `context.ts`)
- Factory/builder files: `*-factory.ts`, `*-builder.ts`, `*-harness.ts` (e.g., `git-manager.ts` for factory functions)
- Port/interface definitions: Located in `ports/*.ts` or named `*-port.ts`

**Functions:**
- `camelCase` — All functions use camelCase: `getContext()`, `tryGetContext()`, `runWithContext()`, `createSecretManager()`
- Factory functions: `createXxx()` pattern returning typed interfaces (e.g., `createSecretManager()` → `SecretManager`, `createLogger()` → Logger)
- Predicate functions: `isXxx()` or `hasXxx()` (e.g., `isReadOnlyTool()`, `hasProvider()`)
- Validators: `validateXxx()`, `checkXxx()` (e.g., `validatePartial()`, `checkApprovalsConfig()`)
- Private/internal helpers: `_clearRegistryForTest()` with leading underscore; ESLint configured to allow underscore-prefixed vars
- Intentionally unused parameters: `_isMinimal`, `_encoding` prefix (underscore marks intentionally unread params)

**Variables:**
- `camelCase` — All variables use camelCase
- Type narrowing variables: `msgHandler`, `skillHandler`, `chanHandler` (domain-specific suffixes for clarity)

**Types/Interfaces:**
- `PascalCase` — All types and interfaces (e.g., `SecretManager`, `RequestContext`, `CircuitBreaker`, `OutputGuardPort`)
- Schema types: `XxxSchema` (e.g., `BudgetConfigSchema`, `RequestContextSchema`, `DeliveryOriginSchema`)
- Inferred types from schemas: `type XxxConfig = z.infer<typeof XxxConfigSchema>` (e.g., `type UserTrustLevel = z.infer<typeof UserTrustLevelSchema>`)
- Event types: `XxxEvents` (e.g., `MessagingEvents`, `AgentEvents`, `ChannelEvents`)
- Domain types: Plain PascalCase without suffix (e.g., `AppConfig`, `ComisToolMetadata`, `RunHandle`)

**Constants:**
- `SCREAMING_SNAKE_CASE` — Constants use upper case with underscores (e.g., `DEFAULT_REDACT_PATHS`, `HEALTH_POLL_ATTEMPTS`, `MAX_STEPS`)

## Code Style

**Formatting:**
- No `.prettierrc` enforced — ESLint is the primary linter
- TypeScript strict mode enabled in all packages
- ES2023 target, NodeNext module resolution
- `"type": "module"` in all packages (ES modules only)

**Linting:**
- ESLint with `eslint.config.js` at project root (ESLint flat config)
- `typescript-eslint` for TypeScript rules
- `eslint-plugin-security` for security-focused lint rules

**Enforced Security Rules** (configured in `eslint.config.js`):
- Empty `.catch(() => {})` → must use `suppressError(promise, reason)` from `@comis/shared` (selector-based ban)
- Raw `path.join()` → must use `safePath()` from `@comis/core/security` (selector-based ban)
- Direct `process.env` access → must use `SecretManager` from `@comis/core/security` (selector-based ban)
- `Function()` constructor → equivalent to eval(), banned (selector-based ban)

**Underscore Convention:**
- ESLint configured to allow underscore-prefixed variables: `{ argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }`
- Used for intentionally unused parameters and internal helpers

## Import Organization

**Pattern:**
- Named imports preferred: `import { ok, err } from "@comis/shared"`
- Type imports explicitly marked: `import type { Result } from "@comis/shared"` or `import type { AppConfig } from "./config/types.js"`
- All imports use `.js` extension (required for Node.js ES modules)
- Relative imports within packages, explicit package names between packages

**Module Resolution:**
- Integration tests only use aliases (resolved via `test/vitest.config.ts`): `@comis/core` → `packages/core/dist/index.js`
- Source packages use direct relative imports
- Aliases resolve at test time (imports from `dist/` after build)

**Barrel Files:**
- Each package exports via `index.ts` re-exporting from subdirectories
- Path: `packages/*/src/index.ts` exports public APIs
- Import style: All packages export via `"main": "./dist/index.js"` and `"types": "./dist/index.d.ts"`

## Error Handling

**Result Type (Required):**
- All functions return `Result<T, E>` from `@comis/shared` — no thrown exceptions
- Discriminated union with `ok` discriminant for type narrowing

**Result Constructors:**
- `ok(value)` — Create successful result
- `err(error)` — Create failed result
- `fromPromise(promise)` — Wrap async operations
- `tryCatch(() => riskySync())` — Wrap synchronous code

**Error Suppression:**
- `suppressError(promise, reason)` from `@comis/shared` for intentional ignoring
- Banned: empty `.catch(() => {})` blocks (ESLint rule enforces this)

**Custom Error Types:**
- Domain errors inferred via Zod schemas (e.g., `ConfigError`, `ValidationError`)
- Error messages always include diagnostic hints (e.g., missing key names, context)

**Null Safety:**
- No implicit undefined — if optional, encode in return type (e.g., `Result<T | undefined, E>`)
- Use `tryGetContext()` for optional context access, `getContext()` when required (throws descriptive error)

## Comments

**Module Documentation:**
- Every file includes a JSDoc module block at the top: `/** @module */` describing file responsibilities
- Explain high-level purpose, domain boundaries, and interaction patterns
- @module tag for file-level documentation

**Complex Business Logic:**
- Explain the "why", not the "what"
- Trade-offs and performance rationale
- Security decisions (threat model, mitigation approach)
- Workarounds (why naive approach won't work, constraints)

**Function Documentation:**
- Always include docstring with purpose, parameters, return value
- Use `@param`, `@returns` tags for clarity on complex signatures
- Example: `@param config - RequestContext for async propagation`

**Complex Types/Interfaces:**
- Document intent and constraints
- Example: `/** User trust level for authorization decisions. This is SEPARATE from memory TrustLevel. */`

**Internal Helpers:**
- Mark intentionally unused parameters with underscore prefix: `function (_isMinimal: boolean): string[] { ... }`
- Comment why the parameter is needed but unused if not obvious

**Circular References (uncommon):**
- Comment: `// eslint-disable-next-line prefer-const -- circular reference: cleanup captures entry, entry contains cleanup`

## Function Design

**Size & Scope:**
- Prefer small, focused functions (< 50 lines typical)
- Extract internal helpers as separate functions when logic exceeds one concern
- Factory functions can be larger (100+ lines) if purely assembly

**Parameters:**
- Max 2-3 positional parameters typical
- > 2 related params: use options object for readability
- Destructuring for options: `function ({ agentId, allowPatterns, eventBus }: Options)`
- Unused parameters marked with `_` prefix: `function (_isMinimal: boolean) { ... }`

**Typing:**
- Always explicitly typed (no untyped `any`)
- Return typed interfaces, not concrete classes (e.g., `CircuitBreaker`, not `CircuitBreakerImpl`)
- Use `Result<T, E>` for functions that can fail

**Return Types:**
- Use `Result<T, E>` for fallible operations
- No implicit undefined — encode optionality in type (e.g., `Result<T | undefined, E>`)

## Module Design

**Exports:**
- Public API via `export` declarations at module level
- Type exports via `export type { TypeName }` for clarity
- Each package has `src/index.ts` re-exporting public APIs

**Internal Helpers:**
- Prefixed with `_` (e.g., `_clearRegistryForTest()`) or unmarked (not exported)
- Not part of public API surface

**Build Outputs:**
- `packages/*/dist/index.js` and `packages/*/dist/index.d.ts` (gitignored, built on CI)

**Architecture:**
- Hexagonal architecture: Core defines port interfaces in `packages/core/src/ports/`, other packages implement adapters
- Composition root: `core/src/bootstrap.ts` wires application (creates SecretManager → loads config → builds event bus, plugin registry, hook runner)
- No circular dependencies; strict acyclic module graph (enforced via `tsconfig.json` project references)

**Factory Pattern (Preferred):**
- Use factory functions returning typed interfaces (e.g., `createCircuitBreaker()` → `CircuitBreaker`)
- Factories often use injectable dependencies for testability (e.g., `createGitManager(deps: GitManagerDeps)`)
- Dependencies object pattern: `{ configDir, execGit, writeFile, removeDir, logger }`

**Async Local Storage Pattern:**
- `RequestContext` propagated via `AsyncLocalStorage<RequestContext>` (module-level singleton)
- Functions: `runWithContext(ctx, fn)` to run within context scope, `getContext()` to retrieve, `tryGetContext()` for optional access
- Context includes: `tenantId`, `userId`, `sessionKey`, `traceId`, `startedAt`, `trustLevel`, `channelType`, `deliveryOrigin`, `resolvedModel`

## Logging Conventions

**Framework:** Pino structured logging via `@comis/infra`

**Object-First Syntax:**
- Always use Pino object-first syntax: `logger.info({ agentId, durationMs, toolCalls: 3 }, "Execution complete")`
- First parameter is object, second is message

**Canonical Fields:**
- `agentId` — Agent-scoped operations
- `traceId` — Auto-injected via AsyncLocalStorage mixin
- `channelType` — Channel adapter logs
- `durationMs` — Any timed operation
- `toolName` — Tool execution
- `method` — RPC/HTTP method
- `err` — Error objects (not `error` — matches Pino serializer)
- `hint` — Actionable guidance (required on ERROR/WARN)
- `errorKind` — Error classification (required on ERROR/WARN)
- `module` — Set via `logLevelManager.getLogger("module")`

**Level Selection:**
- `ERROR` — Broken functionality (unbounded budget, always include `hint` + `errorKind`)
- `WARN` — Degraded but functional (unbounded budget, always include `hint` + `errorKind`)
- `INFO` — Boundary events only: request arrived, execution complete, component started/stopped (2-5 lines per request)
- `DEBUG` — Internal steps, individual tool/LLM calls, intermediate state (unbounded budget)
- `AUDIT` — Custom level for audit events (between INFO and WARN)

**Rule:** Once per request = INFO. N times per request = DEBUG. Aggregate count goes in the INFO summary line.

**Redaction:**
- Pino automatically redacts credential fields to 3 levels deep
- Redacted patterns: `apiKey`, `token`, `password`, `secret`, `authorization`, `botToken`, `privateKey`, `key`, `passphrase`, `connectionString`, `accessKey`, `cookie`, `webhookSecret`
- Nested patterns: `*.apiKey`, `*.*.token`, `*.*.*.password` (3 levels)
- Censor value: `[REDACTED]`

---

*Convention analysis: 2026-04-17*
