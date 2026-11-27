import {SAMPLE, EXTRA_EPC, normalizeEpc, validEpc, parseManifest, compareOutbound, scanDelta, canContinue, canClose, isCurrentManifestRun,
  roles, permits, allocationTotal, dashboardSnapshot, evidenceCsv, specEvidenceCsv, evidenceSummary,
  parsePlan, planCoverage, closePlanErrors, lockPallet, lockTo, pendingPallet, otherPallet, inManifest, manifestCsv, missingSku, unexported,
  displaySource, matchesQuery, skuBreakdown, statusLabel, manifestFor, outboundManifestConflict, receiptProducts, demoSku, palletCartonCount, describeTag, actionLabel, cartonLabel, cartonSku, receiptSizes, matchPalletType, matchesPalletIdentifier, defaultInventoryOptions, skuProduct, signOutIcon} from './model.mjs';
import qrcode from './qrcode-generator.mjs';
import {workspaceClient} from './workspace-client.mjs';

const root = document.querySelector('#app');
const who = document.querySelector('#who');
const notice = document.querySelector('#notice');
const bridge = window.KeypharmAndroid;
const connected = workspaceClient(bridge);
const connectionPanel = document.querySelector('#workspace-connection');
const headerActions = document.querySelector('#workspace-header-actions');
const syncIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11a9 9 0 0 1 15.5-5.5L21 8m0-5v5h-5m5 5a9 9 0 0 1-15.5 5.5L3 16m0 5v-5h5"/></svg>';
const workflowDialog = document.querySelector('#workflow-confirmation');
document.querySelector('#workflow-dismiss').addEventListener('click',() => workflowDialog.close());
function confirmWorkflow(title, detail, tagged = []) {
  if (!connected || workflowDialog.open) return;
  workflowDialog.querySelector('h2').textContent = title;
  workflowDialog.querySelector('p').textContent = detail;
  workflowDialog.querySelector('#workflow-tags').innerHTML = taggedList(tagged);
  workflowDialog.showModal();
}
const liveSample = bridge?.liveSampleManifest?.() ?? '';
const liveSampleName = 'KP-LIVE-SORTED-01.csv';
const key = connected ? 'keypharm-connected-records-v1' : 'keypharm-poc-v1';
const metadata = {
  testId:'Session ID', location:'Location', level:'Storage level', product:'Product mix', palletType:'Pallet type',
  label:'Label type and size', placement:'Label position and orientation', wrapping:'Wrapping',
  shielding:'Shielding', method:'Scan method', planned:'Planned test', notes:'Setup notes'
};
const defaults = {
  testId:'KP-TEST-01', location:'Demo staging area', level:'Ground', product:'Mixed cartons', palletType:'Mixed',
  label:'Paper UHF / 90 × 30 mm', placement:'Long side, upper right', wrapping:'Unwrapped',
  shielding:'Not tested', method:'Walk around the pallet', planned:'Verify a mixed pallet', notes:''
};
const now = () => new Date().toISOString();
// The person holding the device signs every record (operator, verifier, sign-off); roles stay local and unauthenticated.
const actor = () => {
  if (connected) {
    if (!connected.auth) throw new Error('Sign in to record a result.');
    return connected.auth.user.name;
  }
  if (!store.person) {
    document.querySelector('#who-menu')?.setAttribute('open','');
    throw new Error('Enter your name in the menu at the top right before recording anything.');
  }
  return store.person;
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const time = value => value ? new Date(value).toLocaleString() : '—';
const id = () => crypto.randomUUID();
const button = (action, label, options = '') => '<button type="button" data-action="' + action + '" ' + options + '>' + label + '</button>';
const field = (name,label,value = '',attributes = '') => '<label>' + escape(label) + '<input name="' + name +
  '" value="' + escape(value) + '" ' + attributes + '></label>';
const counts = (r,finished) => '<div class="counts">' + [
  ['Expected',r.expected],['Matched',r.matched.length],[finished ? 'Missing' : 'Waiting',r.missing.length],['Extra',r.extra.length]
].map(([name,n]) => '<div><strong>' + n + '</strong><span>' + name + '</span></div>').join('') + '</div>';
// FR-04: name the cartons without a SKU before anyone scans; a blank SKU is allowed, not hidden.
const skuNote = m => {
  const gaps = missingSku(m);
  return gaps.length ? '<p class="status sku-gap">' + gaps.length + (gaps.length === 1 ? ' carton has' : ' cartons have') +
    ' no SKU: ' + escape(gaps.slice(0,5).join(', ')) + (gaps.length > 5 ? ', …' : '') + '</p>' : '';
};

let store = {sessions:[],people:[]}, storageError = false;
try {
  const saved = localStorage.getItem(key);
  if (saved) {
    store = JSON.parse(saved);
    if (!Array.isArray(store.sessions)) throw new Error('Invalid local records');
    store.people ??= [];
  }
} catch {
  storageError = true;
}
let role = connected?.auth?.user.role ?? 'operator';
const compactOperator = () => connected && role === 'operator';
const handheldRoles = {operator:roles.operator,admin:roles.admin,supervisor:roles.supervisor};
const canCreate = () => connected ? role === 'admin' : permits(role,'create');
let refreshConnected = () => {};
const resetDialog = document.createElement('dialog');
resetDialog.className = 'workflow-dialog';
resetDialog.setAttribute('aria-labelledby','reset-demo-title');
resetDialog.innerHTML = '<form method="dialog" class="stack"><h2 id="reset-demo-title">Reset data *</h2>' +
  '<p>Clear sessions, scans and test settings on the handheld and dashboard. Restore starting stock.</p>' +
  field('confirm','Type RESET','','required pattern="RESET" autocomplete="off"') +
  '<div class="row"><button value="cancel" class="secondary" formnovalidate>Cancel</button>' +
  '<button value="reset">Reset data *</button></div></form>';
const palletDialog = document.createElement('dialog');
palletDialog.id = 'pallet-confirm-dialog';
palletDialog.className = 'workflow-dialog';
palletDialog.setAttribute('aria-labelledby','pallet-confirm-title');
palletDialog.innerHTML = '<form method="dialog" class="stack"><h2 id="pallet-confirm-title">Send pallet scan</h2>' +
  '<p>Send pallet tag <code id="pallet-confirm-epc"></code> to the dashboard for <strong id="pallet-confirm-ref"></strong>?</p>' +
  '<div class="row"><button value="cancel" class="secondary" formnovalidate>Cancel</button>' +
  '<button value="confirm">Confirm</button></div></form>';
if (connected) document.body.append(resetDialog,palletDialog);
let selected;
let view = 'sessions';
let stockTaskId = '', stockScenario = 'match', stockScanBusy = false, countUpload;
let receiptProduct = '', receiptSize, receiptCapture, receiptRead, receiptUpload;
// The Search tab keeps the internal name 'lookup'; the Lookup tab is 'identify'.
let registration = false;
let palletTask, palletRead, utilityScan, lookupSessionId, lookupTarget, lookupSku, lookupRead, lookupEpc, lookupTimer, identifyRead;
const identifyPower = () => connected?.controls.identifyPower ?? 10; // dBm: low by default, so the tag held close wins.
let pendingImport;
let rescanReason = '';
const defaultScenario = 'Clean match';
let scenario = defaultScenario;
let active;
let reader = {ready:false,message:'Checking reader…'};
let powerRequest, appliedSessionPower;
let dashboardUrl = '';
let dashboardQr = '';
let includeOtherRecords = false;
let dashboardResetPending = false;
let simulatedKeys = false;
let query = ''; // session search on the home screen (FR-33)
let builder; // manifest generator: {tags:{epc:{count,rssi}}, capture, palletRef, sku}
// The open screen and half-typed form fields survive re-renders and restarts (records stay in `key`).
const uiKey = connected ? 'keypharm-connected-ui-v1' : 'keypharm-poc-ui-v1';
let ui = {drafts:{}};
try { ui = {drafts:{}, ...JSON.parse(localStorage.getItem(uiKey) ?? '{}')}; } catch {}
function saveUi() {
  try {
    if (view === 'sessions' && !selected && !Object.keys(ui.drafts).length) localStorage.removeItem(uiKey);
    else localStorage.setItem(uiKey,JSON.stringify({view, selected, drafts:ui.drafts}));
  } catch {}
}
const draftable = el => el.form?.id && el.name && !['reader-power','stock-demo','epc-search'].includes(el.form.id) &&
  !['file','checkbox','radio','hidden','submit','button'].includes(el.type);
const draftPrefix = formId => (['session','scan','build'].includes(view) ? selected : '') + '|' + formId + '|';
function clearDrafts(prefix) {
  for (const k of Object.keys(ui.drafts)) if (k.startsWith(prefix)) delete ui.drafts[k];
  saveUi();
}

const visibleSessions = () => store.sessions.filter(entry => !connected?.removedSessions.has(entry.id));
const session = () => visibleSessions().find(entry => entry.id === selected);
const lookupSession = () => visibleSessions().find(entry => entry.id === lookupSessionId && entry.manifest);
const latest = s => s?.runs.at(-1);
const multiPallet = s => s?.manifest?.pallets?.length > 1;
const latestCurrentRun = s => s?.runs.findLast(run => isCurrentManifestRun(s,run) &&
  (!multiPallet(s) || run.palletEpc === (pendingPallet(s)?.palletEpc ?? latest(s)?.palletEpc)));
function automaticRescanReason(run) {
  const missing = run?.result?.missing?.length;
  const extra = run?.result?.extra?.length;
  if (missing && extra) return 'Missing cartons and extra EPCs detected';
  if (missing) return 'Missing cartons';
  if (extra) return 'Extra EPCs detected';
  return '';
}
function feedback(message, error = false) {
  notice.textContent = message;
  notice.toggleAttribute('data-error',error);
  const native = Boolean(bridge?.showToast && message && !message.includes('\n'));
  notice.classList.toggle('native-toast-status',native);
  if (native) bridge.showToast(message);
}
function log(s, action, detail, run) {
  s.logs.push({action,detail,run,at:now(),actor:actor()});
}
function publish() {
  bridge?.publishSnapshot(JSON.stringify(dashboardSnapshot(store,includeOtherRecords)));
}
function save() {
  if (storageError) throw new Error('Local records are unavailable. Reopen the app before making changes.');
  localStorage.setItem(key,JSON.stringify(store));
  publish();
  if (connected) queueMicrotask(refreshConnected);
}
function commit(change) {
  const previous = structuredClone(store);
  try {
    change();
    save();
  } catch (error) {
    store = previous;
    throw error;
  }
}
try {
  if (!storageError) {
    for (const s of store.sessions) for (const run of s.runs.filter(r => r.state === 'Reading')) {
      run.state = 'Interrupted';
      run.endedAt = now();
      run.elapsedSeconds = Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000);
      run.result = compareSession(s,manifestFor(s,run),Object.keys(run.observations));
      s.logs.push({action:'Interrupted',detail:'App restarted during capture',run:run.id,at:run.endedAt,actor:run.operator});
    }
    for (const s of store.sessions) if (s.palletPending) {
      const pending = s.palletPending;
      const endedAt = now();
      (s.palletAttempts ??= []).push({...pending,observations:pending.observations ?? {},endedAt,result:'Interrupted'});
      delete s.palletPending;
      s.logs.push({action:'Pallet capture interrupted',detail:'App restarted during capture',run:pending.id,at:endedAt,actor:pending.actor ?? s.creator});
    }
    save();
  }
} catch { storageError = true; }

