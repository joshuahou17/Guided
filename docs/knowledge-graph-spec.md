# Guided V2 — Knowledge Graph Architecture

## Repo

https://github.com/joshuahou17/Guided

Clone this repo and work from it. This is a macOS Electron app that uses the Claude Computer Use API to provide live, step-by-step onboarding guidance with screen annotations.

## The Problem

Currently, Guided requires all context about an application to be processed/provided upfront before the model can guide a user. This means:
- The model lacks sufficient context about the specific app the user is looking at
- Frontloading raw documentation is slow, expensive, and noisy
- The system doesn't get smarter over time
- Context windows get stuffed with full doc pages when the model only needs a few relevant paragraphs

## The Vision

Build a **knowledge graph system** where each application has a structured, traversable graph of knowledge. Instead of dumping raw docs into context, we query the graph for precisely the nodes relevant to what the user is currently looking at. The flow becomes:

```
Screenshot → Identify App + View → Query Knowledge Graph → Inject Relevant Subgraph → Guide
```

Users can download pre-built knowledge graphs ("Guides") for popular apps. Graphs grow richer over time through automated research and usage.

---

## Core Architecture

### 1. Knowledge Graph Schema

Each application gets its own knowledge graph stored as a local JSON file. The graph is made up of **nodes** and **edges**.

#### Node Types

```typescript
type NodeType =
  | "feature"       // e.g., "Auto Layout", "Formulas", "Channels"
  | "ui_element"    // e.g., "Properties Panel", "Sidebar", "Toolbar"
  | "task"          // e.g., "Create a new frame", "Share a document"
  | "concept"       // e.g., "Components vs Instances", "Workspace hierarchy"
  | "shortcut"      // e.g., "Cmd+D to duplicate", "/ for slash commands"
  | "setting"       // e.g., "Dark mode", "Notification preferences"
  | "troubleshoot"  // e.g., "Fix: fonts not loading", "Fix: sync conflicts"

interface KnowledgeNode {
  id: string;                    // unique, e.g., "figma:auto-layout"
  type: NodeType;
  name: string;                  // human-readable: "Auto Layout"
  summary: string;               // 1-3 sentence explanation — the actual guidance content
  steps?: string[];              // ordered steps if this is a how-to task
  keywords: string[];            // for search/matching: ["auto layout", "responsive", "flex"]
  views: string[];               // which UI views/pages this node is relevant to: ["editor", "properties-panel"]
  sources: string[];             // URLs where this knowledge came from
  confidence: number;            // 0-1, how well-sourced this node is
  lastUpdated: string;           // ISO timestamp
  userNotes?: string;            // user-added annotations
}
```

#### Edge Types

```typescript
type EdgeType =
  | "prerequisite_for"   // must understand A before B
  | "located_in"         // UI element A is inside UI element B
  | "shortcut_for"       // shortcut A triggers feature B
  | "related_to"         // general relevance
  | "part_of"            // A is a sub-feature of B
  | "solves"             // troubleshoot node A solves problem with feature B

interface KnowledgeEdge {
  source: string;        // node ID
  target: string;        // node ID
  type: EdgeType;
  weight: number;        // 0-1, strength of relationship (can be boosted by usage)
}
```

#### Full Graph File

```typescript
interface AppKnowledgeGraph {
  appName: string;
  appType: "web" | "desktop" | "mobile";
  version?: string;
  description: string;
  graphVersion: number;          // increment on structural changes
  createdAt: string;
  lastEnriched: string;          // last time research agent added to graph
  nodeCount: number;
  nodes: Record<string, KnowledgeNode>;
  edges: KnowledgeEdge[];
  viewIndex: Record<string, string[]>;  // view name → array of relevant node IDs (precomputed for fast lookup)
}
```

Example path: `~/.guided/graphs/figma.json`

### 2. Screenshot → App Identification

On session start or when the user asks for help:

1. Capture a screenshot of the user's current screen
2. Send to Claude (Sonnet) with prompt:

```
Identify the application shown in this screenshot. Return a JSON object:
{
  "appName": "exact application name",
  "appType": "web|desktop|mobile",
  "currentView": "specific page/screen/panel the user is on, be descriptive",
  "url": "if visible in browser address bar, otherwise null",
  "version": "if visible, otherwise null",
  "visibleElements": ["list", "of", "key", "UI", "elements", "you", "can", "see"],
  "userState": "brief description of what the user appears to be doing or trying to do"
}
```

3. Use `appName` to look up the local knowledge graph file
4. If multiple apps/windows are visible, ask the user which one they need help with

### 3. Graph Query Layer

This is the critical piece that replaces raw doc injection. Given the identified app + current view, pull the relevant subgraph.

```typescript
interface GraphQuery {
  appName: string;
  currentView: string;           // from app identification
  visibleElements: string[];     // from app identification
  userIntent?: string;           // if the user said what they want to do
  maxNodes: number;              // budget — keep this small (15-25 nodes)
  maxTokens: number;             // target context size (~2000-3000 tokens)
}

interface QueryResult {
  relevantNodes: KnowledgeNode[];
  relevantEdges: KnowledgeEdge[];
  contextDocument: string;        // pre-formatted text ready to inject into system prompt
}
```

