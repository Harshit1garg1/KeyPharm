import {randomInt,randomUUID} from 'node:crypto';
import {compare,normalizeEpc,parseCsvRows,validEpc,productSku,receiptProducts,csvCell} from '../app/src/main/assets/model.mjs';

export const locations = ['Receiving','Storage','Staging','Hold'];
const receiptId = 'KP-IN-40';
const outboundRef = 'KP-RECEIVED-40';
const demoPallet = 'D60000000000000000000001';
const unknownTag = 'F60000000000000000000001';
const receiptHeaders = ['receipt_ref','source_ref','destination_location','sku','expected_cartons','carton_id','epc'];
const receiptOptionalHeaders = ['product_identifier','batch_lot','units_per_carton'];
const now = () => new Date().toISOString();
const fail = (message,status = 409) => { throw Object.assign(new Error(message),{status}); };
const field = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 240) fail('Enter ' + label + '.',400);
  return value.trim();
};
const csv = (header,rows) => [header.join(','),...rows.map(row => row.map(csvCell).join(','))].join('\r\n') + '\r\n';
const demoSizes = ['XS','S','M','L'];
const inboundEpc = number => 'D5' + number.toString(16).toUpperCase().padStart(22,'0');

export function nextCartonLabel(db,sku) {
  const labels = db.prepare('SELECT carton FROM cartons WHERE sku=?').all(sku);
  const highest = labels.reduce((max,{carton}) => {
    const suffix = carton.startsWith(sku + '-') && /^(?:XS|S|M|L)-(\d+)$/.exec(carton.slice(sku.length + 1));
    return suffix ? Math.max(max,Number(suffix[1])) : max;
  },0);
  return sku + '-' + demoSizes[randomInt(demoSizes.length)] + '-' + String(highest + 1).padStart(2,'0');
}

