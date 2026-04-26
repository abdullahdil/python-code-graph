const vscode = acquireVsCodeApi();

const canvas = document.getElementById('graphCanvas');
const context = canvas.getContext('2d');
const statsEl = document.getElementById('stats');
const summaryChipsEl = document.getElementById('summaryChips');
const searchInput = document.getElementById('searchInput');
const resetButton = document.getElementById('resetButton');
const refreshButton = document.getElementById('refreshButton');
const openButton = document.getElementById('openButton');
const emptyState = document.getElementById('emptyState');
const startHereList = document.getElementById('startHereList');
const criticalPathsList = document.getElementById('criticalPathsList');
const hotspotsList = document.getElementById('hotspotsList');
const inspectorTitle = document.getElementById('inspectorTitle');
const inspectorContent = document.getElementById('inspectorContent');
const edgeFilterInputs = Array.from(document.querySelectorAll('.filters input[type="checkbox"]'));
const tabButtons = Array.from(document.querySelectorAll('.tab'));

const state = {
  graph: { nodes: [], edges: [], insights: {} },
  nodes: [],
  edges: [],
  selectedNodeId: null,
  hoveredNodeId: null,
  searchText: '',
  dragNodeId: null,
  isPanning: false,
  lastPointer: null,
  activeTab: 'overview',
  transform: {
    x: 0,
    y: 0,
    scale: 1
  }
};

function colorForNode(kind) {
  switch (kind) {
    case 'file':
      return '#f59e0b';
    case 'class':
      return '#a78bfa';
    case 'method':
      return '#60a5fa';
    case 'function':
    default:
      return '#34d399';
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function initializeGraph(graph) {
  state.graph = graph || { nodes: [], edges: [], insights: {} };
  state.selectedNodeId = null;
  state.hoveredNodeId = null;

  const width = canvas.clientWidth || 900;
  const height = canvas.clientHeight || 700;
  const radius = Math.min(width, height) * 0.3;
  const entryIds = new Set((state.graph.insights?.entryPoints || []).map((item) => item.id));
  const hotspotIds = new Set((state.graph.insights?.hotspots || []).map((item) => item.id));

  state.nodes = state.graph.nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(state.graph.nodes.length, 1);
    const baseCluster = node.kind === 'file' ? 1.15 : node.kind === 'class' ? 0.88 : 0.72;
    const focusMultiplier = entryIds.has(node.id) ? 0.5 : hotspotIds.has(node.id) ? 0.68 : baseCluster;
    return {
      ...node,
      x: Math.cos(angle) * radius * focusMultiplier,
      y: Math.sin(angle) * radius * focusMultiplier,
      vx: 0,
      vy: 0,
      r: node.kind === 'file' ? 11 : node.kind === 'class' ? 9 : 7
    };
  });

  applyEdgeFilters();
  resetView();
  emptyState.classList.toggle('hidden', state.nodes.length > 0);
  renderSummary();
  renderInsights();
  updateStats();

  const defaultNodeId = (state.graph.insights?.entryPoints || [])[0]?.id
    || (state.graph.insights?.hotspots || [])[0]?.id
    || state.nodes[0]?.id
    || null;
  if (defaultNodeId) {
    selectNode(defaultNodeId, { center: false });
  } else {
    renderSelection(null);
  }
}

function getVisibleEdgeKinds() {
  return new Set(edgeFilterInputs.filter((input) => input.checked).map((input) => input.value));
}

function applyEdgeFilters() {
  const visibleKinds = getVisibleEdgeKinds();
  state.edges = state.graph.edges.filter((edge) => visibleKinds.has(edge.kind));
  updateStats();
}

function updateStats() {
  const stats = state.graph.stats || { nodes: state.nodes.length, edges: state.edges.length };
  const parts = [
    `${stats.files || 0} files`,
    `${state.nodes.length} nodes`,
    `${state.edges.length} visible edges`
  ];
  if (stats.entryPoints) {
    parts.push(`${stats.entryPoints} entry points`);
  }
  statsEl.textContent = parts.join(' • ');
}