#### Query Algorithm

```
1. EXACT VIEW MATCH: Look up `viewIndex[currentView]` → get directly relevant node IDs
2. KEYWORD MATCH: Match `visibleElements` and `userIntent` against node `keywords`
3. EDGE TRAVERSAL: From matched nodes, traverse 1-2 hops along edges:
   - Always include `prerequisite_for` targets (user needs to understand these)
   - Always include `shortcut_for` sources (useful tips)
   - Include `located_in` parents (orientation context)
   - Include `related_to` if within token budget
4. RANK: Score nodes by (confidence × edge_weight × recency) and take top N
5. FORMAT: Render the subgraph into a concise context document
```

#### Context Document Format

The output of the query gets injected into the guidance model's system prompt:

```
## Application: {appName}
## Current View: {currentView}

### Key Concepts
- **{concept.name}**: {concept.summary}

### Relevant Features
- **{feature.name}**: {feature.summary}
  - Shortcut: {shortcut if exists}
  - Prerequisites: {prerequisites if any}

### How-To Tasks (for this view)
- **{task.name}**: {task.steps joined as numbered list}

### Common Issues
- **{troubleshoot.name}**: {troubleshoot.summary}

### Tips
- {shortcut.name}: {shortcut.summary}
```

Target: **2000-3000 tokens max**. Instead of 20K tokens of raw docs, the model gets a tight, relevant knowledge injection.

### 4. Research Agent (Graph Builder + Enricher)

The research agent's job is to **build and enrich knowledge graphs**. It runs in two modes:

#### Mode A: Initial Graph Build (for new apps or downloadable guide creation)

When no graph exists for an app, or when pre-building a downloadable guide:

1. **Search for documentation sources** using web search:
   - `"{appName} official documentation"`
   - `"{appName} getting started guide"`
   - `"{appName} keyboard shortcuts"`
   - `"{appName} common tasks tutorial"`
   - `"{appName} troubleshooting FAQ"`
   - `"{appName} tips and tricks"`
   - `"how to use {appName}" site:reddit.com OR site:stackoverflow.com`

2. **Fetch and process top sources** (5-10 pages):
   - Fetch each URL
   - Extract useful text (strip nav, ads, chrome)
   - Send to Claude (Sonnet) with the graph schema and prompt:

```
You are building a knowledge graph for {appName}. Given this documentation page, extract knowledge nodes and edges.

For each piece of useful knowledge, create a node with:
- A clear type (feature, task, concept, shortcut, ui_element, setting, troubleshoot)
- A concise 1-3 sentence summary (this will be the guidance content — make it actionable)
- Steps if it's a task
- Keywords for search matching
- Which UI views/pages this is relevant to

Also identify relationships between nodes (prerequisites, shortcuts, containment, etc.)

Return as JSON matching the schema. Aim for 10-30 nodes per source page. Prioritize actionable, practical knowledge over conceptual overviews.
```

3. **Merge nodes** from multiple sources:
   - Deduplicate by matching on name + keywords
   - When duplicates found, keep the higher-confidence version or merge summaries
   - Combine sources arrays

4. **Build the view index**:
   - For each unique view mentioned across all nodes, collect the relevant node IDs
   - This is the precomputed lookup table for fast retrieval

5. **Save the graph** to `~/.guided/graphs/{appName}.json`

#### Mode B: Incremental Enrichment (during usage)

Every time a user sessions with an app:

1. After app identification, check if the current view has sparse coverage in the graph (few nodes in `viewIndex`)
2. If sparse, trigger a **targeted research** for just that view:
   - `"{appName} {currentView} how to"`
   - `"{appName} {currentView} tutorial"`
3. Process results and merge new nodes into the existing graph
4. After the guidance session, record which nodes were actually used → boost their edge weights
5. If the user asks a question the graph can't answer, log it as a "gap" for future enrichment

### 5. Downloadable Guides System

#### Guide Catalog

Maintain a remote catalog (can be a simple JSON hosted on GitHub or a CDN):

```typescript
interface GuideCatalog {
  version: number;
  guides: GuideEntry[];
}

interface GuideEntry {
  appName: string;
  appType: "web" | "desktop" | "mobile";
  description: string;
  nodeCount: number;
  fileSize: number;               // bytes
  graphVersion: number;
  lastUpdated: string;
  downloadUrl: string;            // URL to the graph JSON file
  icon?: string;                  // URL to app icon
  categories: string[];           // e.g., ["design", "productivity", "development"]
  popularity: number;             // download count or rating
}
```

#### In-App Guide Manager UI

Build a view in the Electron app where users can:
- Browse available guides by category
- See which guides they've downloaded
- Download / update / delete guides
- See guide "freshness" (last enriched date)
- Eventually: upload community-contributed guides

#### Storage

