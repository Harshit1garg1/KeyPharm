import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {parseManifest, parsePlan, compare, normalizeEpc, validEpc, canClose, outboundManifestConflict, lockTo, pendingPallet} from '../app/src/main/assets/model.mjs';
import {nextCartonLabel,stockWorkflows} from './stock-workflows.mjs';

export const products = [
  {sku:'Physalis', quantity:20},
  {sku:'Tiger Balm', quantity:15},
  {sku:'Biotona', quantity:35}
];
const time = () => new Date().toISOString();
const fail = (message, status = 409) => { throw Object.assign(new Error(message), {status}); };
const eq = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const eligible = new Set(products.map(p => p.sku));
const reviewRoles = ['admin','reviewer'];
const dispatchRoles = ['admin','supervisor'];
const sessionActionRoles = {manifest:['admin'],reopen:['admin'],physical:['supervisor'],approve:reviewRoles,dispatch:dispatchRoles,remove:['admin']};
const cartonsOf = m => m?.pallets?.flatMap(p => p.cartons) ?? m?.cartons ?? [];
const palletCsv = pallets => ['pallet_ref,pallet_epc,carton_ref,carton_epc,sku', ...pallets.flatMap(p => p.cartons.map(c =>
    [p.pallet,p.palletEpc,c.carton,c.epc,c.sku].map(v => '"' + String(v ?? '').replaceAll('"','""') + '"').join(',')))].join('\n');
const validateManifest = m => {
  if (!m || !Array.isArray(m.pallets) || !m.pallets.length) fail('Load a valid manifest.',400);
  return parseManifest(palletCsv(m.pallets));
};
const draftPallets = draft => draft.pallets ?? (draft.csv ? [{pallet:draft.reference,palletEpc:draft.palletEpc,cartons:draft.cartons}] : []);