function renderSummary() {
  const stats = state.graph.stats || {};
  const hotspots = state.graph.insights?.hotspots || [];
  const chips = [
    { label: 'Entry points', value: stats.entryPoints || 0 },
    { label: 'Critical paths', value: stats.criticalPaths || 0 },
    { label: 'Hotspots', value: hotspots.length || 0 },
    { label: 'Graph edges', value: stats.edges || 0 }
  ];
  summaryChipsEl.innerHTML = chips.map((chip) => `
    <div class="chip">
      <span class="chip__value">${chip.value}</span>
      <span class="chip__label">${escapeHtml(chip.label)}</span>
    </div>
  `).join('');
}

function renderInsights() {
  renderStartHere();
  renderCriticalPaths();
  renderHotspots();
}

function renderStartHere() {
  const entryPoints = state.graph.insights?.entryPoints || [];
  if (!entryPoints.length) {
    startHereList.innerHTML = '<div class="empty-mini">No entry points detected yet.</div>';
    return;
  }

  startHereList.innerHTML = entryPoints.map((item) => `
    <button class="list-card list-card--entry" data-node-id="${escapeHtml(item.id)}">
      <div class="list-card__top">
        <span class="pill pill--${escapeHtml(item.category || 'default')}">${escapeHtml(item.category || 'entry')}</span>
        <span class="list-card__path">${escapeHtml(item.relativePath)}:${item.line || 1}</span>
      </div>
      <div class="list-card__title">${escapeHtml(item.route || item.entryLabel || item.label)}</div>
      <div class="list-card__text">${escapeHtml(item.reason || '')}</div>
    </button>
  `).join('');
}

function renderCriticalPaths() {
  const criticalPaths = state.graph.insights?.criticalPaths || [];
  if (!criticalPaths.length) {
    criticalPathsList.innerHTML = '<div class="empty-mini">No critical paths yet.</div>';
    return;
  }

  criticalPathsList.innerHTML = criticalPaths.map((item) => {
    const preview = item.nodes.slice(0, 4).map((node) => `
      <span class="path-node" data-node-id="${escapeHtml(node.id)}">${escapeHtml(node.label)}</span>
    `).join('<span class="path-arrow">→</span>');
    return `
      <div class="list-card list-card--path">
        <button class="list-card__title list-card__title--button" data-node-id="${escapeHtml(item.entryId)}">${escapeHtml(item.title)}</button>
        <div class="list-card__text">${escapeHtml(item.subtitle || '')}</div>
        <div class="path-preview">${preview}</div>
        <div class="list-card__meta">${escapeHtml(item.summary || '')}</div>
      </div>
    `;
  }).join('');
}

function renderHotspots() {
  const hotspots = state.graph.insights?.hotspots || [];
  if (!hotspots.length) {
    hotspotsList.innerHTML = '<div class="empty-mini">No hotspots yet.</div>';
    return;
  }

  hotspotsList.innerHTML = hotspots.map((item) => `
    <button class="list-card list-card--hot" data-node-id="${escapeHtml(item.id)}">
      <div class="list-card__top">
        <span class="pill pill--hot">hotspot</span>
        <span class="list-card__path">${escapeHtml(item.relativePath)}:${item.line || 1}</span>
      </div>
      <div class="list-card__title">${escapeHtml(item.label)}</div>
      <div class="list-card__text">${escapeHtml((item.reasons || []).slice(0, 2).join(' • '))}</div>
      <div class="list-card__meta">Score ${Math.round(item.score || 0)}</div>
    </button>
  `).join('');
}

