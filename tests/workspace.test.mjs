import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspace} from '../tools/workspace-store.mjs';

const lead = {id:'lead',role:'admin',name:'Administrator'};
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
    assert.deepEqual(['Physalis','Tiger Balm','Biotona'].map(sku => db.inventory().filter(c => c.sku === sku).length),[20,15,35]);
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
    assert.throws(() => db.create(reviewer,sample),/Administrator/);
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
    assert.throws(() => db.create(lead,{...sample,testId:'KP-REUSE'}),/already dispatched under KP-OUT-40/);
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
    const first = verifyAndClose(create('A',cartons[0],'E001'));
    assert.throws(() => create('B',cartons[0],'E002'),/assigned to A.*reopen the existing session/);
    const draft = db.create(lead,{...sample,sample:false,testId:'Offline draft'});
    assert.throws(() => db.sync(lead,{operationId:randomUUID(),revision:draft.workspaceRevision,
      session:{...draft,manifest:first.manifest}}),/assigned to A/);
    assert.equal(record('Offline draft').manifest,undefined);
    const second = action(reviewer,'approve',verifyAndClose(create('B',cartons[1],'E002')));
    assert.throws(() => batch(reviewer,first,second),/Administrator or Supervisor/);
    assert.throws(() => batch(lead,first,first),/each session once/);
    assert.equal(record('A').dispatchedAt,undefined);
    assert.equal(record('A').dispatchApproval,undefined);
    assert.equal(db.inventory().filter(c => c.state === 'dispatched').length,0);

    const reopened = action(lead,'reopen',first);
    assert.equal(reopened.manifest.cartons[0].epc,cartons[0].epc);
    assert.equal(reopened.closedAt,null);
    assert.equal(reopened.dispatchApproval,undefined);
    assert.equal(reopened.runs[0].id,first.runs[0].id);
    assert.equal(reopened.manifest.revision,first.manifest.revision + 1);
    assert.throws(() => batch(supervisor,reopened),/verified pallet/);

    assert.throws(() => action(lead,'manifest',second,{csv:csv(cartons[0],'E003')}),/assigned to A/);
    const changed = action(lead,'manifest',second,{csv:csv(cartons[2],'E003')});
    assert.equal(changed.manifest.cartons[0].epc,cartons[2].epc);
    assert.equal(changed.closedAt,null);
    assert.equal(changed.dispatchApproval,undefined);
    assert.equal(changed.runs[0].id,second.runs[0].id);
    const ready = [verifyAndClose(reopened),action(reviewer,'approve',verifyAndClose(changed))];
    const dispatched = batch(lead,...ready);
    assert.deepEqual(dispatched.map(session => session.dispatchApproval.role),['admin','reviewer']);
    assert.equal(db.inventory().filter(c => c.state === 'dispatched').length,2);
    assert.throws(() => action(lead,'reopen',record('A')),/changed/);
  } finally { db.close(); }
});

