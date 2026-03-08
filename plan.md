# Plan: Workflow-First Context System

## Summary

Rework the context system so Guided plans the optimal workflow upfront, follows it step-by-step, and learns from completed sessions. Currently the model reacts to each screenshot without a plan — it picks the next click based on what it sees, leading to suboptimal paths (8 steps when 3 would do) and confusion when it can't figure out what comes next. The new system: (1) generates a workflow plan before guidance starts, (2) injects the plan into every step so the model stays on track but can adapt, (3) saves successful sessions as workflow nodes in the knowledge graph for future reuse, and (4) tailors research queries to the user's specific goal.

## Root Cause Analysis

### Why the model gives suboptimal workflows
1. **No plan** — the model sees one screenshot at a time and improvises the next step. It doesn't know the full path from A to Z.
2. **Generic research** — search queries are "Spotify documentation getting started," not "Spotify how to create playlist and add description." The research doesn't surface the specific workflow the user needs.
3. **No memory of past sessions** — even if the user completed the exact same goal before, the model starts from scratch every time.
4. **Graph has no workflow concept** — the knowledge graph stores features, UI elements, shortcuts, etc., but not ordered multi-step sequences for specific goals.

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/prompt-builder.js` | Add `buildPlanningPrompt()`; modify `buildSystemPrompt()` to accept + inject workflow plan; update step message to reference plan position |
| `src/core/session-loop.js` | Add `planWorkflow()` call at session start (parallel with screenshot); await plan before API call; save completed sessions as workflow nodes |
| `src/core/claude-client.js` | No changes — already has `sendChatRequest()` for Haiku calls |
| `src/core/response-parser.js` | No changes — model follows plan naturally, no new tags needed |
| `src/knowledge/schema.js` | Add `workflow` node type |
| `src/knowledge/node-extractor.js` | Add workflow extraction from research results |
| `src/knowledge/graph-query.js` | Add `querySimilarWorkflows()` — fuzzy goal matching |
| `src/knowledge/context-formatter.js` | Add workflow formatting for plan context |
| `src/knowledge/graph-builder.js` | Handle workflow node merging |
| `src/knowledge/graph-store.js` | Add `addWorkflowNode()` helper for session learning |
| `src/research/researchAgent.js` | Make query 3 goal-aware instead of view-aware |

## Implementation Steps

### Phase 1: Workflow Planning

The highest-impact change. Adds an upfront planning call that gives the model a roadmap.

- [x] **1.1** Add `buildPlanningPrompt()` to `prompt-builder.js`
  - Inputs: `appName`, `goal`, `appGuide`, `currentView`, `similarWorkflows`
  - System prompt: "You are a workflow planner for software applications. Given a user's goal and context about the app, plan the most efficient step-by-step workflow."
  - User prompt includes:
    - Goal
    - App guide (if available)
    - Current view description
    - Similar past workflows (if any, from graph)
  - Instructions: "Return a JSON array of concise step strings. Each step is one action (click, type, navigate). Be specific about what UI element to interact with. Aim for the shortest path."
  - Returns the formatted prompt (system + user message)

- [x] **1.2** Add `planWorkflow()` to `session-loop.js`
  - Called after app identification, before `runStep()`
  - Gathers: app guide (from profile), cached research context, similar workflows (from graph)
  - Calls `sendChatRequest()` with planning prompt (Haiku, fast)
  - Parses JSON array from response
  - Returns `string[]` or `null` on failure
  - Logs the plan for debugging

- [x] **1.3** Wire planning into `startSession()`
  - After app identification + session creation:
    ```
    const planPromise = planWorkflow(appInfo, goal, ...);
    ```
  - Store on session: `activeSession.workflowPlan = null; activeSession.planPromise = planPromise;`
  - Planning runs in parallel with research start + first screenshot capture

- [x] **1.4** Await plan in `runStep()` before building system prompt
  - After screenshot capture, before `buildSystemPrompt()`:
    ```
    if (session.planPromise && !session.workflowPlan) {
      session.workflowPlan = await session.planPromise;
      session.planPromise = null;
    }
    ```
  - This way planning overlaps with screenshot capture (~500ms free)
  - If planning fails, `workflowPlan` stays null — no plan injected, graceful fallback

- [x] **1.5** Modify `buildSystemPrompt()` to inject workflow plan
  - Add optional `workflowPlan` parameter (string[] or null)
  - If plan exists, inject after the instruction frame, before graph context:
    ```
    === Workflow Plan ===
    Planned steps to achieve "{goal}":
    1. Click the + button next to "Your Library"
    2. Select "Playlist" from the dropdown
    3. Name the playlist
    ...
    Follow this plan step by step. If the screen shows something different than expected, adapt — the plan is a guide, not a rigid script. When adapting, still aim for the shortest path to the goal.
    === End Workflow Plan ===
    ```
  - Also update `buildSystemPromptWithoutResearch()` to pass plan through

- [x] **1.6** Update step messages to reference plan progress
  - In `buildToolResultMessage()`, if previousInstructions provided, keep existing "Completed steps" section (this naturally shows the model where it is relative to the plan)
  - No additional changes needed — the model can compare completed steps to the plan

### Phase 2: Workflow Nodes in Knowledge Graph

Add `workflow` as a first-class node type so the graph stores reusable workflow sequences.

- [x] **2.1** Add workflow to `schema.js`
  - Add `'workflow'` to `NODE_TYPES` array
  - Workflow nodes use existing schema fields:
    - `name`: goal description (e.g., "Create a playlist and add a description")
    - `summary`: brief description of the workflow
    - `steps`: ordered array of step strings (already in schema)
    - `keywords`: extracted from goal text
    - `views`: which views this workflow starts from
    - `confidence`: 0.9 for session-derived, 0.7 for research-derived
  - Add `completionCount` field to node schema (default 0, incremented on successful session reuse)

- [x] **2.2** Add workflow extraction to `node-extractor.js`
  - Update the extraction prompt to also look for workflows:
    - Add to prompt: "Also extract any step-by-step workflows or tutorials. For workflows, set type to 'workflow', name to the goal/task description, and steps to the ordered list of actions."
  - Workflows extracted from research tutorials will have `source: "research"` and `confidence: 0.7`

- [x] **2.3** Update `graph-builder.js` for workflow handling
  - Workflow nodes merge by fuzzy name matching (>60% keyword overlap = same workflow)
  - When merging: keep the version with more steps, or the one with higher confidence
  - Increment `completionCount` on merge if both have counts

- [x] **2.4** Add `querySimilarWorkflows()` to `graph-query.js`
  - Input: `goal` string
  - Tokenize goal into keywords
  - Score each workflow node by keyword overlap with `node.name` + `node.keywords`
  - Return top 3 workflows sorted by: `(keywordOverlap * 0.6) + (completionCount * 0.2) + (confidence * 0.2)`
  - Used by planning call (Phase 1.2) and context formatter

- [x] **2.5** Update `context-formatter.js` for workflow display
  - When formatting graph context, add a "Suggested Workflows" section if workflow nodes matched:
    ```
    ### Suggested Workflows
    - **Create a playlist**: Click + → Select Playlist → Name it → Add songs → Edit details → Save
      (Used successfully 3 times)
    ```
  - Place before other node type sections (workflows are highest priority context)

### Phase 3: Session Learning

Save completed sessions as workflows for future reuse.

- [x] **3.1** Add `distillWorkflow()` to `session-loop.js`
  - Called after `endSession('completed')`
  - Takes: `goal`, `steps[]` (raw step instructions from session)
  - Calls `sendChatRequest()` with Haiku to clean up:
    - System: "You are a workflow optimizer. Clean up this recorded session into the optimal step sequence."
    - User: "Goal: {goal}\n\nRecorded steps:\n{steps}\n\nRemove any repeated, wrong, or unnecessary steps. Return ONLY a JSON array of the essential steps in order."
  - Returns cleaned `string[]`

- [x] **3.2** Add `saveSessionAsWorkflow()` to `session-loop.js`
  - Called after `distillWorkflow()` succeeds
  - Creates a workflow node:
    ```
    {
      id: "{app-slug}:workflow:{goal-slug}",
      type: "workflow",
      name: goal,
      summary: `Workflow for: ${goal}`,
      steps: distilledSteps,
      keywords: tokenize(goal),
      views: [appInfo.currentView],
      sources: [`session:${sessionId}`],
      confidence: 0.9,
      completionCount: 1,
    }
    ```
  - Loads existing graph, checks for similar workflow (fuzzy match on name)
  - If similar exists: merge (keep best steps, increment completionCount)
  - If new: add node
  - Save graph

- [x] **3.3** Wire into `endSession()`
  - Only for `status === 'completed'` and `session.steps.length >= 2`
  - Run async (don't block session cleanup):
    ```
    distillWorkflow(session.goal, session.steps.map(s => s.instruction))
      .then(steps => saveSessionAsWorkflow(session, steps))
      .catch(err => log(`Workflow save error: ${err.message}`));
    ```

### Phase 4: Goal-Aware Research

Make research queries specific to the user's goal.

- [x] **4.1** Pass goal to `runResearchAgent()`
  - Update function signature: `runResearchAgent(appInfo, sendProgress, goal)`
  - Update caller in `session-loop.js` to pass `goal`

- [x] **4.2** Update Exa search query 3 to use goal
  - Current: `"${appName} ${currentView} tips tricks how to tutorial"`
  - New: `"${appName} ${goal} how to tutorial steps"`
  - This makes one of three queries goal-specific
  - Query 1 (documentation) and query 2 (UI layout) stay generic — they provide general app context

- [x] **4.3** Update legacy fallback search topics
  - Add goal-specific search to the tool-use search list:
    - Existing: official docs, getting started, common tasks, tips/shortcuts, troubleshooting, UI layout, workflows
    - Add: `"${appName} ${goal} tutorial"` as a priority search

### Phase 5: Prompt Refinement

Tighten the system prompt to work well with the workflow plan.

- [x] **5.1** Add plan-following rule to system prompt Rules section
  - Add: "If a Workflow Plan is provided, follow it step by step. Reference the plan in your <reasoning> to determine the next action. If the screen doesn't match the expected state for the current plan step, adapt — explain in your reasoning why you're deviating and what the new approach is."

- [x] **5.2** Reduce reasoning verbosity when plan exists
  - Add: "When following a clear plan step, keep your <reasoning> brief — confirm you're on the plan step and identify the target UI element. Save detailed reasoning for when you need to adapt."

### Phase 6: Cleanup & Verification

- [ ] **6.1** Verify no import errors: `npm start`
- [ ] **6.2** Check `$TMPDIR/guided-debug.log` for planning call output
- [ ] **6.3** Test: start session with a goal → verify plan is generated and logged
- [ ] **6.4** Test: complete a session → verify workflow is saved to graph
- [ ] **6.5** Test: start a new session with same/similar goal → verify past workflow appears in plan context
- [ ] **6.6** Update CLAUDE.md with new patterns

## Edge Cases

| Case | Handling |
|------|----------|
| Planning call fails (API error, bad JSON) | `workflowPlan` stays null, system prompt has no plan section — model works reactively as before |
| No cached research + no app guide | Planning call uses only the goal + model's own knowledge of the app — still useful |
| User's goal is vague ("help me use Spotify") | Plan will be generic, model adapts based on what it sees on screen |
| Session completed but only 1 step | Skip workflow saving (too short to be useful) |
| Similar workflow already exists in graph | Merge: keep higher-step-count version, increment completionCount |
| Planning call takes >5 seconds | Haiku is fast (~2s typical), but add a 5s timeout — if exceeded, skip plan |
| Goal matches multiple workflows | Return top 3, planning call picks the most relevant |
| User deviates from plan (clicks something else) | Model sees unexpected screen, adapts per prompt rules |

## Risks

| Risk | Mitigation |
|------|------------|
| Planning call adds latency to session start | Runs parallel with screenshot capture; ~1.5s net addition; plan makes subsequent steps more accurate (fewer total steps) |
| Plan is wrong for the app version | Model adapts when screen doesn't match; plan is a guide, not rigid |
| Workflow accumulation bloats graph | Workflows merge by similarity; graph file is small (JSON); no practical limit concern |
| Haiku distillation removes important steps | Distillation prompt is conservative ("essential steps only"); session raw steps preserved in session store |
| Goal-aware research returns irrelevant results | Only 1 of 3 queries changes; other 2 still provide general context |

## Out of Scope

- Multi-turn replanning (model outputting updated plan mid-session) — natural adaptation is sufficient
- Workflow sharing across users — single-user app
- Workflow version control — simple merge/replace is fine
- Custom workflow creation via dashboard UI — auto-learning is the path
- Parallel step execution — always one step at a time

## Implementation Prompt

> Read plan.md and implement it phase by phase. Mark each task as completed in plan.md when done (change `- [ ]` to `- [x]`). Do not stop until all phases are completed. Do not add unnecessary comments or jsdocs. Run `npm start` after each phase to verify no import errors or crashes. Check `$TMPDIR/guided-debug.log` for runtime errors. Commit after each completed phase with a descriptive message.

## Session Strategy

- **2 sessions.** Phases 1-3 in session 1 (~45 min), Phase 4-6 in session 2 (~20 min).
- **Commit cadence:** After each phase (6 commits).
- **If context compacts:** Re-read plan.md to resume. Key files: `session-loop.js`, `prompt-builder.js`, `graph-query.js`.
- **Parallel opportunity:** Phase 4 (goal-aware research) is independent — could run in a worktree.

## CLAUDE.md Updates

Add to Important Patterns:
```
- Workflow planning: session starts with a Haiku planning call that generates an optimal step sequence; plan is injected into system prompt for all guidance steps
- Planning runs in parallel with first screenshot capture; plan is awaited before the guidance API call
- Workflow nodes (type: 'workflow') in knowledge graph store reusable step sequences from research + completed sessions
- Session learning: completed sessions are distilled (Haiku cleanup call) and saved as workflow nodes for future reuse
- Similar past workflows are queried by fuzzy goal matching and injected into the planning prompt
```

Add to Gotchas:
```
- planWorkflow() has a 5s timeout — if Haiku is slow, session starts without a plan (graceful fallback)
- Workflow distillation runs async after endSession() — doesn't block session cleanup
- Exa query 3 uses the user's specific goal; queries 1-2 stay generic for broad app context
- completionCount on workflow nodes tracks how many times a workflow was successfully reused
```