function runSimulationStep() {
  if (!state.nodes.length) {
    return;
  }

  const nodeMap = new Map(state.nodes.map((node) => [node.id, node]));
  const repulsion = 15000;
  const springStrength = 0.002;
  const centerAttraction = 0.001;

  for (let i = 0; i < state.nodes.length; i += 1) {
    const nodeA = state.nodes[i];
    for (let j = i + 1; j < state.nodes.length; j += 1) {
      const nodeB = state.nodes[j];
      const dx = nodeB.x - nodeA.x;
      const dy = nodeB.y - nodeA.y;
      const distSq = Math.max(dx * dx + dy * dy, 30);
      const dist = Math.sqrt(distSq);
      const force = repulsion / distSq;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      nodeA.vx -= fx;
      nodeA.vy -= fy;
      nodeB.vx += fx;
      nodeB.vy += fy;
    }
  }

  for (const edge of state.edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) {
      continue;
    }
    const springLength = edge.kind === 'contains' ? 135 : edge.kind === 'imports' ? 120 : 92;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const force = (dist - springLength) * springStrength;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    source.vx += fx;
    source.vy += fy;
    target.vx -= fx;
    target.vy -= fy;
  }

  for (const node of state.nodes) {
    if (state.dragNodeId === node.id) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx += (-node.x) * centerAttraction;
    node.vy += (-node.y) * centerAttraction;
    node.vx *= 0.85;
    node.vy *= 0.85;
    node.x += node.vx;
    node.y += node.vy;
  }
}

function worldToScreen(point) {
  return {
    x: point.x * state.transform.scale + state.transform.x,
    y: point.y * state.transform.scale + state.transform.y
  };
}

function screenToWorld(point) {
  return {
    x: (point.x - state.transform.x) / state.transform.scale,
    y: (point.y - state.transform.y) / state.transform.scale
  };
}

function getNodeMap() {
  return new Map(state.nodes.map((node) => [node.id, node]));
}

function getSelectedNode() {
  return state.nodes.find((node) => node.id === state.selectedNodeId) || null;
}

function getFocusNodeId() {
  if (state.selectedNodeId) {
    return state.selectedNodeId;
  }
  if (!state.searchText.trim()) {
    return null;
  }
  const query = state.searchText.trim().toLowerCase();
  const match = state.nodes.find((node) => searchableText(node).includes(query));
  return match ? match.id : null;
}

function searchableText(node) {
  return `${node.label} ${node.relativePath} ${node.qualifiedName || ''} ${node.entryRoute || ''}`.toLowerCase();
}

function getNeighborhood(nodeId) {
  if (!nodeId) {
    return { nodes: new Set(), edges: new Set() };
  }

  const nodeIds = new Set([nodeId]);
  const edgeIds = new Set();
  for (const edge of state.edges) {
    if (edge.source === nodeId || edge.target === nodeId) {
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
      edgeIds.add(edge.id);
    }
  }
  return { nodes: nodeIds, edges: edgeIds };
}

function drawGrid(width, height) {
  const gap = 48 * Math.max(state.transform.scale, 0.45);
  context.save();
  context.strokeStyle = 'rgba(148, 163, 184, 0.07)';
  context.lineWidth = 1;
  for (let x = state.transform.x % gap; x < width; x += gap) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = state.transform.y % gap; y < height; y += gap) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.restore();
}

function drawLabel(text, x, y) {
  context.font = '12px sans-serif';
  const width = context.measureText(text).width + 12;
  context.fillStyle = 'rgba(3, 7, 18, 0.86)';
  context.fillRect(x, y - 12, width, 20);
  context.fillStyle = '#e5edf8';
  context.fillText(text, x + 6, y + 3);
}

function resetView() {
  state.transform.x = (canvas.clientWidth || 900) * 0.42;
  state.transform.y = (canvas.clientHeight || 700) / 2;
  state.transform.scale = 1;
}

function centerOnNode(node) {
  if (!node) {
    return;
  }
  state.transform.x = (canvas.clientWidth || 900) * 0.42 - node.x * state.transform.scale;
  state.transform.y = (canvas.clientHeight || 700) / 2 - node.y * state.transform.scale;
}

