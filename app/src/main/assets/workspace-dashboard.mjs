import {escapeHtml as escape} from './model.mjs';
import {movementControls,receiptCartonDetails,reportsCard,stockPage} from './stock-dashboard.mjs';
import {demoSku,displaySource,palletCartonCount,cartonLabel,defaultInventoryOptions,cartonSku,signOutIcon} from './model.mjs';

const nav = document.querySelector('#dashboard-nav');
const workspaceSections = [
  ['inventory','Inventory','nav-inventory','inventory,inbound,counts,pallet-inventory'],
  ['manage','Outbound','nav-manage','manage,manifests'],
  ['devices','Devices & Setup','nav-pallets','devices']
];
const allWorkspaceKeys = new Set(['inventory','inbound','counts','pallet-inventory','manage','manifests','devices']);
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
const toolbar = document.querySelector('.dashboard-toolbar-actions');
toolbar.prepend(rolePicker);
const signOut = document.createElement('form');
signOut.method = 'post';
signOut.action = 'dashboard/sign-out';
signOut.innerHTML = '<button type="submit" aria-label="Sign out" title="Sign out">' + signOutIcon + '</button>';
signOut.addEventListener('submit',() => sessionStorage.removeItem(roleKey));
toolbar.append(signOut);
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
  if (response.status === 401) window.location.replace("dashboard/sign-in");
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
  return s.verifiedAt ? 'Ready to scan' : s.manifest ? 'Verification due' : 'Manifest needed';
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
    (['admin','supervisor'].includes(user.role) && s.manifest && !s.verifiedAt ? actionButton('physical','Record verification') : '');
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

let inventoryConfig;
function inventoryConfigurator(current) {
  const groups = current === 'pallet-inventory' ? [['palletMaterials','Materials'],['palletSizes','Pallet sizes']] :
    [['cartonSizes','Carton sizes']];
  const catalogs = data.controls.inventoryOptions ?? defaultInventoryOptions;
  return '<section class="inventory-config" aria-label="Inventory configuration">' + groups.map(([group,title]) => {
    const options = catalogs[group].filter(option => !option.archived);
    return '<div><h3>' + title + '</h3><ul>' + options.map(({code,label}) =>
      '<li><span>' + escape(label) + (label === code ? '' : ' · ' + escape(code)) + '</span>' +
      '<form data-inventory-option="remove"><input type="hidden" name="group" value="' + group + '">' +
      '<input type="hidden" name="code" value="' + escape(code) + '"><button type="submit" aria-label="Remove ' +
      escape(label) + ' from ' + title.toLowerCase() + '"' + (options.length === 1 ? ' disabled' : '') + '>Remove</button></form></li>'
    ).join('') + '</ul><form class="stock-action" data-inventory-option="add">' +
    '<input type="hidden" name="group" value="' + group + '">' +
    '<label>Code<input name="code" ' + (group === 'palletMaterials' ? 'placeholder="Auto"' : 'required') +
    ' maxlength="20" pattern="[A-Za-z0-9]+"></label>' +
    '<label>Name<input name="label" maxlength="40"></label><button class="primary-button">Add ' +
    (group === 'palletMaterials' ? 'material' : 'size') + '</button></form></div>';
  }).join('') +
    '<p>Removed options stay on existing records.</p></section>';
}
function inventoryTabs(current) {
  const tasks = stockData?.tasks.filter(item => item.status !== 'Cancelled') ?? [];
  const counts = {
    inventory:data.inventory.length,
    'pallet-inventory':(data.palletInventory ?? []).length,
    inbound:tasks.filter(item => item.type === 'receipt').length,
    counts:tasks.filter(item => item.type === 'count').length
  };
  const config = data.user.role === 'admin' && ['inventory','pallet-inventory'].includes(current);
  return '<div class="inventory-toolbar"><nav class="workspace-subtabs" aria-label="Inventory views">' +
    [['inventory','Stock'],['pallet-inventory','Pallets'],['inbound','Inbound'],['counts','Stock counts']].map(([key,label]) =>
      '<a href="#' + key + '"' + (current === key ? ' aria-current="page"' : '') + '>' + label +
      ' <span class="tab-count">' + counts[key] + '</span></a>').join('') +
    '</nav>' + (config ? '<button type="button" data-inventory-config="' + current + '" aria-haspopup="dialog">' +
      (current === 'inventory' ? 'Configure stock' : 'Configure pallets') + '</button>' : '') +
    '</div>';
}

