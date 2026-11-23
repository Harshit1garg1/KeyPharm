import {SAMPLE, EXTRA_EPC, normalizeEpc, parseManifest, compare, scanDelta, canContinue, canClose,
  roles, permits, allocationTotal, dashboardSnapshot, evidenceCsv, specEvidenceCsv, evidenceSummary} from './model.mjs';

const root = document.querySelector('#app');
const notice = document.querySelector('#notice');
const bridge = window.KeypharmAndroid;
const key = 'keypharm-poc-v1';
const names = {admin:'Demo test lead', operator:'Demo operator', supervisor:'Demo supervisor', reviewer:'Demo reviewer'};
const metadata = {
  testId:'Test ID', location:'Location', level:'Storage level', product:'Product mix', palletType:'Pallet type',
  label:'Label type and size', placement:'Label position and orientation', wrapping:'Wrapping',
  shielding:'Shielding', method:'Scan method', planned:'Planned test', notes:'Setup notes'
};
const defaults = {
  testId:'KP-TEST-01', location:'Demo staging area', level:'Ground', product:'Mixed cartons', palletType:'Mixed',
  label:'Paper UHF / 90 × 30 mm', placement:'Long side, upper right', wrapping:'Unwrapped',
  shielding:'Not tested', method:'Walk around the pallet', planned:'Verify a mixed pallet', notes:''
};
const now = () => new Date().toISOString();
const actor = () => names[role];
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const time = value => value ? new Date(value).toLocaleString() : '—';
const id = () => crypto.randomUUID();
const button = (action, label, options = '') => '<button type="button" data-action="' + action + '" ' + options + '>' + label + '</button>';
const field = (name,label,value = '',attributes = '') => '<label>' + escape(label) + '<input name="' + name +
  '" value="' + escape(value) + '" ' + attributes + '></label>';
const counts = r => '<div class="counts">' + [
  ['Expected',r.expected],['Matched',r.matched.length],['Missing',r.missing.length],['Extra',r.extra.length]
].map(([name,n]) => '<div><strong>' + n + '</strong><span>' + name + '</span></div>').join('') + '</div>';

let store = {sessions:[]}, storageError = false;
try {
  const saved = localStorage.getItem(key);
  if (saved) {
    store = JSON.parse(saved);
    if (!Array.isArray(store.sessions)) throw new Error('Invalid local records');
  }
} catch {
  storageError = true;
}
let role = 'operator';
let selected;
let view = 'sessions';
let pendingImport;
let rescanReason = '';
let scenario = 'Missing one';
let active;
let reader = {ready:false,message:'Checking reader…'};
let dashboardUrl = '';
let includeOtherRecords = false;
let simulatedKeys = false;

