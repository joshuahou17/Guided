let pipeline = null;
let embedPipeline = null;

/**
 * Initialize the embedding pipeline with all-MiniLM-L6-v2.
 * Downloads the model on first use (~23MB).
 */
async function initEmbedder() {
  if (embedPipeline) return;

  // Dynamic import for ESM module
  const { pipeline: createPipeline } = await import('@xenova/transformers');
  pipeline = createPipeline;
  embedPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
}

/**
 * Embed a single text string.
 * Returns a Float32Array of 384 dimensions.
 */
async function embedText(text) {
  await initEmbedder();
  const output = await embedPipeline(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Embed multiple texts.
 * Returns an array of Float32Arrays.
 */
async function embedBatch(texts) {
  const results = [];
  for (const text of texts) {
    results.push(await embedText(text));
  }
  return results;
}

module.exports = { initEmbedder, embedText, embedBatch };
