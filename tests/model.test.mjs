import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseManifest, compare, scanDelta, canContinue, permits, allocationTotal, canClose, dashboardSnapshot, evidenceCsv, specEvidenceCsv, evidenceSummary, EXPORT_COLUMNS, SAMPLE,
  parsePlan, planCoverage, closePlanErrors, manifestFor, lockPallet, lockTo, otherPallet, inManifest, manifestCsv,
  missingSku, unexported} from '../app/src/main/assets/model.mjs';

test('sample validates and pallet EPC is not a carton', () => {
  const manifest = parseManifest(SAMPLE);
  assert.equal(manifest.cartons.length, 4);
  const observed = [manifest.palletEpc, ...manifest.cartons.map(c => c.epc)];
  assert.equal(compare(manifest, [...observed, observed[1]]).status, 'Match');
});

test('reject duplicate, malformed and ambiguous manifest rows', () => {
  const lines = SAMPLE.trim().split('\n');
  assert.throws(() => parseManifest(SAMPLE + lines[1]), /row 6.*duplicate/i);
  assert.throws(() => parseManifest(SAMPLE.replace('C00000000000000000000001', 'oops')), /row 2.*EPC/i);
  assert.throws(() => parseManifest(lines[0]), /carton/i);
  assert.throws(() => parseManifest(SAMPLE.replace('Carton 04', 'Carton 01')), /row 5.*carton/i);
});

test('manifest import lists every bad row at once', () => {
  const bad = SAMPLE.replace('C00000000000000000000001', 'oops').replace('Carton 04', 'Carton 03');
  assert.throws(() => parseManifest(bad), error => /Row 2.*EPC/.test(error.message) && /Row 5.*carton/.test(error.message));
});

test('manifest import accepts Excel semicolons, header case and blank SKU', () => {
  const excel = SAMPLE.replaceAll(',', ';').replace('pallet_ref', 'Pallet_Ref').replace(';Pomegranate juice', ';') + ';;;;\n';
  const manifest = parseManifest(excel);
  assert.equal(manifest.cartons.length, 4);
  assert.equal(manifest.cartons[3].sku, '');
  assert.deepEqual(parseManifest(SAMPLE).cartons.map(c => c.epc), manifest.cartons.map(c => c.epc));
  assert.throws(() => parseManifest(SAMPLE.replace(',Carton 01,', ',,')), /Row 2.*carton/);
});

test('attempts remain independent and extras block even at full completeness', () => {
  const manifest = parseManifest(SAMPLE);
  const [a,b,c,d] = manifest.cartons.map(row => row.epc);
  const first = compare(manifest, [a,b,c]);
  const second = compare(manifest, [b,c,d]);
  assert.deepEqual(first.missing, [d]);
  assert.deepEqual(second.missing, [a]);
  const extra = compare(manifest, [a,b,c,d,'E00000000000000000000009']);
  assert.equal(extra.percent, 100);
  assert.equal(extra.status, 'Hold');
  const session = {verifiedBy: 'Supervisor', identified: true};
  const clean = compare(manifest, [a,b,c,d]);
  assert.equal(canContinue(session, {result: clean, state: 'Finished'}), true);
  for (const run of [{result: extra,state:'Finished'}, {result:clean,state:'Interrupted'}, {result:clean,state:'Reading'}]) {
    assert.equal(canContinue(session, run), false);
  }
  assert.equal(canContinue({...session, identified:false}, {result:clean,state:'Finished'}), false);
});

test('run comparison surfaces newly seen and still missing cartons without changing either result', () => {
  const manifest = parseManifest(SAMPLE);
  const [a,b,c,d] = manifest.cartons.map(row => row.epc);
  const previous = compare(manifest,[a,b]);
  const current = compare(manifest,[a,c]);
  assert.deepEqual(scanDelta(previous,current), {newlySeen:[c],stillMissing:[d]});
  assert.deepEqual(current.missing,[b,d]);
});

