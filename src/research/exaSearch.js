const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const logFile = path.join(os.tmpdir(), 'guided-debug.log');
function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] [ExaSearch] ${msg}\n`);
}

const EXA_API_URL = 'https://api.exa.ai/search';

async function searchExa(query, apiKey, options = {}) {
  const fetch = (await import('node-fetch')).default;
  const {
    numResults = 5,
    maxCharacters = 5000,
    type = 'auto',
    includeDomains = [],
  } = options;

  try {
    const body = {
      query,
      type,
      numResults,
      contents: {
        text: { maxCharacters },
      },
    };

    if (includeDomains.length > 0) {
      body.includeDomains = includeDomains;
    }

    log(`Searching: "${query}" (type=${type}, numResults=${numResults})`);

    const resp = await fetch(EXA_API_URL, {
      method: 'POST',
      timeout: 15000,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      log(`Exa API error ${resp.status}: ${errText.slice(0, 200)}`);
      return [];
    }

    const data = await resp.json();
    const results = (data.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      text: r.text || '',
      score: r.score || 0,
    }));

    log(`Exa returned ${results.length} results for "${query}"`);
    return results;
  } catch (err) {
    log(`Exa search failed: ${err.message}`);
    return [];
  }
}

module.exports = { searchExa };
