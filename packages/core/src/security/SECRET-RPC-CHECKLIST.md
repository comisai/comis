# Secret RPC Handler — Reviewer Checklist

**Scope:** `packages/daemon/src/rpc/secrets-handlers.ts` and any future handler that exposes plaintext secret values across the daemon control channel.

**Referenced from:** the leading comment of `packages/daemon/src/rpc/secrets-handlers.ts` (load-bearing: the architecture test asserts the reference exists).

Before merging any change to a secret RPC handler, verify EVERY box below.

## A. Authority & transport
- [ ] Method registered at scope `"admin"` in `packages/daemon/src/wiring/setup-gateway-rpc.ts`
- [ ] Handler body checks `params._trustLevel === "admin"` defensively (do not rely on registration alone)
- [ ] Method is reachable ONLY over the local daemon control channel (gateway mTLS-terminated localhost); never over an unauthenticated remote route

## B. Plaintext residency
- [ ] No module-level `let`/`const` binding named `/secret|decrypted|plaintext/i` whose initializer is a SecretStorePort/SecretManager/SecretsCrypto call
- [ ] No closure captured by `Promise.all([...])` references a `/secret|decrypted|plaintext/i` binding from an outer scope
- [ ] Plaintext value is the SOLE return-path output — it is never assigned to a `const audit = …`, never spread into a log payload, never JSON.stringified into an event body
- [ ] If the plaintext is split (e.g., for `secrets.import` bulk operation), each chunk's lifetime ends at the function-call return — no chunk escapes into a variable, closure, or buffer that survives the handler

## C. Output discipline
- [ ] Audit event metadata contains the secret NAME only — never `value`, `plaintext`, `decrypted`, or substrings of the value
- [ ] Logger calls at INFO/WARN/ERROR/FATAL contain the secret NAME only (do NOT rely on Pino redaction as the primary defense)
- [ ] Error messages on decrypt-failure name the secret but NOT the failed value (e.g., `"Decryption failed for ${name}"` — never `"Decryption failed: got '${suspectedValue}'"`)
- [ ] Validation failures on malformed input report the validation error but DO NOT echo the rejected payload's value field

## D. Architecture-test alignment
- [ ] `test/architecture/source-rules.test.ts`'s `checkSecretResidency` walker passes against this file (zero violations)
- [ ] `test/integration/secret-rpc-residency.test.ts`'s log-capture test passes: a 100-iteration `secrets.get` + final `secrets.list` produces no plaintext in stdout/stderr/audit-event stream
- [ ] The positive-control deliberate-leak fixture (gated on `COMIS_RESIDENCY_TEST_DELIBERATE_LEAK=1`) still asserts the test would CATCH a leak

## E. Failure-mode tests
- [ ] `daemon-down` path returns exit code 4 + remediation message; no plaintext in stderr
- [ ] `unauthorized` path (`_trustLevel !== "admin"`) returns error; no plaintext in stderr
- [ ] `malformed-name` path (name does not match `/^[A-Z][A-Z0-9_]*$/`) returns error; no plaintext in stderr
- [ ] `backend-decrypt-failure` path returns generic error; no plaintext in stderr OR error message

## F. Source-rule guards
- [ ] `disableRedaction: true` does NOT appear in production source outside `test/integration/secret-rpc-residency.test.ts` (architecture test enforces)
- [ ] No new admin-scope drift: every `/^secrets\./` method registered at `"admin"` (architecture test enforces)

## G. Documentation alignment
- [ ] `AGENTS.md` logging rules are consistent with this handler's logging shape
- [ ] CLI help text matches the pattern: `"Requires the comis daemon to be running."` on every store-backed secrets subcommand