function palletInventory() {
  const importForm = data.user.role === 'admin' ? '<form class="stock-action" data-manifest-form="import-pallets">' +
    '<div class="pallet-import-file"><div class="pallet-import-label"><label for="pallet-inventory-csv">Pallet inventory CSV</label> ' +
    '(<a href="data:text/csv;charset=utf-8,pallet_ref%2Cpallet_epc%2Cmaterial%2Csize%0A" download="pallet-inventory-template.csv">Download template</a>)</div>' +
    '<input id="pallet-inventory-csv" type="file" name="csv" accept=".csv,text/csv" required></div>' +
    '<button class="primary-button">Import pallets</button></form>' : '';
  const rows = (data.palletInventory ?? []).map(pallet => '<tr><th scope="row">' + escape(pallet.reference) + '</th><td>' +
    escape(pallet.identifier) + '</td><td>' + escape(pallet.size) + '</td><td>' + escape(pallet.material) + '</td><td><code>' +
    escape(pallet.epc) + '</code></td><td>' + statusBadge(pallet.status) + '</td>' +
    (data.user.role === 'admin' ? '<td>' + (pallet.status === 'On hand' ?
      '<form class="stock-action" data-stock-action="remove-pallet"><input type="hidden" name="epc" value="' + escape(pallet.epc) +
      '"><button aria-label="Remove pallet ' + escape(pallet.reference) + '">Remove</button></form>' : '') + '</td>' : '') + '</tr>').join('');
  return '<h2>Pallet inventory</h2>' + importForm + (rows ? '<div class="workspace-table"><table aria-label="Pallet inventory">' +
    '<thead><tr><th scope="col">Pallet</th><th scope="col">Identifier</th><th scope="col">Size</th><th scope="col">Material</th>' +
    '<th scope="col">EPC</th><th scope="col">Status</th>' +
    (data.user.role === 'admin' ? '<th scope="col">Actions</th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p>No pallets imported.</p>');
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
  const events = active ? '<div class="dashboard-fold-body"><header class="row spread carton-history-heading"><h3>' +
    escape(cartonSku(active) === active.sku ? cartonLabel(active.carton) : demoSku(cartonSku(active))) +
    ' (' + escape(active.epc.slice(-5)) + ') history</h3>' +
    '<button type="button" data-close-carton-history aria-label="Close carton history" title="Close carton history">×</button></header>' +
    receiptCartonDetails(active) +
    (history.entries.length ? '<ul class="log">' + history.entries.map(entry => '<li><strong>' + escape(entry.action) + '</strong> · ' +
      escape(entry.ref) + ' · ' + escape(entry.actor) + ' · ' + escape(new Date(entry.at).toLocaleString()) +
      (entry.reason ? '<br>' + escape(entry.reason) : '') + '</li>').join('') + '</ul>' : '<p>No movements recorded.</p>') +
    movementControls(active,data.user.role) + '</div>' : '';
  return '<h2 id="inventory-cartons-title">' + escape(sku) + ' cartons (' + cartons.length + ')</h2>' + events + '<div class="workspace-table"><table>' +
    '<thead><tr><th scope="col">Carton</th><th scope="col">EPC</th><th scope="col">Location</th><th scope="col">Tag source</th><th scope="col">Stock status</th></tr></thead><tbody>' +
    cartons.map(c => '<tr><th scope="row"><button type="button" data-carton="' + escape(c.epc) + '">' + escape(cartonSku(c) === c.sku ? cartonLabel(c.carton) : demoSku(cartonSku(c))) +
      '</button></th><td><code>' + escape(c.epc) + '</code></td><td>' + escape(c.location) + '</td><td>' +
      (c.physical ? 'Physical test tag' : c.registered ? 'Registered tag' : 'Synthetic') + '</td><td>' +
      statusBadge(c.state === 'dispatched' ? 'Dispatched' : c.state === 'held' ? 'Held' : 'On hand') +
      '</td></tr>').join('') + '</tbody></table></div>';
}
function sourceLabel(session) {
  if (session.source !== 'C72 hardware') return displaySource(session.source);
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
      '<th scope="col">Session ID</th><th scope="col">Location</th><th scope="col">Source</th><th scope="col">Status</th>' +
      '<th scope="col">Actions</th><th scope="col" aria-label="More actions"></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="muted">No sessions yet.</p>');
}
let manifestSelected;
function outboundLocation() {
  return '<label>Location<select name="location" required>' + (stockData?.outboundLocations ?? []).map(name =>
    '<option value="' + escape(name) + '"' + (name === stockData.stagingLocation ? ' selected' : '') +
    '>' + escape(name) + '</option>').join('') + '</select></label>';
}
function manifestSettings() {
  if (data.user.role !== 'admin') return '<p>Administrator access required.</p>';
  const drafts = data.palletManifests ?? [];
  const draft = drafts.find(item => item.id === manifestSelected) ?? drafts[0];
  const form = (action,body) => '<form class="stock-action manifest-form" data-manifest-form="' + action + '">' + body + '</form>';
  const hiddenId = draft ? '<input type="hidden" name="id" value="' + escape(draft.id) + '">' : '';
  const submit = label => '<button class="primary-button">' + label + '</button>';
  const onHand = (data.palletInventory ?? []).filter(pallet => pallet.status === 'On hand');
  function choosePallet(add) {
    if (!onHand.length) return '<p>No pallets on hand. <a href="#pallet-inventory">Open pallet inventory</a>.</p>';
    const used = new Set(add ? draft.pallets.map(pallet => pallet.palletEpc) : []);
    const types = [...new Set(onHand.filter(pallet => !used.has(pallet.epc)).map(pallet => pallet.identifier))];
    const options = types.map(type => '<option value="' + escape(type) + '">' + escape(type) + '</option>').join('');
    const stock = Object.entries(data.skuAvailability ?? {});
    const quantities = stock.filter(([sku,count]) => count > 0 && !stock.some(([variant]) =>
      variant.startsWith(sku + '-'))).map(([sku,count]) =>
      '<label><span>' + escape(demoSku(sku)) + '</span><small class="muted">' + count +
      ' available</small><input type="number" min="0" max="' + count +
      '" step="1" name="sku:' + escape(sku) + '" value="0"></label>').join('');
    if (!quantities) return '<p>No tagged cartons are available for this manifest.</p>';
    return form('sku-pallet',(add ? hiddenId : '') +
      '<label class="manifest-pallet-type">Pallet type<select name="palletType" required><option value="">Choose a pallet type</option>' +
      options + '</select></label><fieldset class="manifest-quantities"><legend>Carton quantities</legend><div>' +
      quantities + '</div></fieldset>' + submit(add ? 'Add pallet to manifest' : 'Generate manifest'));
  }
  const chooser = drafts.length ? '<label>Manifests (' + drafts.length + ')<select id="manifest-selection">' + drafts.map(item =>
    '<option value="' + escape(item.id) + '"' + (draft.id === item.id ? ' selected' : '') + '>' +
    escape(item.reference + ' · ' + item.status) + '</option>').join('') + '</select></label>' : '';
  if (!draft) return choosePallet(false);
  const pallets = draft.pallets ?? (draft.csv ? [{pallet:draft.reference,palletEpc:draft.palletEpc,cartons:draft.cartons}] : []);
  const details = pallets.map(pallet => '<details class="dashboard-fold"><summary><span>' + escape(pallet.pallet) + ' · ' +
    palletCartonCount(pallet) + (palletCartonCount(pallet) === 1 ? ' carton' : ' cartons') + '</span></summary><div class="dashboard-fold-body"><p><code>' + escape(pallet.palletType ?? pallet.palletEpc) +
    '</code></p><ul class="log">' + (pallet.requirements ? pallet.requirements.map(({sku,quantity}) =>
      '<li>' + escape(sku + ' / ' + demoSku(sku)) + ' · ' + quantity + '</li>') : pallet.cartons.map(carton =>
      '<li>' + escape(carton.carton + ' / ' + carton.sku + ' / ' + carton.epc) + '</li>')).join('') + '</ul></div></details>').join('');
  const download = draft.csv ? '<p><a href="api/pallet-manifest.csv?id=' + encodeURIComponent(draft.id) +
    '" download data-manifest-download>Download CSV</a></p>' : '';
  const session = draft.sessionId ? (draft.sessionRemovedAt ? '<p>Session removed.</p>' :
    '<p><a href="#sessions/' + encodeURIComponent(draft.sessionId) + '">Open session</a></p>') : draft.csv ?
    form('session',hiddenId + '<label>Session ID<input name="testId" required maxlength="80" value="' + escape(draft.reference) +
      '"></label>' + outboundLocation() + submit('Create session from manifest')) : '';
  const add = draft.matchBy === 'sku' && draft.status === 'Manifest ready' ?
    '<details class="dashboard-fold"><summary><span>Add another pallet</span></summary><div class="dashboard-fold-body">' +
    choosePallet(true) + '</div></details>' : '';
  return '<details class="dashboard-fold"><summary><span>New manifest</span></summary><div class="dashboard-fold-body">' +
    choosePallet(false) + '</div></details>' + chooser + '<section class="line"><h3>' + escape(draft.reference) + '</h3><p>' +
    escape(draft.status) + '</p>' + details + add + download + session +
    form('cancel',hiddenId + '<button>Remove pallet manifest</button>') + '</section>';
}

