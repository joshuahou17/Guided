/**
 * Split text into chunks of approximately maxChars characters (~400 tokens).
 * Splits on sentence boundaries with some overlap for continuity.
 */
function chunkText(text, maxChars = 1600) {
  if (!text || text.length <= maxChars) {
    return text ? [text] : [];
  }

  const chunks = [];
  const overlap = 100;

  // Split into sentences
  const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];

  let current = '';
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      // Start new chunk with overlap from end of previous
      const overlapText = current.slice(-overlap);
      current = overlapText + ' ' + trimmed;
    } else {
      current += (current ? ' ' : '') + trimmed;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

module.exports = { chunkText };
