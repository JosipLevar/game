// ui/notifications.js

function getRoot() {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    root.setAttribute('aria-live', 'polite');
    document.body.appendChild(root);
  }
  return root;
}

/**
 * @param {Array<{text:string, kind?: 'plus'|'minus'|'neutral'}>} lines
 * @param {{isError?: boolean, timeoutMs?: number}} opts
 */
export function showToast(lines, { isError = false, timeoutMs = 5500 } = {}) {
  const root = getRoot();
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' toast-error' : ''}`;

  for (const line of lines) {
    const p = document.createElement('div');
    p.className = `toast-line${line.kind ? ' ' + line.kind : ''}`;
    p.textContent = line.text;
    toast.appendChild(p);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ghost';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Zatvori obavijest');
  closeBtn.style.marginTop = '4px';
  closeBtn.addEventListener('click', () => remove());
  toast.appendChild(closeBtn);

  root.appendChild(toast);
  const timer = setTimeout(remove, timeoutMs);

  function remove() {
    clearTimeout(timer);
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }
  return remove;
}

export function showErrorToast(message) {
  showToast([{ text: message, kind: 'minus' }], { isError: true, timeoutMs: 7000 });
}
