import {demoSku} from './model.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const time = value => new Date(value).toLocaleString();
const option = (value,label = value,disabled = false) => '<option value="' + esc(value) + '"' +
  (disabled ? ' disabled' : '') + '>' + esc(label) + '</option>';
const button = label => '<button class="primary-button">' + label + '</button>';
const list = items => items.length ? '<ul class="log">' + items.map(epc => '<li><code>' + esc(epc) + '</code></li>').join('') + '</ul>' : '';
const form = (action,body) => '<form class="stock-action" data-stock-action="' + action + '">' + body + '</form>';

function runDetails(run,open) {
  const total = run.found.length + (run.outstanding ?? run.missing.length);
  return '<details class="dashboard-fold"' + (open ? ' open' : '') + '><summary><span>' + esc(time(run.at)) + ' · ' + esc(run.source) + '</span></summary>' +
    '<div class="dashboard-fold-body"><p>' + total + ' expected · ' + Object.keys(run.observations).length + ' observed · ' +
    run.found.length + ' matched</p><small>' + esc(run.actor) + '</small>' +
    [['Not observed',run.missing],['Unexpected',run.unexpected],['Unknown EPC',run.unknown]].map(([name,epcs]) =>
      epcs.length ? '<h3>' + name + ' (' + epcs.length + ')</h3>' + list(epcs) : '').join('') +
    (run.identifier ? '<p>Product Identifier: ' + esc(run.identifier) + '</p>' :
      run.confirmedAt ? '<p>Confirmed by ' + esc(run.confirmedBy) + '</p>' : '') +
    (run.reason ? '<p>' + esc(run.reason) + '</p>' : '') + '</div></details>';
}
function skuTotals(task, latest) {
  if (task.type !== 'receipt') return '';
  const rows = (task.quantities ? Object.keys(task.quantities) : [...new Set(task.expected.map(item => item.sku))]).map(sku => {
    const epcs = task.expected.filter(item => item.sku === sku).map(item => item.epc);
    const expected = task.quantities?.[sku] ?? epcs.length;
    const received = task.receivedBySku?.[sku] ?? epcs.filter(epc => task.received.includes(epc)).length;
    const observed = latest?.bySku?.[sku] ?? epcs.filter(epc => latest?.found.includes(epc)).length;
    return '<tr><th scope="row">' + esc(sku) + '</th><td>' + expected + '</td><td>' + observed + '</td><td>' + received +
      '</td><td>' + (expected - received) + '</td></tr>';
  });
  return '<div class="workspace-table"><table><thead><tr><th>Product</th><th>Expected</th><th>Observed</th><th>Received</th>' +
    '<th>Outstanding</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
}
function stockDetail(task,role) {
  const receipt = task.type === 'receipt';
  const done = ['Completed','Reviewed'].includes(task.status);
  const latest = task.runs.at(-1);
  const issue = latest && (latest.outstanding || [latest.missing,latest.unexpected,latest.unknown].some(values => values.length));
  const reasons = '<label>Reason<input name="reason" maxlength="240"' + (issue ? ' required' : '') + '></label>';
  let actions = '';
  if (!receipt && !done && ['admin','operator'].includes(role)) {
    actions += '<details class="dashboard-fold"><summary><span>Import EPC reads</span></summary><div class="dashboard-fold-body">' +
      form('scan','<label>EPCs<textarea name="epcs" rows="3" required placeholder="One EPC per line"></textarea></label>' +
        button('Save scan')) + '</div></details>';
  }
  if (!receipt && !done && latest && ['admin','supervisor'].includes(role)) {
    const correction = latest.unexpected.length ? '<label>Verified carton to move<select name="epc">' +
      option('','No stock change') + latest.unexpected.map(epc => option(epc)).join('') + '</select></label>' : '';
    actions += form('review',correction + reasons + button('Confirm count review'));
  }
  if (receipt && done && role === 'admin' && !task.outbound) actions += form('outbound',button('Prepare outbound pallet'));
  const tags = task.tagged ?? [];
  if (tags.length) actions += '<details class="dashboard-fold"><summary>Tagged cartons</summary><div class="dashboard-fold-body"><ul class="log">' +
    tags.map(tag => '<li><strong>' + esc(tag.sku) + '</strong> · ' + esc(demoSku(tag.sku)) + ' · <code>' + esc(tag.epc) + '</code>' +
      (role === 'admin' && !task.outbound && tag.state === 'available' ? form('untag',
        '<input type="hidden" name="epc" value="' + esc(tag.epc) + '"><label>Untag reason<input name="reason" required maxlength="240"></label>' +
        button('Untag carton')) : '') + '</li>').join('') + '</ul></div></details>';
  const cancel = !receipt && !done && ['admin','operator','supervisor'].includes(role) ? form('cancel-count',
    '<button aria-label="Cancel count" title="Cancel count">×</button>') : '';
  return '<section data-stock-record="' + esc(task.id) + '" data-revision="' + task.revision + '"><div class="row"><h2>' +
    esc(receipt ? task.id : task.reference) + '</h2>' + cancel + '</div><p class="muted">' + esc(task.location) + ' · ' + esc(task.status) +
    ' · ' + (receipt ? (task.mode ?? 'EPC') + ' comparison' : 'Snapshot ' + esc(time(task.createdAt))) + '</p>' + skuTotals(task,latest) +
    (task.outbound ? '<p><a href="#sessions/' + encodeURIComponent(task.outbound) + '">View outbound session</a></p>' : '') +
    (task.review ? '<p>Reviewed by ' + esc(task.review.by) + (task.review.reason ? ' · ' + esc(task.review.reason) : '') + '</p>' : '') +
    actions + task.runs.slice().reverse().map(run => runDetails(run,run === latest)).join('') + '</section>';
}

