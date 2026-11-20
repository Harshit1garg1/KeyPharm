const sessions = document.querySelector('#sessions');
const detail = document.querySelector('#detail');
const status = document.querySelector('#connection');
const search = document.querySelector('#search');
const refresh = document.querySelector('#refresh');
let records = [];
let selected;
let refreshed;
let inFlight = false;
let previousBody;

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const time = value => value ? new Date(value).toLocaleString() : '—';
const entry = (name,value) => '<div><strong>' + name + '</strong><p>' + escape(value ?? '—') + '</p></div>';
const epcs = values => values?.length ? values.map(epc => '<li><code>' + escape(epc) + '</code></li>').join('') : '<li>None</li>';

function render() {
  const query = search.value.toLowerCase().trim();
  const matches = records.filter(s => [s.testId,s.manifest?.pallet,s.location,s.creator,s.product,
    ...(s.manifest?.cartons ?? []).map(carton => carton.sku)]
    .some(field => String(field ?? '').toLowerCase().includes(query)));
  if (!matches.some(s => s.id === selected)) selected = matches[0]?.id;
  sessions.innerHTML = matches.map(s => '<button class="record" aria-current="' + (s.id === selected) + '" data-id="' + escape(s.id) +
    '"><span>' + escape(s.testId) + '<br><small>' + escape(s.manifest?.pallet ?? 'Manifest pending') + '</small></span><span>' +
    (s.closedAt ? 'Closed' : 'Open') + '</span></button>').join('') || '<p class="line muted">' + (query ? 'No sessions match your search.' : 'No sessions received.') + '</p>';
  const s = matches.find(session => session.id === selected);
  if (!s) {
    detail.innerHTML = '<p>Select a session to see scan evidence and logs.</p>';
    return;
  }
  const runs = s.runs.map((run,i) => {
    const result = run.result;
    const state = run.state === 'Finished' ? result?.status : run.state;
    return '<details class="line"><summary>' + (i === 0 ? 'First pass' : 'Rescan ' + i) + ' / ' + escape(state) + ' / ' +
      escape(run.source) + '</summary><div class="pair">' + entry('Operator',run.operator) +
      entry('Started',time(run.startedAt)) + entry('Ended',time(run.endedAt)) + entry('Duration',run.endedAt ? run.elapsedSeconds + ' s' : '—') +
      entry('Expected / matched', result ? result.expected + ' / ' + result.matched.length : '—') +
      entry('Completeness', result?.percent == null ? '—' : result.percent + '%') + entry('Rescan reason',run.reason) +
      entry('Profile',run.profile?.name) + entry('Region / power',run.profile ? run.profile.region + ' / ' + (run.profile.powerDbm ?? '—') + ' dBm' : '—') +
      entry('Reader build',run.profile?.build) + '</div><div class="pair"><div><strong>Missing EPCs</strong><ul class="log">' + epcs(result?.missing) +
      '</ul></div><div><strong>Unexpected EPCs</strong><ul class="log">' + epcs(result?.extra) +
      '</ul></div></div><details><summary>Observed EPCs</summary><ul class="log">' + Object.entries(run.observations).map(([epc,o]) =>
        '<li><code>' + escape(epc) + '</code> / ' + escape(o.count) + ' reads / ' + escape(time(o.first)) +
        (o.rssi ? ' / RSSI ' + escape(o.rssi) : '') + '</li>').join('') + '</ul></details></details>';
  }).join('');
  detail.innerHTML = '<h2>' + escape(s.testId) + '</h2><div class="pair">' +
    entry('Pallet',s.manifest?.pallet) + entry('Pallet EPC',s.manifest?.palletEpc) +
    entry('Session',s.id) + entry('Location / level',s.location + ' / ' + s.level) +
    entry('Product mix',s.product) + entry('Pallet type',s.palletType) +
    entry('Label setup',s.label + ' / ' + s.placement) + entry('Wrapping / shielding',s.wrapping + ' / ' + s.shielding) +
    entry('Scan method',s.method) + entry('Created',time(s.createdAt)) + entry('Verified by',s.verifiedBy) +
    entry('Sign-off',s.closure?.actor) + entry('Coverage',s.closure?.coverage) + entry('Setup notes',s.notes) +
    '</div><details class="line"><summary>Manifest and planned evidence</summary>' +
    entry('Source',s.manifest?.source) + entry('Revision',s.manifest?.revision) + entry('Planned test',s.planned) +
    '<ul class="log">' + (s.manifest?.cartons ?? []).map(c => '<li>' + escape(c.carton) + ' / ' + escape(c.sku) + '<br><code>' + escape(c.epc) + '</code></li>').join('') +
    '</ul></details><h3 class="line">Scan attempts</h3>' + (runs || '<p>No recorded attempts.</p>') +
    '<h3 class="line">Activity log</h3><ul class="log">' + s.logs.slice().reverse().map(log => '<li><strong>' + escape(log.action) +
      '</strong><br>' + escape(log.detail) + '<br><small>' + escape(log.actor) + ' / ' + escape(time(log.at)) + '</small></li>').join('') + '</ul>';
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
      records = store.sessions;
      previousBody = body;
      render();
    }
    refreshed = new Date();
    status.className = 'status match';
    status.textContent = 'Handheld online. Refreshed ' + refreshed.toLocaleTimeString() + '.';
  } catch {
    status.className = 'status hold';
    status.textContent = refreshed ? 'Handheld offline. Showing records fetched at ' + refreshed.toLocaleTimeString() + '.' :
      'Handheld unreachable. Check sharing and the network, then refresh.';
  } finally {
    inFlight = false;
    refresh.disabled = false;
  }
}
search.addEventListener('input',render);
sessions.addEventListener('click',event => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  selected = button.dataset.id;
  render();
  [...sessions.querySelectorAll('button')].find(item => item.dataset.id === selected)?.focus();
});
refresh.addEventListener('click',fetchRecords);
fetchRecords();
setInterval(fetchRecords, 5000);
