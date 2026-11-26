// Change this mapping when Keypharm supplies the real manifest contract.
export const SAMPLE = `pallet_ref,pallet_epc,carton_ref,carton_epc,sku
KP-DEMO-01,A00000000000000000000001,Carton 01,C00000000000000000000001,Ginger
KP-DEMO-01,A00000000000000000000001,Carton 02,C00000000000000000000002,Ginger
KP-DEMO-01,A00000000000000000000001,Carton 03,C00000000000000000000003,Essential oil
KP-DEMO-01,A00000000000000000000001,Carton 04,C00000000000000000000004,Physalis
`;
export const EXTRA_EPC = 'E00000000000000000000009';
const columns = ['pallet_ref', 'pallet_epc', 'carton_ref', 'carton_epc', 'sku'];
// Excel saves ';' instead of ',' in Dutch and Belgian locales; the header decides which one the file uses.
const csvLine = sep => new RegExp('(?:^|' + sep + ')(?:"((?:[^"]|"")*)"|([^"' + sep + ']*))(?=' + sep + '|$)', 'g');
export const normalizeEpc = value => String(value ?? '').trim().toUpperCase();
export const productSku = value => value === 'Juice' ? 'Physalis' : value;

export const demoSku = sku => ({Physalis:'DEMO-PHY','Tiger Balm':'DEMO-TB',Biotona:'DEMO-BIO'})[sku] ?? sku;

export function receiptProducts(task) {
  const quantities = task.quantities ?? Object.fromEntries([...new Set(task.expected.map(carton => carton.sku))]
    .map(sku => [sku,task.expected.filter(carton => carton.sku === sku).length]));
  const identifiers = task.identifiers ?? Object.entries(quantities).map(([sku]) => [sku,sku]);
  return identifiers.map(([identifier,sku]) => ({identifier,sku,remaining:quantities[sku] - (task.receivedBySku?.[sku] ??
    task.expected.filter(carton => carton.sku === sku && task.received.includes(carton.epc)).length)}));
}
export const validEpc = value => /^(?:[0-9A-F]{2}){2,31}$/.test(value);
function cells(line, row, sep, size = columns.length) {
  const parts = [...line.matchAll(csvLine(sep))];
  if (parts.map(p => p[0]).join('') !== line || parts.length !== size) {
    throw new Error('Row ' + row + ': expected ' + (size === 5 ? 'five' : size) + ' CSV fields.');
  }
  return parts.map(p => (p[1]?.replaceAll('""', '"') ?? p[2]).trim());
}

export function parseCsvRows(text, headers) {
  if (typeof text !== 'string') throw new Error('Choose a CSV.');
  const [header,...rows] = text.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
  const sep = [',',';'].find(value => header.toLowerCase().split(value).map(col => col.trim()).join() === headers.join());
  if (!sep || !rows.length) throw new Error('Use the template headers and at least one data row.');
  return rows.map((line,index) => cells(line,index + 2,sep,headers.length));
}

