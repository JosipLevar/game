// ui/inspector.js
import { effectiveCosPhi } from '../engine/load-flow.js';
import { edgeStatus, nodeVoltageStatus, transformerStatus } from './renderer-svg.js';

function clear(container) { container.replaceChildren(); }

function row(container, label, value, statusCls) {
  const r = document.createElement('div');
  r.className = 'inspect-row';
  const l = document.createElement('span');
  l.className = 'inspect-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = `inspect-value mono${statusCls ? ' ' + statusCls : ''}`;
  v.textContent = value;
  r.append(l, v);
  container.appendChild(r);
  return r;
}

function heading(container, text) {
  const h = document.createElement('h3');
  h.textContent = text;
  container.appendChild(h);
}

function statusPillClass(status) {
  return status === 'ok' ? 'ok' : status;
}

export function renderInspector(container, { selected, network, calculated, cablesById, limits }) {
  clear(container);

  if (!selected) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'Ništa nije odabrano. Kliknite na vod, čvor ili trafostanicu u shemi.';
    container.appendChild(p);
    return;
  }

  if (selected.type === 'transformer') {
    heading(container, `Trafostanica ${network.transformer.id}`);
    const pct = calculated.transformerLoadingPct ?? 0;
    const status = transformerStatus(pct, limits);
    row(container, 'Nazivna snaga', `${network.transformer.ratedPowerKVA} kVA`);
    row(container, 'Opterećenje', `${pct.toFixed(1)} %`, `status-${statusPillClass(status)}`);
    row(container, 'Prividna snaga', `${((calculated.transformerApparentPowerVA ?? 0) / 1000).toFixed(1)} kVA`);
    row(container, 'Pojačana ovom rundom', network.transformer.upgraded ? 'Da' : 'Ne');
    return;
  }

  if (selected.type === 'edge') {
    const edge = network.edges.find((e) => e.id === selected.id);
    if (!edge) return;
    const cable = cablesById[edge.cableTypeId];
    const loadingPct = calculated.edgeLoadingPct?.[edge.id] ?? 0;
    const status = edgeStatus(loadingPct, limits);

    heading(container, `Vod ${edge.id}`);
    row(container, 'Tip kabela', cable ? cable.name : 'nepoznat');
    row(container, 'Duljina', `${edge.lengthKm.toFixed(3)} km`);
    row(container, 'Struja', `${(calculated.edgeCurrents?.[edge.id] ?? 0).toFixed(1)} A`);
    row(container, 'Opterećenje', `${loadingPct.toFixed(1)} %`, `status-${statusPillClass(status)}`);
    row(container, 'Pad napona', `${(calculated.edgeDeltaUV?.[edge.id] ?? 0).toFixed(1)} V`);
    row(container, 'Gubici', `${(calculated.edgeLossesW?.[edge.id] ?? 0).toFixed(0)} W`);
    row(container, 'Zamjena kabela iskorištena', edge.interventions?.cableReplaced ? 'Da' : 'Ne');
    row(container, 'Skraćivanje dostupno', edge.allowShorten ? 'Da' : 'Ne');
    row(container, 'Skraćivanje iskorišteno', edge.interventions?.shortened ? 'Da' : 'Ne');
    return;
  }

  if (selected.type === 'node') {
    const node = network.nodes.find((n) => n.id === selected.id);
    if (!node) return;
    const voltagePct = calculated.nodeVoltages?.[node.id] ?? 100;
    const status = nodeVoltageStatus(voltagePct, limits);
    heading(container, `Čvor ${node.id}`);
    row(container, 'Napon', `${voltagePct.toFixed(1)} %`, `status-${statusPillClass(status)}`);
    row(container, 'Napon (V)', `${(calculated.nodeVoltagesV?.[node.id] ?? 0).toFixed(0)} V`);

    const loadsHere = network.loads.filter((l) => l.nodeId === node.id);
    if (loadsHere.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'Bez potrošača na ovom čvoru (spojni čvor).';
      container.appendChild(p);
    }
    for (const load of loadsHere) {
      const sub = document.createElement('div');
      sub.className = 'inspect-subsection';
      const h4 = document.createElement('h4');
      h4.textContent = `${load.priority ? '★ ' : ''}${load.name}${load.priority ? ' (prioritet)' : ''}`;
      sub.appendChild(h4);
      row(sub, 'Snaga (P)', `${(load.pW / 1000).toFixed(2)} kW`);
      row(sub, 'cosφ (bazni)', load.cosPhi.toFixed(2));
      row(sub, 'cosφ (efektivni)', effectiveCosPhi(load).toFixed(2));
      row(sub, 'Kompenzacija primijenjena', `${load.compensationSteps || 0}×`);
      row(sub, 'Status', load.connected ? 'Napajan' : 'Isključen', load.connected ? '' : 'status-critical');
      container.appendChild(sub);
    }
    return;
  }
}