export function createWorkspace(path, hardwareCsv = '') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cartons (
      epc TEXT PRIMARY KEY, carton TEXT NOT NULL, sku TEXT NOT NULL, physical INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'available', reservation TEXT
    );
    CREATE TABLE IF NOT EXISTS pallet_manifests (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, actor TEXT NOT NULL, session TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, session TEXT NOT NULL
    );
  `);
  const atomic = execute => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = execute(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  if (!db.prepare("SELECT value FROM settings WHERE key='sample'").get()) atomic(() => {
    const hardware = hardwareCsv.trim() ? parseManifest(hardwareCsv) : null;
    const live = cartonsOf(hardware);
    const insert = db.prepare('INSERT INTO cartons (epc,carton,sku,physical) VALUES (?,?,?,?)');
    const mappings = new Map();
    for (const [i,carton] of live.entries()) mappings.set(carton.epc, products[i % products.length].sku);
    for (const [productIndex,{sku,quantity}] of products.entries()) {
      const tagged = live.filter(c => mappings.get(c.epc) === sku);
      for (const carton of tagged) insert.run(carton.epc,/^Carton \d+$/.test(carton.carton) ? nextCartonLabel(db,sku) : carton.carton,sku,1);
      for (let i=tagged.length; i<quantity; i++) {
        const epc = 'D3' + productIndex.toString(16) + (i + 1).toString(16).padStart(21,'0').toUpperCase();
        insert.run(epc,nextCartonLabel(db,sku),sku,0);
      }
    }
    const header = 'pallet_ref,pallet_epc,carton_ref,carton_epc,sku';
    const csv = rows => [header, ...rows.map(row => row.map(v => '"' + String(v).replaceAll('"','""') + '"').join(','))].join('\n') + '\n';
    const stockFor = db.prepare('SELECT * FROM cartons WHERE physical=0 AND sku=? ORDER BY epc LIMIT ?');
    const simulated = products.flatMap(({sku},index) => stockFor.all(sku,[14,10,16][index]));
    const simulationCsv = csv(simulated.map(c => ['KP-DEMO-40','D40000000000000000000001',c.carton,c.epc,c.sku]));
    const cartonLabel = db.prepare('SELECT carton FROM cartons WHERE epc=?');
    const physicalCsv = hardware ? csv(hardware.pallets.flatMap(p =>
      p.cartons.map(c => [p.pallet,p.palletEpc,cartonLabel.get(c.epc).carton,c.epc,mappings.get(c.epc)]))) : '';
    const setting = db.prepare('INSERT INTO settings VALUES (?,?)');
    setting.run('sample',simulationCsv);
    setting.run('physical',physicalCsv);
  });
  db.exec("UPDATE cartons SET state='available', reservation=NULL WHERE state='reserved'");
  const stockOps = stockWorkflows(db,products);
  atomic(() => {
    if (db.prepare("SELECT 1 FROM cartons WHERE sku='Juice'").get()) {
      const renameCartons = manifest => {
        for (const carton of [...(manifest?.cartons ?? []),...cartonsOf(manifest)]) {
          if (carton.sku === 'Juice') carton.sku = 'Physalis';
        }
      };
      db.exec("UPDATE cartons SET sku='Physalis' WHERE sku='Juice'");
      const writeSession = db.prepare('UPDATE sessions SET body=? WHERE id=?');
      for (const row of db.prepare('SELECT id,body FROM sessions').all()) {
        const session = JSON.parse(row.body);
        renameCartons(session.manifest);
        for (const revision of session.manifestRevisions ?? []) renameCartons(revision);
        if (session.product === 'Juice') session.product = 'Physalis';
        writeSession.run(JSON.stringify(session),row.id);
      }
      const writeTask = db.prepare('UPDATE stock_tasks SET body=? WHERE id=?');
      for (const row of db.prepare('SELECT id,body FROM stock_tasks').all()) {
        const task = JSON.parse(row.body);
        for (const carton of task.expected) if (carton.sku === 'Juice') carton.sku = 'Physalis';
        for (const counts of [task.quantities,task.receivedBySku,...task.runs.map(run => run.bySku)]) {
          if (counts && Object.hasOwn(counts,'Juice')) { counts.Physalis = counts.Juice; delete counts.Juice; }
        }
        writeTask.run(JSON.stringify(task),row.id);
      }
      db.exec(`UPDATE settings SET value=replace(value, '"Juice"', '"Physalis"') WHERE key IN ('sample','physical');`);
    }
    const legacyLabels = db.prepare('SELECT epc,carton,sku FROM cartons ORDER BY epc').all();
    const renameCarton = db.prepare('UPDATE cartons SET carton=? WHERE epc=?');
    const renameSampleCarton = db.prepare("UPDATE settings SET value=replace(value, ?, ?) WHERE key IN ('sample','physical')");
    const renamed = new Map();
    for (const {epc,carton,sku} of legacyLabels) {
      const demoStock = epc.startsWith('D3') && carton.startsWith(sku + ' ') && /^\d+$/.test(carton.slice(sku.length + 1));
      const oldJuice = epc.startsWith('D30') && sku === 'Physalis' && /^Juice \d+$/.test(carton);
      const inbound = epc.startsWith('D5') && /^Inbound \d+$/.test(carton);
      if (!demoStock && !oldJuice && !inbound && carton !== 'Carton ' + epc && !/^Carton \d+$/.test(carton)) continue;
      const label = nextCartonLabel(db,sku);
      renameCarton.run(label,epc);
      renameSampleCarton.run(`,"${carton}","${epc}",`,`,"${label}","${epc}",`);
      renamed.set(epc,label);
    }
    if (renamed.size) {
      const writeTask = db.prepare('UPDATE stock_tasks SET body=? WHERE id=?');
      for (const row of db.prepare('SELECT id,body FROM stock_tasks').all()) {
        const task = JSON.parse(row.body);
        for (const carton of task.expected) if (renamed.has(carton.epc)) carton.carton = renamed.get(carton.epc);
        writeTask.run(JSON.stringify(task),row.id);
      }
    }
    stockOps.seed();
  });
  const readSession = id => {
    const row = db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    return row ? {...JSON.parse(row.body),workspaceRevision:row.revision} : null;
  };
  const sessions = () => db.prepare('SELECT id FROM sessions ORDER BY rowid DESC').all().map(row => readSession(row.id));
  const activeSessions = () => sessions().filter(session => !session.removedAt);
  const settings = () => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='test-controls'").get()?.value ??
    '{"revision":0,"plan":[],"power":null}');
  const generation = () => Number(db.prepare("SELECT value FROM settings WHERE key='generation'").get()?.value ?? 0);
  function reset(user,input) {
    if (user.role !== 'admin') fail('Administrator access required.',403);
    if (input.confirm !== 'RESET') fail('Type RESET to confirm.',400);
    if (input.generation !== generation()) fail('The workspace changed. Refresh before resetting.');
    const next = generation() + 1;
    db.exec(`
      DELETE FROM operations;
      DELETE FROM audit;
      DELETE FROM sessions;
      DELETE FROM pallet_manifests;
      DELETE FROM settings WHERE key='test-controls';
      UPDATE cartons SET state='available', reservation=NULL;
    `);
    stockOps.reset();
    db.prepare("INSERT INTO settings VALUES ('generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(next));
    return {generation:next};
  }
  function setControls(user,input) {
    if (user.role !== 'admin') fail('Administrator access required.',403);
    const current = settings();
    if (current.lastOperation === input.operationId) return current;
    if (!input.operationId || input.revision !== current.revision) fail('Test controls changed. Refresh and review them.');
    if (input.plan !== undefined) {
      if (typeof input.plan !== 'string' || input.plan.length > 12000) fail('Enter a valid test plan.',400);
      current.plan = input.plan.trim() ? parsePlan(input.plan) : [];
    }
    if (input.power !== undefined) {
      if (input.power !== null && (!Number.isInteger(input.power) || input.power < 5 || input.power > 30)) fail('Use 5 to 30 dBm.',400);
      current.power = input.power === null ? null : {requested:input.power,requestedAt:time(),by:user.name};
    }
    for (const key of ['stockPower','palletPower','lookupPower']) {
      const power = input[key];
      if (power === undefined) continue;
      if (!(key === 'lookupPower' && power === null) && (!Number.isInteger(power) || power < 5 || power > 30)) {
        fail('Use 5 to 30 dBm.',400);
      }
      current[key] = power;
    }
    if (input.sessionPowers !== undefined) {
      if (!input.sessionPowers || typeof input.sessionPowers !== 'object' || Array.isArray(input.sessionPowers)) {
        fail('Enter valid session power settings.',400);
      }
      const powers = new Map(Object.entries(current.sessionPowers ?? {}));
      for (const [id,power] of Object.entries(input.sessionPowers)) {
        if (readSession(id)?.source !== 'C72 hardware') fail('Hardware session not found.',404);
        if (power === null) powers.delete(id);
        else {
          if (!Number.isInteger(power) || power < 5 || power > 30) fail('Use 5 to 30 dBm.',400);
          powers.set(id,power);
        }
      }
      current.sessionPowers = Object.fromEntries(powers);
    }
    if (input.applied !== undefined) {
      if (!current.power || current.power.requested !== input.applied) fail('The requested reader power changed.');
      current.power = {...current.power, applied:input.applied, appliedAt:time()};
    }
    current.lastOperation = input.operationId;
    current.revision++;
    db.prepare("INSERT INTO settings VALUES ('test-controls',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(current));
    return current;
  }
  const sample = source => db.prepare('SELECT value FROM settings WHERE key=?').get(source === 'C72 hardware' ? 'physical' : 'sample').value;
  const audit = (s,user,action,detail = '') => {
    const at = time();
    s.logs.push({at,actor:user.name,action,detail});
    db.prepare('INSERT INTO audit (at,actor,action,session) VALUES (?,?,?,?)').run(at,user.id,action,s.id);
  };
  function write(s, revision) {
    const snapshot = {...s};
    delete snapshot.workspaceRevision;
    db.prepare('INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, body=excluded.body')
      .run(s.id,revision,JSON.stringify(snapshot));
    return readSession(s.id);
  }
  function stock(epc) { return db.prepare('SELECT * FROM cartons WHERE epc=?').get(epc); }
  function checkStock(manifest,currentId) {
    const inventory = [];
    for (const c of cartonsOf(manifest)) {
      const carton = stock(c.epc);
      if (!eligible.has(c.sku) || carton?.sku !== c.sku) fail('EPC ' + c.epc + ' has no matching stock SKU.');
      if (carton.state === 'expected') fail('EPC ' + c.epc + ' has not been received.');
      inventory.push(carton);
    }
    const conflict = outboundManifestConflict(manifest,inventory,activeSessions(),currentId);
    if (conflict) fail(conflict);
  }
  const manifests = () => db.prepare('SELECT body FROM pallet_manifests ORDER BY rowid DESC').all().map(row => JSON.parse(row.body));
  const savePalletManifest = draft => {
    db.prepare('INSERT INTO pallet_manifests VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(draft.id,JSON.stringify(draft));
    return draft;
  };
  function assignedCartonEpcs() {
    const fromDrafts = manifests().filter(draft => draft.status !== 'Cancelled')
      .flatMap(draft => draftPallets(draft).flatMap(pallet => pallet.cartons));
    const fromSessions = activeSessions().flatMap(session => cartonsOf(session.manifest));
    return new Set([...fromDrafts,...fromSessions].map(carton => carton.epc));
  }
  function existingPallets() {
    const sessions = activeSessions();
    const sessionPallets = new Set(sessions.flatMap(session => session.manifest?.pallets ?? []).map(pallet => pallet.palletEpc));
    const sessionCartons = new Set(sessions.flatMap(session => cartonsOf(session.manifest)).map(carton => carton.epc));
    return manifests().filter(draft => draft.status === 'Manifest ready').flatMap(draft => draftPallets(draft)
      .filter(pallet => !sessionPallets.has(pallet.palletEpc) &&
        pallet.cartons.every(carton => stock(carton.epc)?.state === 'available' && !sessionCartons.has(carton.epc)))
      .map(pallet => ({draftId:draft.id,...pallet})));
  }
  function readyManifest(draft,pallets) {
    if (pallets.reduce((total,pallet) => total + 1 + pallet.cartons.length,0) > 500) fail('A manifest can use up to 500 labels.',400);
    const csv = palletCsv(pallets);
    checkStock(parseManifest(csv));
    return {...draft,pallets,csv,status:'Manifest ready',generatedAt:time()};
  }
  function palletAvailable(epc,id) {
    if (stock(epc) || manifests().some(draft => draft.id !== id && draft.status !== 'Cancelled' && (draft.palletEpc === epc || draftPallets(draft).some(p => p.palletEpc === epc))) ||
        activeSessions().some(session => [session.manifest,...(session.manifestRevisions ?? [])].some(manifest =>
          manifest?.pallets?.some(pallet => pallet.palletEpc === epc) || cartonsOf(manifest).some(carton => carton.epc === epc)))) {
      fail('This EPC is already registered. Scan an unused pallet tag.');
    }
  }
  function palletManifest(user,input,deviceId,devices) {
    if (input.action === 'request') {
      if (deviceId || user.role !== 'admin') fail('Administrator access required.',403);
      if (!devices.includes(input.deviceId)) fail('Choose a connected handheld.',400);
      const reference = String(input.reference ?? '').trim();
      if (!reference || reference.length > 80 || /^[=+@-]/.test(reference) || /[\r\n]/.test(reference)) fail('Enter a valid pallet reference.',400);
      if (manifests().some(draft => draft.deviceId === input.deviceId && draft.status === 'Awaiting pallet scan')) fail('That handheld already has a pending pallet scan.');
      return savePalletManifest({id:randomUUID(),reference,deviceId:input.deviceId,status:'Awaiting pallet scan',createdAt:time(),by:user.name});
    }
    const draft = manifests().find(row => row.id === input.id);
    if (!draft) fail('Pallet manifest request not found.',404);
    if (input.action === 'scan') {
      if (user.role !== 'operator' || !deviceId || deviceId !== draft.deviceId) fail('This pallet scan is assigned to a different handheld.',403);
      const epc = normalizeEpc(input.epc);
      if (draft.status === 'Pallet scanned' && draft.palletEpc === epc && input.scanReference === draft.scanReference) return draft;
      if (draft.status !== 'Awaiting pallet scan' || input.scanReference !== draft.scanReference) fail('This pallet scan is no longer pending.');
      if (!validEpc(epc)) fail('Scan a valid pallet EPC.',400);
      if (draftPallets(draft).some(pallet => pallet.palletEpc === epc)) fail('That pallet is already in this manifest.');
      palletAvailable(epc,draft.id);
      return savePalletManifest({...draft,palletEpc:epc,scannedAt:time(),scannedBy:user.name,status:'Pallet scanned'});
    }
    if (deviceId || user.role !== 'admin') fail('Administrator access required.',403);
    if (input.action === 'cancel' && input.confirmed === true && draft.status !== 'Cancelled') {
      return savePalletManifest({...draft,status:'Cancelled',removedAt:time(),removedBy:user.name});
    }
    if (input.action === 'add-existing' && draft.status === 'Manifest ready') {
      const selected = existingPallets().find(pallet => pallet.draftId !== draft.id && pallet.palletEpc === normalizeEpc(input.palletEpc));
      if (!selected) fail('That pallet is no longer available. Refresh and choose another pallet.');
      const source = manifests().find(row => row.id === selected.draftId);
      const {pallet,palletEpc,cartons} = selected;
      const pallets = draftPallets(draft);
      if (pallets.some(entry => entry.pallet.toUpperCase() === pallet.toUpperCase())) fail('This manifest already has a pallet with that reference.');
      const combined = readyManifest(draft,[...pallets,{pallet,palletEpc,cartons}]);
      const remaining = draftPallets(source).filter(entry => entry.palletEpc !== palletEpc);
      const last = remaining.at(-1);
      if (last) {
        savePalletManifest(readyManifest({...source,scanReference:undefined,palletEpc:last.palletEpc},remaining));
      } else {
        savePalletManifest({...source,status:'Cancelled',mergedInto:draft.id});
      }
      return savePalletManifest(combined);
    }
    if (input.action === 'add-pallet' && draft.status === 'Manifest ready') {
      const scanReference = String(input.reference ?? '').trim();
      if (!scanReference || scanReference.length > 80 || /^[=+@-]/.test(scanReference) || /[\r\n]/.test(scanReference)) fail('Enter a valid pallet reference.',400);
      const pallets = draftPallets(draft);
      if (pallets.some(pallet => pallet.pallet.toUpperCase() === scanReference.toUpperCase())) fail('Use a different pallet reference.');
      if (!devices.includes(draft.deviceId)) fail('Connect the assigned handheld first.');
      if (manifests().some(other => other.deviceId === draft.deviceId && other.status === 'Awaiting pallet scan')) fail('That handheld already has a pending pallet scan.');
      return savePalletManifest({...draft,pallets,scanReference,palletEpc:null,csv:null,status:'Awaiting pallet scan'});
    }
    if (input.action === 'generate' && draft.status === 'Pallet scanned') {
      if (!Array.isArray(input.epcs) || input.epcs.length < 1 || input.epcs.length > 499) fail('Select 1 to 499 cartons.',400);
      palletAvailable(draft.palletEpc,draft.id);
      const epcs = [...new Set(input.epcs.map(normalizeEpc))];
      if (epcs.length !== input.epcs.length || !Array.isArray(input.locations) || input.locations.length !== epcs.length) fail('Preview the selected cartons again.',400);
      const assigned = assignedCartonEpcs();
      const cartons = epcs.map((epc,index) => {
        if (assigned.has(epc)) fail('A selected carton is already assigned to a pallet. Refresh and choose an unassigned carton.');
        const carton = stock(epc);
        if (carton?.state !== 'available') fail('A selected carton is no longer available. Review the selection.');
        if (carton.location !== input.locations[index]) fail('A pickup location changed. Preview the selected cartons again.');
        return {epc,sku:carton.sku,carton:carton.carton,location:carton.location};
      });
      const pallets = [...draftPallets(draft),{pallet:draft.scanReference ?? draft.reference,palletEpc:draft.palletEpc,cartons}];
      return savePalletManifest(readyManifest(draft,pallets));
    }
    if (input.action === 'session' && draft.status === 'Manifest ready') {
      for (const pallet of draftPallets(draft)) {
        palletAvailable(pallet.palletEpc,draft.id);
        if (pallet.cartons.some(carton => stock(carton.epc)?.state !== 'available')) fail('A manifest carton is no longer available.');
      }
      const session = create(user,{testId:input.testId,location:input.location,source:'C72 hardware',csv:draft.csv});
      return savePalletManifest({...draft,sessionId:session.id,status:'Session created'});
    }
    fail('This action is unavailable for the pallet manifest.');
  }
  function hasVerifiedMatch(s) {
    if (s.manifest?.pallets?.length > 1) return !s.dispatchedAt && s.verifiedBy && s.confirmedAt && !pendingPallet(s);
    const run = s.runs.at(-1);
    return !s.dispatchedAt && s.verifiedBy && s.confirmedAt && s.identified && run?.state === 'Finished' &&
      run.manifestRevision === s.manifest?.revision && run.result?.status === 'Match' && s.manifest?.cartons.length > 0;
  }
  function approveDispatch(s,user) {
    s.acceptedAt = time();
    s.dispatchApproval = {at:s.acceptedAt,by:user.name,role:user.role};
    audit(s,user,'Dispatch approved',user.name);
  }
  function dispatch(s,user) {
    if (!hasVerifiedMatch(s)) fail(s.testId + ' needs a verified pallet and a clean result.');
    if (!s.dispatchApproval) {
      if (user.role !== 'admin') fail(s.testId + ' needs dispatch approval from the Administrator or Reviewer.');
      approveDispatch(s,user);
    }
    const deduct = db.prepare("UPDATE cartons SET state='dispatched', reservation=NULL WHERE epc=? AND state='available'");
    for (const carton of cartonsOf(s.manifest)) {
      const before = stock(carton.epc);
      if (deduct.run(carton.epc).changes !== 1) fail('Carton ' + carton.epc + ' is no longer on hand for ' + s.testId + '.');
      stockOps.dispatch(user,s,before,stock(carton.epc));
    }
    s.dispatchedAt = time();
    audit(s,user,'Dispatch confirmed',cartonsOf(s.manifest).length + ' cartons');
    return write(s,s.workspaceRevision + 1);
  }
  function dispatchSelected(user,input) {
    if (!dispatchRoles.includes(user.role)) fail('Administrator or Supervisor access required.',403);
    if (input.confirmed !== true || !Array.isArray(input.sessions) || !input.sessions.length) fail('Select sessions and confirm dispatch.',400);
    const results = [];
    const seen = new Set();
    for (const selected of input.sessions) {
      if (!selected?.id || seen.has(selected.id)) fail('Select each session once.',400);
      seen.add(selected.id);
      const s = readSession(selected.id);
      if (!s || s.removedAt || s.workspaceRevision !== selected.revision) fail('A selected session changed. Refresh and review the selection.');
      results.push(dispatch(s,user));
    }
    return results;
  }
  function reviseManifest(s,manifest,source) {
    if (s.manifest) (s.manifestRevisions ??= []).push(s.manifest);
    s.manifest = {...manifest,revision:(s.manifest?.revision ?? 0) + 1,source,importedAt:time()};
    s.verifiedBy = s.verifiedAt = s.confirmedAt = s.acceptedAt = s.closedAt = s.closure = null;
    s.identified = false;
    delete s.palletMatches;
    delete s.packedAt;
    delete s.dispatchApproval;
    s.allocation = {cartons:cartonsOf(manifest).length,pallets:manifest.pallets.length};
  }
  function create(user, input) {
    if (user.role !== 'admin') fail('Administrator access required.',403);
    const testId = String(input.testId ?? '').trim();
    const location = String(input.location ?? '').trim();
    if (!testId || testId.length > 80 || !location || location.length > 100) fail('Enter a valid test ID and location.',400);
    if (sessions().some(s => s.testId === testId)) fail('That test ID already exists.');
    if (!['C72 hardware','Simulation'].includes(input.source)) fail('Choose a valid reader source.',400);
    const csv = input.csv || (input.sample ? sample(input.source) : '');
    const manifest = csv ? parseManifest(csv) : null;
    if (manifest) checkStock(manifest);
    const s = {
      id:input.id ?? randomUUID(), testId, location, level:'Ground', product:'Mixed cartons', palletType:'Mixed',
      label:'UHF', placement:'Long side', wrapping:'Unwrapped', shielding:'Not tested', method:'Walk around the pallet',
      planned:'Outbound pallet check', source:input.source, mode:'POC', creator:user.name, createdAt:time(),
      runs:[], logs:[], allocation:{}
    };
    if (manifest) {
      s.manifest = {...manifest,revision:1,source:input.sample ? 'Sample CSV' : 'Dashboard CSV',demo:!!input.sample,importedAt:time()};
      s.allocation = {cartons:cartonsOf(manifest).length,pallets:manifest.pallets.length};
    }
    audit(s,user,'Session created');
    return write(s,1);
  }
  function action(user, input, dashboard) {
    if (!Object.hasOwn(sessionActionRoles,input.action) || (!sessionActionRoles[input.action].includes(user.role) && !(dashboard && user.role === 'admin'))) {
      fail('Action is unavailable for this role.',403);
    }
    const s = readSession(input.id);
    if (!s || s.removedAt) fail('Session not found.',404);
    if (input.action === 'remove' && input.confirmed === true) {
      if (s.workspaceRevision !== input.revision) fail('Session changed. Refresh and review it.');
      s.removedAt = time();
      audit(s,user,'Session removed');
      return write(s,s.workspaceRevision + 1);
    }
    if (input.action === 'dispatch' && s.dispatchedAt) return s;
    if (s.workspaceRevision !== input.revision || s.dispatchedAt) fail('Session changed. Refresh and review it.');
    if (input.action === 'manifest' && (s.closedAt || (!s.confirmedAt && !s.acceptedAt))) {
      const manifest = parseManifest(input.csv || sample(s.source));
      checkStock(manifest,s.id);
      if (s.closedAt) audit(s,user,'Session reopened for manifest change');
      reviseManifest(s,manifest,'Dashboard CSV');
      audit(s,user,'Manifest saved');
    } else if (input.action === 'reopen' && s.closedAt && input.confirmed === true) {
      const manifest = validateManifest(s.manifest);
      checkStock(manifest,s.id);
      reviseManifest(s,manifest,s.manifest.source);
      audit(s,user,'Session reopened');
    } else if (input.action === 'physical' && !s.closedAt && s.manifest && !s.verifiedAt && input.confirmed === true) {
      s.verifiedBy = user.name;
      s.verifiedAt = time();
      audit(s,user,'Physical verification',String(input.note ?? '').slice(0,320));
    } else if (input.action === 'approve' && input.confirmed === true) {
      if (!hasVerifiedMatch(s)) fail('A clean result and physical check are required.');
      if (s.dispatchApproval) return s;
      approveDispatch(s,user);
    } else if (input.action === 'dispatch' && input.confirmed === true) {
      return dispatch(s,user);
    } else fail('Action is unavailable for this role or session state.',403);
    return write(s,s.workspaceRevision + 1);
  }
  const hasPalletRead = (s,pallet) => s.palletAttempts?.some(attempt =>
    attempt.manifestRevision === s.manifest.revision && attempt.palletEpc === pallet.palletEpc &&
    Object.hasOwn(attempt.observations ?? {},pallet.palletEpc));
  function syncOne(user, change) {
    if (user.role === 'reviewer') fail('Reviewer access is read-only.',403);
    const incoming = change.session;
    if (!incoming || !/^[a-f0-9-]{36}$/i.test(incoming.id) || !/^[a-f0-9-]{36}$/i.test(change.operationId)) fail('Invalid session or operation ID.',400);
    const prior = db.prepare('SELECT * FROM operations WHERE id=?').get(change.operationId);
    if (prior) {
      const formerDemoAccount = user.id === 'testing' && prior.actor === 'handheld';
      if ((prior.actor !== user.id && !formerDemoAccount) || prior.session !== incoming.id) fail('Operation ID is already in use.');
      return readSession(prior.session);
    }
    let s = readSession(incoming.id);
    if (!s) {
      if (change.revision !== 0) fail('Session no longer exists.');
      s = create(user,incoming);
    } else if (s.removedAt || s.workspaceRevision !== change.revision || s.closedAt ||
        ((s.dispatchedAt || s.acceptedAt) && !incoming.closedAt)) {
      fail('Server session changed. Local evidence is still on the C72.');
    }
    // Once approved, a closure may be recorded without touching the accepted evidence.
    const evidenceEditable = !s.dispatchedAt && !s.acceptedAt;
    if (evidenceEditable && user.role === 'admin') {
      if (incoming.manifest?.revision !== s.manifest?.revision && incoming.manifest && !s.confirmedAt) {
        const verified = validateManifest(incoming.manifest);
        checkStock(verified,s.id);
        if (s.manifest) (s.manifestRevisions ??= []).push(s.manifest);
        s.manifest = {...verified,revision:(s.manifest?.revision ?? 0) + 1,source:incoming.manifest.source,importedAt:time()};
        s.allocation = {cartons:cartonsOf(verified).length,pallets:verified.pallets.length};
        s.verifiedAt = s.verifiedBy = null;
        s.identified = false;
        delete s.palletMatches;
        audit(s,user,'Manifest saved');
      }
    } else if (evidenceEditable && user.role === 'supervisor') {
      if (incoming.verifiedAt && !s.verifiedAt && s.manifest) {
        s.verifiedBy = user.name; s.verifiedAt = time();
        audit(s,user,'Physical verification');
      }
    } else if (evidenceEditable && user.role === 'operator') {
      const previousAttempts = s.palletAttempts ?? [];
      const attemptIds = new Set(previousAttempts.map(attempt => attempt.id ?? attempt.startedAt));
      const extraAttempts = (incoming.palletAttempts ?? []).filter(attempt => !attemptIds.has(attempt.id ?? attempt.startedAt));
      const runIds = new Set(s.runs.map(run => run.id));
      const newRuns = (incoming.runs ?? []).filter(run => run.state !== 'Reading' && !runIds.has(run.id));
      if (!s.verifiedAt || !s.manifest) {
        if (extraAttempts.length || newRuns.length || incoming.confirmedAt || Object.keys(incoming.palletMatches ?? {}).length) {
          fail('The server requires a physical check before scanning.');
        }
        return s;
      }
      const multi = s.manifest.pallets.length > 1;
      const found = incoming.manifest?.palletEpc;
      if (!multi && !s.identified && incoming.identified && found) {
        const locked = s.manifest.pallets.find(p => p.palletEpc === found);
        const observation = incoming.palletAttempts?.at(-1)?.observations ?? {};
        if (locked && [locked.palletEpc,...locked.cartons.map(c => c.epc)].some(epc => Object.hasOwn(observation,epc))) {
          s.manifest = {...s.manifest,...locked};
          s.identified = true;
        }
      }
      if (extraAttempts.length) s.palletAttempts = [...previousAttempts,...extraAttempts.map(attempt => ({...attempt,actor:user.name}))];
      for (const incomingRun of newRuns) {
        if (runIds.has(incomingRun.id)) continue;
        runIds.add(incomingRun.id);
        const target = s.manifest.pallets.find(pallet => pallet.palletEpc === incomingRun.palletEpc);
        const identified = multi ? target && !s.palletMatches?.[target.palletEpc] && hasPalletRead(s,target) : s.identified;
        if (!identified || incomingRun.manifestRevision !== s.manifest.revision ||
            !['Finished','Interrupted'].includes(incomingRun.state) || incomingRun.source !== s.source) fail('Run does not match the current verified manifest.');
        const observations = incomingRun.observations ?? {};
        const result = compare(multi ? lockTo(s.manifest,target) : s.manifest,Object.keys(observations).map(normalizeEpc));
        s.runs.push({...incomingRun,operator:user.name,observations,result});
        audit(s,user,'Carton scan recorded',incomingRun.state === 'Interrupted' ? 'Interrupted' : result.status);
      }
      if (multi) {
        const confirmed = new Set(Object.values(incoming.palletMatches ?? {}));
        for (let target = pendingPallet(s); target; target = pendingPallet(s)) {
          const run = s.runs.findLast(candidate => candidate.manifestRevision === s.manifest.revision && candidate.palletEpc === target.palletEpc);
          if (!run || !confirmed.has(run.id) || run.state !== 'Finished' || run.result.status !== 'Match') break;
          (s.palletMatches ??= {})[target.palletEpc] = run.id;
          audit(s,user,'Clean match confirmed',target.pallet);
        }
        const target = pendingPallet(s);
        s.identified = Boolean(target && hasPalletRead(s,target));
        if (s.identified) s.manifest = lockTo(s.manifest,target);
        s.confirmedAt = target ? null : s.confirmedAt ?? time();
      }
      if (!multi && incoming.confirmedAt && s.identified && s.runs.at(-1)?.state === 'Finished' && s.runs.at(-1)?.result.status === 'Match') {
        if (!s.confirmedAt) audit(s,user,'Clean match confirmed');
        s.confirmedAt ??= time();
      }
    }
    if (incoming.closedAt) {
      const review = incoming.closure;
      if (typeof review?.coverage !== 'string' || review.coverage.length > 500 ||
          review.reviewed !== true || !canClose(s,review,user.role)) {
        fail('Review the saved scans and enter the coverage before closing the session.');
      }
      s.closedAt = time();
      s.closure = {coverage:review.coverage.trim(),actor:user.name,reviewed:true};
      audit(s,user,'Session closed',s.closure.coverage);
    }
    db.prepare('INSERT INTO operations VALUES (?,?,?)').run(change.operationId,user.id,s.id);
    return write(s,s.workspaceRevision + 1);
  }
  return {
    close:() => db.close(),
    records:() => ({sessions:activeSessions()}),
    removedSessions:() => sessions().filter(session => session.removedAt).map(session => session.id),
    outbound:(user,records) => ({
      approvable:reviewRoles.includes(user.role) ? records.filter(s => !s.dispatchApproval && hasVerifiedMatch(s)).map(s => s.id) : [],
      dispatchable:dispatchRoles.includes(user.role) ? records.filter(s => (s.dispatchApproval || user.role === 'admin') && hasVerifiedMatch(s) &&
        cartonsOf(s.manifest).every(carton => stock(carton.epc)?.state === 'available')).map(s => s.id) : []
    }),
    sample,
    settings,
    generation,
    reset:(user,input) => atomic(() => reset(user,input)),
    inventory:stockOps.inventory,
    stockTasks:() => ({tasks:stockOps.tasks().map(stockOps.tagged),locations:stockOps.locations,events:stockOps.events()}),
    palletManifests:manifests,
    assignedCartonEpcs:() => [...assignedCartonEpcs()],
    existingPallets,
    palletManifest:(user,input,deviceId,devices) => atomic(() => palletManifest(user,input,deviceId,devices)),
    stockHistory:stockOps.events,
    stockReport:stockOps.report,
    stockCommand:(user,input,dashboard) => atomic(() => stockOps.command(user,input,create,dashboard,epc => activeSessions().some(s => cartonsOf(s.manifest).some(c => c.epc === epc)))),
    create:(user,input) => atomic(() => create(user,input)),
    action:(user,input,dashboard) => atomic(() => action(user,input,dashboard)),
    dispatchSelected:(user,input) => atomic(() => dispatchSelected(user,input)),
    sync:(user,input) => atomic(() => syncOne(user,input)),
    setControls:(user,input) => atomic(() => setControls(user,input)),
  };
}