const session = () => store.sessions.find(entry => entry.id === selected);
const latest = s => s?.runs.at(-1);
function feedback(message, error = false) {
  notice.textContent = message;
  notice.toggleAttribute('data-error',error);
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
      run.result = compare(s.manifest,Object.keys(run.observations));
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

function roleBar() {
  return '<div class="panel row spread"><label>Local identity<select id="role" ' + (active ? 'disabled' : '') + '>' +
    Object.entries(roles).map(([value,label]) => '<option value="' + value + '" ' + (role === value ? 'selected' : '') +
      '>' + escape(label) + '</option>').join('') + '</select></label>' +
    (view === 'sessions' ? '' : button('back','Sessions','class="secondary" ' + (active ? 'disabled' : ''))) + '</div>';
}
function render() {
  if (storageError) {
    root.innerHTML = '<p class="status hold">Could not open the local records. Reopen the application before scanning.</p>';
    return;
  }
  const s = session();
  if (!s && view === 'session') view = 'sessions';
  root.innerHTML = roleBar() + (view === 'new' ? creation() : view === 'session' ? showSession(s) : history());
  if (active) updateScan();
}
function history() {
  const total = store.sessions.reduce((sum,s) => sum + allocationTotal(s.allocation),0);
  const records = store.sessions.slice().reverse().map(s => '<button class="record" data-open="' + escape(s.id) +
    '"><span>' + escape(s.testId) + '<br><small>' + escape(s.manifest?.pallet ?? 'Manifest pending') + ' / ' + escape(s.source) +
    '</small></span><span>' + (s.closedAt ? 'Closed' : 'Open') + '</span></button>').join('');
  return '<section class="panel"><div class="row spread"><h2>Sessions</h2><small>' + total + ' / 500 labels allocated</small></div>' +
    (permits(role,'create') ? button('new','New test session') : '') +
    (records || '<p class="line muted">No sessions recorded. Create a session to load a manifest and check a pallet.</p>') + '</section>' +
    (permits(role,'export') ? '<section class="panel"><h2>Evidence</h2><div class="row">' +
      button('export','Export CSV and summary','class="secondary" ' + (!store.sessions.length ? 'disabled' : '')) +
      (bridge ? button('dashboard',dashboardUrl ? 'Stop dashboard sharing' : 'Share web dashboard','class="secondary"') : '') +
      '</div>' + (bridge && role === 'admin' && !dashboardUrl ?
        '<label class="check"><input id="share-all" type="checkbox">Include hardware and imported records</label>' : '') +
      (dashboardUrl ? '<p class="line">Open this private link on the same demo network. ' +
      (includeOtherRecords ? 'All local sessions are shared.' : 'Sample simulation sessions are shared.') + '</p><p><code>' + escape(dashboardUrl) +
      '</code></p>' + button('copy','Copy dashboard link','class="secondary"') : '') + '</section>' : '');
}
function creation() {
  return '<form id="create" class="panel stack"><h2>New test session</h2><label>Reader source<select name="source">' +
    (bridge ? '<option>C72 hardware</option>' : '') + '<option>Simulation</option></select></label>' +
    '<div class="fields">' + Object.entries(metadata).map(([name,label]) =>
      field(name,label,defaults[name], 'maxlength="160" ' + (name === 'notes' ? '' : 'required'))).join('') +
    '</div><button>Create session</button></form>';
}
function showSession(s) {
  const manifest = s.manifest;
  return '<section class="panel"><div class="row spread"><h2>' + escape(s.testId) + '</h2><span class="provenance">' +
    escape(s.source) + (s.closedAt ? ' / Closed' : '') + '</span></div><p>' + escape(s.location) + ' / ' + escape(s.level) +
    '</p><details><summary>Test setup</summary><ul class="log">' + Object.entries(metadata).slice(2).map(([k,v]) =>
      '<li><strong>' + escape(v) + '</strong> ' + escape(s[k] || '—') + '</li>').join('') + '</ul></details></section>' +
    (manifest && s.verifiedBy ? scanPanel(s) : '') + (s.runs.length ? comparisons(s) : '') + closure(s) +
    showManifest(s,manifest) + (manifest ? verification(s) : '') +
    '<section class="panel"><details><summary>Session log (' + s.logs.length + ')</summary><ul class="log">' +
    s.logs.slice().reverse().map(e => '<li><strong>' + escape(e.action) + '</strong><br>' + escape(e.detail) +
      '<br><small>' + escape(e.actor) + ' / ' + escape(time(e.at)) + '</small></li>').join('') + '</ul></details></section>';
}
function showManifest(s,m) {
  let result = '<section class="panel"><h2>Expected cartons</h2>';
  if (m) result += '<p>' + escape(m.pallet) + ' / ' + m.cartons.length + ' cartons / Revision ' + m.revision +
    '</p><details><summary>Carton EPCs and SKUs</summary><p>' + escape(m.source) + '</p><ul class="log">' +
    m.cartons.map(c => '<li>' + escape(c.carton) + ' / ' + escape(c.sku) + '<br><code>' + escape(c.epc) + '</code></li>').join('') + '</ul></details>';
  if (!s.closedAt && !s.runs.length && !active && permits(role,'manifest')) {
    result += '<p class="muted">Use the provisional CSV format. One row per carton.</p><div class="row">' +
      button('sample','Use sample manifest','class="secondary"') + button('csv','Choose CSV','class="secondary"') +
      button('template','Save CSV template','class="secondary"') + '</div>';
    if (!bridge) result += '<label class="line">CSV file<input id="csv-file" type="file" accept=".csv,text/csv"></label>';
    if (pendingImport) result += '<form class="line stack" id="manifest"><p>' + escape(pendingImport.name) + ' / ' +
      pendingImport.data.cartons.length + ' cartons</p><div class="fields">' +
      field('reserves','Reserve labels',s.allocation.reserves ?? 0,'type="number" min="0" max="500" required') +
      field('candidates','Candidate labels',s.allocation.candidates ?? 0,'type="number" min="0" max="500" required') +
      (m ? field('reason','Revision reason','','maxlength="160" required') : '') +
      '</div><button>Save manifest</button></form>';
  } else if (!m) result += '<p class="muted">Select Test lead to load the manifest.</p>';
  return result + '</section>';
}
function verification(s) {
  if (s.verifiedBy) return '<section class="panel"><h2>Physical verification</h2><p>Verified by ' + escape(s.verifiedBy) +
    ' on ' + escape(time(s.verifiedAt)) + '.</p></section>';
  return '<section class="panel"><h2>Physical verification</h2><p>Check pallet contents, unique labels and label placement against the manifest.</p>' +
    (permits(role,'verify') && !s.closedAt ? '<form id="verify" class="stack"><label class="check"><input name="checked" type="checkbox" required>Contents and label assignment verified</label><button>Record verification</button></form>' :
      '<p class="muted">Select Supervisor to verify.</p>') + '</section>';
}
function scanPanel(s) {
  const run = latest(s);
  const isHardware = s.source === 'C72 hardware';
  const canScan = permits(role,'scan') && !s.closedAt && !s.confirmedAt;
  const r = active?.kind === 'cartons' ? compare(s.manifest,Object.keys(run?.observations ?? {})) : run?.result;
  const ready = !isHardware || reader.ready;
  const status = active ? (active.ending ? 'Finishing' : 'Reading') :
    run ? (run.state === 'Finished' ? run.result.status : run.state) : (s.identified ? 'Ready for carton scan' : 'Identify the pallet');
  return '<section class="panel scan-panel"><h2>' + (s.identified ? 'Carton scan' : 'Pallet identification') +
    '</h2><p>' + escape(isHardware ? reader.message : 'Simulated reader') + '</p>' +
    (isHardware && reader.profile ? '<p class="muted">' + escape(reader.profile.region) + ' / ' +
      escape(reader.profile.powerDbm ?? 'Power unavailable') + ' dBm</p>' : '') +
    (isHardware && !ready && canScan ? button('reconnect','Check reader','class="secondary"') : '') +
    '<p class="provenance">' + escape(s.manifest.pallet) + '</p><div id="scan-results"><p class="status ' +
    escape(status.toLowerCase()) + '">' + escape(status) + '</p>' + (r ? counts(r) : '') + '</div>' +
    (s.identified ? '<p class="muted">Pallet verified by UHF EPC.</p>' : '<p>Present the pallet tag before scanning cartons.</p>') +
    (canScan ? '<p>' + (isHardware ? 'Hold the trigger to scan. Release to finish.' : 'Hold the demo trigger. Release to finish.') + '</p>' : '') +
    (canScan && !isHardware && s.identified && !active ? '<label>Demo reads<select id="scenario">' +
      ['Missing one','Unexpected extra','Clean match','Interrupted'].map(item => '<option ' + (scenario === item ? 'selected' : '') +
        '>' + item + '</option>').join('') + '</select></label>' : '') +
    (canScan && s.identified && run && !active ? '<label>Rescan reason<input id="rescan" maxlength="160" value="' + escape(rescanReason) +
      '" placeholder="What changed before retrying?"></label>' : '') +
    (canScan && !isHardware ? '<button type="button" id="demo-trigger" class="secondary scan-cta" ' + (!ready ? 'disabled' : '') +
      '>Hold demo trigger</button>' : '') +
    (canScan && s.identified ? button('continue','Continue','class="scan-cta" ' +
      (!active && permits(role,'confirm') && canContinue(s,run) ? '' : 'disabled')) : '') +
    (s.confirmedAt ? '<p class="status match">Clean carton match confirmed.</p>' : '') + '</section>';
}
function resultBox(s, title, run) {
  if (!run) return '<div><h3>' + title + '</h3><p class="muted">No earlier run.</p></div>';
  const r = run.result;
  return '<div><h3>' + title + '</h3><p>' + escape(run.state === 'Finished' ? r.status : run.state) +
    (r ? ' / ' + r.matched.length + ' of ' + r.expected + ' matched' : '') +
    (run.endedAt ? ' / ' + run.elapsedSeconds + ' s' : '') + '</p>' +
    (r ? '<p>Missing: ' + r.missing.length + ' / Extra: ' + r.extra.length + '</p>' : '') +
    '<details><summary>EPC evidence</summary>' +
    (r ? issueList('Missing',r.missing,s) + issueList('Unexpected',r.extra,s) : '') +
    '<p>Observed</p><ul class="log">' + Object.entries(run.observations).map(([epc,o]) => '<li><code>' +
      escape(epc) + '</code><br><small>' + o.count + ' reads / ' + escape(time(o.first)) +
      (o.rssi ? ' / RSSI ' + escape(o.rssi) : '') + '</small></li>').join('') + '</ul></details></div>';
}
function issueList(label, epcs, s) {
  if (!epcs.length) return '<p>' + label + ': none</p>';
  return '<p>' + label + '</p><ul class="log">' + epcs.map(epc => {
    const c = s.manifest.cartons.find(item => item.epc === epc);
    return '<li><code>' + escape(epc) + '</code>' + (c ? '<br>' + escape(c.carton + ' / ' + c.sku) : '') + '</li>';
  }).join('') + '</ul>';
}
function comparisons(s) {
  const run = latest(s);
  const first = s.runs[0];
  const previous = s.runs.at(-2);
  const delta = previous?.result && run?.result ? scanDelta(previous.result,run.result) : null;
  const firstText = first.result ? first.result.percent + '% first-pass completeness' : 'First pass in progress';
  return '<section class="panel"><div class="row spread"><h2>Scan attempts</h2><small>' + firstText + '</small></div><div class="pair">' +
    resultBox(s,'Previous run',previous) + resultBox(s,'Current run',run) + '</div>' +
    (delta ? '<details class="line"><summary>Changes from previous run</summary>' +
      issueList('Newly seen',delta.newlySeen,s) + issueList('Still missing',delta.stillMissing,s) + '</details>' : '') +
    (s.runs.length > 2 ? '<details class="line"><summary>Earlier attempts</summary>' +
      s.runs.slice(0,-2).map((r,i) => resultBox(s,i ? 'Rescan ' + i : 'First pass',r)).join('') + '</details>' : '') +
    (run?.result?.extra.length && !active && !s.closedAt && permits(role,'investigate') ?
      '<form id="investigate" class="line stack"><label>Unexpected EPC<select name="epc">' +
      run.result.extra.map(epc => '<option>' + escape(epc) + '</option>').join('') + '</select></label>' +
      '<label>Action<select name="outcome"><option>Investigated</option><option>Removed from zone</option><option>Unresolved</option></select></label>' +
      field('note','Investigation note','','required maxlength="200"') + '<button class="secondary">Save investigation</button></form>' : '') + '</section>';
}
function closure(s) {
  if (s.closedAt) return '<section class="panel"><h2>Session closed</h2><p>' + escape(s.closure.coverage) +
    '</p><p class="muted">Signed by ' + escape(s.closure.actor) + ' on ' + escape(time(s.closedAt)) + '.</p></section>';
  if (active || !s.runs.length || !permits(role,'close')) return '';
  return '<section class="panel"><details><summary>Review and close session</summary><form id="close" class="stack">' +
    '<p>Review the planned test, recorded runs and missing-test reasons before closing.</p><p>Planned: ' + escape(s.planned) + '</p>' +
    '<label>Coverage and missing-test reason<textarea name="coverage" required maxlength="500"></textarea></label>' +
    '<label class="check"><input type="checkbox" name="reviewed" required>Results reviewed and signed off</label><button>Close test session</button></form></details></section>';
}

function begin() {
  const s = session();
  if (active || view !== 'session' || !s || !permits(role,'scan') || !s.verifiedBy || !s.manifest || s.closedAt || s.confirmedAt) return;
  const hardware = s.source === 'C72 hardware';
  if (hardware && !reader.ready) { feedback(reader.message,true); return; }
  const kind = s.identified ? 'cartons' : 'pallet';
  const reason = document.querySelector('#rescan')?.value.trim() ?? rescanReason;
  if (kind === 'cartons' && s.runs.length && !reason) { feedback('Enter a rescan reason before holding the trigger.',true); return; }
  const startedAt = now();
  const capture = {id:id(),kind,hardware,startedAt,scenario,observations:{},ending:false};
  commit(() => {
    if (kind === 'cartons') s.runs.push({
      id:capture.id, startedAt, state:'Reading', source:s.source, operator:actor(), method:s.method,
      reason:s.runs.length ? reason : '', profile:hardware ? reader.profile : {name:'Simulator',region:'Simulated'},
      manifestRevision:s.manifest.revision, observations:{}
    });
    else s.palletPending = {id:capture.id,startedAt,observations:capture.observations,actor:actor(),
      profile:hardware ? reader.profile : {name:'Simulator'}};
    log(s,kind === 'cartons' ? 'Carton capture started' : 'Pallet capture started',s.source,capture.id);
  });
  active = capture;
  feedback('');
  if (hardware) bridge.startReader(active.id);
  updateScan();
}
function simReads(s, capture) {
  if (capture.kind === 'pallet') return [{epc:s.manifest.palletEpc}];
  const expected = s.manifest.cartons.map(c => c.epc);
  const epcs = capture.scenario === 'Missing one' || capture.scenario === 'Interrupted' ? expected.slice(0,-1) : expected;
  if (capture.scenario === 'Unexpected extra') epcs.push(EXTRA_EPC);
  return [...epcs, ...epcs.slice(0,1)].map(epc => ({epc}));
}
function collect(reads) {
  const s = session();
  const observations = active.kind === 'cartons' ? latest(s).observations : active.observations;
  let fresh = 0;
  for (const read of reads ?? []) {
    const epc = normalizeEpc(read.epc);
    if (!/^[0-9A-F]{2,128}$/.test(epc) || epc.length % 2) {
      active.invalid = (active.invalid ?? 0) + 1;
      continue;
    }
    const at = read.ms ? new Date(read.ms).toISOString() : now();
    if (!observations[epc]) { observations[epc] = {count:0,first:at}; fresh++; }
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
    finalize(interrupted || (active.kind === 'cartons' && active.scenario === 'Interrupted'), 'Demo interruption');
  }
}
function finalize(interrupted, message) {
  const s = session(), capture = active, endedAt = now();
  if (!s || !capture) return;
  interrupted ||= Boolean(capture.invalid);
  commit(() => {
    if (capture.kind === 'pallet') {
      const seen = Object.keys(capture.observations);
      // Expected cartons can be within range during identification; unrelated EPCs make it ambiguous.
      const known = new Set(s.manifest.cartons.map(c => c.epc));
      const unknown = seen.filter(epc => epc !== s.manifest.palletEpc && !known.has(epc));
      s.identified = !interrupted && seen.includes(s.manifest.palletEpc) && !unknown.length;
      (s.palletAttempts ??= []).push({
        id:capture.id, startedAt:capture.startedAt, endedAt, observations:capture.observations,
        profile:capture.hardware ? reader.profile : {name:'Simulator'}, actor:actor(), result:s.identified ? 'Identified' : 'Unconfirmed'
      });
      delete s.palletPending;
      log(s,s.identified ? 'Pallet identified' : 'Pallet not confirmed',seen.join(', ') || 'No valid EPC read',capture.id);
    } else {
      const run = latest(s);
      run.endedAt = endedAt;
      run.elapsedSeconds = Math.max(0,Math.round((Date.parse(endedAt) - Date.parse(run.startedAt)) / 1000));
      run.state = interrupted ? 'Interrupted' : 'Finished';
      run.result = compare(s.manifest,Object.keys(run.observations));
      run.invalidReads = capture.invalid ?? 0;
      if (interrupted) run.error = run.invalidReads ? run.invalidReads + ' invalid EPC observations' : message || 'Capture interrupted';
      log(s,interrupted ? 'Scan interrupted' : 'Scan finished',interrupted ? run.error : run.result.status,capture.id);
    }
  });
  if (interrupted) bridge?.feedback('error');
  active = undefined;
  rescanReason = '';
  feedback(capture.kind === 'pallet' && !s.identified ? 'Pallet EPC not confirmed. Isolate the pallet tag and retry.' : '',capture.kind === 'pallet' && !s.identified);
  render();
}
function updateScan() {
  const s = session(), element = document.querySelector('#scan-results');
  if (!active || !element || !s) return;
  const elapsed = Math.max(0,Math.floor((Date.now() - Date.parse(active.startedAt)) / 1000));
  element.innerHTML = '<p class="status">' + (active.ending ? 'Finishing' : 'Reading') + ' / ' + elapsed + ' s</p>' +
    (active.kind === 'cartons' ? counts(compare(s.manifest,Object.keys(latest(s).observations))) : '');
  for (const control of root.querySelectorAll('button[data-action], #role, #scenario, #rescan')) control.disabled = true;
}
function chooseManifest(text,name,demo = false) {
  if (view !== 'session' || !permits(role,'manifest') || session()?.closedAt || session()?.runs.length || active) return;
  pendingImport = {data:parseManifest(text),name,demo};
  feedback('');
  render();
}

function action(fn) {
  try { fn(); } catch (error) { feedback(error?.message ?? 'Action could not be completed.',true); }
}
window.keypharmEvent = (name,data) => action(() => {
  if (name === 'reader') {
    reader = data;
    if (view === 'session' && !active) render();
  }
  if (name === 'manifest-file') chooseManifest(data.text,data.name);
  if (name === 'dashboard') {
    dashboardUrl = data.url ?? '';
    if (!dashboardUrl) { includeOtherRecords = false; publish(); }
    feedback(data.message ?? '', Boolean(data.message));
    render();
  }
  if (name === 'error') feedback(data.message,true);
  if (name === 'press' && session()?.source === 'C72 hardware') begin();
  if (name === 'release' && active?.hardware) end();
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

root.addEventListener('change', event => action(() => {
  const target = event.target;
  if (target.id === 'role' && !active) { role = target.value; pendingImport = undefined; feedback(''); render(); }
  if (target.id === 'scenario') scenario = target.value;
  if (target.id === 'csv-file' && target.files[0]) {
    const file = target.files[0];
    if (file.size > 512000) throw new Error('Use a CSV smaller than 512 KB.');
    file.text().then(text => action(() => chooseManifest(text,file.name))).catch(() => feedback('Could not read the CSV.',true));
  }
}));
root.addEventListener('input', event => {
  if (event.target.id === 'rescan') rescanReason = event.target.value;
});
root.addEventListener('click', event => action(() => {
  const control = event.target.closest('button');
  if (!control || active) return;
  const s = session(), command = control.dataset.action;
  if (control.dataset.open) {
    selected = control.dataset.open;
    view = 'session';
    rescanReason = '';
  }
  if (command === 'new' && permits(role,'create')) view = 'new';
  if (command === 'back') { view = 'sessions'; pendingImport = undefined; }
  if (command === 'sample') { chooseManifest(SAMPLE,'Demo sample CSV',true); return; }
  if (command === 'csv' && permits(role,'manifest')) { if (bridge) bridge.pickManifest(); else document.querySelector('#csv-file')?.click(); return; }
  if (command === 'template' && permits(role,'manifest')) { if (bridge) bridge.saveTemplate(SAMPLE); else download('keypharm-sample.csv',SAMPLE); return; }
  if (command === 'reconnect') { bridge?.connectReader(); return; }
  if (command === 'dashboard' && permits(role,'export')) {
    if (!dashboardUrl) {
      includeOtherRecords = role === 'admin' && Boolean(document.querySelector('#share-all')?.checked);
      publish();
    }
    bridge?.shareDashboard(!dashboardUrl);
    return;
  }
  if (command === 'copy' && permits(role,'export')) { bridge?.copyLink(dashboardUrl); feedback('Dashboard link copied.'); return; }
  if (command === 'export' && permits(role,'export')) {
    const evidence = specEvidenceCsv(store), records = evidenceCsv(store), summary = evidenceSummary(store);
    if (bridge) bridge.exportEvidence(evidence,records,summary);
    else { download('keypharm-evidence.csv',evidence); download('keypharm-records.csv',records); download('keypharm-summary.txt',summary); }
    return;
  }
  if (command === 'continue' && permits(role,'confirm') && !s.confirmedAt && canContinue(s,latest(s))) {
    commit(() => { s.confirmedAt = now(); log(s,'Clean match confirmed','Carton set matched',latest(s).id); });
  }
  if (command || control.dataset.open) { feedback(''); render(); }
}));
root.addEventListener('submit', event => action(() => {
  event.preventDefault();
  if (active) return;
  const form = event.target, data = Object.fromEntries(new FormData(form)), s = session();
  if (form.id === 'create' && permits(role,'create')) {
    if (Object.keys(metadata).some(k => k !== 'notes' && !data[k]?.trim())) throw new Error('Fill in the test setup fields.');
    const record = {...data,id:id(),creator:actor(),createdAt:now(),mode:'POC',runs:[],logs:[],allocation:{}};
    commit(() => { log(record,'Session created',record.planned); store.sessions.push(record); });
    selected = record.id; view = 'session';
  }
  if (form.id === 'manifest' && s && !s.closedAt && !s.runs.length && permits(role,'manifest') && pendingImport) {
    if (s.manifest && !data.reason.trim()) throw new Error('Enter a reason for the revision.');
    const allocation = {cartons:pendingImport.data.cartons.length,pallets:1,reserves:Number(data.reserves),candidates:Number(data.candidates)};
    const total = allocationTotal(allocation) + store.sessions.filter(other => other.id !== s.id).reduce((sum,other) => sum + allocationTotal(other.allocation),0);
    if (total > 500) throw new Error('POC label allocation cannot exceed 500 across sessions.');
    commit(() => {
      if (s.manifest) (s.manifestRevisions ??= []).push(s.manifest);
      s.manifest = {...pendingImport.data,revision:(s.manifest?.revision ?? 0)+1,source:pendingImport.name,
        demo:pendingImport.demo,importedAt:now()};
      s.allocation = allocation;
      s.verifiedBy = s.verifiedAt = null;
      s.identified = false;
      log(s,'Manifest saved','Revision ' + s.manifest.revision + ' / ' + s.manifest.source +
        ' / ' + total + ' cumulative labels' + (data.reason ? ' / ' + data.reason : ''));
    });
    pendingImport = undefined;
  }
  if (form.id === 'verify' && s?.manifest && !s.verifiedBy && !s.closedAt && data.checked && permits(role,'verify')) {
    commit(() => { s.verifiedBy = actor(); s.verifiedAt = now(); log(s,'Physical verification','Pallet contents and unique label assignment confirmed'); });
  }
  if (form.id === 'investigate' && s && !s.closedAt && permits(role,'investigate') && latest(s)?.result?.extra.includes(data.epc)) {
    if (!data.note.trim()) throw new Error('Enter the investigation note.');
    commit(() => log(s,'Unexpected EPC ' + data.outcome.toLowerCase(),data.epc + ' / ' + data.note,latest(s).id));
  }
  if (form.id === 'close' && canClose(s,data,role)) {
    commit(() => { s.closedAt = now(); s.closure = {coverage:data.coverage.trim(),actor:actor()}; log(s,'Session closed',s.closure.coverage); });
  }
  feedback(''); render();
}));
function download(name,text) {
  const url = URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}

// Pointer capture and key-up implement the same hold/release behavior as the physical trigger.
root.addEventListener('pointerdown',event => {
  if (event.target.id !== 'demo-trigger' || event.button !== 0) return;
  event.target.setPointerCapture(event.pointerId);
  action(begin);
});
root.addEventListener('pointerup',event => { if (event.target.id === 'demo-trigger') action(() => end()); });
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
render();
bridge?.connectReader();
