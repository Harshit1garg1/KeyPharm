import {indexRecords, RECENT_LIMIT, sections} from './dashboard-model.mjs';

const find = selector => document.querySelector(selector);
const nav = find('#dashboard-nav');
const menu = find('#menu-toggle');
const catalog = find('#catalog');
const records = find('#records');
const detail = find('#detail');
const search = find('#search');
const refresh = find('#refresh');
const connection = find('#connection');
let data = indexRecords([]);
let section = 'overview';
let selected;
let refreshed;
let previousBody;
let inFlight = false;

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const count = new Intl.NumberFormat();
const formattedTime = new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
const time = value => Number.isFinite(Date.parse(value)) ? formattedTime.format(new Date(value)) : '';
const code = value => '<code>' + escape(value) + '</code>';
const facts = (...pairs) => '<dl class="dashboard-facts">' + pairs.map(([name,value]) =>
  '<div><dt>' + escape(name) + '</dt><dd>' + escape(value ?? '—') + '</dd></div>').join('') + '</dl>';
const list = (items, renderer) => items?.length ? '<ul class="log">' + items.map(item =>
  '<li>' + renderer(item) + '</li>').join('') + '</ul>' : '<p class="muted">None recorded.</p>';
const badge = value => value ? '<span class="dashboard-badge" data-state="' + escape(value.toLowerCase()) + '">' + escape(value) + '</span>' : '';
const fold = (label,body) => '<details class="dashboard-fold"><summary>' + escape(label) + '</summary>' + body + '</details>';
const joined = (...items) => items.filter(Boolean).join(' / ');
const readerPower = p => joined(p?.region,p?.powerDbm == null ? '' : p.powerDbm + ' dBm');
const logBody = log => '<strong>' + escape(log.action) + '</strong><br>' + escape(log.detail) +
  '<br><small>' + escape(joined(log.actor,time(log.at))) + '</small>';

function updateOverview() {
  const displayCount = n => previousBody === undefined ? '—' : count.format(n);
  find('#totals').innerHTML = Object.entries(sections).map(([key,s]) =>
    '<a class="dashboard-total" href="#' + key + '"><span>' + s.title + '</span><strong data-total="' +
    key + '">' + displayCount(data.rows[key].length) + '</strong>' +
    (key === 'sessions' && previousBody !== undefined ?
      '<small>' + count.format(data.rows.sessions.length - data.closed) + ' open / ' + count.format(data.closed) + ' closed</small>' : '') +
    '</a>').join('');
  const scans = data.rows.scans.length;
  find('#outcomes').innerHTML = Object.entries(data.results).map(([state,total]) =>
    '<div class="outcome-row" data-state="' + state.toLowerCase() + '"><div class="row spread"><strong>' + state +
    '</strong><span>' + displayCount(total) + '</span></div>' +
    '<progress aria-label="' + state + ' scans" value="' + total + '" max="' + (scans || 1) + '"></progress></div>').join('');
  find('#recent').innerHTML = data.rows.activity.slice(0,5).map(row => '<li><strong>' + escape(row.title) +
    '</strong><small>' + escape(row.description) + '</small><small>' + escape(time(row.at)) + '</small></li>').join('') ||
    '<li class="muted">No activity received.</li>';
}

