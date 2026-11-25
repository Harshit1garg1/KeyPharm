import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspace} from '../tools/workspace-store.mjs';

const lead = {id:'lead',role:'admin',name:'Test lead'};
const operator = {id:'operator',role:'operator',name:'Operator'};
const supervisor = {id:'supervisor',role:'supervisor',name:'Supervisor'};
const reviewer = {id:'viewer',role:'reviewer',name:'Reviewer'};
const sample = {testId:'KP-OUT-40',location:'Staging',source:'Simulation',sample:true};

test('physical fixture maps cartons to products and excludes the pallet EPC from stock', () => {
  const db = createWorkspace(':memory:',[
    'pallet_ref,pallet_epc,carton_ref,carton_epc,sku',
    'P,AAAA,Carton A,AA01,Old', 'P,AAAA,Carton B,AA02,Old', 'P,AAAA,Carton C,AA03,Old'
  ].join('\n'));
  try {
    assert.deepEqual(['Juice','Tiger Balm','Biotona'].map(sku => db.inventory().filter(c => c.sku === sku).length),[20,15,35]);
    assert.deepEqual(db.inventory().filter(c => c.physical).map(c => c.epc).sort(),['AA01','AA02','AA03']);
    assert.match(db.sample('C72 hardware'),/Tiger Balm/);
    assert.equal(db.inventory().some(c => c.epc === 'AAAA'),false);
  } finally { db.close(); }
});