// The name in the header signs every record (see actor()); roles stay local.
function identityMenu(open) {
  const locked = active || powerRequest ? 'disabled' : '';
  const name = store.person;
  return '<details class="who" id="who-menu"' + (open ? ' open' : '') + '><summary aria-label="Role and name">' +
    '<span class="who-initial" aria-hidden="true">' + escape((name || '?').trim().charAt(0).toUpperCase()) + '</span>' +
    '<span class="who-text"><strong>' + escape(name || 'Set your name') + '</strong><small>' + escape(roles[role]) + '</small></span>' +
    '<svg class="who-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2"/></svg>' +
    '</summary><div class="who-sheet"><label>Role<select id="role" ' + locked + '>' +
    Object.entries(handheldRoles).map(([value,label]) => '<option value="' + value + '" ' + (role === value ? 'selected' : '') +
      '>' + escape(label) + '</option>').join('') + '</select></label>' +
    // Saved names are kept until the Test lead resets local data.
    '<label>Your name<input id="person" list="people" maxlength="60" autocomplete="off" placeholder="Pick or type your name" value="' +
      escape(name) + '" ' + locked + '></label><datalist id="people">' +
      store.people.map(person => '<option value="' + escape(person) + '"></option>').join('') + '</datalist></div></details>';
}
function subbar(trailing = '') {
  return '<nav class="subbar">' + button('back','<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
    '<path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="2"/></svg>Sessions',
    'class="back" ' + (active || powerRequest ? 'disabled' : '')) + trailing + '</nav>';
}
// The session moves through four steps; the screen always leads with the one step that is due now.
const STEPS = [['manifest','Cartons'],['verify','Verify'],['scan','Scan'],['close','Close']];
const STEP_ROLE = {manifest:['admin','manifest'], verify:['supervisor','verify'], scan:['operator','scan'], close:['operator','close']};
const stepOf = s => s.closedAt ? 'done' : !s.manifest ? 'manifest' : !s.verifiedBy ? 'verify' : !s.confirmedAt ? 'scan' : 'close';
function nextLabel(s) {
  const step = stepOf(s), run = latestCurrentRun(s);
  if (step === 'done') return 'Closed';
  if (step === 'manifest') return role === 'operator' ? 'Waiting for setup' : 'Load cartons';
  if (step === 'verify') return role === 'operator' ? 'Waiting for setup' : role === 'supervisor' ? 'Verify pallet' : 'Waiting for Supervisor';
  if (step === 'close') return 'Ready to close';
  if (!s.identified) return 'Scan pallet';
  return run?.state === 'Finished' && run.result.status !== 'Match' ? run.result.status + ', rescan' : 'Scan cartons';
}
function render() {
  root.hidden = Boolean(connected && !connected.auth);
  const scanner = view === 'scan' || Boolean(builder?.capture || receiptCapture || utilityScan);
  who.hidden = scanner;
  headerActions.hidden = scanner || !connected?.auth;
  connectionPanel.hidden = !connected || scanner;
  // Keep the menu open across re-renders, e.g. right after a role change.
  who.hidden = Boolean(connected);
  who.innerHTML = storageError || connected ? '' : identityMenu(document.querySelector('#who-menu')?.open);
  if (storageError) {
    root.innerHTML = '<p class="status hold">Could not open the local records. Reopen the application before scanning.</p>';
    return;
  }
  const s = session();
  if (!s && ['session','scan'].includes(view)) view = 'sessions';
  if (view === 'build' && (!s || !builder)) view = 'session';
  if (view === 'stock' && (!connected?.auth || !['operator','admin'].includes(role))) view = 'sessions';
  const screen = view === 'scan' ? scanPanel(s) : view === 'build' ? buildPanel(s) : view === 'new' ? subbar() + creation() :
    view === 'pallet-task' ? subbar() + palletTaskPanel() : view === 'lookup' ? lookupPanel() : view === 'identify' ? identifyPanel() :
    view === 'settings' ? settingsPanel() : view === 'session' ? subbar() + showSession(s) :
    view === 'stock' ? subbar(role === 'operator' ? button('register-pallet','Register a pallet','class="secondary"') : '') + palletScanRequests() + stockPanel() : history();
  root.innerHTML = screen + (!scanner && ['sessions','lookup','identify','settings'].includes(view) ? bottomTabs() : '');
  for (const el of root.querySelectorAll('form[id] [name]')) {
    const k = draftable(el) && draftPrefix(el.form.id) + el.name;
    if (k && k in ui.drafts) el.value = ui.drafts[k];
  }
  const searchDialog = root.querySelector('.lookup-popup');
  if (searchDialog) {
    searchDialog.addEventListener('cancel',event => {
      event.preventDefault();
      stopUtilityScan();
    });
    searchDialog.showModal();
  }
  saveUi();
  if (active) updateScan();
}
function goBack() {
  if (workflowDialog.open) { workflowDialog.close(); return; }
  if (resetDialog.open) { resetDialog.close('cancel'); return; }
  if (palletDialog.open) { palletDialog.close('cancel'); return; }
  if (active) { end(true); return; }
  if (builder?.capture) { buildToggle(); return; }
  if (root.querySelector('#untag-dialog[open]')) { root.querySelector('#untag-dialog').close(); return; }
  if (utilityScan) { stopUtilityScan(true); return; }
  if (stockScanBusy) return;
  if (['lookup','identify','settings','pallet-task'].includes(view)) {
    view = view === 'pallet-task' ? 'stock' : 'sessions';
    registration = false;
    palletRead = undefined;
    lookupRead = identifyRead = undefined;
    feedback('');
    render();
    return;
  }
  if (receiptCapture) { stopReceiptScan(true); return; }
  if (powerRequest || stockScanBusy) return;
  if (view === 'stock' && receiptUpload) { feedback('Retry the pending confirmation first.',true); return; }
  const menu = document.querySelector('#who-menu[open]');
  if (menu) { menu.open = false; return; }
  if (view === 'sessions' || (connected && !connected.auth)) { bridge?.closeApp?.(); return; }
  if (view === 'scan' || view === 'build') {
    builder = undefined;
    view = 'session';
  } else {
    view = 'sessions';
    selected = undefined;
    pendingImport = undefined;
  }
  feedback('');
  render();
  window.scrollTo(0,0);
}
function bottomTabs() {
  return '<nav class="bottom-tabs" aria-label="Main menu"><div>' +
    [['sessions','Home','M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z'],
      ['lookup','Search','M16 16l5 5M10.5 3.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z'],
      ['identify','Lookup','M3 3h8l10 10-8 8L3 11zM7.5 7.5h.01'],
      ['settings','Settings','M10 3h4l.6 2.4 2 .9 2.2-1.1 2.8 2.8-1.1 2.2.9 2L24 13v4l-2.6.6-.9 2 1.1 2.2-2.8 2.8-2.2-1.1-2 .9-.6 2.6h-4l-.6-2.6-2-.9-2.2 1.1-2.8-2.8 1.1-2.2-.9-2L0 17v-4l2.6-.8.9-2L2.4 8l2.8-2.8 2.2 1.1 2-.9zM12 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8z']]
      .map(([page,label,path]) => button('tab','<svg aria-hidden="true" viewBox="' + (page === 'settings' ? '-2 1 28 28' : '0 0 24 24') +
        '"><path d="' + path + '"/></svg>','data-page="' + page + '" aria-label="' + label + '" title="' + label + '"' +
        (view === page ? ' aria-current="page"' : ''))).join('') + '</div></nav>';
}
function history() {
  const sessions = visibleSessions();
  const total = sessions.reduce((sum,s) => sum + allocationTotal(s.allocation),0);
  const records = sessions.slice().reverse().map(s => '<button class="record" data-open="' + escape(s.id) + '"' +
    (matchesQuery(s,query,nextLabel(s)) ? '' : ' hidden') + '><span><strong>' + escape(s.testId) + '</strong><small>' + escape(s.manifest?.pallet ?? 'No cartons loaded') + ' / ' +
    escape(displaySource(s.source)) + '</small></span><span class="record-next" data-step="' + stepOf(s) + '" data-alert="' + /^(Hold|Incomplete|Interrupted)/.test(nextLabel(s)) +
    '">' + escape(nextLabel(s)) +
    '</span></button>').join('');
  return '<section class="home"><div class="row spread section-head"><h1>Sessions</h1>' +
    (connected?.auth && (role === 'admin' || compactOperator()) ?
      button('stock-tasks','Stock tasks','class="secondary"') : connected ? '' : '<small>' + total + ' of 500 labels used</small>') + '</div>' +
    (sessions.length > 1 ? '<input type="search" id="search" class="search" aria-label="Search sessions" maxlength="80" ' +
      'placeholder="Search sessions" value="' + escape(query) + '">' : '') +
    (records ? '<div class="group records">' + records + '</div><p class="muted" id="no-match"' +
      (sessions.some(s => matchesQuery(s,query,nextLabel(s))) ? ' hidden' : '') + '>No session matches the search.</p>' :
      '<p class="empty">No sessions yet.</p>') + '</section>' +
    (canCreate() ? '<div class="actionbar">' + button('new','New test session','class="scan-cta"') + '</div>' : '');
}
function settingsPanel() {
  return '<h1>Settings</h1>' + (bridge ? readerCard() : '') + planPanel() +
    (permits(role,'export') ? '<h2 class="section-title">Evidence</h2><section class="panel">' + exportState() + '<div class="row">' +
      button('export','Export CSV and summary','class="secondary" ' + (!store.sessions.length ? 'disabled' : '')) +
      (bridge && !connected ? button('dashboard',dashboardUrl ? 'Stop dashboard sharing' : 'Share web dashboard',
        'class="secondary" ' + (dashboardResetPending ? 'disabled' : '')) : '') +
      '</div>' + (bridge && !connected && role === 'admin' && !dashboardUrl ?
        '<label class="check"><input id="share-all" type="checkbox" checked>Include hardware and imported records</label>' : '') +
      (dashboardUrl ? '<div class="line dashboard-share"><div class="dashboard-qr" role="img" aria-label="Dashboard QR code">' +
      dashboardQr + '</div><div><p>Scan the QR code or open the private link on the same Wi-Fi network. ' +
      (includeOtherRecords ? 'All local sessions are shared.' : 'Only marked sessions (*) are shared.') + '</p><p><code>' + escape(dashboardUrl) +
      '</code></p>' + button('copy','Copy dashboard link','class="secondary"') + '</div></div>' : '') +
      (role === 'admin' ? '<div class="line">' + button('reset',connected ? 'Reset data *' : 'Reset all local data',
        'class="secondary" ' + (powerRequest ? 'disabled' : '')) + '</div>' : '') +
      (store.audit?.length ? '<details class="line"><summary>Device log (' + store.audit.length + ')</summary><ul class="log">' +
        store.audit.slice().reverse().map(e => '<li><strong>' + escape(e.action) + '</strong><br>' + escape(e.detail) +
          '<br><small>' + escape(e.actor) + ' / ' + escape(time(e.at)) + '</small></li>').join('') + '</ul></details>' : '') +
      '</section>' : '');
}
const currentStockTask = () => countUpload?.task ?? connected.stockTasks.find(task => task.id === stockTaskId) ?? connected.stockTasks[0];
function palletScanRequests() {
  return role === 'operator' && connected.palletTasks.length ? '<section class="panel stack"><h2>Pallet scan requests</h2>' +
    connected.palletTasks.map(task => button('pallet-task',escape(task.scanReference ?? task.reference),'class="secondary" data-task="' + escape(task.id) + '"')).join('') +
    '</section>' : '';
}
function stockPanel() {
  const task = currentStockTask();
  const admin = role === 'admin';
  const power = admin ? '<form id="stock-power" class="row">' +
    field('power','Stock Task Power (dBm)',stockPower(),'type="number" min="5" max="30" step="1" required') +
    '<button class="secondary">Save power</button></form>' : '';
  if (!task) return '<section class="panel stack"><h1>Stock tasks</h1>' + power + '<p>No stock tasks.</p></section>';
  const option = (value,label,selected) => '<option value="' + escape(value) + '"' + (selected ? ' selected' : '') + '>' + escape(label) + '</option>';
  const selector = '<label>Task<select id="stock-task"' + (receiptCapture || receiptUpload || countUpload || stockScanBusy ? ' disabled' : '') + '>' +
    (countUpload ? [task] : connected.stockTasks).map(item => option(item.id,item.reference ?? item.id,item.id === task.id)).join('') + '</select></label>';
  if (task.type === 'receipt') {
    const tags = taggedList(task.tagged,admin && !task.outbound);
    const untag = admin ? '<dialog id="untag-dialog" class="workflow-dialog" aria-labelledby="untag-title">' +
      '<h2 id="untag-title">Untag carton</h2><p>Return <code></code> to outstanding.</p>' +
      '<form id="untag-carton" class="stack"><input type="hidden" name="epc">' +
      field('reason','Reason','','required maxlength="240"') + '<button>Confirm untag</button>' +
      button('untag-close','Cancel','class="secondary"') + '</form></dialog>' : '';
    return '<section class="panel stack"><h1>Stock tasks</h1>' + power + selector +
      (admin ? '' : receiptPanel(task,option)) + tags + untag + '</section>';
  }
  const scenarios = [['match','Match'],['missing','Missing carton'],['unknown','Unknown EPC']];
  const run = task.runs.at(-1);
  const live = countUpload ? button('count-retry','Retry count upload','class="scan-cta" ' + (stockScanBusy ? 'disabled' : '')) :
    button('count-scan',receiptCapture?.ending ? 'Finishing…' : receiptCapture ? 'Stop count scan' : 'Start count scan',
      'class="scan-cta" ' + (!bridge?.startStockReader || !reader.ready || receiptCapture?.ending || stockScanBusy ? 'disabled' : ''));
  return '<section class="panel stack"><h1>Stock tasks</h1>' + selector + live +
    (receiptCapture || countUpload ? '' : '<form class="stack" id="stock-demo"><label>Reads *<select id="stock-scenario" name="scenario">' +
    scenarios.map(([value,label]) => option(value,label,value === stockScenario)).join('') +
    '</select></label><button class="scan-cta"' + (stockScanBusy ? ' disabled' : '') + '>Run count *</button></form>') +
    (run ? '<p class="status">' + run.found.length + ' matched · ' + (run.outstanding ?? run.missing.length) + ' missing · ' +
      (run.unexpected.length + run.unknown.length) + ' extra</p>' : '') + '</section>';
}
const stockPower = () => connected.stockPower();
function taggedList(tags = [],canUntag = false) {
  if (!tags.length) return '';
  return '<section class="tagged-cartons"><h3>Tagged cartons</h3><ul class="log">' + tags.slice().reverse().map(tag =>
    '<li><strong>' + escape(tag.sku) + '</strong> · ' + escape(cartonSku(tag) === tag.sku ? cartonLabel(tag.carton) : demoSku(cartonSku(tag))) +
    '<br><code>' + escape(tag.epc) + '</code>' + (canUntag && tag.state === 'available' ?
      '<br>' + button('untag-open','Untag carton','class="secondary" data-epc="' + escape(tag.epc) + '"') : '') + '</li>').join('') + '</ul></section>';
}
const inventoryChoices = group => (connected?.controls.inventoryOptions?.[group] ?? defaultInventoryOptions[group]).filter(option => !option.archived);
function receiptPanel(task,option) {
  const products = receiptProducts(task);
  const remaining = [...new Map(products.map(item => [item.sku,item.remaining])).values()].reduce((sum,n) => sum+n,0);
  const progress = '<p role="status">' + task.received.length + ' received · ' + remaining + ' outstanding</p>';
  if (!remaining) return progress;
  const outstanding = products.filter(item => item.remaining > 0);
  const product = outstanding.find(item => item.identifier === receiptProduct);
  const disabled = receiptCapture || receiptRead || receiptUpload ? ' disabled' : '';
  const productPicker = '<label>Product<select id="receipt-product" aria-label="Product"' + disabled + '>' +
    option('','Choose a product',!product) + outstanding.map(item =>
      option(item.identifier,item.identifier === item.sku ? item.sku : item.sku + ' · ' + item.identifier,
        item === product)).join('') + '</select></label>';
  if (!product) return progress + productPicker;
  const sizes = receiptSizes(task,product.sku,inventoryChoices('cartonSizes'));
  if (!receiptUpload && !sizes.some(size => size.code === receiptSize)) receiptSize = '';
  const details = progress + productPicker + '<label>SKU<select id="receipt-size" aria-label="SKU"' + disabled + '>' +
    option('','Choose a SKU',!receiptSize) + sizes.map(size =>
      option(size.code,demoSku(product.sku + '-' + size.code),size.code === receiptSize)).join('') + '</select></label>';
  if (!receiptSize) return details;
  if (receiptRead) return details + '<div class="receipt-read"><span><strong>Pending tag</strong>' +
    (receiptRead.epc ? '<code>' + escape(receiptRead.epc) + '</code>' : '<span>EPC *</span>') + '</span>' +
    (!receiptUpload ? button('receipt-remove','×','class="secondary receipt-remove" aria-label="Remove scanned tag"') : '') +
    '</div>' + button('receipt-confirm',stockScanBusy ? 'Saving…' : receiptUpload ? 'Retry confirmation' : 'Confirm',
      'class="scan-cta" ' + (stockScanBusy ? 'disabled' : ''));
  return details + button('receipt-epc',receiptCapture?.ending ? 'Finishing…' : receiptCapture ? 'Stop scan' : 'Scan EPC',
      'class="scan-cta" ' + (!bridge?.startStockReader || !reader.ready || receiptCapture?.ending || stockScanBusy ? 'disabled' : '')) +
    (!receiptCapture && !stockScanBusy ? button('receipt-simulate','EPC *','class="secondary"') : '');
}
function palletTaskPanel() {
  const label = utilityScan ? 'Scanning pallet…' : 'Scan pallet';
  const disabled = stockScanBusy ? ' disabled' : '';
  if (registration) {
    return '<section class="panel stack"><h1>Register a pallet</h1>' +
      '<form id="pallet-registration" class="stack">' +
      [['Material','palletMaterials'],['Size','palletSizes']].map(([label,group]) =>
        '<label>' + label + '<select name="' + label.toLowerCase() + '" required><option value="">Choose ' +
        label.toLowerCase() + '</option>' + inventoryChoices(group).map(option =>
          '<option value="' + escape(option.code) + '">' + escape(option.label) + '</option>').join('') + '</select></label>').join('') +
      (palletRead ? '<p>Scanned pallet EPC <code>' + escape(palletRead.epc) + '</code></p>' +
        button('pallet-clear','Clear tag','class="secondary"' + disabled) +
        '<button' + disabled + '>Save pallet</button>' :
        button('utility-scan',label,'class="scan-cta" ' + (!reader.ready || utilityScan || stockScanBusy ? 'disabled' : ''))) + '</form></section>';
  }
  const controls = palletRead ? '<div class="receipt-read"><span><strong>Scanned pallet tag</strong><code>' + escape(palletRead.epc) +
    '</code>' + (Number.isFinite(palletRead.rssi) ? '<small>RSSI ' + escape(palletRead.rssi) + ' dBm</small>' : '') + '</span>' +
    button('pallet-clear','×','class="secondary receipt-remove" aria-label="Clear pallet tag and rescan"' + disabled) + '</div>' +
    button('pallet-send',stockScanBusy ? 'Sending…' : 'Send Scan','class="scan-cta"' + disabled) :
    button('utility-scan',label,'class="scan-cta" ' + (!reader.ready || utilityScan || stockScanBusy ? 'disabled' : ''));
  return '<section class="panel stack"><h1>' + escape(palletTask?.scanReference ?? palletTask?.reference) + '</h1>' +
    '<p>Hold the reader close to the pallet tag.</p>' + controls + '</section>';
}
function lookupPanel() {
  const s = lookupSession();
  const sessions = visibleSessions().filter(entry => entry.manifest).reverse();
  const title = '<section class="panel stack"><h1>Search for a tag</h1>' +
    '<form id="epc-search" class="stack"><label>EPC<input name="epc" value="' + escape(lookupEpc || '') +
    '" placeholder="Enter or paste EPC" autocomplete="off" required maxlength="128"' + (utilityScan ? ' disabled' : '') +
    '></label><button type="submit" class="secondary"' + (utilityScan ? ' disabled' : '') + '>Find EPC</button></form>';
  if (lookupEpc) {
    const tag = describeTag(lookupEpc,visibleSessions(),connected?.stock,connected?.palletInventory);
    const details = '<div class="tag-result"><h2>' + escape(tag.title) + '</h2>' + lookupFields(tag) + '</div>';
    return title + details + lookupControls() +
      button('clear-epc-search','Search by session','class="secondary" ' + (utilityScan ? 'disabled' : '')) + '</section>';
  }
  const picker = '<label>Session<select id="lookup-session" aria-label="Session"' + (utilityScan || powerRequest ? ' disabled' : '') + '>' +
    '<option value="">All inventory</option>' + sessions.map(entry => '<option value="' + escape(entry.id) + '"' +
      (entry.id === s?.id ? ' selected' : '') + '>' + escape(entry.testId + ' · ' + entry.location) + '</option>').join('') + '</select></label>';
  const pallets = s ? (s.manifest.pallets?.length ? s.manifest.pallets : [s.manifest]) : [];
  const stock = connected?.stock ?? [];
  const products = new Map();
  const label = (product,sku) => product + (sku !== product ? ' / ' + demoSku(sku) : '');
  const include = (product,sku) => { if (sku) products.set(sku,label(product,sku)); };
  const cartonTags = s ? pallets.flatMap(pallet => pallet.requirements ? scanStockFor(s,pallet).filter(carton =>
    carton.physical && carton.state === 'available' && pallet.requirements.some(row =>
      [carton.sku,cartonSku(carton)].includes(skuProduct(row.sku)))) :
    pallet.cartons.map(carton => stock.find(row => row.epc === carton.epc) ?? carton)) :
    stock.filter(carton => carton.state === 'available');
  for (const carton of cartonTags) include(skuProduct(carton.sku),cartonSku(carton));
  const registered = connected?.palletInventory ?? [];
  const tags = lookupSku === '@pallet' ? (s ? pallets.flatMap(pallet => {
    if (!pallet.palletType) return [registered.find(row => row.epc === pallet.palletEpc) ??
      {epc:pallet.palletEpc,reference:pallet.pallet,location:s.location}];
    const actual = s.palletAttempts?.findLast(attempt => attempt.result === 'Identified' &&
      attempt.manifestRevision === s.manifest.revision && attempt.palletEpc === pallet.palletEpc)?.actualPalletEpc;
    return registered.filter(row => row.epc === actual || (!actual && row.status === 'On hand' &&
      matchesPalletIdentifier(pallet.palletType,row.identifier)));
  }) : registered.filter(row => row.status !== 'Dispatched')) :
    cartonTags.filter(carton => cartonSku(carton) === lookupSku);
  const items = [...new Map(tags.map(item => [item.epc,item])).values()].sort((a,b) =>
    (a.location ?? '').localeCompare(b.location ?? '',undefined,{numeric:true}) || a.epc.localeCompare(b.epc));
  if (!items.some(item => item.epc === lookupTarget)) lookupTarget = '';
  const option = (value,label,selected) => '<option value="' + escape(value) + '"' +
    (value === selected ? ' selected' : '') + '>' + escape(label) + '</option>';
  const searching = utilityScan?.kind === 'lookup';
  const productPicker = '<label>Product / SKU<select id="lookup-sku"' + (searching ? ' disabled' : '') + '>' +
    option('','Choose a product',lookupSku) + [...products].sort((a,b) => a[1].localeCompare(b[1])).map(([sku,name]) => option(sku,name,lookupSku)).join('') +
    option('@pallet','Pallet',lookupSku) + '</select></label>';
  const cartonPicker = !lookupSku ? '' : items.length ? '<label>Tag<select id="lookup-target"' +
    (searching ? ' disabled' : '') + '>' + option('','Choose a tag',lookupTarget) +
    items.map(item => option(item.epc,[item.location,lookupSku === '@pallet' ? item.reference : products.get(lookupSku),item.epc].filter(Boolean).join(' / '),lookupTarget)).join('') +
    '</select></label>' : '<p>No available tags for this selection.</p>';
  return title + picker + productPicker + cartonPicker + lookupControls() + '</section>';
}
function lookupControls() {
  return utilityScan?.kind === 'lookup' ? '<dialog class="workflow-dialog lookup-popup" aria-labelledby="lookup-title">' +
    '<h2 id="lookup-title">Searching</h2><code>' + escape(lookupTarget) + '</code>' +
    '<div class="lookup-indicator" data-signal="idle" aria-hidden="true"></div>' +
    '<p id="lookup-label" class="lookup-label" role="status">Looking for tag</p><small id="lookup-rssi" class="lookup-label muted">RSSI —</small>' +
    button('utility-scan',utilityScan.ending ? 'Finishing…' : 'Stop search','class="scan-cta" ' + (utilityScan.ending ? 'disabled' : '')) +
    '</dialog>' : button('utility-scan','Start search','class="scan-cta" ' +
      (!lookupTarget || !bridge?.startReader || !reader.ready || powerRequest ? 'disabled' : ''));
}
function lookupFields(tag) {
  return tag.rows.length ? '<dl>' + tag.rows.map(([label,value]) => '<dt>' + escape(label) + '</dt><dd>' + escape(value) + '</dd>').join('') + '</dl>' : '';
}
function identifyPanel() {
  const tag = identifyRead && describeTag(identifyRead.epc,visibleSessions(),connected?.stock,connected?.palletInventory);
  const result = !tag ? '' : '<div class="tag-result" role="status"><h2>' + escape(tag.title) + '</h2><dl>' +
    tag.rows.map(([label,value]) => '<dt>' + escape(label) + '</dt><dd>' + escape(value) + '</dd>').join('') +
    '<dt>EPC</dt><dd><code>' + escape(identifyRead.epc) + '</code></dd></dl>' +
    (Number.isFinite(identifyRead.rssi) ? '<small class="muted">RSSI ' + identifyRead.rssi.toFixed(0) + ' dBm</small>' : '') + '</div>';
  return '<section class="panel stack"><h1>Look up a tag</h1><p>Hold the reader close to one tag.</p>' + result +
    button('utility-scan',utilityScan ? 'Scanning\u2026' : tag ? 'Scan another tag' : 'Scan tag',
      'class="scan-cta" ' + (!bridge?.startStockReader || !reader.ready || utilityScan || powerRequest ? 'disabled' : '')) + '</section>';
}
function updateLookup() {
  const looking = utilityScan?.kind === 'lookup' && !utilityScan.ending;
  const sample = looking && lookupRead && Date.now() - lookupRead.at < 900 ? lookupRead.rssi : null;
  const strength = sample == null ? 0 : Math.max(0,Math.min(1,(sample + 78) / 36));
  const signal = sample == null ? 'idle' : strength >= .72 ? 'strong' : strength >= .38 ? 'medium' : 'weak';
  const indicator = root.querySelector('.lookup-indicator');
  if (indicator) {
    indicator.dataset.signal = signal;
    const label = root.querySelector('#lookup-label');
    const text = sample == null ? looking ? 'Searching…' : 'Ready to search' :
      ({strong:'Strong signal',medium:'Medium signal',weak:'Weak signal'})[signal];
    if (label.textContent !== text) label.textContent = text;
    root.querySelector('#lookup-rssi').textContent = 'RSSI ' + (sample == null ? '—' : sample.toFixed(0) + ' dBm');
  }
  return sample == null ? null : Math.round(1050 - 855 * strength);
}
function lookupPulse() {
  const delay = updateLookup();
  if (utilityScan?.kind !== 'lookup' || utilityScan.ending) return;
  if (delay != null) bridge.feedback?.('lookup');
  lookupTimer = setTimeout(lookupPulse,delay ?? 160);
}
function startUtilityScan() {
  if (utilityScan || stockScanBusy || powerRequest || !reader.ready) return;
  const kind = ['lookup','identify'].includes(view) ? view : 'pallet';
  const lookupPower = connected?.controls.lookupPower ?? (lookupEpc || !lookupSession() ? identifyPower() : null);
  if (kind === 'lookup') {
    if (!bridge?.startReader || !lookupTarget) return;
    if (lookupPower == null && !applySessionPower(lookupSession(), true)) {
      feedback('Wait for reader power before searching.',true);
      return;
    }
  } else if (!bridge?.startStockReader || (kind === 'pallet' && (role !== 'operator' || (!registration && !palletTask) || palletRead))) return;
  utilityScan = {id:id(),kind,epcs:new Map()};
  lookupRead = identifyRead = undefined;
  feedback('');
  if (kind === 'pallet') bridge.startStockReader(utilityScan.id,connected.controls.palletPower ?? 15);
  else if (kind === 'identify') bridge.startStockReader(utilityScan.id,identifyPower());
  else if (lookupPower != null && bridge.startStockReader) bridge.startStockReader(utilityScan.id,lookupPower);
  else bridge.startReader(utilityScan.id);
  render();
  if (kind === 'lookup') lookupPulse();
}
function stopUtilityScan(interrupted = false) {
  if (!utilityScan || utilityScan.ending) return;
  utilityScan.ending = true;
  clearTimeout(utilityScan.timer);
  clearTimeout(lookupTimer);
  bridge.stopReader(utilityScan.id,interrupted);
  render();
}
async function submitPalletScan(epc) {
  stockScanBusy = true;
  render();
  try {
    await connected.submitPalletScan(palletTask,epc);
    palletTask = palletRead = undefined;
    view = 'stock';
    feedback('Pallet scan sent to the dashboard.');
  } catch (error) { feedback(error.message,true); }
  finally {
    stockScanBusy = false;
    render();
    void refreshConnected();
  }
}
function startStockScan() {
  const task = currentStockTask();
  if (!task || role !== 'operator' || receiptCapture || countUpload || stockScanBusy || !reader.ready || !bridge?.startStockReader) return;
  if (task.type === 'receipt' && (receiptRead || !receiptProduct || !receiptSize)) return;
  receiptCapture = {id:id(),task,epc:'',epcs:task.type === 'count' ? new Map() : null,ending:false};
  feedback('');
  bridge.startStockReader(receiptCapture.id,stockPower());
  render();
}
function stopReceiptScan(interrupted = false) {
  if (!receiptCapture || receiptCapture.ending) return;
  receiptCapture.ending = true;
  bridge.stopReader(receiptCapture.id,interrupted);
  render();
}
async function receiveStockCarton() {
  if (stockScanBusy || role !== 'operator' || !receiptRead) return;
  const stockTask = currentStockTask();
  const product = receiptProducts(stockTask).find(row => row.identifier === receiptProduct);
  if (!receiptUpload && (!product || !receiptSize)) return;
  receiptUpload ??= {task:stockTask,change:{action:'receive-carton',identifier:receiptProduct,size:receiptSize,
    variantSku:demoSku(product.sku + '-' + receiptSize),operationId:id(),...receiptRead}};
  const {task,change} = receiptUpload;
  stockScanBusy = true;
  feedback('');
  render();
  try {
    const updated = await connected.stockAction(task,change);
    receiptUpload = receiptRead = undefined;
    receiptProduct = '';
    confirmWorkflow('Carton tagged',updated.status === 'Completed' ? 'Receipt complete.' : 'Carton added to this receipt.',updated.tagged);
  } catch (error) {
    if ([400,403,409,422].includes(error.status)) receiptUpload = undefined;
    feedback(error.message,true);
  } finally {
    stockScanBusy = false;
    render();
    void refreshConnected();
  }
}
async function untagCarton(data) {
  const task = currentStockTask();
  if (!task || stockScanBusy) return;
  stockScanBusy = true;
  feedback('');
  try {
    const updated = await connected.stockAction(task,{action:'untag',epc:data.epc,reason:data.reason});
    confirmWorkflow('Carton untagged','Carton returned to outstanding.',updated.tagged);
  } catch (error) {
    feedback(error.message,true);
  } finally {
    stockScanBusy = false;
    render();
    void refreshConnected();
  }
}
async function scanStock(change, task = currentStockTask()) {
  ({task,change} = countUpload ?? {task,change});
  if (stockScanBusy || !task || role !== 'operator') return;
  stockScanBusy = true;
  feedback('');
  render();
  try {
    if (change.scenario) bridge?.feedback?.('start');
    await connected.stockAction(task,{action:'scan',...change});
    countUpload = undefined;
    feedback('Scan saved.');
  } catch (error) {
    if (change.epcs && (!error.status || error.status >= 500)) countUpload = {task,change};
    else countUpload = undefined;
    feedback(error.message,true);
  } finally {
    stockScanBusy = false;
    render();
    void refreshConnected();
  }
}
// Section 13 recovery: say which sessions changed since their last export, so nothing is cleared unexported.
function exportState() {
  if (!store.sessions.length) return '';
  const pending = store.sessions.filter(unexported);
  return pending.length ? '<p class="status export-state" data-pending="true">' + pending.length + ' of ' + store.sessions.length +
      ' sessions not exported since their last change: ' + escape(pending.map(s => s.testId).join(', ')) + '</p>' :
    '<p class="muted export-state">Every session is exported.</p>';
}
// Planned tests for the day (FR-28 coverage): the Test lead enters them, closing the day needs a reason for every test not run.
function planPanel() {
  const plan = store.plan;
  const {tests, unplanned} = planCoverage(plan, store.sessions);
  let html = '<h2 class="section-title">PoC test plan</h2><section class="panel">';
  html += tests.length ? '<ul class="log">' + tests.map(t => '<li><strong>' + escape(t.id) + '</strong> ' + escape(t.title) +
      '<br><small>' + escape(t.status) + (plan.closure?.skipped?.[t.id] ? ' / not run: ' + escape(plan.closure.skipped[t.id]) : '') +
      '</small></li>').join('') + '</ul>' + (unplanned.length ? '<p class="muted">Not in plan: ' + escape(unplanned.join(', ')) + '</p>' : '')
    : '<p class="muted">No planned tests.</p>';
  if (plan?.closedAt) return html + '<p class="status match">PoC day closed by ' + escape(plan.closure.actor) + ' on ' +
    escape(time(plan.closedAt)) + '.</p></section>';
  if (permits(role,'manifest')) html += '<details' + (tests.length ? '' : ' open') + '><summary>Edit planned tests</summary>' +
    '<form id="plan" class="stack"><label>One test per line: Test ID, then description<textarea name="tests" rows="5" required>' +
    escape(tests.map(t => (t.id + ' ' + t.title).trim()).join('\n')) + '</textarea></label>' +
    '<button class="secondary">Save test plan</button></form></details>';
  if (tests.length && permits(role,'close')) html += '<details><summary>Close PoC day</summary><form id="close-plan" class="stack">' +
    tests.filter(t => t.status === 'Not run').map(t => field(escape('skip:' + t.id),'Why was ' + t.id + ' not run?','','maxlength="200"')).join('') +
    '<label class="check"><input type="checkbox" name="reviewed" required>Coverage reviewed and signed off</label>' +
    '<button>Close PoC day</button></form></details>';
  return html + '</section>';
}
function creation() {
  // Pre-fill the first planned test that has not run yet. Only the fields that change per test stay open.
  const next = planCoverage(store.plan, store.sessions).tests.find(t => t.status === 'Not run');
  const values = {...defaults, ...(next && {testId:next.id, planned:next.title || defaults.planned})};
  const essential = ['testId','location','level','method'];
  const input = name => name === 'location' && connected?.auth ?
    '<label>Location<select name="location" required>' + connected.outboundLocations.map(location =>
      '<option' + (location === 'Outbound staging' ? ' selected' : '') + '>' + escape(location) + '</option>').join('') +
    '</select></label>' : field(name,metadata[name],values[name],'maxlength="160" ' +
    (name === 'notes' ? '' : 'required') + (name === 'testId' ? ' list="planned-tests"' : ''));
  return '<form id="create" class="stack"><h1>New test session</h1><label>Reader source<select name="source">' +
    (bridge ? '<option value="C72 hardware">RFID handheld</option>' : '') + '<option value="Simulation">Scan *</option></select></label>' +
    '<div class="fields">' + essential.map(input).join('') + '</div>' +
    '<details><summary>More setup details</summary><div class="fields">' +
    Object.keys(metadata).filter(name => !essential.includes(name)).map(input).join('') + '</div></details>' +
    '<datalist id="planned-tests">' + (store.plan?.tests ?? []).map(t => '<option value="' + escape(t.id) + '">' +
      escape(t.title) + '</option>').join('') + '</datalist><button class="scan-cta">Create session</button></form>';
}
const sessionPower = s => connected.sessionPowerOverride(s?.id) ?? connected.controls.power?.requested ?? 30;
function needsSessionPower(s, allowClosed = false) {
  return Boolean(connected?.auth && s?.source === 'C72 hardware' && (allowClosed || (!s.closedAt && !s.dispatchedAt)));
}
function applySessionPower(s, allowClosed = false) {
  if (!needsSessionPower(s, allowClosed)) return true;
  const power = sessionPower(s);
  if (appliedSessionPower?.id === s.id && appliedSessionPower.power === power) return true;
  if (powerRequest || active || !reader.ready || !bridge?.setReaderPower) return false;
  if (reader.profile?.powerDbm === power) {
    appliedSessionPower = {id:s.id,power};
    return true;
  }
  powerRequest = {id:id(), automatic:{id:s.id,power}};
  bridge.setReaderPower(powerRequest.id,power);
  return false;
}

