const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getFrontmostAppInfo, captureAndResize } = require('../main/screenshot');
const { sendGuideRequest, initClient } = require('./claude-client');
const { buildSystemPrompt, buildSystemPromptWithoutResearch, buildStepMessage, buildComputerTools, buildToolResultMessage, buildPlanningPrompt } = require('./prompt-builder');
const { parseComputerUseResponse } = require('./response-parser');
const { createSession, completeSession, abandonSession, saveStep } = require('../storage/session-store');
const { getProfile, saveProfile } = require('../storage/profile-store');
const { getPopupWindow } = require('../main/windows');
const { screen } = require('electron');
const { ensureSessionDir, getSettings } = require('../main/paths');
const { startListening, stopListening } = require('../main/click-listener');
const { computeImageHash, hasScreenChanged } = require('../main/screen-diff');
const os = require('node:os');

// Research pipeline imports
const { identifyApp } = require('../research/appIdentifier');
const { runResearchAgent } = require('../research/researchAgent');
const { buildContextDocument, formatContextForPrompt, generateAppGuide } = require('../research/contextBuilder');
const { getCachedResearch, setCachedResearch } = require('../research/cache');

const logFile = path.join(os.tmpdir(), 'guided-debug.log');
function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] [SessionLoop] ${msg}\n`);
}

let activeSession = null;
let isProcessing = false;
let nativeOverlayProcess = null;
let screenPollTimer = null;

// Knowledge graph imports
const { loadGraph } = require('../knowledge/graph-store');
const { queryGraph } = require('../knowledge/graph-query');
const { formatGraphContext } = require('../knowledge/context-formatter');
const { buildGraph } = require('../knowledge/graph-builder');

// --- Conversation History Management ---

/**
 * Strip screenshots from older messages to manage token budget.
 * Keeps screenshots in the most recent `keepRecent` user messages.
 * All text content (reasoning, instructions, tool results) is preserved.
 */
function trimOldScreenshots(history, keepRecent) {
  // Count user messages from the end to determine which ones to strip
  let userMsgCount = 0;
  const userMsgIndices = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      userMsgCount++;
      userMsgIndices.push(i);
    }
  }

  // Strip screenshots from user messages older than keepRecent
  const toStrip = userMsgIndices.slice(keepRecent);
  for (const idx of toStrip) {
    const msg = history[idx];
    if (!Array.isArray(msg.content)) continue;

    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];

      // Direct image block (step 1 format)
      if (block.type === 'image') {
        msg.content[j] = { type: 'text', text: '[Screenshot from earlier step]' };
        continue;
      }

      // Image inside tool_result (step 2+ format)
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (let k = 0; k < block.content.length; k++) {
          if (block.content[k].type === 'image') {
            block.content[k] = { type: 'text', text: '[Screenshot from earlier step]' };
          }
        }
      }
    }
  }
}

// --- Native Overlay Management ---

function getNativeOverlayPath() {
  // Look for compiled binary relative to project root
  const projectRoot = path.resolve(__dirname, '..', '..');
  return path.join(projectRoot, 'native', 'overlay');
}

function spawnNativeOverlay() {
  const overlayPath = getNativeOverlayPath();
  if (!fs.existsSync(overlayPath)) {
    log(`Native overlay not found at ${overlayPath}, annotations will be skipped`);
    return;
  }

  try {
    nativeOverlayProcess = spawn(overlayPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    nativeOverlayProcess.stdout.on('data', (data) => {
      log(`[NativeOverlay stdout] ${data.toString().trim()}`);
    });

    nativeOverlayProcess.stderr.on('data', (data) => {
      log(`[NativeOverlay stderr] ${data.toString().trim()}`);
    });

    nativeOverlayProcess.on('error', (err) => {
      log(`[NativeOverlay] Process error: ${err.message}`);
      nativeOverlayProcess = null;
    });

    nativeOverlayProcess.on('exit', (code) => {
      log(`[NativeOverlay] Exited with code ${code}`);
      nativeOverlayProcess = null;
    });

    log('Spawned native overlay process');
  } catch (err) {
    log(`Failed to spawn native overlay: ${err.message}`);
    nativeOverlayProcess = null;
  }
}

function sendOverlayCommand(cmd) {
  if (nativeOverlayProcess && nativeOverlayProcess.stdin && !nativeOverlayProcess.killed) {
    try {
      nativeOverlayProcess.stdin.write(JSON.stringify(cmd) + '\n');
    } catch (err) {
      log(`Failed to send overlay command: ${err.message}`);
    }
  }
}

function killNativeOverlay() {
  if (nativeOverlayProcess && !nativeOverlayProcess.killed) {
    try {
      sendOverlayCommand({ cmd: 'quit' });
      // Give it a moment to quit gracefully, then force kill
      setTimeout(() => {
        if (nativeOverlayProcess && !nativeOverlayProcess.killed) {
          nativeOverlayProcess.kill();
        }
      }, 500);
    } catch {
      // Already dead
    }
    nativeOverlayProcess = null;
  }
}

// --- Global Click Listener (auto-advance on user action) ---

function startClickListener() {
  startListening(({ x, y }) => {
    // Ignore clicks while already processing a step
    if (isProcessing || !activeSession || !activeSession.isRunning) return;

    // Ignore clicks on the Guided popup itself
    const popup = getPopupWindow();
    if (popup && !popup.isDestroyed() && popup.isVisible()) {
      const bounds = popup.getBounds();
      if (x >= bounds.x && x <= bounds.x + bounds.width &&
          y >= bounds.y && y <= bounds.y + bounds.height) {
        return;
      }
    }

    // Skip clicks during text input steps — user is clicking to focus/type, not to advance
    if (activeSession.textInputMode) return;

    log(`Click detected at (${x}, ${y}) — advancing step`);
    setTimeout(() => {
      if (activeSession && activeSession.isRunning && !isProcessing) {
        advanceStep(500);
      }
    }, 500);
  });
}

// --- Screen Change Poller (settle-based: waits for screen to stabilize after change) ---

function startScreenPoller() {
  if (screenPollTimer) { clearInterval(screenPollTimer); screenPollTimer = null; }
  if (!activeSession || !activeSession.isRunning) return;

  const session = activeSession;
  const baselinePath = path.join(session.sessionDir, '_baseline.jpg');

  captureAndResize(null, baselinePath, 1024).then(async () => {
    let lastHash = await computeImageHash(baselinePath);
    if (!lastHash) return;

    let state = 'waiting_for_change'; // 'waiting_for_change' | 'settling'
    let settleCount = 0;
    const SETTLE_THRESHOLD = 2; // 2 stable polls after last change (~1.5s total)

    screenPollTimer = setInterval(async () => {
      if (isProcessing || !activeSession || !activeSession.isRunning) {
        clearInterval(screenPollTimer); screenPollTimer = null;
        return;
      }
      try {
        const pollPath = path.join(session.sessionDir, '_poll.jpg');
        await captureAndResize(null, pollPath, 1024);
        const pollHash = await computeImageHash(pollPath);
        const changed = hasScreenChanged(lastHash, pollHash);

        if (changed) {
          state = 'settling';
          settleCount = 0;
          lastHash = pollHash;
        } else if (state === 'settling') {
          settleCount++;
          if (settleCount >= SETTLE_THRESHOLD) {
            log('Screen settled after change — advancing step');
            clearInterval(screenPollTimer); screenPollTimer = null;
            advanceStep(200);
          }
        }
      } catch (err) {
        log(`Poll error: ${err.message}`);
      }
    }, 750);
  }).catch(err => log(`Baseline capture error: ${err.message}`));
}

function stopScreenPoller() {
  if (screenPollTimer) { clearInterval(screenPollTimer); screenPollTimer = null; }
}

// --- Workflow Planning ---

async function planWorkflow(appInfo, goal, appGuide, graph) {
  try {
    const { sendChatRequest } = require('./claude-client');

    // Query graph for similar past workflows
    let similarWorkflows = [];
    if (graph) {
      try {
        const { querySimilarWorkflows } = require('../knowledge/graph-query');
        similarWorkflows = querySimilarWorkflows(graph, goal);
      } catch { /* graph query not available yet */ }
    }

    const { systemPrompt, userMsg } = buildPlanningPrompt(
      appInfo.appName, goal, appInfo.currentView, appGuide, similarWorkflows
    );

    const response = await Promise.race([
      sendChatRequest(systemPrompt, [{ role: 'user', content: userMsg }], 1000),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Planning timeout')), 5000)),
    ]);

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      log('Planning: no JSON array in response');
      return null;
    }

    const raw = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(raw) || raw.length === 0) return null;

    // Normalize: handle objects like {step: 1, action: "..."} or plain strings
    const steps = raw.map(s => typeof s === 'string' ? s : (s.action || s.step || String(s)));

    log(`Workflow plan generated: ${steps.length} steps`);
    steps.forEach((s, i) => log(`  Plan step ${i + 1}: ${s}`));
    return steps;
  } catch (err) {
    log(`Planning error: ${err.message}`);
    return null;
  }
}

// --- Session ---

async function startSession(goal, role) {
  // Ensure Claude client is initialized
  const settings = getSettings();
  if (!settings.apiKey) {
    throw new Error('No API key configured. Open Settings to add your Claude API key.');
  }
  initClient(settings.apiKey);

  // Create a temporary session dir for research screenshots
  const tempSessionId = `temp-${Date.now()}`;
  const tempSessionDir = ensureSessionDir(tempSessionId);

  // Notify popup: loading
  const popup = getPopupWindow();
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send('session:loading', true);
  }

  // --- PHASE 1: Quick app identification (blocking, ~2 sec) ---
  let appName;
  let appInfo;

  // Get OS-level app name first (reliable for native/Electron apps)
  let osAppName = null;
  try {
    const jxaInfo = await getFrontmostAppInfo();
    osAppName = jxaInfo.appName || null;
    log(`OS app name: ${osAppName}`);
  } catch (err) {
    log(`JXA app info error: ${err.message}`);
  }

  try {
    // Capture screenshot for identification
    const identScreenshotPath = path.join(tempSessionDir, '_identify.jpg');
    if (popup && !popup.isDestroyed()) popup.hide();
    await new Promise(r => setTimeout(r, 50));
    await captureAndResize(null, identScreenshotPath, 1024);
    if (popup && !popup.isDestroyed()) popup.showInactive();

    const base64 = fs.readFileSync(identScreenshotPath).toString('base64');
    appInfo = await identifyApp(base64, osAppName);
    appName = appInfo.appName;
    log(`Identified app: ${appName} (${appInfo.appType}) — view: ${appInfo.currentView}`);
  } catch (err) {
    log(`App identification error: ${err.message}`);
    appName = osAppName || 'Unknown App';
    if (appName === 'Guided' || appName === 'Electron') {
      appName = 'the target application';
    }
    appInfo = { appName, appType: 'desktop', currentView: 'Unknown', url: null, version: null };
  }

  // Notify popup of detected app
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send('session:app-detected', appName);
  }

  // Create the real session record
  const sessionId = createSession(appName, goal, role);
  const sessionDir = ensureSessionDir(sessionId);

  // Check cache synchronously — if hit, we have research context immediately
  let researchContext = '';
  let researchReady = false;
  const cached = getCachedResearch(appInfo.appName, appInfo.version);
  if (cached) {
    researchContext = formatContextForPrompt(cached);
    researchReady = true;
    log(`Cache hit for ${appName} — research available immediately`);
    if (popup && !popup.isDestroyed()) {
      popup.webContents.send('session:research-progress', `Using cached research for ${appName}`);
    }

    // Auto-generate app guide from cached research if profile has no guide
    const cachedProfile = getProfile(appInfo.appName);
    if ((!cachedProfile || !cachedProfile.appGuide || !cachedProfile.appGuide.trim()) && cached.documentation && cached.documentation.length > 0) {
      generateAppGuide(appInfo.appName, cached.documentation).then(guide => {
        if (guide) {
          saveProfile(appInfo.appName, { ...(cachedProfile || {}), appGuide: guide });
          log(`Auto-generated app guide from cache for ${appName}`);
        }
      }).catch(err => log(`Cache guide generation error: ${err.message}`));
    }
  }

  // Load knowledge graph if one exists for this app
  let graph = null;
  try {
    graph = loadGraph(appName);
    if (graph) log(`Loaded knowledge graph for ${appName}: ${Object.keys(graph.nodes).length} nodes`);
  } catch (err) {
    log(`Graph load error: ${err.message}`);
  }

  // Start workflow planning in parallel (will be awaited in runStep before API call)
  const profile = getProfile(appInfo.appName);
  const appGuide = profile && profile.appGuide ? profile.appGuide.trim() : '';
  const planPromise = planWorkflow(appInfo, goal, appGuide, graph);

  activeSession = {
    id: sessionId,
    goal,
    appName,
    appInfo,
    role: role || settings.defaultRole || '',
    steps: [],
    isRunning: true,
    onTrack: true,
    sessionDir,
    conversationHistory: [],
    lastToolUseId: null,
    imageDimensions: null,
    researchContext,
    researchReady,
    graph,
    workflowPlan: null,
    planPromise,
  };

  log(`Session started: ${sessionId} — app: ${appName} — goal: ${goal} — research: ${researchReady ? 'cached' : 'pending'}`);

  // Spawn native overlay
  spawnNativeOverlay();

  // Start global click listener for auto-advance
  startClickListener();

  // --- PHASE 2: Start guidance immediately (plan awaited inside runStep) ---
  await runStep();

  // --- PHASE 3: Background research (non-blocking) ---
  if (!researchReady) {
    runBackgroundResearch(appInfo, tempSessionDir, goal).catch(err => {
      log(`Background research error: ${err.message}`);
    });
  } else {
    // Clean up temp dir since we don't need research
    try { fs.rmSync(tempSessionDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }

  return { sessionId, appName };
}

/**
 * Run research in the background. When complete, inject context into active session.
 * First guidance step runs without research; step 2+ gets enriched context.
 */
async function runBackgroundResearch(appInfo, tempSessionDir, goal = '') {
  const popup = getPopupWindow();

  const sendProgress = (msg) => {
    log(`[BackgroundResearch] ${msg}`);
    if (popup && !popup.isDestroyed()) {
      popup.webContents.send('session:research-progress', msg);
    }
  };

  sendProgress(`Researching ${appInfo.appName}...`);

  let researchResults = [];
  try {
    researchResults = await runResearchAgent(appInfo, sendProgress, goal);
  } catch (err) {
    log(`Research agent error: ${err.message}`);
    sendProgress('Research encountered an error');
  }

  // Build and cache context
  const contextDoc = buildContextDocument(appInfo, researchResults);
  if (researchResults.length > 0) {
    setCachedResearch(appInfo.appName, appInfo.version, contextDoc);
  }

  // Auto-generate app guide if profile doesn't have one yet
  if (researchResults.length > 0) {
    const existingProfile = getProfile(appInfo.appName);
    if (!existingProfile || !existingProfile.appGuide || !existingProfile.appGuide.trim()) {
      try {
        const guide = await generateAppGuide(appInfo.appName, researchResults);
        if (guide) {
          saveProfile(appInfo.appName, { ...(existingProfile || {}), appGuide: guide });
          log(`Auto-generated app guide for ${appInfo.appName} (${guide.length} chars)`);
          sendProgress(`Generated app guide for ${appInfo.appName}`);
        }
      } catch (err) {
        log(`App guide generation error: ${err.message}`);
      }
    }
  }

  const researchContext = formatContextForPrompt(contextDoc);

  // Build/enrich knowledge graph from research results
  if (researchResults.length > 0) {
    try {
      const graph = await buildGraph(appInfo, researchResults);
      if (activeSession && activeSession.isRunning && activeSession.appName === appInfo.appName) {
        activeSession.graph = graph;
        log(`Knowledge graph built for ${appInfo.appName}: ${Object.keys(graph.nodes).length} nodes`);
      }
    } catch (err) {
      log(`Graph build failed, continuing without graph: ${err.message}`);
    }
  }

  // Inject into active session if still running
  if (activeSession && activeSession.isRunning && activeSession.appName === appInfo.appName) {
    activeSession.researchContext = researchContext;
    activeSession.researchReady = true;
    log(`Background research complete: ${researchResults.length} sources injected into session`);
  }

  // Notify popup
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send('session:research-complete', {
      sourcesCount: researchResults.length,
      limitedDocs: researchResults.length < 2,
    });
    sendProgress(`Research complete: ${researchResults.length} sources found`);
  }

  // Clean up temp dir
  try { fs.rmSync(tempSessionDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
}

async function runStep(userMessage = null) {
  if (!activeSession || !activeSession.isRunning) return;
  if (isProcessing) {
    log('runStep skipped: already processing');
    return;
  }
  isProcessing = true;
  stopScreenPoller();

  const session = activeSession;
  session.textInputMode = false;

  // Notify popup: loading
  const popup = getPopupWindow();
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send('session:loading', true);
  }

  try {
    // 1. Hide popup so it doesn't appear in the screenshot
    if (popup && !popup.isDestroyed()) {
      popup.hide();
    }
    // Delay to let the window hide and app UI settle before screenshot
    await new Promise(r => setTimeout(r, 300));

    // 2. Capture FULL SCREEN and resize (no window-specific capture)
    const stepNum = session.steps.length + 1;
    const screenshotPath = path.join(session.sessionDir, `${stepNum}.jpg`);
    const imgResult = await captureAndResize(null, screenshotPath, 1024);
    session.imageDimensions = { width: imgResult.width, height: imgResult.height };

    // 3. Re-show popup (without stealing focus from target app)
    if (popup && !popup.isDestroyed()) {
      popup.showInactive();
    }

    log(`Step ${stepNum}: Full-screen screenshot ${imgResult.width}x${imgResult.height}`);

    // 3. Read screenshot as base64
    const base64 = fs.readFileSync(screenshotPath).toString('base64');

    // 3.5. Await workflow plan if not yet available (runs in parallel with screenshot capture)
    if (session.planPromise && !session.workflowPlan) {
      try {
        session.workflowPlan = await session.planPromise;
        session.planPromise = null;
        if (session.workflowPlan) log(`Workflow plan ready: ${session.workflowPlan.length} steps`);
      } catch (err) {
        log(`Planning await error: ${err.message}`);
        session.planPromise = null;
      }
    }

    // 4. Query knowledge graph for relevant context
    let graphContext = '';
    if (session.graph) {
      try {
        const queryResult = queryGraph(session.graph, {
          currentView: session.appInfo.currentView,
          visibleElements: session.appInfo.visibleElements || [],
          userIntent: session.goal,
          maxNodes: 20,
          maxTokens: 2500,
        });
        graphContext = formatGraphContext(session.appName, session.appInfo.currentView, queryResult);
        if (graphContext) log(`Graph query returned ${queryResult.nodes.length} nodes for step`);
      } catch (err) {
        log(`Graph query error: ${err.message}`);
      }
    }

    // 5. Build prompt — now includes graph context + research context + app guide
    const profile = getProfile(session.appName);
    const profileContext = profile
      ? `Role: ${profile.role || 'Unknown'}. Notes: ${profile.notes || 'None'}.`
      : '';
    const appGuide = profile && profile.appGuide ? profile.appGuide.trim() : '';

    // Use full prompt if research is ready, otherwise use the no-research variant
    const systemPrompt = session.researchReady
      ? buildSystemPrompt(session.appName, session.role, profileContext, graphContext, session.researchContext, appGuide, session.workflowPlan)
      : buildSystemPromptWithoutResearch(session.appName, session.role, profileContext, graphContext, appGuide, session.workflowPlan);

    // 6. Build tools array
    const tools = buildComputerTools(imgResult.width, imgResult.height);

    // 7. Build the user message
    const previousInstructions = session.steps.map(s => s.instruction);
    let message;
    if (session.lastToolUseId) {
      // Subsequent step: send as tool_result (include step summary for context)
      message = buildToolResultMessage(session.lastToolUseId, base64, userMessage, previousInstructions, session.lastActionType || 'click');
    } else {
      // First step: send as regular user message with image
      message = buildStepMessage(
        base64,
        session.goal,
        previousInstructions,
        userMessage
      );
    }

    // Add this step's user message to conversation history
    session.conversationHistory.push(message);

    // Strip screenshots from older messages to manage token budget
    // Keep full text context (reasoning, instructions, outcomes) from all steps
    trimOldScreenshots(session.conversationHistory, 3);

    // Safety cap: prevent unbounded history growth in very long sessions
    while (session.conversationHistory.length > 30) {
      session.conversationHistory.splice(0, 2); // remove oldest user+assistant pair
      log('History cap: removed oldest message pair');
    }

    // 8. Call Claude with streaming — emit instruction early via callback
    const sourcesCount = (graphContext ? 1 : 0) + (session.researchContext ? 1 : 0);
    const responseContent = await sendGuideRequest(
      systemPrompt,
      session.conversationHistory,
      tools,
      {
        onInstruction: (instruction) => {
          // Show instruction in popup immediately (before tool_use/coordinates arrive)
          if (popup && !popup.isDestroyed()) {
            popup.webContents.send('session:loading', false);
            popup.webContents.send('step:update', {
              instruction,
              stepNumber: session.steps.length + 1,
              done: false,
              sourcesCount,
            });
          }
        },
      }
    );

    // 9. Parse Computer Use response
    const parsed = parseComputerUseResponse(responseContent);

    log(`Step ${stepNum}: instruction="${parsed.instruction}" done=${parsed.done} coord=${JSON.stringify(parsed.clickCoord)} toolUseId=${parsed.toolUseId}`);

    // Store tool_use ID and action type for next tool_result
    session.lastToolUseId = parsed.toolUseId || null;
    session.lastActionType = parsed.actionType || 'click';

    // Add assistant response to conversation history for multi-turn context
    session.conversationHistory.push({ role: 'assistant', content: responseContent });

    // 10. Store step
    const step = {
      stepNumber: stepNum,
      instruction: parsed.instruction,
      clickCoord: parsed.clickCoord,
      screenshotPath,
      onTrack: parsed.onTrack,
      timestamp: new Date().toISOString(),
    };
    session.steps.push(step);
    saveStep(session.id, step);

    // 11. Send step update to popup
    if (popup && !popup.isDestroyed()) {
      popup.webContents.send('session:loading', false);
      popup.webContents.send('step:update', {
        instruction: parsed.instruction,
        stepNumber: stepNum,
        done: parsed.done,
        sourcesCount,
      });
    }

    // 12. Send annotation to native overlay (direct screen coordinate mapping)
    if (parsed.clickCoord) {
      const [imgX, imgY] = parsed.clickCoord;
      const display = screen.getPrimaryDisplay();
      const { width: screenW, height: screenH } = display.size; // logical points

      // Full-screen capture: image coords map directly to screen coords
      const screenX = (imgX / imgResult.width) * screenW;
      const screenY = (imgY / imgResult.height) * screenH;

      log(`Step ${stepNum}: Annotation at screen (${Math.round(screenX)}, ${Math.round(screenY)}) from img (${imgX}, ${imgY}) — imgSize=${imgResult.width}x${imgResult.height} screenSize=${screenW}x${screenH}`);

      const currentSettings = getSettings();
      sendOverlayCommand({
        cmd: 'annotate',
        x: Math.round(screenX),
        y: Math.round(screenY),
        label: parsed.instruction,
        offTrack: !parsed.onTrack,
        color: currentSettings.annotationColor || '#3B82F6',
      });
    }

    // 13. Handle off-track
    if (!parsed.onTrack) {
      session.onTrack = false;
      if (popup && !popup.isDestroyed()) {
        popup.webContents.send('step:off-track', {
          correction: parsed.instruction,
        });
      }
    } else {
      session.onTrack = true;
    }

    // 14. Check if done
    if (parsed.done) {
      await endSession('completed');
      return;
    }

    // 15. Start appropriate advancement method
    if (parsed.actionType === 'text_input') {
      log(`Step ${stepNum}: text_input action — waiting for user (Done? button only)`);
      session.textInputMode = true;
      if (popup && !popup.isDestroyed()) {
        popup.webContents.send('step:text-input', { instruction: parsed.instruction });
      }
      // No screen poller, no click listener — text input advances only via Done? button
    } else {
      startScreenPoller();
    }

  } catch (err) {
    console.error('Step error:', err);
    log(`Step error: ${err.message}`);
    if (popup && !popup.isDestroyed()) {
      popup.webContents.send('session:loading', false);
      popup.webContents.send('session:error', err.message);
    }
  } finally {
    isProcessing = false;
  }
}

async function distillWorkflow(goal, stepInstructions) {
  try {
    const { sendChatRequest } = require('./claude-client');
    const systemPrompt = 'You are a workflow optimizer. Clean up a recorded session into the optimal step sequence. Remove any repeated, wrong, or unnecessary steps. Return ONLY a JSON array of the essential steps in order. No other text.';
    const userMsg = `Goal: ${goal}\n\nRecorded steps:\n${stepInstructions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;

    const response = await sendChatRequest(systemPrompt, [{ role: 'user', content: userMsg }], 1000);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;

    const raw = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.map(s => typeof s === 'string' ? s : (s.action || s.step || String(s)));
  } catch (err) {
    log(`Distill workflow error: ${err.message}`);
    return null;
  }
}

