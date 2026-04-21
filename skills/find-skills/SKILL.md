---
name: find-skills
description: Discover and install agent skills from the open skills ecosystem at skills.sh. Use this skill when the user asks "how do I do X", "find a skill for X", "is there a skill that can...", "can you do X" for a specialized capability, wants to extend agent capabilities, or mentions wishing they had help with a specific domain (design, testing, deployment, etc.) -- even if they don't use the word "skill".
comis:
  requires:
    bins: ["git"]
---

# Find Skills

Discover and install skills from the open agent skills ecosystem into Comis.

All script paths below are relative to this skill's directory. Resolve them against the skill location shown in the available skills listing.

## Workflow

### Step 1: Understand what they need

Identify the domain (e.g., React, testing, deployment), the specific task (e.g., writing tests, reviewing PRs), and whether a skill likely exists for it.

### Step 2: Search for skills

If `npx` is available, use the Skills CLI to search:

```bash
npx skills find [query]
```

Examples:
- User asks "how do I make my React app faster?" -- `npx skills find react performance`
- User asks "can you help with PR reviews?" -- `npx skills find pr review`
- User asks "I need to create a changelog" -- `npx skills find changelog`

If npx is not available, the user can browse available skills online at the Skills directory website.

### Step 3: Present options

When you find relevant skills, present the skill name, what it does, and the install command.

### Step 4: Install

Run the bundled install script. It clones the skill from GitHub directly into `~/.comis/skills/` (shared, visible to all agents):

```bash
bash scripts/install-skill.sh <owner/repo@skill-name>
```

Example:
```bash
bash scripts/install-skill.sh vercel-labs/agent-skills@vercel-react-best-practices
```

The skill is available immediately after installation (hot-reloaded by the skill watcher).

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
