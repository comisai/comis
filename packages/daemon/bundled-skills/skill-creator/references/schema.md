# Skill Manifest Schema Reference

Complete reference for SKILL.md frontmatter fields and validation rules.

## Frontmatter Fields

The authored frontmatter carries **exactly six top-level fields**. Every platform
extension rides under one `metadata.comis` key (see below) -- nothing else is
authored at the top level.

### Required

| Field | Type | Rules |
|-------|------|-------|
| `name` | string | 1-64 chars, lowercase alphanumeric + hyphens, no consecutive hyphens, no leading/trailing hyphens. Regex: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` |
| `description` | string | 1-1024 chars. Primary trigger mechanism -- include both what the skill does AND when to use it |

### Optional (top-level)

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `license` | string | - | SPDX license identifier |
| `compatibility` | string | - | Free-prose environment/runtime note (operator-visible). No platform semantics; a note over 500 chars draws an advisory warning. Machine-readable prerequisites live under `metadata.comis` -- complementary, not a duplicate |
| `allowed-tools` | string | `""` | Space-separated tool-restriction list; empty means no restriction. Restriction-only -- it narrows the active tool set, never grants |
| `metadata` | map string→string | - | Arbitrary string key-value pairs. Also carries `metadata.version` and the `metadata.comis` extension carrier (below) |

### Minimal example

```yaml
---
name: my-skill
description: What this skill does and when to use it.
---
```

### Optional-fields example

```yaml
---
name: my-skill
description: What this skill does and when to use it.
license: MIT
compatibility: Needs Node 22+ and ripgrep on PATH.
allowed-tools: "read grep bash"
metadata:
  version: "1.0.0"
---
```

## Platform Extensions (`metadata.comis`)

Fields that only apply within Comis ride under a single `metadata.comis` key. Its
value is a **JSON string** (so `metadata` stays a plain string→string map); it
parses and then validates by the same rules as every other manifest field -- the
carrier moves, the semantics do not. Hosts that implement only the skill spec
ignore this key.

The `metadata.comis` JSON object may carry:

| Field | Type | Purpose |
|-------|------|---------|
| `userInvocable` | boolean (default `true`) | Whether users can invoke via `/skill:name` |
| `disableModelInvocation` | boolean (default `false`) | When true, hidden from the model's available-skills listing |
| `argumentHint` | string | Hint text shown to users (e.g., "[query]") |
| `permissions` | object | Required permissions (see below) |
| `inputSchema` | object | JSON Schema for input parameters |
| `comis` | object | The Comis namespace block (see below) |
| `mcpServers` | array/object | Optional bundled MCP servers declaration |

The version is authored as `metadata.version` (a string in the metadata map), not
inside the JSON carrier.

### metadata.comis example

```yaml
---
name: my-skill
description: What this skill does and when to use it.
metadata:
  version: "1.0.0"
  comis: '{"userInvocable": true, "permissions": {"net": ["api.example.com"]}, "comis": {"os": ["linux"], "requires": {"bins": ["ripgrep"]}}}'
---
```

Malformed `metadata.comis` JSON fails with an error naming the key -- fix the JSON
string, do not remove the metadata map.

### Permissions

Carried as `permissions` inside the `metadata.comis` JSON object:

```json
{
  "permissions": {
    "fsRead": [],
    "fsWrite": [],
    "net": [],
    "env": []
  }
}
```

| Key | Purpose |
|-----|---------|
| `fsRead` | Filesystem read paths |
| `fsWrite` | Filesystem write paths |
| `net` | Network domains |
| `env` | Environment variables (read-only) |

### Comis namespace

Carried as `comis` inside the `metadata.comis` JSON object:

```json
{
  "comis": {
    "os": ["linux", "darwin"],
    "requires": {
      "bins": ["ripgrep", "fd"],
      "env": ["OPENAI_API_KEY"]
    },
    "skill-key": "my-custom-key",
    "primary-env": "discord",
    "command-dispatch": "my-command"
  }
}
```

| Field | Purpose |
|-------|---------|
| `os` | Target operating systems (a bare string is coerced to a one-element list) |
| `requires.bins` | Required binaries on PATH |
| `requires.env` | Required environment variables |
| `skill-key` | Explicit skill key override (slug format) |
| `primary-env` | Display/grouping hint for the primary environment |
| `command-dispatch` | Metadata-only dispatch tag for command routing |

## Read Compatibility

The pre-migration top-level form -- extension fields authored directly at the top
level (`type`, `version`, `userInvocable`, `disableModelInvocation`,
`allowedTools`, `argumentHint`, `permissions`, `inputSchema`, `comis`,
`mcpServers`) -- still loads, emitting a **deprecation warning** that names each
moved key and its new home:

- `version` → `metadata.version`
- `userInvocable` / `disableModelInvocation` / `argumentHint` / `permissions` / `inputSchema` / `comis` / `mcpServers` → `metadata.comis`
- `allowedTools` (array) → `allowed-tools` (space-separated string)
- `type` is dropped -- skills are prompt-only

It is read for compatibility only and is never written back. Author new skills in
the spec-pure form above.

## Body Constraints

- Maximum length: **20,000 characters** (configurable via `skills.promptSkills.maxBodyLength`)
- Exceeding the limit: body truncated with `[TRUNCATED]` marker appended
- Ideal: keep SKILL.md body under **500 lines**; use references/ for large docs

## Content Scanning

Skill bodies are scanned at load time for dangerous patterns. **CRITICAL** findings block loading by default.

### Blocked Patterns (CRITICAL severity)

- Shell injection: `$(...)`, backticks with dangerous binaries, `eval()`
- Pipe to shell: `| bash`, `| sh`, `| zsh`
- Crypto mining: `stratum://` pools, miner binaries, mining domains
- Reverse shells: `/dev/tcp`, `nc -e`
- Obfuscated execution: `base64 -d |`
- XML breakout: `</available_skills>`, `</skill_invocation>`, `<system>`, `</system>`, `<tool_result>`

### Warning Patterns (WARN severity)

- Environment harvesting: `printenv`, `/proc/self/environ`
- Long base64 strings (80+ chars)
- Long hex sequences (20+ pairs)

## Discovery

Skills are found by scanning configured `discoveryPaths` (default: `~/.comis/skills/`):

- **Root .md files**: `.md` files directly in the skills directory root
- **Recursive SKILL.md**: `SKILL.md` files in any subdirectory

First-loaded-wins on name collision across discovery paths.

## Hot Reload

The skill watcher monitors discovery paths for file changes. After a 400ms debounce, the registry re-discovers all skills. No daemon restart needed -- just save the file and the skill is available.

## Runtime Eligibility

When the `comis` namespace (under `metadata.comis`) sets `requires` or `os`, the skill is only available if:

1. Current OS matches the namespace `os` (if specified)
2. All binaries in `requires.bins` exist on PATH
3. All env vars in `requires.env` are set (via SecretManager)

Failed eligibility checks make the skill invisible to the model -- no error, just not listed.
