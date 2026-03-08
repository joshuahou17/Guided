function formatGraphContext(appName, currentView, queryResult) {
  const { nodes, edges } = queryResult;
  if (!nodes || nodes.length === 0) return '';

  const byType = {};
  for (const node of nodes) {
    if (!byType[node.type]) byType[node.type] = [];
    byType[node.type].push(node);
  }

  const edgeMap = {};
  for (const edge of (edges || [])) {
    if (!edgeMap[edge.source]) edgeMap[edge.source] = [];
    edgeMap[edge.source].push(edge);
    if (!edgeMap[edge.target]) edgeMap[edge.target] = [];
    edgeMap[edge.target].push(edge);
  }

  const parts = [];
  parts.push(`=== Knowledge Graph Context for ${appName} ===`);
  parts.push(`Current View: ${currentView}`);
  parts.push('');

  if (byType.workflow) {
    parts.push('### Suggested Workflows');
    for (const n of byType.workflow) {
      if (n.steps && n.steps.length > 0) {
        let line = `- **${n.name}**: ${n.steps.join(' → ')}`;
        if (n.completionCount > 0) line += ` (used successfully ${n.completionCount} time${n.completionCount > 1 ? 's' : ''})`;
        parts.push(line);
      }
    }
    parts.push('');
  }

  if (byType.concept) {
    parts.push('### Key Concepts');
    for (const n of byType.concept) {
      parts.push(`- **${n.name}**: ${n.summary}`);
    }
    parts.push('');
  }

  if (byType.feature) {
    parts.push('### Features');
    for (const n of byType.feature) {
      let line = `- **${n.name}**: ${n.summary}`;
      const shortcut = findRelated(n.id, edges, nodes, 'shortcut_for', 'source');
      if (shortcut) line += `\n  - Shortcut: ${shortcut.name} — ${shortcut.summary}`;
      parts.push(line);
    }
    parts.push('');
  }

  if (byType.task) {
    parts.push('### How-To Tasks');
    for (const n of byType.task) {
      if (n.steps && n.steps.length > 0) {
        parts.push(`- **${n.name}**:`);
        n.steps.forEach((step, i) => parts.push(`  ${i + 1}. ${step}`));
      } else {
        parts.push(`- **${n.name}**: ${n.summary}`);
      }
    }
    parts.push('');
  }

  if (byType.ui_element) {
    parts.push('### UI Elements');
    for (const n of byType.ui_element) {
      const parent = findRelated(n.id, edges, nodes, 'located_in', 'target');
      let line = `- **${n.name}**: ${n.summary}`;
      if (parent) line += ` (in: ${parent.name})`;
      parts.push(line);
    }
    parts.push('');
  }

  if (byType.shortcut) {
    parts.push('### Tips & Shortcuts');
    for (const n of byType.shortcut) {
      parts.push(`- ${n.name}: ${n.summary}`);
    }
    parts.push('');
  }

  if (byType.setting) {
    parts.push('### Settings');
    for (const n of byType.setting) {
      parts.push(`- **${n.name}**: ${n.summary}`);
    }
    parts.push('');
  }

  if (byType.troubleshoot) {
    parts.push('### Troubleshooting');
    for (const n of byType.troubleshoot) {
      parts.push(`- **${n.name}**: ${n.summary}`);
    }
    parts.push('');
  }

  parts.push('=== End Knowledge Graph Context ===');
  return parts.join('\n');
}

function findRelated(nodeId, edges, nodes, edgeType, matchField) {
  if (!edges) return null;
  for (const edge of edges) {
    if (edge.type !== edgeType) continue;
    // matchField = which end of the edge THIS node is on; return the OTHER end
    if (matchField === 'source' && edge.source === nodeId) {
      return nodes.find(n => n.id === edge.target) || null;
    }
    if (matchField === 'target' && edge.target === nodeId) {
      return nodes.find(n => n.id === edge.source) || null;
    }
  }
  return null;
}

module.exports = { formatGraphContext };
