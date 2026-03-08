const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const logFile = path.join(os.tmpdir(), 'guided-debug.log');
function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] [ContextBuilder] ${msg}\n`);
}

/**
 * Build a structured context document from app identification + research results.
 *
 * @param {object} appInfo - { appName, appType, currentView, url, version }
 * @param {Array} researchResults - array of { source, url, title, summary }
 * @returns {object} structured context document
 */
function buildContextDocument(appInfo, researchResults) {
  // Validate each research result: must have source, url, title, summary as non-empty strings
  const validResults = [];
  for (const result of (researchResults || [])) {
    if (
      result &&
      typeof result.source === 'string' && result.source.trim() &&
      typeof result.url === 'string' && result.url.trim() &&
      typeof result.title === 'string' && result.title.trim() &&
      typeof result.summary === 'string' && result.summary.trim()
    ) {
      // Truncate summary to 1500 chars (increased for richer Exa content)
      validResults.push({
        ...result,
        summary: result.summary.length > 1500 ? result.summary.slice(0, 1500) + '...' : result.summary,
      });
    } else {
      log(`Dropped invalid research result: ${JSON.stringify(result)}`);
    }
  }

  const limitedDocs = validResults.length < 2;

  const doc = {
    appName: appInfo.appName,
    appType: appInfo.appType,
    currentView: appInfo.currentView,
    url: appInfo.url,
    version: appInfo.version,
    documentation: validResults,
    limitedDocs,
    researchedAt: new Date().toISOString(),
  };

  log(`Built context document for ${appInfo.appName}: ${validResults.length} valid sources (limitedDocs: ${limitedDocs})`);
  return doc;
}

/**
 * Format a context document into a text block suitable for injection
 * into a system prompt.
 *
 * @param {object} contextDoc - structured context document
 * @returns {string} formatted text for system prompt
 */
function formatContextForPrompt(contextDoc) {
  if (!contextDoc || !contextDoc.documentation || contextDoc.documentation.length === 0) {
    return '';
  }

  let text = `\n\n=== Research Context for ${contextDoc.appName} ===\n`;
  text += `App Type: ${contextDoc.appType}\n`;
  text += `Current View: ${contextDoc.currentView}\n`;

  if (contextDoc.version) {
    text += `Version: ${contextDoc.version}\n`;
  }

  text += `\nDocumentation & Resources:\n`;

  for (const doc of contextDoc.documentation) {
    text += `\n--- ${doc.source || 'Source'}: ${doc.title || 'Untitled'} ---\n`;
    if (doc.url) text += `URL: ${doc.url}\n`;
    text += `${doc.summary}\n`;
  }

  if (contextDoc.limitedDocs) {
    text += `\nNote: Limited documentation was found for this app. Guidance is based primarily on what's visible on screen.\n`;
  }

  text += `\n=== End Research Context ===\n`;

  log(`Formatted context: ${text.length} chars from ${contextDoc.documentation.length} sources (limitedDocs: ${!!contextDoc.limitedDocs})`);
  return text;
}

/**
 * Auto-generate an app guide from research results using Claude.
 * Synthesizes documentation summaries into a concise description of the app's
 * UI layout, navigation, and workflows.
 *
 * @param {string} appName - name of the app
 * @param {Array} researchResults - array of { source, url, title, summary }
 * @returns {string|null} generated guide text, or null if generation fails
 */
async function generateAppGuide(appName, researchResults) {
  if (!researchResults || researchResults.length === 0) return null;

  const { sendChatRequest } = require('../core/claude-client');

  const summaries = researchResults
    .map(r => `[${r.source}] ${r.title}: ${r.summary}`)
    .join('\n\n');

  const systemPrompt = `You generate concise app guides from documentation research. An app guide describes an application's UI layout, navigation structure, and common workflows in a format that helps an AI guide users through the interface step-by-step. Write only the guide content — no preamble or meta-commentary.`;

  const messages = [{
    role: 'user',
    content: `Based on this research about ${appName}, write a detailed App Guide (max 500 words). Focus on:\n- Main UI areas and their locations (sidebar, toolbar, panels, menus)\n- Navigation structure (how to get between views/screens)\n- Key features and where to find them\n- Common workflows as step sequences\n\nBe specific about positions (left sidebar, top bar, bottom panel, etc). Skip generic info — only include what helps someone navigate the UI.\n\nResearch:\n${summaries}`,
  }];

  try {
    const guide = await sendChatRequest(systemPrompt, messages, 1000);
    const trimmed = guide.trim();
    if (trimmed.length < 20) {
      log(`Generated guide too short (${trimmed.length} chars), discarding`);
      return null;
    }
    log(`Generated app guide for ${appName}: ${trimmed.length} chars`);
    return trimmed;
  } catch (err) {
    log(`App guide generation failed for ${appName}: ${err.message}`);
    return null;
  }
}

module.exports = { buildContextDocument, formatContextForPrompt, generateAppGuide };
