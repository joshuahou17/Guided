const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getClient } = require('../core/claude-client');

const logFile = path.join(os.tmpdir(), 'guided-debug.log');
function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] [AppIdentifier] ${msg}\n`);
}

/**
 * Send a screenshot to Claude and identify the application/page the user is on.
 *
 * @param {string} screenshotBase64 - base64-encoded JPEG screenshot
 * @returns {Promise<{appName: string, appType: string, currentView: string, url: string|null, version: string|null}>}
 */
const BROWSER_NAMES = ['chrome', 'safari', 'firefox', 'arc', 'edge', 'brave', 'opera', 'vivaldi', 'chromium'];
const GENERIC_APP_NAMES = ['electron', 'guided', 'unknown', ''];

async function identifyApp(screenshotBase64, osAppName = null, retryCount = 0) {
  const client = getClient();

  log(`Sending screenshot for app identification... (OS hint: ${osAppName || 'none'})`);

  let promptText = `Identify the application, website, or tool shown in this screenshot. Return a JSON object with these fields:

{
  "appName": "the name of the application (e.g. Figma, VS Code, Gmail)",
  "appType": "web" or "desktop" or "mobile",
  "currentView": "describe the specific page/view/state the user is on (e.g. 'Design file editor', 'Inbox', 'Settings page')",
  "url": "the URL if visible in a browser address bar, otherwise null",
  "version": "the version number if visible, otherwise null"
}`;

  if (osAppName && !GENERIC_APP_NAMES.includes(osAppName.toLowerCase())) {
    promptText += `\n\nThe macOS system reports this application as "${osAppName}". Use this as the appName unless it's clearly a browser showing a specific website.`;
  }

  promptText += `\n\nIf you cannot identify the app, return your best guess. Always return valid JSON. For the appName field, use the most specific name — if a website is open in a browser, use the website name (e.g. "Gmail" not "Chrome", "Figma" not "Safari").

Return ONLY the JSON object, no other text.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: screenshotBase64,
            },
          },
          {
            type: 'text',
            text: promptText,
          },
        ],
      },
    ],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  log(`Raw identification response: ${text}`);

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }
    const parsed = JSON.parse(jsonMatch[0]);

    let result = {
      appName: parsed.appName || 'Unknown App',
      appType: parsed.appType || 'desktop',
      currentView: parsed.currentView || 'Main view',
      url: parsed.url || null,
      version: parsed.version || null,
    };

    // Strip generic wrapper names (e.g., "Electron (Spotify)" → "Spotify")
    const wrapperMatch = result.appName.match(/^(?:electron|guided)\s*[\(\-:]\s*(.+?)\s*\)?$/i);
    if (wrapperMatch) {
      log(`Stripped wrapper from app name: "${result.appName}" → "${wrapperMatch[1]}"`);
      result.appName = wrapperMatch[1];
    } else if (GENERIC_APP_NAMES.includes(result.appName.toLowerCase())) {
      result.appName = 'Unknown App';
    }

    // Validate: if appName is a browser name but URL is present, use domain as appName
    if (result.url && BROWSER_NAMES.includes(result.appName.toLowerCase())) {
      try {
        const domain = new URL(result.url).hostname.replace('www.', '');
        // Capitalize first letter of domain for display
        const domainName = domain.split('.')[0];
        result.appName = domainName.charAt(0).toUpperCase() + domainName.slice(1);
        result.appType = 'web';
        log(`Corrected browser name to domain: ${result.appName}`);
      } catch { /* keep original if URL parsing fails */ }
    }

    log(`Identified app: ${JSON.stringify(result)}`);
    return result;
  } catch (err) {
    log(`Failed to parse identification response: ${err.message}`);

    // Retry once with backoff
    if (retryCount < 1) {
      log('Retrying identification after 2s...');
      await new Promise(r => setTimeout(r, 2000));
      return identifyApp(screenshotBase64, osAppName, retryCount + 1);
    }

    return {
      appName: 'Unknown App',
      appType: 'desktop',
      currentView: 'Unknown view',
      url: null,
      version: null,
    };
  }
}

module.exports = { identifyApp };
