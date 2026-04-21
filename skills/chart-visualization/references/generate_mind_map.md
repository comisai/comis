# generate_mind_map — Mind Map

## Overview
Expands 2-3 levels of branches around a central topic, helps organize ideas, plans, or knowledge structures, commonly used for brainstorming and project planning.

## Input Fields
### Required
- `data`: object, required, each node must contain at least `name`, and can be recursively expanded via `children` (array<object>); recommended depth is 3 or fewer levels.

### Optional
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.

## Usage Tips
Write the topic in the central node; first-level branches represent main dimensions (goals, resources, risks, etc.); use short phrases for leaf nodes; if there are many branches, consider splitting into multiple mind maps.

## Output
- Returns a mind map URL, with the node tree preserved in `_meta.spec` for subsequent refinement.
