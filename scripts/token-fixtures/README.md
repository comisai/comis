# Token-fixture ground truth (TOK-02)

The measurement instrument for `design/multilingual-excellence.md` §4 TOK-02:
counts the ~180-string multilingual corpus (`corpus.mjs` — 9 scripts ×
>=20 strings: he/ar/ru/zh/ja/el/th/hi/en) against **>=2 real tokenizers** and
writes the result to `packages/core/src/text/__fixtures__/token-counts.json`.

That committed JSON is the durable deliverable: the offline conservativeness
suite (`packages/agent/src/safety/token-conservativeness.test.ts`, plan
179-05 — agent-side placement is a documented plan deviation in that file's
header) asserts `estimate >= worst measured tokenizer count` against it
forever; core's `token-factor.test.ts` is the unit pin suite. "Factors
asserted without measurement are the same failure class as the unverified
3.5" (`context-engine/constants.ts`'s own history).

**This script is operator-run, ONCE per leg.** It is wired into no
`package.json` script, no vitest project, and no workflow — CI and
`pnpm validate` never run it and never touch the network.

## The two legs

| Leg | Tokenizer | Needs |
|---|---|---|
| `qwen` | local llama.cpp (`node-llama-cpp@3.18.1`, resolved from the existing `packages/memory` pin — zero new dependencies) against a qwen-class GGUF — the served local-model family | `QWEN_GGUF_PATH` (local file; no network) |
| `anthropic` | the `count_tokens` HTTP endpoint (free; tier-1 100 RPM is ample at the built-in 700 ms spacing) | `ANTHROPIC_API_KEY` + `ANTHROPIC_COUNT_MODEL` |

Legs can run at different times / on different machines: the generator MERGES
into an existing `token-counts.json` by entry id, fills only the requested
leg, and recomputes `maxTokenCount` over the legs measured so far. An un-run
leg stays `null`. Carried-forward counts survive a merge ONLY while the
entry's text is unchanged — if you edit an entry's text in `corpus.mjs`, the
generator drops that entry's stale counts with a WARN and both legs must be
re-run for it (counts measured against old text never attach to new text).

## Run

```bash
cd scripts/token-fixtures
cp token-fixtures.env.example token-fixtures.env   # fill in; NEVER commit it (gitignored)
./run.sh --dry              # offline corpus audit (no key, no model, no network)
./run.sh --leg qwen         # local tokenizer leg only
./run.sh --leg anthropic    # count_tokens leg only
./run.sh                    # both legs
```

After a run, commit the updated
`packages/core/src/text/__fixtures__/token-counts.json`. If any committed
token factor is violated by the new measurements, lower the factor **in the
same commit** (the TOK-02 same-commit lowering rule, plan 179-05).

## Current fixture status — operator TODO

The committed fixture has the **qwen leg measured** (qwen3-coder:30b blob,
2026-06-12). The **Anthropic leg is pending an operator run** (no
`ANTHROPIC_API_KEY` was available when the fixture was generated):

```bash
cd scripts/token-fixtures
cp token-fixtures.env.example token-fixtures.env   # fill ANTHROPIC_API_KEY (+ QWEN_GGUF_PATH if re-running qwen)
./run.sh --leg anthropic
```

then commit the updated JSON (and apply the same-commit lowering rule if any
factor is violated). Until then, `anthropicTokens`/`anthropicModel` are `null`
and `maxTokenCount` equals the qwen measurement — consumers assert against the
worst MEASURED tokenizer, so the suite stays honest with one leg.

## Finding a GGUF (leg B)

Discover the blob behind a local Ollama model:

```bash
ollama show qwen3-coder:30b --modelfile | grep '^FROM'
```

Set `QWEN_GGUF_PATH` to that path. Notes:

- **qwen3.6 (`qwen35`-arch) blobs DO NOT load** in node-llama-cpp 3.18.1
  (`key qwen35.rope.dimension_sections has wrong array length; expected 4,
  got 3`). Use the `qwen3-coder:30b` blob — same Qwen BPE vocab family,
  verified loads + tokenizes 2026-06-12 — or download any small Qwen-family
  GGUF (~400 MB, e.g. a Qwen 0.5B instruct GGUF) as a fallback.
- The first `gpu: false` load compiles a CPU addon (~2 min); it is cached
  after that. Tokenization itself needs no GPU.
- Only the GGUF **basename** is recorded in the committed JSON (no absolute
  paths or usernames leave the machine).

## Key safety

- `token-fixtures.env` is gitignored (`.gitignore` in this directory) — real
  keys never enter the repo.
- The generator never prints `ANTHROPIC_API_KEY`; output is counts only.
- The corpus strings ARE committed (they are the test data) — neutral,
  non-personal content only; keep it that way when extending `corpus.mjs`.