test('permission, cap and failed-test closure', () => {
  assert.equal(permits('reviewer', 'scan'), false);
  assert.equal(permits('operator', 'manifest'), false);
  assert.equal(permits('admin', 'manifest'), true);
  assert.equal(allocationTotal({cartons:498,pallets:1,reserves:1,candidates:0}), 500);
  assert.throws(() => allocationTotal({cartons:501}), /500/);
  assert.throws(() => allocationTotal({cartons:-1}), /whole/);
  const session = {runs:[{state:'Interrupted'}], closedAt:null};
  assert.equal(canClose(session, {reviewed:true,coverage:'Skipped second test: no labels'}, 'operator'), true);
  assert.equal(canClose(session, {reviewed:false,coverage:'One of two'}, 'operator'), false);
  assert.equal(canClose(session, {reviewed:true,coverage:'One of two'}, 'reviewer'), false);
  assert.equal(canClose(session, {reviewed:true,coverage:'One of two'}, 'supervisor'), true);
  assert.equal(permits('supervisor','confirm'), false);
});

test('dashboard publishes committed evidence and defaults to sample sessions', () => {
  const demo = {source:'Simulation',manifest:{demo:true},palletPending:{id:'p'},runs:[{id:'a',state:'Reading'},{id:'b',state:'Finished'}],
    logs:[{run:'a'},{run:'p'},{run:'b'},{action:'Created'}]};
  const hardware = {source:'C72 hardware',runs:[],logs:[]};
  const store = {sessions:[demo,hardware]};
  assert.deepEqual(dashboardSnapshot(store).sessions,[{source:'Simulation',manifest:{demo:true},
    runs:[{id:'b',state:'Finished'}],logs:[{run:'b'},{action:'Created'}]}]);
  assert.equal(dashboardSnapshot(store,true).sessions.length,2);
  assert.equal(demo.runs.length,2);
});

test('evidence CSV carries logs, escapes quotes and neutralizes spreadsheet formulas', () => {
  const csv = evidenceCsv({sessions:[{id:'s1',testId:'=1+1',manifest:{},runs:[],logs:[{action:'review',detail:'said "ok"'}]}]});
  assert.match(csv, /"'=1\+1"/);
  assert.match(csv, /"review: said ""ok"""/);
});

test('spec evidence CSV uses the section 8 columns with one row per EPC per run', () => {
  const manifest = {...parseManifest(SAMPLE), revision:1};
  const [a,b,c,d] = manifest.cartons.map(row => row.epc);
  const x = 'E00000000000000000000009';
  const observations = epcs => Object.fromEntries(epcs.map(epc => [epc,{count:3,first:'t1',last:'t2',rssi:'-55'}]));
  const profile = {model:'C72',deviceId:'dev-1',region:'ETSI',powerDbm:30};
  const first = {id:'r1',state:'Finished',startedAt:'s1',endedAt:'e1',elapsedSeconds:12,operator:'Op',method:'Walk around',
    reason:'',profile,observations:observations([manifest.palletEpc,a,b,c,x]),result:compare(manifest,[manifest.palletEpc,a,b,c,x])};
  const second = {id:'r2',state:'Interrupted',startedAt:'s2',endedAt:'e2',elapsedSeconds:4,operator:'Op',method:'Walk around',
    reason:'Label repositioned',profile,observations:observations([a]),result:compare(manifest,[a])};
  const session = {id:'s1',mode:'POC',testId:'KP-1',location:'Dock',level:'Ground',label:'Paper',placement:'Upper right',
    shielding:'Shielded',manifest,runs:[first,second,{id:'r3',state:'Reading',observations:{}}],closure:{actor:'Lead'},
    logs:[{run:'r1',action:'Unexpected EPC removed from zone',detail:x + ' / Neighbour pallet'}]};
  const [header,...rows] = specEvidenceCsv({sessions:[session]}).replace(/^﻿/,'').trim().split('\r\n')
    .map(line => line.split('","').map(cell => cell.replace(/^"|"$/g,'')));
  assert.deepEqual(header.slice(0,32), ['SessionID','Mode','TransactionRef','PalletRef','TestID','RunID','RunType','RunStart','RunEnd',
    'DurationSeconds','Location','StorageLevel','SKU','CartonRef','ExpectedEPC','ObservedEPC','Classification','ReaderModel','DeviceID',
    'RegionProfile','PowerSetting','ScanMethod','LabelType','LabelPosition','ShieldingStatus','CompletenessPct','ResultStatus',
    'ExceptionCode','Operator','Reviewer','Disposition','Notes']);
  assert.deepEqual(header, EXPORT_COLUMNS);
  const col = name => header.indexOf(name);
  const r1 = rows.filter(row => row[col('RunID')] === 'r1');
  assert.equal(r1.length, 6);
  const byEpc = epc => r1.find(row => row[col('ExpectedEPC')] === epc || row[col('ObservedEPC')] === epc);
  assert.deepEqual([byEpc(a)[col('Classification')],byEpc(a)[col('ExpectedEPC')],byEpc(a)[col('ObservedEPC')],byEpc(a)[col('SKU')]],
    ['Matched',a,a,'Ginger']);
  assert.deepEqual([byEpc(d)[col('Classification')],byEpc(d)[col('ObservedEPC')],byEpc(d)[col('ExceptionCode')]],['Missing','','MISSING_CARTON']);
  assert.deepEqual([byEpc(x)[col('Classification')],byEpc(x)[col('ExpectedEPC')],byEpc(x)[col('Disposition')],byEpc(x)[col('Notes')]],
    ['Unexpected','','Removed from zone','Neighbour pallet']);
  assert.equal(byEpc(manifest.palletEpc)[col('Classification')],'Pallet tag');
  assert.deepEqual([r1[0][col('RunType')],r1[0][col('ResultStatus')],r1[0][col('CompletenessPct')],r1[0][col('PowerSetting')],
    r1[0][col('Reviewer')],r1[0][col('ReadCount')],r1[0][col('RSSI')]],['First pass','Hold','75','30','Lead','3','-55']);
  const r2 = rows.filter(row => row[col('RunID')] === 'r2');
  assert.equal(r2.length, 4);
  assert.deepEqual([r2[0][col('RunType')],r2[0][col('ResultStatus')],r2[0][col('Notes')]],['Rescan','Interrupted','Rescan reason: Label repositioned']);
  assert.equal(rows.some(row => row[col('RunID')] === 'r3'), false);
});

