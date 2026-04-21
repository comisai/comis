---
name: image-generation
description: Generate images using structured prompts and optional reference images. Supports character design, scenes, product visualization, and any visual content creation. Use this skill when the user requests to generate, create, imagine, draw, or visualize images, characters, portraits, scenes, products, or any visual content -- even if they don't explicitly say "generate an image".
comis:
  requires:
    bins: ["python3"]
    env: ["GEMINI_API_KEY"]
---

# Image Generation

Generate high-quality images using structured JSON prompts and a bundled Python script. Supports reference images for style and composition guidance.

All script paths below are relative to this skill's directory. Resolve them against the `<location>` shown in the available skills listing (e.g., if the skill location is `~/.comis/skills/image-generation`, then `scripts/generate.py` means `~/.comis/skills/image-generation/scripts/generate.py`).

Write prompt files and generated outputs to your workspace directory (shown in the "Workspace" section of your system prompt).

The bundled script requires `requests` and `Pillow` Python packages (`pip install requests Pillow`).

## Workflow

### Step 1: Understand requirements

Identify from the user's request:
- **Subject/content**: What should be in the image
- **Style preferences**: Art style, mood, color palette
- **Technical specs**: Aspect ratio, composition, lighting
- **Reference images**: Any images to guide generation

### Step 2: Create structured prompt

Write a JSON prompt file to your workspace directory with a descriptive filename like `{subject-name}.json`.

### Step 3: Execute generation

```bash
python3 scripts/generate.py \
  --prompt-file ~/.comis/workspace/prompt-file.json \
  --output-file ~/.comis/workspace/generated-image.jpg \
  --aspect-ratio 16:9
```

With reference images:
```bash
python3 scripts/generate.py \
  --prompt-file ~/.comis/workspace/prompt-file.json \
  --reference-images /path/to/ref1.jpg /path/to/ref2.png \
  --output-file ~/.comis/workspace/generated-image.jpg \
  --aspect-ratio 2:3
```

Parameters:
- `--prompt-file`: Path to JSON prompt file (required)
- `--reference-images`: Paths to reference images (optional, space-separated)
- `--output-file`: Path to output image file (required)
- `--aspect-ratio`: Aspect ratio (optional, default: 16:9)

Do NOT read the Python script -- just call it with the parameters.

## Prompt JSON Format

### Character design

```json
{
  "characters": [{
    "gender": "female",
    "age": "mid-20s",
    "ethnicity": "Japanese",
    "body_type": "slender, elegant",
    "facial_features": "delicate features, expressive eyes, long dark hair",
    "clothing": "stylish trench coat, high heels, contemporary street fashion",
    "accessories": "minimal jewelry, statement earrings, leather handbag",
    "era": "1990s"
  }],
  "negative_prompt": "blurry face, deformed, low quality, oversaturated",
  "style": "Leica M11 street photography aesthetic, film-like rendering, natural color palette",
  "composition": "medium shot, rule of thirds, subject slightly off-center, shallow depth of field",
  "lighting": "neon lights, wet pavement reflections, soft ambient city glow",
  "color_palette": "muted naturalistic tones, warm skin tones, cool blue and magenta neon accents"
}
```

### With reference images

Use `[Image N]` placeholders in the JSON to reference provided images by order:

```json
{
  "characters": [{
    "gender": "based on [Image 1]",
    "facial_features": "matching [Image 1] with slight weathered look",
    "clothing": "Star Wars style outfit - worn leather jacket, cargo pants"
  }],
  "prompt": "Character inspired by [Image 1] standing next to a vehicle inspired by [Image 2]...",
  "style": "Star Wars original trilogy aesthetic, practical effects inspired"
}
```

### Scene generation

Include environment description, time of day, weather, mood, atmosphere, focal points, and composition.

### Product visualization

Include product details, materials, lighting setup, background/context, and presentation angle.

## Specific Templates

Read the following template file only when matching the user request:

- [Doraemon Comic](templates/doraemon.md)

## Notes

- Always use English for prompts regardless of user's language
- JSON format ensures structured, parsable prompts
- Reference images enhance generation quality significantly
- Iterative refinement is normal for optimal results
- For character generation, include the detailed character object plus a consolidated prompt field
