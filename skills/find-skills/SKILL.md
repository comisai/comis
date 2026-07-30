---
name: find-skills
version: 1.0.4
description: "MANDATORY: For requests asking whether a skill or specialized capability exists, load this skill and run its catalog workflow before answering. Do not answer from general capabilities or generic web search."
comis:
  requires:
    bins: ["git"]
---

# Find Skills

Discover and install skills from the open agent skills ecosystem into Comis.

All script paths below are relative to this skill's directory. Resolve them against the directory containing the manifest file shown in `<location>`.
Invoke the resolved script by its absolute path while keeping the tool working directory inside the execution workspace. Never set `cwd` to the skill directory; it is outside workspace bounds. In command examples below, replace each relative `scripts/...` path with its resolved absolute path.

## Workflow

### Step 1: Understand what they need

Identify the domain (e.g., React, testing, deployment), the specific task (e.g., writing tests, reviewing PRs), and whether a skill likely exists for it.

### Step 2: Search for skills

For an existing-skill discovery request, you must run `npx skills find <query>` first through `exec`
in the execution workspace. Use the non-interactive form:

```bash
npx --yes skills find <query>
```

Examples:
- User asks "how do I make my React app faster?" -- `npx skills find react performance`
- User asks "can you help with PR reviews?" -- `npx skills find pr review`
- User asks "I need to create a changelog" -- `npx skills find changelog`

Do not substitute generic web search while the native catalog command is available. If the command
is missing or fails, report that exact limitation and offer direct help; never imply that a catalog
skill was found.

### Step 3: Present options

Present the strongest verified fit as the clear recommendation, including its
`owner/repo@skill-name` identifier. Mention alternatives only when they materially differ. Do not
claim details the catalog output did not establish.

### Step 4: Install

Never copy a skill into `~/.comis/skills/` and never use `npx skills add`; those paths bypass Comis's
scoped registry, content scan, and approval gate.

When the user asks to install a catalog result:

1. Resolve its exact GitHub directory URL with the bundled resolver:

   ```bash
   bash scripts/resolve-skill-url.sh <owner/repo@skill-name>
   ```

2. Call `skills_manage` with `action: "import"`, that URL, and `scope: "local"`. Local scope installs
   into the calling agent's workspace. Use `scope: "shared"` only when the user explicitly asks for
   a shared install and the calling agent is authorized.
3. Let the normal approval gate complete; do not claim installation while approval is pending or
   denied.
4. Call `skills_manage` with `action: "list"` and confirm the returned entry. Report the exact
   returned location as installation ground truth.

The skill watcher makes a successfully listed import available without a daemon restart.

## Common Skill Categories

| Category | Example Queries |
|----------|----------------|
| Web Development | react, nextjs, typescript, css, tailwind |
| Testing | testing, jest, playwright, e2e |
| DevOps | deploy, docker, kubernetes, ci-cd |
| Documentation | docs, readme, changelog, api-docs |
| Code Quality | review, lint, refactor, best-practices |
| Design | ui, ux, design-system, accessibility |
| Productivity | workflow, automation, git |

## When No Skills Are Found

1. Acknowledge that no existing skill was found
2. Offer to help with the task directly using general capabilities
3. Suggest the user could create their own skill using the skill-creator skill
