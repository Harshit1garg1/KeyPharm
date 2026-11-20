import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseManifest, compare, scanDelta, canContinue, permits, allocationTotal, canClose, dashboardSnapshot, evidenceCsv, SAMPLE} from '../app/src/main/assets/model.mjs';

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
