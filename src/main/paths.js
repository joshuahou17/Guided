const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const appDataDir = path.join(app.getPath('userData'));
const screenshotsDir = path.join(appDataDir, 'screenshots');
const profilesDir = path.join(appDataDir, 'profiles');
const knowledgeDir = path.join(appDataDir, 'knowledge');
const dbPath = path.join(appDataDir, 'sessions.db');
const settingsPath = path.join(appDataDir, 'settings.json');

function ensureDirectories() {
  for (const dir of [appDataDir, screenshotsDir, profilesDir, knowledgeDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureSessionDir(sessionId) {
  const dir = path.join(screenshotsDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return { apiKey: '', defaultRole: '', menubarEnabled: true, hotkey: 'CommandOrControl+Shift+Space', annotationColor: '#3B82F6' };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

module.exports = {
  appDataDir,
  screenshotsDir,
  profilesDir,
  knowledgeDir,
  dbPath,
  settingsPath,
  ensureDirectories,
  ensureSessionDir,
  getSettings,
  saveSettings,
};
