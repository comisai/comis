// SPDX-License-Identifier: Apache-2.0
/**
 * The uniform competitor-adapter layer — the single contract the one
 * head-to-head runner drives across every memory system it compares.
 *
 * WHAT THIS IS: a `CompetitorAdapter` interface (`run(tier, config) ->
 * AdapterResult`), a `skipWithDisclosure` helper, and skip-with-disclosure
 * SKELETON adapters for mem0 / zep / hindsight / mnemosyne. The `letta-fs-baseline`
 * adapter (the one that actually runs keyless at $0) lives in its sibling
 * `letta-fs-baseline-adapter.ts`.
 *
 * THE LOAD-BEARING INTEGRITY INVARIANT (the reason this layer exists at all): an
 * absent competitor system (no key / not installed / no sibling clone) degrades
 * GRACEFULLY to a skip — `{ ran:false, skipped:true, system, reason, disclosure }`
 * — a shape that carries NO score field. {@link AdapterResult} is a DISCRIMINATED
 * UNION whose `ran:false` arm has no `accuracy`/`overall`/`score`/`manifestRef`,
 * so it is structurally IMPOSSIBLE for an absent system to fabricate a number
 * (the anti-fabrication threat). The keyless CI
 * always hits the skip branch (no env, no install) — that IS the wiring proof; the
 * operator-costed run (keys + competitor installs + LLM spend) fills the real
 * numbers in a costed re-run, honestly deferred.
 *
 * SUPPLY-CHAIN HARD CONSTRAINT (CLAUDE.md "Supply-chain invariants" + AGENTS.md):
 * mem0 / zep / hindsight / mnemosyne (and any future competitor) are NEVER added to
 * any `packages/*\/package.json`. All deps are exact-pinned; `@comis/*` are
 * private:true + bundled. These skeletons import NOTHING from a competitor package
 * — they PROBE presence (an injectable predicate) and SKIP. Competitors are
 * operator/external installs (mem0/zep external; hindsight/mnemosyne are sibling
 * clones `../hindsight`, `../mnemosyne`). competitor-adapter.test.ts Test 5
 * statically reads every manifest and asserts no competitor specifier is present.
 *
 * GLOBALS DISCIPLINE (globals.test.ts forbids `process.env` in packages/*\/src):
 * the presence probe is an INJECTED predicate. Its default is `() => false` — the
 * keyless default always skips and this module reads ZERO environment variables.
 * The operator wires a real env/path probe at call time (in their own non-src
 * script or test, where `process.env` is permitted). This keeps the module pure
 * and lets a test drive both branches deterministically.
 *
 * ARCHITECTURE: imports NOTHING — no @comis/memory (the agent↛memory cut), no
 * competitor package. The live store + recall wiring lives ONLY in the gated
 * `.bench.test.ts` (the single cut escape).
 *
 * @module
 */

/**
 * The per-cell config the runner passes to an adapter for one (tier, system)
 * cell. Kept minimal + OPEN (an index signature) so a future cell can carry
 * extra tier-scoped knobs WITHOUT changing this contract — the runner and each
 * adapter agree on the keys they use; unknown keys are ignored by an adapter that
 * does not need them.
 */
export interface AdapterConfig {
  /** The benchmark tier this cell runs (e.g. "j1", "suite-04"). */
  readonly tier: string;
  /**
   * Optional per-cell haystack the letta-fs control dumps as its full-context
   * baseline. Declared so a caller passing the one structured key the
   * shipped control consumes gets compiler-checked, while the open extension point
   * below still admits future tier-scoped knobs. The adapter STILL re-validates
   * this at runtime via a total `coerceDocs` (the config can arrive from a
   * non-typed JS caller), so a wrong shape degrades to an empty haystack, never a
   * crash.
   */
  readonly docs?: ReadonlyArray<{ content: string; createdAt: number }>;
  /** Open extension point — extra per-cell, tier-scoped knobs (never a secret). */
  readonly [key: string]: unknown;
}

/**
 * The result of running ONE (tier, system) cell — a DISCRIMINATED UNION.
 *
 * The `ran:true` arm links the cell to its committed manifest (the number lives
 * in the manifest, read back from disk and asserted before it is ever quoted —
 * the honesty protocol). The `ran:false` arm is the skip-with-disclosure shape
 * and carries NO score field of any name — an absent system can never fabricate a
 * number. Code that consumes a result MUST narrow on `ran` before reading either
 * arm's fields (the compiler enforces it).
 */
export type AdapterResult =
  | {
      /** The cell ran a real, valid==0 measurement. */
      readonly ran: true;
      /** Which system produced this cell. */
      readonly system: string;
      /** True for the letta-fs-baseline control row — NEVER Comis's headline. */
      readonly isControl: boolean;
      /** The cell -> committed-manifest link (the number lives in the manifest). */
      readonly manifestRef: string;
      /**
       * The observed character length of the context the cell actually rendered.
       * This makes the cell's keyless work LOAD-BEARING: the letta-fs
       * control records the length of its full-dump formatted context here, so the
       * format call cannot be deleted as dead code without a behavioural change.
       * NOT a score — a digest of the work done. Absent on cells that render no
       * in-harness context (the real number lives in the committed manifest).
       */
      readonly contextChars?: number;
    }
  | {
      /** The cell was NOT run (system/keys absent) — this arm has NO score. */
      readonly ran: false;
      /** Always true on this arm (the explicit skip discriminant). */
      readonly skipped: true;
      /** Which system was absent. */
      readonly system: string;
      /** A short machine-ish reason (e.g. "mem0 not detected"). */
      readonly reason: string;
      /** An ACTIONABLE disclosure: the env var / install / clone path to enable this cell. */
      readonly disclosure: string;
    };

