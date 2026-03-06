const { LocalIndex } = require('vectra');
const path = require('node:path');
const fs = require('node:fs');
const { knowledgeDir } = require('../main/paths');
const { embedText } = require('./embedder');

/**
 * Get or create a vectra index for an app.
 */
async function getIndex(appName) {
  const safe = appName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const indexPath = path.join(knowledgeDir, safe);

  const index = new LocalIndex(indexPath);
  if (!await index.isIndexCreated()) {
    await index.createIndex();
  }
  return index;
}

/**
 * Index an array of text chunks for an app.
 * Each chunk: { text, url, title }
 */
async function indexChunks(appName, chunks) {
  const index = await getIndex(appName);

  // Delete existing items first (re-index)
  try {
    await index.deleteIndex();
    await index.createIndex();
  } catch { /* index may not exist yet */ }

  for (const chunk of chunks) {
    const vector = await embedText(chunk.text);
    await index.insertItem({
      vector,
      metadata: {
        text: chunk.text,
        url: chunk.url || '',
        title: chunk.title || '',
      },
    });
  }
}

/**
 * Search the knowledge base for an app.
 * Returns top-K results: [{ text, score, url, title }]
 */
async function searchKnowledge(query, appName, topK = 4) {
  const index = await getIndex(appName);
  const queryVector = await embedText(query);
  const results = await index.queryItems(queryVector, topK);

  return results.map(r => ({
    text: r.item.metadata.text,
    score: r.score,
    url: r.item.metadata.url,
    title: r.item.metadata.title,
  }));
}

/**
 * Check if a knowledge index exists for an app.
 */
function vectorStoreExists(appName) {
  const safe = appName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const indexPath = path.join(knowledgeDir, safe);
  return fs.existsSync(path.join(indexPath, 'index.json'));
}

module.exports = { indexChunks, searchKnowledge, vectorStoreExists };