function showSession(s) {
  const operator = compactOperator();
  const step = stepOf(s);
  const steps = role === 'operator' ? STEPS.filter(([key]) => key === 'scan' || key === 'close') :
    STEPS.filter(([key]) => key !== 'verify' || role === 'supervisor');
  const current = steps.findIndex(([key]) => key === step);
  const progress = '<ol class="steps" aria-label="Test progress">' + steps.map(([key,label],i) => {
    const state = step === 'done' || i < current ? 'done' : i === current ? 'current' : 'todo';
    return '<li data-state="' + state + '"' + (state === 'current' ? ' aria-current="step"' : '') + '>' + label + '</li>';
  }).join('') + '</ol>';
  const runs = s.runs.length ? comparisons(s,operator) : '';
  return '<div class="title-row"><h1>' + escape(s.testId) + '</h1><p class="muted">' + escape(s.location) + ' / ' +
    (operator ? '' : escape(s.level) + ' / ') + escape(displaySource(s.source)) + '</p>' +
    (connected?.auth && s.source === 'C72 hardware' ? '<p class="muted">Recommended: ' + sessionPower(s) + ' dBm</p>' : '') + '</div>' +
    progress + (connected?.auth && s.source === 'C72 hardware' && permits(role,'reader-power') ?
      '<form id="session-power" class="panel row">' + field('power','Recommended Power (dBm)',connected.sessionPowerOverride(s.id) ?? '',
        'type="number" min="5" max="30" step="1" placeholder="' + (connected.controls.power?.requested ?? 30) + '"') +
      '<button class="secondary">Save power</button></form>' : '') + nextCard(s,step) + runs +
    (operator ? '<section class="panel details">' + sessionLog(s,true) + sessionExport() + '</section>' : detailsPanel(s,step));
}
function nextCard(s, step) {
  if (step === 'done') return '<section class="panel next" data-step="done"><h2>Session closed</h2><p>' +
    escape(s.closure.coverage) + '</p><p class="muted">Signed by ' + escape(s.closure.actor) + ' on ' + escape(time(s.closedAt)) + '.</p></section>';
  if (role === 'operator' && (step === 'manifest' || step === 'verify')) {
    return '<section class="panel next"><h2>Waiting for setup</h2><p>Sync when the session is ready to scan.</p></section>';
  }
  if (role === 'admin' && step === 'verify') {
    return '<section class="panel next"><h2>Waiting for Supervisor</h2>' +
      (connected ? '' : button('as-role','Switch to Supervisor','class="scan-cta" data-role="supervisor"')) + '</section>';
  }
  if (connected && role !== 'operator' && step === 'scan') {
    return '<section class="panel next"><h2>Ready for Operator</h2><p>Switch to Operator to scan the pallet.</p></section>';
  }
  const [needRole, needAction] = STEP_ROLE[step];
  const title = {manifest:'Load the expected cartons', verify:'Verify the pallet', close:'Review and close the test',
    scan:!s.identified ? 'Scan the pallet' : latestCurrentRun(s)?.result ? 'Rescan the cartons' : 'Scan the cartons'}[step];
  let body = step === 'verify' ? '<p><strong>' + escape(manifestSummary(s.manifest)) + '</strong></p>' + skuNote(s.manifest) : '';
  if (!permits(role,needAction)) {
    body += '<p>Role required: ' + escape(roles[needRole]) + '</p>' +
      (connected ? '' : button('as-role','Switch to ' + escape(roles[needRole]),'class="scan-cta" data-role="' + needRole + '"'));
  } else if (step === 'manifest') {
    body = manifestControls(s,null);
  } else if (step === 'verify') {
    body += '<p>Check contents, label uniqueness and placement.</p>' +
      '<form id="verify" class="stack"><label class="check"><input name="checked" type="checkbox" required>' +
      'Contents and label assignment verified</label><button class="scan-cta">Record verification</button></form>';
  } else if (step === 'scan') {
    body = lastRun(s) + button('open-scan',s.identified ? 'Open carton scanner' : 'Open pallet scanner','class="scan-cta"') +
      (s.runs.length && permits(role,'close') ? '<details class="line"><summary>Close without a clean match</summary>' + closeForm(s) + '</details>' : '');
  } else {
    body = '<p class="status match">Clean carton match confirmed.</p>' + (permits(role,'close') ? closeForm(s) : '');
  }
  return '<section class="panel next" data-step="' + step + '"><h2>' + title + '</h2>' + body + '</section>';
}
function lastRun(s) {
  const run = latest(s), r = run?.result;
  if (!run) return '';
  const status = run.state === 'Finished' ? r.status : run.state;
  return '<p class="status ' + escape(status.toLowerCase()) + '">Run ' + s.runs.length + ': ' + escape(statusLabel(status)) +
    (r ? ' / ' + r.matched.length + ' of ' + r.expected + ' matched' + (r.extra.length ? ' / ' + r.extra.length + ' unexpected' : '') : '') + '</p>';
}
function closeForm(s) {
  return '<form id="close" class="stack">' + (compactOperator() ? '' : '<p>Planned: ' + escape(s.planned) + '</p>') +
    '<label>Coverage and missing-test reason<textarea name="coverage" required maxlength="500">' +
    (s.confirmedAt ? 'Successful Run' : '') + '</textarea></label>' +
    '<label class="check"><input type="checkbox" name="reviewed" required>Results reviewed and signed off</label>' +
    '<button>Close test session</button></form>';
}
function detailsPanel(s, step) {
  const m = s.manifest;
  return '<h2 class="section-title">Details</h2><section class="panel details">' +
    '<details><summary>Test setup</summary><ul class="log">' + Object.entries(metadata).slice(2).map(([k,v]) =>
      '<li><strong>' + escape(v) + '</strong> ' + escape(s[k] || '—') + '</li>').join('') + '</ul></details>' +
    (m ? '<details' + (pendingImport ? ' open' : '') + '><summary>Expected cartons</summary>' + manifestList(m) +
      (step !== 'manifest' ? manifestControls(s,m) : '') + '</details>' : '') +
    (role === 'supervisor' && s.verifiedBy ? '<details><summary>Verification</summary><p>Verified by ' + escape(s.verifiedBy) +
      ' on ' + escape(time(s.verifiedAt)) + '.</p></details>' : '') +
    (s.source === 'C72 hardware' ? readerSettings(s) : '') + sessionLog(s) + sessionExport() + '</section>';
}
function sessionLog(s,includeRunNote = false) {
  const open = root.querySelector('#session-log');
  const logs = role === 'operator' ? s.logs.filter(entry => entry.action !== 'Physical verification') : s.logs;
  return '<details id="session-log" data-session="' + escape(s.id) + '"' +
    (open?.open && open.dataset.session === s.id ? ' open' : '') + '><summary>Session log (' + logs.length + ')</summary><ul class="log">' +
    logs.slice().reverse().map(e => '<li><strong>' + escape(actionLabel(e.action)) + '</strong><br>' + escape(e.detail) +
      '<br><small>' + escape(e.actor) + ' / ' + escape(time(e.at)) + '</small></li>').join('') + '</ul>' +
    (includeRunNote ? runNote(s) : '') + '</details>';
}
function sessionExport() {
  return permits(role,'export') && !active ? button('export-one','Export this test','class="secondary"') : '';
}
function manifestSummary(m) {
  const pallets = m.pallets?.length > 1 ? m.pallets : null;
  const summary = pallets ? pallets.length + ' pallets / ' + pallets.reduce((n,p) => n + palletCartonCount(p),0) :
    m.pallet + ' / ' + palletCartonCount(m);
  return summary + ' cartons / Revision ' + m.revision;
}
function manifestList(m) {
  if (m.matchBy === 'sku') return '<p>' + escape(manifestSummary(m)) + '</p><ul class="log">' +
    m.pallets.flatMap(pallet => pallet.requirements.map(({sku,quantity}) =>
      '<li>' + escape(pallet.pallet + ' / ' + sku + ' / ' + demoSku(sku)) + ' · ' + quantity + '</li>')).join('') + '</ul>';
  const pallets = m.pallets?.length > 1 ? m.pallets : null;
  return '<p>' + escape(manifestSummary(m)) + '</p><p class="muted">' + escape(displaySource(m.source)) + '</p>' + skuNote(m) + '<ul class="log">' +
    (pallets ? pallets.flatMap(p => p.cartons.map(c => ({...c, carton:p.pallet + ' / ' + c.carton}))) : m.cartons)
      .map(c => '<li>' + escape([c.carton, c.sku].filter(Boolean).join(' / ')) + '<br><code>' + escape(c.epc) + '</code></li>').join('') + '</ul>';
}
// Revising after a scan is allowed until a clean match is confirmed; earlier runs keep their own revision (section 8).
function manifestControls(s,m) {
  if (s.closedAt || s.confirmedAt || active || !permits(role,'manifest')) return '';
  const hardware = s.source === 'C72 hardware';
  let result = (s.runs.length ? '<p class="muted">A CSV change requires a new verification and scan.</p>' : '') +
    '<div class="row manifest-options">' +
    (connected ? button('csv','Choose a CSV','class="secondary"') +
      button('sample','Use CSV *','class="secondary" ' + (connected.samples[s.source] ? '' : 'disabled')) :
    (hardware ? (liveSample ? button('sample','Use RFID CSV *','class="secondary"') : '') :
      button('sample','Use CSV *','class="secondary"')) + button('csv','Choose CSV','class="secondary"') + button('build-open','Build from scan','class="secondary"') +
    button('template',hardware && liveSample ? 'Save RFID CSV *' : 'Save CSV template','class="secondary"')) + '</div>';
  if (!bridge) result += '<label class="line">CSV file<input id="csv-file" type="file" accept=".csv,text/csv"></label>';
  if (pendingImport) result += '<form class="line stack" id="manifest"><p>' + escape(pendingImport.name) + ' / ' +
    pendingImport.data.pallets.length + ' pallet(s) / ' + pendingImport.data.pallets.reduce((n,p) => n + p.cartons.length,0) +
    ' cartons</p>' + skuNote(pendingImport.data) + '<div class="fields">' +
    (connected ? '' : field('reserves','Reserve labels',s.allocation.reserves ?? 0,'type="number" min="0" max="500" required') +
      field('candidates','Candidate labels',s.allocation.candidates ?? 0,'type="number" min="0" max="500" required')) +
    (m ? field('reason','Revision reason','','maxlength="160" required') : '') +
    '</div><button>Save manifest</button></form>';
  return result;
}
// Reader power is device-wide: the Test lead sets it from the home screen or from a hardware session's Details.
// Manifest generator: scan one pallet's tags, keep the right ones, choose the pallet tag, then load or save the CSV.
function buildPanel(s) {
  const tags = Object.entries(builder.tags).sort((a,b) => (parseFloat(b[1].rssi) || -999) - (parseFloat(a[1].rssi) || -999));
  const hardware = s.source === 'C72 hardware', reading = Boolean(builder.capture);
  return '<nav class="subbar">' + button('build-close','<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
      '<path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="2"/></svg>' + escape(s.testId),
      'class="back" ' + (reading ? 'disabled' : '')) + '</nav>' +
    '<div class="title-row"><h1>Build manifest from scan</h1><p class="muted">Scan the tags on one pallet. The strongest tag ' +
      'is taken as the pallet tag; change it if needed.</p></div>' +
    '<section class="panel"><div class="row spread"><strong id="build-count">' + tags.length + ' tags read</strong>' +
      '<span class="reader-state" data-ready="' + (!hardware || reader.ready) + '">' + escape(hardware ? readerStatus() : 'Scan *') + '</span></div>' +
      button('build-toggle',reading ? 'Stop scan' : tags.length ? 'Scan again' : 'Start scan',
        'class="scan-cta" ' + (hardware && !reader.ready && !reading ? 'disabled' : '')) +
      (hardware ? '<p class="muted line">Or hold the handheld trigger and release to finish. Scanning again adds to the list.</p>' : '') + '</section>' +
    (tags.length && !reading ? '<form id="build-form" class="stack"><div class="fields">' +
      field('palletRef','Pallet reference',builder.palletRef ?? 'PAL-' + s.testId,'maxlength="60" required') +
      field('sku','SKU for all cartons (optional)',builder.sku ?? '','maxlength="60"') + '</div>' +
      '<fieldset class="group build-tags"><legend>Tick the tags to keep and choose the pallet tag</legend>' + tags.map(([epc,t],i) =>
        '<div class="build-tag"><label class="check"><input type="checkbox" name="keep" value="' + escape(epc) + '" checked>' +
        '<span><code>' + escape(epc) + '</code><small>' + (t.rssi != null ? escape(t.rssi) + ' dBm / ' : '') + t.count + (t.count === 1 ? ' read' : ' reads') + '</small></span></label>' +
        '<label class="pallet-pick"><input type="radio" name="palletEpc" value="' + escape(epc) + '"' + (i ? '' : ' checked') + '>Pallet</label></div>').join('') +
      '</fieldset><button class="scan-cta">Use as manifest</button>' + button('build-save','Save CSV file','class="secondary"') + '</form>' : '');
}
function builtCsv() {
  const data = new FormData(document.querySelector('#build-form'));
  const keep = data.getAll('keep').map(String), palletEpc = String(data.get('palletEpc') ?? '');
  builder.palletRef = String(data.get('palletRef') ?? '');
  builder.sku = String(data.get('sku') ?? '');
  if (palletEpc && !keep.includes(palletEpc)) throw new Error('Keep the pallet tag ticked.');
  return manifestCsv(builder.palletRef,palletEpc,keep,builder.sku);
}
function buildCollect(reads) {
  for (const read of reads ?? []) {
    const epc = normalizeEpc(read.epc);
    if (!/^[0-9A-F]{2,128}$/.test(epc) || epc.length % 2) continue;
    const tag = builder.tags[epc] ??= {count:0};
    tag.count++;
    // Keep the strongest signal seen, so the pallet tag held closest sorts first.
    if (read.rssi != null && (tag.rssi == null || parseFloat(read.rssi) > parseFloat(tag.rssi))) tag.rssi = read.rssi;
  }
  const count = document.querySelector('#build-count');
  if (count) count.textContent = Object.keys(builder.tags).length + ' tags read';
}
function buildToggle() {
  const s = session();
  if (builder.capture) {
    if (!builder.capture.ending) { builder.capture.ending = true; bridge.stopReader(builder.capture.id,false); }
    return;
  }
  const hardware = s.source === 'C72 hardware';
  if (hardware && !reader.ready) { feedback(reader.message,true); return; }
  if (hardware && (powerRequest || !applySessionPower(s))) {
    feedback(powerRequest ? 'Setting reader power. Scan again when ready.' : 'Reader power could not be confirmed.',true);
    return;
  }
  if (hardware) {
    builder.capture = {id:id()};
    bridge.startReader(builder.capture.id);
    render();
    return;
  }
  bridge?.feedback?.('start');
  // Simulation: the demo pallet and its cartons, the pallet tag strongest.
  const m = parseManifest(SAMPLE);
  buildCollect([m.palletEpc, ...m.cartons.map(c => c.epc)].map((epc,i) => ({epc, rssi:String(-38 - i * 4)})));
  render();
}
function readerStatus() {
  const profile = reader.profile;
  return profile ? profile.region + ' / ' + (profile.powerDbm ?? 'Unknown') + ' dBm' : reader.ready ? 'Ready' : 'Not ready';
}
function readerControls(closed) {
  if (closed || !bridge?.setReaderPower) return '';
  if (!permits(role,'reader-power')) return '<p class="muted">The Administrator sets reader power.</p>' +
    (connected ? '' : button('as-role','Switch to Administrator','class="secondary" data-role="admin"'));
  if (!reader.ready) return button('reconnect','Check reader','class="secondary"');
  const request = connected?.controls.power;
  const requested = request && !request.appliedAt ? request.requested : undefined;
  return (requested == null ? '' : '<p class="muted">Dashboard requested ' + escape(requested) + ' dBm. Check the reader before applying.</p>') +
    '<form id="reader-power" class="row">' + field('power','Output power (dBm)',requested ?? reader.profile?.powerDbm,
      'type="number" min="5" max="30" step="1" required ' + (powerRequest ? 'disabled' : '')) +
    '<button ' + (powerRequest ? 'disabled' : '') + '>' + (powerRequest ? 'Setting power…' : 'Set power') + '</button></form>' +
    '<p class="muted">5 to 30 dBm. Each scan records the power it used.</p>';
}
// One glanceable row (Android settings pattern: show the current value); tap to change. The old DOM is still in place
// while this string is built, so its open state carries over the re-render.
function readerCard() {
  const open = document.querySelector('#reader-card')?.open || powerRequest;
  return '<details class="panel reader-card" id="reader-card"' + (open ? ' open' : '') + '><summary><span class="reader-label">' +
    '<strong>Reader diagnostics</strong><small>' + escape(reader.message) + '</small></span><span class="reader-state" data-ready="' +
    reader.ready + '">' + escape(readerStatus()) + '</span></summary><div class="reader-body">' + readerControls(false) + '</div></details>';
}
function readerSettings(s) {
  return '<details><summary>Reader settings: ' + escape(readerStatus()) + '</summary><p>' + escape(reader.message) + '</p>' +
    readerControls(s.closedAt || Boolean(connected)) + '</details>';
}
function scanPanel(s) {
  const run = latestCurrentRun(s);
  const target = multiPallet(s) ? pendingPallet(s) : null;
  const palletStep = target ? 'Pallet ' + (s.manifest.pallets.indexOf(target) + 1) + ' of ' + s.manifest.pallets.length + ' · ' : '';
  const automaticReason = automaticRescanReason(run);
  const isHardware = s.source === 'C72 hardware';
  const ready = !isHardware || reader.ready;
  return '<section class="scan-workspace"><div class="row spread scan-nav">' +
    button('scan-details',compactOperator() ? 'Scan results' : 'Session details','class="secondary"') +
    '<span class="mode">' + palletStep + 'Step ' + (s.identified ? '2' : '1') + ' of 2</span></div>' +
    '<section class="panel scan-panel"><div class="row spread scan-title"><h1 tabindex="-1">' +
    (s.identified ? 'Scan cartons' : 'Scan pallet') + '</h1><span class="reader-state" data-ready="' + ready + '">' +
    escape(isHardware ? (ready ? 'Reader ready' : 'Reader unavailable') : 'Scan *') + '</span></div>' +
    '<div class="scan-target"><div class="scan-signal" data-reading="false" aria-hidden="true"></div><div>' +
    '<p class="provenance">' + escape((target ?? s.manifest).palletType ?? (target ?? s.manifest).pallet) + '</p>' +
    (s.identified ? '<p class="muted">Pallet verified by UHF EPC.</p>' : '<p>Scan near the pallet tag.</p>') +
    (isHardware && reader.profile?.powerDbm != null ? '<p class="muted">Reader power: ' + escape(reader.profile.powerDbm) + ' dBm</p>' : '') +
    '<p class="muted">' + (isHardware ? 'Tap Start scan, or hold the handheld trigger and release to finish.' : 'Hold the handheld trigger or the button below. Release to finish.') + '</p></div></div>' +
    (isHardware && !ready ? '<p class="status hold">' + escape(reader.message) + '</p>' +
      button('reconnect','Check reader','class="secondary"') : '') +
    '<p id="scan-clock" class="scan-clock" hidden></p><div id="scan-results" class="scan-results">' + scanSummary(s) + '</div>' +
    (!isHardware && s.identified ? '<label>Reads *<select id="scenario">' +
      [defaultScenario,'Missing one','Unexpected extra','Missing and unexpected','Interrupted'].map(item => '<option ' + (scenario === item ? 'selected' : '') +
        '>' + item + '</option>').join('') + '</select></label>' : '') +
    (s.identified && run ? '<label>Rescan reason<input id="rescan" maxlength="160" value="' + escape(automaticReason || rescanReason) +
      '"' + (automaticReason ? ' readonly></label>' : ' list="rescan-reasons" placeholder="Pick or type what changed"></label><datalist id="rescan-reasons">' +
      ['Missed carton','Label repositioned','Pallet rebuilt','Shielding adjusted','Scan method changed']
        .map(reason => '<option value="' + reason + '"></option>').join('') + '</datalist>') : '') +
    (!isHardware ? '<button type="button" id="demo-trigger" class="secondary scan-cta">Hold trigger *</button>' : '') +
    // Glove-friendly alternative to the trigger: tap once to start, tap again to stop (§6 scan screen).
    (isHardware ? '<button type="button" id="hw-toggle" class="scan-cta" ' + (!ready && !active ? 'disabled' : '') +
      '>' + (active ? 'Stop scan' : 'Start scan') + '</button>' : '') +
    (s.identified ? button('continue',target && target !== s.manifest.pallets.at(-1) ? 'Next pallet' : 'Continue','class="scan-cta" ' +
      (!active && permits(role,'confirm') && canContinue(s,run) ? '' : 'disabled')) : '') +
    '</section>' + (s.identified ? '<section class="panel"><h2>Carton status</h2><ul id="tag-list" class="tag-list">' +
      tagRows(s) + '</ul></section>' : '') + '</section>';
}
function scanStockFor(s,manifest) {
  if (!manifest.requirements) return [];
  const confirmed = new Set(Object.values(s.palletMatches ?? {}));
  const used = new Set(s.runs.filter(run => confirmed.has(run.id) && run.palletEpc !== manifest.palletEpc)
    .flatMap(run => run.result?.matched ?? []));
  return (connected?.stock ?? []).filter(carton => {
    const claimedBy = connected.verificationClaims[carton.epc];
    return !used.has(carton.epc) && (!claimedBy || claimedBy === s.id);
  });
}
function scannedTagConflict(epc,s) {
  if (!connected) return '';
  const carton = connected.stock.find(row => row.epc === epc);
  const pallet = connected.palletClaims[epc];
  const owner = connected.verificationClaims[epc];
  if (carton?.state === 'dispatched' || pallet?.status === 'Dispatched') return 'Tag already dispatched.';
  if (pallet && pallet.id !== s?.id) return 'Pallet assigned to ' + (pallet.reference || 'another session') + '.';
  if (owner && owner !== s?.id) {
    const other = visibleSessions().find(session => session.id === owner);
    return other ? 'Carton assigned to ' + other.testId + '.' : 'Carton assigned to another session or manifest.';
  }
  return '';
}
function compareSession(s,manifest,epcs) {
  const actual = manifest.palletType && s.palletAttempts?.findLast(attempt =>
    attempt.manifestRevision === manifest.revision && attempt.palletEpc === manifest.palletEpc && attempt.actualPalletEpc);
  const blocked = new Set(epcs.filter(epc => scannedTagConflict(epc,s)));
  return compareOutbound(actual ? {...manifest,actualPalletEpc:actual.actualPalletEpc} : manifest,epcs,scanStockFor(s,manifest),blocked);
}
function scanResult(s) {
  if (!s.identified) return null;
  const run = latestCurrentRun(s);
  return active ? compareSession(s,s.manifest,Object.keys(run?.observations ?? {})) :
    (run?.result ?? compareSession(s,s.manifest,[]));
}
function scanSummary(s,r = scanResult(s)) {
  const run = latestCurrentRun(s);
  const status = active ? (active.ending ? 'Finishing' : 'Reading') :
    run ? (run.state === 'Finished' ? run.result.status : run.state) : 'Ready to scan';
  return '<p role="status" class="status ' + status.toLowerCase().replaceAll(' ','-') + '">' + statusLabel(status) + '</p>' +
    (r ? counts(r,Boolean(!active && run?.result)) : '');
}
function tagRows(s,r = scanResult(s)) {
  const matched = new Set(r.matched);
  const pending = active || !latestCurrentRun(s)?.result;
  const row = (epc,title,state,label,detail = '') => '<li class="tag-row" data-tag-status="' + state + '"><div><strong>' +
    escape(title) + '</strong><code>' + escape(epc) + '</code>' + (detail ? '<small>' + escape(detail) + '</small>' : '') +
    (state === 'unexpected' ? button('copy-epc','Copy EPC','class="secondary" data-epc="' + escape(epc) + '"') : '') +
    '</div><span class="tag-badge">' + label + '</span></li>';
  const extra = epc => {
    const carton = connected?.stock.find(item => item.epc === epc);
    const other = otherPallet(s.manifest,epc);
    const title = carton ? 'Extra is ' + cartonSku(carton).toUpperCase() : other ? 'Belongs to pallet ' + other : 'Outside this pallet';
    return row(epc,title,'unexpected','Unexpected',scannedTagConflict(epc,s));
  };
  const cartonTitle = carton => {
    const sku = cartonSku(carton);
    return sku === carton.sku ? sku : carton.sku + ' · ' + sku.toUpperCase();
  };
  if (s.manifest.requirements) {
    const observed = (r.matchedCartons ?? []).map(carton => {
      const saved = carton.variant_size ? carton : connected?.stock.find(item => item.epc === carton.epc) ?? carton;
      return row(carton.epc,cartonTitle(saved),'matched','Expected');
    });
    const shortages = s.manifest.requirements.flatMap(({sku}) => {
      const missing = r.missing.filter(product => product === sku).length;
      return missing ? [row('',sku.toUpperCase(),pending ? 'waiting' : 'missing',missing + (pending ? ' to scan' : ' missing'))] : [];
    });
    return [...observed,...shortages,...r.extra.map(extra)].join('');
  }
  return r.extra.map(extra).join('') +
    s.manifest.cartons.map(c => {
      if (matched.has(c.epc)) {
        const registered = connected?.stock.find(item => item.epc === c.epc);
        return row(c.epc,registered ? cartonTitle(registered) : c.carton,'matched','Expected');
      }
      return pending ? row(c.epc,c.carton,'waiting','Waiting') : row(c.epc,c.carton,'missing','Missing');
    }).join('');
}
function resultBox(s, title, run) {
  if (!run) return '<div><h3>' + title + '</h3><p class="muted">No earlier run.</p></div>';
  const r = run.result;
  const bySku = r ? skuBreakdown(manifestFor(s,run),r) : [];
  return '<div><h3>' + title + '</h3><p>' + escape(statusLabel(run.state === 'Finished' ? r.status : run.state)) +
    (r ? ' / ' + r.matched.length + ' of ' + r.expected + ' matched' : '') +
    (run.endedAt ? ' / ' + run.elapsedSeconds + ' s' : '') + '</p>' +
    (r ? '<p>Missing: ' + r.missing.length + ' / Extra: ' + r.extra.length + '</p>' : '') +
    // AT-02: a mixed pallet reads per SKU; the EPC stays the carton identity.
    (bySku.length > 1 ? '<details class="by-sku"><summary>By SKU</summary><ul class="log">' + bySku.map(row => '<li><strong>' +
      escape(row.sku) + '</strong> ' + row.matched + ' of ' + row.expected + ' matched' + (row.missing ? ' / ' + row.missing + ' missing' : '') +
      '</li>').join('') + '</ul></details>' : '') +
    '<details><summary>EPC evidence</summary>' +
    (r ? issueList('Missing',r.missing,s) + issueList('Unexpected',r.extra,s) : '') +
    s.logs.filter(l => l.run === run.id && l.action === 'Run note').map(l => '<p><strong>Note</strong> ' + escape(l.detail) + '</p>').join('') +
    '<p>Observed</p><ul class="log">' + Object.entries(run.observations).map(([epc,o]) => '<li><code>' +
      escape(epc) + '</code><br><small>' + o.count + ' reads / ' + escape(time(o.first)) +
      (o.rssi ? ' / RSSI ' + escape(o.rssi) : '') + '</small></li>').join('') + '</ul></details></div>';
}
function issueList(label, epcs, s) {
  if (!epcs.length) return '<p>' + label + ': none</p>';
  return '<p>' + label + '</p><ul class="log">' + epcs.map(epc => {
    // EPC is the carton identity, so any revision can name it.
    const c = [s.manifest, ...(s.manifestRevisions ?? [])].flatMap(m => m.pallets?.flatMap(pallet => pallet.cartons) ?? m.cartons).find(item => item.epc === epc);
    return '<li><code>' + escape(epc) + '</code>' + (c ? '<br>' + escape([c.carton, c.sku].filter(Boolean).join(' / ')) : '') + '</li>';
  }).join('') + '</ul>';
}
function comparisons(s,compact = false) {
  const run = latest(s);
  const samePallet = multiPallet(s) ? s.runs.filter(candidate =>
    candidate.palletEpc === run.palletEpc && candidate.manifestRevision === run.manifestRevision) : s.runs;
  const first = samePallet[0];
  const previous = samePallet.at(-2);
  const earlier = multiPallet(s) ? s.runs.filter(candidate => candidate !== previous && candidate !== run) : s.runs.slice(0,-2);
  const delta = previous?.result && run?.result ? scanDelta(previous.result,run.result) : null;
  const firstText = first.result ? first.result.percent + '% first-pass completeness' : 'First pass in progress';
  return '<section class="panel" id="scan-attempts"><div class="row spread"><h2 tabindex="-1">Scan attempts</h2><small>' + firstText + '</small></div><div class="pair">' +
    (compact ? resultBox(s,'Current run',run) + (previous ? resultBox(s,'Previous run',previous) : '') :
      resultBox(s,'Previous run',previous) + resultBox(s,'Current run',run)) + '</div>' +
    (delta ? '<details class="line"><summary>Changes from previous run</summary>' +
      issueList('Newly seen',delta.newlySeen,s) + issueList('Still missing',delta.stillMissing,s) + '</details>' : '') +
    (!compact && earlier.length ? '<details class="line"><summary>Earlier attempts</summary>' +
      earlier.map((r,i) => resultBox(s,multiPallet(s) ? manifestFor(s,r).pallet : i ? 'Rescan ' + i : 'First pass',r)).join('') + '</details>' : '') +
    (run?.result?.extra.length && !active && !s.closedAt && permits(role,'investigate') ?
      '<form id="investigate" class="line stack"><label>Unexpected EPC<select name="epc">' +
      run.result.extra.map(epc => '<option>' + escape(epc) + '</option>').join('') + '</select></label>' +
      '<label>Action<select name="outcome"><option>Investigated</option><option>Removed from zone</option><option>Neighbouring tag</option><option>Unresolved</option></select></label>' +
      field('note','Investigation note','','required maxlength="200"') + '<button class="secondary">Save investigation</button></form>' : '') +
    (compact ? '' : runNote(s)) + '</section>';
}
function runNote(s) {
  return latest(s) && !active && !s.closedAt && permits(role,'investigate') ? '<form id="run-note" class="line stack">' +
      field('note','Note on the current run','','required maxlength="300" placeholder="Label position, pallet build, shielding, environment"') +
      '<button class="secondary">Save run note</button></form>' : '';
}

