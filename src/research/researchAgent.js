const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cheerio = require('cheerio');
const { getClient } = require('../core/claude-client');
const { searchExa } = require('./exaSearch');

const logFile = path.join(os.tmpdir(), 'guided-debug.log');
function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] [ResearchAgent] ${msg}\n`);
}

const RESEARCH_MODEL = 'claude-haiku-4-5-20251001';
const MAX_RESEARCH_TURNS = 5;
const MAX_FETCH_PAGES = 4;

/**
 * Fetch a URL and extract clean text content.
 * Returns { url, title, text } or null on failure.
 */
async function fetchPage(url) {
  const fetch = (await import('node-fetch')).default;

  try {
    const resp = await fetch(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Guided/1.0 (Documentation Research Agent)' },
      redirect: 'follow',
    });

    // Detect login wall via HTTP status
    if (resp.status === 401 || resp.status === 403) {
      log(`Login wall detected (${resp.status}) for ${url}`);
      return { url, title: 'Login Required', text: 'This page requires authentication.' };
    }

    if (!resp.ok) return null;

    // Detect login wall via redirect to login/signin URL
    const finalUrl = resp.url || url;
    if (/\/(login|signin|sign-in|auth|sso)\b/i.test(finalUrl) && finalUrl !== url) {
      log(`Login wall detected (redirect to ${finalUrl}) for ${url}`);
      return { url, title: 'Login Required', text: 'This page requires authentication.' };
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const html = await resp.text();
    const $ = cheerio.load(html);

    // Detect login wall via form with password input
    const hasPasswordForm = $('form').find('input[type="password"]').length > 0;
    if (hasPasswordForm) {
      log(`Login wall detected (password form) for ${url}`);
      return { url, title: 'Login Required', text: 'This page requires authentication.' };
    }

    // Remove non-content elements
    $('nav, footer, header, script, style, noscript, iframe, .sidebar, .nav, .navigation, .menu, .breadcrumb, .cookie-banner, .ad, .ads, .advertisement').remove();

    const title = $('title').text().trim() || $('h1').first().text().trim() || '';
    const text = $('main, article, .content, .documentation, .doc-content, [role="main"], body')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    // Truncate to ~6000 chars for better doc coverage
    const truncated = text.length > 6000 ? text.slice(0, 6000) + '...' : text;

    return { url, title, text: truncated };
  } catch (err) {
    log(`Fetch error for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Research using Exa API: 3 targeted searches with inline content + 1 Haiku summarization.
 * Much faster and more reliable than the multi-turn tool-use loop.
 */
async function runExaResearch(appInfo, onProgress = () => {}, goal = '') {
  const { appName, appType, currentView, version } = appInfo;
  const exaApiKey = getExaApiKey();
  if (!exaApiKey) return null;

  log(`Starting Exa research for ${appName}`);
  onProgress(`Searching documentation for ${appName}...`);

  // Query 1: User-facing help/support pages (not developer docs)
  const q1 = searchExa(
    `${appName} app help guide how to use for beginners`,
    exaApiKey,
    { numResults: 5, maxCharacters: 5000 }
  );

  // Query 2: UI layout and navigation
  const q2 = searchExa(
    `${appName} app UI layout interface navigation guide overview`,
    exaApiKey,
    { numResults: 5, maxCharacters: 5000 }
  );

  // Query 3: Goal-specific how-tos (or generic tips if no goal)
  const q3Context = goal || (currentView && currentView !== 'Unknown' ? currentView : appType);
  const q3 = searchExa(
    `${appName} ${q3Context} how to tutorial steps`,
    exaApiKey,
    { numResults: 5, maxCharacters: 5000 }
  );

  const [results1, results2, results3] = await Promise.all([q1, q2, q3]);

  // Deduplicate by URL
  const seen = new Set();
  const allResults = [];
  for (const r of [...results1, ...results2, ...results3]) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    allResults.push(r);
  }

  log(`Exa returned ${allResults.length} unique results for ${appName}`);

  if (allResults.length === 0) {
    log('Exa returned no results, falling back');
    return null;
  }

  onProgress(`Summarizing ${allResults.length} sources for ${appName}...`);

  // Build content for Haiku summarization
  const sourceTexts = allResults.map((r, i) =>
    `[Source ${i + 1}] ${r.title}\nURL: ${r.url}\n\n${r.text.slice(0, 4000)}`
  ).join('\n\n---\n\n');

  const { sendChatRequest } = require('../core/claude-client');

  const systemPrompt = `You summarize documentation excerpts for applications. For each source, write a 2-4 sentence summary focusing on:
- UI layout: where key elements are located (sidebar, toolbar, panels, menus)
- Navigation: how to move between views/screens
- How-to steps: concrete sequences of actions
- Tips and shortcuts

Return a JSON array where each item has: "source" (type like "official docs", "tutorial", "community", "UI overview", "workflow guide"), "url", "title", "summary".
Return ONLY the JSON array.`;

  const userMsg = `Summarize these documentation excerpts for ${appName}${version ? ` (version ${version})` : ''}:\n\n${sourceTexts}`;

  try {
    const response = await sendChatRequest(systemPrompt, [{ role: 'user', content: userMsg }], 4096);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      log(`Exa research complete: ${parsed.length} summarized sources for ${appName}`);
      onProgress(`Research complete: ${parsed.length} sources found`);
      return parsed;
    }
  } catch (err) {
    log(`Exa summarization failed: ${err.message}`);
  }

  // Fallback: return raw Exa results as summaries
  log('Summarization failed, returning raw Exa results');
  return allResults.map(r => ({
    source: 'documentation',
    url: r.url,
    title: r.title,
    summary: r.text.slice(0, 1500),
  }));
}