test('same 40 cartons move from a 38+2 receipt through count, outbound Hold, Match and dispatch', () => {
  const db = createWorkspace(':memory:');
  const command = (user,action,task,extra) => db.stockCommand(user,{action,id:task?.id,revision:task?.revision,operationId:randomUUID(),...extra});
  const onHand = () => db.inventory().filter(c => c.state !== 'dispatched').length;
  try {
    let [receipt] = db.stockTasks().tasks;
    assert.equal(onHand(),70);
    receipt = command(operator,'scan',receipt,{scenario:'partial'});
    assert.equal(receipt.runs[0].found.length,38);
    assert.equal(onHand(),70);
    const partial = {action:'receive',id:receipt.id,revision:receipt.revision,operationId:randomUUID(),reason:'Two cartons still in transit'};
    receipt = db.stockCommand(operator,partial);
    db.stockCommand(operator,partial);
    assert.equal(receipt.status,'Partially received');
    assert.equal(onHand(),108);
    const oldCount = command(operator,'count',null,{location:'Storage'});
    const stale = command(operator,'scan',oldCount,{scenario:'missing'});
    receipt = command(operator,'scan',receipt,{scenario:'match'});
    assert.equal(receipt.runs[1].found.length,2);
    receipt = command(operator,'receive',receipt);
    assert.equal(onHand(),110);
    assert.throws(() => command(supervisor,'review',stale,{reason:'Old count'}),/Stock changed/);
    assert.throws(() => command(reviewer,'cancel-count',stale),/role/);
    const inventoryBeforeCancellation = db.inventory();
    const cancelled = command(operator,'cancel-count',stale);
    assert.equal(cancelled.status,'Cancelled');
    assert.deepEqual(cancelled.runs,stale.runs);
    assert.deepEqual(db.inventory(),inventoryBeforeCancellation);
    assert.throws(() => command(operator,'scan',cancelled,{scenario:'match'}),/closed/);
    let count = command(operator,'count',null,{location:'Storage'});
    count = command(operator,'scan',count,{scenario:'missing'});
    assert.equal(count.runs[0].missing.length,1);
    count = command(operator,'scan',count,{scenario:'match'});
    assert.equal(count.runs[1].found.length,40);
    assert.equal(count.runs[0].missing.length,1);
    assert.equal(onHand(),110);
    assert.throws(() => command(operator,'review',count),/role/);
    command(supervisor,'review',count);
    receipt = command(lead,'outbound',receipt);
    let s = db.records().sessions.find(session => session.id === receipt.outbound);
    assert.deepEqual(s.manifest.cartons.map(item => item.epc).sort(),receipt.received.slice().sort());
    const action = (user,name) => db.action(user,{id:s.id,revision:s.workspaceRevision,action:name,confirmed:true});
    s = action(supervisor,'physical');
    const epcs = s.manifest.cartons.map(carton => carton.epc);
    const extra = db.inventory().find(carton => !epcs.includes(carton.epc)).epc;
    const run = tags => ({id:randomUUID(),state:'Finished',source:s.source,manifestRevision:s.manifest.revision,
      observations:Object.fromEntries(tags.map(epc => [epc,{count:1}]))});
    const sync = session => db.sync(operator,{operationId:randomUUID(),revision:s.workspaceRevision,session});
    s = sync({...s,identified:true,palletAttempts:[{id:randomUUID(),observations:{[s.manifest.palletEpc]:{count:1}}}],
      runs:[run([...epcs.slice(0,-1),extra])]});
    assert.equal(s.runs[0].result.status,'Hold');
    assert.equal(s.runs[0].result.matched.length,39);
    assert.throws(() => action(supervisor,'dispatch'),/clean result/);
    s = sync({...s,confirmedAt:'2026-11-25',runs:[...s.runs,run(epcs)]});
    s = action(reviewer,'approve');
    assert.equal(onHand(),110);
    s = action(supervisor,'dispatch');
    assert.equal(onHand(),70);
    assert.equal(s.runs[0].result.status,'Hold');
    assert.deepEqual(db.stockHistory(epcs[0]).map(event => event.action),['Dispatched','Received']);
    assert.match(db.stockReport('receipts'),/Two cartons|KP-IN-40/);
    db.reset(lead,{generation:0,confirm:'RESET'});
    assert.equal(db.stockTasks().tasks.length,1);
    assert.equal(db.stockTasks().tasks[0].status,'Ready');
    assert.equal(onHand(),70);
  } finally { db.close(); }
});