export function stockWorkflows(db, products, onAudit = () => {}) {
  const cartonColumns = new Set(db.prepare('PRAGMA table_info(cartons)').all().map(column => column.name));
  if (!cartonColumns.has('location')) {
    db.exec("ALTER TABLE cartons ADD COLUMN location TEXT NOT NULL DEFAULT 'Staging'");
  }
  if (!cartonColumns.has('batch_lot')) db.exec('ALTER TABLE cartons ADD COLUMN batch_lot TEXT');
  if (!cartonColumns.has('units_per_carton')) db.exec('ALTER TABLE cartons ADD COLUMN units_per_carton INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_tasks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stock_commands (id TEXT PRIMARY KEY, actor TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stock_mappings (epc TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS stock_events (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, ref TEXT NOT NULL, epc TEXT NOT NULL,
      action TEXT NOT NULL, before_state TEXT NOT NULL, after_state TEXT NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stock_events_epc ON stock_events(epc);
    CREATE TABLE IF NOT EXISTS stock_task_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_type TEXT NOT NULL, actor TEXT, source TEXT,
      identifier TEXT, expected_count INTEGER, matched_count INTEGER, missing_count INTEGER,
      unexpected_count INTEGER, unknown_count INTEGER, outstanding INTEGER,
      recorded_at TEXT, confirmed_at TEXT, confirmed_by TEXT, superseded_at TEXT, reason TEXT,
      observations_json TEXT, result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS stock_task_runs_task ON stock_task_runs(task_id);
    CREATE TABLE IF NOT EXISTS carton_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT, archived_at TEXT NOT NULL, archived_by TEXT NOT NULL,
      task_id TEXT NOT NULL, reason TEXT NOT NULL, epc TEXT NOT NULL, carton TEXT NOT NULL, sku TEXT NOT NULL,
      physical INTEGER NOT NULL, prior_state TEXT NOT NULL, prior_location TEXT NOT NULL,
      batch_lot TEXT, units_per_carton INTEGER
    );
  `);
  const carton = epc => db.prepare('SELECT * FROM cartons WHERE epc=?').get(epc);
  const read = row => ({...JSON.parse(row.body),revision:row.revision});
  const get = id => {
    const row = db.prepare('SELECT * FROM stock_tasks WHERE id=?').get(id);
    return row && read(row);
  };
  const tasks = () => db.prepare('SELECT * FROM stock_tasks ORDER BY rowid DESC').all().map(read);
  const inventory = () => db.prepare(`SELECT cartons.*, EXISTS (SELECT 1 FROM stock_mappings WHERE stock_mappings.epc=cartons.epc) AS registered
    FROM cartons WHERE state<>'expected' ORDER BY sku,carton`).all();
  const tagged = task => task.type !== 'receipt' ? task : {...task,tagged:task.received.map(carton).filter(Boolean).map(
    ({epc,sku,carton:reference,state}) => ({epc,sku,reference,state}))};
  const stockVersion = () => db.prepare('SELECT COALESCE(MAX(id),0) AS version FROM stock_events').get().version;
  const deleteTaskRuns = db.prepare('DELETE FROM stock_task_runs WHERE task_id=?');
  const insertTaskRun = db.prepare(`INSERT INTO stock_task_runs
    (id,task_id,task_type,actor,source,identifier,expected_count,matched_count,missing_count,unexpected_count,unknown_count,outstanding,recorded_at,confirmed_at,confirmed_by,superseded_at,reason,observations_json,result_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  function syncTaskRuns(task) {
    deleteTaskRuns.run(task.id);
    for (const [index,run] of (task.runs ?? []).entries()) {
      const matched = run.found?.length ?? 0;
      const missing = run.missing?.length ?? 0;
      const unexpected = run.unexpected?.length ?? 0;
      const unknown = run.unknown?.length ?? 0;
      insertTaskRun.run(run.id ?? (task.id + ':run:' + index),task.id,task.type,run.actor ?? null,run.source ?? null,
        run.identifier ?? null,matched + (run.outstanding ?? missing),matched,missing,unexpected,unknown,
        run.outstanding ?? null,run.at ?? null,run.confirmedAt ?? null,run.confirmedBy ?? null,
        run.supersededAt ?? null,run.reason ?? null,JSON.stringify(run.observations ?? {}),
        JSON.stringify({found:run.found ?? [],missing:run.missing ?? [],unexpected:run.unexpected ?? [],unknown:run.unknown ?? [],bySku:run.bySku ?? {}}));
    }
  }
  for (const row of db.prepare('SELECT body FROM stock_tasks WHERE NOT EXISTS (SELECT 1 FROM stock_task_runs WHERE stock_task_runs.task_id=stock_tasks.id)').all()) {
    syncTaskRuns(JSON.parse(row.body));
  }
  function save(task) {
    const {revision,...body} = task;
    db.prepare('INSERT INTO stock_tasks VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body')
      .run(task.id,revision + 1,JSON.stringify(body));
    syncTaskRuns(task);
    return get(task.id);
  }
  const insert = db.prepare('INSERT INTO stock_events(at,actor,ref,epc,action,before_state,after_state,reason,source) VALUES (?,?,?,?,?,?,?,?,?)');
  function record(user,ref,before,after,action,reason,source) {
    insert.run(now(),user.name,ref,after.epc,action,JSON.stringify({state:before.state,location:before.location}),
      JSON.stringify({state:after.state,location:after.location}),reason,source);
  }
  function seed() {
    if (get(receiptId)) return;
    const insertCarton = db.prepare("INSERT INTO cartons(epc,carton,sku,physical,state,location) VALUES (?,?,?,0,'expected','Receiving')");
    const expected = Array.from({length:40},(_,i) => {
      const epc = inboundEpc(i + 1);
      const sku = products[i % products.length].sku;
      const item = {epc,carton:nextCartonLabel(db,sku),sku};
      insertCarton.run(item.epc,item.carton,item.sku);
      return item;
    });
    save({id:receiptId,type:'receipt',revision:0,location:'Storage',sourceRef:'Demo delivery',status:'Ready',
      createdAt:now(),expected,received:[],runs:[]});
  }
  function reset() {
    db.exec(`DELETE FROM stock_events; DELETE FROM stock_commands; DELETE FROM stock_task_runs; DELETE FROM stock_tasks;
      DELETE FROM carton_archive; DELETE FROM cartons WHERE epc IN (SELECT epc FROM stock_mappings); DELETE FROM stock_mappings;
      UPDATE cartons SET location='Staging';`);
    const deleteCarton = db.prepare('DELETE FROM cartons WHERE epc=?');
    for (let number = 1; number <= 40; number++) deleteCarton.run(inboundEpc(number));
    seed();
  }
  function chooseLocation(input, allowHold = false) {
    if (!locations.includes(input.location) || (!allowHold && input.location === 'Hold')) fail('Choose a working location.',400);
    return input.location;
  }
  function openCount(user,input) {
    const location = chooseLocation(input,true);
    const expected = inventory().filter(c => c.location === location && c.state !== 'dispatched');
    return save({id:randomUUID(),type:'count',reference:'Count ' + location,revision:0,location,status:'Ready',
      createdAt:now(),actor:user.name,stockVersion:stockVersion(),expected,runs:[]});
  }
  function prepareReceipt(text) {
    const header = typeof text === 'string' ? text.trimStart().split(/\r?\n/,1)[0].toLowerCase().split(/[,;]/).map(name => name.trim()) : [];
    const optional = header.slice(receiptHeaders.length);
    if (new Set(optional).size !== optional.length || optional.some(name => !receiptOptionalHeaders.includes(name))) {
      fail('Use the receipt template headers.',400);
    }
    const rows = parseCsvRows(text,[...receiptHeaders,...optional]);
    if (rows.length > 500) fail('Use up to 500 receipt lines.',400);
    const [id,sourceRef,location] = rows[0];
    const quantities = {};
    const cartonDetails = {};
    const identifiers = new Map();
    const expected = [];
    const seen = new Set();
    const mode = rows[0][6] ? 'EPC' : 'SKU';
    rows.forEach(([ref,source,destination,rawSku,count,cartonId,tag,...values],index) => {
      const row = 'Row ' + (index + 2) + ': ';
      const sku = productSku(rawSku);
      const {product_identifier,batch_lot,units_per_carton} = Object.fromEntries(optional.map((name,i) => [name,values[i]]));
      const identifier = product_identifier || sku;
      if (!id || !sourceRef || id.length > 80 || sourceRef.length > 100 || ref !== id || source !== sourceRef || destination !== location ||
          !locations.includes(location) || location === 'Hold') fail(row + 'use one receipt reference, source and destination.',400);
      const quantity = Number(count);
      if (!products.some(product => product.sku === sku) || !Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
        fail(row + 'use a known SKU and a quantity from 1 to 500.',400);
      }
      if (identifier.length > 100 || (identifiers.has(identifier) && identifiers.get(identifier) !== sku)) {
        fail(row + 'use a Product Identifier that maps to one SKU.',400);
      }
      const units = units_per_carton ? Number(units_per_carton) : null;
      if (units_per_carton && (!/^\d+$/.test(units_per_carton) || !Number.isSafeInteger(units) || units < 1)) {
        fail(row + 'units per carton must be a positive whole number.',400);
      }
      if (batch_lot?.length > 100) fail(row + 'batch/lot must be 100 characters or fewer.',400);
      const details = {batch_lot:batch_lot || null,units_per_carton:units};
      const previous = cartonDetails[sku];
      if (previous && (previous.batch_lot !== details.batch_lot || previous.units_per_carton !== details.units_per_carton)) {
        fail(row + 'use a separate receipt for this SKU with a different batch/lot or units per carton.',400);
      }
      cartonDetails[sku] = details;
      identifiers.set(identifier,sku);
      if (mode === 'EPC') {
        const epc = normalizeEpc(tag);
        const known = carton(epc);
        if (quantity !== 1 || !cartonId || cartonId.length > 80 || !validEpc(epc) || seen.has(epc) ||
            (known && (known.sku !== sku || known.carton !== cartonId || known.state !== 'expected')) ||
            tasks().some(task => task.type === 'receipt' && task.id !== id && task.expected.some(item => item.epc === epc))) {
          fail(row + 'use one carton with a unique, consistent EPC mapping.',400);
        }
        seen.add(epc);
        expected.push({epc,carton:cartonId,sku});
      } else if (tag || cartonId) fail(row + 'keep identity fields empty in SKU comparison mode.',400);
      quantities[sku] = (quantities[sku] ?? 0) + quantity;
    });
    if (Object.values(quantities).reduce((sum,n) => sum + n,0) > 500) fail('Use up to 500 expected cartons.',400);
    return {id,sourceRef,location,mode,quantities,expected,identifiers:[...identifiers],cartonDetails};
  }
  function register(user,input,source = 'Manual entry') {
    const epc = normalizeEpc(input.epc), name = field(input.carton,'a carton reference');
    if (!validEpc(epc) || name.length > 80 || !products.some(p => p.sku === input.sku)) fail('Enter a valid EPC, carton and SKU.',400);
    const known = carton(epc);
    if (known) {
      if (known.carton !== name || known.sku !== input.sku) fail('This EPC is already mapped to a different carton or SKU.');
      return known;
    }
    if (db.prepare('SELECT 1 FROM cartons WHERE lower(carton)=lower(?)').get(name)) fail('This carton reference already has an EPC.');
    db.prepare("INSERT INTO cartons(epc,carton,sku,physical,state,location) VALUES (?,?,?,?,'expected','Receiving')")
      .run(epc,name,input.sku,source === 'C72 hardware' ? 1 : 0);
    db.prepare('INSERT INTO stock_mappings VALUES (?)').run(epc);
    const mapped = carton(epc);
    record(user,'Carton mapping',{},mapped,'EPC registered','',source);
    return mapped;
  }
  function receiveCarton(user,task,input) {
    if (task.type !== 'receipt' || task.status === 'Completed') fail('This receipt is closed.');
    const lines = receiptProducts(task);
    const line = lines.find(item => item.identifier === input.identifier);
    if (!line || line.remaining < 1) fail('Choose a Product Identifier with cartons still outstanding.');
    const simulated = input.simulation === true;
    const planned = simulated && task.mode !== 'SKU' ? task.expected.find(item => item.sku === line.sku && !task.received.includes(item.epc)) : null;
    const epc = simulated ? (planned?.epc ?? 'D7' + randomUUID().replaceAll('-','').slice(0,22).toUpperCase()) : normalizeEpc(input.epc);
    if (!validEpc(epc)) fail('Scan one valid carton EPC.',400);
    let before = carton(epc);
    if (task.received.includes(epc)) fail('This EPC is already tagged' + (before ? ' to ' + before.sku : '') + ' in this task.');
    if (before && before.state !== 'expected') fail('This EPC is already tagged to ' + before.sku + '.');
    const expected = task.expected.find(item => item.epc === epc);
    if (expected && expected.sku !== line.sku) fail('This EPC is already assigned to ' + expected.sku + '.');
    if (tasks().some(other => other.type === 'receipt' && other.id !== task.id && other.expected.some(item => item.epc === epc))) {
      fail('This EPC is assigned to another receipt.');
    }
    if (before && before.sku !== line.sku) fail('This EPC is already assigned to ' + before.sku + '.');
    const source = simulated ? 'Simulation' : 'C72 hardware';
    before ??= register(user,{epc,sku:line.sku,carton:expected?.carton ?? nextCartonLabel(db,line.sku)},source);
    const at = now();
    const remaining = [...new Map(lines.map(item => [item.sku,item.remaining])).values()].reduce((sum,n) => sum+n,0) - 1;
    const details = task.cartonDetails?.[line.sku];
    db.prepare("UPDATE cartons SET state='available',location=?,physical=max(physical,?),batch_lot=?,units_per_carton=? WHERE epc=?")
      .run(task.location,simulated ? 0 : 1,details?.batch_lot ?? null,details?.units_per_carton ?? null,epc);
    record(user,task.id,before,carton(epc),'Received','Product Identifier: ' + line.identifier,source);
    const receivedForSku = task.expected.filter(item => item.sku === line.sku && task.received.includes(item.epc)).length;
    task.receivedBySku ??= {};
    task.receivedBySku[line.sku] = (task.receivedBySku[line.sku] ?? receivedForSku) + 1;
    task.received.push(epc);
    task.runs.push({id:randomUUID(),at,actor:user.name,source,identifier:line.identifier, observations:{[epc]:1},
      found:[epc],missing:[],unexpected:[],unknown:[],outstanding:remaining,bySku:{[line.sku]:1},confirmedAt:at,confirmedBy:user.name});
    task.status = remaining ? 'Partially received' : 'Completed';
    return save(task);
  }
  function simulate(task,scenario) {
    const expected = task.expected.filter(item => !task.received?.includes(item.epc)).map(item => item.epc);
    if (task.type === 'receipt' && scenario === 'partial') return expected.slice(0,38);
    if (scenario === 'missing') return expected.slice(0,-1);
    if (scenario === 'unknown') return [...expected,unknownTag];
    if (scenario !== 'match') fail('Choose a simulation scenario.',400);
    return [...expected,...expected.slice(0,1)];
  }
  function scan(user,task,input) {
    if (['Completed','Reviewed','Cancelled'].includes(task.status)) fail('This record is closed.');
    let expected = task.expected.filter(item => !task.received?.includes(item.epc));
    if (task.mode === 'SKU' && input.scenario) fail('Import EPC reads for a SKU-only receipt.',400);
    const epcs = input.scenario ? simulate(task,input.scenario) : input.epcs;
    if (!Array.isArray(epcs) || epcs.length > 4000) fail('Enter up to 4,000 EPC reads.',400);
    const observations = {};
    for (const raw of epcs) {
      const epc = normalizeEpc(raw);
      if (!validEpc(epc)) fail('Every EPC must be even-length hexadecimal.',400);
      const reads = input.reader === 'hardware' ? input.readCounts?.[epc] ?? 1 : 1;
      if (!Number.isSafeInteger(reads) || reads < 1 || reads > 1_000_000) fail('Invalid reader count.',400);
      observations[epc] = (observations[epc] ?? 0) + reads;
    }
    const ids = Object.keys(observations);
    let outstanding;
    if (task.mode === 'SKU') {
      const limits = {...task.quantities};
      for (const epc of task.received) limits[carton(epc).sku]--;
      const claims = new Set(tasks().flatMap(other => other.id === task.id ? [] : other.expected.map(item => item.epc)));
      expected = ids.map(carton).filter(item => {
        if (item?.state !== 'expected' || !(limits[item.sku] > 0) || claims.has(item.epc)) return false;
        limits[item.sku]--;
        return true;
      });
      outstanding = Object.values(limits).reduce((sum,n) => sum + n,0);
    }
    const result = compare({cartons:expected},ids);
    const at = now();
    task.runs.push({id:randomUUID(),at,actor:user.name,source:input.scenario ? 'Simulation' : input.reader === 'hardware' ? 'C72 hardware' : 'Imported EPC reads',
      observations,found:result.matched,missing:result.missing,outstanding,
      bySku:Object.fromEntries(products.map(({sku}) => [sku,ids.filter(epc => carton(epc)?.sku === sku).length])),
      unexpected:result.extra.filter(epc => carton(epc)),unknown:result.extra.filter(epc => !carton(epc))});
    task.status = task.received?.length ? 'Partially received' : 'In progress';
    return save(task);
  }
  function confirmReceipt(user,task,input) {
    const run = task.runs.at(-1);
    if (task.status === 'Completed' || !run || run.confirmedAt || run.supersededAt || !run.found.length) fail('Scan and review new cartons first.');
    const partial = run.outstanding || run.missing.length || run.unexpected.length || run.unknown.length;
    const reason = partial ? field(input.reason,'a reason for the partial receipt or discrepancy') : '';
    const remainingBySku = new Map(receiptProducts(task).map(line => [line.sku,line.remaining]));
    for (const epc of run.found) {
      const before = carton(epc);
      if (before?.state !== 'expected' || task.received.includes(epc)) fail('This carton was already received. Run a new scan.');
      const remaining = remainingBySku.get(before.sku);
      if (!(remaining > 0)) fail('This scan contains more cartons than are outstanding for ' + before.sku + '.');
      remainingBySku.set(before.sku,remaining - 1);
      const details = task.cartonDetails?.[before.sku];
      db.prepare("UPDATE cartons SET state='available',location=?,batch_lot=?,units_per_carton=? WHERE epc=?")
        .run(task.location,details?.batch_lot ?? null,details?.units_per_carton ?? null,epc);
      record(user,task.id,before,carton(epc),'Received',reason,run.source);
      task.received.push(epc);
      task.receivedBySku ??= {};
      task.receivedBySku[before.sku] = (task.receivedBySku[before.sku] ?? 0) + 1;
    }
    run.confirmedAt = now();
    run.confirmedBy = user.name;
    run.reason = reason;
    const total = task.quantities ? Object.values(task.quantities).reduce((sum,n) => sum + n,0) : task.expected.length;
    task.status = total === task.received.length ? 'Completed' : 'Partially received';
    return save(task);
  }
  function untag(user,task,input,usedInOutbound) {
    const epc = normalizeEpc(input.epc);
    const before = carton(epc);
    const last = db.prepare('SELECT action,ref FROM stock_events WHERE epc=? ORDER BY id DESC LIMIT 1').get(epc);
    if (task.type !== 'receipt' || !task.received.includes(epc) || task.outbound || usedInOutbound(epc) ||
        before?.state !== 'available' || before.location !== task.location || last?.action !== 'Received' || last.ref !== task.id) {
      fail('Only a received carton that has not moved or been assigned to outbound can be untagged.');
    }
    const reason = field(input.reason,'an untag reason');
    const planned = task.expected.some(item => item.epc === epc);
    if (planned) db.prepare("UPDATE cartons SET state='expected',location='Receiving' WHERE epc=?").run(epc);
    else {
      db.prepare(`INSERT INTO carton_archive
        (archived_at,archived_by,task_id,reason,epc,carton,sku,physical,prior_state,prior_location,batch_lot,units_per_carton)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(now(),user.name,task.id,reason,before.epc,before.carton,before.sku,
        before.physical ?? 0,before.state,before.location,before.batch_lot ?? null,before.units_per_carton ?? null);
      db.prepare('DELETE FROM stock_mappings WHERE epc=?').run(epc);
      db.prepare('DELETE FROM cartons WHERE epc=?').run(epc);
    }
    record(user,task.id,before,{epc,state:planned ? 'expected' : 'untagged',location:'Receiving'},'Carton untagged',reason,'Manual confirmation');
    const counted = task.receivedBySku?.[before.sku] ??
      task.expected.filter(item => item.sku === before.sku && task.received.includes(item.epc)).length;
    task.receivedBySku = {...task.receivedBySku,[before.sku]:Math.max(0,counted - 1)};
    task.received = task.received.filter(value => value !== epc);
    task.status = task.received.length ? 'Partially received' : 'Ready';
    const lastRun = task.runs.at(-1);
    if (lastRun && !lastRun.confirmedAt) lastRun.supersededAt = now();
    return save(task);
  }
  function move(user,input) {
    const before = carton(normalizeEpc(input.epc));
    if (!before || before.location !== input.from || before.state !== input.state || !['available','held'].includes(before.state)) {
      fail('Stock changed. Reopen the carton before moving it.');
    }
    const hold = input.action === 'hold';
    const destination = hold ? 'Hold' : chooseLocation(input);
    const state = hold ? 'held' : 'available';
    if (hold ? before.state !== 'available' : (input.action === 'release' ? before.state !== 'held' : before.state !== 'available')) {
      fail('This movement is unavailable for the carton.');
    }
    if (before.location === destination && before.state === state) fail('Choose a different location.');
    const reason = field(input.reason,'a movement reason');
    db.prepare('UPDATE cartons SET location=?,state=? WHERE epc=?').run(destination,state,before.epc);
    const after = carton(before.epc);
    const action = hold ? 'Held' : input.action === 'release' ? 'Released from hold' : 'Transferred';
    record(user,'Stock movement',before,after,action,reason,'Manual confirmation');
    return after;
  }
  function reviewCount(user,task,input) {
    if (['Reviewed','Cancelled'].includes(task.status)) fail('This count is closed.');
    if (!task.runs.length) fail('Scan the count before review.');
    if (task.stockVersion !== stockVersion()) fail('Stock changed after this snapshot. Cancel this count and open a new one before reviewing.');
    const run = task.runs.at(-1);
    const epc = normalizeEpc(input.epc);
    const changed = Boolean(epc);
    const reason = changed || run.missing.length || run.unexpected.length || run.unknown.length ? field(input.reason,'a review reason') : '';
    if (changed) {
      const before = carton(epc);
      if (!run.unexpected.includes(epc) || before?.state !== 'available' || before.location === task.location) {
        fail('Choose a physically verified extra carton recorded at another location.');
      }
      db.prepare('UPDATE cartons SET location=? WHERE epc=?').run(task.location,epc);
      record(user,task.id,before,carton(epc),'Count correction',reason,run.source);
    }
    task.review = {at:now(),by:user.name,reason,epc:epc || null};
    task.status = 'Reviewed';
    return save(task);
  }
  function prepareOutbound(user,task,create) {
    if (task.type !== 'receipt' || task.status !== 'Completed' || task.outbound) fail('Complete the receipt first.');
    if (task.received.some(epc => carton(epc)?.state !== 'available')) fail('Every carton must be on hand.');
    const ref = task.id === receiptId ? outboundRef : (task.id.slice(0,75) + '-OUT');
    const pallet = task.id === receiptId ? demoPallet : 'D6' + randomUUID().replaceAll('-','').slice(0,22).toUpperCase();
    const manifest = csv(['pallet_ref','pallet_epc','carton_ref','carton_epc','sku'],
      task.received.map(epc => { const item = carton(epc); return [ref,pallet,item.carton,item.epc,item.sku]; }));
    const session = create(user,{testId:ref,location:task.location,source:'Simulation',csv:manifest});
    task.outbound = session.id;
    return save(task);
  }
  const roles = {count:'operator',scan:'operator',receive:'operator','receive-carton':'operator',transfer:'operator',review:'supervisor','cancel-count':'supervisor',hold:'supervisor',
    release:'supervisor',outbound:'admin',register:'admin',receipt:'admin',preview:'admin',untag:'admin'};
  function command(user,input,create,dashboard,usedInOutbound) {
    const operatorCancel = input.action === 'cancel-count' && user.role === 'operator';
    if (!Object.hasOwn(roles,input.action) || (user.role !== roles[input.action] && !operatorCancel && !(dashboard && user.role === 'admin'))) {
      fail('This role cannot perform that action.',403);
    }
    if (input.action === 'preview') return prepareReceipt(input.csv);
    if (!/^[a-f0-9-]{36}$/i.test(input.operationId)) fail('Invalid operation ID.',400);
    const body = JSON.stringify(input);
    const prior = db.prepare('SELECT * FROM stock_commands WHERE id=?').get(input.operationId);
    if (prior) {
      if (prior.actor !== user.id || prior.body !== body) fail('Operation ID is already in use.');
      return ['receive-carton','untag'].includes(input.action) ? tagged(get(input.id)) : {saved:true};
    }
    let result;
    if (input.action === 'receipt') {
      const task = prepareReceipt(input.csv);
      if (get(task.id)) fail('This receipt reference already exists.');
      for (const item of task.expected) register(user,item);
      result = save({...task,type:'receipt',status:'Ready',revision:0,createdAt:now(),received:[],runs:[]});
    } else if (input.action === 'register') result = register(user,input);
    else if (['transfer','hold','release'].includes(input.action)) result = move(user,input);
    else if (input.action === 'count') result = openCount(user,input);
    else {
      const task = get(input.id);
      if (!task || task.revision !== input.revision) fail('This record changed. Refresh before continuing.');
      if (input.action === 'scan') result = scan(user,task,input);
      else if (input.action === 'receive' && task.type === 'receipt') result = confirmReceipt(user,task,input);
      else if (input.action === 'receive-carton') result = tagged(receiveCarton(user,task,input));
      else if (input.action === 'untag') result = tagged(untag(user,task,input,usedInOutbound));
      else if (input.action === 'review' && task.type === 'count') result = reviewCount(user,task,input);
      else if (input.action === 'cancel-count' && task.type === 'count') {
        if (!['Ready','In progress'].includes(task.status)) fail('Only unfinished counts can be cancelled.');
        result = save({...task,status:'Cancelled',cancelled:{at:now(),by:user.name}});
      }
      else if (input.action === 'outbound') result = prepareOutbound(user,task,create);
      else fail('Action is unavailable for this record.');
    }
    db.prepare('INSERT INTO stock_commands VALUES (?,?,?)').run(input.operationId,user.id,body);
    onAudit(user,'Stock ' + input.action,input.id ?? result?.id ?? 'stock',result?.reference ?? '');
    return result;
  }
  const events = epc => epc ? db.prepare('SELECT * FROM stock_events WHERE epc=? ORDER BY id DESC').all(epc) :
    db.prepare('SELECT * FROM stock_events ORDER BY id DESC LIMIT 50').all();
  function report(type) {
    if (type === 'receipt-template') return csv([...receiptHeaders,...receiptOptionalHeaders],
      [['KP-IN-CSV','Demo delivery','Storage',products[0].sku,2,'','',products[0].sku,'LOT-DEMO-01',10]]);
    if (type === 'stock') return csv(['carton','epc','sku','location','stock_state','batch_lot','units_per_carton'],
      inventory().map(c => [c.carton,c.epc,c.sku,c.location,c.state,c.batch_lot,c.units_per_carton]));
    if (type === 'movements') return csv(['reference','epc','action','actor','time_utc','before','after','reason','input_source'],
      db.prepare('SELECT * FROM stock_events ORDER BY id').all().map(e => [e.ref,e.epc,e.action,e.actor,e.at,e.before_state,e.after_state,e.reason,e.source]));
    const kind = type === 'receipts' ? 'receipt' : 'count';
    return csv(['reference','location','run_id','time_utc','actor','input_source','epc','classification','reads'],
      tasks().filter(t => t.type === kind).flatMap(t => t.runs.flatMap(run =>
        ['found','missing','unexpected','unknown'].flatMap(status => run[status].map(epc =>
          [t.type === 'count' ? t.reference : t.id,t.location,run.id,run.at,run.actor,run.source,epc,status,run.observations[epc] ?? 0])))));
  }
  return {seed,reset,inventory,tasks,tagged,events,command,report,locations,
    dispatch:(user,session,before,after) => record(user,session.testId,before,after,'Dispatched','',session.source)};
}
