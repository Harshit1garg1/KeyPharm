const escape = value => String(value ?? '').replace(/[&<>"']/g, ch =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const nav = document.querySelector('#dashboard-nav');
for (const [target,label,icon] of [['inventory','Inventory','nav-inventory'],['manage','Session controls','nav-manage']]) {
  const link = document.createElement('a');
  link.href = '#' + target;
  const mark = document.createElement('span');
  mark.className = 'nav-icon ' + icon;
  mark.setAttribute('aria-hidden','true');
  link.append(mark,label);
  nav.insertBefore(link,nav.querySelector('[href="#activity"]'));
}
const panel = document.createElement('section');
panel.id = 'workspace-panel';
panel.className = 'panel workspace-panel';
panel.hidden = true;
document.querySelector('#catalog').after(panel);
let data, product = 'Juice', openClosed = '';
const selectedSessions = new Set();
let dispatchState = 'idle';
let loadVersion = 0;
let mutating = false;
const readApi = async (path, body) => {
  const response = await fetch(path,{cache:'no-store',...(body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? 'Request failed.');
  return result;
};
function stage(s) {
  if (s.dispatchedAt) return 'Dispatched';
  if (s.dispatchApproval) return 'Ready to dispatch';
  if (s.closedAt) return 'Closed';
  if (s.confirmedAt) return 'Awaiting approval';
  const run = s.runs.findLast(item => item.manifestRevision === s.manifest?.revision);
  if (run?.state === 'Interrupted') return 'Interrupted';
  if (['Hold','Incomplete'].includes(run?.result?.status)) return run.result.status;
  return s.verifiedAt ? 'Ready to scan' : s.manifest ? 'Physical check due' : 'Manifest needed';
}
const statusBadge = status => '<span class="dashboard-badge" data-state="' + escape(status.toLowerCase()) + '">' + escape(status) + '</span>';
const actionButton = (key,label) => '<button type="button" data-action="' + key + '">' + label + '</button>';
const canOpenClosed = s => s.closedAt && !s.dispatchedAt && (data.user.role === 'admin' || data.approvable.includes(s.id));
const approveButton = s => data.approvable.includes(s.id) ? actionButton('approve','Approve dispatch') : '';
const controls = (s, user) => {
  if (s.dispatchedAt) return '';
  if (s.closedAt) return canOpenClosed(s) ? '<button type="button" data-action="open-closed" aria-expanded="' +
    (openClosed === s.id) + '" aria-controls="closed-' + escape(s.id) + '">' +
    (openClosed === s.id ? 'Hide session actions' : 'Open closed session') + '</button>' : '';
  if (user.role === 'admin' && !s.confirmedAt && !s.acceptedAt) return actionButton('manifest',s.manifest ? 'Change CSV' : 'Load CSV');
  if (user.role === 'supervisor' && s.manifest && !s.verifiedAt) return actionButton('physical','Record physical check');
  return approveButton(s);
};
const csvPicker = id => '<label class="workspace-upload" data-csv-drop>' +
  '<input class="workspace-file-input" name="csv" type="file" accept=".csv,text/csv" aria-label="Choose a CSV" aria-describedby="' + id + '">' +
  '<span class="workspace-upload-icon" aria-hidden="true"></span><span class="workspace-upload-copy">' +
  '<span>Drop a CSV or <span class="workspace-upload-browse">browse</span></span>' +
  '<small id="' + id + '" data-csv-status role="status"></small></span></label>';

function showCsvSelection(input, error = '') {
  const zone = input.closest('[data-csv-drop]');
  const file = input.files[0];
  zone.querySelector('[data-csv-status]').textContent = error || file?.name || '';
  zone.toggleAttribute('data-error',Boolean(error));
  input.setAttribute('aria-invalid',String(Boolean(error)));
  if (file && !error) input.form.querySelector('[data-action="sample"]')?.setAttribute('aria-pressed','false');
}

function validateCsvSelection(input) {
  const file = input.files[0];
  if (file && (!/\.csv$/i.test(file.name) || !file.size)) {
    input.value = '';
    showCsvSelection(input,'Choose a non-empty CSV file.');
    return;
  }
  showCsvSelection(input);
}

function inventory() {
  const stock = data.inventory;
  const products = ['Juice','Tiger Balm','Biotona'];
  const rows = products.map(sku => {
    const set = stock.filter(c => c.sku === sku);
    const dispatched = set.filter(c => c.state === 'dispatched').length;
    const expanded = product === sku;
    return '<tr class="workspace-stock-row" data-product="' + escape(sku) + '"' + (expanded ? ' data-expanded' : '') +
      '><td class="workspace-stock-expand"><button class="workspace-row-arrow" type="button" aria-expanded="' + expanded +
      '" aria-controls="inventory-cartons" aria-label="' + (expanded ? 'Hide ' : 'View ') + escape(sku) +
      ' cartons"></button></td><th scope="row">' + escape(sku) + '</th><td>' + (set.length - dispatched) + '</td><td>' + dispatched +
      '</td></tr>';
  }).join('');
  return '<div class="workspace-inventory"><div class="workspace-table"><table><caption>Carton stock</caption><thead><tr>' +
    '<th scope="col" aria-label="Carton details" class="workspace-stock-expand"></th><th scope="col">Product</th>' +
    '<th scope="col">On hand</th><th scope="col">Dispatched</th></tr></thead><tbody>' + rows +
    '</tbody></table></div><section id="inventory-cartons" aria-labelledby="inventory-cartons-title"' +
    (product ? '>' + cartonDetails(product,stock.filter(c => c.sku === product)) : ' hidden>') + '</section></div>';
}
function cartonDetails(sku,cartons) {
  return '<h2 id="inventory-cartons-title">' + escape(sku) + ' cartons</h2><div class="workspace-table"><table>' +
    '<thead><tr><th scope="col">Carton</th><th scope="col">EPC</th><th scope="col">Tag source</th><th scope="col">Stock status</th></tr></thead><tbody>' +
    cartons.map(c => '<tr><th scope="row">' + escape(c.carton) + '</th><td><code>' + escape(c.epc) + '</code></td><td>' +
      (c.physical ? 'Physical test tag' : 'Synthetic') + '</td><td>' + statusBadge(c.state === 'dispatched' ? 'Dispatched' : 'On hand') +
      '</td></tr>').join('') + '</tbody></table></div>';
}
function outboundTable() {
  const canConfirmDispatch = ['admin','supervisor'].includes(data.user.role);
  const rows = data.sessions.map(s => {
    const closed = canOpenClosed(s);
    const expanded = closed && openClosed === s.id;
    const checkbox = canConfirmDispatch ? '<td class="dispatch-select"><input type="checkbox" data-select-session aria-label="Select ' +
      escape(s.testId) + ' for dispatch"' + (data.dispatchable.includes(s.id) ? '' : ' disabled') + '></td>' : '';
    return '<tr data-session="' + escape(s.id) + '">' + checkbox + '<th scope="row"><a href="#sessions/' + encodeURIComponent(s.id) + '">' +
      escape(s.testId) + '</a></th><td>' + escape(s.location) + '</td><td>' + escape(s.source) + '</td><td>' + statusBadge(stage(s)) +
      '</td><td><div class="row">' + controls(s,data.user) + '</div></td></tr>' + (closed ?
        '<tr class="workspace-carton-details" id="closed-' + escape(s.id) + '" data-session="' + escape(s.id) + '"' +
        (expanded ? '><td colspan="' + (canConfirmDispatch ? 6 : 5) + '"><div class="row">' + approveButton(s) +
          (data.user.role === 'admin' ? actionButton('reopen','Reopen session') + actionButton('manifest','Change CSV') : '') +
          '</div></td>' : ' hidden>') + '</tr>' : '');
  }).join('');
  return '<div class="row spread line"><h2>Outbound sessions</h2><div class="row">' +
    (canConfirmDispatch ? '<button type="button" class="primary-button dispatch-button" data-action="dispatch" disabled>' +
      '<span class="dispatch-indicator" aria-hidden="true"></span><span class="dispatch-label">Confirm dispatch</span></button>' : '') +
    (rows ? '<a href="api/evidence.csv" download>Export evidence CSV</a>' : '') + '</div></div>' +
    (rows ? '<div class="workspace-table"><table><thead><tr>' + (canConfirmDispatch ?
      '<th scope="col" class="dispatch-select"><input type="checkbox" data-select-all aria-label="Select all dispatchable sessions"></th>' : '') +
      '<th scope="col">Test ID</th><th scope="col">Location</th><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Actions</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="muted">No sessions yet.</p>');
}
function manage() {
  const setting = data.controls;
  const controlsForm = '<details id="workspace-lead-settings" class="dashboard-fold"' +
    (panel.querySelector('#workspace-lead-settings[open]') ? ' open' : '') + '><summary><span>Test lead settings</span></summary>' +
    '<div class="dashboard-fold-body"><form id="workspace-settings">' +
    '<div class="workspace-fields"><label>Test plan<textarea name="plan" rows="3" placeholder="Test ID and description">' +
    escape(setting.plan.map(item => [item.id,item.title].filter(Boolean).join(' ')).join('\n')) + '</textarea></label>' +
    '<label>Requested C72 power (dBm)<input type="number" min="5" max="30" step="1" name="power" value="' +
    escape(setting.power?.requested ?? '') + '"></label></div><p class="muted">' +
    escape(setting.power?.appliedAt ? 'C72 reported ' + setting.power.applied + ' dBm.' :
      setting.power ? 'Waiting for the Test lead to apply this setting on the C72.' :
      'Reader power is applied and checked on the C72.') + '</p>' +
    '<div class="row workspace-actions"><button class="primary-button">Save test settings</button></div></form>' +
    '<div class="line"><button type="button" data-action="reset">Reset demo data</button></div></div></details>';
  return (data.user.role === 'admin' ? '<form id="workspace-create"><h2>New session</h2><div class="workspace-fields">' +
    '<label>Test ID<input name="testId" maxlength="80" required></label><label>Location<input name="location" maxlength="100" value="Staging" required></label>' +
    '<label>Reader source<select name="source"><option>Simulation</option><option>C72 hardware</option></select></label></div>' +
    '<div class="workspace-create-actions"><div class="workspace-csv-choice">' + csvPicker('create-csv-status') +
    '<span class="workspace-csv-divider" aria-hidden="true">&#92;</span>' +
    '<button type="button" data-action="sample" aria-pressed="false">Use Sample CSV</button></div>' +
    '<button class="primary-button">Create session</button></div></form>' +
    controlsForm : '') + outboundTable();
}
let message = '';
const milestones = {
  physical:['Physical check recorded','The Operator can open the session and scan the pallet.'],
  approve:['Dispatch approved','The session can now be selected for dispatch.'],
  dispatch:['Dispatch recorded','The dispatched cartons were deducted from on-hand stock.'],
  reopen:['Session reopened','The session is ready for a new physical check.'],
  reset:['Demo data reset','Starting inventory restored.']
};
const confirmation = document.createElement('dialog');
confirmation.className = 'workflow-dialog';
confirmation.setAttribute('aria-labelledby','workspace-confirm-title');
confirmation.innerHTML = '<span class="workflow-tick" aria-hidden="true"></span><h2 id="workspace-confirm-title"></h2>' +
  '<p></p><form method="dialog"><button>Done</button></form>';
panel.after(confirmation);
const render = () => {
  if (!data) { panel.textContent = message || 'Loading workspace…'; return; }
  panel.innerHTML = '<p id="workspace-message" role="status">' + escape(message) + '</p>' +
    (location.hash === '#inventory' ? inventory() : manage()) +
    '<dialog id="workspace-dialog" aria-labelledby="workspace-dialog-title"><form method="dialog" id="workspace-dialog-form">' +
    '<h2 id="workspace-dialog-title"></h2><p></p><div class="workspace-dialog-fields"></div>' +
    '<div class="row workspace-actions"><button value="cancel" formnovalidate>Cancel</button>' +
    '<button class="primary-button" value="confirm">Confirm</button></div></form></dialog>';
  updateSelection();
};
function updateSelection() {
  const button = panel.querySelector('[data-action="dispatch"]');
  if (!button) return;
  const eligible = data.dispatchable;
  for (const id of selectedSessions) if (!eligible.includes(id)) selectedSessions.delete(id);
  for (const checkbox of panel.querySelectorAll('[data-select-session]')) {
    checkbox.checked = selectedSessions.has(checkbox.closest('[data-session]').dataset.session);
  }
  const all = panel.querySelector('[data-select-all]');
  if (all) {
    all.disabled = !eligible.length;
    all.checked = Boolean(eligible.length) && eligible.length === selectedSessions.size;
    all.indeterminate = selectedSessions.size > 0 && !all.checked;
  }
  button.disabled = selectedSessions.size === 0 || dispatchState !== 'idle';
  const label = dispatchState === 'pending' ? 'Dispatching…' : dispatchState === 'done' ? 'Dispatched' : 'Confirm dispatch';
  button.dataset.state = dispatchState;
  button.setAttribute('aria-busy',String(dispatchState === 'pending'));
  button.querySelector('.dispatch-label').textContent = label;
}
function canRefreshInBackground() {
  return !mutating && ['#inventory','#manage'].includes(location.hash) && !panel.contains(document.activeElement) &&
    !confirmation.open && !panel.querySelector('dialog[open]') && !panel.querySelector('input[type=file]')?.files.length &&
    !panel.querySelector('[data-csv-drop][data-dragging], [data-csv-drop][data-error]') &&
    ![...panel.querySelectorAll('input:not([type=file]),textarea')].some(input => input.value !== input.defaultValue) &&
    !panel.querySelector('[data-action="sample"][aria-pressed="true"]');
}
async function load(background = false) {
  const version = ++loadVersion;
  const canRender = () => version === loadVersion && (!background || canRefreshInBackground());
  try {
    const updated = await readApi('api/workspace');
    if (!canRender()) return;
    data = updated;
  } catch (error) {
    if (!canRender()) return;
    message = error.message;
  }
  render();
}
async function mutate(path, payload) {
  if (mutating) return;
  mutating = true;
  const dispatching = payload.action === 'dispatch';
  if (dispatching) {
    dispatchState = 'pending';
    updateSelection();
  }
  message = '';
  let result;
  try { result = await readApi(path,{...payload,generation:data.generation}); message = 'Saved.'; window.dispatchEvent(new Event('workspace-updated')); }
  catch (error) { message = error.message; }
  if (dispatching) {
    dispatchState = result ? 'done' : 'idle';
    updateSelection();
  }
  await load();
  if (dispatching && result && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await new Promise(resolve => setTimeout(resolve,420));
  }
  mutating = false;
  const milestone = result && milestones[payload.action];
  if (milestone) {
    confirmation.querySelector('h2').textContent = milestone[0];
    confirmation.querySelector('p').textContent = milestone[1];
    confirmation.showModal();
  }
  if (dispatching) {
    dispatchState = 'idle';
    updateSelection();
  }
}
panel.addEventListener('submit', async event => {
  if (event.target.id === 'workspace-settings') {
    event.preventDefault();
    const values = new FormData(event.target);
    const power = values.get('power');
    const change = {revision:data.controls.revision,operationId:crypto.randomUUID(),plan:values.get('plan')};
    if (power !== '' && Number(power) !== data.controls.power?.requested) change.power = Number(power);
    await mutate('api/settings',change);
    return;
  }
  if (event.target.id !== 'workspace-create') return;
  event.preventDefault();
  const form = new FormData(event.target);
  const file = form.get('csv');
  const sample = event.target.querySelector('[data-action="sample"]').getAttribute('aria-pressed') === 'true';
  if (!sample && !file?.size) {
    panel.querySelector('#workspace-message').textContent = 'Choose a CSV or use the sample.';
    return;
  }
  await mutate('api/session',{testId:form.get('testId'),location:form.get('location'),source:form.get('source'),
    csv:sample ? '' : await file.text(), sample});
});
panel.addEventListener('click', event => {
  const stockRow = event.target.closest('.workspace-stock-row');
  if (stockRow) {
    const sku = stockRow.dataset.product;
    const restoreFocus = stockRow.contains(document.activeElement);
    product = sku === product ? '' : sku;
    render();
    if (restoreFocus) panel.querySelector('[data-product="' + CSS.escape(sku) + '"] button')?.focus();
    return;
  }
  const button = event.target.closest('button');
  if (button?.dataset.action === 'sample') {
    const next = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed',String(next));
    if (next) {
      const input = button.form.elements.csv;
      input.value = '';
      showCsvSelection(input);
    }
    return;
  }
  const action = button?.dataset.action;
  const row = button?.closest('[data-session]');
  if (!action || (!row && !['reset','dispatch'].includes(action))) return;
  const record = row && data.sessions.find(s => s.id === row.dataset.session);
  if (action === 'open-closed') {
    openClosed = openClosed === record.id ? '' : record.id;
    render();
    panel.querySelector('[data-session="' + CSS.escape(record.id) + '"] [data-action="open-closed"]')?.focus();
    return;
  }
  const dispatch = action === 'dispatch' ? data.sessions.filter(s => selectedSessions.has(s.id)) : [];
  const dialog = panel.querySelector('dialog');
  dialog.returnValue = 'cancel';
  dialog.querySelector('h2').textContent = button.textContent;
  dialog.querySelector('p').textContent = action === 'physical' ? 'Confirm you checked the actual pallet and its label assignments.' :
    action === 'approve' ? 'Confirm dispatch approval for ' + record.testId + ' after reviewing the physical check and clean scan.' :
    action === 'dispatch' ? 'Confirm dispatch for the selected sessions. Their cartons will be deducted from on-hand stock.' :
    action === 'manifest' && record.closedAt ? 'Changing the CSV reopens the session and requires a new physical check.' :
    action === 'manifest' && record.manifest ? 'Changing the CSV requires a new physical check.' :
    action === 'reopen' ? 'Keep the current CSV and start a new verification. Previous scans stay in the session history.' :
    action === 'reset' ? 'Clear sessions, scans and test settings from the shared workspace and the C72. Restore starting stock.' :
    'Session ' + record.testId;
  const fields = dialog.querySelector('.workspace-dialog-fields');
  fields.innerHTML = action === 'manifest' ? csvPicker('replace-csv-status') :
    action === 'physical' ? '<label>Check notes<input name="note" maxlength="320"></label>' :
    action === 'dispatch' ? '<ul>' + dispatch.map(s => '<li>' + escape(s.testId) + '</li>').join('') + '</ul>' :
    action === 'reset' ? '<label>Type RESET<input name="confirm" pattern="RESET" autocomplete="off" required></label>' : '';
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'confirm') return;
    const form = new FormData(dialog.querySelector('form'));
    if (action === 'reset') {
      await mutate('api/reset',{action,confirm:form.get('confirm')});
      return;
    }
    if (action === 'dispatch') {
      await mutate('api/dispatch',{action,confirmed:true,sessions:dispatch.map(s => ({id:s.id,revision:s.workspaceRevision}))});
      return;
    }
    const file = form.get('csv');
    if (action === 'manifest' && !file?.size) {
      panel.querySelector('#workspace-message').textContent = 'Choose a CSV to load.';
      return;
    }
    await mutate('api/action',{action,id:record.id,revision:record.workspaceRevision,confirmed:true,
      note:form.get('note'),csv:file?.size ? await file.text() : undefined});
  },{once:true});
  dialog.showModal();
});
panel.addEventListener('change',event => {
  if (event.target.matches('.workspace-file-input')) validateCsvSelection(event.target);
  if (event.target.matches('[data-select-all]')) {
    selectedSessions.clear();
    if (event.target.checked) for (const id of data.dispatchable) selectedSessions.add(id);
    updateSelection();
  }
  if (event.target.matches('[data-select-session]')) {
    const id = event.target.closest('[data-session]').dataset.session;
    if (event.target.checked) selectedSessions.add(id);
    else selectedSessions.delete(id);
    updateSelection();
  }
});
panel.addEventListener('dragover',event => {
  const zone = event.target.closest('[data-csv-drop]');
  if (!zone || !event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  zone.setAttribute('data-dragging','');
});
panel.addEventListener('dragleave',event => {
  const zone = event.target.closest('[data-csv-drop]');
  if (zone && !zone.contains(event.relatedTarget)) zone.removeAttribute('data-dragging');
});
panel.addEventListener('drop',event => {
  const zone = event.target.closest('[data-csv-drop]');
  if (!zone) return;
  event.preventDefault();
  zone.removeAttribute('data-dragging');
  const input = zone.querySelector('input');
  const files = event.dataTransfer.files;
  if (files.length !== 1) {
    input.value = '';
    showCsvSelection(input,'Drop one CSV file at a time.');
    return;
  }
  input.files = files;
  validateCsvSelection(input);
});
window.addEventListener('hashchange',() => { if (['#inventory','#manage'].includes(location.hash)) void load(); });
document.querySelector('#refresh').addEventListener('click',() => { if (!panel.hidden) void load(); });
setInterval(() => {
  if (canRefreshInBackground()) void load(true);
},5000);
window.dispatchEvent(new Event('hashchange'));
void load();