test('formula guard still neutralizes formulas but keeps negative numbers', () => {
  const csv = evidenceCsv({sessions:[{id:'-1+2',testId:'-55',manifest:{},runs:[],logs:[]}]});
  assert.match(csv, /"'-1\+2"/);
  assert.match(csv, /"-55"/);
});

test('test plan parses one test per line and reports coverage, skips and unplanned tests', () => {
  const tests = parsePlan('KP-01 Ginger pallet\n\n  KP-02 Mixed pallet  \nKP-03');
  assert.deepEqual(tests, [{id:'KP-01',title:'Ginger pallet'},{id:'KP-02',title:'Mixed pallet'},{id:'KP-03',title:''}]);
  assert.throws(() => parsePlan('KP-01 a\nkp-01 b'), /duplicate/i);
  assert.throws(() => parsePlan('  \n'), /at least one/i);
  const sessions = [{testId:'kp-01',runs:[{}],closedAt:'t'}, {testId:'KP-02',runs:[{}]}, {testId:'KP-02',runs:[]}, {testId:'EXTRA',runs:[]}];
  const plan = {tests};
  const coverage = planCoverage(plan, sessions);
  assert.deepEqual(coverage.tests.map(t => t.status), ['Done','In progress','Not run']);
  assert.deepEqual(coverage.unplanned, ['EXTRA']);
  assert.deepEqual(closePlanErrors(plan, sessions, {}), ['KP-02: close the test first.', 'KP-03: give a reason it was not run.']);
  assert.deepEqual(closePlanErrors(plan, sessions.slice(0,1), {'KP-02':'No labels', 'KP-03':'Out of time'}), []);
});

