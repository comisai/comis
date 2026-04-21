# Skill Manifest Schema Reference

Complete reference for SKILL.md frontmatter fields and validation rules.

## Frontmatter Fields

### Required

| Field | Type | Rules |
|-------|------|-------|
| `name` | string | 1-64 chars, lowercase alphanumeric + hyphens, no consecutive hyphens, no leading/trailing hyphens. Regex: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` |
| `description` | string | 1-1024 chars. Primary trigger mechanism -- include both what the skill does AND when to use it |

### Optional (top-level)

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `type` | `"prompt"` | `"prompt"` | Always "prompt" for Markdown instruction skills |
| `version` | string | - | Semver version string |
| `license` | string | - | SPDX license identifier |
| `userInvocable` | boolean | `true` | Whether users can invoke via `/skill:name` |
| `disableModelInvocation` | boolean | `false` | When true, hidden from model's available skills listing |
| `allowedTools` | string[] | `[]` | Tool restrictions when skill is active; empty = no restriction |
| `argumentHint` | string | - | Hint text shown to users (e.g., "[query]") |
| `permissions` | object | see below | Required permissions |
| `inputSchema` | object | - | JSON Schema for input parameters |
| `metadata` | Record<string, string> | - | Arbitrary key-value pairs |

### Permissions Block

```yaml
permissions:
  fsRead: []      # Filesystem read paths
  fsWrite: []     # Filesystem write paths
  net: []         # Network domains
  env: []         # Environment variables (read-only)
```

### Comis Namespace (`comis:`)

Platform-specific fields that only apply within Comis. Other pi-coding-agent hosts ignore this block.

```yaml
comis:
  os: ["linux", "darwin"]           # Target operating systems (coerced: string -> [string])
  requires:                          # External prerequisites
    bins: ["ripgrep", "fd"]          # Required binaries on PATH
    env: ["OPENAI_API_KEY"]          # Required environment variables
  skill-key: my-custom-key           # Explicit skill key override (slug format)
  primary-env: discord               # Display/grouping hint for primary environment
  command-dispatch: my-command       # Metadata-only dispatch tag for command routing
```

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
- Network fetching: `curl | bash`, `wget -O -`

## Discovery

Skills are found by scanning configured `discoveryPaths` (default: `~/.comis/skills/`):

- **Root .md files**: `.md` files directly in the skills directory root
- **Recursive SKILL.md**: `SKILL.md` files in any subdirectory

First-loaded-wins on name collision across discovery paths.

## Hot Reload

The skill watcher monitors discovery paths for file changes. After a 400ms debounce, the registry re-discovers all skills. No daemon restart needed -- just save the file and the skill is available.

## Runtime Eligibility

When `comis.requires` or `comis.os` is set, the skill is only available if:

1. Current OS matches `comis.os` (if specified)
2. All binaries in `comis.requires.bins` exist on PATH
3. All env vars in `comis.requires.env` are set (via SecretManager)

Failed eligibility checks make the skill invisible to the model -- no error, just not listed.