function observationDetails(observations) {
  const entries = Object.entries(observations ?? {});
  return fold('Observed EPCs (' + entries.length + ')', list(entries, ([epc,o]) => code(epc) +
    '<br><small>' + escape(joined(o?.count == null ? '' : o.count + ' reads',o?.rssi == null ? '' : 'RSSI ' + o.rssi,
      time(o?.first))) + '</small>'));
}
function runEvidence(run) {
  const r = run.result;
  return facts(['Operator',run.operator],['Source',run.source],['Started',time(run.startedAt)],['Finished',time(run.endedAt)],
    ['Duration',run.elapsedSeconds == null ? null : run.elapsedSeconds + ' s'],['Manifest revision',run.manifestRevision],
    ['Expected',r?.expected],['Matched',r?.matched?.length],['Completeness',r?.percent == null ? null : r.percent + '%'],
    ['Reader profile',run.profile?.name],['Region / power',readerPower(run.profile)],['Reader build',run.profile?.build],
    ['Rescan reason',run.reason],['Notes',run.note ?? run.notes],['Error',run.error]) +
    fold('Missing EPCs (' + (r?.missing?.length ?? 0) + ')',list(r?.missing,code)) +
    fold('Unexpected EPCs (' + (r?.extra?.length ?? 0) + ')',list(r?.extra,code)) +
    observationDetails(run.observations);
}
function sessionEvidence(s) {
  const m = s.manifest;
  const pallets = m?.pallets?.length ? m.pallets : (m ? [m] : []);
  const scans = data.rows.scans.filter(row => row.session === s).slice(0,RECENT_LIMIT);
  const logs = data.rows.activity.filter(row => row.session === s).slice(0,RECENT_LIMIT).map(row => row.log);
  return facts(['Pallet',m?.pallet],['Pallet EPC',m?.palletEpc],['Session ID',s.id],
    ['Location / level',joined(s.location,s.level)],['Product mix',s.product],['Pallet type',s.palletType],
    ['Label setup',joined(s.label,s.placement)],['Wrapping / shielding',joined(s.wrapping,s.shielding)],
    ['Scan method',s.method],['Created',time(s.createdAt)],['Created by',s.creator],['Verified by',s.verifiedBy],
    ['Sign-off',s.closure?.actor],['Coverage',s.closure?.coverage],['Setup notes',s.notes]) +
    fold('Manifest and planned evidence',facts(['Source',m?.source],['Revision',m?.revision],['Planned test',s.planned]) +
      pallets.map(p => '<h3>' + escape(p.pallet) + '</h3>' +
        list(p.cartons,c => escape(joined(c.carton,c.sku)) + '<br>' + code(c.epc))).join('')) +
    '<h3 class="line">Recent carton scans</h3>' + (scans.map(row =>
      fold(row.title + ' / ' + row.status,runEvidence(row.run))).join('') || '<p class="muted">No recorded attempts.</p>') +
    '<h3 class="line">Recent activity</h3>' + list(logs,logBody);
}

function renderDetail(row) {
  if (!row) { detail.innerHTML = '<p class="muted">Select a record to see its details.</p>'; return; }
  let evidence;
  if (section === 'sessions') evidence = sessionEvidence(row.session);
  if (section === 'pallets') {
    const a = row.attempt;
    evidence = facts(['Test',row.session.testId],['Pallet locked',a.lockedPallet],['Operator',a.actor],
      ['Started',time(a.startedAt)],['Finished',time(a.endedAt)],['Region / power',readerPower(a.profile)]) +
      observationDetails(a.observations);
  }
  if (section === 'scans') {
    const manifest = [...(row.session.manifestRevisions ?? []),row.session.manifest]
      .find(item => item && item.revision === row.run.manifestRevision) ?? row.session.manifest;
    evidence = facts(['Test',row.session.testId],['Pallet',manifest?.pallet]) + runEvidence(row.run);
  }
  if (section === 'exceptions') {
    const disposition = row.status === 'Unexpected' ? (row.session.logs ?? []).findLast(log =>
      log.run === row.run.id && log.action?.startsWith('Unexpected EPC ') &&
      String(log.detail).split(' / ')[0] === row.epc) : null;
    evidence = facts(['Test',row.session.testId],['Scan',row.scan],['EPC',row.epc],
      ['Result',row.run.result?.status],['Operator',row.run.operator],['Recorded',time(row.at)],['Error',row.run.error]) +
      (disposition ? fold('Investigation',logBody(disposition)) : '') + fold('Scan evidence',runEvidence(row.run));
  }
  if (section === 'activity') evidence = facts(['Test',row.session.testId],['Actor',row.log.actor],
    ['Time',time(row.at)],['Run ID',row.log.run],['Details',row.log.detail]);
  detail.innerHTML = '<div class="row spread dashboard-detail-heading"><h2>' + escape(row.title) + '</h2>' + badge(row.status) + '</div>' + evidence;
}