let adminSettingsOpen = true;
function adminSettings() {
  if (data.user.role !== 'admin') return '';
  const setting = data.controls;
  return '<details id="workspace-lead-settings" class="dashboard-fold"' +
    (adminSettingsOpen ? ' open' : '') + '><summary><span>Administrator settings</span></summary>' +
    '<div class="dashboard-fold-body"><form id="workspace-settings">' +
    '<div class="workspace-fields"><label class="workspace-field-wide">Test plan<textarea name="plan" rows="3" placeholder="Test ID and description">' +
    escape(setting.plan.map(item => [item.id,item.title].filter(Boolean).join(' ')).join('\n')) + '</textarea></label>' +
    '<label>Requested Power (dBm)<input type="number" min="5" max="30" step="1" name="power" placeholder="30" value="' +
    escape(setting.power?.requested ?? '') + '"></label>' +
    '<label>Stock Task Power (dBm)<input name="stockPower" type="number" min="5" max="30" step="1" required value="' +
    (setting.stockPower ?? 10) + '"></label>' +
    '<label>Pallet Scan Power (dBm)<input name="palletPower" type="number" min="5" max="30" step="1" required value="' +
    (setting.palletPower ?? 15) + '"></label>' +
    '<label>Search Power (dBm)<input name="lookupPower" type="number" min="5" max="30" step="1" placeholder="Use session power" value="' +
    escape(setting.lookupPower ?? '') + '"></label>' +
    '<label>Lookup Power (dBm)<input name="identifyPower" type="number" min="5" max="30" step="1" required value="' +
    (setting.identifyPower ?? 10) + '"></label></div>' +
    '<div class="row workspace-actions"><button class="primary-button">Save test settings</button></div></form>' +
    '<div class="workspace-reset-row"><button type="button" data-action="reset">Reset data *</button></div></div></details>';
}