```
~/.guided/
  graphs/                  # knowledge graph files
    figma.json
    notion.json
    slack.json
    ...
  cache/                   # temporary research cache
    research-sessions/
  catalog.json             # cached remote catalog
  user-data.json           # user preferences, completed tasks, custom notes
```

### 6. Integration with Guidance Flow

The existing Computer Use guidance loop stays the same, but the system prompt changes. Instead of raw documentation or no context, inject the graph query result:

```
You are helping a user navigate {appName}. You have deep knowledge of this application loaded below.

CURRENT STATE:
- The user is on: {currentView}
- Visible elements: {visibleElements}
- User intent: {userIntent or "exploring / not specified"}

APPLICATION KNOWLEDGE (from knowledge graph):
{contextDocument from graph query — ~2000-3000 tokens}

INSTRUCTIONS:
- Guide the user step by step using the knowledge above
- Reference specific UI elements by name
- Mention keyboard shortcuts when relevant
- If the user's question goes beyond what's in the knowledge above, say so and offer to research further
- Keep steps concrete and actionable — "Click the blue + button in the top-left toolbar" not "Create a new item"
```

### 7. Session-Over-Session Learning

Track usage patterns to make the graph and guidance smarter:

```typescript
interface UserAppProfile {
  appName: string;
  sessionsCount: number;
  completedTasks: string[];       // node IDs of task nodes the user has done
  frequentViews: Record<string, number>;  // view → visit count
  knowledgeGaps: string[];        // questions the graph couldn't answer
  skillLevel: "beginner" | "intermediate" | "advanced";  // inferred from usage
  customNotes: Record<string, string>;  // user annotations on nodes
}
```

- **Skip basics**: if the user has completed beginner tasks, don't re-explain them
- **Adapt depth**: advanced users get power-user tips; beginners get step-by-step
- **Fill gaps**: periodically run enrichment on logged `knowledgeGaps`
- **Boost relevance**: nodes/edges that get used often have higher weight in ranking

---

## Model Selection

- **App Identification** (screenshot → JSON): **Sonnet** — fast, good vision, cheap
- **Research Agent** (search + fetch + extract nodes): **Sonnet** — bulk processing of doc pages
- **Graph Query** (subgraph retrieval): **No model needed** — pure local code (JSON traversal + keyword matching)
- **Guidance Loop** (step-by-step with annotations): **Sonnet via Computer Use API** (same as current)

The entire point of the knowledge graph is that the expensive reasoning happens once (during graph building) and then gets reused across every session as cheap local lookups. The model runs faster because it receives 2-3K tokens of focused context instead of 15-20K of raw docs.

---

## Suggested File Structure

```
src/
  knowledge/
    schema.ts              — TypeScript types for the graph schema (nodes, edges, etc.)
    graphStore.ts           — CRUD operations on graph files (load, save, merge nodes)
    graphQuery.ts           — query algorithm: view + keywords → relevant subgraph
    contextFormatter.ts     — render subgraph into text for system prompt injection
  research/
    appIdentifier.ts        — screenshot → app identification via Claude
    researchAgent.ts        — web search + fetch + node extraction loop
    nodeExtractor.ts        — prompt + parse logic for extracting nodes from doc pages
    enrichment.ts           — incremental enrichment during sessions
  guides/
    catalog.ts              — fetch remote catalog, check for updates
    guideManager.ts         — download, update, delete guide files
    guideManagerUI/         — Electron UI for browsing/managing guides
  guidance/
    (existing guidance code, modified to use graph context)
  storage/
    paths.ts                — file path constants (~/.guided/graphs/, etc.)
    userProfile.ts          — per-app user profile tracking
```

---

## Implementation Order

1. **Read the existing codebase** — understand current flow: main.js, src/, how screenshots and Claude API calls work today
2. **Define the schema** — implement `schema.ts` with all TypeScript types
3. **Build the graph store** — load/save/merge operations on graph JSON files
4. **Build the graph query layer** — the algorithm that takes a view + keywords and returns a relevant subgraph with formatted context
5. **Build app identification** — screenshot → structured app info
6. **Build the research agent** — search + fetch + node extraction → full graph build
7. **Wire into guidance flow** — replace current context injection with graph query results
8. **Build incremental enrichment** — sparse view detection, targeted research, usage tracking
9. **Build the guide manager** — catalog, download UI, storage management
10. **Test end-to-end**: open an app → screenshot → graph lookup → focused context → fast guidance

---

## What NOT to Change

- Don't change the core annotation/overlay system
- Don't change the Electron app shell or IPC structure unless necessary
- Keep the existing UI/UX for the guidance overlay
- The knowledge graph is an additive layer that feeds into the existing flow

---

## Key Design Principles

- **Small context, high relevance**: never inject more than ~3000 tokens of graph context. If the subgraph is larger, rank and truncate.
- **Offline-first**: graphs are local JSON files. The app works without internet after guides are downloaded. Research/enrichment requires internet but is not blocking.
- **Composable**: each layer (identification, graph query, research, guidance) should be independently testable.
- **Incremental**: graphs start sparse and get richer. Don't block the user waiting for a "complete" graph — guide with what you have and enrich in the background.
