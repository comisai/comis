---
name: skill-creator
version: "1.1.1"
description: Create new Comis skills, modify and improve existing skills, and validate them against the platform's manifest schema. Use this skill whenever the user wants to create a skill from scratch, turn a workflow into a reusable skill, update or fix an existing skill, understand the skill format, or asks about how skills work in Comis -- even if they don't use the word "skill" explicitly.
---

# Skill Creator

Create, validate, and iterate on Comis prompt skills.

## How Skills Work

Skills are Markdown instruction files that extend what the agent can do. When a user sends a message, the agent scans available skill descriptions and, if one matches, reads its SKILL.md and follows the instructions step by step. Skills are the primary way to teach the agent new capabilities without changing code.

Skills are hot-reloaded -- save a file and it's available immediately, no restart needed.

## Core Principles

### The context window is a public good

Skills share the context window with the system prompt, conversation history, other skills' metadata, and the user's request. Challenge each piece of information: "Does the agent really need this?" and "Does this paragraph justify its token cost?" Default assumption: the agent is already very smart -- only add context it doesn't already have. Prefer concise examples over verbose explanations.

### Set appropriate degrees of freedom

Match the level of specificity to the task's fragility:

- **High freedom** (text-based instructions): Multiple approaches are valid, decisions depend on context. Like an open field -- many routes work.
- **Medium freedom** (pseudocode or parameterized scripts): A preferred pattern exists but some variation is acceptable.
- **Low freedom** (specific scripts, exact sequences): Operations are fragile, consistency is critical. Like a narrow bridge -- guardrails needed.

### What NOT to include

A skill should only contain files that directly support its function. Do not create:
- README.md, CHANGELOG.md, INSTALLATION_GUIDE.md, or any auxiliary documentation
- User-facing docs about the process that went into creating the skill
- Setup/testing procedures (those belong in the iteration loop, not the skill)

## Private vs Shared Skills

Skills can live in two places. **Default to private** unless the user explicitly asks for a shared skill.

### Private skills (default)

Created in the agent's own workspace under `skills/`.

Workspace paths follow the pattern `~/.comis/workspace-<agent-id>/` (e.g., `~/.comis/workspace-ta-trader/` for the `ta-trader` agent). The default agent's workspace is simply `~/.comis/workspace/`. Your workspace path is shown in the "Workspace" section of your system prompt -- use it directly, don't guess.

Create private skills at: `<your-workspace>/skills/<skill-name>/SKILL.md`

- Full read/write access -- create, edit, and delete freely
- Visible only to this agent (and its sub-agents who share the workspace)
- Take priority over shared skills with the same name

### Shared skills

Created at `~/.comis/skills/`. Visible to all agents on the platform.

- Use the absolute path `~/.comis/skills/<skill-name>/`
- Only when explicitly requested ("make this available to all agents", "create a shared skill")

## Creating a Skill

**Before creating**, check if a skill with the same or similar name already exists:
- `ls <workspace>/skills/` -- check the agent's private skills
- `ls ~/.comis/skills/` -- check shared skills

Two calls maximum. If a match is found, confirm with the user whether to modify the existing skill or create a new one.

### Routing: simple vs complex

**Simple skill** (no scripts, references, or assets -- most skills):
1. Write `<workspace>/skills/<name>/SKILL.md` directly (the write tool creates parent dirs)
2. Validate → suggest test prompt → done

**Complex skill** (needs bundled scripts, reference docs, or asset files):
Follow Steps 1-8 below.

### Step 1: Understand intent

You MUST ask at least one clarifying question unless the user's request already specifies ALL of: (1) the specific capability, (2) the tools or data sources, and (3) the expected output format.

Four dimensions to clarify:

1. What should this skill enable the agent to do?
2. When should it trigger? (what user phrases, contexts, or tasks)
3. What tools does the agent need? (file ops, exec, web search, memory, messaging)
4. What's the expected output format or behavior?

If the conversation already contains a workflow the user wants to capture ("turn this into a skill"), extract the steps, tools used, and corrections from the conversation history. Confirm before proceeding.

Do NOT proceed to Step 2 until intent is clear on all four dimensions.

### Step 2: Verify tools

