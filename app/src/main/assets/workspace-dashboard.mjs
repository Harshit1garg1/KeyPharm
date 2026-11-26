import {escapeHtml as escape} from './model.mjs';
import {movementControls,receiptCartonDetails,reportsCard,stockPage} from './stock-dashboard.mjs';

const nav = document.querySelector('#dashboard-nav');
const workspaceSections = [
  ['inventory','Inventory','nav-inventory','inventory,inbound,counts'],
  ['manage','Outbound','nav-manage','manage,manifests'],
  ['devices','Devices & Setup','nav-pallets','devices']
];
const allWorkspaceKeys = new Set(['inventory','inbound','counts','manage','manifests','devices']);
const section = () => location.hash.slice(1);
const isWorkspace = () => allWorkspaceKeys.has(section());
const roleNames = {admin:'Administrator',operator:'Operator',supervisor:'Supervisor',reviewer:'Reviewer'};
const roleKey = 'keypharm-dashboard-role';
let role = sessionStorage.getItem(roleKey);
if (!Object.hasOwn(roleNames,role)) role = 'operator';
const rolePicker = document.createElement('select');
rolePicker.id = 'dashboard-role';
rolePicker.setAttribute('aria-label','Role');
for (const [value,label] of Object.entries(roleNames)) rolePicker.add(new Option(label,value));
rolePicker.value = role;
const devicePill = document.createElement('a');
devicePill.id = 'workspace-device-pill';
devicePill.href = '#devices';
devicePill.className = 'status device-status';
devicePill.hidden = true;
document.querySelector('.dashboard-toolbar-actions').prepend(devicePill,rolePicker);
for (const [target,label,icon,aliases] of workspaceSections) {
  const link = document.createElement('a');
  link.href = '#' + target;
  link.dataset.workspaceTitle = label;
  link.dataset.workspaceAliases = aliases;
  const mark = document.createElement('span');
  mark.className = 'nav-icon ' + icon;
  mark.setAttribute('aria-hidden','true');
  link.append(mark,label);
  const anchor = target === 'devices' ? '[href="#activity"]' : '[href="#sessions"]';
  nav.insertBefore(link,nav.querySelector(anchor));
}
const panel = document.createElement('section');
panel.id = 'workspace-panel';
panel.className = 'panel workspace-panel';
panel.hidden = true;
document.querySelector('#catalog').after(panel);
const overviewReports = document.querySelector('#overview-reports');
let data, stockData, product = 'Physalis';
let stockSelection = '', inventoryLocation = '', outboundPanel = '', history, historyRequest = 0;
let receiptPreview, receiptCsv;
const selectedSessions = new Set();
let dispatchState = 'idle';
let loadVersion = 0;
let mutating = false;
const readApi = async (path, body) => {
  const headers = {'X-KeyPharm-Role':role};
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path,{cache:'no-store',headers,...(body ? {method:'POST',body:JSON.stringify(body)} : {})});
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
const controls = (s, user) => {
  const power = user.role === 'admin' && s.source === 'C72 hardware' ? actionButton('power','Change recommended power') : '';
  const remove = user.role === 'admin' ? actionButton('remove','Remove session') : '';
  if (s.dispatchedAt) return power + remove;
  const approval = user.role === 'admin' && data.approvable.includes(s.id) ? actionButton('approve','Approve dispatch') : '';
  if (s.closedAt) return user.role === 'admin' ?
    actionButton('reopen','Reopen session') + actionButton('manifest','Change CSV') + approval + power + remove : '';
  return approval + power + remove + (user.role === 'admin' && !s.confirmedAt && !s.acceptedAt ? actionButton('manifest',s.manifest ? 'Change CSV' : 'Load CSV') : '') +
    (['admin','supervisor'].includes(user.role) && s.manifest && !s.verifiedAt ? actionButton('physical','Record physical check') : '');
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

function inventoryTabs(current) {
  const tasks = stockData?.tasks.filter(item => item.status !== 'Cancelled') ?? [];
  const counts = {
    inventory:data.inventory.length,
    inbound:tasks.filter(item => item.type === 'receipt').length,
    counts:tasks.filter(item => item.type === 'count').length
  };
  return '<nav class="workspace-subtabs" aria-label="Inventory views">' +
    [['inventory','Stock'],['inbound','Inbound'],['counts','Stock counts']].map(([key,label]) =>
      '<a href="#' + key + '"' + (current === key ? ' aria-current="page"' : '') + '>' + label +
      ' <span class="tab-count">' + counts[key] + '</span></a>').join('') +
    '</nav>';
}

function inventory() {
  const stock = inventoryLocation ? data.inventory.filter(c => c.location === inventoryLocation) : data.inventory;
  const products = ['Physalis','Tiger Balm','Biotona'];
  let totalOnHand = 0, totalDispatched = 0;
  const rows = products.map(sku => {
    const set = stock.filter(c => c.sku === sku);
    const dispatched = set.filter(c => c.state === 'dispatched').length;
    const onHand = set.length - dispatched;
    totalOnHand += onHand;
    totalDispatched += dispatched;
    const expanded = product === sku;
    return '<tr class="workspace-stock-row" data-product="' + escape(sku) + '"' + (expanded ? ' data-expanded' : '') +
      '><td class="workspace-stock-expand"><button class="workspace-row-arrow" type="button" aria-expanded="' + expanded +
      '" aria-controls="inventory-cartons" aria-label="' + (expanded ? 'Hide ' : 'View ') + escape(sku) +
      ' cartons"></button></td><th scope="row">' + escape(sku) + '</th><td>' + onHand + '</td><td>' + dispatched +
      '</td></tr>';
  }).join('');
  return '<label class="stock-filter">Location<select id="inventory-location"><option value="">All locations</option>' +
    (stockData?.locations ?? []).map(location => '<option' + (location === inventoryLocation ? ' selected' : '') + '>' + escape(location) + '</option>').join('') +
    '</select></label><div class="workspace-inventory"><div class="workspace-table"><table><caption>Carton stock (' + stock.length + ')</caption><thead><tr>' +
    '<th scope="col" aria-label="Carton details" class="workspace-stock-expand"></th><th scope="col">Product</th>' +
    '<th scope="col">On hand</th><th scope="col">Dispatched</th></tr></thead><tbody>' + rows +
    '</tbody><tfoot><tr class="workspace-stock-total"><td></td><th scope="row">Total</th><td>' + totalOnHand + '</td><td>' + totalDispatched + '</td></tr></tfoot></table></div><section id="inventory-cartons" aria-labelledby="inventory-cartons-title"' +
    (product ? '>' + cartonDetails(product,stock.filter(c => c.sku === product)) : ' hidden>') + '</section></div>';
}
function cartonDetails(sku,cartons) {
  const active = history && cartons.find(c => c.epc === history.epc);
  const events = active ? '<div class="dashboard-fold-body"><h3>' + escape(active.carton) + ' history</h3>' +
    receiptCartonDetails(active) +
    (history.entries.length ? '<ul class="log">' + history.entries.map(entry => '<li><strong>' + escape(entry.action) + '</strong> · ' +
      escape(entry.ref) + ' · ' + escape(entry.actor) + ' · ' + escape(new Date(entry.at).toLocaleString()) +
      (entry.reason ? '<br>' + escape(entry.reason) : '') + '</li>').join('') + '</ul>' : '<p>No movements recorded.</p>') +
    movementControls(active,data.user.role,stockData.locations) + '</div>' : '';
  return '<h2 id="inventory-cartons-title">' + escape(sku) + ' cartons (' + cartons.length + ')</h2>' + events + '<div class="workspace-table"><table>' +
    '<thead><tr><th scope="col">Carton</th><th scope="col">EPC</th><th scope="col">Location</th><th scope="col">Tag source</th><th scope="col">Stock status</th></tr></thead><tbody>' +
    cartons.map(c => '<tr><th scope="row"><button type="button" data-carton="' + escape(c.epc) + '">' + escape(c.carton) +
      '</button></th><td><code>' + escape(c.epc) + '</code></td><td>' + escape(c.location) + '</td><td>' +
      (c.physical ? 'Physical test tag' : c.registered ? 'Registered tag' : 'Synthetic') + '</td><td>' +
      statusBadge(c.state === 'dispatched' ? 'Dispatched' : c.state === 'held' ? 'Held' : 'On hand') +
      '</td></tr>').join('') + '</tbody></table></div>';
}
function sourceLabel(session) {
  if (session.source !== 'C72 hardware') return session.source;
  const scans = [...(session.palletAttempts ?? []), ...session.runs];
  const latest = scans.filter(scan => scan.profile?.deviceId).sort((a,b) =>
    (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
  return latest?.profile.deviceId ?? 'Device ID unavailable';
}

function outboundTable() {
  const canConfirmDispatch = ['admin','supervisor'].includes(data.user.role);
  const stockByEpc = new Map(data.inventory.map(carton => [carton.epc,carton.state]));
  const rows = data.sessions.map(s => {
    const eligible = data.dispatchable.includes(s.id);
    const pallets = s.manifest?.pallets ?? [];
    const cartons = pallets.length ? pallets.flatMap(pallet => pallet.cartons) : (s.manifest?.cartons ?? []);
    const progress = pallets.filter(pallet => s.palletMatches?.[pallet.palletEpc]).length;
    const blocked = !s.dispatchedAt && (s.dispatchApproval || s.confirmedAt) ?
      cartons.filter(carton => stockByEpc.get(carton.epc) !== 'available') : [];
    const stockReason = blocked.length ? blocked.length + (blocked.length === 1 ? ' carton ' : ' cartons ') +
      (blocked.every(carton => stockByEpc.get(carton.epc) === 'dispatched') ? 'already dispatched' : 'unavailable') : '';
    const actions = controls(s,data.user);
    const menuId = 'session-actions-' + escape(s.id);
    const checkbox = canConfirmDispatch ? '<td class="dispatch-select"><input type="checkbox" data-select-session aria-label="Select ' +
      escape(s.testId) + ' for dispatch"' + (eligible ? '' : ' disabled') + '></td>' : '';
    const dispatchButton = canConfirmDispatch && !s.dispatchedAt ? '<button type="button" data-action="dispatch"' +
      (eligible ? '' : ' disabled') + '>Dispatch</button>' : data.approvable.includes(s.id) ? actionButton('approve','Approve dispatch') : '';
    const more = actions ? '<button type="button" class="session-more" popovertarget="' + menuId + '">More actions</button>' +
      '<div popover id="' + menuId + '" class="session-actions" role="group" aria-label="Actions for ' + escape(s.testId) + '">' + actions + '</div>' : '';
    return '<tr data-session="' + escape(s.id) + '">' + checkbox + '<th scope="row"><a href="#sessions/' + encodeURIComponent(s.id) + '">' +
      escape(s.testId) + '</a></th><td>' + escape(s.location) + '</td><td>' + escape(sourceLabel(s)) +
      (s.source === 'C72 hardware' ? '<small class="dispatch-block-reason">Recommended: ' +
        (data.controls.sessionPowers?.[s.id] ?? data.controls.power?.requested ?? 30) + ' dBm</small>' : '') + '</td><td>' +
      (stockReason ? statusBadge('Stock blocked') + '<small class="dispatch-block-reason">' + stockReason + '</small>' : statusBadge(stage(s))) +
      (pallets.length > 1 && !s.dispatchedAt ? '<small class="dispatch-block-reason">' + progress + ' of ' + pallets.length + ' pallets matched</small>' : '') +
      '</td><td>' + dispatchButton + '</td><td>' + more + '</td></tr>';
  }).join('');
  return '<div class="row spread line"><h2>Outbound sessions (' + data.sessions.length + ')</h2><div class="row">' +
    (canConfirmDispatch ? '<button type="button" class="primary-button dispatch-button" data-action="dispatch" data-dispatch-batch disabled>' +
      '<span class="dispatch-indicator" aria-hidden="true"></span><span class="dispatch-label">Confirm dispatch</span></button>' : '') +
    (rows ? '<a href="api/evidence.csv" download>Export evidence CSV</a>' : '') + '</div></div>' +
    (rows ? '<div class="workspace-table"><table><thead><tr>' + (canConfirmDispatch ?
      '<th scope="col" class="dispatch-select"><input type="checkbox" data-select-all aria-label="Select all dispatchable sessions"></th>' : '') +
      '<th scope="col">Test ID</th><th scope="col">Location</th><th scope="col">Source</th><th scope="col">Status</th>' +
      '<th scope="col">Actions</th><th scope="col" aria-label="More actions"></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="muted">No sessions yet.</p>');
}
let manifestSelected, manifestPreview;
function manifestSettings() {
  if (data.user.role !== 'admin') return '<p>Administrator access required.</p>';
  const drafts = data.palletManifests ?? [];
  const draft = drafts.find(item => item.id === manifestSelected) ?? drafts[0];
  const esc = escape;
  const form = (action,body) => '<form class="stock-action manifest-form" data-manifest-form="' + action + '">' + body + '</form>';
  const hiddenId = draft ? '<input type="hidden" name="id" value="' + esc(draft.id) + '">' : '';
  const submit = label => '<button class="primary-button">' + label + '</button>';
  const devices = (data.devices ?? []).filter(device => Date.now() - Date.parse(device.lastContact) < 60_000);
  const request = devices.length ? form('request','<label>Pallet reference<input name="reference" required maxlength="80"></label>' +
    '<label>Handheld<select name="deviceId">' + devices.map(device => '<option value="' + esc(device.deviceId) + '">RFID handheld ' +
      esc(device.deviceId) + '</option>').join('') + '</select></label>' + submit('Request pallet scan')) : '<p>No handheld is connected.</p>';
  const chooser = drafts.length ? '<label>Manifest requests (' + drafts.length + ')<select id="manifest-selection">' + drafts.map(item =>
    '<option value="' + esc(item.id) + '"' + (draft.id === item.id ? ' selected' : '') + '>' +
    esc(item.reference + ' · ' + item.status) + '</option>').join('') + '</select></label>' : '';
  const table = (rows,selectable) => '<div class="workspace-table"><table><thead><tr>' + (selectable ? '<th scope="col">Select</th>' : '') +
    '<th scope="col">Product</th><th scope="col">Carton</th><th scope="col">EPC</th><th scope="col">Pickup location</th></tr></thead><tbody>' +
    rows.map(carton => '<tr>' + (selectable ? '<td><input type="checkbox" name="epc" value="' + esc(carton.epc) +
      '" aria-label="Select ' + esc(carton.carton) + '"></td>' : '') + '<td>' + esc(carton.sku) + '</td><td>' + esc(carton.carton) +
      '</td><td><code>' + esc(carton.epc) + '</code></td><td>' + esc(carton.location) + '</td></tr>').join('') + '</tbody></table></div>';
  const pallets = draft?.pallets ?? (draft?.csv ? [{pallet:draft.reference,palletEpc:draft.palletEpc,cartons:draft.cartons}] : []);
  const assigned = new Set(data.assignedCartonEpcs ?? []);
  const palletList = pallets.map(pallet => '<details class="dashboard-fold"><summary><span>' + esc(pallet.pallet) + ' · ' +
    pallet.cartons.length + ' cartons</span></summary><div class="dashboard-fold-body"><p><code>' + esc(pallet.palletEpc) +
    '</code></p>' + table(pallet.cartons,false) + '</div></details>').join('');
  const existing = (data.existingPallets ?? []).filter(pallet => pallet.draftId !== draft?.id);
  const addPallet = draft?.status === 'Manifest ready' ? '<details class="dashboard-fold"' +
    (panel.querySelector('#add-manifest-pallet[open]')?.dataset.draft === draft.id ? ' open' : '') +
    ' id="add-manifest-pallet" data-draft="' + esc(draft.id) + '"><summary><span>Add another pallet</span></summary>' +
    '<div class="dashboard-fold-body">' +
    (existing.length ? form('add-existing',hiddenId +
      '<label>Existing pallet<select name="palletEpc" required><option value="">Choose a pallet</option>' +
      existing.map(pallet => '<option value="' + esc(pallet.palletEpc) + '">' +
        esc(pallet.pallet + ' · ' + pallet.cartons.length + (pallet.cartons.length === 1 ? ' carton' : ' cartons')) +
        '</option>').join('') + '</select></label>' + submit('Add existing pallet')) : '<p>No existing pallets are available.</p>') +
    form('add-pallet',hiddenId + '<label>Next pallet reference<input name="reference" required maxlength="80"></label>' +
      submit('Request new pallet scan')) + '</div></details>' : '';
  let detail = '';
  if (draft?.status === 'Pallet scanned') {
    const available = data.inventory.filter(carton => carton.state === 'available' && !assigned.has(carton.epc));
    const preview = manifestPreview?.id === draft.id ? manifestPreview.epcs.map(epc => available.find(item => item.epc === epc)) : [];
    detail = preview.length && preview.every(Boolean) ?
      '<h3>Preview pickup list (' + preview.length + ')</h3>' + table(preview,false) + form('generate',hiddenId +
        preview.map(carton => '<input type="hidden" name="epc" value="' + esc(carton.epc) + '"><input type="hidden" name="locationAtPreview" value="' + esc(carton.location) + '">').join('') +
        submit('Generate manifest') + '<button type="button" data-edit-manifest>Edit selection</button>') :
      '<h3>Available cartons (' + available.length + ')</h3>' + (available.length ? form('preview',hiddenId + table(available,true) + submit('Preview manifest')) :
        '<p>No cartons are available.</p>');
  } else if (draft?.csv) {
    detail = '<p><a href="api/pallet-manifest.csv?id=' + encodeURIComponent(draft.id) + '" download data-manifest-download>Download CSV</a></p>' +
      (draft.sessionId ? (draft.sessionRemovedAt ? '<p class="muted">Session removed.</p>' :
        '<p><a href="#sessions/' + encodeURIComponent(draft.sessionId) + '">Open session</a></p>') : form('session',hiddenId +
        '<label>Test ID<input name="testId" required maxlength="80" value="' + esc(draft.reference) + '"></label>' +
        '<label>Location<input name="location" required value="Staging" maxlength="100"></label>' + submit('Create session from manifest')) +
      addPallet);
  }
  return request + chooser + (draft ?
    '<section class="line"><h3>' + esc(draft.reference) + '</h3><p>' + esc(draft.status) + ' · RFID handheld ' + esc(draft.deviceId) +
    (draft.scanReference ? ' · ' + esc(draft.scanReference) : '') +
    (draft.palletEpc ? ' · <code>' + esc(draft.palletEpc) + '</code>' : '') + '</p>' + palletList + detail +
    form('cancel',hiddenId + '<button>Remove pallet manifest</button>') + '</section>' : '');
}
function adminSettings() {
  if (data.user.role !== 'admin') return '';
  const setting = data.controls;
  return '<details id="workspace-lead-settings" class="dashboard-fold"' +
    (panel.querySelector('#workspace-lead-settings[open]') ? ' open' : '') + '><summary><span>Administrator settings</span></summary>' +
    '<div class="dashboard-fold-body"><form id="workspace-settings">' +
    '<div class="workspace-fields"><label class="workspace-field-wide">Test plan<textarea name="plan" rows="3" placeholder="Test ID and description">' +
    escape(setting.plan.map(item => [item.id,item.title].filter(Boolean).join(' ')).join('\n')) + '</textarea></label>' +
    '<label>Requested Power (dBm)<input type="number" min="5" max="30" step="1" name="power" placeholder="30" value="' +
    escape(setting.power?.requested ?? '') + '"></label>' +
    '<label>Stock Task Power (dBm)<input name="stockPower" type="number" min="5" max="30" step="1" required value="' +
    (setting.stockPower ?? 10) + '"></label>' +
    '<label>Pallet Scan Power (dBm)<input name="palletPower" type="number" min="5" max="30" step="1" required value="' +
    (setting.palletPower ?? 15) + '"></label>' +
    '<label>LookUp Power (dBm)<input name="lookupPower" type="number" min="5" max="30" step="1" placeholder="Use session power" value="' +
    escape(setting.lookupPower ?? '') + '"></label></div>' +
    '<div class="row workspace-actions"><button class="primary-button">Save test settings</button></div></form>' +
    '<div class="workspace-reset-row"><button type="button" data-action="reset">Reset demo data</button></div></div></details>';
}

function manage() {
  const adminTools = data.user.role === 'admin' ? '<div class="workspace-section-actions">' +
    '<button type="button" data-outbound-panel="create" aria-pressed="' + (outboundPanel === 'create') + '">+ New session</button>' +
    '<button type="button" data-outbound-panel="manifest" aria-pressed="' + (outboundPanel === 'manifest') + '">+ Build manifest</button></div>' +
    (outboundPanel === 'create' ? '<div class="workspace-outbound-tools"><form id="workspace-create"><h2>New session</h2><div class="workspace-fields">' +
      '<label>Test ID<input name="testId" maxlength="80" required></label><label>Location<input name="location" maxlength="100" value="Staging" required></label>' +
      '<label>Reader source<select name="source"><option>Simulation</option><option value="C72 hardware">RFID handheld</option></select></label></div>' +
      '<div class="workspace-create-actions"><div class="workspace-csv-choice">' + csvPicker('create-csv-status') +
      '<span class="workspace-csv-divider" aria-hidden="true">&#92;</span>' +
      '<button type="button" data-action="sample" aria-pressed="false">Use Sample CSV</button></div>' +
      '<button class="primary-button">Create session</button></div></form></div>' :
    outboundPanel === 'manifest' ? '<div class="workspace-outbound-tools">' + manifestSettings() + '</div>' : '') : '';
  return adminTools + outboundTable();
}
let message = '';
const milestones = {
  physical:['Physical check recorded','The Operator can open the session and scan the pallet.'],
  approve:['Dispatch approved','The session can now be selected for dispatch.'],
  dispatch:['Dispatch recorded','The dispatched cartons were deducted from on-hand stock.'],
  reopen:['Session reopened','The session is ready for a new physical check.'],
  receive:['Receipt confirmed','Inventory is updated.'],
  review:['Count reviewed','Scan evidence is saved.'],
  'cancel-count':['Count cancelled','You can open a fresh count for this location.'],
  outbound:['Pallet prepared','Open it in Outbound.'],
  reset:['Demo data reset','Starting inventory restored.']
};
const confirmation = document.createElement('dialog');
confirmation.className = 'workflow-dialog';
confirmation.setAttribute('aria-labelledby','workspace-confirm-title');
confirmation.innerHTML = '<span class="workflow-tick" aria-hidden="true"></span><h2 id="workspace-confirm-title"></h2>' +
  '<p></p><form method="dialog"><button>Done</button></form>';
panel.after(confirmation);
function updateDevicePill() {
  const devices = stockData?.devices ?? data?.devices ?? (stockData?.device ? [stockData.device] : []);
  if (!data && !stockData) { devicePill.hidden = true; return; }
  const live = devices.filter(device => device?.lastContact && Date.now() - Date.parse(device.lastContact) < 60_000);
  const label = live.length === 1 ? 'Handheld · ' + (live[0].deviceId || 'Live') :
    live.length > 1 ? live.length + ' handhelds live' : devices.length ? 'Handheld · Offline' : 'No handheld';
  devicePill.hidden = false;
  devicePill.className = 'status device-status' + (live.length ? ' live' : '');
  devicePill.textContent = label;
  devicePill.title = label;
}
const render = () => {
  updateDevicePill();
  if (overviewReports) {
    if (stockData) {
      if (!overviewReports.hasChildNodes()) overviewReports.innerHTML = reportsCard();
      overviewReports.hidden = false;
    } else {
      overviewReports.hidden = true;
    }
  }
  if (!data) { panel.textContent = message || 'Loading workspace…'; return; }
  const current = section();
  const body = current === 'inventory' ? inventoryTabs(current) + inventory() :
    ['inbound','counts'].includes(current) ? inventoryTabs(current) + stockPage(current,data,stockData,stockSelection,receiptPreview) :
    ['manage','manifests'].includes(current) ? manage() :
    current === 'devices' ? adminSettings() + stockPage('devices',data,stockData,stockSelection,receiptPreview) :
    stockPage(current,data,stockData,stockSelection,receiptPreview);
  panel.innerHTML = '<p id="workspace-message" role="status">' + escape(message) + '</p>' + body +
    '<dialog id="workspace-dialog" aria-labelledby="workspace-dialog-title"><form method="dialog" id="workspace-dialog-form">' +
    '<h2 id="workspace-dialog-title"></h2><p></p><div class="workspace-dialog-fields"></div>' +
    '<div class="row workspace-actions"><button value="cancel" formnovalidate>Cancel</button>' +
    '<button class="primary-button" value="confirm">Confirm</button></div></form></dialog>';
  updateSelection();
};
function updateSelection() {
  const button = panel.querySelector('[data-dispatch-batch]');
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
  return !mutating && (isWorkspace() || ['','overview'].includes(section())) && !panel.contains(document.activeElement) &&
    !confirmation.open && !panel.querySelector('dialog[open], :popover-open') && !panel.querySelector('input[type=file]')?.files.length &&
    !panel.querySelector('[data-csv-drop][data-dragging], [data-csv-drop][data-error]') &&
    ![...panel.querySelectorAll('input:not([type=file]),textarea')].some(input =>
      input.type === 'checkbox' || input.type === 'radio' ? input.checked !== input.defaultChecked : input.value !== input.defaultValue) &&
    !panel.querySelector('[data-action="sample"][aria-pressed="true"]');
}
async function load(background = false) {
  const version = ++loadVersion;
  const canRender = () => version === loadVersion && (!background || canRefreshInBackground());
  try {
    const [updated,ops] = await Promise.all([readApi('api/workspace'),readApi('api/stock-workflows')]);
    if (!canRender()) return;
    data = updated;
    stockData = ops;
    window.dispatchEvent(new CustomEvent('stock-overview',{detail:{
      inventory:data.inventory.filter(c => c.state !== 'dispatched').length,
      inbound:stockData.tasks.filter(t => t.type === 'receipt' && t.status !== 'Completed').length,
      counts:stockData.tasks.filter(t => t.type === 'count' && t.status === 'In progress').length
    }}));
  } catch (error) {
    if (!canRender()) return;
    message = error.message;
  }
  render();
}
async function mutate(path, payload) {
  if (mutating) return;
  mutating = true;
  rolePicker.disabled = true;
  const dispatching = payload.action === 'dispatch';
  if (dispatching) {
    dispatchState = 'pending';
    updateSelection();
  }
  message = '';
  let result;
  try {
    result = await readApi(path,{...payload,generation:data.generation});
    if (path === 'api/pallet-manifest') { manifestSelected = result.id; manifestPreview = undefined; }
    if (path === 'api/session') outboundPanel = '';
    if (['count','receipt'].includes(payload.action) && result.id) stockSelection = result.id;
    if (payload.action === 'receipt') { receiptPreview = receiptCsv = undefined; }
    if (['transfer','hold','release'].includes(payload.action) && history?.epc === payload.epc) {
      history.entries = await readApi('api/carton-history?epc=' + encodeURIComponent(payload.epc));
    }
    message = 'Saved.';
    window.dispatchEvent(new Event('workspace-updated'));
  }
  catch (error) {
    message = error.message;
    if (path === 'api/session' && ['manage','manifests'].includes(section())) {
      panel.querySelector('#workspace-message').textContent = message;
      mutating = rolePicker.disabled = false;
      return;
    }
  }
  if (dispatching) {
    dispatchState = result ? 'done' : 'idle';
    updateSelection();
  }
  await load();
  if (dispatching && result && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await new Promise(resolve => setTimeout(resolve,420));
  }
  mutating = false;
  rolePicker.disabled = false;
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
panel.addEventListener('change', event => {
  if (event.target.id !== 'manifest-selection') return;
  manifestSelected = event.target.value;
  manifestPreview = undefined;
  message = '';
  render();
});
panel.addEventListener('click', async event => {
  const link = event.target.closest('[data-manifest-download]');
  if (link) {
    event.preventDefault();
    try {
      const response = await fetch(link.href,{cache:'no-store',headers:{'X-KeyPharm-Role':role}});
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('text/csv')) throw new Error('Could not download the manifest CSV.');
      const url = URL.createObjectURL(await response.blob());
      const download = document.createElement('a');
      download.href = url;
      download.download = 'pallet-manifest.csv';
      download.click();
      setTimeout(() => URL.revokeObjectURL(url),1000);
    } catch (error) { panel.querySelector('#workspace-message').textContent = error.message; }
    return;
  }
  const togglePanel = event.target.closest('[data-outbound-panel]');
  if (togglePanel) {
    const next = togglePanel.dataset.outboundPanel;
    outboundPanel = outboundPanel === next ? '' : next;
    message = '';
    render();
    return;
  }
  if (!event.target.closest('[data-edit-manifest]')) return;
  const epcs = manifestPreview?.epcs ?? [];
  manifestPreview = undefined;
  render();
  for (const option of panel.querySelectorAll('input[name="epc"]')) option.checked = epcs.includes(option.value);
});
panel.addEventListener('submit', async event => {
  if (event.target.dataset.manifestForm) {
    event.preventDefault();
    const action = event.target.dataset.manifestForm;
    const values = new FormData(event.target);
    const epcs = values.getAll('epc');
    if (action === 'preview') {
      if (!epcs.length) { panel.querySelector('#workspace-message').textContent = 'Select at least one carton.'; return; }
      manifestPreview = {id:values.get('id'),epcs};
      render();
      return;
    }
    const payload = {...Object.fromEntries(values),action,epcs,locations:values.getAll('locationAtPreview')};
    if (action === 'cancel') {
      const dialog = panel.querySelector('dialog');
      dialog.returnValue = 'cancel';
      dialog.querySelector('h2').textContent = 'Remove pallet manifest?';
      dialog.querySelector('p').textContent = 'This removes it from the manifest list. Any session created from it stays available.';
      dialog.querySelector('.workspace-dialog-fields').replaceChildren();
      dialog.addEventListener('close',() => {
        if (dialog.returnValue === 'confirm') void mutate('api/pallet-manifest',{...payload,confirmed:true});
      },{once:true});
      dialog.showModal();
      return;
    }
    await mutate('api/pallet-manifest',payload);
    return;
  }
  if (event.target.dataset.stockAction) {
    event.preventDefault();
    const values = new FormData(event.target);
    const requestedAction = event.target.dataset.stockAction;
    const action = requestedAction === 'transfer' && values.get('location') === 'Hold' ? 'hold' : requestedAction;
    const record = event.target.closest('[data-stock-record]');
    const dialog = panel.querySelector('dialog');
    const change = {...Object.fromEntries(values),action,operationId:crypto.randomUUID(),
      id:record?.dataset.stockRecord,revision:Number(record?.dataset.revision)};
    if (action === 'preview') {
      try {
        const file = values.get('csv');
        if (!file?.size || file.size > 512000) throw new Error('Choose a CSV up to 512 KB.');
        receiptCsv = await file.text();
        receiptPreview = await readApi('api/stock-action',{action,csv:receiptCsv,generation:data.generation});
        message = '';
        render();
      } catch (error) {
        receiptPreview = receiptCsv = undefined;
        panel.querySelector('#workspace-message').textContent = error.message;
      }
      return;
    }
    if (action === 'receipt') change.csv = receiptCsv;
    if (values.has('epcs')) change.epcs = values.get('epcs').trim().split(/[\s,;]+/).filter(Boolean);
    if (['count','scan','receipt'].includes(action)) { await mutate('api/stock-action',change); return; }
    dialog.returnValue = 'cancel';
    dialog.querySelector('h2').textContent = action === 'hold' ? 'Place on hold' :
    action === 'cancel-count' ? 'Cancel count?' : event.submitter.textContent;
    dialog.querySelector('p').textContent = action === 'untag' ? 'Remove this EPC from the receipt and return the carton to outstanding.' :
    action === 'cancel-count' ? 'Remove this count from the list and keep its scan history. Inventory stays the same.' : '';
    dialog.querySelector('.workspace-dialog-fields').replaceChildren();
    dialog.addEventListener('close',() => {
      if (dialog.returnValue === 'confirm') void mutate('api/stock-action',change);
    },{once:true});
    dialog.showModal();
    return;
  }
  if (event.target.id === 'workspace-settings') {
    event.preventDefault();
    const values = new FormData(event.target);
    const power = values.get('power');
    const change = {revision:data.controls.revision,operationId:crypto.randomUUID(),plan:values.get('plan')};
    const requested = power === '' ? null : Number(power);
    if (requested !== (data.controls.power?.requested ?? null)) change.power = requested;
    const stockPower = Number(values.get('stockPower'));
    if (stockPower !== (data.controls.stockPower ?? 10)) change.stockPower = stockPower;
    const palletPower = Number(values.get('palletPower'));
    if (palletPower !== (data.controls.palletPower ?? 15)) change.palletPower = palletPower;
    const lookupPower = values.get('lookupPower') === '' ? null : Number(values.get('lookupPower'));
    if (lookupPower !== (data.controls.lookupPower ?? null)) change.lookupPower = lookupPower;
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
panel.addEventListener('click', async event => {
  const task = event.target.closest('[data-stock-open]');
  if (task) {
    stockSelection = task.dataset.stockOpen;
    render();
    return;
  }
  const carton = event.target.closest('[data-carton]');
  if (carton) {
    const epc = carton.dataset.carton;
    const version = ++historyRequest;
    try {
      const entries = await readApi('api/carton-history?epc=' + encodeURIComponent(epc));
      if (version === historyRequest && section() === 'inventory') { history = {epc,entries}; render(); }
    } catch (error) { panel.querySelector('#workspace-message').textContent = error.message; }
    return;
  }
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
  button.closest(':popover-open')?.hidePopover();
  const dispatch = action === 'dispatch' ? (record ? [record] : data.sessions.filter(s => selectedSessions.has(s.id))) : [];
  const dialog = panel.querySelector('dialog');
  dialog.returnValue = 'cancel';
  dialog.querySelector('h2').textContent = action === 'dispatch' ? 'Confirm dispatch' : action === 'approve' ? 'Approve dispatch' : button.textContent;
  dialog.querySelector('p').textContent = action === 'physical' ? 'Confirm you checked the actual pallet and its label assignments.' :
    action === 'approve' ? 'Confirm dispatch approval for ' + record.testId + ' after reviewing the physical check and clean scan.' :
    action === 'dispatch' ? (dispatch.some(s => !s.dispatchApproval) ?
      'This records approval and deducts the selected cartons from on-hand stock.' : 'This deducts the selected cartons from on-hand stock.') :
    action === 'manifest' && record.closedAt ? 'Changing the CSV reopens the session and requires a new physical check.' :
    action === 'manifest' && record.manifest ? 'Changing the CSV requires a new physical check.' :
    action === 'remove' ? 'Remove this session from the dashboard and handheld lists. Scan history and inventory are retained.' :
    action === 'reopen' ? 'Keep the current CSV and start a new verification. Previous scans stay in the session history.' :
    action === 'reset' ? 'Clear sessions, scans and test settings from the shared workspace and the handheld. Restore starting stock.' :
    'Session ' + record.testId;
  const fields = dialog.querySelector('.workspace-dialog-fields');
  fields.innerHTML = action === 'manifest' ? csvPicker('replace-csv-status') :
    action === 'power' ? '<label>Recommended Power (dBm)<input name="power" type="number" min="5" max="30" step="1" placeholder="' +
      (data.controls.power?.requested ?? 30) + '" value="' + escape(data.controls.sessionPowers?.[record.id] ?? '') + '"></label>' :
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
    if (action === 'power') {
      const power = form.get('power');
      await mutate('api/settings',{revision:data.controls.revision,operationId:crypto.randomUUID(),
        sessionPowers:{[record.id]:power === '' ? null : Number(power)}});
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
  if (event.target.id === 'inventory-location') {
    inventoryLocation = event.target.value;
    render();
    panel.querySelector('#inventory-location')?.focus();
    return;
  }
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
window.addEventListener('hashchange',() => {
  message = '';
  if (section() === 'manifests') outboundPanel = 'manifest';
  if (isWorkspace() || ['', 'overview', 'reports'].includes(section())) void load();
});
rolePicker.addEventListener('change',() => {
  role = rolePicker.value;
  sessionStorage.setItem(roleKey,role);
  selectedSessions.clear();
  history = receiptPreview = receiptCsv = undefined;
  message = '';
  data = undefined;
  render();
  void load();
});
document.querySelector('#refresh').addEventListener('click',() => { if (!panel.hidden || ['', 'overview'].includes(section())) void load(); });
setInterval(() => {
  if (canRefreshInBackground()) void load(true);
},5000);
window.dispatchEvent(new Event('hashchange'));
void load();
