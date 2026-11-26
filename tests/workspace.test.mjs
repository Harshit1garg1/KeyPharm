import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspace} from '../tools/workspace-store.mjs';
import {workspaceClient} from '../app/src/main/assets/workspace-client.mjs';

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
    assert.throws(() => command(lead,'outbound',receipt),/Complete the receipt first/);
    assert.equal(onHand(),108);
    const oldCount = command(operator,'count',null,{location:'Storage'});
    const stale = command(operator,'scan',oldCount,{scenario:'missing'});
    receipt = command(operator,'scan',receipt,{scenario:'match'});
    assert.equal(receipt.runs[1].found.length,2);
    receipt = command(operator,'receive',receipt);
    assert.equal(onHand(),110);
    receipt = command(lead,'outbound',receipt);
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
  const csv = 'receipt_ref,source_ref,destination_location,sku,expected_cartons,carton_id,epc,product_identifier,batch_lot,units_per_carton\n' +
    'TEST-IN,Factory,Storage,Physalis,2,,,SUP-001,LOT-01,10';
  try {
    assert.throws(() => action(operator,'receipt',{csv}),/role/);
    assert.throws(() => action(lead,'preview',{csv:csv.replace(/,10$/,',2.5')}),/positive whole number/);
    const receipt = action(lead,'receipt',{csv});
    assert.deepEqual(receipt.identifiers,[['SUP-001','Physalis']]);
    assert.deepEqual(receipt.cartonDetails.Physalis,{batch_lot:'LOT-01',units_per_carton:10});
    const pair = {action:'receive-carton',operationId:randomUUID(),id:receipt.id,revision:receipt.revision,identifier:'SUP-001',epc:'AB0001'};
    assert.throws(() => db.stockCommand(lead,pair),/role/);
    assert.throws(() => db.stockCommand(operator,{...pair,identifier:'Wrong'}),/Product Identifier/);
    const partial = db.stockCommand(operator,pair);
    assert.equal(partial.status,'Partially received');
    assert.equal(partial.runs[0].identifier,'SUP-001');
    assert.deepEqual(db.stockCommand(operator,pair).received,['AB0001']);
    assert.equal(db.inventory().find(c => c.epc === 'AB0001').sku,'Physalis');
    const receivedCarton = db.inventory().find(c => c.epc === 'AB0001');
    assert.equal(receivedCarton.physical,1);
    assert.equal(receivedCarton.batch_lot,'LOT-01');
    assert.equal(receivedCarton.units_per_carton,10);
    assert.match(db.stockReport('stock'),/"AB0001","Physalis","Storage","available","LOT-01","10"/);
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

test('one generated manifest verifies two pallets in sequence before dispatching both', () => {
  const db = createWorkspace(':memory:');
  try {
    const [first,second] = db.inventory();
    const device = 'demo-handheld';
    const manifest = (user, input, scannedDevice) => db.palletManifest(user,input,scannedDevice,[device]);
    const request = manifest(lead,{action:'request',reference:'PAL-A',deviceId:device});
    const draft = (action,fields = {}) => ({id:request.id,action,...fields});
    const scan = (epc,scanReference) => manifest(operator,draft('scan',{epc,scanReference}),device);
    const generate = carton => manifest(lead,draft('generate',{epcs:[carton.epc],locations:[carton.location]}));
    scan('AC0001');
    generate(first);
    manifest(lead,draft('add-pallet',{reference:'PAL-B'}));
    assert.throws(() => scan('AC0002'),/no longer pending/);
    assert.throws(() => scan('AC0001','PAL-B'),/already in this manifest/);
    scan('AC0002','PAL-B');
    assert.throws(() => generate(first),/already assigned to a pallet/);
    const ready = generate(second);
    assert.deepEqual(ready.pallets.map(p => [p.pallet,p.cartons[0].epc]),[['PAL-A',first.epc],['PAL-B',second.epc]]);
    assert.equal(ready.csv.split('\n').length,3);
    const {sessionId} = manifest(lead,draft('session',{testId:'MULTI',location:'Staging'}));
    let session = db.records().sessions.find(s => s.id === sessionId);
    session = db.action(supervisor,{id:sessionId,revision:session.workspaceRevision,action:'physical',confirmed:true});
    const sync = fields => db.sync(operator,{revision:session.workspaceRevision,operationId:randomUUID(),session:{...session,...fields}});
    const run = (palletEpc,epcs) => ({
      id:randomUUID(),source:session.source,state:'Finished',manifestRevision:1,palletEpc,
      observations:Object.fromEntries(epcs.map(epc => [epc,{count:1}]))
    });
    const identified = palletEpc => ({id:randomUUID(),manifestRevision:1,palletEpc,observations:{[palletEpc]:{count:1}}});
    const a = run('AC0001',[first.epc]);
    const b = run('AC0002',[second.epc]);
    const pa = identified('AC0001'), pb = identified('AC0002');
    assert.throws(() => sync({palletAttempts:[pa],runs:[a,b]}),/current verified manifest/);
    session = sync({palletAttempts:[pa],runs:[a],palletMatches:{AC0001:a.id},confirmedAt:'claimed'});
    assert.equal(session.confirmedAt,null);
    assert.deepEqual(db.outbound(lead,[session]).dispatchable,[]);
    const wrong = run('AC0002',[first.epc,second.epc]);
    session = sync({palletAttempts:[pa,pb],runs:[a,wrong],palletMatches:{AC0001:a.id,AC0002:wrong.id}});
    assert.equal(session.runs.at(-1).result.status,'Hold');
    assert.equal(session.confirmedAt,null);
    session = sync({runs:[a,wrong,b],palletMatches:{AC0001:a.id,AC0002:b.id}});
    assert.ok(session.confirmedAt);
    assert.deepEqual(db.outbound(lead,[session]).dispatchable,[sessionId]);
    db.action(lead,{id:sessionId,revision:session.workspaceRevision,action:'dispatch',confirmed:true},true);
    assert.ok(db.inventory().filter(c => [first.epc,second.epc].includes(c.epc)).every(c => c.state === 'dispatched'));
  } finally { db.close(); }
});

test('operator sync skips unchanged sessions but requires a physical check for new scan evidence', () => {
  const db = createWorkspace(':memory:');
  try {
    const session = db.create(lead,sample);
    const sync = fields => db.sync(operator,{
      revision:session.workspaceRevision,operationId:randomUUID(),session:{...session,...fields}
    });
    assert.equal(sync({}).workspaceRevision,session.workspaceRevision);
    assert.throws(() => sync({palletAttempts:[{id:randomUUID(),observations:{}}]}),/physical check before scanning/);
    assert.throws(() => sync({runs:[{id:randomUUID(),state:'Finished'}]}),/physical check before scanning/);
    assert.equal(db.records().sessions[0].runs.length,0);
  } finally { db.close(); }
});

test('sync adopts old cache fingerprints and drops only an unchanged retry', async t => {
  const remote = {id:randomUUID(),workspaceRevision:1,manifest:{revision:1},runs:[],logs:[]};
  const next = {...remote,id:randomUUID()};
  const unsynced = {...remote,id:randomUUID(),palletAttempts:[{id:randomUUID(),observations:{}}]};
  const legacy = JSON.stringify([remote.manifest,null,null,[],null,null,null,[]]);
  const prefix = 'keypharm-connected-v1';
  const stored = new Map([
    [prefix + '-generation','1'],
    [prefix + '-auth',JSON.stringify({token:'demo',user:operator})],
    [prefix + '-samples',JSON.stringify({Simulation:'demo','C72 hardware':'demo'})],
    [prefix + '-base',JSON.stringify({[remote.id]:legacy,[next.id]:legacy,[unsynced.id]:legacy})],
    [prefix + '-queue',JSON.stringify({[remote.id]:{session:remote,operationId:randomUUID(),revision:1,by:'operator/operator'}})]
  ]);
  const previous = Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    getItem:key => stored.get(key) ?? null, setItem:(key,value) => stored.set(key,value)
  }});
  t.after(() => {
    if (previous) Object.defineProperty(globalThis,'localStorage',previous);
    else delete globalThis.localStorage;
  });
  const uploaded = [];
  const verified = {...remote,workspaceRevision:2,verifiedAt:'2026-11-26'};
  const workspace = {generation:1,controls:{},inventory:[],sessions:[verified,next,{...unsynced,palletAttempts:undefined}]};
  const local = [remote,next,unsynced];
  const client = workspaceClient({workspaceRequest(id,path,_auth,body) {
    queueMicrotask(() => {
      if (path === 'sync') {
        uploaded.push(JSON.parse(body).session.id);
        workspace.sessions[2] = unsynced;
      }
      const data = path === 'sync' ? unsynced : workspace;
      client.receive({id,status:200,body:JSON.stringify(data)});
    });
  }});
  const apply = record => { local[local.findIndex(s => s.id === record.id)] = record; };
  await client.refresh(() => local,apply,() => true,() => {},() => {});
  assert.equal(local[0].verifiedAt,verified.verifiedAt);
  assert.deepEqual(uploaded,[unsynced.id]);
  assert.deepEqual(JSON.parse(stored.get(prefix + '-queue')),{});
  assert.equal(client.state,'Synced');
});

