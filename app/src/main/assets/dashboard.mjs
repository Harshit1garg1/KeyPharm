import {actionLabel, displaySource, escapeHtml as escape, manifestFor} from './model.mjs';
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
const theme = find('#dashboard-theme');
const themeKey = 'keypharm-dashboard-theme';
function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  const label = mode === 'dark' ? 'Light mode' : 'Dark mode';
  theme.setAttribute('aria-label',label);
  theme.title = label;
}
let savedTheme;
try { savedTheme = localStorage.getItem(themeKey); } catch { /* Private storage may be unavailable. */ }
applyTheme(savedTheme === 'light' ? 'light' : 'dark');
theme.hidden = false;
theme.addEventListener('click',() => {
  const mode = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(mode);
  try { localStorage.setItem(themeKey,mode); } catch { /* The current page still switches themes. */ }
});
let data = indexRecords([]);
let section = 'overview';
let selected;
let linkedSession;
let previousBody;
let inFlight = false;
let stockOverview;

const count = new Intl.NumberFormat();
const formattedTime = new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
const time = value => Number.isFinite(Date.parse(value)) ? formattedTime.format(new Date(value)) : '';
const code = value => '<code>' + escape(value) + '</code>';
const facts = (...pairs) => '<dl class="dashboard-facts">' + pairs.map(([name,value]) =>
  '<div><dt>' + escape(name) + '</dt><dd>' + escape(value ?? '—') + '</dd></div>').join('') + '</dl>';
const list = (items, renderer) => items?.length ? '<ul class="log">' + items.map(item =>
  '<li>' + renderer(item) + '</li>').join('') + '</ul>' : '<p class="muted">None recorded.</p>';
const badge = value => value ? '<span class="dashboard-badge" data-state="' + escape(value.toLowerCase()) + '">' + escape(value) + '</span>' : '';
const fold = (label,body,status) => '<details class="dashboard-fold"><summary><span>' + escape(label) + '</span>' +
  badge(status) + '</summary><div class="dashboard-fold-body">' + body + '</div></details>';
const joined = (...items) => items.filter(Boolean).join(' / ');
const readerPower = p => joined(p?.region,p?.powerDbm == null ? '' : p.powerDbm + ' dBm');
const logBody = log => '<strong>' + escape(actionLabel(log.action)) + '</strong><br>' + escape(log.detail) +
  '<br><small>' + escape(joined(log.actor,time(log.at))) + '</small>';

function updateOverview() {
  const displayCount = n => previousBody === undefined ? '—' : count.format(n);
  find('#totals').innerHTML = ['sessions','pallets','scans','exceptions','activity'].map(key =>
    '<a class="dashboard-total" href="#' + key + '"><span>' + sections[key].title + '</span><strong data-total="' +
    key + '">' + displayCount(data.rows[key].length) + '</strong>' +
    (key === 'sessions' && previousBody !== undefined ?
      '<small>' + count.format(data.rows.sessions.length - data.closed) + ' open / ' + count.format(data.closed) + ' closed</small>' : '') +
    '</a>').join('') + (stockOverview ? [['inventory','Cartons on hand'],['inbound','Open receipts'],['counts','Counts to review']]
      .map(([key,label]) => '<a class="dashboard-total" href="#' + key + '"><span>' + label + '</span><strong data-total="' + key +
        '">' + count.format(stockOverview[key]) + '</strong></a>').join('') : '');
  for (const chip of document.querySelectorAll('#catalog-tabs [data-tab-count]')) {
    const key = chip.dataset.tabCount;
    chip.textContent = displayCount(data.rows[key]?.length ?? 0);
  }
  const sessionsCount = find('#recent-sessions-count');
  if (sessionsCount) {
    sessionsCount.hidden = previousBody === undefined;
    sessionsCount.textContent = count.format(data.rows.sessions.length);
  }
  const outcomes = Object.entries(data.results);
  const scans = outcomes.reduce((sum,[,total]) => sum + total,0);
  let start = 0;
  const slices = outcomes.flatMap(([state,total]) => {
    if (!total) return [];
    const end = start + total;
    const slice = 'var(--outcome-' + state.toLowerCase() + ') ' + (start / scans * 100) + '% ' + (end / scans * 100) + '%';
    start = end;
    return [slice];
  });
  const chart = slices.length ? 'conic-gradient(' + slices.join(',') + ')' : 'var(--raised)';
  find('#outcomes').innerHTML = '<div class="outcome-chart" style="--outcome-chart:' + chart +
    '"><span><strong>' + displayCount(scans) + '</strong><small>Total scans</small></span></div>' +
    '<dl class="outcome-counts" aria-label="Scan counts by outcome">' + outcomes.map(([state,total]) =>
      '<div class="outcome-row" data-state="' + state.toLowerCase() + '"><dt>' + state +
      '</dt><dd>' + displayCount(total) + '</dd></div>').join('') + '</dl>';
  const sessions = data.rows.sessions.slice(0,6);
  find('#recent-sessions').innerHTML = sessions.map(row =>
    '<tr><th scope="row"><a href="#sessions/' + escape(encodeURIComponent(row.id)) + '">' + escape(row.title) +
    '</a></th><td>' + escape(row.session.manifest?.pallet ?? '—') + '</td><td>' + escape(displaySource(row.session.source) ?? '—') +
    '</td><td>' + badge(row.status) + '</td></tr>').join('');
  const empty = find('#sessions-empty');
  empty.hidden = sessions.length > 0;
  empty.textContent = previousBody === undefined ? 'Waiting for records…' : 'No shared sessions yet.';
}

