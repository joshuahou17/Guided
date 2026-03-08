const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const appDataDir = path.join(app.getPath('userData'));
const screenshotsDir = path.join(appDataDir, 'screenshots');
const profilesDir = path.join(appDataDir, 'profiles');
const knowledgeDir = path.join(appDataDir, 'knowledge');
const graphsDir = path.join(appDataDir, 'graphs');
const dbPath = path.join(appDataDir, 'sessions.db');
const settingsPath = path.join(appDataDir, 'settings.json');

function ensureDirectories() {
  for (const dir of [appDataDir, screenshotsDir, profilesDir, knowledgeDir, graphsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureSessionDir(sessionId) {
  const dir = path.join(screenshotsDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SETTINGS_DEFAULTS = {
  apiKey: '',
  exaApiKey: '',
  braveApiKey: '',
  defaultRole: '',
  menubarEnabled: true,
  hotkey: 'CommandOrControl+Shift+Space',
  annotationColor: '#3B82F6',
};

function getSettings() {
  try {
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function getGraphPath(appName) {
  const safeName = appName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return path.join(graphsDir, `${safeName}.json`);
}

module.exports = {
  appDataDir,
  screenshotsDir,
  profilesDir,
  knowledgeDir,
  graphsDir,
  dbPath,
  settingsPath,
  ensureDirectories,
  ensureSessionDir,
  getGraphPath,
  getSettings,
  saveSettings,
};
