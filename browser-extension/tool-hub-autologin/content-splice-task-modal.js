// content-splice-task-modal.js — Task Selection Modal.
//
// Renders inside a Shadow DOM root for CSS isolation from Splice's own page
// styles - mirrors content-epidemicsound-task-modal.js exactly (see its own
// header comment, itself citing content-envato-task-modal.js and
// content-freepik-task-modal.js, for the full reasoning behind the Shadow
// DOM choice and the "Client required, Task optional" validation rule).
//
// Exposes exactly one function, openSpliceTaskSelectionModal(), returning a
// Promise that resolves to { taskId, taskName, clientId, clientName }
// (either pair may be null) on Continue, or null on Cancel/ESC/nothing
// available. content-splice-capture.js's click interceptor is the only
// caller.
//
// Own host id (rmw-splice-task-gate-host) and function/const names
// namespaced with "Splice" - this file shares its isolated-world global
// scope with content-splice.js (the login-automation script, its own
// separate manifest.json entry but matching the same host), which may
// declare generic top-level names of its own. See
// content-epidemicsound-capture.js's header comment for the fuller version
// of this reasoning.

const SPLICE_TASK_MODAL_HOST_ID = 'rmw-splice-task-gate-host';
const SPLICE_PICKER_SEARCH_THRESHOLD = 10;

let spliceTaskModalOpenPromise = null;

function openSpliceTaskSelectionModal() {
  if (spliceTaskModalOpenPromise) return spliceTaskModalOpenPromise;

  spliceTaskModalOpenPromise = new Promise((resolve) => {
    mountSpliceTaskModal(resolve);
  }).finally(() => {
    spliceTaskModalOpenPromise = null;
  });

  return spliceTaskModalOpenPromise;
}

function spliceTaskModalStyles() {
  return `
    :host { all: initial; }
    .rmw-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(8, 10, 16, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .rmw-dialog {
      width: min(460px, calc(100vw - 32px));
      max-height: min(640px, calc(100vh - 64px));
      display: flex;
      flex-direction: column;
      background: #14161f;
      color: #f1f3f9;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    .rmw-header {
      padding: 18px 20px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .rmw-title {
      font-size: 16px;
      font-weight: 600;
      margin: 0 0 4px;
    }
    .rmw-subtitle {
      font-size: 12.5px;
      color: #9aa0b4;
      margin: 0;
    }
    .rmw-body {
      flex: 1;
      overflow-y: auto;
      padding: 4px 20px 12px;
    }
    .rmw-section { margin-top: 14px; }
    .rmw-section-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #9aa0b4;
      margin: 0 0 8px;
    }
    .rmw-search {
      width: 100%;
      box-sizing: border-box;
      margin-bottom: 8px;
      padding: 8px 11px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: #1b1e29;
      color: #f1f3f9;
      font-size: 13px;
      outline: none;
    }
    .rmw-search:focus { border-color: #6d8bff; }
    .rmw-list { max-height: 176px; overflow-y: auto; }
    .rmw-option {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 9px 11px;
      border-radius: 10px;
      cursor: pointer;
      margin-bottom: 5px;
      border: 1px solid transparent;
    }
    .rmw-option:hover { background: rgba(255, 255, 255, 0.05); }
    .rmw-option.rmw-selected {
      background: rgba(109, 139, 255, 0.12);
      border-color: rgba(109, 139, 255, 0.5);
    }
    .rmw-option input { margin-top: 3px; accent-color: #6d8bff; }
    .rmw-option-body { flex: 1; min-width: 0; }
    .rmw-option-title {
      font-size: 13.5px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rmw-option-meta {
      font-size: 11.5px;
      color: #9aa0b4;
      margin-top: 2px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .rmw-badge {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
    }
    .rmw-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px 12px;
      text-align: center;
      color: #c7cbdc;
      font-size: 13px;
    }
    .rmw-spinner {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 2.5px solid rgba(255, 255, 255, 0.18);
      border-top-color: #6d8bff;
      animation: rmw-spin 0.8s linear infinite;
    }
    @keyframes rmw-spin { to { transform: rotate(360deg); } }
    .rmw-validation {
      margin: 0 20px;
      padding: 8px 12px;
      border-radius: 8px;
      background: rgba(255, 99, 99, 0.12);
      border: 1px solid rgba(255, 99, 99, 0.35);
      color: #ffb3b3;
      font-size: 12.5px;
      display: none;
    }
    .rmw-validation.rmw-visible { display: block; }
    .rmw-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 14px 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }
    button.rmw-btn {
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      padding: 9px 16px;
      border-radius: 10px;
      border: 1px solid transparent;
      cursor: pointer;
    }
    .rmw-btn-cancel {
      background: transparent;
      border-color: rgba(255, 255, 255, 0.16);
      color: #e4e6f1;
    }
    .rmw-btn-cancel:hover { background: rgba(255, 255, 255, 0.06); }
    .rmw-btn-continue {
      background: #6d8bff;
      color: #0b0d14;
    }
    .rmw-btn-continue:hover { background: #85a0ff; }
    .rmw-btn-continue:disabled {
      background: rgba(109, 139, 255, 0.25);
      color: rgba(255, 255, 255, 0.4);
      cursor: not-allowed;
    }
  `;
}