function observationDetails(observations) {
  const entries = Object.entries(observations ?? {});
  return fold('Observed EPCs (' + entries.length + ')', list(entries, ([epc,o]) => code(epc) +
    '<br><small>' + escape(joined(o?.count == null ? '' : o.count + ' reads',o?.rssi == null ? '' : 'RSSI ' + o.rssi,
      time(o?.first))) + '</small>'));
}
function runEvidence(run) {
  const r = run.result;
  return facts(['Operator',run.operator],['Source',displaySource(run.source)],['Started',time(run.startedAt)],['Finished',time(run.endedAt)],
    ['Duration',run.elapsedSeconds == null ? null : run.elapsedSeconds + ' s'],['Manifest revision',run.manifestRevision],
    ['Expected',r?.expected],['Matched',r?.matched?.length],['Completeness',r?.percent == null ? null : r.percent + '%'],
    ['Reader profile',displaySource(run.profile?.name)],['Profile version',displaySource(run.profile?.version)],['Region / power',readerPower(run.profile)],['Reader build',run.profile?.build],
    ['Rescan reason',run.reason],['Notes',run.note ?? run.notes],['Error',run.error]) +
    fold((r?.matchedCartons ? 'Missing cartons by SKU (' : 'Missing EPCs (') + (r?.missing?.length ?? 0) + ')',list(r?.missing,code)) +
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
    fold('Manifest and planned evidence',facts(['Source',displaySource(m?.source)],['Revision',m?.revision],['Planned test',s.planned]) +
      (m?.matchBy === 'sku' ? list(pallets.flatMap(pallet => pallet.requirements.map(requirement => ({...requirement,pallet:pallet.pallet}))),
        row => escape(row.pallet + ' / ' + row.sku + ' / ' + row.quantity + ' cartons')) : '') +
      pallets.map(p => '<h3>' + escape(p.pallet) + '</h3>' +
        list(p.cartons,c => escape(joined(c.carton,c.sku)) + '<br>' + code(c.epc))).join('')) +
    '<h3 class="line">Recent carton scans</h3>' + (scans.map(row =>
      fold(row.title,runEvidence(row.run),row.status)).join('') || '<p class="muted">No recorded attempts.</p>') +
    '<h3 class="line">Recent activity</h3>' + list(logs,logBody);
}

function exceptionEvidence(row) {
  const disposition = row.status === 'Unexpected' ? (row.session.logs ?? []).findLast(log =>
    log.run === row.run.id && log.action?.startsWith('Unexpected EPC ') &&
    String(log.detail).split(' / ')[0] === row.epc) : null;
  return facts(['Scan',row.scan],['EPC',row.epc],
    ['Operator',row.run.operator],['Recorded',time(row.at)],['Error',row.run.error]) +
    '<div class="exception-subdetails">' + (disposition ? fold('Investigation',logBody(disposition)) : '') +
    fold('Scan evidence','<div class="exception-evidence-content">' + runEvidence(row.run) + '</div>') + '</div>';
}

const exceptionCount = total => count.format(total) + (total === 1 ? ' exception' : ' exceptions');