function matches(row, query) {
  const manifest = row.session.manifest;
  const sku = (manifest?.pallets?.length ? manifest.pallets : [manifest])
    .flatMap(pallet => (pallet?.cartons ?? []).map(carton => carton.sku));
  return [row.title,row.description,row.status,row.epc,row.log?.detail,row.session.product,manifest?.palletEpc,...sku]
    .some(value => String(value ?? '').toLowerCase().includes(query));
}
function renderRecords() {
  const all = data.rows[section];
  const recent = all.slice(0,RECENT_LIMIT);
  const query = search.value.trim().toLowerCase();
  const found = query ? recent.filter(row => matches(row,query)) : recent;
  find('#record-count').textContent = query ? count.format(found.length) + ' matches in the latest ' + count.format(recent.length) + ' records.' :
    'Showing ' + count.format(recent.length) + ' of ' + count.format(all.length) + ' records.';
  if (!found.some(row => row.id === selected)) selected = found[0]?.id;
  records.innerHTML = found.map(row => '<li><button type="button" data-id="' + escape(row.id) +
    '" class="dashboard-record" aria-pressed="' + (row.id === selected) + '"><span><strong>' + escape(row.title) +
    '</strong><small>' + escape(row.description) + '</small><small>' + escape(time(row.at)) + '</small></span>' +
    badge(row.status) + '</button></li>').join('') ||
    '<li class="muted">' + (query ? 'No recent records match your search.' : 'No records received in this section.') + '</li>';
  renderDetail(found.find(row => row.id === selected));
}

function navigate(focusTitle = false) {
  const requested = window.location.hash.slice(1);
  if (requested === 'content') return;
  const next = Object.hasOwn(sections,requested) ? requested : 'overview';
  if (section !== next) { selected = undefined; search.value = ''; }
  section = next;
  for (const link of nav.querySelectorAll('a')) {
    if (link.hash === '#' + section) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
  find('#page-title').textContent = sections[section]?.title ?? 'Overview';
  find('#section-description').textContent = sections[section]?.description ?? 'Totals cover all records shared by the handheld.';
  find('#overview').hidden = section !== 'overview';
  catalog.hidden = section === 'overview';
  menu.setAttribute('aria-expanded','false');
  if (!catalog.hidden) renderRecords();
  if (focusTitle) find('#page-title').focus();
}

async function fetchRecords() {
  if (inFlight) return;
  inFlight = true;
  refresh.disabled = true;
  try {
    const response = await fetch('records', {cache:'no-store', signal:AbortSignal.timeout(3500)});
    if (!response.ok) throw new Error('Fetch failed');
    const body = await response.text();
    if (body !== previousBody) {
      const store = JSON.parse(body);
      if (!Array.isArray(store.sessions)) throw new Error('Invalid records');
      data = indexRecords(store.sessions);
      previousBody = body;
      updateOverview();
      if (!catalog.hidden) renderRecords();
    }
    refreshed = new Date();
    connection.className = 'status match';
    connection.textContent = 'Handheld online. Refreshed ' + refreshed.toLocaleTimeString() + '.';
  } catch {
    connection.className = 'status hold';
    connection.textContent = refreshed ? 'Handheld offline. Showing records fetched at ' + refreshed.toLocaleTimeString() + '.' :
      'Handheld unreachable. Check sharing and the network, then refresh.';
  } finally {
    inFlight = false;
    refresh.disabled = false;
  }
}

search.addEventListener('input',renderRecords);
records.addEventListener('click',event => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  selected = button.dataset.id;
  renderRecords();
  if (matchMedia('(max-width: 920px)').matches) detail.focus();
  else [...records.querySelectorAll('button')].find(item => item.dataset.id === selected)?.focus();
});
menu.addEventListener('click',() => menu.setAttribute('aria-expanded',String(menu.getAttribute('aria-expanded') !== 'true')));
nav.addEventListener('click',event => {
  if (event.target.closest('a')?.hash === window.location.hash) navigate(true);
});
window.addEventListener('hashchange',() => navigate(true));
refresh.addEventListener('click',fetchRecords);
updateOverview();
navigate();
fetchRecords();
setInterval(fetchRecords,5000);