test('manifest revisions after a scan keep earlier runs on their own manifest in the export', () => {
  const first = {...parseManifest(SAMPLE), revision:1};
  const [a,b,c,d] = first.cartons.map(row => row.epc);
  const second = {...first, revision:2, cartons:first.cartons.slice(0,3)};
  const observations = epcs => Object.fromEntries(epcs.map(epc => [epc,{count:1,first:'t',last:'t'}]));
  const run1 = {id:'r1',state:'Finished',manifestRevision:1,observations:observations([a,b,c]),result:compare(first,[a,b,c])};
  const run2 = {id:'r2',state:'Finished',manifestRevision:2,observations:observations([a,b,c]),result:compare(second,[a,b,c])};
  const session = {id:'s',testId:'KP-1',manifest:second,manifestRevisions:[first],runs:[run1,run2],
    logs:[{run:'r2',action:'Run note',detail:'Carton 04 was never loaded'}]};
  assert.equal(manifestFor(session, run1), first);
  assert.equal(manifestFor(session, run2), second);
  const rows = specEvidenceCsv({sessions:[session]}).trim().split('\r\n').slice(1);
  assert.equal(rows.filter(row => row.includes('"r1"')).length, 4);
  assert.equal(rows.filter(row => row.includes('"r2"')).length, 3);
  assert.ok(rows.some(row => row.includes('"r1"') && row.includes(d) && row.includes('MISSING_CARTON')));
  assert.ok(rows.filter(row => row.includes('"r2"')).every(row => row.includes('Carton 04 was never loaded')));
  assert.match(evidenceSummary({sessions:[], plan:{tests:[{id:'KP-1',title:'x'}]}}), /KP-1.*Not run/);
});

const MULTI = 'pallet_ref;pallet_epc;carton_ref;carton_epc;sku\r\n' +
  'PAL-A;A1A1;A-01;C0A1;x\r\nPAL-A;A1A1;A-02;C0A2;x\r\nPAL-B;B1B1;B-01;C0B1;y\r\n';

test('one CSV can hold several pallets and EPCs stay unique across the file', () => {
  const m = parseManifest(MULTI);
  assert.deepEqual(m.pallets.map(p => [p.pallet, p.palletEpc, p.cartons.length]), [['PAL-A','A1A1',2],['PAL-B','B1B1',1]]);
  assert.deepEqual([m.palletEpc, m.cartons.length], ['', 0]);
  const single = parseManifest(SAMPLE);
  assert.deepEqual([single.pallets.length, single.cartons.length, single.palletEpc], [1, 4, 'A00000000000000000000001']);
  assert.throws(() => parseManifest(MULTI.replace('C0B1', 'C0A1')), /Row 4.*duplicate EPC/);
  assert.throws(() => parseManifest(MULTI.replace('PAL-A;A1A1;A-02', 'PAL-A;A2A2;A-02')), /Row 3.*PAL-A/);
  assert.throws(() => parseManifest(MULTI.replace('PAL-B;B1B1', 'PAL-B;A1A1')), /Row 4.*pallet EPC/);
  assert.throws(() => parseManifest(MULTI.replace('B-01;C0B1', 'B-01;A1A1')), /Row 4.*duplicate EPC/);
});

test('strongest signal locks the pallet, and a carton read first locks its own pallet', () => {
  const m = parseManifest(MULTI);
  const lock = lockPallet(m, {C0A1:{rssi:'-60'}, B1B1:{rssi:'-41.5'}, FFFF:{rssi:'-30'}});
  assert.deepEqual([lock.pallet.pallet, lock.rssi, lock.seen], ['PAL-B', -41.5, 1]);
  assert.equal(lockPallet(m, {C0A2:{rssi:'-70'}}).pallet.pallet, 'PAL-A');
  assert.equal(lockPallet(m, {C0A1:{count:1}, C0A2:{count:1}, B1B1:{count:1}}).pallet.pallet, 'PAL-A');
  assert.equal(lockPallet(m, {FFFF:{rssi:'-20'}}), null);
  assert.equal(lockPallet(parseManifest(SAMPLE), {C00000000000000000000002:{}}).pallet.pallet, 'KP-DEMO-01');
  assert.equal(inManifest(m, 'C0B1'), true);
  assert.equal(inManifest(m, 'FFFF'), false);

  const locked = lockTo(m, m.pallets[0]);
  assert.deepEqual([locked.pallet, locked.palletEpc, locked.cartons.length, locked.pallets.length], ['PAL-A','A1A1',2,2]);
  const r = compare(locked, ['A1A1','C0A1','C0A2','C0B1','B1B1','FFFF']);
  assert.deepEqual([r.matched.length, r.extra, r.status], [2, ['C0B1','B1B1','FFFF'], 'Hold']);
  assert.deepEqual(['C0B1','B1B1','FFFF','C0A1'].map(epc => otherPallet(locked, epc)), ['PAL-B','PAL-B',undefined,undefined]);

  const observations = Object.fromEntries(['C0A1','C0A2','C0B1','FFFF'].map(epc => [epc,{count:1}]));
  const session = {id:'s',testId:'T',manifest:{...locked, revision:1},logs:[],
    runs:[{id:'r1',state:'Finished',manifestRevision:1,observations,result:compare(locked,Object.keys(observations))}]};
  const rows = specEvidenceCsv({sessions:[session]}).trim().split('\r\n').slice(1);
  const other = rows.find(row => row.includes('"C0B1"'));
  assert.match(other, /OTHER_PALLET_EPC/);
  assert.match(other, /Belongs to pallet PAL-B/);
  assert.match(rows.find(row => row.includes('"FFFF"')), /UNEXPECTED_EPC/);
});

