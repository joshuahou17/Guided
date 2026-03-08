# Guided — Claude Code Briefing

## What This Is
macOS Electron menubar app that uses Claude Computer Use API to provide live, step-by-step onboarding guidance with screen annotations. Takes screenshots, identifies the app, researches it autonomously, then guides the user with click-position overlays.

## Commands
```bash
npm start          # Launch the app
npm run dev        # Launch with GUIDED_DEV=1 flag
npm run rebuild    # Rebuild native modules (better-sqlite3, sharp)
npm run build:native  # Compile the Swift overlay binary
```

## Architecture

### Process Model
- **Main process** (`main.js`) — Electron main; sets up tray, global hotkey, IPC handlers
- **Renderer** — Two windows: popup (floating pill) and dashboard (settings/history)
- **Native overlay** — Swift binary (`native/overlay`) spawned as child process, receives JSON commands on stdin for screen annotations

### Core Flow
1. User presses hotkey → popup appears → user types goal
2. `session-loop.js` captures screenshot → `appIdentifier.js` identifies app (~2s, blocking)
3. First guidance step starts immediately (without research context)
4. Background: `researchAgent.js` runs → cache → context injected into session for step 2+
5. Screenshot → Claude Computer Use API → parse response → show annotation overlay
6. Settle-based screen poller or click listener auto-advances; text input steps are manual-only (Done? button or click)

### Key Directories
```
src/
  core/           — Session loop, Claude client, prompt builder, response parser
  research/       — App identifier, research agent, context builder, cache
  knowledge/      — Knowledge graph (schema, store, query, formatter, extractor, builder)
  main/           — Electron main process (IPC, windows, tray, hotkey, screenshot)
  renderers/      — HTML/JS for popup and dashboard windows
  storage/        — SQLite database, session store, profile store
  native/         — Swift overlay source
native/           — Compiled overlay binary
```

### Knowledge Graph
- Each app gets a local JSON graph at `~/Library/Application Support/guided/graphs/{app}.json`
- Nodes: feature, ui_element, task, concept, shortcut, setting, troubleshoot, workflow
- Edges: prerequisite_for, located_in, shortcut_for, related_to, part_of, solves
- Graph built from research results via Sonnet node extraction (background, non-blocking)
- Graph query: view + keywords + intent -> top 20 nodes -> ~2500 token context injection
- Priority order in system prompt: app guide > workflow plan > graph context > research context
- If no graph exists, falls back to research context only

### Important Patterns
- Claude API calls go through `src/core/claude-client.js` — uses streaming with `betas: ['computer-use-2025-01-24']`
- Sonnet (`claude-sonnet-4-6`) used for knowledge graph node extraction; Haiku for everything else
- Model is `claude-haiku-4-5-20251001` for guidance + research calls
- Screenshots use macOS `screencapture` CLI, resized with `sharp` to max 1024px width
- IPC follows `handle`/`invoke` pattern for async, `on`/`send` for fire-and-forget
- Popup state machine: `setup` → `collapsed` → `expanded` → `done`
- Research cache lives in `~/Library/Application Support/guided/research-cache/`, 7-day TTL
- Research runs in background: first guidance step starts without research context; step 2+ gets enriched context
- Exa API is primary search backend for research; Brave Search is secondary; DuckDuckGo is no-key fallback
- Research pipeline: 3 Exa search calls (with inline content) + 1 Haiku summarization call (replaces multi-turn Haiku tool-use loop)
- Conversation history preserves full text across all steps; screenshots stripped from messages older than 3 steps
- Safety cap: conversation history capped at 30 messages to prevent unbounded growth
- Research cache validates non-empty documentation arrays; empty = cache miss
- App Guides: descriptions of app layout/workflows stored in profile (`appGuide` field), injected into system prompt as high-priority context
- App Guides are auto-generated from research results via `generateAppGuide()` in `contextBuilder.js` — one Haiku call to synthesize; never overwrites manual edits
- Research agent searches for UI layout + workflow docs in addition to standard documentation
- Graph files are JSON, stored alongside profiles and research cache
- Legacy vector store (`vectra`, `@xenova/transformers`) removed — graph replaces it
- Screen poller uses settle-based detection: waits for screen to stabilize (~1.5s after last change) before advancing
- Text input steps are manual-only: user clicks "Done?" or clicks in the app to advance (no auto-detection)
- Click listener has 500ms delay; popup hide has 300ms delay — ensures screenshots capture final UI state
- `advanceStep(settleMs)` accepts an optional settle delay — click listener uses 500ms, Done? button uses 300ms, screen poller uses 200ms
- Workflow planning: session starts with a Haiku planning call that generates an optimal step sequence; plan is injected into system prompt
- Planning runs in parallel with first screenshot capture; plan is awaited before the guidance API call (5s timeout)
- Workflow nodes (type: 'workflow') in knowledge graph store reusable step sequences from research + completed sessions
- Session learning: completed sessions are distilled (Haiku cleanup call) and saved as workflow nodes for future reuse
- `querySimilarWorkflows()` does fuzzy goal matching to find relevant past workflows for the planning prompt
- Exa research query 3 is goal-aware: uses the user's specific goal instead of generic tips/tricks search

## Code Style
- CommonJS (`require`/`module.exports`), no TypeScript
- No linter/formatter configured — follow existing style
- Logging: append to `os.tmpdir()/guided-debug.log` via `fs.appendFileSync`
- Error handling: try/catch with log + graceful fallback, never crash the main process
- Node-fetch is ESM-only — use dynamic `import('node-fetch')` pattern

## Gotchas
- `node-fetch` v3 is ESM — must use `const fetch = (await import('node-fetch')).default`
- `sharp` and `better-sqlite3` need native rebuilds for Electron: run `npm run rebuild`
- Screen Recording permission required on macOS — `main.js` handles the prompt
- The popup window hides before screenshots so it doesn't appear in captures
- Brave API key stored in settings (`braveApiKey`) — if missing, research falls back to DuckDuckGo HTML scraping
- `session:research-complete` IPC event fires once when background research finishes
- `buildSystemPromptWithoutResearch()` used only for step 1; all subsequent steps use full `buildSystemPrompt()`
- `electron` module only available in main process — research modules that need `app` paths import from `electron` directly
- Node extraction is Sonnet (not Haiku) — check `sendExtractionRequest()` in claude-client.js
- Graph context injected between app guide and research context in system prompt
- Empty graph query result -> empty string -> research context used as fallback
- Exa API key stored in settings (`exaApiKey`) — if missing, research falls back to Brave → DuckDuckGo
- Conversation history is NOT trimmed anymore — model sees full step-by-step context
- Screenshots are large (~1500 tokens each) — only last 3 steps include screenshots, older ones get text placeholders
