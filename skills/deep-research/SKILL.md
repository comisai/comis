---
name: deep-research
description: Conduct systematic, multi-angle web research on any topic. Use this skill instead of a single web search for ANY question requiring online information -- "what is X", "explain X", "compare X and Y", "research X", or before content generation tasks like articles, reports, presentations, or documentation. Provides thorough multi-source research methodology. Use proactively when the user's question needs current, comprehensive information from multiple angles.
---

# Deep Research

Systematic methodology for thorough web research. Load this skill BEFORE starting any content generation task to gather sufficient information from multiple angles, depths, and sources.

## Core Principle

Never generate content based solely on general knowledge. The quality of output depends directly on research quality. A single search query is never enough.

## Research Methodology

### Phase 1: Broad Exploration

1. **Initial survey** -- use the `web_search` tool on the main topic to understand overall context
2. **Identify dimensions** -- from initial results, note key subtopics, themes, and angles
3. **Map the territory** -- note different perspectives, stakeholders, and viewpoints

Example:
```
Topic: "AI in healthcare"
Initial searches:
- "AI healthcare applications 2026"
- "artificial intelligence medical diagnosis"
- "healthcare AI market trends"

Identified dimensions:
- Diagnostic AI (radiology, pathology)
- Treatment recommendation systems
- Administrative automation
- Regulatory landscape
- Ethical considerations
```

### Phase 2: Deep Dive

For each important dimension, conduct targeted research:

1. **Specific queries** -- precise keywords for each subtopic via `web_search`
2. **Multiple phrasings** -- try different keyword combinations
3. **Fetch full content** -- use `web_fetch` to read important sources in full, not just snippets
4. **Follow references** -- when sources mention other important resources, search for those too

### Phase 3: Diversity & Validation

Ensure comprehensive coverage by seeking diverse information types:

| Information Type | Purpose | Example Searches |
|-----------------|---------|------------------|
| **Facts & data** | Concrete evidence | "statistics", "data", "market size" |
| **Examples & cases** | Real-world applications | "case study", "implementation" |
| **Expert opinions** | Authority perspectives | "expert analysis", "interview" |
| **Trends & predictions** | Future direction | "trends 2026", "forecast" |
| **Comparisons** | Context and alternatives | "vs", "comparison", "alternatives" |
| **Challenges & criticisms** | Balanced view | "challenges", "limitations" |

### Phase 4: Synthesis Check

Before proceeding to content generation, verify:

- [ ] Searched from at least 3-5 different angles
- [ ] Fetched and read the most important sources in full
- [ ] Have concrete data, examples, and expert perspectives
- [ ] Explored both positive aspects and challenges/limitations
- [ ] Information is current and from authoritative sources

If any answer is NO, continue researching before generating content.

## Search Strategy

### Effective query patterns

```
# Be specific with context
Bad:  "AI trends"
Good: "enterprise AI adoption trends 2026"

# Include authoritative source hints
"[topic] research paper"
"[topic] industry analysis"

# Search for specific content types
"[topic] case study"
"[topic] statistics"
```

### Temporal awareness

Always check `<current_date>` in your context before forming search queries.

| User intent | Precision needed | Example query |
|---|---|---|
| "today / just released" | **Month + day** | `"tech news March 22 2026"` |
| "this week" | **Week range** | `"releases week of Mar 16 2026"` |
| "recently / latest" | **Month** | `"AI breakthroughs March 2026"` |
| "this year / trends" | **Year** | `"software trends 2026"` |

When the user asks about "today", use month + day + year. Never drop to year-only when day-level precision is needed. Try multiple phrasings: numeric, written, and relative terms across different queries.

### When to use web_fetch

Use `web_fetch` to read full content when a search result looks highly relevant and authoritative, when you need details beyond the snippet, or when the source contains data, case studies, or expert analysis.

### Iterative refinement

Research is iterative. After initial searches, review what you've learned, identify gaps, formulate more targeted queries, and repeat until you have comprehensive coverage.

## Quality Bar

Research is sufficient when you can confidently answer:
- What are the key facts and data points?
- What are 2-3 concrete real-world examples?
- What do experts say about this topic?
- What are the current trends and future directions?
- What are the challenges or limitations?

## Common Mistakes

- Stopping after 1-2 searches
- Relying on search snippets without reading full sources
- Searching only one aspect of a multi-faceted topic
- Ignoring contradicting viewpoints or challenges
- Using outdated information when current data exists
- Starting content generation before research is complete