function begin() {
  const s = session();
  if (active || view !== 'scan' || (connected && role !== 'operator') || !s || !permits(role,'scan') || !s.verifiedBy || !s.manifest || s.closedAt || s.confirmedAt) return;
  const hardware = s.source === 'C72 hardware';
  if (hardware && !reader.ready) { feedback(reader.message,true); return; }
  if (hardware && (powerRequest || !applySessionPower(s))) {
    feedback(powerRequest ? 'Setting reader power. Scan again when ready.' : 'Reader power could not be confirmed.',true);
    return;
  }
  const kind = s.identified ? 'cartons' : 'pallet';
  const previous = kind === 'cartons' && latestCurrentRun(s);
  const reason = previous ? automaticRescanReason(previous) || rescanReason.trim() : '';
  if (previous && !reason) { feedback('Enter a rescan reason before starting another carton scan.',true); return; }
  const startedAt = now();
  const capture = {id:id(),kind,hardware,startedAt,scenario,observations:{},ending:false};
  commit(() => {
    if (kind === 'cartons') s.runs.push({
      id:capture.id, startedAt, state:'Reading', source:s.source, operator:actor(), method:s.method,
      reason, profile:hardware ? reader.profile : {name:'Simulator',region:'Simulated'},
      manifestRevision:s.manifest.revision, palletEpc:s.manifest.palletEpc, observations:{}
    });
    else s.palletPending = {id:capture.id,startedAt,observations:capture.observations,actor:actor(),
      profile:hardware ? reader.profile : {name:'Simulator'}};
    log(s,kind === 'cartons' ? 'Carton capture started' : 'Pallet capture started',s.source,capture.id);
  });
  active = capture;
  feedback('');
  if (hardware) bridge.startReader(active.id);
  else bridge?.feedback?.('start');
  updateScan();
}
function simReads(s, capture) {
  if (capture.kind === 'pallet') return [{epc:(pendingPallet(s) ?? s.manifest).palletEpc}];
  const expected = s.manifest.requirements ? s.manifest.requirements.flatMap(({sku,quantity}) =>
    scanStockFor(s,s.manifest).filter(carton => carton.sku === sku && carton.state === 'available').slice(0,quantity).map(c => c.epc)) :
    s.manifest.cartons.map(c => c.epc);
  const missing = ['Missing one','Missing and unexpected','Interrupted'].includes(capture.scenario);
  const epcs = missing ? expected.slice(0,-1) : expected;
  if (['Unexpected extra','Missing and unexpected'].includes(capture.scenario)) {
    const neighbour = connected?.stock.find(c => !c.physical && c.state === 'available' && !expected.includes(c.epc));
    epcs.push(neighbour?.epc ?? EXTRA_EPC);
  }
  return [...epcs, ...epcs.slice(0,1)].map(epc => ({epc}));
}
function collect(reads) {
  const s = session();
  const observations = active.kind === 'cartons' ? latest(s).observations : active.observations;
  let fresh = 0;
  for (const read of reads ?? []) {
    const epc = normalizeEpc(read.epc);
    if (!/^[0-9A-F]{2,128}$/.test(epc) || epc.length % 2) {
      if (active.kind === 'cartons') active.invalid = (active.invalid ?? 0) + 1;
      continue;
    }
    const at = read.ms ? new Date(read.ms).toISOString() : now();
    if (!observations[epc]) {
      observations[epc] = {count:0,first:at};
      if (active.kind === 'cartons' || inManifest(s.manifest,epc)) fresh++;
      const conflict = scannedTagConflict(epc,s);
      if (conflict && !active.tagConflict) {
        active.tagConflict = conflict;
        feedback(conflict,true);
      }
    }
    const entry = observations[epc];
    entry.last = at;
    entry.count++;
    if (read.rssi != null) entry.rssi = read.rssi;
  }
  // One short beep/vibration per batch with a new unique EPC; repeat reads stay silent.
  if (fresh) bridge?.feedback('read');
  if (active.hardware && reads?.length && Date.now() >= (active.checkpoint ?? 0)) {
    active.checkpoint = Date.now() + 1000;
    try {
      localStorage.setItem(key,JSON.stringify(store));
    } catch {
      feedback('Could not checkpoint current reads. Review local storage after this run.',true);
    }
  }
}
function end(interrupted = false) {
  if (!active || active.ending) return;
  active.ending = true;
  if (active.hardware) {
    bridge.stopReader(active.id,interrupted);
    updateScan();
  } else {
    collect(simReads(session(),active));
    finalize(interrupted || (active.kind === 'cartons' && active.scenario === 'Interrupted'), 'Interrupted *');
  }
}
function finalize(interrupted, message) {
  const s = session(), capture = active, endedAt = now();
  if (!s || !capture) return;
  interrupted ||= Boolean(capture.invalid);
  commit(() => {
    if (capture.kind === 'pallet') {
      const seen = Object.keys(capture.observations);
      const target = multiPallet(s) ? pendingPallet(s) : null;
      const planned = target ?? s.manifest;
      const used = new Set(Object.keys(s.palletMatches ?? {}).map(slot => s.palletAttempts?.findLast(attempt =>
        attempt.manifestRevision === s.manifest.revision && attempt.palletEpc === slot)?.actualPalletEpc));
      const observations = Object.fromEntries(Object.entries(capture.observations).filter(([epc]) => !scannedTagConflict(epc,s)));
      const available = (connected?.palletInventory ?? []).map(pallet => connected.palletClaims[pallet.epc]?.id === s.id ?
        {...pallet,status:'On hand'} : pallet);
      const actual = !interrupted && planned.palletType && matchPalletType(planned,observations,available,used);
      const lock = interrupted || (!planned.palletType && scannedTagConflict(planned.palletEpc,s)) ? null : planned.palletType ?
        actual && {pallet:planned,rssi:parseFloat(observations[actual.epc].rssi),seen:1} :
        target ? lockPallet({pallets:[target]},observations[target.palletEpc] ?
          {[target.palletEpc]:observations[target.palletEpc]} : {}) : lockPallet(s.manifest,observations);
      s.identified = Boolean(lock);
      if (lock && lock.pallet.palletEpc !== s.manifest.palletEpc) {
        s.manifest = lockTo(s.manifest,lock.pallet);
      }
      (s.palletAttempts ??= []).push({
        id:capture.id, startedAt:capture.startedAt, endedAt, observations:capture.observations,
        profile:s.palletPending?.profile, actor:actor(), result:s.identified ? 'Identified' : 'Unconfirmed',
        lockedPallet:lock?.pallet.pallet, palletEpc:lock?.pallet.palletEpc, actualPalletEpc:actual?.epc, manifestRevision:s.manifest.revision
      });
      delete s.palletPending;
      log(s,lock ? 'Pallet locked' : 'Pallet not confirmed',lock ? (actual?.epc ?? lock.pallet.pallet) + ' / strongest signal ' +
        (Number.isFinite(lock.rssi) ? lock.rssi + ' dBm' : 'not reported') + ' / ' + lock.seen + ' of its tags read / ' +
        seen.length + ' EPCs in range' : seen.join(', ') || 'No valid EPC read',capture.id);
    } else {
      const run = latest(s);
      run.endedAt = endedAt;
      run.elapsedSeconds = Math.max(0,Math.round((Date.parse(endedAt) - Date.parse(run.startedAt)) / 1000));
      run.state = interrupted ? 'Interrupted' : 'Finished';
      run.result = compareSession(s,manifestFor(s,run),Object.keys(run.observations));
      run.invalidReads = capture.invalid ?? 0;
      if (interrupted) run.error = run.invalidReads ? run.invalidReads + ' invalid EPC observations' : message || 'Capture interrupted';
      log(s,interrupted ? 'Scan interrupted' : 'Scan finished',interrupted ? run.error : run.result.status,capture.id);
    }
  });
  if (interrupted) bridge?.feedback('error');
  active = undefined;
  rescanReason = '';
  if (capture.kind === 'pallet' && s.identified) scenario = defaultScenario;
  const unmatched = capture.kind === 'pallet' && !s.identified;
  feedback(capture.tagConflict || (unmatched ? 'Pallet EPC not confirmed. Scan closer to the displayed pallet and retry.' : ''),Boolean(capture.tagConflict || unmatched));
  render();
  if (capture.kind === 'pallet' && s.identified) focusScan();
}
function focusScan() {
  window.scrollTo(0,0);
  document.querySelector('.scan-title h1')?.focus({preventScroll:true});
}
function updateScan() {
  const s = session(), element = document.querySelector('#scan-results');
  if (!active || !element || !s) return;
  const elapsed = Math.max(0,Math.floor((Date.now() - Date.parse(active.startedAt)) / 1000));
  const clock = document.querySelector('#scan-clock');
  clock.hidden = false;
  clock.textContent = elapsed + ' s elapsed';
  document.querySelector('.scan-signal').dataset.reading = String(!active.ending);
  const r = scanResult(s);
  const stamp = JSON.stringify([active.ending,r?.matched.length,r?.extra.length]);
  if (element.dataset.scanState !== stamp) {
    element.dataset.scanState = stamp;
    element.innerHTML = scanSummary(s,r);
    if (r) document.querySelector('#tag-list').innerHTML = tagRows(s,r);
  }
  for (const control of root.querySelectorAll('button[data-action], #role, #person, #scenario, #rescan')) control.disabled = true;
  const toggle = root.querySelector('#hw-toggle');
  if (toggle) {
    toggle.textContent = active.ending ? 'Finishing…' : 'Stop scan';
    toggle.disabled = Boolean(active.ending);
  }
}
function checkManifestConflict(manifest,sessionId) {
  if (!connected) return;
  const conflict = outboundManifestConflict(manifest,connected.stock,store.sessions,sessionId);
  if (conflict) throw new Error(conflict);
}
function chooseManifest(text,name,demo = false) {
  const s = session();
  if (view !== 'session' || !permits(role,'manifest') || s?.closedAt || s?.confirmedAt || active) return;
  let data;
  try {
    data = parseManifest(text);
  } catch (error) {
    // Section 10 manifest import error: keep file name, time and the first errors in the session log.
    // ponytail: skipped while no name is set, because every log entry needs a signer.
    const rows = String(error.message).split('\n');
    if (s && store.person) commit(() => log(s,'Manifest import failed',name + ' / ' + rows.slice(0,3).join(' | ') + (rows.length > 3 ? ' | …' : '')));
    throw error;
  }
  checkManifestConflict(data,s.id);
  pendingImport = {data,name,demo};
  feedback('');
  render();
}

