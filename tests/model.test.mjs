import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseManifest, compare, scanDelta, canContinue, permits, allocationTotal, canClose, dashboardSnapshot, evidenceCsv, specEvidenceCsv, EXPORT_COLUMNS, SAMPLE} from '../app/src/main/assets/model.mjs';

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
