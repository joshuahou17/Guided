const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

const logFile = path.join(os.tmpdir(), 'guided-debug.log');
function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] [ResearchCache] ${msg}\n`);
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getCacheDir() {
  const dir = path.join(app.getPath('userData'), 'research-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheKey(appName, version) {
  const safe = appName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  // Normalize version: strip leading 'v', lowercase, keep semver dots
  const v = version ? `-${version.replace(/^v/i, '').toLowerCase().replace(/[^a-z0-9.]+/g, '')}` : '';
  return `${safe}${v}`;
}

/**
 * Get cached research context for an app.
 * Returns the context document if found and not expired, otherwise null.
 */
function getCachedResearch(appName, version) {
  const key = cacheKey(appName, version);
  const filePath = path.join(getCacheDir(), `${key}.json`);

  if (!fs.existsSync(filePath)) {
    log(`Cache miss: ${key}`);
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Check TTL
    const age = Date.now() - (data._cachedAt || 0);
    if (age > CACHE_TTL_MS) {
      log(`Cache expired: ${key} (age: ${Math.round(age / 1000 / 60 / 60)}h)`);
      fs.unlinkSync(filePath);
      return null;
    }

    // Validate that documentation array is non-empty; treat empty as miss
    if (!data.documentation || !Array.isArray(data.documentation) || data.documentation.length === 0) {
      log(`Cache miss (empty documentation): ${key}`);
      fs.unlinkSync(filePath);
      return null;
    }

    log(`Cache hit: ${key} (age: ${Math.round(age / 1000 / 60)}min)`);
    return data;
  } catch (err) {
    log(`Cache read error: ${err.message}`);
    return null;
  }
}

/**
 * Save research context to cache.
 */
function setCachedResearch(appName, version, contextDoc) {
  const key = cacheKey(appName, version);
  const filePath = path.join(getCacheDir(), `${key}.json`);

  const data = {
    ...contextDoc,
    _cachedAt: Date.now(),
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    log(`Cache saved: ${key}`);
  } catch (err) {
    log(`Cache write error: ${err.message}`);
  }
}

/**
 * Clear all cached research.
 */
function clearCache() {
  const dir = getCacheDir();
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      fs.unlinkSync(path.join(dir, f));
    }
    log(`Cache cleared: ${files.length} entries`);
  } catch (err) {
    log(`Cache clear error: ${err.message}`);
  }
}

/**
 * Delete cached research for a specific app. Returns null.
 * Used for manual cache refresh from UI.
 */
function refreshCache(appName) {
  const dir = getCacheDir();
  const prefix = appName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
    for (const f of files) {
      fs.unlinkSync(path.join(dir, f));
    }
    log(`Cache refreshed for ${appName}: ${files.length} entries deleted`);
  } catch (err) {
    log(`Cache refresh error: ${err.message}`);
  }
  return null;
}

module.exports = { getCachedResearch, setCachedResearch, clearCache, refreshCache };
