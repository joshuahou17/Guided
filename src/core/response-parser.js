/**
 * Extract content between XML-like tags.
 */
function extractTag(text, tagName) {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Parse Claude's Computer Use API response.
 * Response content is an array of blocks: text blocks + tool_use blocks.
 *
 * Returns { instruction, onTrack, done, clickCoord, toolUseId, reasoning }
 */
function parseComputerUseResponse(responseContent) {
  // Extract all text from text blocks
  const textBlocks = responseContent.filter(b => b.type === 'text');
  const fullText = textBlocks.map(b => b.text).join('\n');

  // Parse XML tags from text
  const instruction = extractTag(fullText, 'instruction') || 'Follow the highlighted element';
  const reasoning = extractTag(fullText, 'reasoning') || '';

  const onTrackStr = extractTag(fullText, 'on_track');
  const onTrack = onTrackStr !== 'false';

  const doneStr = extractTag(fullText, 'done');
  const done = doneStr === 'true';

  // Extract tool_use blocks for coordinates
  const toolUseBlocks = responseContent.filter(b => b.type === 'tool_use');
  let clickCoord = null;
  let toolUseId = null;

  if (toolUseBlocks.length > 0) {
    const toolUse = toolUseBlocks[0];
    toolUseId = toolUse.id;

    if (toolUse.input && toolUse.input.coordinate) {
      clickCoord = toolUse.input.coordinate; // [x, y] in image pixels
    }
  }

  return { instruction, onTrack, done, clickCoord, toolUseId, reasoning, raw: fullText };
}

/**
 * Parse Claude's structured guidance response (legacy XML format).
 * Returns { instruction, annotation, onTrack, done, raw }
 */
function parseGuideResponse(responseText) {
  const instruction = extractTag(responseText, 'instruction') || 'Follow the highlighted element';

  const annotationStr = extractTag(responseText, 'annotation');
  let annotation = null;
  if (annotationStr) {
    try {
      annotation = JSON.parse(annotationStr);
      // Clamp coordinates to 0-1 range
      if (annotation.x != null) annotation.x = Math.max(0, Math.min(1, annotation.x));
      if (annotation.y != null) annotation.y = Math.max(0, Math.min(1, annotation.y));
    } catch {
      annotation = null;
    }
  }

  const onTrackStr = extractTag(responseText, 'on_track');
  const onTrack = onTrackStr !== 'false';

  const doneStr = extractTag(responseText, 'done');
  const done = doneStr === 'true';

  const reasoning = extractTag(responseText, 'reasoning') || '';

  return { instruction, annotation, onTrack, done, reasoning, raw: responseText };
}

/**
 * Parse profile update from AI interview response.
 */
function parseProfileUpdate(responseText) {
  const updateStr = extractTag(responseText, 'profile_update');
  if (!updateStr) return null;
  try {
    return JSON.parse(updateStr);
  } catch {
    return null;
  }
}

module.exports = { parseGuideResponse, parseComputerUseResponse, parseProfileUpdate, extractTag };