function locationSettings() {
  const list = stockData?.locationRecords ?? [];
  const open = panel.querySelector('#workspace-locations[open]') ? ' open' : '';
  const admin = data.user.role === 'admin';
  const nameField = (label,value = '') => '<label>' + label + '<input name="name" maxlength="100" required value="' +
    escape(value) + '"></label>';
  const add = admin ? '<form class="stock-action" data-stock-action="add-location">' + nameField('New location name') +
    '<button class="primary-button">Add location</button></form>' : '';
  const rows = list.map(location => {
    const name = escape(location.name);
    const controls = admin && !location.archived && !location.protected ?
      '<form class="stock-action" data-stock-action="rename-location"><input type="hidden" name="locationId" value="' + escape(location.id) + '">' +
      nameField('Rename ' + name,location.name) + '<button>Save name</button>' +
      '<button type="submit" formnovalidate data-location-archive>Archive</button></form>' :
      statusBadge(location.archived ? 'Archived' : location.protected ? 'Protected' : 'Active');
    return '<tr><th scope="row">' + name + '</th><td>' + controls + '</td></tr>';
  }).join('');
  return '<details id="workspace-locations" class="dashboard-fold"' + open + '><summary><span>Locations</span></summary>' +
    '<div class="dashboard-fold-body">' + add + '<div class="workspace-table"><table aria-label="Locations"><thead><tr>' +
    '<th scope="col">Location</th><th scope="col">' + (admin ? 'Manage' : 'Status') + '</th></tr></thead><tbody>' +
    rows + '</tbody></table></div></div></details>';
}
function manage() {
  const adminTools = data.user.role === 'admin' ? '<div class="workspace-section-actions">' +
    '<button type="button" data-outbound-panel="create" aria-pressed="' + (outboundPanel === 'create') + '">+ New session</button>' +
    '<button type="button" data-outbound-panel="manifest" aria-pressed="' + (outboundPanel === 'manifest') + '">+ Build manifest</button></div>' +
    (outboundPanel === 'create' ? '<div class="workspace-outbound-tools"><form id="workspace-create"><h2>New session</h2><div class="workspace-fields">' +
      '<label>Session ID<input name="testId" maxlength="80" required></label>' + outboundLocation() +
      '<label>Reader source<select name="source"><option value="Simulation">Scan *</option><option value="C72 hardware">RFID handheld</option></select></label></div>' +
      '<div class="workspace-create-actions"><div class="workspace-csv-choice">' + csvPicker('create-csv-status') +
      '<span class="workspace-csv-divider" aria-hidden="true">&#92;</span>' +
      '<button type="button" data-action="sample" aria-pressed="false">Use CSV *</button></div>' +
      '<button class="primary-button">Create session</button></div></form></div>' :
    outboundPanel === 'manifest' ? '<div class="workspace-outbound-tools">' + manifestSettings() + '</div>' : '') : '';
  return adminTools + outboundTable();
}
let message = '';
const milestones = {
  physical:['Verification recorded','The Operator can open the session and scan the pallet.'],
  approve:['Dispatch approved','The session can now be selected for dispatch.'],
  dispatch:['Dispatch recorded','The dispatched cartons were deducted from on-hand stock.'],
  reopen:['Session reopened','The session is ready for a new verification.'],
  receive:['Receipt confirmed','Inventory is updated.'],
  review:['Count reviewed','Scan evidence is saved.'],
  'cancel-count':['Count cancelled','You can open a fresh count for this location.'],
  'cancel-receipt':['Task cancelled','Received cartons and scan history are retained.'],
  outbound:['Pallet prepared','Open it in Outbound.'],
  reset:['Data reset *','Starting inventory restored.']
};
const confirmation = document.createElement('dialog');
confirmation.className = 'workflow-dialog';
confirmation.setAttribute('aria-labelledby','workspace-confirm-title');
confirmation.innerHTML = '<span class="workflow-tick" aria-hidden="true"></span><h2 id="workspace-confirm-title"></h2>' +
  '<p></p><form method="dialog"><button>Done</button></form>';
