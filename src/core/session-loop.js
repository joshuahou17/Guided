const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getFrontmostAppInfo, captureAndResize } = require('../main/screenshot');
const { sendGuideRequest, initClient } = require('./claude-client');
const { buildSystemPrompt, buildStepMessage, buildComputerTools, buildToolResultMessage } = require('./prompt-builder');
const { parseComputerUseResponse } = require('./response-parser');
const { createSession, completeSession, abandonSession, saveStep } = require('../storage/session-store');
const { getProfile } = require('../storage/profile-store');
const { getPopupWindow } = require('../main/windows');
const { screen } = require('electron');
const { ensureSessionDir, getSettings } = require('../main/paths');
const { startListening, stopListening } = require('../main/click-listener');
const { computeImageHash, hasScreenChanged } = require('../main/screen-diff');
const os = require('node:os');

const logFile = path.join(os.tmpdir(), 'guided-debug.log');
function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] [SessionLoop] ${msg}\n`);
}

let activeSession = null;
let isProcessing = false;
let nativeOverlayProcess = null;
let screenPollTimer = null;

// Try to lazily import knowledge module (may fail if deps not installed)
let searchKnowledge, vectorStoreExists;
try {
  const vs = require('../knowledge/vector-store');
  searchKnowledge = vs.searchKnowledge;
  vectorStoreExists = vs.vectorStoreExists;
} catch {
  searchKnowledge = async () => [];
  vectorStoreExists = () => false;
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

    // Minimal delay to let the target app's UI register the click
    log(`Click detected at (${x}, ${y}) — advancing step`);
    setTimeout(() => {
      if (activeSession && activeSession.isRunning && !isProcessing) {
        advanceStep();
      }
    }, 150);
  });
}

// --- Screen Change Poller (auto-advance without hiding popup) ---

function startScreenPoller() {
  if (screenPollTimer) { clearInterval(screenPollTimer); screenPollTimer = null; }
  if (!activeSession || !activeSession.isRunning) return;

  const session = activeSession;
  const baselinePath = path.join(session.sessionDir, '_baseline.jpg');

  // Capture baseline WITH popup visible (no hide/show = no flash)
  captureAndResize(null, baselinePath, 1024).then(async () => {
    const baselineHash = await computeImageHash(baselinePath);

    screenPollTimer = setInterval(async () => {
      if (isProcessing || !activeSession || !activeSession.isRunning) {
        clearInterval(screenPollTimer); screenPollTimer = null;
        return;
      }
      try {
        const pollPath = path.join(session.sessionDir, '_poll.jpg');
        await captureAndResize(null, pollPath, 1024);
        const pollHash = await computeImageHash(pollPath);
        if (hasScreenChanged(baselineHash, pollHash)) {
          log('Screen change detected — advancing step');
          clearInterval(screenPollTimer); screenPollTimer = null;
          advanceStep();
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

// --- Session ---

async function startSession(goal, role) {
  // Ensure Claude client is initialized
  const settings = getSettings();
  if (!settings.apiKey) {
    throw new Error('No API key configured. Open Settings to add your Claude API key.');
  }
  initClient(settings.apiKey);

  // Get frontmost app info (for app name detection — NOT for coordinate mapping)
  const appInfo = await getFrontmostAppInfo();
  let appName = appInfo.appName || 'Unknown App';

  // If the frontmost app is Guided/Electron itself, try to detect the app behind it
  if (appName === 'Guided' || appName === 'Electron') {
    log(`Frontmost app is ${appName}, will detect target app from screenshot context`);
    appName = 'the target application';
  }

  // Create session record
  const sessionId = createSession(appName, goal, role);
  const sessionDir = ensureSessionDir(sessionId);

  activeSession = {
    id: sessionId,
    goal,
    appName,
    role: role || settings.defaultRole || '',
    steps: [],
    isRunning: true,
    onTrack: true,
    sessionDir,
    conversationHistory: [], // Multi-turn messages for Claude
    lastToolUseId: null,     // Track tool_use ID for tool_result flow
    imageDimensions: null,   // { width, height } of last screenshot sent
  };

  log(`Session started: ${sessionId} — app: ${appName} — goal: ${goal}`);

  // Notify popup of detected app
  const popup = getPopupWindow();
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send('session:app-detected', appName);
  }

  // Spawn native overlay
  spawnNativeOverlay();

  // Start global click listener for auto-advance
  startClickListener();

  // Run first step
  await runStep();

  return { sessionId, appName };
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
    // Brief delay to let the window hide
    await new Promise(r => setTimeout(r, 50));

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

    // 4. Search knowledge base (if available)
    let knowledgeChunks = [];
    if (vectorStoreExists(session.appName)) {
      try {
        const results = await searchKnowledge(session.goal, session.appName, 4);
        knowledgeChunks = results.map(r => r.text);
      } catch {
        // Knowledge search failed, continue without it
      }
    }

    // 5. Build prompt
    const profile = getProfile(session.appName);
    const profileContext = profile
      ? `Role: ${profile.role || 'Unknown'}. Notes: ${profile.notes || 'None'}.`
      : '';

    const systemPrompt = buildSystemPrompt(
      session.appName,
      session.role,
      profileContext,
      knowledgeChunks
    );

    // 6. Build tools array
    const tools = buildComputerTools(imgResult.width, imgResult.height);

    // 7. Build the user message
    const previousInstructions = session.steps.map(s => s.instruction);
    let message;
    if (session.lastToolUseId) {
      // Subsequent step: send as tool_result (include step summary for context)
      message = buildToolResultMessage(session.lastToolUseId, base64, userMessage, previousInstructions);
    } else {
      // First step: send as regular user message with image
      message = buildStepMessage(
        base64,
        session.goal,
        previousInstructions,
        userMessage
      );
    }

    // Trim history: keep only last assistant message for tool_use/tool_result chain
    // Claude still has context via system prompt + completed steps summary in message
    if (session.conversationHistory.length > 1) {
      const lastAssistant = session.conversationHistory[session.conversationHistory.length - 1];
      session.conversationHistory = lastAssistant.role === 'assistant' ? [lastAssistant] : [];
    }

    // Add this step's user message to conversation history
    session.conversationHistory.push(message);

    // 8. Call Claude with streaming — emit instruction early via callback
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
              sourcesCount: knowledgeChunks.length,
            });
          }
        },
      }
    );

    // 9. Parse Computer Use response
    const parsed = parseComputerUseResponse(responseContent);

    log(`Step ${stepNum}: instruction="${parsed.instruction}" done=${parsed.done} coord=${JSON.stringify(parsed.clickCoord)} toolUseId=${parsed.toolUseId}`);

    // Store tool_use ID for next tool_result
    session.lastToolUseId = parsed.toolUseId || null;

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
        sourcesCount: knowledgeChunks.length,
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

    // 15. Start screen poller for auto-advance (captures WITH popup visible — no flashing)
    startScreenPoller();

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

async function endSession(status = 'completed') {
  if (!activeSession) return;

  log(`Session ended: ${activeSession.id} — status: ${status} — steps: ${activeSession.steps.length}`);

  if (status === 'completed') {
    completeSession(activeSession.id);
  } else {
    abandonSession(activeSession.id);
  }

  const popup = getPopupWindow();
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send('session:ended', {
      sessionId: activeSession.id,
      status,
      stepCount: activeSession.steps.length,
    });
  }

  // Stop screen poller and click listener
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

async function advanceStep() {
  if (!activeSession || !activeSession.isRunning) return;
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