function draw() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  context.clearRect(0, 0, width, height);
  drawGrid(width, height);

  const nodeMap = getNodeMap();
  const query = state.searchText.trim().toLowerCase();
  const focusNodeId = getFocusNodeId();
  const neighborhood = getNeighborhood(focusNodeId);

  for (const edge of state.edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) {
      continue;
    }
    const a = worldToScreen(source);
    const b = worldToScreen(target);
    const isFocused = neighborhood.edges.has(edge.id);
    const dimmed = focusNodeId && !isFocused;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.lineWidth = isFocused ? 2.6 : edge.kind === 'calls' ? 1.8 : 1.2;
    context.strokeStyle = isFocused
      ? 'rgba(255, 255, 255, 0.92)'
      : edge.kind === 'calls'
        ? (dimmed ? 'rgba(96, 165, 250, 0.12)' : 'rgba(96, 165, 250, 0.74)')
        : edge.kind === 'imports'
          ? (dimmed ? 'rgba(167, 139, 250, 0.12)' : 'rgba(167, 139, 250, 0.58)')
          : (dimmed ? 'rgba(148, 163, 184, 0.06)' : 'rgba(148, 163, 184, 0.2)');
    context.stroke();
  }

  for (const node of state.nodes) {
    const pos = worldToScreen(node);
    const isSelected = node.id === state.selectedNodeId;
    const isHovered = node.id === state.hoveredNodeId;
    const isSearchMatch = query && searchableText(node).includes(query);
    const inNeighborhood = !focusNodeId || neighborhood.nodes.has(node.id);
    const radius = Math.max(node.r * state.transform.scale, 4);

    if (node.isHotspot) {
      context.beginPath();
      context.arc(pos.x, pos.y, radius + 7, 0, Math.PI * 2);
      context.fillStyle = 'rgba(251, 113, 133, 0.12)';
      context.fill();
    }

    if (node.isEntryPoint) {
      context.beginPath();
      context.arc(pos.x, pos.y, radius + 4, 0, Math.PI * 2);
      context.strokeStyle = 'rgba(251, 191, 36, 0.9)';
      context.lineWidth = 1.8;
      context.stroke();
    }

    context.beginPath();
    context.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    context.fillStyle = inNeighborhood ? colorForNode(node.kind) : 'rgba(71, 85, 105, 0.34)';
    context.fill();

    if (isSelected || isHovered || isSearchMatch) {
      context.beginPath();
      context.arc(pos.x, pos.y, radius + 7, 0, Math.PI * 2);
      context.strokeStyle = isSelected ? '#f8fafc' : '#93c5fd';
      context.lineWidth = 2;
      context.stroke();
    }

    if (state.transform.scale > 0.65 || isSelected || isSearchMatch || node.isEntryPoint) {
      drawLabel(node.label, pos.x + radius + 8, pos.y + 5);
    }
  }
}

function tick() {
  runSimulationStep();
  draw();
  requestAnimationFrame(tick);
}

function getPointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function getNodeAtScreenPoint(point) {
  for (let index = state.nodes.length - 1; index >= 0; index -= 1) {
    const node = state.nodes[index];
    const pos = worldToScreen(node);
    const dx = point.x - pos.x;
    const dy = point.y - pos.y;
    const radius = Math.max(node.r * state.transform.scale, 6) + 6;
    if (dx * dx + dy * dy <= radius * radius) {
      return node;
    }
  }
  return null;
}

function selectNode(nodeId, options = {}) {
  const node = state.nodes.find((item) => item.id === nodeId) || null;
  state.selectedNodeId = node ? node.id : null;
  renderSelection(node);
  if (node && options.center !== false) {
    centerOnNode(node);
  }
}

