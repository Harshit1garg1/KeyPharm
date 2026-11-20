// Change this mapping when Keypharm supplies the real manifest contract.
export const SAMPLE = `pallet_ref,pallet_epc,carton_ref,carton_epc,sku
KP-DEMO-01,A00000000000000000000001,Carton 01,C00000000000000000000001,Ginger
KP-DEMO-01,A00000000000000000000001,Carton 02,C00000000000000000000002,Ginger
KP-DEMO-01,A00000000000000000000001,Carton 03,C00000000000000000000003,Essential oil
KP-DEMO-01,A00000000000000000000001,Carton 04,C00000000000000000000004,Pomegranate juice
`;
export const EXTRA_EPC = 'E00000000000000000000009';
const columns = ['pallet_ref', 'pallet_epc', 'carton_ref', 'carton_epc', 'sku'];
const csvLine = /(?:^|,)(?:"((?:[^"]|"")*)"|([^",]*))(?=,|$)/g;
export const normalizeEpc = value => String(value ?? '').trim().toUpperCase();
const validEpc = value => /^(?:[0-9A-F]{2}){2,31}$/.test(value);
function cells(line, row) {
  const parts = [...line.matchAll(csvLine)];
  if (parts.map(p => p[0]).join('') !== line || parts.length !== columns.length) {
    throw new Error('Row ' + row + ': expected five CSV fields.');
  }
  return parts.map(p => (p[1]?.replaceAll('""', '"') ?? p[2]).trim());
}

export function parseManifest(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.shift() !== columns.join(',')) throw new Error('Use the five headers from the sample CSV.');
  if (!lines.length) throw new Error('Manifest needs at least one carton.');
  let manifest;
  const epcs = new Set();
  const references = new Set();
  for (const [index, line] of lines.entries()) {
    const row = index + 2;
    const [pallet, palletTag, carton, tag, sku] = cells(line, row);
    const palletEpc = normalizeEpc(palletTag), epc = normalizeEpc(tag);
    if (!pallet || !carton || !sku) throw new Error('Row ' + row + ': provide pallet, carton and SKU references.');
    if (!validEpc(palletEpc) || !validEpc(epc)) throw new Error('Row ' + row + ': EPC must be even-length hexadecimal.');
    if (epc === palletEpc || epcs.has(epc)) throw new Error('Row ' + row + ': duplicate EPC.');
    if (references.has(carton.toUpperCase())) throw new Error('Row ' + row + ': duplicate carton reference.');
    manifest ??= {pallet, palletEpc, cartons: []};
    if (pallet !== manifest.pallet || palletEpc !== manifest.palletEpc) throw new Error('Row ' + row + ': use one pallet per file.');
    epcs.add(epc);
    references.add(carton.toUpperCase());
    manifest.cartons.push({epc, carton, sku});
  }
  return manifest;
}

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

export function canContinue(session, run) {
  return Boolean(session?.verifiedBy && session.identified && !session.closedAt &&
    run?.state === 'Finished' && run.result?.status === 'Match');
}

export const roles = {admin:'Test lead', operator:'Operator', supervisor:'Supervisor', reviewer:'Reviewer'};
const actions = {
  create: ['admin','operator'], manifest: ['admin'], verify: ['supervisor'],
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
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(str) || /^[\t\r\n]/.test(str)) str = "'" + str;
  return '"' + str.replaceAll('"', '""') + '"';
};
export function evidenceCsv(store) {
  const rows = [['Record type','Session ID','Test ID','Pallet','Run ID','Time','Operator','Status','Expected','Matched','Missing','Extra','Completeness %','EPC','Details']];
  for (const s of store.sessions) {
    const identity = [s.id,s.testId,s.manifest?.pallet];
    rows.push(['Session',...identity,'',s.createdAt,s.creator,s.closedAt ? 'Closed' : 'Open','','','','','','',JSON.stringify({...s, runs:undefined, logs:undefined, manifest:undefined})]);
    if (s.manifest) rows.push(['Manifest',...identity,'',s.manifest.importedAt,'','Revision ' + s.manifest.revision,'','','','','',s.manifest.palletEpc,s.manifest.source]);
    for (const c of s.manifest?.cartons ?? []) rows.push(['Manifest carton',...identity,'','','','','','','','','',c.epc,JSON.stringify(c)]);
    for (const run of s.runs) {
      const r = run.result ?? {};
      rows.push(['Run',...identity,run.id,run.endedAt,run.operator,run.state === 'Finished' ? r.status : run.state,r.expected,r.matched?.length,r.missing?.length,r.extra?.length,r.percent,'',JSON.stringify({...run, observations:undefined})]);
      for (const [epc,read] of Object.entries(run.observations)) rows.push(['RFID observation',...identity,run.id,read.first,run.operator,
        epc === s.manifest?.palletEpc ? 'Pallet' : (r.matched?.includes(epc) ? 'Matched' : 'Unexpected'),'','','','','',epc,JSON.stringify(read)]);
      for (const epc of r.missing ?? []) rows.push(['Missing EPC',...identity,run.id,run.endedAt,run.operator,'Missing','','','','','',epc,'']);
    }
    for (const log of s.logs) rows.push(['Log',...identity,log.run ?? '',log.at,log.actor,'','','','','','','',log.action + ': ' + (log.detail ?? '')]);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function evidenceSummary(store) {
  const lines = ['Keypharm RFID POC — Evidence summary'];
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
  return lines.join('\n') + '\n';
}
