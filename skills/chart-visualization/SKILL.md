---
name: chart-visualization
description: Generate data visualizations and charts from user data. Supports 26 chart types including line, bar, pie, scatter, treemap, sankey, radar, funnel, maps, org charts, mind maps, network graphs, and more. Use this skill whenever the user wants to visualize data, create a chart, plot a graph, make a diagram, display metrics, or show data visually -- even if they don't explicitly say "chart" or "visualization".
comis:
  requires:
    bins: ["node"]
---

# Chart Visualization

Generate charts and data visualizations from user data. Selects the best chart type from 26 options, extracts parameters from detailed specs, and generates a chart image via a bundled Node.js script.

All script paths below are relative to this skill's directory. Resolve them against the `<location>` shown in the available skills listing (e.g., if the skill location is `~/.comis/skills/chart-visualization`, then `scripts/generate.js` means `~/.comis/skills/chart-visualization/scripts/generate.js`).

## Workflow

### 1. Select chart type

Analyze the user's data to determine the best chart type:

- **Time series**: `generate_line_chart` (trends), `generate_area_chart` (accumulated), `generate_dual_axes_chart` (two scales)
- **Comparisons**: `generate_bar_chart` (categorical), `generate_column_chart`, `generate_histogram_chart` (frequency)
- **Part-to-whole**: `generate_pie_chart`, `generate_treemap_chart` (hierarchical)
- **Relationships & flow**: `generate_scatter_chart` (correlation), `generate_sankey_chart` (flow), `generate_venn_chart` (overlap)
- **Maps**: `generate_district_map` (regions), `generate_pin_map` (points), `generate_path_map` (routes)
- **Hierarchies**: `generate_organization_chart`, `generate_mind_map`
- **Specialized**: `generate_radar_chart` (multi-dimensional), `generate_funnel_chart` (stages), `generate_liquid_chart` (percentage), `generate_word_cloud_chart` (text frequency), `generate_boxplot_chart` / `generate_violin_chart` (distribution), `generate_network_graph` (node-edge), `generate_fishbone_diagram` (cause-effect), `generate_flow_diagram` (process), `generate_spreadsheet` (tabular/pivot)

### 2. Extract parameters

Read the corresponding file in `references/` (e.g., `references/generate_line_chart.md`) to identify required and optional fields. Map the user's data to the expected `args` format.

### 3. Generate chart

Build a JSON payload and invoke the script:

```json
{
  "tool": "generate_chart_type_name",
  "args": {
    "data": [...],
    "title": "...",
    "theme": "...",
    "style": { ... }
  }
}
```

```bash
node scripts/generate.js '<payload_json>'
```

### 4. Return result

The script outputs the URL of the generated chart image. Return the image URL and the `args` spec used for generation to the user.

## Reference Material

Detailed specifications for each chart type are in the `references/` directory. Consult these to ensure `args` match the expected schema.