function sessionExceptions(row) {
  const open = new Set([...detail.querySelectorAll('details[data-exception][open]')].map(item => item.dataset.exception));
  const query = search.value.trim().toLowerCase();
  const recent = row.exceptions.slice(0,RECENT_LIMIT);
  const matchesSession = !query || matches(row,query);
  const shown = matchesSession ? recent : recent.filter(item => matches(item,query));
  return facts(['Pallet',row.session.manifest?.pallet],['Latest exception',time(row.at)]) +
    (shown.length !== row.exceptions.length ? '<p class="muted">Showing ' + count.format(shown.length) + ' of ' +
      exceptionCount(row.exceptions.length) + '.</p>' : '') +
    shown.map(item => {
      const status = item.run.state === 'Interrupted' ? 'Interrupted' : (item.run.result?.status || item.status);
      return '<details class="exception-entry" data-exception="' + escape(item.id) + '"' +
        (open.has(item.id) ? ' open' : '') + '><summary><span class="exception-chevron" aria-hidden="true"></span>' +
        '<span class="exception-entry-copy"><strong>' + escape(item.title) + '</strong><small>' +
        escape(joined(item.scan,item.epc)) + '</small></span>' + badge(status) + '</summary>' +
        '<div class="exception-body">' + exceptionEvidence(item) + '</div></details>';
    }).join('');
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
    const manifest = manifestFor(row.session,row.run);
    evidence = facts(['Test',row.session.testId],['Pallet',manifest?.pallet]) + runEvidence(row.run);
  }
  if (section === 'exceptions') evidence = sessionExceptions(row);
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
const dashboardFind = find('.dashboard-find');
const dashboardQuery = find('#dashboard-query');
const dashboardResults = find('#dashboard-find-results');
const dashboardFindLinks = find('#dashboard-find-links');
function renderDashboardSearch() {
  const terms = dashboardQuery.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  dashboardResults.hidden = !terms.length;
  if (!terms.length) return;
  const results = data.rows.sessions.filter(row => {
    const {manifest,location} = row.session;
    const pallets = manifest?.pallets?.length ? manifest.pallets : manifest ? [manifest] : [];
    const fields = [row.title,location,row.status,...pallets.flatMap(pallet =>
      [pallet.pallet,pallet.palletEpc,...(pallet.requirements ?? []).map(row => row.sku),...(pallet.cartons ?? []).flatMap(carton => [carton.carton,carton.epc,carton.sku])])];
    const searchable = fields.join(' ').toLowerCase();
    return terms.every(term => searchable.includes(term));
  });
  find('#dashboard-find-status').textContent = previousBody === undefined ? 'Waiting for records…' :
    results.length ? 'Showing ' + Math.min(results.length,8) + ' of ' + results.length + ' sessions' : 'No matching sessions.';
  dashboardFindLinks.innerHTML = results.slice(0,8).map(row => '<li><a href="#sessions/' +
    encodeURIComponent(row.id) + '"><strong>' + escape(row.title) + '</strong><small>' +
    escape(joined(row.session.location,row.status)) + '</small></a></li>').join('');
}
dashboardFind.hidden = false;
dashboardQuery.addEventListener('input',renderDashboardSearch);
dashboardQuery.addEventListener('focus',renderDashboardSearch);
dashboardFind.addEventListener('submit',event => {
  event.preventDefault();
  dashboardFindLinks.querySelector('a')?.click();
});
dashboardFind.addEventListener('keydown',event => {
  if (event.key !== 'Escape' || dashboardResults.hidden) return;
  event.preventDefault();
  dashboardQuery.focus();
  dashboardResults.hidden = true;
});
dashboardFind.addEventListener('focusout',event => {
  if (!dashboardFind.contains(event.relatedTarget)) dashboardResults.hidden = true;
});
dashboardFindLinks.addEventListener('click',event => {
  const link = event.target.closest('a');
  if (!link) return;
  dashboardQuery.value = '';
  dashboardResults.hidden = true;
  if (window.location.hash === link.hash) navigate(true);
});

