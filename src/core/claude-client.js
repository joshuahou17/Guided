const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5-20251001';

let client = null;
let stats = { inputTokens: 0, outputTokens: 0, callCount: 0 };

function initClient(apiKey) {
  client = new Anthropic({ apiKey });
  stats = { inputTokens: 0, outputTokens: 0, callCount: 0 };
}

function getClient() {
  if (!client) throw new Error('Claude client not initialized. Set API key in settings.');
  return client;
}

/**
 * Send a guided step request using Computer Use API with streaming.
 *
 * Streams the response. When the <instruction> tag is fully received,
 * calls options.onInstruction(text) immediately so the popup can show it
 * before the tool_use block (with coordinates) arrives.
 *
 * Returns the full response content array (text blocks + tool_use blocks)
 * after the stream completes.
 */
async function sendGuideRequest(systemPrompt, messages, tools, options = {}) {
  const c = getClient();
  stats.callCount++;

  const params = {
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    betas: ['computer-use-2025-01-24'],
  };

  if (tools && tools.length > 0) {
    params.tools = tools;
  }

  const stream = c.beta.messages.stream(params);

  // Detect <instruction> early from text deltas
  let accumulatedText = '';
  let instructionEmitted = false;

  stream.on('text', (textDelta) => {
    accumulatedText += textDelta;

    // Check if we have a complete <instruction>...</instruction> tag
    if (!instructionEmitted && options.onInstruction) {
      const match = accumulatedText.match(/<instruction>([\s\S]*?)<\/instruction>/i);
      if (match) {
        instructionEmitted = true;
        options.onInstruction(match[1].trim());
      }
    }
  });

  // Wait for the stream to complete and get the final message
  const finalMessage = await stream.finalMessage();

  stats.inputTokens += finalMessage.usage.input_tokens;
  stats.outputTokens += finalMessage.usage.output_tokens;

  return finalMessage.content;
}

async function sendChatRequest(systemPrompt, messages, maxTokens = 1000) {
  const c = getClient();
  stats.callCount++;

  const response = await c.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });

  stats.inputTokens += response.usage.input_tokens;
  stats.outputTokens += response.usage.output_tokens;

  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

function getStats() {
  return { ...stats };
}

module.exports = { initClient, getClient, sendGuideRequest, sendChatRequest, getStats };
