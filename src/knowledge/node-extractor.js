const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { sendExtractionRequest } = require('../core/claude-client');
const { createNode, createEdge, validateNode, NODE_TYPES, EDGE_TYPES } = require('./schema');

const logPath = path.join(os.tmpdir(), 'guided-debug.log');
function log(msg) {
  fs.appendFileSync(logPath, `[node-extractor] ${new Date().toISOString()} ${msg}\n`);
}

const EXTRACTION_SYSTEM_PROMPT = `You are building a knowledge graph for an application. Given documentation about the app, extract knowledge nodes and edges.

For each piece of useful knowledge, create a node object with these fields:
- type: one of "feature", "ui_element", "task", "concept", "shortcut", "setting", "troubleshoot", "workflow"
- name: human-readable name (e.g., "Auto Layout", "Properties Panel")
- summary: 1-3 sentence actionable explanation
- steps: array of ordered steps if this is a how-to task, otherwise empty array
- keywords: array of search keywords for matching
- views: array of UI views/pages this is relevant to (e.g., "editor", "settings", "dashboard")
- confidence: 0-1 how well-sourced this knowledge is (0.8+ for official docs, 0.5 for community)

For relationships between nodes, create edge objects with:
- sourceName: name of the source node
- targetName: name of the target node
- type: one of "prerequisite_for", "located_in", "shortcut_for", "related_to", "part_of", "solves"
- weight: 0-1 strength of relationship

Return a JSON object with two arrays: { "nodes": [...], "edges": [...] }
Also extract step-by-step workflows or tutorials. For workflows, set type to "workflow", name to the goal/task description (e.g., "Create a new playlist"), and steps to the ordered list of concrete actions.

Prioritize actionable, practical knowledge. Target 10-30 nodes per source. Do not include meta-commentary.`;

async function extractNodes(appName, appType, researchResults) {
  const allNodes = [];
  const allEdges = [];

  for (const result of researchResults) {
    if (!result.summary || !result.title) continue;

    try {
      const userMessage = `Application: ${appName} (${appType})
Source: ${result.source || 'documentation'}
Title: ${result.title}
URL: ${result.url || 'unknown'}

Content:
${result.summary}`;

      const response = await sendExtractionRequest(
        EXTRACTION_SYSTEM_PROMPT,
        [{ role: 'user', content: userMessage }],
        4096
      );

      const parsed = parseExtractionResponse(response);
      if (!parsed) continue;

      const nodes = [];
      for (const raw of (parsed.nodes || [])) {
        try {
          const node = createNode(appName, raw.type, raw.name, raw.summary, {
            steps: raw.steps || [],
            keywords: raw.keywords || [],
            views: raw.views || [],
            sources: [result.url || result.title],
            confidence: raw.confidence ?? 0.5,
          });
          if (validateNode(node)) nodes.push(node);
        } catch {
          // skip invalid nodes
        }
      }

      const edges = [];
      for (const raw of (parsed.edges || [])) {
        try {
          if (!EDGE_TYPES.includes(raw.type)) continue;
          const sourceId = findNodeId(nodes, raw.sourceName);
          const targetId = findNodeId(nodes, raw.targetName);
          if (sourceId && targetId) {
            edges.push(createEdge(sourceId, targetId, raw.type, raw.weight ?? 0.5));
          }
        } catch {
          // skip invalid edges
        }
      }

      log(`Extracted ${nodes.length} nodes, ${edges.length} edges from "${result.title}"`);
      allNodes.push(...nodes);
      allEdges.push(...edges);
    } catch (err) {
      log(`Extraction failed for "${result.title}": ${err.message}`);
    }
  }

  log(`Total extraction: ${allNodes.length} nodes, ${allEdges.length} edges for ${appName}`);
  return { nodes: allNodes, edges: allEdges };
}

function parseExtractionResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

function findNodeId(nodes, name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  const node = nodes.find(n => n.name.toLowerCase() === lower);
  return node ? node.id : null;
}

module.exports = { extractNodes };