test('saved pallets retain exclusive carton assignments when moved between manifests', () => {
  const db = createWorkspace(':memory:');
  try {
    const [first,second,third] = db.inventory();
    const device = 'demo-handheld';
    const command = (action,fields) => db.palletManifest(lead,{action,...fields},undefined,[device]);
    const scan = (id,epc,scanReference) => db.palletManifest(operator,{action:'scan',id,epc,scanReference},device,[device]);
    const newDraft = (reference,epc) => {
      const {id} = command('request',{reference,deviceId:device});
      scan(id,epc);
      return id;
    };
    const generate = (id,carton) => command('generate',{id,epcs:[carton.epc],locations:[carton.location]});
    const destination = newDraft('PAL-A','AC0001');
    generate(destination,first);
    const source = newDraft('PAL-B','AC0002');
    assert.throws(() => generate(source,first),/already assigned to a pallet/);
    generate(source,second);
    command('add-pallet',{id:source,reference:'PAL-C'});
    scan(source,'AC0003','PAL-C');
    generate(source,third);
    assert.deepEqual(new Set(db.assignedCartonEpcs()),new Set([first.epc,second.epc,third.epc]));
    const combined = command('add-existing',{id:destination,palletEpc:'AC0002'});
    assert.deepEqual(combined.pallets.map(pallet => pallet.pallet),['PAL-A','PAL-B']);
    const remaining = db.palletManifests().find(draft => draft.id === source);
    assert.deepEqual(remaining.pallets.map(pallet => pallet.pallet),['PAL-C']);
    assert.equal(remaining.csv.includes(second.epc),false);
    assert.throws(() => command('add-existing',{id:destination,palletEpc:'AC0002'}),/no longer available/);
    const merged = command('add-existing',{id:destination,palletEpc:'AC0003'});
    assert.equal(merged.pallets.length,3);
    assert.equal(db.palletManifests().find(draft => draft.id === source).mergedInto,destination);
    const {sessionId} = command('session',{id:destination,testId:'SHIPMENT',location:'Staging'});
    assert.equal(db.existingPallets().length,0);
    command('cancel',{id:destination,confirmed:true});
    assert.deepEqual(new Set(db.assignedCartonEpcs()),new Set([first.epc,second.epc,third.epc]));
    const session = db.records().sessions.find(row => row.id === sessionId);
    db.action(lead,{id:sessionId,revision:session.workspaceRevision,action:'remove',confirmed:true});
    assert.equal(db.assignedCartonEpcs().length,0);
  } finally { db.close(); }
});

