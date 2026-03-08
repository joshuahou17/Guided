const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'not', 'no', 'if', 'then', 'than', 'too', 'very', 'just', 'about',
  'up', 'out', 'so', 'it', 'its', 'this', 'that', 'these', 'those',
]);

function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

function keywordOverlap(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setB = new Set(tokensB);
  const matches = tokensA.filter(t => setB.has(t)).length;
  return matches / Math.max(tokensA.length, tokensB.length);
}

function recencyBoost(lastUpdated) {
  if (!lastUpdated) return 0.6;
  const age = Date.now() - new Date(lastUpdated).getTime();
  const days = age / (1000 * 60 * 60 * 24);
  if (days < 7) return 1.0;
  if (days < 30) return 0.8;
  return 0.6;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

function queryGraph(graph, options = {}) {
  const {
    currentView = '',
    visibleElements = [],
    userIntent = '',
    maxNodes = 20,
    maxTokens = 2500,
  } = options;

  if (!graph || !graph.nodes || Object.keys(graph.nodes).length === 0) {
    return { nodes: [], edges: [] };
  }

  const scored = {};
  const allNodes = graph.nodes;

  // 1. Exact view index lookup
  const viewKey = currentView.toLowerCase();
  if (graph.viewIndex[viewKey]) {
    for (const nodeId of graph.viewIndex[viewKey]) {
      scored[nodeId] = (scored[nodeId] || 0) + 3.0;
    }
  }

  // 2. Fuzzy view match
  const viewTokens = tokenize(currentView);
  for (const [key, nodeIds] of Object.entries(graph.viewIndex)) {
    const keyTokens = tokenize(key);
    const overlap = keywordOverlap(viewTokens, keyTokens);
    if (overlap > 0.3) {
      for (const nodeId of nodeIds) {
        scored[nodeId] = (scored[nodeId] || 0) + overlap * 2.0;
      }
    }
  }

  // 3. Keyword match against visibleElements + userIntent
  const queryTokens = [
    ...tokenize(userIntent),
    ...visibleElements.flatMap(e => tokenize(e)),
  ];

  if (queryTokens.length > 0) {
    for (const [nodeId, node] of Object.entries(allNodes)) {
      const nodeTokens = [
        ...tokenize(node.name),
        ...(node.keywords || []).flatMap(k => tokenize(k)),
      ];
      const overlap = keywordOverlap(queryTokens, nodeTokens);
      if (overlap > 0.1) {
        scored[nodeId] = (scored[nodeId] || 0) + overlap * 2.0;
      }
    }
  }

  // 4. Edge traversal (1 hop from matched nodes)
  const matchedIds = new Set(Object.keys(scored));
  for (const edge of graph.edges) {
    if (matchedIds.has(edge.source) || matchedIds.has(edge.target)) {
      const bonus = edge.weight * 0.5;
      if (edge.type === 'prerequisite_for' && matchedIds.has(edge.source)) {
        scored[edge.target] = (scored[edge.target] || 0) + bonus + 0.5;
      }
      if (edge.type === 'shortcut_for' && matchedIds.has(edge.target)) {
        scored[edge.source] = (scored[edge.source] || 0) + bonus + 0.3;
      }
      if (edge.type === 'located_in' && matchedIds.has(edge.source)) {
        scored[edge.target] = (scored[edge.target] || 0) + bonus + 0.2;
      }
      if (edge.type === 'related_to') {
        const other = matchedIds.has(edge.source) ? edge.target : edge.source;
        scored[other] = (scored[other] || 0) + bonus;
      }
    }
  }

  // 5. Apply confidence and recency to final scores
  for (const nodeId of Object.keys(scored)) {
    const node = allNodes[nodeId];
    if (!node) { delete scored[nodeId]; continue; }
    scored[nodeId] *= (node.confidence || 0.5) * recencyBoost(node.lastUpdated);
  }

  // 6. Rank and take top N
  let ranked = Object.entries(scored)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxNodes);

  // 7. Token budget check
  let totalTokens = 0;
  const budgetRanked = [];
  for (const [nodeId, score] of ranked) {
    const node = allNodes[nodeId];
    const nodeTokens = estimateTokens(node.summary) + estimateTokens(node.name) +
      (node.steps || []).reduce((sum, s) => sum + estimateTokens(s), 0);
    if (totalTokens + nodeTokens > maxTokens) continue;
    totalTokens += nodeTokens;
    budgetRanked.push(nodeId);
  }

  // Collect result nodes and relevant edges
  const resultNodeIds = new Set(budgetRanked);
  const resultNodes = budgetRanked.map(id => allNodes[id]).filter(Boolean);
  const resultEdges = graph.edges.filter(
    e => resultNodeIds.has(e.source) && resultNodeIds.has(e.target)
  );

  return { nodes: resultNodes, edges: resultEdges };
}

function querySimilarWorkflows(graph, goal, maxResults = 3) {
  if (!graph || !graph.nodes) return [];

  const goalTokens = tokenize(goal);
  if (goalTokens.length === 0) return [];

  const scored = [];
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== 'workflow') continue;
    if (!node.steps || node.steps.length === 0) continue;

    const nodeTokens = [...tokenize(node.name), ...(node.keywords || []).flatMap(k => tokenize(k))];
    const overlap = keywordOverlap(goalTokens, nodeTokens);
    if (overlap <= 0.1) continue;

    const completionCount = node.completionCount || 0;
    const confidence = node.confidence || 0.5;
    const score = (overlap * 0.6) + (Math.min(completionCount, 5) / 5 * 0.2) + (confidence * 0.2);
    scored.push({ ...node, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

module.exports = { queryGraph, querySimilarWorkflows, tokenize, keywordOverlap };
