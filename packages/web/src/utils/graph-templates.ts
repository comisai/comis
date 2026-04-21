// SPDX-License-Identifier: Apache-2.0
/**
 * Pre-built graph template definitions for the pipeline builder.
 *
 * Each template is a factory function returning valid PipelineNode/PipelineEdge
 * arrays with positions, ready to be loaded into the graph builder state.
 * The GRAPH_TEMPLATES array is consumed by the template picker modal.
 */

import type {
  PipelineNode,
  PipelineEdge,
  GraphSettings,
} from "../api/types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Descriptor for a pre-built graph template */
export interface GraphTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly nodeCount: string;
  readonly icon: string;
  readonly create: () => {
    nodes: PipelineNode[];
    edges: PipelineEdge[];
    settings: Partial<GraphSettings>;
  };
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/** Linear chain: A -> B -> C (3 nodes, sequential) */
export function createLinearChainTemplate(): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: Partial<GraphSettings>;
} {
  const nodes: PipelineNode[] = [
    {
      id: "step-1",
      task: "Research the latest developments in renewable energy technology. Focus on solar, wind, and battery storage advances from the past year.",
      dependsOn: [],
      position: { x: 300, y: 50 },
    },
    {
      id: "step-2",
      task: "Analyze the research findings and identify the top 3 most promising technologies.\n\nResearch data:\n{{step-1.result}}",
      dependsOn: ["step-1"],
      position: { x: 300, y: 220 },
    },
    {
      id: "step-3",
      task: "Write a concise executive summary based on the analysis.\n\nAnalysis:\n{{step-2.result}}",
      dependsOn: ["step-2"],
      position: { x: 300, y: 390 },
    },
  ];
  const edges: PipelineEdge[] = [
    { id: "step-1->step-2", source: "step-1", target: "step-2" },
    { id: "step-2->step-3", source: "step-2", target: "step-3" },
  ];
  return { nodes, edges, settings: { label: "Linear Chain" } };
}

/** Fan-out/Fan-in: start -> {worker-1, worker-2} -> merge (4 nodes) */
export function createFanOutFanInTemplate(): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: Partial<GraphSettings>;
} {
  const nodes: PipelineNode[] = [
    {
      id: "start",
      task: "Define the key aspects to investigate about the given topic. List 2 focus areas, one per line.",
      dependsOn: [],
      position: { x: 300, y: 50 },
    },
    {
      id: "worker-1",
      task: "Investigate the first focus area from the plan. Provide detailed findings.\n\nPlan:\n{{start.result}}",
      dependsOn: ["start"],
      position: { x: 180, y: 220 },
    },
    {
      id: "worker-2",
      task: "Investigate the second focus area from the plan. Provide detailed findings.\n\nPlan:\n{{start.result}}",
      dependsOn: ["start"],
      position: { x: 420, y: 220 },
    },
    {
      id: "merge",
      task: "Synthesize both sets of findings into a unified report.\n\nFindings 1:\n{{worker-1.result}}\n\nFindings 2:\n{{worker-2.result}}",
      dependsOn: ["worker-1", "worker-2"],
      position: { x: 300, y: 390 },
    },
  ];
  const edges: PipelineEdge[] = [
    { id: "start->worker-1", source: "start", target: "worker-1" },
    { id: "start->worker-2", source: "start", target: "worker-2" },
    { id: "worker-1->merge", source: "worker-1", target: "merge" },
    { id: "worker-2->merge", source: "worker-2", target: "merge" },
  ];
  return { nodes, edges, settings: { label: "Fan-out Fan-in" } };
}