function action(fn) {
  try { fn(); } catch (error) { feedback(error?.message ?? 'Action could not be completed.',true); }
}
window.keypharmEvent = (name,data) => action(() => {
  if (name === 'back') { goBack(); return; }
  if (utilityScan?.id === data?.id && utilityScan) {
    if (name === 'started' && utilityScan.kind !== 'lookup' && !utilityScan.ending) {
      utilityScan.timer = setTimeout(() => stopUtilityScan(),850);
    }
    if (name === 'reads' || name === 'ended') {
      for (const read of data.reads ?? []) {
        const epc = normalizeEpc(read.epc);
        if (utilityScan.kind !== 'lookup' && validEpc(epc)) {
          const rssi = Number.parseFloat(read.rssi);
          const strength = Number.isFinite(rssi) ? rssi : -Infinity;
          utilityScan.epcs.set(epc,Math.max(utilityScan.epcs.get(epc) ?? -Infinity,strength));
        }
        if (utilityScan.kind === 'lookup' && epc === lookupTarget) {
          const rssi = Number.parseFloat(read.rssi);
          if (Number.isFinite(rssi)) lookupRead = {rssi,at:Date.now()};
        }
      }
      if (name === 'reads' && utilityScan.kind === 'lookup') updateLookup();
      if (name === 'ended') {
        const {kind,epcs,timer} = utilityScan;
        clearTimeout(timer);
        utilityScan = undefined;
        clearTimeout(lookupTimer);
        if (data.interrupted) feedback(data.message || 'Scan interrupted.',true);
        else if (kind !== 'lookup') {
          const [strongest] = [...epcs].sort((a,b) => b[1]-a[1]);
          const noun = kind === 'pallet' ? 'pallet tag' : 'tag';
          if (strongest && (epcs.size === 1 || Number.isFinite(strongest[1]))) {
            const read = {epc:strongest[0],rssi:strongest[1]};
            if (kind === 'pallet') {
              const conflict = scannedTagConflict(read.epc);
              if (conflict) feedback(conflict,true); else palletRead = read;
            } else identifyRead = read;
          } else feedback(strongest ? 'Signal strength unavailable. Move closer to the ' + noun + ' and retry.' : 'No ' + noun + ' read.',true);
        }
        render();
      }
    }
    return;
  }
  if (['lookup','identify','pallet-task'].includes(view) && ['press','release','cancel'].includes(name)) {
    if (name === 'press') startUtilityScan();
    else if (name === 'cancel' || view === 'lookup') stopUtilityScan(name === 'cancel');
    return;
  }
  if (receiptCapture && data?.id === receiptCapture.id) {
    if (receiptCapture.epcs) {
      if (name === 'reads' || name === 'ended') {
        for (const read of data.reads ?? []) {
          const epc = normalizeEpc(read.epc);
          if (!validEpc(epc)) continue;
          const previous = receiptCapture.epcs.get(epc);
          if (previous === undefined && receiptCapture.epcs.size >= 4000) {
            receiptCapture.overflow = true;
            stopReceiptScan(true);
            break;
          }
          receiptCapture.epcs.set(epc,(previous ?? 0) + 1);
        }
      }
      if (name === 'ended') {
        const capture = receiptCapture;
        receiptCapture = undefined;
        if (data.interrupted || capture.overflow) {
          feedback(capture.overflow ? 'Too many carton tags. Count a smaller area.' : data.message || 'Count scan interrupted.',true);
          render();
        } else void scanStock({epcs:[...capture.epcs.keys()],readCounts:Object.fromEntries(capture.epcs),
          reader:'hardware',operationId:capture.id},capture.task);
      }
      return;
    }
    if (name === 'reads' || name === 'ended') {
      receiptCapture.epc ||= (data.reads ?? []).map(read => normalizeEpc(read.epc)).find(validEpc) ?? '';
      if (name === 'reads' && receiptCapture.epc) stopReceiptScan();
    }
    if (name === 'ended') {
      const {epc} = receiptCapture;
      receiptCapture = undefined;
      const taskTags = currentStockTask()?.tagged ?? [];
      const duplicate = !data.interrupted && epc && (taskTags.find(tag => tag.epc === epc) ??
        connected.stock.find(tag => tag.epc === epc));
      if (data.interrupted) feedback(data.message || 'Scan interrupted.',true);
      else if (epc && scannedTagConflict(epc)) feedback(scannedTagConflict(epc),true);
      else if (duplicate) {
        feedback('This EPC is already tagged to ' + duplicate.sku + (taskTags.includes(duplicate) ? ' in this task.' : '.'),true);
      } else if (epc) receiptRead = {epc};
      else feedback(data.message || 'No carton tag read.',true);
      render();
    }
    return;
  }
  if (view === 'stock' && ['press','release','cancel'].includes(name)) {
    if (name === 'press') startStockScan();
    else stopReceiptScan(name === 'cancel');
    return;
  }
  if (builder?.capture && data?.id === builder.capture.id) {
    if (name === 'reads' || name === 'ended') buildCollect(data.reads);
    if (name === 'ended') {
      builder.capture = undefined;
      if (data.interrupted) { feedback(data.message || 'Scan interrupted.',true); bridge?.connectReader(); }
      render();
    }
    return;
  }
  if (view === 'build' && builder && ['press','release','cancel'].includes(name)) {
    if ((name === 'press') !== Boolean(builder.capture)) buildToggle();
    return;
  }
  if (name === 'reader') {
    const becameReady = data.ready && !reader.ready;
    reader = data;
    if (!reader.ready) appliedSessionPower = undefined;
    if (becameReady && ['session','scan'].includes(view)) applySessionPower(session());
    if (!active && !powerRequest && !receiptCapture && !utilityScan && (['scan','sessions','stock','lookup','identify','settings','pallet-task'].includes(view) || (view === 'session' && session()?.source === 'C72 hardware'))) render();
  }
  if (name === 'reader-power' && powerRequest?.id === data.id) {
    const {session:target, actor:changedBy, automatic} = powerRequest;
    powerRequest = undefined;
    reader = {...reader, ready:data.ready ?? reader.ready, profile:data.profile ?? reader.profile};
    if (automatic) {
      if (data.ok && reader.profile?.powerDbm === automatic.power) {
        appliedSessionPower = automatic;
        feedback('');
        if (session()?.id === automatic.id) applySessionPower(session());
      } else feedback(data.message || 'Reader power could not be confirmed.',true);
      render();
      if (connected?.hasPending(store.sessions)) void refreshConnected();
      return;
    }
    // A session change goes to its log; a home-screen change goes to the device log (FR-35). Every scan still records its power.
    if (data.ok && data.previousPower !== data.profile?.powerDbm) {
      const detail = data.previousPower + ' to ' + data.profile.powerDbm + ' dBm';
      commit(() => target ? log(target,'Reader power changed',detail) :
        (store.audit ??= []).push({at:now(), actor:changedBy, action:'Reader power changed', detail:detail + ' (home screen)'}));
    }
    if (data.ok && connected?.controls.power?.requested === data.profile?.powerDbm) {
      connected.updateControls({applied:data.profile.powerDbm});
      void refreshConnected();
    }
    feedback(data.message,!data.ok);
    render();
  }
  if (name === 'manifest-file') chooseManifest(data.text,data.name);
  if (name === 'dashboard') {
    if (dashboardResetPending) {
      // A previous share request can report its URL before the stop request completes.
      if (!data.url && !data.message) {
        dashboardResetPending = false;
        root.querySelector('[data-action="dashboard"]')?.removeAttribute('disabled');
      }
      return;
    }
    dashboardUrl = data.url ?? '';
    dashboardQr = '';
    if (dashboardUrl) {
      const qr = qrcode(0, 'M');
      qr.addData(dashboardUrl);
      qr.make();
      dashboardQr = qr.createSvgTag({scalable:true});
    } else {
      includeOtherRecords = false;
      publish();
    }
    feedback(data.message ?? '', Boolean(data.message));
    render();
  }
  if (name === 'error') feedback(data.message,true);
  if (name === 'press') begin();
  if (name === 'release') end();
  if (name === 'cancel' && active) end(true);
  // Settings read back from the reader as this run started (FR-08), replacing the snapshot from the last connect.
  if (name === 'started' && active?.id === data.id && data.profile) {
    reader = {...reader, profile:data.profile};
    const s = session(), capture = active.kind === 'cartons' ? latest(s) : s.palletPending;
    if (capture) commit(() => { capture.profile = data.profile; });
  }
  if (name === 'reads' && active?.id === data.id) {
    collect(data.reads);
    updateScan();
  }
  if (name === 'ended' && active?.id === data.id) {
    collect(data.reads);
    finalize(data.interrupted,data.message);
    if (data.interrupted) bridge?.connectReader();
  }
});