function spliceStatusLabel(status) {
  const map = {
    pending: 'Pending', forwarded: 'Forwarded', assigned: 'Assigned',
    in_progress: 'In Progress', need_improvement: 'Needs Improvement',
  };
  return map[status] || (status ? status.replace(/_/g, ' ') : 'Unknown');
}

function escapeSpliceTaskHtml(value) {
  return `${value}`.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// One independent picker section (Task or Client) - identical shape for
// both, parameterized so the loading/error/empty/search/select logic isn't
// duplicated between them. Mirrors content-epidemicsound-task-modal.js's
// createEpidemicPickerSection exactly.
function createSplicePickerSection(container, { key, title, radioGroupName, fetchItems, metaFor, onSelectionChange }) {
  const section = document.createElement('div');
  section.className = 'rmw-section';
  section.innerHTML = `
    <p class="rmw-section-title">${escapeSpliceTaskHtml(title)}</p>
    <input class="rmw-search" type="text" placeholder="Search…" style="display:none" aria-label="Search ${escapeSpliceTaskHtml(title)}" />
    <div class="rmw-list"><div class="rmw-state"><div class="rmw-spinner"></div><span>Loading…</span></div></div>
  `;
  container.appendChild(section);

  const searchEl = section.querySelector('.rmw-search');
  const listEl = section.querySelector('.rmw-list');
  const state = { items: [], selected: null, closed: false };

  function setSelected(item) {
    state.selected = item;
    onSelectionChange();
    listEl.querySelectorAll('.rmw-option').forEach((node) => {
      node.classList.toggle('rmw-selected', node.dataset.itemId === String(item?.id));
    });
  }

  function renderOptions(filterText) {
    const q = (filterText || '').trim().toLowerCase();
    const visible = q
      ? state.items.filter((item) => `${item.name || item.title || ''}`.toLowerCase().includes(q))
      : state.items;

    listEl.innerHTML = '';
    if (!visible.length) {
      listEl.innerHTML = '<div class="rmw-state">No matches.</div>';
      return;
    }

    visible.forEach((item) => {
      const option = document.createElement('label');
      option.className = 'rmw-option';
      option.dataset.itemId = String(item.id);

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = radioGroupName;
      radio.value = String(item.id);
      radio.checked = state.selected?.id === item.id;
      radio.addEventListener('change', () => setSelected(item));

      const body = document.createElement('div');
      body.className = 'rmw-option-body';
      const titleEl = document.createElement('div');
      titleEl.className = 'rmw-option-title';
      titleEl.textContent = item.title || item.name || `#${item.id}`;
      const meta = document.createElement('div');
      meta.className = 'rmw-option-meta';
      const parts = metaFor(item);
      meta.innerHTML = parts.map((part) => `<span class="rmw-badge">${escapeSpliceTaskHtml(part)}</span>`).join('');

      body.appendChild(titleEl);
      if (parts.length) body.appendChild(meta);
      option.appendChild(radio);
      option.appendChild(body);
      option.addEventListener('click', (event) => {
        if (event.target !== radio) {
          radio.checked = true;
          setSelected(item);
        }
      });
      listEl.appendChild(option);
    });
  }

  function renderError(message) {
    listEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'rmw-state';
    const text = document.createElement('span');
    text.textContent = message || `Unable to load ${title.toLowerCase()}.`;
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'rmw-btn rmw-btn-cancel';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', load);
    wrap.appendChild(text);
    wrap.appendChild(retryBtn);
    listEl.appendChild(wrap);
  }

  function renderEmpty(message) {
    listEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'rmw-state';
    wrap.textContent = message;
    listEl.appendChild(wrap);
  }

  async function load() {
    listEl.innerHTML = '<div class="rmw-state"><div class="rmw-spinner"></div><span>Loading…</span></div>';
    const result = await fetchItems();
    if (state.closed) return;

    if (!result?.ok) {
      renderError(result?.error);
      return;
    }

    state.items = Array.isArray(result.items) ? result.items : [];
    if (!state.items.length) {
      renderEmpty(result.emptyMessage || 'None available.');
      return;
    }

    searchEl.style.display = state.items.length > SPLICE_PICKER_SEARCH_THRESHOLD ? 'block' : 'none';
    renderOptions(searchEl.value);
  }

  searchEl.addEventListener('input', () => renderOptions(searchEl.value));

  return {
    key,
    load,
    getFirstFocusable: () => (searchEl.style.display === 'block' ? searchEl : listEl.querySelector('.rmw-option input')),
    getSelected: () => state.selected,
    destroy: () => { state.closed = true; },
  };
}

function mountSpliceTaskModal(resolve) {
  document.getElementById(SPLICE_TASK_MODAL_HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = SPLICE_TASK_MODAL_HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = spliceTaskModalStyles();
  shadow.appendChild(style);

  const overlay = document.createElement('div');
  overlay.className = 'rmw-overlay';
  overlay.setAttribute('role', 'presentation');

  const dialog = document.createElement('div');
  dialog.className = 'rmw-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'rmw-task-modal-title');
  overlay.appendChild(dialog);

  dialog.innerHTML = `
    <div class="rmw-header">
      <p class="rmw-title" id="rmw-task-modal-title">Select Task</p>
      <p class="rmw-subtitle">Every download must be linked to a client. Selecting a task is optional.</p>
    </div>
    <div class="rmw-body"></div>
    <div class="rmw-validation" role="alert"></div>
    <div class="rmw-footer">
      <button type="button" class="rmw-btn rmw-btn-cancel">Cancel</button>
      <button type="button" class="rmw-btn rmw-btn-continue" disabled>Continue</button>
    </div>
  `;

  shadow.appendChild(overlay);
  (document.body || document.documentElement).appendChild(host);

  const bodyEl = shadow.querySelector('.rmw-body');
  const validationEl = shadow.querySelector('.rmw-validation');
  const cancelBtn = shadow.querySelector('.rmw-btn-cancel');
  const continueBtn = shadow.querySelector('.rmw-btn-continue');

  let closed = false;

  function close(outcome) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    taskSection.destroy();
    clientSection.destroy();
    host.remove();
    resolve(outcome);
  }

  function showValidation(message) {
    validationEl.textContent = message;
    validationEl.classList.toggle('rmw-visible', Boolean(message));
  }

  function updateContinueState() {
    const enabled = Boolean(clientSection.getSelected());
    continueBtn.disabled = !enabled;
    if (enabled) showValidation('');
  }

  function confirmAndClose() {
    const task = taskSection.getSelected();
    const client = clientSection.getSelected();
    if (!client) {
      showValidation('Please select a client before downloading.');
      return;
    }
    close({
      taskId: task?.id ?? null,
      taskName: task?.title ?? null,
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
    });
  }

  const taskSection = createSplicePickerSection(bodyEl, {
    key: 'task',
    title: 'Select Task',
    radioGroupName: 'rmw-splice-task-choice',
    onSelectionChange: updateContinueState,
    metaFor: (task) => {
      const parts = [spliceStatusLabel(task.status)];
      if (task.priority) parts.push(task.priority.charAt(0).toUpperCase() + task.priority.slice(1));
      if (task.department) parts.push(task.department);
      return parts;
    },
    fetchItems: async () => {
      const result = await fetchMyActiveSpliceTasks();
      if (!result?.ok) return { ok: false, error: result?.error || 'Unable to load your tasks.' };
      return {
        ok: true,
        items: result.tasks,
        emptyMessage: 'No active tasks found. Please contact your manager or create a task before downloading.',
      };
    },
  });

  const clientSection = createSplicePickerSection(bodyEl, {
    key: 'client',
    title: 'Select Client',
    radioGroupName: 'rmw-splice-client-choice',
    onSelectionChange: updateContinueState,
    metaFor: () => [],
    fetchItems: async () => {
      const result = await fetchActiveSpliceClients();
      if (!result?.ok) return { ok: false, error: result?.error || 'Unable to load clients.' };
      return {
        ok: true,
        items: result.clients,
        emptyMessage: 'No clients have been added yet.',
      };
    },
  });

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(null);
      return;
    }
    if (event.key === 'Enter' && !continueBtn.disabled) {
      event.preventDefault();
      confirmAndClose();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = Array.from(shadow.querySelectorAll('input, button'))
        .filter((node) => !node.disabled && node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = shadow.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  cancelBtn.addEventListener('click', () => close(null));
  continueBtn.addEventListener('click', confirmAndClose);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close(null);
  });

  document.addEventListener('keydown', onKeyDown, true);
  Promise.all([taskSection.load(), clientSection.load()]).then(() => {
    if (closed) return;
    (taskSection.getFirstFocusable() || clientSection.getFirstFocusable())?.focus();
  });
}