/** Parallel tracks: two independent streams {a->b} and {c->d} side by side (4 nodes) */
export function createParallelTracksTemplate(): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: Partial<GraphSettings>;
} {
  const nodes: PipelineNode[] = [
    {
      id: "track-a1",
      task: "Gather quantitative data and statistics on the topic.",
      dependsOn: [],
      position: { x: 200, y: 50 },
    },
    {
      id: "track-a2",
      task: "Create charts and visualizations from the quantitative data.\n\nData:\n{{track-a1.result}}",
      dependsOn: ["track-a1"],
      position: { x: 200, y: 220 },
    },
    {
      id: "track-b1",
      task: "Collect qualitative insights and expert opinions on the topic.",
      dependsOn: [],
      position: { x: 450, y: 50 },
    },
    {
      id: "track-b2",
      task: "Summarize the qualitative insights into key themes.\n\nInsights:\n{{track-b1.result}}",
      dependsOn: ["track-b1"],
      position: { x: 450, y: 220 },
    },
  ];
  const edges: PipelineEdge[] = [
    { id: "track-a1->track-a2", source: "track-a1", target: "track-a2" },
    { id: "track-b1->track-b2", source: "track-b1", target: "track-b2" },
  ];
  return { nodes, edges, settings: { label: "Parallel Tracks" } };
}

/** Independent workers: 3 unconnected nodes spread horizontally (3 nodes, 0 edges) */
export function createIndependentWorkersTemplate(): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: Partial<GraphSettings>;
} {
  const nodes: PipelineNode[] = [
    {
      id: "worker-1",
      task: "Monitor social media channels for brand mentions and sentiment.",
      dependsOn: [],
      position: { x: 150, y: 100 },
    },
    {
      id: "worker-2",
      task: "Check system health dashboards and report any anomalies.",
      dependsOn: [],
      position: { x: 350, y: 100 },
    },
    {
      id: "worker-3",
      task: "Review and categorize incoming support tickets by priority.",
      dependsOn: [],
      position: { x: 550, y: 100 },
    },
  ];
  return { nodes, edges: [], settings: { label: "Independent Workers" } };
}

/** Diamond: A -> {B, C} -> D (4 nodes, diamond topology) */
export function createDiamondTemplate(): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: Partial<GraphSettings>;
} {
  const nodes: PipelineNode[] = [
    {
      id: "top",
      task: "Break down the project requirements into technical and business categories.",
      dependsOn: [],
      position: { x: 300, y: 50 },
    },
    {
      id: "left",
      task: "Evaluate the technical requirements and estimate implementation effort.\n\nRequirements:\n{{top.result}}",
      dependsOn: ["top"],
      position: { x: 180, y: 220 },
    },
    {
      id: "right",
      task: "Assess the business requirements and estimate business value.\n\nRequirements:\n{{top.result}}",
      dependsOn: ["top"],
      position: { x: 420, y: 220 },
    },
    {
      id: "bottom",
      task: "Create a prioritized roadmap combining technical effort and business value.\n\nTechnical evaluation:\n{{left.result}}\n\nBusiness evaluation:\n{{right.result}}",
      dependsOn: ["left", "right"],
      position: { x: 300, y: 390 },
    },
  ];
  const edges: PipelineEdge[] = [
    { id: "top->left", source: "top", target: "left" },
    { id: "top->right", source: "top", target: "right" },
    { id: "left->bottom", source: "left", target: "bottom" },
    { id: "right->bottom", source: "right", target: "bottom" },
  ];
  return { nodes, edges, settings: { label: "Diamond" } };
}

/** Debate: Two agents debate a topic, synthesizer produces final answer (3 nodes) */
export function createDebateTemplate(): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: Partial<GraphSettings>;
} {
  const nodes: PipelineNode[] = [
    {
      id: "research",
      task: "Research the given topic and prepare a comprehensive briefing document with key facts, statistics, and relevant context.",
      dependsOn: [],
      position: { x: 300, y: 50 },
    },
    {
      id: "debate",
      task: "Debate the implications and best course of action based on the research.\n\nResearch briefing:\n{{research.result}}",
      dependsOn: ["research"],
      typeId: "debate",
      typeConfig: { agents: [], rounds: 2 },
      position: { x: 300, y: 220 },
    },
    {
      id: "conclusion",
      task: "Based on the debate transcript, write a balanced conclusion with actionable recommendations.\n\nDebate outcome:\n{{debate.result}}",
      dependsOn: ["debate"],
      position: { x: 300, y: 390 },
    },
  ];
  const edges: PipelineEdge[] = [
    { id: "research->debate", source: "research", target: "debate" },
    { id: "debate->conclusion", source: "debate", target: "conclusion" },
  ];
  return { nodes, edges, settings: { label: "Debate Pipeline" } };
}