test('SKU receipt import keeps unknown EPCs out of stock and requires consistent mappings', () => {
  const dir = mkdtempSync(join(tmpdir(),'keypharm-stock-'));
  const path = join(dir,'demo.sqlite');
  let db = createWorkspace(path);
  const action = (user,name,extra) => db.stockCommand(user,{action:name,operationId:randomUUID(),...extra});
  try {
    const csv = db.stockReport('receipt-template');
    assert.equal(action(lead,'preview',{csv}).mode,'SKU');
    let receipt = action(lead,'receipt',{csv});
    action(lead,'register',{epc:'DE0101',carton:'Receipt test carton',sku:'Physalis'});
    assert.throws(() => action(lead,'register',{epc:'DE0101',carton:'Other',sku:'Biotona'}),/already mapped/);
    receipt = action(operator,'scan',{id:receipt.id,revision:receipt.revision,epcs:['DE0101','DE0101','FE0101']});
    assert.equal(receipt.runs[0].observations.DE0101,2);
    assert.deepEqual(receipt.runs[0].unknown,['FE0101']);
    assert.equal(receipt.runs[0].outstanding,1);
    action(operator,'receive',{id:receipt.id,revision:receipt.revision,reason:'Expect the second carton later'});
    db.close();
    db = createWorkspace(path);
    assert.equal(db.inventory().length,71);
    assert.equal(db.inventory().some(row => row.epc === 'FE0101'),false);
    assert.equal(db.stockTasks().tasks.find(item => item.id === receipt.id).status,'Partially received');
    assert.equal(db.stockHistory('DE0101').at(-1).action,'EPC registered');
    assert.throws(() => action(operator,'hold',{epc:'DE0101',from:'Storage',state:'available',reason:'Check'}),/role/);
    action(supervisor,'hold',{epc:'DE0101',from:'Storage',state:'available',reason:'Check carton identity'});
    assert.equal(db.inventory().find(row => row.epc === 'DE0101').state,'held');
    action(supervisor,'release',{epc:'DE0101',from:'Hold',state:'held',location:'Staging',reason:'Identity checked'});
    let count = action(operator,'count',{location:'Storage'});
    count = action(operator,'scan',{id:count.id,revision:count.revision,epcs:['DE0101']});
    assert.throws(() => action(supervisor,'review',{id:count.id,revision:count.revision,epc:'DE0101'}),/review reason/);
    action(supervisor,'review',{id:count.id,revision:count.revision,epc:'DE0101',reason:'Verified carton in Storage'});
    const adjustment = db.stockHistory('DE0101')[0];
    assert.equal(JSON.parse(adjustment.before_state).location,'Staging');
    assert.equal(JSON.parse(adjustment.after_state).location,'Storage');
  } finally {
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('handheld pairs a receipt Product Identifier with one EPC and records it once', () => {
  const db = createWorkspace(':memory:');
  const action = (user,name,extra) => db.stockCommand(user,{action:name,operationId:randomUUID(),...extra});
  const csv = 'receipt_ref,source_ref,destination_location,sku,expected_cartons,carton_id,epc,product_identifier\n' +
    'TEST-IN,Supplier,Storage,Physalis,2,,,SUP-001';
  try {
    assert.throws(() => action(operator,'receipt',{csv}),/role/);
    const receipt = action(lead,'receipt',{csv});
    assert.deepEqual(receipt.identifiers,[['SUP-001','Physalis']]);
    const pair = {action:'receive-carton',operationId:randomUUID(),id:receipt.id,revision:receipt.revision,identifier:'SUP-001',epc:'AB0001'};
    assert.throws(() => db.stockCommand(lead,pair),/role/);
    assert.throws(() => db.stockCommand(operator,{...pair,identifier:'Wrong'}),/Product Identifier/);
    const partial = db.stockCommand(operator,pair);
    assert.equal(partial.status,'Partially received');
    assert.equal(partial.runs[0].identifier,'SUP-001');
    assert.deepEqual(db.stockCommand(operator,pair).received,['AB0001']);
    assert.equal(db.inventory().find(c => c.epc === 'AB0001').sku,'Physalis');
    assert.equal(db.inventory().find(c => c.epc === 'AB0001').physical,1);
    assert.throws(() => action(operator,'receive-carton',{id:receipt.id,revision:partial.revision,identifier:'SUP-001',epc:'AB0001'}),/already tagged to Physalis in this task/);
    const finished = action(operator,'receive-carton',{id:receipt.id,revision:partial.revision,identifier:'SUP-001',simulation:true});
    assert.equal(finished.status,'Completed');
    assert.equal(db.inventory().length,72);
    assert.equal(finished.runs.at(-1).source,'Simulation');
    const demoReceipt = db.stockTasks().tasks.find(task => task.id === 'KP-IN-40');
    const newTag = action(operator,'receive-carton',{id:demoReceipt.id,revision:demoReceipt.revision,identifier:'Physalis',epc:'AB0015'});
    assert.deepEqual(newTag.received,['AB0015']);
    assert.equal(newTag.tagged[0].sku,'Physalis');
    assert.throws(() => action(operator,'receive-carton',{id:demoReceipt.id,revision:newTag.revision,identifier:'Tiger Balm',epc:'AB0015'}),/already tagged/);
    assert.equal(finished.tagged.find(tag => tag.epc === 'AB0001').sku,'Physalis');
    const undo = {id:receipt.id,revision:finished.revision,epc:'AB0001',reason:'Wrong label'};
    assert.throws(() => action(operator,'untag',undo),/role/);
    const reopened = action(lead,'untag',undo);
    assert.equal(reopened.status,'Partially received');
    assert.equal(reopened.tagged.length,1);
    assert.equal(reopened.receivedBySku.Physalis,1);
    assert.equal(db.inventory().some(c => c.epc === 'AB0001'),false);
    assert.equal(db.stockHistory('AB0001')[0].action,'Carton untagged');
    assert.equal(action(operator,'receive-carton',{...pair,revision:reopened.revision,operationId:randomUUID()}).status,'Completed');
  } finally { db.close(); }
});