function receiptSetup(preview) {
  const importSetup = '<a href="api/receipt-template.csv" download>Receipt CSV template</a>' +
    form('preview','<label>Receipt CSV<input name="csv" type="file" accept=".csv,text/csv" required></label>' + button('Preview receipt')) +
    (preview ? '<p>' + esc(preview.id) + ' · ' + esc(preview.location) + ' · ' + esc(preview.mode) + ' comparison</p><ul>' +
      preview.identifiers.map(([identifier,sku]) => '<li>' + esc(identifier) + (identifier === sku ? '' : ' · ' + esc(sku)) +
        ' · ' + preview.quantities[sku] + '</li>').join('') + '</ul>' +
      form('receipt',button('Create receipt')) : '');
  return '<details class="dashboard-fold"' + (preview ? ' open' : '') + '><summary><span>Import receipt' +
    '</span></summary><div class="dashboard-fold-body">' + importSetup + '</div></details>';
}

export function movementControls(carton,role,locations) {
  const {epc,location,state} = carton;
  const actions = [];
  if (state === 'available' && ['admin','operator'].includes(role)) actions.push('transfer');
  if (['admin','supervisor'].includes(role)) {
    if (state === 'available' && role === 'supervisor') actions.push('hold');
    if (state === 'held') actions.push('release');
  }
  const fields = [['epc',epc],['from',location],['state',state]].map(([key,value]) =>
    '<input type="hidden" name="' + key + '" value="' + esc(value) + '">').join('');
  return actions.map(action => {
    const destination = action === 'hold' ? '' : '<label>Destination<select name="location">' +
      locations.filter(value => role === 'admin' || (value !== location && value !== 'Hold')).map(value =>
        value === location ? option(value,value + ' (current)',true) : option(value)).join('') + '</select></label>';
    return form(action,fields + destination + '<label>Reason<input name="reason" required maxlength="240"></label>' +
      button({transfer:'Move carton',hold:'Place on hold',release:'Release from hold'}[action]));
  }).join('');
}