If the skill will reference specific tools (MCP servers, platform tools, or deferred tools), call `discover_tools` to load their schemas before writing any instructions.

- Confirm parameter names, required fields, and return formats match what the skill instructions will reference
- Do NOT assume tool capabilities from deferred-tool names alone -- always check the schema
- If a tool is unavailable or its schema differs from expectations, flag this to the user before proceeding

Skip this step if the skill uses only general-purpose capabilities (text generation, reasoning) with no specific tool references.

### Step 3: Plan reusable resources

Before writing, analyze the concrete examples to identify what should be bundled:

- Will the same code be written on every invocation? → `scripts/`
- Is there reference material the agent needs but only sometimes? → `references/`
- Are there templates or files used in the output? → `assets/`

### Step 4: Initialize resource directories (if needed)

Skip this step for simple skills -- the write tool creates the skill directory automatically. Only run the init script when the skill needs `scripts/`, `references/`, or `assets/` directories:

```
python3 scripts/init-skill.py <skill-name> --path <workspace>/skills --resources scripts,references
python3 scripts/init-skill.py <skill-name> --path <workspace>/skills --description "What it does and when to use it"
```

This creates the directory with a templated SKILL.md. If `--description` is provided, the template uses it directly instead of a TODO placeholder. Use the **absolute path** to `scripts/init-skill.py` from this skill-creator's directory (do NOT set `cwd` to this directory -- the exec tool will reject it as outside workspace bounds).

For shared skills: `python3 scripts/init-skill.py <skill-name> --path ~/.comis/skills`

### Step 5: Edit the SKILL.md

#### Frontmatter

Two fields are required -- `name` and `description`. Everything else is optional.

```yaml
---
name: my-skill-name
description: What this skill does and when to use it. Be specific and slightly pushy.
---
```

**Name rules:** lowercase alphanumeric + hyphens, 1-64 chars, no consecutive/leading/trailing hyphens.

**Description guidance:** This is the primary trigger mechanism. The agent decides whether to use a skill based on this field alone. All "when to use" info goes here -- not in the body (the body is only loaded after triggering).

Bad: `"Dashboard builder."`
Good: `"Build data visualization dashboards with charts, tables, and filters. Use whenever the user mentions dashboards, data visualization, metrics display, or chart creation -- even if they don't explicitly ask for a 'dashboard'."`

Only two fields are required: `name` and `description`. For advanced fields (comis namespace, permissions, allowedTools, inputSchema), read `references/schema.md` in this skill's directory.

#### Body structure

Choose the pattern that fits the skill's purpose:

**Workflow-based** -- for sequential processes:
```
## Overview → ## Decision Tree → ## Step 1 → ## Step 2 ...
```

**Task-based** -- for tool collections with different operations:
```
## Overview → ## Quick Start → ## Task Category 1 → ## Task Category 2 ...
```

**Reference/guidelines** -- for standards or specifications:
```
## Overview → ## Guidelines → ## Specifications → ## Usage ...
```

**Capabilities-based** -- for integrated systems:
```
## Overview → ## Core Capabilities → ### 1. Feature → ### 2. Feature ...
```

Patterns can be mixed as needed.

### Complete example

A minimal working skill:

~~~
---
name: commit-message
description: Write conventional commit messages from staged changes. Use whenever the user asks to commit, write a commit message, or says "commit this" -- even if they don't mention conventional commits.
---

# Commit Message

Generate a conventional commit message from the current staged diff.

## Steps

1. Run `git diff --cached` to see staged changes
2. Analyze the diff: what changed, why, which components
3. Write a message following conventional commits format: `type(scope): description`
   - `feat` for new features, `fix` for bugs, `refactor` for restructuring, `docs` for documentation
   - scope = package or component name
   - description = imperative mood, lowercase, no period
4. Present the message and wait for approval before committing
~~~

This skill needs no scripts, references, or assets -- just the SKILL.md file.

#### Body writing principles

1. **Explain the why.** The model handles edge cases better when it understands reasoning. Instead of "ALWAYS use format X", explain why format X matters.

2. **Use imperative form.** "Read the config file" not "You should read the config file".