test('removing session unlinks draft, allows Test ID reuse, ready manifests lock cartons, and add-existing updates reference', () => {
  const db = createWorkspace(':memory:');
  try {
    const [first,second] = db.inventory();
    const device = 'demo-handheld';
    const command = (action,fields) => db.palletManifest(lead,{action,...fields},undefined,[device]);
    const scan = (id,epc,scanReference) => db.palletManifest(operator,{action:'scan',id,epc,scanReference},device,[device]);
    const idA = command('request',{reference:'PAL-FIRST',deviceId:device}).id;
    scan(idA,'AD0001');
    command('generate',{id:idA,epcs:[first.epc],locations:[first.location]});
    const receiptCsv = 'receipt_ref,source_ref,destination_location,sku,expected_cartons,carton_id,epc,product_identifier\nIN-LOCK,Supplier,Storage,Physalis,1,,,SUP-LOCK';
    const receipt = db.stockCommand(lead,{action:'receipt',operationId:randomUUID(),csv:receiptCsv});
    const tagged = db.stockCommand(operator,{action:'receive-carton',operationId:randomUUID(),id:receipt.id,revision:receipt.revision,identifier:'SUP-LOCK',epc:'AD0010'});
    const idB = command('request',{reference:'PAL-SECOND',deviceId:device}).id;
    scan(idB,'AD0002');
    command('generate',{id:idB,epcs:['AD0010'],locations:['Storage']});
    assert.throws(() => db.stockCommand(lead,{action:'untag',operationId:randomUUID(),id:tagged.id,revision:tagged.revision,epc:'AD0010',reason:'Blocked'}),/manifest|outbound/i);
    assert.throws(() => db.create(lead,{testId:'MANUAL-DUP',location:'Staging',source:'Simulation',
      csv:'pallet_ref,pallet_epc,carton_ref,carton_epc,sku\nP,AD0099,C1,AD0010,Physalis'}),/manifest/i);
    command('add-pallet',{id:idB,reference:'PAL-KEEP'});
    scan(idB,'AD0003','PAL-KEEP');
    command('generate',{id:idB,epcs:[second.epc],locations:[second.location]});
    command('add-existing',{id:idA,palletEpc:'AD0002'});
    assert.equal(db.palletManifests().find(d => d.id === idB).reference,'PAL-KEEP');
    const created = command('session',{id:idA,testId:'REUSE-ME',location:'Staging'});
    const s = db.records().sessions.find(row => row.id === created.sessionId);
    db.action(lead,{id:s.id,revision:s.workspaceRevision,action:'remove',confirmed:true});
    const unlinked = db.palletManifests().find(d => d.id === idA);
    assert.equal(unlinked.status,'Manifest ready');
    assert.equal(unlinked.sessionId,undefined);
    const createdAgain = command('session',{id:idA,testId:'REUSE-ME',location:'Staging'});
    assert.equal(db.records().sessions.find(row => row.id === createdAgain.sessionId).testId,'REUSE-ME');
  } finally { db.close(); }
});