function renderSelection(node) {
  inspectorTitle.textContent = node ? node.label : 'Nothing selected';
  openButton.disabled = !node;
  inspectorContent.classList.toggle('muted', !node);

  if (!node) {
    inspectorContent.innerHTML = 'Select a node to inspect it.';
    return;
  }

  if (state.activeTab === 'overview') {
    inspectorContent.innerHTML = renderOverview(node);
  } else if (state.activeTab === 'explain') {
    inspectorContent.innerHTML = renderExplain(node);
  } else if (state.activeTab === 'impact') {
    inspectorContent.innerHTML = renderImpact(node);
  } else {
    inspectorContent.innerHTML = renderPath(node);
  }
}

function renderOverview(node) {
  const outgoing = state.graph.edges.filter((edge) => edge.source === node.id && edge.kind !== 'contains').length;
  const incoming = state.graph.edges.filter((edge) => edge.target === node.id && edge.kind !== 'contains').length;
  return `
    <div class="detail-header">
      <span class="kind-badge">${escapeHtml(node.kind)}</span>
      ${node.isEntryPoint ? `<span class="kind-badge kind-badge--entry">${escapeHtml(node.entryCategory || 'entry')}</span>` : ''}
      ${node.isHotspot ? '<span class="kind-badge kind-badge--hot">hotspot</span>' : ''}
    </div>
    <div class="detail-grid">
      <div class="detail-row"><div class="detail-label">Path</div><div class="detail-value">${escapeHtml(node.relativePath)}</div></div>
      <div class="detail-row"><div class="detail-label">Line</div><div class="detail-value">${node.line || 1}</div></div>
      <div class="detail-row"><div class="detail-label">Qualified name</div><div class="detail-value">${escapeHtml(node.qualifiedName || node.label)}</div></div>
      ${node.signature ? `<div class="detail-row"><div class="detail-label">Signature</div><div class="detail-value">${escapeHtml(node.signature)}</div></div>` : ''}
      ${node.entryReason ? `<div class="detail-row"><div class="detail-label">Why it matters</div><div class="detail-value">${escapeHtml(node.entryReason)}</div></div>` : ''}
      ${node.docstring ? `<div class="detail-row"><div class="detail-label">Docstring</div><div class="detail-value">${escapeHtml(node.docstring)}</div></div>` : ''}
    </div>
    <div class="metric-row">
      <div class="metric"><strong>${outgoing}</strong><span>Outgoing links</span></div>
      <div class="metric"><strong>${incoming}</strong><span>Incoming links</span></div>
    </div>
  `;
}

function renderExplain(node) {
  const related = getNeighbors(node.id, 'outgoing', ['calls', 'imports']).slice(0, 4);
  const callers = getNeighbors(node.id, 'incoming', ['calls']).slice(0, 4);
  const paths = getPathsToNode(node.id, 3, 5);
  const sentences = [];

  sentences.push(explainRole(node));

  if (node.docstring) {
    sentences.push(`The source includes a docstring: “${node.docstring}”.`);
  }

  if (node.isEntryPoint) {
    sentences.push(`This acts as an entry point for the codebase as a ${node.entryCategory || 'runtime'} surface${node.entryRoute ? ` (${node.entryRoute})` : ''}.`);
  }

  if (related.length) {
    sentences.push(`It directly depends on ${joinLabels(related)}.`);
  }

  if (callers.length) {
    sentences.push(`It is used by ${joinLabels(callers)}.`);
  }

  if (!callers.length && !node.isEntryPoint) {
    sentences.push('It currently looks isolated from discovered callers, which may mean internal utility use, dynamic invocation, or incomplete static resolution.');
  }

  if (paths.length) {
    const first = paths[0].map((item) => item.label).join(' → ');
    sentences.push(`One high-signal path reaching this node is ${first}.`);
  }

  return `
    <div class="prose-block">
      ${sentences.map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join('')}
      <div class="micro-note">Generated from static graph structure, docstrings, imports, and caller relationships.</div>
    </div>
  `;
}

