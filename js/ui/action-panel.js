// ui/action-panel.js
import { ACTION_TYPES, ACTION_LABELS } from '../constants.js';
import { simulateIntervention } from '../engine/interventions.js';
import { buildTopology, wouldCreateCycle } from '../engine/topology.js';
import { effectiveCosPhi } from '../engine/load-flow.js';

function clear(container) { container.replaceChildren(); }
function eur(cents) { return `${(cents / 100).toLocaleString('hr-HR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} €`; }

function makeButton(labelText, cls, onClick, disabled = false) {
  const b = document.createElement('button');
  b.textContent = labelText;
  if (cls) b.className = cls;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function makeSelect(options, onChange) {
  const sel = document.createElement('select');
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function engineCtx(gameState, cablesById, transformersById, limits) {
  return {
    cablesById, transformersById, limits,
    budgetRemainingCents: gameState.budgetRemainingCents,
    actionsRemaining: gameState.actionsRemaining
  };
}

/** Build the [before] -> [after] preview block exactly per the spec's example layout. */
function renderPreviewBlock(container, { title, lines, costCents, errors, onCancel, onConfirm }) {
  const box = document.createElement('div');
  box.className = 'action-preview';

  const h = document.createElement('h4');
  h.textContent = title;
  box.appendChild(h);

  if (errors && errors.length > 0) {
    const err = document.createElement('p');
    err.className = 'action-error';
    err.textContent = errors.join(' ');
    box.appendChild(err);
    box.appendChild(makeButton('Zatvori', 'ghost', onCancel));
    container.appendChild(box);
    return;
  }

  for (const line of lines) {
    const p = document.createElement('p');
    p.className = 'action-preview-line mono';
    p.textContent = line;
    box.appendChild(p);
  }
  const costP = document.createElement('p');
  costP.className = 'action-preview-line mono';
  costP.textContent = `Trošak: ${eur(costCents)}`;
  box.appendChild(costP);
  const movesP = document.createElement('p');
  movesP.className = 'action-preview-line mono';
  movesP.textContent = 'Potezi: 1';
  box.appendChild(movesP);

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  actions.appendChild(makeButton('Odustani', 'ghost', onCancel));
  const confirmBtn = makeButton('Potvrdi intervenciju', 'primary', () => {
    confirmBtn.disabled = true; // ghost-click guard — synchronous, before anything else happens
    onConfirm();
  });
  actions.appendChild(confirmBtn);
  box.appendChild(actions);

  container.appendChild(box);
}

export function renderActionPanel(container, ctx) {
  const { selected, previewAction, gameState, cablesById, transformersById, limits, onPreviewStart, onPreviewCancel, onCommit } = ctx;
  clear(container);

  const heading = document.createElement('h3');
  heading.textContent = 'Intervencije';
  container.appendChild(heading);

  if (!selected) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'Odaberite vod, čvor ili trafostanicu da vidite dostupne intervencije.';
    container.appendChild(p);
    return;
  }

  if (gameState.actionsRemaining <= 0) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'Nema više raspoloživih intervencija ovom rundom.';
    container.appendChild(p);
    return;
  }

  const network = gameState.network;
  const eCtx = engineCtx(gameState, cablesById, transformersById, limits);

  function renderPreview({ actionType, params }) {
    const result = simulateIntervention(network, actionType, params, eCtx);
    if (!result.valid) {
      renderPreviewBlock(container, {
        title: ACTION_LABELS[actionType],
        lines: [],
        errors: result.errors,
        onCancel: onPreviewCancel
      });
      return;
    }

    const before = gameState.calculated;
    const after = result.calculated;
    const lines = [];

    if (actionType === ACTION_TYPES.REPLACE_CABLE) {
      const oldCable = cablesById[network.edges.find((e) => e.id === params.edgeId).cableTypeId];
      const newCable = cablesById[params.newCableTypeId];
      lines.push(`${oldCable.name} → ${newCable.name}`);
      lines.push(`Opterećenje: ${(before.edgeLoadingPct[params.edgeId] ?? 0).toFixed(0)}% → ${(after.edgeLoadingPct[params.edgeId] ?? 0).toFixed(0)}%`);
      const toNode = network.edges.find((e) => e.id === params.edgeId).toNodeId;
      lines.push(`Napon čvora ${toNode}: ${(before.nodeVoltages[toNode] ?? 0).toFixed(1)}% → ${(after.nodeVoltages[toNode] ?? 0).toFixed(1)}%`);
    } else if (actionType === ACTION_TYPES.SHORTEN_LINE) {
      const toNode = network.edges.find((e) => e.id === params.edgeId).toNodeId;
      lines.push(`Opterećenje: ${(before.edgeLoadingPct[params.edgeId] ?? 0).toFixed(0)}% → ${(after.edgeLoadingPct[params.edgeId] ?? 0).toFixed(0)}%`);
      lines.push(`Napon čvora ${toNode}: ${(before.nodeVoltages[toNode] ?? 0).toFixed(1)}% → ${(after.nodeVoltages[toNode] ?? 0).toFixed(1)}%`);
    } else if (actionType === ACTION_TYPES.TRANSFER_LOAD) {
      lines.push(`Čvor ${params.nodeId} → novi nadređeni čvor ${params.targetParentNodeId}`);
      lines.push(`Napon čvora ${params.nodeId}: ${(before.nodeVoltages[params.nodeId] ?? 0).toFixed(1)}% → ${(after.nodeVoltages[params.nodeId] ?? 0).toFixed(1)}%`);
    } else if (actionType === ACTION_TYPES.DISCONNECT_LOAD) {
      const load = network.loads.find((l) => l.id === params.loadId);
      lines.push(`${load.name}: napajan → isključen`);
      lines.push(`TS opterećenje: ${(before.transformerLoadingPct ?? 0).toFixed(0)}% → ${(after.transformerLoadingPct ?? 0).toFixed(0)}%`);
    } else if (actionType === ACTION_TYPES.ADD_COMPENSATION) {
      const load = network.loads.find((l) => l.id === params.loadId);
      const afterLoad = result.network.loads.find((l) => l.id === params.loadId);
      const nodeEdge = buildTopology(network).edgeToParent.get(load.nodeId);
      lines.push(`cosφ: ${effectiveCosPhi(load).toFixed(2)} → ${effectiveCosPhi(afterLoad).toFixed(2)}`);
      if (nodeEdge) lines.push(`Opterećenje ${nodeEdge}: ${(before.edgeLoadingPct[nodeEdge] ?? 0).toFixed(0)}% → ${(after.edgeLoadingPct[nodeEdge] ?? 0).toFixed(0)}%`);
    } else if (actionType === ACTION_TYPES.UPGRADE_TRANSFORMER) {
      lines.push(`${network.transformer.ratedPowerKVA} kVA → ${transformersById[params.newTransformerId].ratedPowerKVA} kVA`);
      lines.push(`TS opterećenje: ${(before.transformerLoadingPct ?? 0).toFixed(0)}% → ${(after.transformerLoadingPct ?? 0).toFixed(0)}%`);
    }

    renderPreviewBlock(container, {
      title: ACTION_LABELS[actionType],
      lines,
      costCents: result.costCents,
      onCancel: onPreviewCancel,
      onConfirm: () => onCommit(actionType, params)
    });
  }

  // If a preview is active, show ONLY the preview block (per the spec's flow:
  // pick action -> see preview -> confirm/cancel).
  if (previewAction) {
    renderPreview(previewAction);
    return;
  }

  if (selected.type === 'edge') {
    const edge = network.edges.find((e) => e.id === selected.id);
    if (!edge) return;

    if (!edge.interventions?.cableReplaced) {
      const wrap = document.createElement('div');
      wrap.className = 'action-item';
      const label = document.createElement('div');
      label.className = 'action-item-label';
      label.textContent = ACTION_LABELS[ACTION_TYPES.REPLACE_CABLE];
      wrap.appendChild(label);
      const cableOptions = Object.values(cablesById)
        .filter((c) => c.id !== edge.cableTypeId)
        .sort((a, b) => a.tier - b.tier)
        .map((c) => ({ value: c.id, label: c.name }));
      let chosenCable = cableOptions[0]?.value;
      const sel = makeSelect(cableOptions, (v) => { chosenCable = v; });
      wrap.appendChild(sel);
      wrap.appendChild(makeButton('Simuliraj', null, () =>
        onPreviewStart(ACTION_TYPES.REPLACE_CABLE, { edgeId: edge.id, newCableTypeId: chosenCable })));
      container.appendChild(wrap);
    }

    if (edge.allowShorten && !edge.interventions?.shortened) {
      const wrap = document.createElement('div');
      wrap.className = 'action-item';
      wrap.appendChild(makeButton(ACTION_LABELS[ACTION_TYPES.SHORTEN_LINE], null, () =>
        onPreviewStart(ACTION_TYPES.SHORTEN_LINE, { edgeId: edge.id })));
      container.appendChild(wrap);
    }

    if (edge.interventions?.cableReplaced && (!edge.allowShorten || edge.interventions?.shortened)) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'Sve raspoložive intervencije za ovaj vod su iskorištene.';
      container.appendChild(p);
    }
  }

  if (selected.type === 'node') {
    const node = network.nodes.find((n) => n.id === selected.id);
    if (!node) return;

    const topo = buildTopology(network);
    if (topo.valid && topo.parentOf.has(node.id)) {
      const candidateTargets = network.nodes.filter((n) =>
        n.id !== node.id &&
        n.id !== topo.parentOf.get(node.id) &&
        !wouldCreateCycle(node.id, n.id, topo)
      );
      if (candidateTargets.length > 0) {
        const wrap = document.createElement('div');
        wrap.className = 'action-item';
        const label = document.createElement('div');
        label.className = 'action-item-label';
        label.textContent = ACTION_LABELS[ACTION_TYPES.TRANSFER_LOAD];
        wrap.appendChild(label);
        let chosenTarget = candidateTargets[0].id;
        const sel = makeSelect(candidateTargets.map((n) => ({ value: n.id, label: n.id })), (v) => { chosenTarget = v; });
        wrap.appendChild(sel);
        wrap.appendChild(makeButton('Simuliraj', null, () =>
          onPreviewStart(ACTION_TYPES.TRANSFER_LOAD, { nodeId: node.id, targetParentNodeId: chosenTarget })));
        container.appendChild(wrap);
      }
    }

    const loadsHere = network.loads.filter((l) => l.nodeId === node.id);
    for (const load of loadsHere) {
      if (!load.priority && load.connected) {
        const wrap = document.createElement('div');
        wrap.className = 'action-item';
        wrap.appendChild(makeButton(`${ACTION_LABELS[ACTION_TYPES.DISCONNECT_LOAD]} — ${load.name}`, null, () =>
          onPreviewStart(ACTION_TYPES.DISCONNECT_LOAD, { loadId: load.id })));
        container.appendChild(wrap);
      }
      if (load.connected && effectiveCosPhi(load) < 0.98 - 1e-9) {
        const wrap = document.createElement('div');
        wrap.className = 'action-item';
        wrap.appendChild(makeButton(`${ACTION_LABELS[ACTION_TYPES.ADD_COMPENSATION]} — ${load.name}`, null, () =>
          onPreviewStart(ACTION_TYPES.ADD_COMPENSATION, { loadId: load.id })));
        container.appendChild(wrap);
      }
    }

    if (container.querySelectorAll('.action-item').length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'Nema dostupnih intervencija za ovaj čvor.';
      container.appendChild(p);
    }
  }

  if (selected.type === 'transformer') {
    if (!network.transformer.upgraded) {
      const options = Object.values(transformersById)
        .filter((t) => t.ratedPowerKVA > network.transformer.ratedPowerKVA)
        .sort((a, b) => a.ratedPowerKVA - b.ratedPowerKVA)
        .map((t) => ({ value: t.id, label: `${t.ratedPowerKVA} kVA` }));
      if (options.length > 0) {
        const wrap = document.createElement('div');
        wrap.className = 'action-item';
        const label = document.createElement('div');
        label.className = 'action-item-label';
        label.textContent = ACTION_LABELS[ACTION_TYPES.UPGRADE_TRANSFORMER];
        wrap.appendChild(label);
        let chosen = options[0].value;
        const sel = makeSelect(options, (v) => { chosen = v; });
        wrap.appendChild(sel);
        wrap.appendChild(makeButton('Simuliraj', null, () =>
          onPreviewStart(ACTION_TYPES.UPGRADE_TRANSFORMER, { newTransformerId: chosen })));
        container.appendChild(wrap);
      }
    } else {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'Trafostanica je već pojačana ovom rundom.';
      container.appendChild(p);
    }
  }
}
