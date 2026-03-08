const fs = require('node:fs');
const path = require('node:path');
const { graphsDir, getGraphPath } = require('../main/paths');
const { validateGraph } = require('./schema');

function loadGraph(appName) {
  try {
    const filePath = getGraphPath(appName);
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!validateGraph(data)) {
      fs.unlinkSync(filePath);
      return null;
    }
    // Ensure viewIndex exists (older graphs may lack it)
    if (!data.viewIndex) {
      rebuildViewIndex(data);
    }
    return data;
  } catch (err) {
    return null;
  }
}

function saveGraph(graph) {
  graph.nodeCount = Object.keys(graph.nodes).length;
  const filePath = getGraphPath(graph.appName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(graph, null, 2));
}

function deleteGraph(appName) {
  try {
    const filePath = getGraphPath(appName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    // ignore
  }
}

function listGraphs() {
  try {
    if (!fs.existsSync(graphsDir)) return [];
    const files = fs.readdirSync(graphsDir).filter(f => f.endsWith('.json'));
    const results = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(graphsDir, file), 'utf-8'));
        results.push({
          appName: data.appName,
          nodeCount: data.nodeCount || Object.keys(data.nodes || {}).length,
          lastEnriched: data.lastEnriched,
        });
      } catch {
        // skip corrupt files
      }
    }
    return results;
  } catch {
    return [];
  }
}

function rebuildViewIndex(graph) {
  const index = {};
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    for (const view of (node.views || [])) {
      const key = view.toLowerCase();
      if (!index[key]) index[key] = [];
      if (!index[key].includes(nodeId)) index[key].push(nodeId);
    }
  }
  graph.viewIndex = index;
}

function mergeNodes(graph, newNodes, newEdges) {
  for (const node of newNodes) {
    const existing = graph.nodes[node.id];
    if (existing) {
      if (node.confidence > existing.confidence) {
        const mergedSources = [...new Set([...existing.sources, ...node.sources])];
        graph.nodes[node.id] = { ...node, sources: mergedSources };
      } else {
        existing.sources = [...new Set([...existing.sources, ...node.sources])];
      }
    } else {
      graph.nodes[node.id] = node;
    }
  }

  for (const edge of newEdges) {
    const exists = graph.edges.some(
      e => e.source === edge.source && e.target === edge.target && e.type === edge.type
    );
    if (!exists) {
      graph.edges.push(edge);
    }
  }

  rebuildViewIndex(graph);
}

function addWorkflowNode(graph, workflowNode) {
  // Check for existing similar workflow by fuzzy name match
  const { tokenize, keywordOverlap } = require('./graph-query');
  const newTokens = tokenize(workflowNode.name);

  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.type !== 'workflow') continue;
    const existingTokens = tokenize(node.name);
    if (keywordOverlap(newTokens, existingTokens) > 0.6) {
      // Merge: keep version with more steps or higher confidence
      const keepNew = workflowNode.steps.length > node.steps.length || workflowNode.confidence > node.confidence;
      if (keepNew) {
        graph.nodes[id] = { ...workflowNode, id, completionCount: (node.completionCount || 0) + (workflowNode.completionCount || 0) };
      } else {
        node.completionCount = (node.completionCount || 0) + (workflowNode.completionCount || 0);
        node.sources = [...new Set([...node.sources, ...workflowNode.sources])];
      }
      rebuildViewIndex(graph);
      return;
    }
  }

  // No match — add as new node
  graph.nodes[workflowNode.id] = workflowNode;
  rebuildViewIndex(graph);
}

module.exports = {
  loadGraph,
  saveGraph,
  deleteGraph,
  listGraphs,
  rebuildViewIndex,
  mergeNodes,
  addWorkflowNode,
};