function renderImpact(node) {
  const directCallers = getNeighbors(node.id, 'incoming', ['calls']);
  const directDependencies = getNeighbors(node.id, 'outgoing', ['calls', 'imports']);
  const downstream = traverse(node.id, getAdjacencyMap(['calls', 'imports'], false));
  const upstream = traverse(node.id, getAdjacencyMap(['calls', 'imports'], true));
  const impactedEntries = (state.graph.insights?.entryPoints || []).filter((entry) => {
    const reachable = traverse(entry.id, getAdjacencyMap(['calls', 'imports'], false));
    return reachable.has(node.id) || entry.id === node.id;
  });
  const risk = computeRiskLabel({
    directCallers: directCallers.length,
    directDependencies: directDependencies.length,
    downstream: downstream.size,
    upstream: upstream.size,
    impactedEntries: impactedEntries.length
  });

  return `
    <div class="impact-hero impact-hero--${risk.tone}">
      <div class="impact-hero__label">Blast radius</div>
      <div class="impact-hero__value">${risk.label}</div>
      <div class="impact-hero__text">${escapeHtml(risk.text)}</div>
    </div>
    <div class="metric-row metric-row--wide">
      <div class="metric"><strong>${directCallers.length}</strong><span>Direct callers</span></div>
      <div class="metric"><strong>${directDependencies.length}</strong><span>Direct dependencies</span></div>
      <div class="metric"><strong>${upstream.size}</strong><span>Upstream symbols</span></div>
      <div class="metric"><strong>${downstream.size}</strong><span>Downstream symbols</span></div>
    </div>
    <div class="detail-section">
      <div class="detail-label">Affected entry points</div>
      <div class="token-list">${impactedEntries.length ? impactedEntries.map((item) => tokenButton(item.id, item.route || item.entryLabel || item.label)).join('') : '<span class="token">None detected</span>'}</div>
    </div>
    <div class="detail-section">
      <div class="detail-label">Top direct callers</div>
      <div class="token-list">${directCallers.length ? directCallers.slice(0, 6).map((item) => tokenButton(item.id, item.label)).join('') : '<span class="token">No direct callers found</span>'}</div>
    </div>
    <div class="detail-section">
      <div class="detail-label">Top direct dependencies</div>
      <div class="token-list">${directDependencies.length ? directDependencies.slice(0, 6).map((item) => tokenButton(item.id, item.label)).join('') : '<span class="token">No direct dependencies found</span>'}</div>
    </div>
  `;
}

function renderPath(node) {
  const paths = getPathsToNode(node.id, 4, 6);
  const outgoing = getNeighbors(node.id, 'outgoing', ['calls']).slice(0, 5);
  if (node.isEntryPoint) {
    const critical = (state.graph.insights?.criticalPaths || []).find((item) => item.entryId === node.id);
    return `
      <div class="detail-section">
        <div class="detail-label">Entry point</div>
        <div class="detail-value">${escapeHtml(node.entryReason || 'Detected as an entry point.')}</div>
      </div>
      ${critical ? `<div class="path-block"><div class="path-track">${critical.nodes.map((item) => tokenButton(item.id, item.label, true)).join('<span class="path-arrow">→</span>')}</div></div>` : ''}
      <div class="detail-section">
        <div class="detail-label">Next likely calls</div>
        <div class="token-list">${outgoing.length ? outgoing.map((item) => tokenButton(item.id, item.label)).join('') : '<span class="token">No downstream call path found</span>'}</div>
      </div>
    `;
  }

  return `
    <div class="detail-section">
      <div class="detail-label">Paths from entry points</div>
      ${paths.length ? paths.map((pathItems) => `
        <div class="path-block">
          <div class="path-track">${pathItems.map((item) => tokenButton(item.id, item.label, true)).join('<span class="path-arrow">→</span>')}</div>
        </div>
      `).join('') : '<div class="empty-mini">No path from a detected entry point was found.</div>'}
    </div>
    <div class="detail-section">
      <div class="detail-label">Next likely calls</div>
      <div class="token-list">${outgoing.length ? outgoing.map((item) => tokenButton(item.id, item.label)).join('') : '<span class="token">No downstream call path found</span>'}</div>
    </div>
  `;
}