test('manifest built from a scan: chosen pallet tag, the rest become numbered cartons, and it parses back', () => {
  const csv = manifestCsv('PAL-C72-03', 'aa01', ['CC02', 'aa01', 'cc01', 'CC01'], 'Ginger 50ml');
  const m = parseManifest(csv);
  assert.equal(m.pallet, 'PAL-C72-03');
  assert.equal(m.palletEpc, 'AA01');
  assert.deepEqual(m.cartons.map(c => [c.carton, c.epc, c.sku]), [['Carton 01', 'CC01', 'Ginger 50ml'], ['Carton 02', 'CC02', 'Ginger 50ml']]);
  assert.throws(() => manifestCsv('PAL', '', ['CC01']), /pallet tag/);
  assert.throws(() => manifestCsv('PAL', 'AA01', ['AA01']), /carton/);
  assert.throws(() => manifestCsv('PAL;1', 'AA01', ['CC01']), /commas/);
  assert.throws(() => manifestCsv('=HYPERLINK(1)', 'AA01', ['CC01']), /start with/);
  assert.throws(() => manifestCsv('PAL', 'AA01', ['CC01'], '@SUM(1)'), /start with/);
});


test('cartons without a SKU are listed before scanning, per locked pallet or across a multi-pallet file (FR-04)', () => {
  assert.deepEqual(missingSku(parseManifest(SAMPLE)), []);
  assert.deepEqual(missingSku(parseManifest(SAMPLE.replace(',Pomegranate juice', ','))), ['Carton 04']);
  const multi = parseManifest('pallet_ref,pallet_epc,carton_ref,carton_epc,sku\nP1,AA01,C1,CC01,\nP1,AA01,C2,CC02,Ginger\nP2,AA02,C3,CC03,\n');
  assert.deepEqual(missingSku(multi), ['P1 / C1', 'P2 / C3']);
  assert.deepEqual(missingSku(lockTo(multi, multi.pallets[1])), ['C3']);
  assert.deepEqual(missingSku(undefined), []);
});

test('a session counts as unexported until an export follows its last logged change (section 13 recovery)', () => {
  const s = {logs:[{at:'2026-11-24T10:00:00.000Z'}]};
  assert.equal(unexported(s), true);
  assert.equal(unexported({...s, exportedAt:'2026-11-24T10:05:00.000Z'}), false);
  assert.equal(unexported({logs:[...s.logs, {at:'2026-11-24T10:06:00.000Z'}], exportedAt:'2026-11-24T10:05:00.000Z'}), true);
});

test('each export row carries the reader profile version of its run (section 9.1)', () => {
  const manifest = {...parseManifest(SAMPLE), revision:1};
  const run = {id:'r1',state:'Finished',observations:{},profile:{region:'ETSI',powerDbm:30,version:'C72-ETSI-1'},result:compare(manifest,[])};
  const [header,row] = specEvidenceCsv({sessions:[{id:'s',testId:'T',manifest,runs:[run],logs:[]}]}).replace(/^﻿/,'').trim().split('\r\n')
    .map(line => line.split('","').map(cell => cell.replace(/^"|"$/g,'')));
  assert.equal(header.at(-1), 'ProfileVersion');
  assert.equal(row[header.indexOf('ProfileVersion')], 'C72-ETSI-1');
});