test('stock stays on hand until Supervisor dispatch after an independent clean rescan', () => {
  const dir = mkdtempSync(join(tmpdir(),'keypharm-workspace-'));
  const path = join(dir,'demo.sqlite');
  let db = createWorkspace(path);
  try {
    assert.throws(() => db.create(reviewer,sample),/Test lead/);
    let s = db.create(lead,sample);
    const action = (user,name) => db.action(user,{id:s.id,revision:s.workspaceRevision,action:name,confirmed:true});
    assert.equal(s.manifest.cartons.length,40);
    assert.throws(() => action(operator,'dispatch'),/role/);
    assert.throws(() => action(supervisor,'dispatch'),/verified/);
    assert.equal(db.inventory().filter(c => c.state === 'available').length,70);
    s = action(supervisor,'physical');
    const observed = s.manifest.cartons.map(c => c.epc);
    const extra = db.inventory().find(c => !observed.includes(c.epc)).epc;
    const run = epcs => ({id:randomUUID(),state:'Finished',source:s.source,manifestRevision:s.manifest.revision,
      observations:Object.fromEntries(epcs.map(epc => [epc,{count:3}]))});
    const capture = {...s,identified:true,palletAttempts:[{startedAt:'2026-11-24',observations:{[s.manifest.palletEpc]:{count:1}}}],
      runs:[run([...observed.slice(0,-1),extra])]};
    const first = {operationId:randomUUID(),revision:s.workspaceRevision,session:capture};
    s = db.sync(operator,first);
    assert.equal(s.runs[0].result.status,'Hold');
    assert.equal(s.runs[0].result.matched.length,39);
    assert.equal(s.runs[0].result.missing.length,1);
    assert.equal(s.runs[0].result.extra.length,1);
    assert.equal(db.sync(operator,first).workspaceRevision,s.workspaceRevision);
    assert.throws(() => action(reviewer,'approve'),/clean result/);
    assert.throws(() => db.sync(operator,{...first,operationId:randomUUID()}),/changed/);
    s = db.sync(operator,{operationId:randomUUID(),revision:s.workspaceRevision,session:{...s,runs:[...s.runs,run(observed)],confirmedAt:'2026-11-24'}});
    assert.deepEqual(s.runs.map(r => r.result.status),['Hold','Match']);
    assert.throws(() => action(supervisor,'dispatch'),/needs dispatch approval/);
    assert.throws(() => action(supervisor,'approve'),/role/);
    s = action(reviewer,'approve');
    assert.equal(s.dispatchApproval.role,'reviewer');
    assert.equal(db.inventory().filter(c => c.state !== 'dispatched').length,70);
    const close = {operationId:randomUUID(),revision:s.workspaceRevision,session:{...s,closedAt:'2026-11-24',
      closure:{coverage:'Reviewed both runs.',reviewed:true},runs:[]}};
    s = db.sync(operator,close);
    assert.equal(s.closure.actor,'Operator');
    assert.equal(s.runs.length,2);
    assert.equal(db.sync(operator,close).closedAt,s.closedAt);
    const before = s.workspaceRevision;
    s = action(supervisor,'dispatch');
    assert.equal(db.action(supervisor,{id:s.id,revision:before,action:'dispatch',confirmed:true}).dispatchedAt,s.dispatchedAt);
    assert.equal(db.inventory().filter(c => c.state !== 'dispatched').length,30);
    db.close();
    db = createWorkspace(path);
    assert.equal(db.records().sessions.find(row => row.id === s.id).runs.length,2);
    assert.equal(db.inventory().filter(c => c.state === 'dispatched').length,40);
  } finally {
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('closed sessions retain evidence when reopened and selected dispatch is atomic', () => {
  const db = createWorkspace(':memory:');
  const cartons = db.inventory();
  const csv = (carton,pallet) => 'pallet_ref,pallet_epc,carton_ref,carton_epc,sku\nP,' + pallet + ',Carton,' + carton.epc + ',' + carton.sku;
  const action = (user,name,s,extra) => db.action(user,{id:s.id,revision:s.workspaceRevision,action:name,confirmed:true,...extra});
  const record = testId => db.records().sessions.find(s => s.testId === testId);
  const verifyAndClose = session => {
    const s = action(supervisor,'physical',session);
    const observations = Object.fromEntries(s.manifest.cartons.map(c => [c.epc,{count:1}]));
    const finished = new Date().toISOString();
    return db.sync(operator,{operationId:randomUUID(),revision:s.workspaceRevision,session:{...s,identified:true,
      palletAttempts:[...(s.palletAttempts ?? []),{id:randomUUID(),observations:{[s.manifest.palletEpc]:{count:1}}}],
      runs:[...s.runs,{id:randomUUID(),state:'Finished',source:s.source,manifestRevision:s.manifest.revision,observations}],
      confirmedAt:finished,closedAt:finished,closure:{coverage:'All cartons checked.',reviewed:true}}});
  };
  const create = (testId,carton,pallet) => db.create(lead,{...sample,sample:false,testId,csv:csv(carton,pallet)});
  const batch = (user,...sessions) => db.dispatchSelected(user,{confirmed:true,sessions:sessions.map(s =>
    ({id:s.id,revision:s.workspaceRevision}))});
  try {
    const first = action(lead,'approve',verifyAndClose(create('A',cartons[0],'E001')));
    const second = action(reviewer,'approve',verifyAndClose(create('B',cartons[0],'E002')));
    assert.throws(() => batch(reviewer,first,second),/Test lead or Supervisor/);
    assert.throws(() => batch(supervisor,first,second),/no longer on hand/);
    assert.equal(record('A').dispatchedAt,undefined);
    assert.equal(db.inventory().filter(c => c.state === 'dispatched').length,0);

    const reopened = action(lead,'reopen',first);
    assert.equal(reopened.manifest.cartons[0].epc,cartons[0].epc);
    assert.equal(reopened.closedAt,null);
    assert.equal(reopened.dispatchApproval,undefined);
    assert.equal(reopened.runs[0].id,first.runs[0].id);
    assert.equal(reopened.manifest.revision,first.manifest.revision + 1);
    assert.throws(() => batch(supervisor,reopened),/verified pallet/);

    const changed = action(lead,'manifest',second,{csv:csv(cartons[1],'E003')});
    assert.equal(changed.manifest.cartons[0].epc,cartons[1].epc);
    assert.equal(changed.closedAt,null);
    assert.equal(changed.dispatchApproval,undefined);
    assert.equal(changed.runs[0].id,second.runs[0].id);
    const ready = [action(lead,'approve',verifyAndClose(reopened)),action(reviewer,'approve',verifyAndClose(changed))];
    assert.equal(batch(lead,...ready).length,2);
    assert.equal(db.inventory().filter(c => c.state === 'dispatched').length,2);
    assert.throws(() => action(lead,'reopen',record('A')),/changed/);
  } finally { db.close(); }
});