function explainRole(node) {
  const location = node.relativePath ? ` in ${node.relativePath}` : '';
  if (node.kind === 'file') {
    return `${node.label} is a source file${location} that groups related symbols and imports.`;
  }
  if (node.kind === 'class') {
    return `${node.label} is a class${location} that likely owns state and coordinates behavior through its methods.`;
  }
  if (node.kind === 'method') {
    return `${node.label} is a method${location} that contributes behavior to ${node.qualifiedName.split('.').slice(0, -1).join('.') || 'its parent class'}.`;
  }
  return `${node.label} is a function${location} that encapsulates a reusable unit of application logic.`;
}

function joinLabels(items) {
  const labels = items.map((item) => item.label);
  if (labels.length === 1) {
    return labels[0];
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

function computeRiskLabel(metrics) {
  const score = (metrics.directCallers * 4) + (metrics.directDependencies * 2) + metrics.downstream + metrics.upstream + (metrics.impactedEntries * 5);
  if (score >= 24) {
    return {
      label: 'High',
      tone: 'high',
      text: 'This symbol sits on a busy path. Changes here likely need targeted review and regression testing.'
    };
  }
  if (score >= 10) {
    return {
      label: 'Medium',
      tone: 'medium',
      text: 'This symbol has meaningful connections. Refactor carefully and inspect direct callers.'
    };
  }
  return {
    label: 'Low',
    tone: 'low',
    text: 'This symbol appears relatively contained based on the current static graph.'
  };
}

function getAdjacencyMap(kinds, reverse) {
  const key = reverse ? 'semanticReverseAdj' : 'semanticAdj';
  if (kinds.length === 2 && kinds.includes('calls') && kinds.includes('imports')) {
    return new Map(Object.entries(state.graph.insights?.maps?.[key] || {}));
  }
  const map = new Map();
  for (const edge of state.graph.edges) {
    if (!kinds.includes(edge.kind)) {
      continue;
    }
    const source = reverse ? edge.target : edge.source;
    const target = reverse ? edge.source : edge.target;
    if (!map.has(source)) {
      map.set(source, []);
    }
    map.get(source).push(target);
  }
  return map;
}

function getNeighbors(nodeId, direction, kinds) {
  const nodeMap = getNodeMap();
  return state.graph.edges
    .filter((edge) => kinds.includes(edge.kind) && (direction === 'outgoing' ? edge.source === nodeId : edge.target === nodeId))
    .map((edge) => nodeMap.get(direction === 'outgoing' ? edge.target : edge.source))
    .filter(Boolean);
}

function traverse(startId, adjacency) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length) {
    const current = queue.shift();
    const neighbors = adjacency.get(current) || [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor) || neighbor === startId) {
        continue;
      }
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }
  return visited;
}

function getPathsToNode(targetId, limit, maxDepth) {
  const entries = state.graph.insights?.entryPoints || [];
  const adjacency = new Map(Object.entries(state.graph.insights?.maps?.callAdj || {}));
  const nodeMap = getNodeMap();
  const results = [];

  for (const entry of entries) {
    const path = shortestPath(entry.id, targetId, adjacency, maxDepth);
    if (path.length) {
      results.push(path.map((id) => nodeMap.get(id)).filter(Boolean));
    }
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function shortestPath(startId, targetId, adjacency, maxDepth) {
  if (startId === targetId) {
    return [startId];
  }
  const queue = [{ id: startId, path: [startId], depth: 0 }];
  const visited = new Set([startId]);
  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= maxDepth) {
      continue;
    }
    const neighbors = adjacency.get(current.id) || [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) {
        continue;
      }
      const nextPath = [...current.path, neighbor];
      if (neighbor === targetId) {
        return nextPath;
      }
      visited.add(neighbor);
      queue.push({ id: neighbor, path: nextPath, depth: current.depth + 1 });
    }
  }
  return [];
}