function saveSessionAsWorkflow(session, distilledSteps) {
  try {
    const { slugify, createNode } = require('../knowledge/schema');
    const { loadGraph, saveGraph, addWorkflowNode } = require('../knowledge/graph-store');
    const { createEmptyGraph } = require('../knowledge/schema');

    let graph = loadGraph(session.appName);
    if (!graph) {
      graph = createEmptyGraph(session.appName, session.appInfo?.appType || 'desktop', `Knowledge graph for ${session.appName}`);
    }

    const workflowNode = createNode(session.appName, 'workflow', session.goal, `Workflow for: ${session.goal}`, {
      steps: distilledSteps,
      keywords: session.goal.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2),
      views: session.appInfo?.currentView ? [session.appInfo.currentView] : [],
      sources: [`session:${session.id}`],
      confidence: 0.9,
    });
    workflowNode.completionCount = 1;

    addWorkflowNode(graph, workflowNode);
    saveGraph(graph);
    log(`Saved workflow from session: "${session.goal}" (${distilledSteps.length} steps)`);
  } catch (err) {
    log(`Save workflow error: ${err.message}`);
  }
}

async function endSession(status = 'completed') {
  if (!activeSession) return;

  log(`Session ended: ${activeSession.id} — status: ${status} — steps: ${activeSession.steps.length}`);

  // Save completed sessions as workflows (async, non-blocking)
  if (status === 'completed' && activeSession.steps.length >= 2) {
    const sessionSnapshot = { ...activeSession, steps: [...activeSession.steps] };
    distillWorkflow(sessionSnapshot.goal, sessionSnapshot.steps.map(s => s.instruction))
      .then(steps => { if (steps) saveSessionAsWorkflow(sessionSnapshot, steps); })
      .catch(err => log(`Workflow save error: ${err.message}`));
  }

  if (status === 'completed') {
    completeSession(activeSession.id);
  } else {
    abandonSession(activeSession.id);
  }

  const popup = getPopupWindow();
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send('step:reset');
    popup.webContents.send('session:ended', {
      sessionId: activeSession.id,
      status,
      stepCount: activeSession.steps.length,
    });
  }

  // Stop pollers and click listener
  stopScreenPoller();
  stopListening();

  // Clear native overlay
  sendOverlayCommand({ cmd: 'clear' });
  killNativeOverlay();

  activeSession.isRunning = false;
  activeSession = null;
}

async function stopSession() {
  await endSession('abandoned');
}

async function sendUserMessage(text) {
  if (!activeSession || !activeSession.isRunning) return;
  await runStep(text);
}

async function advanceStep(settleMs = 0) {
  if (!activeSession || !activeSession.isRunning) return;
  if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs));
  await runStep();
}

function resetOnTrack() {
  if (activeSession) {
    activeSession.onTrack = true;
  }
}

function getActiveSession() {
  return activeSession;
}

module.exports = {
  startSession,
  stopSession,
  sendUserMessage,
  advanceStep,
  resetOnTrack,
  getActiveSession,
};