const cardIcon = path => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>';
const reportTypes = [
  ['stock','Carton stock','Carton IDs, EPCs, products, locations, and current stock status.','M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4m-9 4v10m-4-16 9 4'],
  ['receipts','Receipt results','EPCs found, missing, unexpected, or unknown on each inbound scan.','M4 13v6h16v-6M8 13l4 4 4-4m-4 4V4'],
  ['counts','Count variances','Count results by location, including missing and unexpected EPCs.','M8 5H5v16h14V5h-3M9 3h6v4H9zM8 12l1 1 2-2m2 1h3m-8 5h8'],
  ['movements','Stock movements','Carton stock changes with the previous state, actor, and reason.','M3 8h17m-4-4 4 4-4 4m5 4H4m4-4-4 4 4 4'],
  ['evidence','Pallet verification','Outbound scan evidence by pallet, run, and EPC.','M4 18h16M6 18v3m6-3v3m6-3v3M5 15V9h6v6m2 0V9h6v6M8 5l2 2 4-4']
];
const downloadIcon = cardIcon('M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4');

function reportsPage() {
  const cards = reportTypes.map(([key,label,description,path]) => '<li class="report-card"><div class="report-description">' +
    '<span class="report-icon">' + cardIcon(path) + '</span><div><h2>' + label + '</h2><p>' + description + '</p></div></div>' +
    '<a class="report-download" href="api/' + key + '.csv" download aria-label="Download ' + label + ' CSV">' + downloadIcon + 'Download CSV</a></li>');
  return '<ul class="report-grid" aria-label="CSV reports">' + cards.join('') + '</ul>' +
    '<div class="report-integration"><span class="report-icon">' + cardIcon('M8 4v5m8-5v5M6 9h12v3a6 6 0 0 1-12 0zm6 9v3') +
    '</span><h2>ERP/WMS</h2><span class="dashboard-badge">Not configured</span></div>';
}

function devicesPage(device) {
  const contact = device?.lastContact;
  const connected = contact && Date.now() - Date.parse(contact) < 60_000;
  const name = 'RFID handheld' + (device?.deviceId ? ' ' + device.deviceId : '');
  return '<article class="device-card"><div class="report-description"><span class="report-icon">' +
    cardIcon('M7 3h10v18H7zM9 6h6v7H9zm1 10h.01m4 0h.01m-4 3h.01m4 0h.01') +
    '</span><h2>' + esc(name) + '</h2></div><dl class="device-details">' +
    '<div><dt>Reader Status</dt><dd>' + (connected ? 'Connected' : 'Offline') + '</dd></div>' +
    '<div><dt>Last Synced</dt><dd>' + (contact ? '<time datetime="' + esc(contact) + '">' + esc(time(contact)) + '</time>' : '—') +
    '</dd></div></dl></article>';
}

export function stockPage(section,data,ops,selected,preview) {
  if (!ops) return '';
  if (section === 'devices') return devicesPage(ops.device);
  if (section === 'reports') return reportsPage();
  const inbound = section === 'inbound';
  const items = ops.tasks.filter(item => item.type === (inbound ? 'receipt' : 'count') && item.status !== 'Cancelled');
  const active = items.find(item => selected === item.id) ?? items[0];
  const open = !inbound && ['admin','operator'].includes(data.user.role) ? form('count','<label>Location<select name="location">' +
    ops.locations.map(location => option(location)).join('') + '</select></label>' + button('Open count')) : '';
  return '<div class="workspace-inventory"><section>' + open +
    (inbound && data.user.role === 'admin' ? receiptSetup(preview) : '') +
    (items.length ? '<ul class="dashboard-records">' + items.map(item =>
    '<li><button type="button" class="dashboard-record" data-stock-open="' + esc(item.id) + '" aria-pressed="' + (item === active) +
    '"><span><strong>' + esc(inbound ? item.id : item.reference) + '</strong><small>' + esc(item.status) + '</small></span></button></li>').join('') +
    '</ul>' : '<p>' + (inbound ? 'No receipts yet.' : 'No counts yet.') + '</p>') + '</section>' + (active ? stockDetail(active,data.user.role) : '') + '</div>';
}
