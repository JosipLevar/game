// ui/renderer-svg.js
// Draws the network as an SVG single-line diagram. Every element that can
// be selected is keyboard-focusable (tabindex=0, role=button) with a full
// textual aria-label — status is always conveyed by colour AND an icon AND
// text together, never colour alone. Built entirely with createElementNS /
// textContent; this file must never use innerHTML on data-derived strings.

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}

function text(parent, attrs, content) {
  const t = el('text', attrs, parent);
  t.textContent = content; // NEVER innerHTML — content may originate from user import/consumer names
  return t;
}

export function edgeStatus(loadingPct, limits) {
  if (loadingPct >= limits.maxCableLoadingPct) return 'critical';
  if (loadingPct >= limits.warningCableLoadingPct) return 'warn';
  return 'ok';
}
export function nodeVoltageStatus(voltagePct, limits) {
  if (voltagePct < limits.minVoltagePct) return 'critical';
  if (voltagePct < limits.warningVoltagePct) return 'warn';
  return 'ok';
}
export function transformerStatus(loadingPct, limits) {
  if (loadingPct >= limits.maxTransformerLoadingPct) return 'critical';
  if (loadingPct >= limits.warningTransformerLoadingPct) return 'warn';
  return 'ok';
}

function statusClass(status) {
  return status === 'ok' ? '' : ` status-${status}`;
}
function statusWord(status) {
  return status === 'critical' ? 'kritično' : status === 'warn' ? 'upozorenje' : 'uredu';
}
function badgeIcon(status) {
  return status === 'ok' ? '' : '⚠ ';
}

function cableLineWidth(cable) {
  const tier = cable && Number.isFinite(cable.tier) ? cable.tier : 2;
  return Math.min(7, 2 + (tier - 1) * 0.8);
}

function fmtPct(v) { return `${v.toFixed(0)}%`; }
function fmtKw(w) { return `${(w / 1000).toFixed(1)} kW`; }

/**
 * @param {HTMLElement} container - element to render into (cleared each call)
 * @param {object} params
 *   network, calculated, limits, cablesById
 *   selected: {type:'edge'|'node'|'transformer', id:string} | null
 *   onSelect: (type, id) => void
 */