test('workspaceClient unblocks role switching when settings save hits 409 conflict', async t => {
  const prefix = 'keypharm-connected-v1';
  const stored = new Map([
    [prefix + '-generation','1'],
    [prefix + '-auth',JSON.stringify({token:'demo',user:{...lead,canSwitch:true}})],
    [prefix + '-samples',JSON.stringify({Simulation:'demo','C72 hardware':'demo'})],
  ]);
  const previous = Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    getItem:key => stored.get(key) ?? null, setItem:(key,value) => stored.set(key,value)
  }});
  t.after(() => {
    if (previous) Object.defineProperty(globalThis,'localStorage',previous);
    else delete globalThis.localStorage;
  });
  const workspace = {generation:1,controls:{revision:2,plan:[{id:'KP-1',title:'Old'}]},inventory:[],sessions:[]};
  const client = workspaceClient({workspaceRequest(id,path) {
    queueMicrotask(() => {
      if (path === 'settings') {
        client.receive({id,status:409,body:JSON.stringify({message:'Test controls changed. Refresh and review them.'})});
      } else client.receive({id,status:200,body:JSON.stringify(workspace)});
    });
  }});
  client.updateControls({plan:'KP-NEW New test'});
  await client.refresh(() => [],() => {},() => true,() => {},() => {});
  assert.equal(client.switchTo('operator',[]).role,'operator');
});

