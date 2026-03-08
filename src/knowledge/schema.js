const NODE_TYPES = ['feature', 'ui_element', 'task', 'concept', 'shortcut', 'setting', 'troubleshoot', 'workflow'];
const EDGE_TYPES = ['prerequisite_for', 'located_in', 'shortcut_for', 'related_to', 'part_of', 'solves'];

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function createNode(appName, type, name, summary, opts = {}) {
  if (!NODE_TYPES.includes(type)) throw new Error(`Invalid node type: ${type}`);
  return {
    id: `${slugify(appName)}:${slugify(name)}`,
    type,
    name,
    summary,
    steps: opts.steps || [],
    keywords: opts.keywords || [],
    views: opts.views || [],
    sources: opts.sources || [],
    confidence: opts.confidence ?? 0.5,
    lastUpdated: new Date().toISOString(),
    userNotes: opts.userNotes || '',
  };
}

function createEdge(source, target, type, weight = 0.5) {
  if (!EDGE_TYPES.includes(type)) throw new Error(`Invalid edge type: ${type}`);
  return { source, target, type, weight };
}

function createEmptyGraph(appName, appType, description) {
  return {
    appName,
    appType: appType || 'desktop',
    version: null,
    description: description || '',
    graphVersion: 1,
    createdAt: new Date().toISOString(),
    lastEnriched: new Date().toISOString(),
    nodeCount: 0,
    nodes: {},
    edges: [],
    viewIndex: {},
  };
}

function validateNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (!node.id || typeof node.id !== 'string') return false;
  if (!NODE_TYPES.includes(node.type)) return false;
  if (!node.name || typeof node.name !== 'string') return false;
  if (!node.summary || typeof node.summary !== 'string') return false;
  if (!Array.isArray(node.keywords)) return false;
  if (!Array.isArray(node.views)) return false;
  if (typeof node.confidence !== 'number' || node.confidence < 0 || node.confidence > 1) return false;
  return true;
}

function validateGraph(graph) {
  if (!graph || typeof graph !== 'object') return false;
  if (!graph.appName || typeof graph.appName !== 'string') return false;
  if (!['web', 'desktop', 'mobile'].includes(graph.appType)) return false;
  if (typeof graph.nodes !== 'object' || graph.nodes === null) return false;
  if (!Array.isArray(graph.edges)) return false;
  if (typeof graph.viewIndex !== 'object' || graph.viewIndex === null) return false;
  for (const edge of graph.edges) {
    if (!EDGE_TYPES.includes(edge.type)) return false;
    if (!edge.source || !edge.target) return false;
  }
  return true;
}

module.exports = {
  NODE_TYPES,
  EDGE_TYPES,
  slugify,
  createNode,
  createEdge,
  createEmptyGraph,
  validateNode,
  validateGraph,
};
