# Terminal-driver fixtures

This directory holds two fixture families:

1. **Golden-frame fixtures** — `spinner.*`,
   `altscreen.*`, `vim.*` — pin the `@xterm/addon-serialize` serialization.
2. **Classifier-corpus fixtures** — the
   per-CLI `<scenario>.stream.txt` streams that pin `terminal-classifier.ts` across
   `claude`/`codex`/`aider` × each state. See
   [The classifier corpus](#the-classifier-corpus) below.

---

# Golden-frame fixtures

These fixtures back `terminal-golden-frame.test.ts` — the **addon-serialize
churn guard**. `@xterm/addon-serialize` is pinned (`0.14.0`) but flagged
experimental, so a future bump could silently change the serialization. The
golden-frame test replays each committed `*.stream.txt` byte stream through a
fresh `createSessionEmulator` and asserts `snapshot({format:'ansi'}).screen`
equals the committed `*.golden.txt`. A serialization change — **or** a tampered
stream — surfaces loudly as a `serialize() !== golden` failure, never
silently.

The replay is **platform-independent**: `@xterm/headless` is pure-JS, so the same
bytes produce the same serialization on macOS and Linux. That is why the replay
test runs on macOS even for the VPS-recorded `vim` stream — the bytes are captured
on a real PTY (the VPS), but the golden assertion is host-independent.

## The fixtures

| Stream | Golden | What it is | Authored |
|--------|--------|------------|----------|
| `spinner.stream.txt` | `spinner.golden.txt` | A classic CLI spinner: a label + several `\r`-redrawn glyph frames (`\| / - \`) ending on a settled `Working done`. Printable + `\r` only. The final `\r`-frame is what renders. | **macOS** (synthetic, no PTY) |
| `altscreen.stream.txt` | `altscreen.golden.txt` | A synthetic alt-screen stream: `\x1b[?1049h` (enter alt) + clear/home + a boxed `EDITOR` banner via explicit cursor moves; STAYS in alt (no leave), so `snapshot().alt === true` at capture end. | **macOS** (synthetic, no PTY) |
| `vim.stream.txt` | `vim.golden.txt` | A real `vim -u NONE -N` session recorded on the VPS through a real PTY (a scripted `iHELLO` edit). The alt-screen full-screen TUI render. | **VPS** (`comisvps`, real PTY) |

The synthetic fixtures are small (~100–130 bytes), deterministic, and
human-reviewable in a diff. The `vim` fixture is recorded on the VPS (this repo's
macOS author box's node-pty cannot `posix_spawnp` in-harness) and committed (kept
to a few KB).

## Regenerating fixtures + goldens — `scripts/record-fixture.mjs`

The helper has three modes. All paths are resolved relative to the `scripts/` dir,
so `../fixtures/x` writes here. **Build skills first** (`pnpm build`) for `--golden`.

### 1. Author a synthetic fixture (no PTY — runs anywhere)

```bash
cd packages/skills/src/tools/builtin/terminal-driver/scripts
node record-fixture.mjs --synthetic spinner   --out ../fixtures/spinner.stream.txt
node record-fixture.mjs --synthetic altscreen --out ../fixtures/altscreen.stream.txt
```

The synthetic byte strings are literal constants in `record-fixture.mjs` — edit
them there (never hand-type raw escapes into the `.txt`) so the fixtures stay
regenerable + reviewable.

### 2. Record a real TUI stream (VPS only — needs node-pty + a real PTY)

```bash
cd packages/skills/src/tools/builtin/terminal-driver/scripts
node record-fixture.mjs vim --args "-u NONE -N" \
     --keys ":set nonumber\riHELLO\x1b:q!\r" --duration 2000 \
     --out ../fixtures/vim.stream.txt
```

`vim -u NONE -N` (no host vimrc) + a scripted deterministic edit ⇒ the captured
bytes contain only the fixed test content + vim's own chrome — **no host paths,
no env, no secrets**. Review the fixture in the commit diff before
landing. **Fallback:** if `vim` is unavailable, record `top`/`htop` instead (any
real alt-screen TUI satisfies the "recorded vim/top" intent) — note which here.

### 3. (Re)generate a golden from a stream (replay → serialize)

```bash
cd packages/skills/src/tools/builtin/terminal-driver/scripts
node record-fixture.mjs --golden --in ../fixtures/spinner.stream.txt   --out ../fixtures/spinner.golden.txt
node record-fixture.mjs --golden --in ../fixtures/altscreen.stream.txt --out ../fixtures/altscreen.golden.txt
node record-fixture.mjs --golden --in ../fixtures/vim.stream.txt       --out ../fixtures/vim.golden.txt
```

`--golden` replays the stream through the SAME emulator the test drives (reading +
writing `latin1` so control bytes round-trip exactly) and writes
`serialize({format:'ansi'})`. **Regenerating a golden is an intentional, reviewed
act** — do it ONLY on a deliberate `@xterm/addon-serialize` bump, then re-commit
the `*.golden.txt` alongside its stream so the diff is reviewable. Never regenerate
a golden to "make a failing test pass" without understanding why the serialization
changed (that would mask exactly the churn this guard catches).

---

# The classifier corpus

These `<scenario>.stream.txt` streams back the corpus block in
`terminal-classifier.test.ts` — the **primary classifier guard**. Each stream is
replayed through a fresh `createSessionEmulator` (the same host-independent pure-JS
replay as the golden frames); the test models the worker's settle/diff frame for
that scenario and asserts `classifyFrame(...)` returns the expected state **and
its `confidence`**. The **load-bearing** assertion is that the **thinking/tool-use
pause** is classified `working`, NEVER `awaiting-input` (a false `awaiting-input` would
wake a turn that fires a spurious keystroke into a still-generating CLI — a HIGH-severity
risk).

The corpus covers `claude` + `codex` + `aider` × {idle-working, awaiting-text-input,
full-screen menu, permission dialog, completed, hung}, and asserts the `confidence` on
every case. The two `claude-*` dialog fixtures are the **regression lock** for the
claude-2.1.x misread: a full-screen permission/menu dialog whose cursor sits on a blank
input line **below** the prompt block must classify
`awaiting-input`/`medium`/`dialog_detected` via the structural dialog detector, not
`stuck`. A render shift that moves the cursor or drops the dialog chrome fails **here**,
not in a production drive.

## Pinned CLI versions

| CLI | Version | Role in the corpus |
|-----|---------|--------------------|
| `claude` (Claude Code) | **2.1.177** | The primary corpus; the RED dialog misread shapes. |
| `codex` (codex-cli) | **0.138** | TUI **shape reference** — boxed prompt / enumerated menu / `(y/n)` gate / parked input prompt. |
| `aider` | **0.81** | TUI **shape reference** — enumerated menu / `(y/n)` gate / parked `>` chat prompt. |

> **REFRESH this corpus on each `claude` / `codex` / `aider` version bump.** A new release
> can shift where the CLI parks (or does not park) its
> cursor, or reshape its dialog chrome; a drift surfaces here as a failing corpus case.
> Re-author the affected streams via `record-fixture.mjs --synthetic` (never hand-edit
> the `.txt` bytes), re-verify the asserted state **and confidence**, and bump the
> version above. The `cli` tag on each `CorpusCase` row documents which fixtures a given
> CLI bump affects.

## The scenarios

### `claude` (the base corpus + the RED dialog shapes)

| Stream | Expected | What it is | Authored |
|--------|----------|------------|----------|
| `startup.stream.txt` | `working`/`high` | The CLI banner still painting (an UNSETTLED frame). | **hand-authored** |
| `trust-dialog.stream.txt` | `awaiting-input`/`high` | The "Do you trust the files in this folder?" prompt; cursor PARKED on the `❯` affordance at the bottom. | **hand-authored** |
| `ask-user-question.stream.txt` | `awaiting-input`/`high` | An `AskUserQuestion` choice menu; cursor PARKED on the selected option. | **hand-authored** |
| `permission-gate.stream.txt` | `awaiting-input`/`high` | A tool-use `(y/n)` permission gate; cursor PARKED right after the prompt. | **hand-authored** |
| `long-working.stream.txt` | `working`/`high` | A long working stream (spinner + streaming output); UNSETTLED. | **hand-authored** |
| `thinking-pause.stream.txt` | **`working`**/`medium` | **The load-bearing negative.** A thinking/tool-use pause: settled + diff∅ but the cursor sits MID-SCREEN in the generation region (output rendered BELOW it), so it is NOT parked ⇒ `working`, never `awaiting-input`. | **hand-authored** |
| `completion.stream.txt` | `awaiting-input`/`high` | The turn finished and returned to the `❯` input prompt; cursor PARKED at the bottom. | **hand-authored** |
| `auth-expired.stream.txt` | `awaiting-input`/`high` | An expired-Max OAuth/login prompt; cursor PARKED. (The auto-answer policy asserts an auth/login prompt ESCALATES — never auto-answered.) | **hand-authored** |
| `claude-permission-dialog.stream.txt` | **`awaiting-input`**/`medium` | **The RED regression lock.** An ASCII-bordered permission prompt ABOVE; cursor on a blank input line BELOW (NOT parked) ⇒ `dialog_detected` (a naive cursor-park check would misread it as `stuck`). | **synthetic** |
| `claude-menu.stream.txt` | **`awaiting-input`**/`medium` | The RED misread family: a full-screen enumerated menu ABOVE; cursor on a blank line BELOW ⇒ `dialog_detected`. | **synthetic** |

### `codex` (shape reference) and `aider` (shape reference) — the six states each

| Stream | Expected | What it is | Authored |
|--------|----------|------------|----------|
| `codex-working.stream.txt` / `aider-working.stream.txt` | `working`/`high` | Streaming output, cursor trailing mid-stream; UNSETTLED. | **synthetic** |
| `codex-awaiting-input.stream.txt` / `aider-awaiting-input.stream.txt` | `awaiting-input`/`high` | Parked at the input prompt (`>`), cursor on the affordance. | **synthetic** |
| `codex-menu.stream.txt` / `aider-menu.stream.txt` | `awaiting-input`/`medium` | A full-screen menu (boxed / enumerated); cursor on a blank line below ⇒ `dialog_detected`. | **synthetic** |
| `codex-permission-dialog.stream.txt` / `aider-permission-dialog.stream.txt` | `awaiting-input`/`medium` | A `(y/n)` permission gate; cursor on a blank line below ⇒ `dialog_detected`. | **synthetic** |
| `codex-completed.stream.txt` / `aider-completed.stream.txt` | `awaiting-input`/`high` | Finished and returned to the parked input prompt. | **synthetic** |
| `codex-hung.stream.txt` / `aider-hung.stream.txt` | `stuck`/`medium` | Frozen prose, NO box/menu/selector, cursor mid-screen + no progress > `stuckMs` (the dialog branch must NOT steal it). | **synthetic** |

## Why hand-authored (not live-recorded)

Either a live recording or a faithful hand-authored stream satisfies the corpus. All
corpus streams are **synthetic / hand-authored** because a live `claude`/`codex`/`aider`
capture is (a) **non-deterministic** (model output varies run-to-run, so it cannot
deterministically pin a pure classifier), (b) **auth-gated** (it needs an authenticated
session + a real TTY), and (c) not in-harness reproducible on the macOS author box (its
node-pty cannot `posix_spawnp` in-harness). Synthetic streams
matching the documented byte patterns are deterministic, host-independent, and
reviewable in the commit diff — exactly like the `spinner`/`altscreen` golden frames.

The **cursor position at capture end** is the load-bearing signal: a real prompt
parks the cursor at/near the last non-blank row; a thinking pause leaves it
mid-screen with output below; the misread dialog shape leaves it on a blank line
**below** the prompt block. The byte strings are literal constants in
`scripts/record-fixture.mjs` (the `SYNTHETIC` map) — edit them THERE (never hand-type
raw escapes into the `.txt`), then regenerate.

> **Encoding constraint (latin1):** the corpus replay reads each
> stream `latin1` (the golden-frame round-trip contract), so a multi-byte UTF-8 glyph
> (`╭`, `❯`) decodes as **3 separate latin1 cells** — a wide Unicode box row would overflow
> the 80-col grid and wrap, and a `❯`-prefixed enumerator would no longer match the
> line-start regex. The `claude-*`/`codex-*`/`aider-*` dialog fixtures therefore use
> **pure-ASCII** structural cues that survive the latin1 decode 1:1 — an ASCII border
> (`+----+` / `| … |`), a `(y/n)` token, or ≥2 line-start `1.`/`2.` option rows. (The
> original `claude` fixtures keep their `╭`/`❯` chrome because they assert via a
> *parked cursor*, never via the structural dialog predicate, so glyph width is moot there.)

Regenerate the original `claude` corpus:

```bash
cd packages/skills/src/tools/builtin/terminal-driver/scripts
for s in startup trust-dialog ask-user-question permission-gate \
         long-working thinking-pause completion auth-expired; do
  node record-fixture.mjs --synthetic "$s" --out "../fixtures/$s.stream.txt"
done
```

Regenerate the per-CLI corpus (claude RED dialogs + codex/aider × six states):

```bash
cd packages/skills/src/tools/builtin/terminal-driver/scripts
for s in claude-permission-dialog claude-menu \
         codex-working codex-awaiting-input codex-menu \
         codex-permission-dialog codex-completed codex-hung \
         aider-working aider-awaiting-input aider-menu \
         aider-permission-dialog aider-completed aider-hung; do
  node record-fixture.mjs --synthetic "$s" --out "../fixtures/$s.stream.txt"
done
```
