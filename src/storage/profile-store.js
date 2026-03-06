const fs = require('node:fs');
const path = require('node:path');
const { profilesDir } = require('../main/paths');

function profilePath(appName) {
  const safe = appName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return path.join(profilesDir, `${safe}.json`);
}

function getProfile(appName) {
  const p = profilePath(appName);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function saveProfile(appName, data) {
  const p = profilePath(appName);
  const profile = {
    appName,
    ...data,
    lastUpdated: new Date().toISOString(),
  };
  fs.writeFileSync(p, JSON.stringify(profile, null, 2));
  return profile;
}

function listProfiles() {
  try {
    const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(profilesDir, f), 'utf-8'));
        return {
          appName: data.appName,
          role: data.role || '',
          lastUpdated: data.lastUpdated || '',
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function deleteProfile(appName) {
  const p = profilePath(appName);
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = { getProfile, saveProfile, listProfiles, deleteProfile };
