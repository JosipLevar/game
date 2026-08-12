// ui/dialogs.js
// Simple, dependency-free modal system. All text goes through textContent.

function getRoot() {
  let root = document.getElementById('dialogs-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'dialogs-root';
    document.body.appendChild(root);
  }
  return root;
}

function buildOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  const box = document.createElement('div');
  box.className = 'dialog-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  overlay.appendChild(box);
  return { overlay, box };
}

/**
 * Generic dialog. `buttons` is an array of {label, cls, onClick, autofocus}.
 * Returns a close() function.
 */
export function showDialog({ title, bodyText, bodyNode, buttons = [], dismissible = true }) {
  const root = getRoot();
  const { overlay, box } = buildOverlay();

  const h2 = document.createElement('h2');
  h2.textContent = title;
  box.appendChild(h2);

  if (bodyText) {
    const p = document.createElement('div');
    p.className = 'dialog-body';
    p.textContent = bodyText;
    box.appendChild(p);
  }
  if (bodyNode) {
    const wrap = document.createElement('div');
    wrap.className = 'dialog-body';
    wrap.appendChild(bodyNode);
    box.appendChild(wrap);
  }

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  let firstFocusTarget = null;
  for (const btnDef of buttons) {
    const btn = document.createElement('button');
    btn.textContent = btnDef.label;
    if (btnDef.cls) btn.className = btnDef.cls;
    btn.addEventListener('click', () => {
      if (btnDef.onClick) btnDef.onClick();
      close();
    });
    actions.appendChild(btn);
    if (btnDef.autofocus) firstFocusTarget = btn;
  }
  box.appendChild(actions);

  function close() {
    overlay.removeEventListener('keydown', onKeydown);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  function onKeydown(evt) {
    if (evt.key === 'Escape' && dismissible) close();
  }
  overlay.addEventListener('keydown', onKeydown);
  if (dismissible) {
    overlay.addEventListener('click', (evt) => { if (evt.target === overlay) close(); });
  }

  root.appendChild(overlay);
  (firstFocusTarget || box).focus?.();
  box.setAttribute('tabindex', '-1');
  box.focus();

  return close;
}

export function confirmDialog({ title, body, confirmLabel = 'Potvrdi', cancelLabel = 'Odustani', danger = false }) {
  return new Promise((resolve) => {
    showDialog({
      title,
      bodyText: body,
      dismissible: true,
      buttons: [
        { label: cancelLabel, cls: 'ghost', onClick: () => resolve(false) },
        { label: confirmLabel, cls: danger ? 'danger' : 'primary', onClick: () => resolve(true), autofocus: true }
      ]
    });
  });
}

export function messageDialog({ title, body }) {
  return new Promise((resolve) => {
    showDialog({
      title,
      bodyText: body,
      buttons: [{ label: 'U redu', cls: 'primary', onClick: () => resolve(), autofocus: true }]
    });
  });
}

function fmtEur(cents) { return `${(cents / 100).toLocaleString('hr-HR')} €`; }
function fmtDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function showRoundEndDialog({ won, score, seed, elapsedSeconds, budgetSpentCents, actionsUsed, reasons, onPlayAgain, onGoHome }) {
  const body = document.createElement('div');

  const status = document.createElement('p');
  status.className = won ? 'mono' : 'mono';
  status.style.color = won ? 'var(--status-ok)' : 'var(--status-critical)';
  status.style.fontSize = 'var(--fs-lg)';
  status.style.fontWeight = '700';
  status.textContent = won ? '✓ RUNDA USPJEŠNA' : '✕ RUNDA NEUSPJEŠNA';
  body.appendChild(status);

  const rows = [
    ['Rezultat (score)', String(score)],
    ['Seed', String(seed)],
    ['Trajanje', fmtDuration(elapsedSeconds)],
    ['Potrošeno', fmtEur(budgetSpentCents)],
    ['Iskorišteno intervencija', String(actionsUsed)]
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'inspect-row';
    const l = document.createElement('span');
    l.className = 'inspect-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'inspect-value mono';
    v.textContent = value;
    row.append(l, v);
    body.appendChild(row);
  }

  if (!won && reasons && reasons.length > 0) {
    const reasonsTitle = document.createElement('p');
    reasonsTitle.className = 'dialog-body';
    reasonsTitle.style.marginTop = 'var(--space-2)';
    reasonsTitle.textContent = 'Razlog:';
    body.appendChild(reasonsTitle);
    const ul = document.createElement('ul');
    for (const r of reasons) {
      const li = document.createElement('li');
      li.textContent = r;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }

  showDialog({
    title: won ? 'Čestitamo!' : 'Runda završena',
    bodyNode: body,
    dismissible: false,
    buttons: [
      { label: 'Na početni zaslon', cls: 'ghost', onClick: onGoHome },
      { label: 'Igraj ponovno', cls: 'primary', onClick: onPlayAgain, autofocus: true }
    ]
  });
}