function getExaApiKey() {
  try {
    const { getSettings } = require('../main/paths');
    const settings = getSettings();
    return settings.exaApiKey || '';
  } catch {
    return '';
  }
}

/**
 * Use Claude with tool use to autonomously research an application.
 * The agent has access to web_search and web_fetch tools and will
 * iteratively find and read documentation.
 *
 * @param {object} appInfo - { appName, appType, currentView, url, version }
 * @param {function} onProgress - callback(statusMessage) for UI updates
 * @returns {Promise<Array<{source: string, url: string, title: string, summary: string}>>}
 */
async function runResearchAgent(appInfo, onProgress = () => {}, goal = '') {
  // Try Exa first (faster, higher quality)
  try {
    const exaResults = await runExaResearch(appInfo, onProgress, goal);
    if (exaResults && exaResults.length > 0) {
      log(`Using Exa research path: ${exaResults.length} results`);
      return exaResults;
    }
  } catch (err) {
    log(`Exa research failed, falling back to legacy: ${err.message}`);
  }

  log('Falling back to legacy research (Brave/DDG)');
  return runLegacyResearch(appInfo, onProgress);
}

/**
 * Legacy research: multi-turn Haiku tool-use loop with Brave/DDG search.
 * Used as fallback when no Exa API key is configured.
 */
async function runLegacyResearch(appInfo, onProgress = () => {}) {
  const client = getClient();
  const { appName, appType, currentView, url, version } = appInfo;

  const tools = [
    {
      name: 'web_search',
      description: 'Search the web for documentation, tutorials, and guides about an application. Returns a list of search results with titles, URLs, and snippets.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to find relevant documentation and guides.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'web_fetch',
      description: 'Fetch and extract the text content from a web page URL. Use this to read documentation pages, tutorials, and guides.',
      input_schema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch content from.',
          },
        },
        required: ['url'],
      },
    },
  ];

  const systemPrompt = `You are a research agent preparing to help a user learn ${appName}.

The user is currently on: ${currentView}
App type: ${appType}
${version ? `Version: ${version}` : ''}
${url ? `URL: ${url}` : ''}

Your job is to gather comprehensive knowledge about this application so you can later guide the user step-by-step through its UI. Research the following:

1. Official documentation — find the docs site and read the most relevant pages for what the user is currently doing
2. Getting started / onboarding guides — find official or high-quality tutorials
3. Common tasks and how-tos — find guides for the most common things users do in this app
4. Tips, shortcuts, and best practices — find power-user tips
5. Common issues and troubleshooting — find FAQ/support pages
6. UI layout and navigation — find pages that describe the app's interface layout, navigation structure, menu organization, sidebar contents, toolbar buttons, and key UI areas. Search for "interface overview", "UI tour", "workspace layout", or "navigation guide" pages.
7. Workflows and processes — find pages that describe step-by-step workflows or multi-screen processes (e.g. "how to set up a project from start to finish"). Focus on the sequence of screens/views and where to click.

Focus your research on what's most relevant to the user's CURRENT view/state: ${currentView}

Use the web_search tool to find relevant pages, then use web_fetch to read the most promising ones. Fetch at least 3-5 high-quality sources. Prioritize official docs over third-party content. Include at least one search for "${appName} UI layout overview" or "${appName} interface guide".

When you have gathered enough information, respond with a final summary. Do NOT use any tools in your final response. Your final response should be a JSON array of the sources you found, each with these fields:
- "source": type of source (e.g. "official docs", "getting started guide", "tutorial", "FAQ", "community", "UI overview", "workflow guide")
- "url": the URL
- "title": page title
- "summary": a 2-3 sentence summary of the key information from this page. For UI layout sources, describe the main UI areas, navigation elements, and where key features are located. For workflow sources, describe the sequence of steps involved.

Return ONLY the JSON array in your final message.`;

  const messages = [
    {
      role: 'user',
      content: `Research ${appName} now. Start by searching for its official documentation and getting started guides.`,
    },
  ];

  let fetchCount = 0;
  const fetchedPages = [];
  const fetchedUrls = new Set();

  for (let turn = 0; turn < MAX_RESEARCH_TURNS; turn++) {
    log(`Research turn ${turn + 1}/${MAX_RESEARCH_TURNS}`);

    const response = await client.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages,
      tools,
    });

    // Check if the model wants to use tools
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');

    if (toolUseBlocks.length === 0) {
      // No tool use — this is the final response
      const finalText = textBlocks.map(b => b.text).join('');
      log(`Research complete after ${turn + 1} turns. Fetched ${fetchCount} pages.`);

      // Parse the final JSON
      try {
        const jsonMatch = finalText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (err) {
        log(`Failed to parse final research JSON: ${err.message}`);
      }

      // If we can't parse the JSON, construct from fetched pages
      return fetchedPages.map(p => ({
        source: 'documentation',
        url: p.url,
        title: p.title,
        summary: p.text.slice(0, 200) + '...',
      }));
    }

    // Add assistant response to messages
    messages.push({ role: 'assistant', content: response.content });

    // Process each tool call
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      let result;

      if (toolUse.name === 'web_search') {
        onProgress(`Searching: "${toolUse.input.query}"`);
        log(`web_search: "${toolUse.input.query}"`);
        result = await executeWebSearch(toolUse.input.query);
      } else if (toolUse.name === 'web_fetch') {
        if (fetchCount >= MAX_FETCH_PAGES) {
          result = 'Maximum page fetch limit reached. Please provide your final summary now.';
        } else if (fetchedUrls.has(toolUse.input.url)) {
          result = 'This URL was already fetched. Try a different URL.';
        } else {
          onProgress(`Reading: ${toolUse.input.url}`);
          log(`web_fetch: ${toolUse.input.url}`);
          fetchedUrls.add(toolUse.input.url);
          const page = await fetchPage(toolUse.input.url);
          if (page) {
            fetchedPages.push(page);
            fetchCount++;
            result = `Title: ${page.title}\n\nContent:\n${page.text}`;
          } else {
            result = 'Failed to fetch this page. Try another URL.';
          }
        }
      } else {
        result = `Unknown tool: ${toolUse.name}`;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });

    // If we're on the last allowed turn, force a final response
    if (turn === MAX_RESEARCH_TURNS - 2) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: 'You have one more turn. Please provide your final summary now as a JSON array. Do not use any more tools.' }],
      });
    }
  }

  // Fallback: return whatever pages we fetched
  log(`Research hit max turns. Returning ${fetchedPages.length} fetched pages.`);
  return fetchedPages.map(p => ({
    source: 'documentation',
    url: p.url,
    title: p.title,
    summary: p.text.slice(0, 200) + '...',
  }));
}

