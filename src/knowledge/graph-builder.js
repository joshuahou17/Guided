const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { loadGraph, saveGraph, mergeNodes } = require('./graph-store');
const { createEmptyGraph } = require('./schema');
const { extractNodes } = require('./node-extractor');

const logPath = path.join(os.tmpdir(), 'guided-debug.log');
function log(msg) {
  fs.appendFileSync(logPath, `[graph-builder] ${new Date().toISOString()} ${msg}\n`);
}

async function buildGraph(appInfo, researchResults) {
  const { appName, appType } = appInfo;
  log(`Building graph for ${appName} from ${researchResults.length} research results`);

  let graph = loadGraph(appName);
  if (!graph) {
    graph = createEmptyGraph(appName, appType, `Knowledge graph for ${appName}`);
    log(`Created new empty graph for ${appName}`);
  }

  try {
    const { nodes, edges } = await extractNodes(appName, appType || 'desktop', researchResults);
    if (nodes.length > 0) {
      mergeNodes(graph, nodes, edges);
      graph.lastEnriched = new Date().toISOString();
      saveGraph(graph);
      log(`Graph saved for ${appName}: ${Object.keys(graph.nodes).length} nodes, ${graph.edges.length} edges`);
    } else {
      log(`No nodes extracted for ${appName}, graph unchanged`);
    }
  } catch (err) {
    log(`Graph build error for ${appName}: ${err.message}`);
  }

  return graph;
}

async function enrichGraph(appName, currentView, researchResults) {
  let graph = loadGraph(appName);
  if (!graph) {
    log(`No existing graph for ${appName}, cannot enrich`);
    return null;
  }

  try {
    const { nodes, edges } = await extractNodes(appName, graph.appType || 'desktop', researchResults);
    if (nodes.length > 0) {
      mergeNodes(graph, nodes, edges);
      graph.lastEnriched = new Date().toISOString();
      saveGraph(graph);
      log(`Enriched graph for ${appName} (view: ${currentView}): now ${Object.keys(graph.nodes).length} nodes`);
    }
  } catch (err) {
    log(`Enrichment error for ${appName}: ${err.message}`);
  }

  return graph;
}

function isViewSparse(graph, currentView) {
  if (!graph || !currentView) return true;
  const key = currentView.toLowerCase();
  for (const [viewKey, nodeIds] of Object.entries(graph.viewIndex)) {
    if (viewKey === key || viewKey.includes(key) || key.includes(viewKey)) {
      if (nodeIds.length >= 3) return false;
    }
  }
  return true;
}

module.exports = { buildGraph, enrichGraph, isViewSparse };
