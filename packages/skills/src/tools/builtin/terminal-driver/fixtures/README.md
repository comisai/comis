# Golden-frame fixtures (Plan 121-05, TR-02 / §11)

These fixtures back `terminal-golden-frame.test.ts` — the **§11 addon-serialize
churn guard**. `@xterm/addon-serialize` is pinned (`0.14.0`) but flagged
experimental, so a future bump could silently change the serialization. The
golden-frame test replays each committed `*.stream.txt` byte stream through a
fresh `createSessionEmulator` and asserts `snapshot({format:'ansi'}).screen`
equals the committed `*.golden.txt`. A serialization change — **or** a tampered
stream — surfaces loudly as a `serialize() !== golden` failure (T-121-13), never
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
macOS author box's node-pty cannot `posix_spawnp` in-harness — the 119/120
precedent) and committed (kept to a few KB).

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
regenerable + reviewable (T-121-13).

### 2. Record a real TUI stream (VPS only — needs node-pty + a real PTY)

```bash
cd packages/skills/src/tools/builtin/terminal-driver/scripts
node record-fixture.mjs vim --args "-u NONE -N" \
     --keys ":set nonumber\riHELLO\x1b:q!\r" --duration 2000 \
     --out ../fixtures/vim.stream.txt
```

`vim -u NONE -N` (no host vimrc) + a scripted deterministic edit ⇒ the captured
bytes contain only the fixed test content + vim's own chrome — **no host paths,
no env, no secrets** (T-121-14). Review the fixture in the commit diff before
landing. **Fallback:** if `vim` is unavailable, record `top`/`htop` instead (any
real alt-screen TUI satisfies TR-02's "recorded vim/top" intent) — note which here.

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