3. **Progressive disclosure.** Keep SKILL.md body under 500 lines. Move detailed reference material to `references/` files -- keep only core workflow in the body. When splitting content, clearly reference the files and describe when to read them.

4. **Bundle repeated work as scripts.** If the same helper code would be written every time, put it in `scripts/`. Scripts execute without loading into context -- saves tokens and ensures consistency.

5. **Avoid duplication.** Information should live in SKILL.md or reference files, not both.

6. **Include examples.** Concise examples over verbose explanations:
```
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

#### Progressive disclosure patterns

**Pattern 1: High-level guide with references**
```markdown
## Quick start
Extract text with pdfplumber: [code example]

## Advanced features
- **Form filling**: See references/forms.md for complete guide
- **API reference**: See references/api.md for all methods
```

**Pattern 2: Domain-specific organization**
```
bigquery-skill/
├── SKILL.md (overview and navigation)
└── references/
    ├── finance.md
    ├── sales.md
    └── product.md
```
When the user asks about sales, the agent only reads `sales.md`.

**Guidelines:**
- Keep references one level deep from SKILL.md -- avoid nested references
- For reference files over 100 lines, include a table of contents at the top
- If a reference file is very large (>10k words), include grep search patterns in SKILL.md so the agent can find what it needs efficiently

#### Body constraints

- Maximum 20,000 characters (truncated with [TRUNCATED] at load time)
- Aim for under 500 lines
- No shell injection patterns (see content scanning rules in `references/schema.md`)

### Step 6: Validate

Run the validation script:

```
python3 scripts/validate-skill.py <path-to-skill-dir>
```

Use the **absolute path** to `scripts/validate-skill.py` from this skill-creator's directory (same rule -- no `cwd` override).

This checks: frontmatter fields and types, name format, description length, body size, content scanning patterns, and unreferenced bundled scripts.

Fix any errors, then save -- the skill watcher hot-reloads automatically.

### Step 7: Hand off to the user

Tell the user the skill is ready and suggest a sample prompt they can send to test it. Do NOT run the test yourself or spawn a sub-agent to test -- testing is the user's job. Example:

> Your **{skill-name}** skill is live. Try sending: "{a natural prompt that would trigger it}."

If the user later reports the skill didn't trigger, the description needs to be more specific or "pushy".

### Step 8: Iterate

1. **Generalize from feedback.** Don't overfit to test cases. If there's a stubborn issue, try different metaphors or patterns.
2. **Keep it lean.** Remove instructions that aren't pulling their weight. Read transcripts -- if the agent wastes time on unproductive steps, trim the parts causing that.
3. **Test bundled scripts.** Run scripts to verify they work. If there are many similar scripts, test a representative sample.

## Modifying an Existing Skill

1. Read the current SKILL.md to understand what it does
2. Ask what's not working or what should change
3. Make targeted edits -- don't rewrite from scratch unless the structure is fundamentally wrong
4. Validate with the script
5. Test the change

## Bundled Resources

### scripts/
Executable code for deterministic, repeatable tasks. Signs you need a script:
- The same code would be written on every invocation
- Parsing, transforming, or validating data in a predictable way
- Consistency across invocations is important

Scripts can execute without loading into context (saves tokens). Only Python 3 stdlib is guaranteed. Scripts may still need to be read by the agent for patching or environment-specific adjustments.

### references/
Documentation loaded into context as needed. Signs you need a reference:
- Information is important but not needed every time
- Body is getting too long
- Multiple domains or frameworks need separate docs

### assets/
Files used in the output the agent produces (templates, images, fonts, boilerplate). Not loaded into context -- copied or referenced in the final output.

## Platform Features

For advanced frontmatter fields (comis namespace, permissions, allowedTools, model visibility), read `references/schema.md`. Not needed for simple skills using only `name` and `description`.

## Checklist

Before considering a skill done:

- [ ] Name follows format rules (lowercase, hyphens, 1-64 chars)
- [ ] Description is specific, includes trigger phrases, and all "when to use" info
- [ ] Body is under 500 lines (references/ for overflow)
- [ ] No content scanning violations (run validate script)
- [ ] Bundled scripts are referenced in the body and tested
- [ ] No extraneous files (README, CHANGELOG, etc.)
- [ ] Suggested a test prompt to the user