document.addEventListener('change', event => action(() => {
  const target = event.target;
  if (target.id === 'role' && !active) { role = target.value; pendingImport = undefined; feedback(''); render(); }
  if (target.id === 'person' && !active) {
    const name = target.value.trim();
    commit(() => {
      store.person = name;
      if (name && !store.people.includes(name)) store.people.push(name);
    });
    // No render here: change fires on blur, and re-rendering would swallow the tap that caused the blur.
    document.querySelector('.who-text strong').textContent = name || 'Set your name';
    document.querySelector('.who-initial').textContent = (name || '?').charAt(0).toUpperCase();
    feedback('');
  }
  if (target.id === 'scenario') scenario = target.value;
  if (target.id === 'stock-task') {
    stockTaskId = target.value;
    stockScenario = 'match';
    receiptProduct = '';
    receiptUpload = receiptRead = undefined;
    render();
    root.querySelector('#stock-task')?.focus();
  }
  if (target.id === 'lookup-session') {
    lookupSessionId = target.value;
    lookupSku = lookupTarget = '';
    lookupRead = undefined;
    feedback('');
    if (connected?.controls.lookupPower == null) applySessionPower(lookupSession(), true);
    render();
  }
  if (target.id === 'lookup-sku') { lookupSku = target.value; lookupTarget = ''; render(); }
  if (target.id === 'lookup-target') { lookupTarget = target.value; lookupRead = undefined; render(); }
  if (target.id === 'receipt-product') {
    receiptProduct = target.value;
    receiptSize = '';
    feedback('');
    render();
    root.querySelector('#receipt-size')?.focus();
  }
  if (target.id === 'receipt-size') { receiptSize = target.value; render(); root.querySelector('[data-action=receipt-epc]')?.focus(); }
  if (target.id === 'stock-scenario') stockScenario = target.value;
  if (target.id === 'csv-file' && target.files[0]) {
    const file = target.files[0], uploadSession = selected;
    if (file.size > 512000) throw new Error('Use a CSV smaller than 512 KB.');
    file.text().then(text => {
      if (selected === uploadSession) action(() => chooseManifest(text,file.name));
    }).catch(() => {
      if (selected === uploadSession) feedback('Could not read the CSV.',true);
    });
  }
}));
document.addEventListener('input', event => {
  if (draftable(event.target)) { ui.drafts[draftPrefix(event.target.form.id) + event.target.name] = event.target.value; saveUi(); }
  if (event.target.id === 'rescan') rescanReason = event.target.value;
  // Filter in place: a re-render would close the keyboard on every letter.
  if (event.target.id === 'search') {
    query = event.target.value;
    let shown = 0;
    for (const record of root.querySelectorAll('.record')) {
      const s = store.sessions.find(entry => entry.id === record.dataset.open);
      record.hidden = !(s && matchesQuery(s,query,nextLabel(s)));
      shown += !record.hidden;
    }
    root.querySelector('#no-match')?.toggleAttribute('hidden',shown > 0);
  }
});
document.addEventListener('click', event => action(() => {
  // Tapping anywhere outside the identity menu folds it away.
  const menu = document.querySelector('#who-menu');
  if (menu?.open && !event.target.closest('#who-menu')) menu.open = false;
  const control = event.target.closest('button');
  if (control?.id === 'hw-toggle') { if (active) end(); else begin(); return; }
  if (!control || active || powerRequest) return;
  const s = session(), command = control.dataset.action;
  if (command === 'copy-epc') {
    const epc = control.dataset.epc;
    if (bridge?.copyLink) {
      bridge.copyLink(epc);
      feedback('EPC copied.');
    } else if (navigator.clipboard) {
      void navigator.clipboard.writeText(epc).then(() => feedback('EPC copied.')).catch(() => feedback('Could not copy the EPC.',true));
    }
    return;
  }
  if (command === 'clear-epc-search') {
    lookupEpc = lookupTarget = '';
    render();
    return;
  }
  if (control.dataset.open) {
    selected = control.dataset.open;
    view = 'session';
    appliedSessionPower = undefined;
    if (needsSessionPower(session())) {
      applySessionPower(session());
      void refreshConnected();
    }
    rescanReason = '';
    scenario = defaultScenario;
  }
  if (command === 'new' && canCreate()) view = 'new';
  if (command === 'register-pallet' && view === 'stock' && role === 'operator') {
    registration = true;
    palletRead = undefined;
    view = 'pallet-task';
    render();
    return;
  }
  if (command === 'pallet-task' && connected?.auth && role === 'operator') {
    registration = false;
    palletRead = undefined;
    palletTask = connected.palletTasks.find(task => task.id === control.dataset.task);
    if (palletTask) view = 'pallet-task';
  }
  if (command === 'tab' && ['sessions','lookup','identify','settings'].includes(control.dataset.page)) {
    if (view === control.dataset.page) return;
    view = control.dataset.page;
    selected = undefined;
    lookupRead = identifyRead = undefined;
    feedback('');
    window.scrollTo(0,0);
  }
  if (view === 'pallet-task' && palletRead && !stockScanBusy && command === 'pallet-clear') {
    palletRead = undefined;
    feedback('');
    render();
    return;
  }
  if (view === 'pallet-task' && palletRead && !stockScanBusy && command === 'pallet-send') {
    palletDialog.querySelector('#pallet-confirm-epc').textContent = palletRead.epc;
    palletDialog.querySelector('#pallet-confirm-ref').textContent = palletTask?.scanReference ?? palletTask?.reference ?? '';
    palletDialog.returnValue = 'cancel';
    palletDialog.showModal();
    return;
  }
  if (command === 'utility-scan') {
    if (utilityScan) stopUtilityScan(); else startUtilityScan();
    return;
  }
  if (command === 'stock-tasks' && connected?.auth && ['operator','admin'].includes(role)) {
    view = 'stock';
    stockTaskId = '';
    stockScenario = 'match';
    receiptProduct = '';
    receiptUpload = receiptRead = undefined;
    window.scrollTo(0,0);
  }
  if (view === 'stock' && command === 'untag-close') { root.querySelector('#untag-dialog')?.close(); return; }
  if (view === 'stock' && command === 'untag-open' && role === 'admin') {
    const dialog = root.querySelector('#untag-dialog');
    dialog.querySelector('code').textContent = control.dataset.epc;
    dialog.querySelector('[name="epc"]').value = control.dataset.epc;
    dialog.showModal();
    return;
  }
  if (view === 'stock' && ['receipt-epc','count-scan'].includes(command)) {
    if (receiptCapture) stopReceiptScan(); else startStockScan();
    return;
  }
  if (view === 'stock' && command === 'count-retry') { void scanStock(); return; }
  if (view === 'stock' && command === 'receipt-simulate') {
    bridge?.feedback?.('start');
    receiptRead = {simulation:true};
    feedback('');
    render();
    return;
  }
  if (view === 'stock' && command === 'receipt-remove' && !receiptUpload) {
    receiptRead = undefined;
    feedback('');
    render();
    return;
  }
  if (view === 'stock' && command === 'receipt-confirm') { void receiveStockCarton(); return; }
  if (command === 'build-open' && s && permits(role,'manifest') && !s.closedAt && !s.confirmedAt) { builder = {tags:{}}; view = 'build'; }
  if (command === 'build-toggle' && view === 'build' && builder) { buildToggle(); return; }
  if (command === 'build-close' && !builder?.capture) { builder = undefined; view = 'session'; }
  if (command === 'build-save' && view === 'build' && builder) {
    const csv = builtCsv(), filename = 'manifest-' + s.testId.replace(/[^\w-]+/g,'_') + '.csv';
    if (bridge) bridge.saveTemplate(csv,filename); else download(filename,csv);
    return;
  }
  if (command === 'as-role' && !connected && handheldRoles[control.dataset.role]) { role = control.dataset.role; pendingImport = undefined; }
  if (command === 'back') { goBack(); return; }
  if (command === 'open-scan' && (!connected || role === 'operator') && s?.manifest && s.verifiedBy && permits(role,'scan') && !s.closedAt && !s.confirmedAt) {
    if (multiPallet(s) && pendingPallet(s)?.palletEpc !== s.manifest.palletEpc && s.identified) {
      commit(() => { s.identified = false; });
    }
    view = 'scan';
    feedback('');
    render();
    focusScan();
    return;
  }
  if (command === 'scan-details') {
    view = 'session';
    window.scrollTo(0,0);
    render();
    if (compactOperator()) {
      const results = root.querySelector('#scan-attempts h2');
      results?.scrollIntoView({block:'start'});
      results?.focus({preventScroll:true});
    }
    return;
  }
  if (command === 'sample') {
    if (connected) {
      if (connected.samples[s?.source]) chooseManifest(connected.samples[s.source],'Sample CSV',s.source === 'Simulation');
      return;
    }
    if (s?.source === 'C72 hardware') {
      if (liveSample) chooseManifest(liveSample,liveSampleName);
    } else chooseManifest(SAMPLE,'Demo sample CSV',true);
    return;
  }
  if (command === 'csv' && permits(role,'manifest')) { if (bridge) bridge.pickManifest(); else document.querySelector('#csv-file')?.click(); return; }
  if (command === 'template' && permits(role,'manifest')) {
    const hardwareSample = s?.source === 'C72 hardware' && liveSample;
    const csv = hardwareSample || SAMPLE;
    const filename = hardwareSample ? liveSampleName : 'keypharm-sample.csv';
    if (bridge) bridge.saveTemplate(csv,filename); else download(filename,csv);
    return;
  }
  if (command === 'reconnect') { bridge?.connectReader(); return; }
  if (command === 'reset' && view === 'settings' && role === 'admin' && !builder?.capture) {
    if (connected) {
      resetDialog.querySelector('form').reset();
      resetDialog.returnValue = 'cancel';
      resetDialog.showModal();
      return;
    }
    if (!window.confirm('Permanently delete all sessions, loaded manifests, scans, the PoC test plan, saved names, and form drafts on this device? ' +
      'This also stops dashboard sharing. Export evidence first if you need to keep it.')) return;
    localStorage.removeItem(uiKey);
    localStorage.removeItem(key);
    store = {sessions:[],people:[]};
    ui = {drafts:{}};
    role = 'operator';
    selected = undefined;
    builder = undefined;
    pendingImport = undefined;
    rescanReason = '';
    scenario = defaultScenario;
    simulatedKeys = false;
    dashboardUrl = '';
    dashboardQr = '';
    includeOtherRecords = false;
    document.querySelector('#reader-card')?.removeAttribute('open');
    publish();
    if (bridge?.shareDashboard) {
      dashboardResetPending = true;
      bridge.shareDashboard(false);
    }
    view = 'sessions';
    feedback('Local data reset.');
    render();
    window.scrollTo(0,0);
    root.querySelector('[data-action="new"]')?.focus({preventScroll:true});
    return;
  }
  if (command === 'dashboard' && permits(role,'export') && !dashboardResetPending) {
    if (!dashboardUrl) {
      // All records by default (hardware sessions too); the Test lead can untick to share sample sessions only.
      includeOtherRecords = document.querySelector('#share-all')?.checked !== false;
      publish();
    }
    bridge?.shareDashboard(!dashboardUrl);
    return;
  }
  if (command === 'copy' && permits(role,'export')) { bridge?.copyLink(dashboardUrl); feedback('Dashboard link copied.'); return; }
  if (command === 'export' && permits(role,'export')) { exportRecords(store); return; }
  if (command === 'export-one' && s && permits(role,'export')) { exportRecords({sessions:[s]}); return; }
  if (command === 'continue' && view === 'scan' && permits(role,'confirm') && !s.confirmedAt && canContinue(s,latestCurrentRun(s))) {
    const run = latestCurrentRun(s);
    commit(() => {
      log(s,'Clean match confirmed',s.manifest.pallet,run.id);
      if (multiPallet(s)) {
        (s.palletMatches ??= {})[s.manifest.palletEpc] = run.id;
        if (pendingPallet(s)) {
          s.identified = false;
          return;
        }
      }
      s.confirmedAt = now();
    });
    if (!s.confirmedAt) {
      rescanReason = '';
      feedback('');
      render();
      focusScan();
      return;
    }
    view = 'session';
    confirmWorkflow(multiPallet(s) ? 'All pallets matched' : 'Pallet match recorded',
      'The result is saved on this handheld. Review and close the session when ready.');
    window.scrollTo(0,0);
  }
  if (command || control.dataset.open) { feedback(''); render(); }
}));
root.addEventListener('submit', event => action(() => {
  event.preventDefault();
  if (active || powerRequest) return;
  const form = event.target, data = Object.fromEntries(new FormData(form)), s = session(), drafts = draftPrefix(form.id);
  if (form.id === 'epc-search' && !utilityScan) {
    const epc = normalizeEpc(data.epc);
    if (!validEpc(epc)) { feedback('Enter a valid hexadecimal EPC.',true); return; }
    lookupEpc = lookupTarget = epc;
    lookupRead = undefined;
    feedback('');
    render();
    return;
  }
  if (form.id === 'pallet-registration' && registration && palletRead && !stockScanBusy) {
    stockScanBusy = true;
    void connected.registerPallet({...data,epc:palletRead.epc}).then(pallet => {
      clearDrafts(drafts);
      registration = false;
      palletRead = undefined;
      view = 'stock';
      confirmWorkflow('Pallet registered',pallet.identifier + ' · ' + pallet.epc);
    }).catch(error => feedback(error.message,true)).finally(() => {
      stockScanBusy = false;
      render();
    });
    render();
    return;
  }
  if (form.id === 'stock-demo' && view === 'stock') { void scanStock({scenario:data.scenario}); return; }
  if (form.id === 'stock-power' && view === 'stock' && role === 'admin') {
    const power = Number(data.power);
    if (!Number.isInteger(power) || power < 5 || power > 30) throw new Error('Choose a power from 5 to 30 dBm.');
    connected.updateControls({stockPower:power});
    feedback('Stock task power saved.');
    void refreshConnected();
    return;
  }
  if (form.id === 'untag-carton' && view === 'stock' && role === 'admin') {
    root.querySelector('#untag-dialog').close();
    void untagCarton(data);
    return;
  }
  if (form.id === 'session-power' && connected?.auth && view === 'session' && s?.source === 'C72 hardware' && permits(role,'reader-power')) {
    const power = data.power === '' ? null : Number(data.power);
    if (power !== null && (!Number.isInteger(power) || power < 5 || power > 30)) throw new Error('Choose a power from 5 to 30 dBm.');
    connected.updateControls({sessionPowers:{[s.id]:power}});
    applySessionPower(s);
    feedback('Recommended power saved.');
    render();
    void refreshConnected();
    return;
  }
  const hardwareSession = !connected && view === 'session' && s?.source === 'C72 hardware' && !s.closedAt;
  if (form.id === 'reader-power' && (view === 'settings' || hardwareSession) &&
      reader.ready && permits(role,'reader-power') && bridge?.setReaderPower) {
    const power = Number(data.power);
    if (!Number.isInteger(power) || power < 5 || power > 30) throw new Error('Choose a power from 5 to 30 dBm.');
    powerRequest = {id:id(), session:hardwareSession ? s : null, actor:actor()};
    feedback('');
    render();
    bridge.setReaderPower(powerRequest.id,power);
    return;
  }
  if (form.id === 'build-form' && view === 'build' && builder && s && permits(role,'manifest')) {
    const csv = builtCsv();
    builder = undefined;
    view = 'session';
    chooseManifest(csv,'Built from scan ' + new Date().toLocaleString());
  }
  if (form.id === 'create' && canCreate()) {
    if (Object.keys(metadata).some(k => k !== 'notes' && !data[k]?.trim())) throw new Error('Fill in the test setup fields.');
    const record = {...data,id:id(),creator:actor(),createdAt:now(),mode:'POC',runs:[],logs:[],allocation:{}};
    commit(() => { log(record,'Session created',record.planned); store.sessions.push(record); });
    selected = record.id; view = 'session';
    appliedSessionPower = undefined;
    applySessionPower(record);
  }
  if (form.id === 'manifest' && s && !s.closedAt && !s.confirmedAt && permits(role,'manifest') && pendingImport) {
    checkManifestConflict(pendingImport.data,s.id);
    if (s.manifest && !data.reason.trim()) throw new Error('Enter a reason for the revision.');
    // Until the scan locks one pallet, every pallet and carton in the file counts toward the 500-label cap.
    const allocation = {cartons:pendingImport.data.pallets.reduce((n,p) => n + p.cartons.length,0),pallets:pendingImport.data.pallets.length,
      reserves:Number(data.reserves ?? s.allocation.reserves ?? 0),candidates:Number(data.candidates ?? s.allocation.candidates ?? 0)};
    const total = allocationTotal(allocation) + store.sessions.filter(other => other.id !== s.id).reduce((sum,other) => sum + allocationTotal(other.allocation),0);
    if (total > 500) throw new Error('POC label allocation cannot exceed 500 across sessions.');
    commit(() => {
      if (s.manifest) (s.manifestRevisions ??= []).push(s.manifest);
      s.manifest = {...pendingImport.data,revision:(s.manifest?.revision ?? 0)+1,source:pendingImport.name,
        demo:pendingImport.demo,importedAt:now()};
      s.allocation = allocation;
      s.verifiedBy = s.verifiedAt = null;
      s.identified = false;
      delete s.palletMatches;
      log(s,'Manifest saved','Revision ' + s.manifest.revision + ' / ' + s.manifest.source +
        ' / ' + total + ' cumulative labels' + (missingSku(s.manifest).length ? ' / ' + missingSku(s.manifest).length + ' cartons without SKU' : '') +
        (data.reason ? ' / ' + data.reason : ''));
    });
    pendingImport = undefined;
  }
  if (form.id === 'verify' && s?.manifest && !s.verifiedBy && !s.closedAt && data.checked && permits(role,'verify')) {
    commit(() => { s.verifiedBy = actor(); s.verifiedAt = now(); log(s,'Physical verification','Pallet contents and unique label assignment confirmed'); });
    confirmWorkflow('Verification recorded','The confirmation is saved on this handheld and will sync to the dashboard.');
  }
  if (form.id === 'investigate' && s && !s.closedAt && permits(role,'investigate') && latest(s)?.result?.extra.includes(data.epc)) {
    if (!data.note.trim()) throw new Error('Enter the investigation note.');
    commit(() => log(s,'Unexpected EPC ' + data.outcome.toLowerCase(),data.epc + ' / ' + data.note,latest(s).id));
  }
  if (form.id === 'run-note' && s && !s.closedAt && latest(s) && permits(role,'investigate')) {
    if (!data.note.trim()) throw new Error('Enter the run note.');
    commit(() => log(s,'Run note',data.note.trim(),latest(s).id));
  }
  if (form.id === 'plan' && permits(role,'manifest') && !store.plan?.closedAt) {
    const tests = parsePlan(data.tests);
    connected?.updateControls({plan:data.tests});
    commit(() => { store.plan = {tests}; });
  }
  if (form.id === 'close-plan' && permits(role,'close') && store.plan && !store.plan.closedAt) {
    const skipped = Object.fromEntries(Object.entries(data).filter(([k,v]) => k.startsWith('skip:') && v.trim())
      .map(([k,v]) => [k.slice(5), v.trim()]));
    const errors = closePlanErrors(store.plan, store.sessions, skipped);
    if (errors.length) throw new Error(errors.join('\n'));
    commit(() => { store.plan.closedAt = now(); store.plan.closure = {actor:actor(), skipped}; });
  }
  if (form.id === 'close') {
    if (!canClose(s,data,role)) throw new Error('Review the scans and enter the coverage before closing.');
    commit(() => { s.closedAt = now(); s.closure = {coverage:data.coverage.trim(),actor:actor(),reviewed:true}; log(s,'Session closed',s.closure.coverage); });
    confirmWorkflow('Test session closed','The scan evidence remains available in the session.');
  }
  clearDrafts(drafts);
  feedback(''); render();
}));
function exportRecords(records) {
  const evidence = specEvidenceCsv(records), full = evidenceCsv(records), summary = evidenceSummary(records);
  if (bridge) bridge.exportEvidence(evidence,full,summary);
  else { download('keypharm-evidence.csv',evidence); download('keypharm-records.csv',full); download('keypharm-summary.txt',summary); }
  // ponytail: marked when the share sheet opens; Android does not report a cancelled share back to the page.
  const at = now();
  commit(() => { for (const s of records.sessions) s.exportedAt = at; });
  render();
}
function download(name,text) {
  const url = URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}