panel.after(confirmation);
const render = () => {
  if (overviewReports) {
    if (stockData) {
      if (!overviewReports.hasChildNodes()) overviewReports.innerHTML = reportsCard();
      overviewReports.hidden = false;
    } else {
      overviewReports.hidden = true;
    }
  }
  if (!data) { panel.textContent = message || 'Loading workspace…'; return; }
  const previousSettings = panel.querySelector('#workspace-lead-settings');
  if (previousSettings) adminSettingsOpen = previousSettings.open;
  const current = section();
  const body = current === 'inventory' ? inventoryTabs(current) + inventory() :
    current === 'pallet-inventory' ? inventoryTabs(current) + palletInventory() :
    ['inbound','counts'].includes(current) ? inventoryTabs(current) + stockPage(current,data,stockData,stockSelection,receiptPreview) :
    ['manage','manifests'].includes(current) ? manage() :
    current === 'devices' ? adminSettings() + locationSettings() + stockPage('devices',data,stockData,stockSelection,receiptPreview) :
    stockPage(current,data,stockData,stockSelection,receiptPreview);
  const configuring = data.user.role === 'admin' && inventoryConfig === current;
  const builder = configuring ? '<dialog class="inventory-builder" aria-labelledby="inventory-builder-title">' +
    '<header><h2 id="inventory-builder-title">' + (current === 'pallet-inventory' ? 'Configure pallets' : 'Configure stock') +
    '</h2><form method="dialog"><button autofocus>Close</button></form></header>' +
    '<p role="status">' + escape(message) + '</p>' + inventoryConfigurator(current) + '</dialog>' : '';
  panel.innerHTML = '<p id="workspace-message" role="status"' + (configuring ? ' hidden' : '') + '>' + escape(message) + '</p>' + body +
    '<dialog id="workspace-dialog" aria-labelledby="workspace-dialog-title"><form method="dialog" id="workspace-dialog-form">' +
    '<h2 id="workspace-dialog-title"></h2><p></p><div class="workspace-dialog-fields"></div>' +
    '<div class="row workspace-actions"><button value="cancel" formnovalidate>Cancel</button>' +
    '<button class="primary-button" value="confirm">Confirm</button></div></form></dialog>' + builder;
  const inventoryDialog = panel.querySelector('.inventory-builder');
  if (inventoryDialog) {
    inventoryDialog.addEventListener('close',() => {
      inventoryConfig = undefined;
      panel.querySelector('#workspace-message').hidden = false;
      panel.querySelector('[data-inventory-config]')?.focus();
    });
    inventoryDialog.showModal();
  }
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
      'pallet-inventory':data.palletInventory.filter(pallet => pallet.status === 'On hand').length,
      inventory:data.inventory.filter(c => c.state !== 'dispatched').length,
      inbound:stockData.tasks.filter(t => t.type === 'receipt' && !['Completed','Cancelled'].includes(t.status)).length,
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
    if (path === 'api/pallet-manifest') { if (result.id) manifestSelected = result.id; }
    if (path === 'api/session') outboundPanel = '';
    if (['count','receipt'].includes(payload.action) && result.id) stockSelection = result.id;
    if (payload.action === 'receipt') { receiptPreview = receiptCsv = undefined; }
    if (['hold','release'].includes(payload.action) && history?.epc === payload.epc) {
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
  const configure = event.target.closest('[data-inventory-config]');
  if (configure) {
    inventoryConfig = configure.dataset.inventoryConfig;
    message = '';
    render();
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
});
panel.addEventListener('submit', async event => {
  if (event.target.dataset.inventoryOption) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    await mutate('api/settings',{revision:data.controls.revision,operationId:crypto.randomUUID(),
      inventoryOption:{...values,action:event.target.dataset.inventoryOption}});
    return;
  }
  if (event.target.dataset.manifestForm) {
    event.preventDefault();
    const action = event.target.dataset.manifestForm;
    const values = new FormData(event.target);
    if (action === 'import-pallets') {
      const file = values.get('csv');
      if (!file?.size || file.size > 512000) {
        panel.querySelector('#workspace-message').textContent = 'Choose a CSV up to 512 KB.';
        return;
      }
      try { await mutate('api/pallet-manifest',{action,csv:await file.text()}); }
      catch (error) { panel.querySelector('#workspace-message').textContent = error.message; }
      return;
    }
    const payload = {...Object.fromEntries(values),action};
    if (action === 'sku-pallet') payload.requirements = [...values].filter(([key,value]) => key.startsWith('sku:') && Number(value) > 0)
      .map(([key,value]) => ({sku:key.slice(4),quantity:Number(value)}));
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
    const action = event.submitter?.hasAttribute('data-location-archive') ? 'archive-location' : event.target.dataset.stockAction;
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
    if (['count','scan','receipt','add-location','rename-location'].includes(action)) { await mutate('api/stock-action',change); return; }
    const needsReason = ['cancel-count','cancel-receipt','remove-carton','remove-pallet'].includes(action);
    dialog.returnValue = 'cancel';
    dialog.querySelector('h2').textContent = action === 'hold' ? 'Place on hold' :
    action === 'cancel-count' ? 'Cancel count?' : action === 'cancel-receipt' ? 'Cancel task?' :
    action === 'remove-pallet' ? 'Remove pallet?' : action === 'archive-location' ? 'Archive location?' : event.submitter.textContent;
    dialog.querySelector('p').textContent = action === 'untag' ? 'Remove this EPC from the receipt and return the carton to outstanding.' :
    action === 'cancel-count' ? 'Close this count and keep its scan history.' :
    action === 'cancel-receipt' ? 'Stop receiving on this task. Cartons already received stay in stock.' :
    action === 'remove-carton' ? 'Remove this carton from active stock and keep its history.' :
    action === 'remove-pallet' ? 'Remove this pallet from active inventory and keep its history.' :
    action === 'archive-location' ? 'Remove this location from new work. Existing history is kept.' : '';
    dialog.querySelector('.workspace-dialog-fields').innerHTML = needsReason ?
      '<label>Reason<input name="reason" required maxlength="240"></label>' : '';
    dialog.addEventListener('close',() => {
      if (dialog.returnValue !== 'confirm') return;
      if (needsReason) change.reason = dialog.querySelector('input[name="reason"]').value;
      void mutate(action === 'remove-pallet' ? 'api/pallet-manifest' : 'api/stock-action',change);
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
    const identifyPower = Number(values.get('identifyPower'));
    if (identifyPower !== (data.controls.identifyPower ?? 10)) change.identifyPower = identifyPower;
    await mutate('api/settings',change);
    return;
  }
  if (event.target.id !== 'workspace-create') return;
  event.preventDefault();
  const form = new FormData(event.target);
  const file = form.get('csv');
  const sample = event.target.querySelector('[data-action="sample"]').getAttribute('aria-pressed') === 'true';
  if (!sample && !file?.size) {
    panel.querySelector('#workspace-message').textContent = 'Choose a CSV or select Use CSV *.';
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
  if (event.target.closest('[data-close-carton-history]')) {
    const epc = history.epc;
    history = undefined;
    historyRequest++;
    render();
    panel.querySelector('[data-carton="' + CSS.escape(epc) + '"]')?.focus({preventScroll:true});
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
    action === 'approve' ? 'Confirm dispatch approval for ' + record.testId + ' after reviewing the verification and clean scan.' :
    action === 'dispatch' ? (dispatch.some(s => !s.dispatchApproval) ?
      'This records approval and deducts the selected cartons from on-hand stock.' : 'This deducts the selected cartons from on-hand stock.') :
    action === 'manifest' && record.closedAt ? 'Changing the CSV reopens the session and requires a new verification.' :
    action === 'manifest' && record.manifest ? 'Changing the CSV requires a new verification.' :
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