/** Vote Pipeline: Research, parallel voting, then summarize results (3 nodes) */
export function createVotePipelineTemplate(): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: Partial<GraphSettings>;
} {
  const nodes: PipelineNode[] = [
    {
      id: "research",
      task: "Research the given topic thoroughly and prepare a comprehensive briefing with key facts and arguments for and against.",
      dependsOn: [],
      position: { x: 300, y: 50 },
    },
    {
      id: "vote",
      task: "Based on the research, vote on the best course of action.\n\nResearch briefing:\n{{research.result}}",
      dependsOn: ["research"],
      typeId: "vote",
      typeConfig: { voters: [], verdict_format: "YES or NO with one-line justification" },
      position: { x: 300, y: 220 },
    },
    {
      id: "summarize",
      task: "Summarize the voting results and recommend next steps based on the majority decision.\n\nVote results:\n{{vote.result}}",
      dependsOn: ["vote"],
      position: { x: 300, y: 390 },
    },
  ];
  const edges: PipelineEdge[] = [
    { id: "research->vote", source: "research", target: "vote" },
    { id: "vote->summarize", source: "vote", target: "summarize" },
  ];
  return { nodes, edges, settings: { label: "Vote Pipeline" } };
}

/** Refine Chain: Draft, sequential review, then publish (3 nodes) */
export function createRefineChainTemplate(): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: Partial<GraphSettings>;
} {
  const nodes: PipelineNode[] = [
    {
      id: "draft",
      task: "Write a first draft addressing the given topic. Include all key points but don't worry about polish.",
      dependsOn: [],
      position: { x: 300, y: 50 },
    },
    {
      id: "refine",
      task: "Review and refine the draft. Each reviewer improves upon the previous version.\n\nDraft:\n{{draft.result}}",
      dependsOn: ["draft"],
      typeId: "refine",
      typeConfig: { reviewers: [] },
      position: { x: 300, y: 220 },
    },
    {
      id: "publish",
      task: "Format the refined document for publication. Add headers, sections, and a summary.\n\nRefined content:\n{{refine.result}}",
      dependsOn: ["refine"],
      position: { x: 300, y: 390 },
    },
  ];
  const edges: PipelineEdge[] = [
    { id: "draft->refine", source: "draft", target: "refine" },
    { id: "refine->publish", source: "refine", target: "publish" },
  ];
  return { nodes, edges, settings: { label: "Refine Chain" } };
}

/** Map-Reduce: Plan, parallel analysis, then synthesize (3 nodes) */
export function createMapReduceTemplate(): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: Partial<GraphSettings>;
} {
  const nodes: PipelineNode[] = [
    {
      id: "plan",
      task: "Break the topic into distinct sub-topics that can be researched independently. List each sub-topic clearly.",
      dependsOn: [],
      position: { x: 300, y: 50 },
    },
    {
      id: "analyze",
      task: "Each mapper researches their assigned sub-topic in depth.\n\nSub-topics:\n{{plan.result}}",
      dependsOn: ["plan"],
      typeId: "map-reduce",
      typeConfig: { mappers: [], reducer: "", reducer_prompt: "Synthesize all mapper outputs into a comprehensive report with sections for each sub-topic." },
      position: { x: 300, y: 220 },
    },
    {
      id: "report",
      task: "Format the synthesized analysis into a polished final report with executive summary.\n\nAnalysis:\n{{analyze.result}}",
      dependsOn: ["analyze"],
      position: { x: 300, y: 390 },
    },
  ];
  const edges: PipelineEdge[] = [
    { id: "plan->analyze", source: "plan", target: "analyze" },
    { id: "analyze->report", source: "analyze", target: "report" },
  ];
  return { nodes, edges, settings: { label: "Map-Reduce Pipeline" } };
}