/**
 * The uniform adapter the single head-to-head runner drives across every system
 * it compares. One method, `run`, returns an {@link AdapterResult} — either a
 * ran-manifest link or a skip-with-disclosure. The runner never special-cases a
 * system; it iterates adapters and records each cell's result.
 */
export interface CompetitorAdapter {
  /** The system this adapter represents (e.g. "mem0", "letta-fs-baseline"). */
  readonly system: string;
  /** True only for a control adapter (letta-fs-baseline) — never Comis's headline. */
  readonly isControl?: boolean;
  /** Run ONE cell for `tier` under `config`; degrade to skip-with-disclosure if absent. */
  run(tier: string, config: AdapterConfig): Promise<AdapterResult>;
}

/**
 * Build the skip-with-disclosure result for an absent system. ALWAYS returns the
 * `ran:false` arm — NEVER a number. This is the single constructor for the
 * anti-fabrication shape; every skeleton adapter routes its absent path through
 * here so the invariant cannot be bypassed by a hand-built object.
 */
export function skipWithDisclosure(
  system: string,
  reason: string,
  disclosure: string,
): AdapterResult {
  return { ran: false, skipped: true, system, reason, disclosure };
}

/**
 * Options shared by every skeleton adapter. The ONLY behavioural knob is the
 * presence probe — an injectable predicate that reports whether the operator's
 * environment has this competitor system wired (keys + install/clone). Its
 * default is `() => false`, so the keyless default ALWAYS skips and this module
 * reads no environment. The operator passes a real probe (which may read
 * `process.env` / check a clone path) at call time from a non-src caller.
 */
export interface SkeletonAdapterOptions {
  /** Reports whether this competitor system is wired. Default: `() => false` (keyless skip). */
  readonly isPresent?: () => boolean;
}

/**
 * Shared skeleton body: a competitor adapter whose `run` PROBES presence and
 * either skips-with-disclosure (absent — the keyless default) or, when the
 * operator's probe reports the system present, STILL skips with a
 * "no runner wired here" disclosure (this layer has no costed runner — the real
 * run is the operator-costed pass). It NEVER fabricates a `ran:true` with a
 * number; the discriminated union makes that structurally impossible.
 */
function makeSkeletonAdapter(
  system: string,
  absentReason: string,
  absentDisclosure: string,
  presentDisclosure: string,
  options: SkeletonAdapterOptions,
): CompetitorAdapter {
  const isPresent = options.isPresent ?? (() => false);
  return {
    system,
    async run(_tier: string, _config: AdapterConfig): Promise<AdapterResult> {
      if (!isPresent()) {
        // Absent (the keyless CI path): skip-with-disclosure, never a number.
        return skipWithDisclosure(system, absentReason, absentDisclosure);
      }
      // Present per the operator's probe, but this skeleton has NO costed runner
      // wired (the actual mem0/zep/hindsight/mnemosyne run is the operator-costed
      // pass). Still a skip — the integrity invariant holds: no fabricated number.
      return skipWithDisclosure(
        system,
        `${system} detected but no costed runner is wired in this layer`,
        presentDisclosure,
      );
    },
  };
}

/**
 * mem0 skeleton. Absent by default → skip-with-disclosure naming the
 * env var AND the install. mem0 is an EXTERNAL package + a hosted key — NEVER a
 * Comis dependency (supply-chain invariant).
 */
export function createMem0Adapter(options: SkeletonAdapterOptions = {}): CompetitorAdapter {
  return makeSkeletonAdapter(
    "mem0",
    "mem0 not detected",
    "mem0 not detected; set MEM0_API_KEY and install the mem0ai package (an operator/external install — never a Comis dependency) to run this cell",
    "mem0 detected; run the operator-costed mem0 pass (keys + mem0ai install + LLM spend) to fill this cell",
    options,
  );
}

/**
 * zep skeleton. Absent by default → skip-with-disclosure naming the
 * env var / account. zep is an EXTERNAL service + SDK — NEVER a Comis dependency.
 */
export function createZepAdapter(options: SkeletonAdapterOptions = {}): CompetitorAdapter {
  return makeSkeletonAdapter(
    "zep",
    "zep not detected",
    "zep not detected; set ZEP_API_KEY and install the @getzep/zep-js SDK (an operator/external install — never a Comis dependency) to run this cell",
    "zep detected; run the operator-costed zep pass (keys + @getzep SDK + LLM spend) to fill this cell",
    options,
  );
}

/**
 * hindsight skeleton. Absent by default → skip-with-disclosure naming
 * the SIBLING-CLONE path. hindsight is a sibling clone (`../hindsight`) the
 * operator builds — NEVER a Comis dependency.
 */
export function createHindsightAdapter(options: SkeletonAdapterOptions = {}): CompetitorAdapter {
  return makeSkeletonAdapter(
    "hindsight",
    "hindsight not detected",
    "hindsight not detected; clone and build the sibling repo at ../hindsight (an operator/external checkout — never a Comis dependency) to run this cell",
    "hindsight detected at ../hindsight; run the operator-costed hindsight pass to fill this cell",
    options,
  );
}

/**
 * mnemosyne skeleton. Absent by default → skip-with-disclosure naming
 * the SIBLING-CLONE path. mnemosyne is a sibling clone (`../mnemosyne`) the
 * operator builds — NEVER a Comis dependency.
 */
export function createMnemosyneAdapter(options: SkeletonAdapterOptions = {}): CompetitorAdapter {
  return makeSkeletonAdapter(
    "mnemosyne",
    "mnemosyne not detected",
    "mnemosyne not detected; clone and build the sibling repo at ../mnemosyne (an operator/external checkout — never a Comis dependency) to run this cell",
    "mnemosyne detected at ../mnemosyne; run the operator-costed mnemosyne pass to fill this cell",
    options,
  );
}