function renderRecords() {
  const grouped = section === 'exceptions';
  const all = grouped ? data.exceptionSessions : data.rows[section];
  const recent = all.slice(0,RECENT_LIMIT);
  if (section === 'sessions' && linkedSession && !recent.some(row => row.id === linkedSession)) {
    const linked = all.find(row => row.id === linkedSession);
    if (linked) recent.splice(RECENT_LIMIT - 1,1,linked);
  }
  const query = search.value.trim().toLowerCase();
  const found = query ? recent.filter(row => matches(row,query) ||
    row.exceptions?.slice(0,RECENT_LIMIT).some(item => matches(item,query))) : recent;
  const unit = grouped ? ' sessions' : ' records';
  find('#record-count').textContent = query ? count.format(found.length) + ' matches in the latest ' + count.format(recent.length) + unit + '.' :
    'Showing ' + count.format(recent.length) + ' of ' + count.format(all.length) + unit + (grouped ? ' with exceptions.' : '.');
  if (!found.some(row => row.id === selected)) selected = found[0]?.id;
  records.innerHTML = found.map(row => '<li><button type="button" data-id="' + escape(row.id) +
    '" class="dashboard-record" aria-pressed="' + (row.id === selected) + '"><span><strong>' + escape(row.title) +
    '</strong><small>' + escape(row.description) + '</small><small>' + escape(time(row.at)) + '</small></span>' +
    badge(row.status) + '</button></li>').join('') ||
    '<li class="muted">' + (query ? 'No recent records match your search.' :
      grouped ? 'No sessions with exceptions.' : 'No records received in this section.') + '</li>';
  renderDetail(found.find(row => row.id === selected));
}

const scanLogSections = new Set(['sessions','pallets','scans','exceptions']);
function navigate(focusTitle = false) {
  const [rawRequested, sessionId] = window.location.hash.slice(1).split('/');
  if (rawRequested === 'content') return;
  const workspace = find('#workspace-panel');
  const requested = rawRequested === 'reports' && workspace ? 'overview' : rawRequested;
  const workspaceSection = workspace && [...nav.querySelectorAll('[data-workspace-title]')].find(link =>
    (link.dataset.workspaceAliases ?? link.hash.slice(1)).split(',').includes(requested));
  const next = workspaceSection || Object.hasOwn(sections,requested) ? requested : 'overview';
  if (section !== next) { selected = undefined; search.value = ''; }
  section = next;
  linkedSession = section === 'sessions' && sessionId ?
    data.rows.sessions.find(row => encodeURIComponent(row.id) === sessionId)?.id : undefined;
  if (section === 'sessions' && sessionId) {
    selected = linkedSession;
    search.value = '';
  }
  for (const link of nav.querySelectorAll('a')) {
    const active = link === workspaceSection ||
      (link.hash === '#sessions' && scanLogSections.has(section)) ||
      link.hash === '#' + section;
    if (active) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
  const catalogTabs = find('#catalog-tabs');
  if (catalogTabs) {
    catalogTabs.hidden = !scanLogSections.has(section);
    for (const tab of catalogTabs.querySelectorAll('a')) {
      if (tab.hash === '#' + section) tab.setAttribute('aria-current','page');
      else tab.removeAttribute('aria-current');
    }
  }
  find('#page-title').textContent = workspaceSection ? workspaceSection.dataset.workspaceTitle :
    sections[section]?.title ?? 'Overview';
  find('#page-heading').dataset.overview = String(section === 'overview');
  find('#section-description').textContent = workspaceSection ? '' :
    (sections[section]?.description ?? (section === 'overview' ? 'Session verification, stock movement, and handheld sync.' : ''));
  find('#overview').hidden = section !== 'overview';
  catalog.hidden = section === 'overview' || Boolean(workspaceSection);
  if (workspace) workspace.hidden = !workspaceSection;
  menu.setAttribute('aria-expanded','false');
  if (!catalog.hidden) renderRecords();
  if (rawRequested === 'reports' && workspace) find('#overview-reports')?.scrollIntoView({block:'nearest'});
  if (focusTitle) {
    find('#content').scrollTop = 0;
    find('#page-title').focus({preventScroll:true});
  }
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
      if (!dashboardResults.hidden) renderDashboardSearch();
      if (!catalog.hidden) {
        if (section === 'sessions' && !selected && window.location.hash.startsWith('#sessions/')) navigate();
        else renderRecords();
      }
    }
    connection.textContent = '';
  } catch {
    connection.className = 'status hold';
    const source = find('#workspace-panel') ? 'Workspace' : 'Handheld';
    connection.textContent = previousBody !== undefined ? source + ' offline. Showing saved records.' :
      source + ' unavailable. Check the connection and refresh.';
  } finally {
    inFlight = false;
    refresh.disabled = false;
  }
}

search.addEventListener('input',() => { linkedSession = undefined; renderRecords(); });
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
window.addEventListener('workspace-updated',fetchRecords);
window.addEventListener('stock-overview',event => { stockOverview = event.detail; updateOverview(); });
updateOverview();
navigate();
fetchRecords();
setInterval(fetchRecords,5000);