/**
 * Execute a web search using Brave Search API (primary) or DuckDuckGo HTML (fallback).
 */
async function executeWebSearch(query) {
  const fetch = (await import('node-fetch')).default;

  // Try Brave Search API first if key is configured
  const braveApiKey = getBraveApiKey();
  if (braveApiKey) {
    try {
      return await executeBraveSearch(fetch, query, braveApiKey);
    } catch (err) {
      log(`Brave Search failed, falling back to DuckDuckGo: ${err.message}`);
    }
  }

  // Fallback: DuckDuckGo HTML search
  return await executeDuckDuckGoSearch(fetch, query);
}

function getBraveApiKey() {
  try {
    const { getSettings } = require('../main/paths');
    const settings = getSettings();
    return settings.braveApiKey || '';
  } catch {
    return '';
  }
}

async function executeBraveSearch(fetch, query, apiKey) {
  const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`;
  const resp = await fetch(searchUrl, {
    timeout: 10000,
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!resp.ok) {
    throw new Error(`Brave API returned status ${resp.status}`);
  }

  const data = await resp.json();
  const webResults = (data.web && data.web.results) || [];

  if (webResults.length === 0) {
    return 'No search results found. Try a different query.';
  }

  const results = webResults.slice(0, 8).map(r => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.description || '',
  }));

  return JSON.stringify(results, null, 2);
}

async function executeDuckDuckGoSearch(fetch, query) {
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(searchUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!resp.ok) {
      return `Search failed with status ${resp.status}`;
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    const results = [];
    $('.result').each((i, el) => {
      if (i >= 8) return false;
      const title = $(el).find('.result__title a').text().trim();
      const url = $(el).find('.result__title a').attr('href');
      const snippet = $(el).find('.result__snippet').text().trim();

      if (title && url) {
        let cleanUrl = url;
        try {
          const parsed = new URL(url, 'https://duckduckgo.com');
          const uddg = parsed.searchParams.get('uddg');
          if (uddg) cleanUrl = decodeURIComponent(uddg);
        } catch { /* use raw url */ }

        results.push({ title, url: cleanUrl, snippet });
      }
    });

    if (results.length === 0) {
      return 'No search results found. Try a different query.';
    }

    return JSON.stringify(results, null, 2);
  } catch (err) {
    log(`Search error: ${err.message}`);
    return `Search failed: ${err.message}. Try a different query.`;
  }
}

module.exports = { runResearchAgent, runExaResearch, fetchPage };