// Manifest built on the handheld from one scan: the chosen pallet tag, every other kept EPC as a numbered carton.
export function manifestCsv(palletRef, palletEpc, epcs, sku = '') {
  const ref = String(palletRef ?? '').trim(), item = String(sku ?? '').trim(), pallet = normalizeEpc(palletEpc);
  if (/[,;"]/.test(ref + item)) throw new Error('Pallet reference and SKU cannot contain commas, semicolons or quotes.');
  // Excel would run a cell starting with = + @ - as a formula when the saved CSV is opened.
  if ([ref, item].some(v => /^[=+@\-\t\r\n]/.test(v))) throw new Error('Pallet reference and SKU cannot start with = + @ or -.');
  if (!ref) throw new Error('Enter a pallet reference.');
  if (!pallet) throw new Error('Choose the pallet tag.');
  const cartons = [...new Set(epcs.map(normalizeEpc))].filter(epc => epc && epc !== pallet).sort();
  if (!cartons.length) throw new Error('Keep at least one carton tag besides the pallet tag.');
  return ['pallet_ref,pallet_epc,carton_ref,carton_epc,sku', ...cartons.map((epc,i) =>
    [ref, pallet, 'Carton ' + String(i + 1).padStart(2,'0'), epc, item].join(','))].join('\n') + '\n';
}
export function parseManifest(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const header = lines.shift().toLowerCase();
  const sep = [',', ';'].find(s => header.split(s).map(h => h.trim()).join() === columns.join());
  if (!sep) throw new Error('Use the five headers from the sample CSV, separated by commas or semicolons.');
  if (!lines.length) throw new Error('Manifest needs at least one carton.');
  // One file may list several pallets; the scan later locks to one of them (see lockPallet).
  const pallets = new Map(), palletRefs = new Map();
  const epcs = new Set();
  const references = new Set();
  const errors = [];
  for (const [index, line] of lines.entries()) {
    const row = index + 2;
    // Excel leaves rows such as ";;;;" after the data.
    if (!line.replace(new RegExp('[\\s"' + sep + ']', 'g'), '')) continue;
    try {
      const [pallet, palletTag, carton, tag, sku] = cells(line, row, sep);
      const palletEpc = normalizeEpc(palletTag), epc = normalizeEpc(tag);
      if (!pallet || !carton) throw new Error('Row ' + row + ': provide pallet and carton references.');
      if (!validEpc(palletEpc) || !validEpc(epc)) throw new Error('Row ' + row + ': EPC must be even-length hexadecimal.');
      if (epc === palletEpc || epcs.has(epc) || palletRefs.has(epc)) throw new Error('Row ' + row + ': duplicate EPC.');
      if (references.has(carton.toUpperCase())) throw new Error('Row ' + row + ': duplicate carton reference.');
      let entry = pallets.get(pallet);
      if (entry && entry.palletEpc !== palletEpc) throw new Error('Row ' + row + ': pallet ' + pallet + ' already has another pallet EPC.');
      if (!entry) {
        if (palletRefs.has(palletEpc) || epcs.has(palletEpc)) throw new Error('Row ' + row + ': pallet EPC is already used in this file.');
        entry = {pallet, palletEpc, cartons: []};
        pallets.set(pallet, entry);
        palletRefs.set(palletEpc, pallet);
      }
      epcs.add(epc);
      references.add(carton.toUpperCase());
      entry.cartons.push({epc, carton, sku:productSku(sku)});
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length) {
    // ponytail: first 20 rows only, so a wrong file does not flood the screen.
    const more = errors.length > 20 ? ['\u2026and ' + (errors.length - 20) + ' more rows.'] : [];
    throw new Error([...errors.slice(0, 20), ...more].join('\n'));
  }
  const list = [...pallets.values()];
  if (!list.length) throw new Error('Manifest needs at least one carton.');
  // A single-pallet file is already locked; a multi-pallet file has no expected cartons until the scan locks one.
  return list.length === 1 ? {...list[0], pallets:list} :
    {pallet:'Any of ' + list.length + ' pallets', palletEpc:'', cartons:[], pallets:list};
}

const palletsOf = m => m?.pallets?.length ? m.pallets : (m ? [m] : []);
const manifestCartons = m => palletsOf(m).flatMap(pallet => pallet.cartons ?? []);
export function outboundManifestConflict(manifest,inventory,sessions,currentId) {
  const expected = new Set(manifestCartons(manifest).map(carton => carton.epc));
  const shipped = new Set(inventory.filter(carton => carton.state === 'dispatched' && expected.has(carton.epc)).map(carton => carton.epc));
  if (shipped.size) {
    const refs = sessions.filter(session => session.dispatchedAt && manifestCartons(session.manifest).some(carton => shipped.has(carton.epc)))
      .map(session => session.testId);
    return 'This manifest contains cartons already dispatched' + (refs.length ? ' under ' + refs.join(', ') : '') +
      '. Change the CSV to use cartons currently on hand.';
  }
  const assigned = sessions.filter(session => session.id !== currentId && !session.dispatchedAt &&
    manifestCartons(session.manifest).some(carton => expected.has(carton.epc)))
    .map(session => session.testId);
  if (assigned.length) return 'This manifest contains cartons assigned to ' + assigned.join(', ') +
    '. Open or reopen the existing session to continue verification, or change the CSV if the assignment is a mistake.';
  return '';
}
const tagsOf = p => [p.palletEpc, ...p.cartons.map(c => c.epc)];
export const inManifest = (manifest, epc) => palletsOf(manifest).some(p => tagsOf(p).includes(epc));

// Any tag of a pallet (its pallet tag or a carton) can lock it; the pallet with the strongest RSSI wins,
// then the one with more tags read. ponytail: RSSI from one short read, raise power or move closer if the wrong pallet wins.
export function lockPallet(manifest, observations) {
  let best = null;
  for (const pallet of palletsOf(manifest)) {
    const seen = tagsOf(pallet).filter(epc => observations[epc]);
    if (!seen.length) continue;
    const rssi = Math.max(...seen.map(epc => parseFloat(observations[epc].rssi)).filter(Number.isFinite));
    if (!best || rssi > best.rssi || (rssi === best.rssi && seen.length > best.seen)) best = {pallet, rssi, seen:seen.length};
  }
  return best;
}
// FR-04: a blank SKU is allowed but shown before scanning. Ambiguous mappings (one carton reference twice) are rejected by parseManifest.
export function missingSku(m) {
  const pallets = m?.palletEpc ? [m] : (m?.pallets ?? []);
  return pallets.flatMap(p => p.cartons.filter(c => !c.sku).map(c => (pallets.length > 1 ? p.pallet + ' / ' : '') + c.carton));
}
// Section 13 recovery: a session is unexported until an export follows its last logged change (ISO times compare as text).
export const unexported = s => !s.exportedAt || (s.logs.at(-1)?.at ?? '') > s.exportedAt;
// FR-33: every search term must appear in the test, pallet, carton, SKU, location, level, people, date or status text.
export function matchesQuery(s, query, status = '') {
  const text = [s.testId, s.location, s.level, s.product, s.creator, s.createdAt?.slice(0,10), status,
    ...palletsOf(s.manifest).flatMap(p => [p.pallet, ...p.cartons.flatMap(c => [c.carton, c.sku])]),
    ...s.runs.map(run => run.operator)].join(' ').toLowerCase();
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).every(term => text.includes(term));
}
// AT-02: expected, matched and missing cartons per SKU for one run; SKU never replaces the EPC identity.
export function skuBreakdown(manifest, result) {
  const matched = new Set(result.matched), rows = new Map();
  for (const c of manifest.cartons) {
    const sku = c.sku || 'No SKU', row = rows.get(sku) ?? {sku, expected:0, matched:0, missing:0};
    row.expected++;
    if (matched.has(c.epc)) row.matched++; else row.missing++;
    rows.set(sku, row);
  }
  return [...rows.values()];
}
// Section 9.3 lists "Unexpected reads" as its own state; FR-15 calls it Hold. Show both.
export const statusLabel = status => status === 'Hold' ? 'Hold: unexpected reads' : status;
export const pendingPallet = session => session.manifest?.pallets?.find(pallet => !session.palletMatches?.[pallet.palletEpc]);
export const lockTo = (manifest, pallet) => ({...manifest, pallet:pallet.pallet, palletEpc:pallet.palletEpc, cartons:pallet.cartons});
// The other loaded pallet an unexpected EPC belongs to, if any.
export const otherPallet = (manifest, epc) =>
  palletsOf(manifest).find(p => p.palletEpc !== manifest.palletEpc && tagsOf(p).includes(epc))?.pallet;

export function compare(manifest, observed) {
  const expected = new Set(manifest.cartons.map(c => c.epc));
  const seen = new Set(observed.map(normalizeEpc).filter(epc => epc && epc !== manifest.palletEpc));
  const matched = [...expected].filter(epc => seen.has(epc));
  const missing = [...expected].filter(epc => !seen.has(epc));
  const extra = [...seen].filter(epc => !expected.has(epc));
  const percent = expected.size ? Math.round(matched.length * 1000 / expected.size) / 10 : null;
  const status = extra.length ? 'Hold' : (missing.length || !expected.size ? 'Incomplete' : 'Match');
  return {expected: expected.size, matched, missing, extra, percent, status};
}

export function scanDelta(previous, current) {
  const previouslyMissing = new Set(previous.missing);
  return {
    newlySeen: current.matched.filter(epc => previouslyMissing.has(epc)),
    stillMissing: current.missing.filter(epc => previouslyMissing.has(epc))
  };
}

export const isCurrentManifestRun = (session, run) =>
  Boolean(run && (run.manifestRevision ?? 1) === (session?.manifest?.revision ?? 1));

export function canContinue(session, run) {
  return Boolean(session?.verifiedBy && session.identified && !session.closedAt &&
    isCurrentManifestRun(session,run) && run.state === 'Finished' && run.result?.status === 'Match');
}

export const roles = {admin:'Administrator', operator:'Operator', supervisor:'Supervisor', reviewer:'Reviewer'};
const actions = {
  create: ['admin','operator'], manifest: ['admin'], 'reader-power': ['admin'], verify: ['supervisor'],
  scan: ['operator','admin'], confirm: ['operator','admin'], close: ['operator','admin','supervisor'],
  investigate: ['operator','admin','supervisor'], export: ['admin','operator','supervisor']
};
export const permits = (role, action) => actions[action]?.includes(role) ?? false;
export function allocationTotal(allocation) {
  const values = ['cartons','pallets','reserves','candidates'].map(key => allocation[key] ?? 0);
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Enter whole label counts of zero or more.');
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total > 500) throw new Error('POC label allocation cannot exceed 500.');
  return total;
}

export function canClose(session, review, role) {
  return Boolean(permits(role, 'close') && session && !session.closedAt && session.runs.some(run =>
    run.state === 'Finished' || run.state === 'Interrupted') && review.reviewed && review.coverage?.trim());
}

export function dashboardSnapshot(store, includeOtherRecords = false) {
  const demoManifest = m => m?.demo === true || (m?.demo == null && m?.source === 'Demo sample CSV');
  const sessions = store.sessions.filter(s => includeOtherRecords || (s.source === 'Simulation' &&
    demoManifest(s.manifest) && (s.manifestRevisions ?? []).every(demoManifest)));
  return {sessions:sessions.map(({palletPending,...s}) => {
    const pending = new Set(s.runs.filter(run => run.state === 'Reading').map(run => run.id));
    if (palletPending) pending.add(palletPending.id);
    return {...s, runs:s.runs.filter(run => !pending.has(run.id)), logs:s.logs.filter(log => !pending.has(log.run))};
  })};
}

const csvCell = value => {
  let str = String(value ?? '');
  // Plain numbers such as RSSI -55 are not formulas; keep them numeric for Excel.
  if (!/^-?\d+(\.\d+)?$/.test(str) && (/^[\s\u0000-\u001f]*[=+@-]/.test(str) || /^[\t\r\n]/.test(str))) str = "'" + str;
  return '"' + str.replaceAll('"', '""') + '"';
};
export function evidenceCsv(store) {
  const rows = [['Record type','Session ID','Test ID','Pallet','Run ID','Time','Operator','Status','Expected','Matched','Missing','Extra','Completeness %','EPC','Details']];
  for (const s of store.sessions) {
    const identity = [s.id,s.testId,s.manifest?.pallet];
    rows.push(['Session',...identity,'',s.createdAt,s.creator,s.closedAt ? 'Closed' : 'Open','','','','','','',JSON.stringify({...s, runs:undefined, logs:undefined, manifest:undefined})]);
    if (s.manifest) rows.push(['Manifest',...identity,'',s.manifest.importedAt,'','Revision ' + s.manifest.revision,'','','','','',s.manifest.palletEpc,s.manifest.source]);
    for (const pallet of palletsOf(s.manifest)) {
      for (const c of pallet.cartons ?? []) rows.push(['Manifest carton',s.id,s.testId,pallet.pallet,'','','','','','','','','',c.epc,JSON.stringify(c)]);
    }
    for (const run of s.runs) {
      const r = run.result ?? {}, m = manifestFor(s,run);
      const runIdentity = [s.id,s.testId,m?.pallet];
      rows.push(['Run',...runIdentity,run.id,run.endedAt,run.operator,run.state === 'Finished' ? r.status : run.state,r.expected,r.matched?.length,r.missing?.length,r.extra?.length,r.percent,'',JSON.stringify({...run, observations:undefined})]);
      for (const [epc,read] of Object.entries(run.observations)) rows.push(['RFID observation',...runIdentity,run.id,read.first,run.operator,
        epc === m?.palletEpc ? 'Pallet' : (r.matched?.includes(epc) ? 'Matched' : 'Unexpected'),'','','','','',epc,JSON.stringify(read)]);
      for (const epc of r.missing ?? []) rows.push(['Missing EPC',...runIdentity,run.id,run.endedAt,run.operator,'Missing','','','','','',epc,'']);
    }
    for (const log of s.logs) rows.push(['Log',...identity,log.run ?? '',log.at,log.actor,'','','','','','','',log.action + ': ' + (log.detail ?? '')]);
  }
  // FR-35: device-wide changes that have no session, such as reader power set from the home screen.
  for (const log of store.audit ?? []) rows.push(['Device log','','','','',log.at,log.actor,'','','','','','','',log.action + ': ' + (log.detail ?? '')]);
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// Functional design section 8 "Recommended export columns", then per-EPC read diagnostics.
export const EXPORT_COLUMNS = ['SessionID','Mode','TransactionRef','PalletRef','TestID','RunID','RunType','RunStart','RunEnd',
  'DurationSeconds','Location','StorageLevel','SKU','CartonRef','ExpectedEPC','ObservedEPC','Classification','ReaderModel','DeviceID',
  'RegionProfile','PowerSetting','ScanMethod','LabelType','LabelPosition','ShieldingStatus','CompletenessPct','ResultStatus',
  'ExceptionCode','Operator','Reviewer','Disposition','Notes','ReadCount','FirstSeen','LastSeen','RSSI','ProfileVersion'];
export function specEvidenceCsv(store) {
  const rows = [EXPORT_COLUMNS];
  for (const s of store.sessions) {
    const firstPassByPallet = new Set();
    s.runs.filter(run => run.result).forEach(run => {
      const r = run.result, p = run.profile ?? {}, m = manifestFor(s, run);
      const key = m?.palletEpc;
      const rescan = firstPassByPallet.has(key);
      firstPassByPallet.add(key);
      const cartons = new Map((m?.cartons ?? []).map(c => [c.epc, c]));
      const notes = s.logs.filter(log => log.run === run.id && log.action === 'Run note').map(log => log.detail);
      // Latest investigation per EPC; the handheld logs "Unexpected EPC <outcome>" with "<epc> / <note>".
      const disposition = new Map();
      for (const log of s.logs) if (log.run === run.id && log.action?.startsWith('Unexpected EPC ')) {
        const [epc, ...note] = String(log.detail ?? '').split(' / ');
        const outcome = log.action.slice('Unexpected EPC '.length);
        disposition.set(epc, {outcome:outcome.charAt(0).toUpperCase() + outcome.slice(1), note:note.join(' / ')});
      }
      const row = (epc, classification, expected, observed, code, note) => {
        const c = cartons.get(epc), read = run.observations[epc], d = disposition.get(epc);
        return [s.id, s.mode ?? 'POC', '', m?.pallet, s.testId, run.id, rescan ? 'Rescan' : 'First pass',
          run.startedAt, run.endedAt, run.elapsedSeconds, s.location, s.level, c?.sku, c?.carton,
          expected ? epc : '', observed ? epc : '', classification, p.model ?? p.name, p.deviceId, p.region, p.powerDbm,
          run.method ?? s.method, s.label, s.placement, s.shielding, r.percent,
          run.state === 'Finished' ? r.status : run.state, code, run.operator, s.closure?.actor, d?.outcome,
          [note, run.reason && 'Rescan reason: ' + run.reason, d?.note, ...notes].filter(Boolean).join(' | '),
          read?.count, read?.first, read?.last, read?.rssi, p.version];
      };
      for (const c of m?.cartons ?? []) {
        const seen = r.matched.includes(c.epc);
        rows.push(row(c.epc, seen ? 'Matched' : 'Missing', true, seen, seen ? '' : 'MISSING_CARTON'));
      }
      for (const epc of r.extra) {
        const other = otherPallet(m, epc);
        rows.push(row(epc, 'Unexpected', false, true, other ? 'OTHER_PALLET_EPC' : 'UNEXPECTED_EPC', other && 'Belongs to pallet ' + other));
      }
      if (run.observations[m?.palletEpc]) rows.push(row(m.palletEpc, 'Pallet tag', false, true, ''));
    });
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function evidenceSummary(store) {
  const lines = ['Keypharm RFID POC — Evidence summary'];
  if (store.plan?.tests?.length) {
    const {tests, unplanned} = planCoverage(store.plan, store.sessions);
    lines.push('', 'Test plan' + (store.plan.closedAt ? ' (closed by ' + store.plan.closure.actor + ')' : ' (open)'));
    for (const t of tests) lines.push(t.id + ' ' + t.title + ': ' + t.status +
      (store.plan.closure?.skipped?.[t.id] ? ' — not run: ' + store.plan.closure.skipped[t.id] : ''));
    if (unplanned.length) lines.push('Not in plan: ' + unplanned.join(', '));
  }
  for (const s of store.sessions) {
    lines.push('', s.testId + ' / ' + (s.manifest?.pallet ?? 'Pallet pending'), 'Location: ' + s.location,
      'Status: ' + (s.closedAt ? 'Closed' : 'Open'), 'Coverage: ' + (s.closure?.coverage ?? 'Pending'));
    for (const [i,run] of s.runs.entries()) {
      const r = run.result;
      lines.push('Run ' + (i+1) + ' (' + run.source + '): ' + (run.state === 'Finished' ? r.status : run.state) +
        ' | ' + (r?.matched.length ?? 0) + '/' + (r?.expected ?? 0) + ' matched | ' +
        (r?.missing.length ?? 0) + ' missing | ' + (r?.extra.length ?? 0) + ' extra');
    }
  }
  lines.push(...configResults(store.sessions));
  if (store.audit?.length) lines.push('', 'Device log', ...store.audit.map(l => l.at + ' ' + l.actor + ': ' + l.action + ' ' + (l.detail ?? '')));
  return lines.join('\n') + '\n';
}
// Section 12: results per test configuration. Each session keeps its own first-pass and final figure; the
// first-pass range across sessions is the repeatability. Different products, labels or levels are never blended.
function configResults(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const runs = s.runs.filter(run => run.result);
    if (!runs.length) continue;
    const key = [s.product, s.label, s.placement, s.level, s.method, s.shielding].map(v => v || '—').join(' / ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({s, runs});
  }
  if (!groups.size) return [];
  const pct = r => r.percent == null ? '—' : r.percent + '%';
  const figure = r => pct(r) + ' (' + r.matched.length + '/' + r.expected + ')';
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const lines = ['', 'Results by configuration (product / label / position / level / method / shielding)'];
  for (const [key, entries] of groups) {
    const firsts = entries.map(e => e.runs[0].result.percent).filter(p => p != null);
    const low = Math.min(...firsts), high = Math.max(...firsts);
    lines.push(key + ': ' + plural(entries.length, 'session') + ', ' + plural(entries.reduce((n, e) => n + e.runs.length, 0), 'run') +
      (firsts.length ? ', first pass ' + (low === high ? low + '%' : low + '% to ' + high + '%') : ''));
    for (const {s, runs} of entries) lines.push('  ' + s.testId + ': first pass ' + figure(runs[0].result) + ', final ' +
      figure(runs.at(-1).result) + ', ' + plural(runs.length, 'run'));
  }
  return lines;
}

// A run is compared against the manifest revision that was current when it started (section 8 data rule).
export function manifestFor(s, run) {
  const manifest = [...(s.manifestRevisions ?? []), s.manifest].find(m => m && m.revision === run.manifestRevision) ?? s.manifest;
  const pallet = manifest?.pallets?.find(entry => entry.palletEpc === run.palletEpc);
  return pallet ? lockTo(manifest,pallet) : manifest;
}

// One PoC test plan for the day: "TEST-ID description" per line. Records link to it by Test ID.
export function parsePlan(text) {
  const tests = [], ids = new Set();
  for (const line of String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    const [id, ...title] = line.split(/\s+/);
    if (ids.has(id.toUpperCase())) throw new Error('Duplicate planned test ' + id + '.');
    ids.add(id.toUpperCase());
    tests.push({id, title:title.join(' ')});
  }
  if (!tests.length) throw new Error('Enter at least one planned test, one per line.');
  return tests;
}
const sameTest = (a, b) => String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
export function planCoverage(plan, sessions) {
  const tests = (plan?.tests ?? []).map(t => {
    const records = sessions.filter(s => sameTest(s.testId, t.id));
    const status = records.some(s => s.closedAt) ? 'Done' : records.some(s => s.runs.length) ? 'In progress' : 'Not run';
    return {...t, status};
  });
  const unplanned = [...new Set(sessions.map(s => s.testId).filter(id => !tests.some(t => sameTest(t.id, id))))];
  return {tests, unplanned};
}
export function closePlanErrors(plan, sessions, skipped) {
  return planCoverage(plan, sessions).tests.flatMap(t =>
    t.status === 'In progress' ? [t.id + ': close the test first.'] :
    t.status === 'Not run' && !skipped[t.id]?.trim() ? [t.id + ': give a reason it was not run.'] : []);
}
