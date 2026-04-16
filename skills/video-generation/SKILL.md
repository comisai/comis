---
name: video-generation
description: Generate videos using structured prompts and optional reference images. Supports scene generation with camera, dialogue, and audio specifications. Use this skill when the user requests to generate, create, or produce videos, clips, animations, or motion content -- even if they just say "make a video of X" or "animate this".
comis:
  requires:
    bins: ["python3"]
    env: ["GEMINI_API_KEY"]
---

# Video Generation

Generate high-quality videos using structured JSON prompts and a bundled Python script. Supports a reference image as guidance or as the first/last frame.

All script paths below are relative to this skill's directory. Resolve them against the `<location>` shown in the available skills listing (e.g., if the skill location is `~/.comis/skills/video-generation`, then `scripts/generate.py` means `~/.comis/skills/video-generation/scripts/generate.py`).

Write prompt files and generated outputs to your workspace directory (shown in the "Workspace" section of your system prompt).

The bundled script requires the `requests` Python package (`pip install requests`).

## Workflow

### Step 1: Understand requirements

Identify from the user's request:
- **Subject/content**: What should be in the video
- **Style preferences**: Art style, mood, color palette
- **Technical specs**: Aspect ratio, composition, lighting
- **Reference image**: Any image to guide generation

### Step 2: Create structured prompt

Write a JSON prompt file to your workspace directory with naming pattern `{descriptive-name}.json`.

### Step 3: Create reference image (optional)

If the image-generation skill is available, generate a reference image first. A single reference image is used as the guided frame of the video.

### Step 4: Execute generation

```bash
python3 scripts/generate.py \
  --prompt-file ~/.comis/workspace/prompt-file.json \
  --output-file ~/.comis/workspace/generated-video.mp4 \
  --aspect-ratio 16:9
```

With reference image:
```bash
python3 scripts/generate.py \
  --prompt-file ~/.comis/workspace/prompt-file.json \
  --reference-images /path/to/ref.jpg \
  --output-file ~/.comis/workspace/generated-video.mp4 \
  --aspect-ratio 16:9
```

Parameters:
- `--prompt-file`: Path to JSON prompt file (required)
- `--reference-images`: Path to reference image (optional)
- `--output-file`: Path to output video file (required)
- `--aspect-ratio`: Aspect ratio (optional, default: 16:9)

Do NOT read the Python script -- just call it with the parameters.

## Prompt JSON Format

```json
{
  "title": "Scene Title",
  "background": {
    "description": "Environment description with era, mood, atmosphere",
    "era": "Time period",
    "location": "Setting location"
  },
  "characters": ["Character A", "Character B"],
  "camera": {
    "type": "Close-up two-shot",
    "movement": "Static with subtle handheld movement",
    "angle": "Profile view, intimate framing",
    "focus": "Both faces in focus, background soft bokeh"
  },
  "dialogue": [
    {"character": "Character A", "text": "Dialogue line..."},
    {"character": "Character B", "text": "Response line..."}
  ],
  "audio": [
    {"type": "Ambient sound description", "volume": 1},
    {"type": "Music description", "volume": 0.5}
  ]
}
```

## Notes

- Always use English for prompts regardless of user's language
- JSON format ensures structured, parsable prompts
- Reference images enhance generation quality significantly
- Iterative refinement is normal for optimal results