// Pointer capture and key-up implement the same hold/release behavior as the physical trigger.
root.addEventListener('pointerdown',event => {
  if (event.target.id !== 'demo-trigger' || event.button !== 0) return;
  event.preventDefault();
  event.target.setPointerCapture(event.pointerId);
  action(begin);
});
root.addEventListener('pointerup',event => {
  if (event.target.id !== 'demo-trigger' || !active || active.hardware) return;
  // Keep the release gesture on the trigger before replacing it with the next scan screen.
  const capture = active;
  setTimeout(() => { if (active === capture) action(() => end()); },0);
});
root.addEventListener('pointercancel',event => { if (event.target.id === 'demo-trigger') action(() => end(true)); });
root.addEventListener('keydown',event => {
  if (event.target.id !== 'demo-trigger' || !['Enter',' '].includes(event.key)) return;
  event.preventDefault();
  if (!simulatedKeys && !event.repeat) { simulatedKeys = true; action(begin); }
});
root.addEventListener('keyup',event => {
  if (!simulatedKeys || !['Enter',' '].includes(event.key)) return;
  event.preventDefault();
  simulatedKeys = false; action(() => end());
});
window.addEventListener('blur', () => {
  if (active && !active.hardware) { simulatedKeys = false; action(() => end(true)); }
});
setInterval(updateScan,300);
for (const change of ['online','offline']) window.addEventListener(change, () => { if (!active && !powerRequest && view === 'sessions') render(); });
// Reopen where the user was; a scan or manifest build cannot resume, so those land on their session.
if (ui.selected && store.sessions.some(s => s.id === ui.selected)) {
  selected = ui.selected;
  view = ['session','scan','build'].includes(ui.view) ? 'session' : 'sessions';
} else if (ui.view === 'new') view = 'new';
render();
bridge?.connectReader();
if (connected) {
  const nativeEvent = window.keypharmEvent;
  window.keypharmEvent = (name,data) => {
    if (name === 'workspace-response') connected.receive(data);
    else nativeEvent(name,data);
  };
  connectionPanel.hidden = false;
  headerActions.innerHTML =
    '<button type="button" class="secondary" data-workspace="retry" aria-label="Sync now" title="Sync now">' + syncIcon + '</button>' +
    '<button type="button" class="secondary" data-workspace="logout" aria-label="Sign out" title="Sign out">' + signOutIcon + '</button>';
  let manualSync = false, lastSyncNotice = '', bubbleTimer;
  const showConnection = () => {
    if (!connected.auth) {
      root.hidden = true;
      who.textContent = '';
      if (!connectionPanel.querySelector('form')) {
        connectionPanel.innerHTML = '<section class="panel"><h1>Sign in</h1>' +
          '<form class="stack"><label>Username<input name="username" value="testing" autocomplete="username" required></label>' +
          '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>' +
          '<button>Sign in</button></form><p class="info-bubble" role="status"></p></section>';
      }
    } else if (!connectionPanel.querySelector('#workspace-role')) {
      connectionPanel.innerHTML = '<div class="row spread workspace-strip"><p class="info-bubble workspace-bubble" role="status"></p>' +
        '<select id="workspace-role" aria-label="Role">' + Object.entries(handheldRoles).map(([key,label]) =>
          '<option value="' + key + '">' + escape(label) + '</option>').join('') + '</select></div>';
    }
    const picker = connectionPanel.querySelector('#workspace-role');
    if (picker) picker.value = role;
    const status = connectionPanel.querySelector('[role="status"]');
    status.textContent = connected.message || (connected.auth ? connected.state : '');
    if (connected.auth) {
      status.dataset.visible ??= 'false';
      if (connected.state === 'Syncing') {
        status.dataset.visible = 'false';
        return;
      }
      const message = connected.message || (manualSync && connected.state === 'Synced' ? 'Synced' : '');
      if (message && (message !== lastSyncNotice || manualSync)) {
        lastSyncNotice = message;
        if (bridge.showToast) bridge.showToast(message);
        else {
          status.dataset.visible = 'true';
          clearTimeout(bubbleTimer);
          bubbleTimer = setTimeout(() => { status.dataset.visible = 'false'; },2600);
        }
      } else if (!message && connected.state === 'Synced') {
        status.dataset.visible = 'false';
        lastSyncNotice = '';
      }
      manualSync = false;
    }
  };
  const safe = () => !active && !builder?.capture && !utilityScan && !receiptCapture && !powerRequest && !stockScanBusy && !pendingImport && !resetDialog.open && !palletDialog.open && !root.querySelector('#untag-dialog[open]');
  const clearConnectedRecords = () => {
    localStorage.removeItem(uiKey);
    localStorage.removeItem(key);
    store = {sessions:[],people:[]};
    ui = {drafts:{}};
    view = 'sessions';
    selected = builder = pendingImport = undefined;
    query = rescanReason = '';
    scenario = defaultScenario;
    receiptProduct = '';
    receiptUpload = receiptRead = countUpload = undefined;
    registration = false;
    palletTask = palletRead = utilityScan = lookupSessionId = lookupTarget = lookupSku = lookupRead = lookupEpc = identifyRead = undefined;
    pendingRecordRender = true;
    publish();
  };
  let pendingRecordRender = false;
  const renderReceivedRecord = () => {
    const focus = document.activeElement;
    if (!pendingRecordRender || !safe() || (root.contains(focus) && focus.matches('input, textarea, select'))) return;
    pendingRecordRender = false;
    render();
  };
  const applyRecord = updated => {
    const index = store.sessions.findIndex(s => s.id === updated.id);
    if (index < 0) store.sessions.push(updated);
    else store.sessions[index] = updated;
    localStorage.setItem(key,JSON.stringify(store));
    if (['sessions','lookup','identify'].includes(view) || selected === updated.id) pendingRecordRender = true;
    renderReceivedRecord();
  };
  let controlsRevision = connected.controls.revision;
  let recommendedPower = sessionPower(session());
  let stockVersion = '', lookupVersion = '', removedVersion = [...connected.removedSessions].join();
  refreshConnected = () => connected.refresh(() => store.sessions,applyRecord,safe,() => {
    showConnection();
    const removed = [...connected.removedSessions].join();
    if (removed !== removedVersion) {
      removedVersion = removed;
      pendingRecordRender = true;
    }
    renderReceivedRecord();
    if (recommendedPower !== sessionPower(session())) {
      recommendedPower = sessionPower(session());
      if (safe() && ['session','scan'].includes(view) && needsSessionPower(session())) {
        applySessionPower(session());
        if (!document.activeElement?.matches('#session-power input')) render();
      }
    }
    if (safe() && ['lookup','identify'].includes(view) && !document.activeElement?.matches('input, select')) {
      const version = JSON.stringify([connected.stock,connected.palletInventory]);
      if (version !== lookupVersion) { lookupVersion = version; render(); }
    }
    const updatedTasks = connected.stockTasks.map(task => task.id + ':' + task.revision).concat(connected.palletTasks.map(task => task.id)).join();
    if (updatedTasks !== stockVersion && ['sessions','stock'].includes(view) && !root.querySelector('#untag-dialog[open]') && !document.activeElement?.matches('input, textarea, select')) {
      stockVersion = updatedTasks;
      render();
    }
    if (safe() && connected.auth && controlsRevision !== connected.controls.revision && !connected.hasPending(store.sessions)) {
      controlsRevision = connected.controls.revision;
      if (!store.plan?.closedAt) store.plan = {tests:connected.controls.plan};
      localStorage.setItem(key,JSON.stringify(store));
      if (['sessions','stock'].includes(view) && !document.activeElement?.matches('input, textarea, select') && !root.querySelector('#untag-dialog[open]')) render();
    }
  },clearConnectedRecords);
  resetDialog.addEventListener('close',async () => {
    if (resetDialog.returnValue !== 'reset' || role !== 'admin') return;
    try {
      const confirm = new FormData(resetDialog.querySelector('form')).get('confirm');
      await connected.reset(confirm,clearConnectedRecords);
      await refreshConnected();
      confirmWorkflow('Data reset *','Starting inventory restored.');
    } catch (error) { feedback(error.message,true); }
  });
  palletDialog.addEventListener('close',() => {
    if (palletDialog.returnValue === 'confirm' && palletRead && palletTask && !stockScanBusy) {
      void submitPalletScan(palletRead.epc);
    }
  });
  connectionPanel.addEventListener('submit',async event => {
    event.preventDefault();
    const fields = new FormData(event.target);
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      const user = await connected.signIn(fields.get('username'),fields.get('password'));
      role = user.role;
      connected.message = '';
      render();
      await refreshConnected();
    } catch (error) {
      connected.message = error.message;
      showConnection();
      button.disabled = false;
    }
  });
  headerActions.addEventListener('click',event => {
    const command = event.target.closest('button')?.dataset.workspace;
    if (command === 'retry') { manualSync = true; void refreshConnected(); }
    if (command === 'logout') {
      if (!safe() || receiptUpload || countUpload) {
        connected.message = 'Finish the current action before signing out.';
        showConnection();
        return;
      }
      try { connected.signOut(store.sessions); connected.message = ''; render(); }
      catch (error) { connected.message = error.message; }
      showConnection();
    }
  });
  connectionPanel.addEventListener('change',event => {
    if (event.target.id !== 'workspace-role') return;
    try {
      if (!safe() || receiptUpload || countUpload) throw new Error('Finish the current action before changing role.');
      const user = connected.switchTo(event.target.value,store.sessions);
      if (user && role !== user.role) {
        role = user.role;
        receiptProduct = '';
        receiptRead = undefined;
      }
      pendingImport = undefined;
      render();
      void refreshConnected();
    } catch (error) { connected.message = error.message; }
    showConnection();
  });
  showConnection();
  void refreshConnected();
  setInterval(refreshConnected,5000);
  window.addEventListener('online',refreshConnected);
}