test('multi-table schema persists separate records, backfills legacy DBs, and caps audit activity at 300 rows', () => {
  const dir = mkdtempSync(join(tmpdir(),'keypharm-schema-'));
  const file = join(dir,'workspace.sqlite');
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE cartons (epc TEXT PRIMARY KEY, carton TEXT NOT NULL, sku TEXT NOT NULL, physical INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'available', reservation TEXT, location TEXT NOT NULL DEFAULT 'Staging', batch_lot TEXT, units_per_carton INTEGER);
      CREATE TABLE pallet_manifests (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE operations (id TEXT PRIMARY KEY, actor TEXT NOT NULL, session TEXT NOT NULL);
      CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, session TEXT NOT NULL);
      CREATE TABLE stock_tasks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE stock_commands (id TEXT PRIMARY KEY, actor TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE stock_mappings (epc TEXT PRIMARY KEY);
      CREATE TABLE stock_events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, ref TEXT NOT NULL, epc TEXT NOT NULL, action TEXT NOT NULL, before_state TEXT NOT NULL, after_state TEXT NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL);
    `);
    legacy.prepare('INSERT INTO settings VALUES (?,?)').run('sample','pallet_ref,pallet_epc,carton_ref,carton_epc,sku\nP,D401,Physalis-S-01,D30001,Physalis\n');
    legacy.prepare('INSERT INTO settings VALUES (?,?)').run('physical','');
    legacy.prepare('INSERT INTO cartons VALUES (?,?,?,?,?,?,?,?,?)').run('D30001','Physalis-S-01','Physalis',0,'available',null,'Staging',null,null);
    const oldSession = {
      id:'11111111-1111-4111-8111-111111111111', testId:'LEGACY-01', location:'Staging', source:'Simulation',
      manifest:{revision:1,source:'Sample CSV',pallet:'P',palletEpc:'D401',cartons:[{epc:'D30001',carton:'Physalis-S-01',sku:'Physalis'}],pallets:[{pallet:'P',palletEpc:'D401',cartons:[{epc:'D30001',carton:'Physalis-S-01',sku:'Physalis'}]}]},
      palletAttempts:[{id:'att-1',actor:'Operator',startedAt:'2026-11-26T08:00:00Z',endedAt:'2026-11-26T08:00:01Z',result:'Identified',lockedPallet:'P',palletEpc:'D401',manifestRevision:1,observations:{D401:{count:1,rssi:-50}}}],
      runs:[{id:'run-1',palletEpc:'D401',manifestRevision:1,operator:'Operator',source:'Simulation',state:'Finished',startedAt:'2026-11-26T08:01:00Z',endedAt:'2026-11-26T08:01:02Z',elapsedSeconds:2,observations:{D30001:{count:2,rssi:-48}},result:{status:'Match',expected:1,matched:['D30001'],missing:[],extra:[],percent:100}}],
      logs:[]
    };
    legacy.prepare('INSERT INTO sessions VALUES (?,?,?)').run(oldSession.id,1,JSON.stringify(oldSession));
    legacy.prepare('INSERT INTO stock_tasks VALUES (?,?,?)').run('CNT-1',1,JSON.stringify({
      id:'CNT-1',type:'count',reference:'Count Staging',location:'Staging',status:'In progress',expected:[{epc:'D30001'}],
      runs:[{id:'srun-1',at:'2026-11-26T08:05:00Z',actor:'Operator',source:'Simulation',observations:{D30001:1},found:['D30001'],missing:[],unexpected:[],unknown:[]}]
    }));
    const insAudit = legacy.prepare('INSERT INTO audit (at,actor,action,session) VALUES (?,?,?,?)');
    for (let i = 1; i <= 305; i++) insAudit.run('2026-11-26T08:00:00Z','testing','Old ' + i,oldSession.id);
    legacy.close();

    const db = createWorkspace(file);
    try {
      db.recordDevice('a01234',operator);
    } finally { db.close(); }

    const reopened = createWorkspace(file);
    try {
      assert.deepEqual(reopened.devices().map(d => d.deviceId),['a01234']);
      const receiptCsv = 'receipt_ref,source_ref,destination_location,sku,expected_cartons,carton_id,epc,product_identifier\nIN-ARC,Supplier,Storage,Physalis,1,,,SUP-ARC';
      const r = reopened.stockCommand(lead,{action:'receipt',operationId:randomUUID(),csv:receiptCsv});
      const t = reopened.stockCommand(operator,{action:'receive-carton',operationId:randomUUID(),id:r.id,revision:r.revision,identifier:'SUP-ARC',epc:'AE0099'});
      reopened.stockCommand(lead,{action:'untag',operationId:randomUUID(),id:t.id,revision:t.revision,epc:'AE0099',reason:'Archive check'});
      for (let i = 1; i <= 10; i++) {
        reopened.setControls(lead,{revision:reopened.settings().revision,operationId:randomUUID(),power:10 + (i % 15)});
      }
    } finally { reopened.close(); }

    const raw = new DatabaseSync(file,{readOnly:true});
    try {
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM manifest_revisions WHERE session_id=?').get('11111111-1111-4111-8111-111111111111').n,1);
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM pallet_attempts WHERE id=?').get('att-1').n,1);
      assert.equal(raw.prepare('SELECT status, matched_count FROM scan_runs WHERE id=?').get('run-1').status,'Match');
      assert.equal(raw.prepare('SELECT outcome, read_count FROM scan_observations WHERE run_id=? AND epc=?').get('run-1','D30001').outcome,'matched');
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM stock_task_runs WHERE id=?').get('srun-1').n,1);
      assert.equal(raw.prepare('SELECT reason FROM carton_archive WHERE epc=?').get('AE0099').reason,'Archive check');
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM settings_history').get().n,10);
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM audit').get().n,300);
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='Old 1'").get().n,0);
      assert.ok(raw.prepare("SELECT role, actor_name FROM audit WHERE action='Settings updated' ORDER BY id DESC LIMIT 1").get().role === 'admin');
    } finally { raw.close(); }

    const cleared = createWorkspace(file);
    try {
      cleared.reset(lead,{confirm:'RESET',generation:cleared.generation()});
      assert.equal(cleared.devices().length,0);
    } finally { cleared.close(); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