function tokenButton(nodeId, label, inline = false) {
  return `<button class="token ${inline ? 'token--inline' : ''}" data-node-id="${escapeHtml(nodeId)}">${escapeHtml(label)}</button>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

canvas.addEventListener('mousemove', (event) => {
  const point = getPointerPosition(event);

  if (state.dragNodeId) {
    const dragged = state.nodes.find((node) => node.id === state.dragNodeId);
    if (dragged) {
      const world = screenToWorld(point);
      dragged.x = world.x;
      dragged.y = world.y;
      dragged.vx = 0;
      dragged.vy = 0;
    }
    return;
  }

  if (state.isPanning && state.lastPointer) {
    const dx = point.x - state.lastPointer.x;
    const dy = point.y - state.lastPointer.y;
    state.transform.x += dx;
    state.transform.y += dy;
    state.lastPointer = point;
    return;
  }

  const hovered = getNodeAtScreenPoint(point);
  state.hoveredNodeId = hovered ? hovered.id : null;
});

canvas.addEventListener('mousedown', (event) => {
  const point = getPointerPosition(event);
  const node = getNodeAtScreenPoint(point);
  state.lastPointer = point;

  if (node) {
    state.dragNodeId = node.id;
    selectNode(node.id, { center: false });
    return;
  }

  state.selectedNodeId = null;
  renderSelection(null);
  state.isPanning = true;
});

window.addEventListener('mouseup', () => {
  state.dragNodeId = null;
  state.isPanning = false;
  state.lastPointer = null;
});

canvas.addEventListener('mouseleave', () => {
  state.dragNodeId = null;
  state.isPanning = false;
  state.lastPointer = null;
});

canvas.addEventListener('dblclick', (event) => {
  const node = getNodeAtScreenPoint(getPointerPosition(event));
  if (node) {
    vscode.postMessage({ type: 'openNode', node });
  }
});

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const pointer = getPointerPosition(event);
  const worldBefore = screenToWorld(pointer);
  const scaleFactor = event.deltaY < 0 ? 1.1 : 0.9;
  state.transform.scale = Math.min(3, Math.max(0.16, state.transform.scale * scaleFactor));
  state.transform.x = pointer.x - worldBefore.x * state.transform.scale;
  state.transform.y = pointer.y - worldBefore.y * state.transform.scale;
});

resetButton.addEventListener('click', () => {
  resetView();
  const node = getSelectedNode();
  if (node) {
    centerOnNode(node);
  }
});

refreshButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshGraph' });
});

openButton.addEventListener('click', () => {
  const node = getSelectedNode();
  if (node) {
    vscode.postMessage({ type: 'openNode', node });
  }
});

searchInput.addEventListener('input', () => {
  state.searchText = searchInput.value || '';
  if (!state.searchText.trim()) {
    return;
  }
  const query = state.searchText.trim().toLowerCase();
  const match = state.nodes.find((node) => searchableText(node).includes(query));
  if (match) {
    selectNode(match.id);
  }
});

edgeFilterInputs.forEach((input) => {
  input.addEventListener('change', () => {
    applyEdgeFilters();
  });
});

tabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    state.activeTab = button.dataset.tab;
    tabButtons.forEach((item) => item.classList.toggle('is-active', item === button));
    renderSelection(getSelectedNode());
  });
});

[startHereList, criticalPathsList, hotspotsList, inspectorContent].forEach((container) => {
  container.addEventListener('click', (event) => {
    const target = event.target.closest('[data-node-id]');
    if (!target) {
      return;
    }
    event.preventDefault();
    selectNode(target.dataset.nodeId);
  });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'graphData') {
    initializeGraph(message.graph || { nodes: [], edges: [], insights: {} });
  }
  if (message.type === 'graphError') {
    emptyState.textContent = message.error || 'Failed to build graph.';
    emptyState.classList.remove('hidden');
  }
});

window.addEventListener('resize', () => {
  resizeCanvas();
});

resizeCanvas();
requestAnimationFrame(tick);
vscode.postMessage({ type: 'ready' });