export function renderNetworkSvg(container, { network, calculated, limits, cablesById, selected, onSelect }) {
  container.replaceChildren();

  const nodeById = new Map(network.nodes.map((n) => [n.id, n]));
  const xs = network.nodes.map((n) => n.x);
  const ys = network.nodes.map((n) => n.y);
  const pad = 90;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const width = Math.max(600, maxX - minX);
  const height = Math.max(340, maxY - minY);

  const svg = el('svg', {
    viewBox: `${minX} ${minY} ${width} ${height}`,
    width: Math.max(640, width),
    height,
    role: 'group',
    'aria-label': 'Jednopolna shema niskonaponske mreže'
  }, container);

  const isSelected = (type, id) => selected && selected.type === type && selected.id === id;

  function attachSelectHandlers(group, type, id) {
    group.setAttribute('tabindex', '0');
    group.setAttribute('role', 'button');
    group.addEventListener('click', () => onSelect(type, id));
    group.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        onSelect(type, id);
      }
    });
  }

  // ---- Edges (drawn first, under nodes) ----
  for (const edge of network.edges) {
    const from = nodeById.get(edge.fromNodeId);
    const to = nodeById.get(edge.toNodeId);
    if (!from || !to) continue;

    const loadingPct = calculated.edgeLoadingPct?.[edge.id] ?? 0;
    const status = edgeStatus(loadingPct, limits);
    const cable = cablesById[edge.cableTypeId];
    const lineWidth = cableLineWidth(cable);
    const current = calculated.edgeCurrents?.[edge.id] ?? 0;

    const group = el('g', { class: `grid-edge-group${isSelected('edge', edge.id) ? ' is-selected' : ''}` }, svg);
    attachSelectHandlers(group, 'edge', edge.id);

    const label = `Vod ${edge.id}, ${cable ? cable.name : 'nepoznat kabel'}, ${edge.lengthKm.toFixed(2)} km. ` +
      `Struja ${current.toFixed(1)} A, opterećenje ${fmtPct(loadingPct)} — ${statusWord(status)}.`;
    group.setAttribute('aria-label', label);

    el('line', { class: 'grid-edge-hit', x1: from.x, y1: from.y, x2: to.x, y2: to.y }, group);
    el('line', {
      class: `grid-edge-line${statusClass(status)}`,
      x1: from.x, y1: from.y, x2: to.x, y2: to.y, 'stroke-width': lineWidth
    }, group);
    if (current > 0.01) {
      el('line', { class: 'grid-edge-flow', x1: from.x, y1: from.y, x2: to.x, y2: to.y, 'stroke-width': Math.max(1, lineWidth - 1.5) }, group);
    }

    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const badgeText = `${badgeIcon(status)}${fmtPct(loadingPct)}`;
    const badgeW = 14 + badgeText.length * 6;
    el('rect', {
      class: `grid-edge-badge-bg${statusClass(status)}`,
      x: midX - badgeW / 2, y: midY - 10, width: badgeW, height: 18, rx: 4
    }, group);
    text(group, { class: `grid-edge-label${statusClass(status)}`, x: midX, y: midY + 3, 'text-anchor': 'middle' }, badgeText);
    text(group, { class: 'grid-edge-label', x: midX, y: midY + 22, 'text-anchor': 'middle' }, edge.id);
  }

  // ---- Load / junction nodes ----
  for (const node of network.nodes) {
    if (node.kind === 'source') continue;

    const voltagePct = calculated.nodeVoltages?.[node.id] ?? 100;
    const status = nodeVoltageStatus(voltagePct, limits);
    const loadsHere = network.loads.filter((l) => l.nodeId === node.id);
    const anyDisconnected = loadsHere.some((l) => !l.connected);
    const anyPriority = loadsHere.some((l) => l.priority);
    const ringStatusClass = anyDisconnected ? 'status-disconnected' : statusClass(status).trim();

    const group = el('g', { class: `grid-node-group${isSelected('node', node.id) ? ' is-selected' : ''}`, transform: `translate(${node.x},${node.y})` }, svg);
    attachSelectHandlers(group, 'node', node.id);

    const namesPart = loadsHere.length ? loadsHere.map((l) => `${l.name}${l.connected ? '' : ' (isključen)'}`).join(', ') : 'bez potrošača';
    const label = `Čvor ${node.id}, ${namesPart}. Napon ${voltagePct.toFixed(1)}% — ${statusWord(status)}.` +
      (anyPriority ? ' Prioritetni potrošač.' : '');
    group.setAttribute('aria-label', label);

    if (anyPriority) el('circle', { class: 'grid-node-priority-ring', r: 20, cx: 0, cy: 0 }, group);
    el('circle', { class: `grid-node-ring ${ringStatusClass}`.trim(), r: 15, cx: 0, cy: 0 }, group);

    if (anyDisconnected) {
      // Redundant non-colour "off" icon — a slash through the node, not just
      // a colour change. Hardcoded hex (matches --text-faint) rather than
      // var() inside a raw SVG presentation attribute, for maximum
      // cross-browser reliability on a purely decorative element.
      el('line', { x1: -8, y1: -8, x2: 8, y2: 8, stroke: '#506459', 'stroke-width': 2 }, group);
    }

    text(group, { class: 'grid-node-label', x: 0, y: 4, 'text-anchor': 'middle' }, node.id);
    const subline = loadsHere.length
      ? `${fmtPct(voltagePct)} · ${fmtKw(loadsHere.reduce((s, l) => s + (l.connected ? l.pW : 0), 0))}`
      : fmtPct(voltagePct);
    text(group, { class: `grid-node-sublabel${statusClass(status)}`, x: 0, y: 30, 'text-anchor': 'middle' }, subline);
    if (loadsHere.length) {
      const nameLine = (anyPriority ? '★ ' : '') + loadsHere.map((l) => l.name).join(', ');
      text(group, { class: 'grid-node-sublabel', x: 0, y: 44, 'text-anchor': 'middle' }, nameLine);
    }
  }

  // ---- Transformer (root) ----
  const tsNode = nodeById.get(network.transformer.id);
  if (tsNode) {
    const tLoadingPct = calculated.transformerLoadingPct ?? 0;
    const tStatus = transformerStatus(tLoadingPct, limits);
    const group = el('g', {
      class: `grid-transformer-group${isSelected('transformer', network.transformer.id) ? ' is-selected' : ''}`,
      transform: `translate(${tsNode.x},${tsNode.y})`
    }, svg);
    attachSelectHandlers(group, 'transformer', network.transformer.id);
    group.setAttribute('aria-label',
      `Trafostanica ${network.transformer.id}, ${network.transformer.ratedPowerKVA} kVA. Opterećenje ${fmtPct(tLoadingPct)} — ${statusWord(tStatus)}.`);

    el('circle', { class: `grid-transformer-body${statusClass(tStatus)}`, r: 24, cx: -8, cy: 0 }, group);
    el('circle', { class: `grid-transformer-body${statusClass(tStatus)}`, r: 24, cx: 8, cy: 0, fill: 'none' }, group);
    text(group, { class: 'grid-transformer-label', x: 0, y: -34, 'text-anchor': 'middle' }, 'TS');
    text(group, { class: 'grid-node-sublabel', x: 0, y: 46, 'text-anchor': 'middle' },
      `${network.transformer.ratedPowerKVA} kVA · ${fmtPct(tLoadingPct)}`);
  }

  return svg;
}

export function renderLegend(container) {
  container.replaceChildren();
  const items = [
    ['ok', 'Uredu'],
    ['warn', '⚠ Upozorenje'],
    ['critical', '⚠ Kritično']
  ];
  for (const [cls, labelText] of items) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const dot = document.createElement('span');
    dot.className = `legend-dot ${cls}`;
    const span = document.createElement('span');
    span.textContent = labelText;
    item.append(dot, span);
    container.appendChild(item);
  }
}
