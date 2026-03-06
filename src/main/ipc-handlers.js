const { ipcMain, BrowserWindow } = require('electron');
const { startSession, stopSession, sendUserMessage, advanceStep, resetOnTrack } = require('../core/session-loop');
const { listSessions, getSession } = require('../storage/session-store');
const { getProfile, saveProfile, listProfiles, deleteProfile } = require('../storage/profile-store');
const { getSettings, saveSettings } = require('./paths');
const { hidePopup, showDashboard } = require('./windows');

function registerAllIpcHandlers() {
  // --- Window close (fire-and-forget from renderer) ---
  ipcMain.on('popup:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.hide();
    }
  });

  // --- Open settings from renderer ---
  ipcMain.on('popup:open-settings', () => {
    showDashboard('settings');
  });
  // --- Session ---
  ipcMain.handle('session:start', async (_event, goal, role) => {
    try {
      return await startSession(goal, role);
    } catch (err) {
      throw new Error(err.message);
    }
  });

  ipcMain.handle('session:stop', async () => {
    await stopSession();
  });

  ipcMain.handle('session:message', async (_event, text) => {
    await sendUserMessage(text);
  });

  ipcMain.handle('session:next-step', async () => {
    await advanceStep();
  });

  ipcMain.handle('session:back-on-track', () => {
    resetOnTrack();
  });

  ipcMain.handle('session:dismiss', () => {
    const fs = require('node:fs');
    const logFile = require('node:path').join(require('node:os').tmpdir(), 'guided-debug.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] session:dismiss called\n`);
    try {
      hidePopup();
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] hidePopup done\n`);
    } catch (err) {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] dismiss error: ${err.message}\n`);
    }
  });

  // --- Dashboard ---
  ipcMain.handle('dashboard:sessions', () => {
    return listSessions();
  });

  ipcMain.handle('dashboard:session', (_event, id) => {
    return getSession(id);
  });

  // --- Profiles ---
  ipcMain.handle('dashboard:profiles', () => {
    return listProfiles();
  });

  ipcMain.handle('dashboard:profile', (_event, appName) => {
    return getProfile(appName);
  });

  ipcMain.handle('dashboard:update-profile', (_event, appName, data) => {
    return saveProfile(appName, data);
  });

  ipcMain.handle('dashboard:delete-profile', (_event, appName) => {
    return deleteProfile(appName);
  });

  // --- Settings ---
  ipcMain.handle('settings:get', () => {
    return getSettings();
  });

  ipcMain.handle('settings:save', (_event, settings) => {
    saveSettings(settings);

    // Re-init Claude client if API key changed
    if (settings.apiKey) {
      try {
        const { initClient } = require('../core/claude-client');
        initClient(settings.apiKey);
      } catch { /* will init on next session */ }
    }

    // Update hotkey if changed
    if (settings.hotkey) {
      try {
        const { updateHotkey } = require('./global-hotkey');
        updateHotkey(settings.hotkey);
      } catch { /* non-fatal */ }
    }

    return true;
  });

  // --- Knowledge Base ---
  ipcMain.handle('knowledge:scrape', async (_event, appName, url) => {
    try {
      const { scrapeHelpCenter } = require('../knowledge/scraper');
      const { chunkText } = require('../knowledge/chunker');
      const { indexChunks } = require('../knowledge/vector-store');

      const pages = await scrapeHelpCenter(url);
      const allChunks = [];
      for (const page of pages) {
        const chunks = chunkText(page.text);
        for (const text of chunks) {
          allChunks.push({ text, url: page.url, title: page.title });
        }
      }

      await indexChunks(appName, allChunks);
      return { pagesScraped: pages.length, chunksIndexed: allChunks.length };
    } catch (err) {
      throw new Error(`Scraping failed: ${err.message}`);
    }
  });

  ipcMain.handle('knowledge:status', (_event, appName) => {
    try {
      const { vectorStoreExists } = require('../knowledge/vector-store');
      return { indexed: vectorStoreExists(appName) };
    } catch {
      return { indexed: false };
    }
  });

  // --- Profile AI Interview ---
  ipcMain.handle('profile:chat', async (_event, appName, message) => {
    try {
      const { sendChatRequest } = require('../core/claude-client');
      const { buildProfileInterviewPrompt } = require('../core/prompt-builder');
      const { parseProfileUpdate } = require('../core/response-parser');

      const profile = getProfile(appName);
      const systemPrompt = buildProfileInterviewPrompt(appName, profile);

      const responseText = await sendChatRequest(systemPrompt, [
        { role: 'user', content: message },
      ]);

      // Check for profile update in response
      const profileUpdate = parseProfileUpdate(responseText);
      if (profileUpdate) {
        saveProfile(appName, { ...profile, ...profileUpdate });
      }

      // Strip the profile_update tags from the visible response
      const cleanResponse = responseText.replace(/<profile_update>[\s\S]*?<\/profile_update>/g, '').trim();

      return { response: cleanResponse, profileUpdated: !!profileUpdate };
    } catch (err) {
      throw new Error(`Profile chat failed: ${err.message}`);
    }
  });
}

module.exports = { registerAllIpcHandlers };