/** Approval Gate: Prepare action, wait for human approval, then execute (3 nodes) */
export function createApprovalGateTemplate(): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: Partial<GraphSettings>;
} {
  const nodes: PipelineNode[] = [
    {
      id: "prepare",
      task: "Analyze the request and prepare a detailed action plan. Include cost estimates and risk assessment.",
      dependsOn: [],
      position: { x: 300, y: 50 },
    },
    {
      id: "approve",
      task: "Review the action plan and approve or deny execution.\n\nAction plan:\n{{prepare.result}}",
      dependsOn: ["prepare"],
      typeId: "approval-gate",
      typeConfig: { message: "Please review the action plan and reply APPROVE or DENY.", timeout_minutes: 60 },
      position: { x: 300, y: 220 },
    },
    {
      id: "execute",
      task: "Execute the approved action plan.\n\nApproved plan:\n{{prepare.result}}\n\nApproval:\n{{approve.result}}",
      dependsOn: ["approve"],
      position: { x: 300, y: 390 },
    },
  ];
  const edges: PipelineEdge[] = [
    { id: "prepare->approve", source: "prepare", target: "approve" },
    { id: "approve->execute", source: "approve", target: "execute" },
  ];
  return { nodes, edges, settings: { label: "Approval Gate Pipeline" } };
}

/** Blank canvas: empty graph with no nodes or edges */
export function createBlankTemplate(): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  settings: Partial<GraphSettings>;
} {
  return { nodes: [], edges: [], settings: { label: "Untitled Pipeline" } };
}

// ---------------------------------------------------------------------------
// Template catalog
// ---------------------------------------------------------------------------

/** All available graph templates in display order */
export const GRAPH_TEMPLATES: readonly GraphTemplate[] = [
  {
    id: "linear-chain",
    name: "Linear Chain",
    description: "Sequential pipeline: each step depends on the previous one.",
    nodeCount: "3 nodes",
    icon: "\u2193",
    create: createLinearChainTemplate,
  },
  {
    id: "fan-out-fan-in",
    name: "Fan-out Fan-in",
    description: "Parallel workers with a single merge point.",
    nodeCount: "4 nodes",
    icon: "\u2194",
    create: createFanOutFanInTemplate,
  },
  {
    id: "parallel-tracks",
    name: "Parallel Tracks",
    description: "Two independent streams running side by side.",
    nodeCount: "4 nodes",
    icon: "\u2261",
    create: createParallelTracksTemplate,
  },
  {
    id: "independent-workers",
    name: "Independent Workers",
    description: "Unconnected nodes that run in parallel with no dependencies.",
    nodeCount: "3 nodes",
    icon: "\u2630",
    create: createIndependentWorkersTemplate,
  },
  {
    id: "diamond",
    name: "Diamond",
    description: "Fork into two paths, then converge at the end.",
    nodeCount: "4 nodes",
    icon: "\u25C8",
    create: createDiamondTemplate,
  },
  {
    id: "debate",
    name: "Debate Pipeline",
    description: "Research, multi-agent debate, then synthesize conclusions.",
    nodeCount: "3 nodes",
    icon: "\u2694",
    create: createDebateTemplate,
  },
  {
    id: "vote-pipeline",
    name: "Vote Pipeline",
    description: "Research a topic, have multiple agents vote, then summarize results.",
    nodeCount: "3 nodes",
    icon: "\u2714",
    create: createVotePipelineTemplate,
  },
  {
    id: "refine-chain",
    name: "Refine Chain",
    description: "Draft content, refine through sequential reviewers, then publish.",
    nodeCount: "3 nodes",
    icon: "\u270E",
    create: createRefineChainTemplate,
  },
  {
    id: "map-reduce",
    name: "Map-Reduce",
    description: "Split work across parallel mappers, then reduce into a single output.",
    nodeCount: "3 nodes",
    icon: "\u21C4",
    create: createMapReduceTemplate,
  },
  {
    id: "approval-gate",
    name: "Approval Gate",
    description: "Prepare an action, wait for human approval, then execute.",
    nodeCount: "3 nodes",
    icon: "\u2611",
    create: createApprovalGateTemplate,
  },
  {
    id: "blank",
    name: "Blank Canvas",
    description: "Start from scratch with an empty graph.",
    nodeCount: "0 nodes",
    icon: "\u2795",
    create: createBlankTemplate,
  },
] as const;
