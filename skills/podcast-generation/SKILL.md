---
name: podcast-generation
description: Convert text content into two-host conversational podcast audio. Transforms articles, reports, documentation, or any written content into natural dialogue between male and female hosts, then synthesizes speech audio. Use this skill when the user requests to generate, create, or produce a podcast from text content -- even if they just say "turn this into audio" or "make this listenable".
comis:
  requires:
    bins: ["python3"]
    env: ["VOLCENGINE_TTS_APPID", "VOLCENGINE_TTS_ACCESS_TOKEN"]
---

# Podcast Generation

Generate podcast audio from text content. The workflow: create a structured JSON dialogue script, then execute audio generation via a bundled Python script that handles TTS synthesis and audio mixing.

All script paths below are relative to this skill's directory. Resolve them against the `<location>` shown in the available skills listing (e.g., if the skill location is `~/.comis/skills/podcast-generation`, then `scripts/generate.py` means `~/.comis/skills/podcast-generation/scripts/generate.py`).

Write script files and generated outputs to your workspace directory (shown in the "Workspace" section of your system prompt).

The bundled script requires the `requests` Python package (`pip install requests`).

## Workflow

### Step 1: Understand requirements

Identify from the user's request:
- **Source content**: The text/article/report to convert
- **Language**: en or zh (based on content)

### Step 2: Create script JSON

Write a structured JSON script file to your workspace directory with naming pattern `{descriptive-name}-script.json`.

```json
{
  "title": "Episode Title",
  "locale": "en",
  "lines": [
    {"speaker": "male", "paragraph": "Hello Deer! Welcome back to another episode."},
    {"speaker": "female", "paragraph": "Hey everyone! Today we have an exciting topic."},
    {"speaker": "male", "paragraph": "That's right! We're going to talk about..."}
  ]
}
```

Fields:
- **title**: Episode title (optional, used as heading in transcript)
- **locale**: Language code -- "en" or "zh"
- **lines**: Array of dialogue lines, each with **speaker** ("male" or "female") and **paragraph**

### Step 3: Execute generation

```bash
python3 scripts/generate.py \
  --script-file ~/.comis/workspace/script-file.json \
  --output-file ~/.comis/workspace/generated-podcast.mp3 \
  --transcript-file ~/.comis/workspace/generated-podcast-transcript.md
```

Parameters:
- `--script-file`: Path to JSON script file (required)
- `--output-file`: Path to output MP3 file (required)
- `--transcript-file`: Path to output transcript markdown (optional, recommended)

Execute the script in one complete call. The script handles all TTS API calls and audio mixing internally. Do NOT read the Python script -- just call it with the parameters. Always include `--transcript-file` to generate a readable transcript.

## Script Writing Guidelines

### Format
- Two hosts only: male and female, alternating naturally
- Target runtime: ~10 minutes of dialogue (40-60 lines)
- Start with the male host saying a greeting that includes "Hello Deer"

### Tone & style
- Natural, conversational dialogue -- like two friends chatting
- Casual expressions and conversational transitions
- Include reactions, follow-up questions, and natural interjections

### Content
- Frequent back-and-forth between hosts
- Keep sentences short and easy to follow when spoken
- Plain text only -- no markdown formatting
- Translate technical concepts into accessible language
- No mathematical formulas, code, or complex notation
- Exclude meta information like dates, author names, or document structure

## Specific Templates

Read the following template file only when matching the user request:

- [Tech Explainer](templates/tech-explainer.md) -- for converting technical documentation and tutorials

## Notes

- The script JSON locale should match the content language
- Technical content should be simplified for audio accessibility
- Complex notations (formulas, code) should be translated to plain language
- Long content may result in longer podcasts
