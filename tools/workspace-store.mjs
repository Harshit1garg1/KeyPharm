import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {parseManifest, parseCsvRows, skuManifestCsv, palletCartonCount, skuProduct, parsePlan, compareOutbound, normalizeEpc, validEpc, canClose, outboundManifestConflict, lockTo, pendingPallet, cartonSku, demoSku, palletIdentifier, matchesPalletIdentifier, defaultInventoryOptions} from '../app/src/main/assets/model.mjs';
import {nextCartonLabel,stockWorkflows,OUTBOUND_STAGING} from './stock-workflows.mjs';

export const products = [
  {sku:'Physalis', quantity:20},
  {sku:'Tiger Balm', quantity:15},
  {sku:'Biotona', quantity:35}
];
const time = () => new Date().toISOString();
const fail = (message, status = 409) => { throw Object.assign(new Error(message), {status}); };
const eq = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const eligible = new Set(products.map(p => p.sku));
const productFamily = sku => products.find(product => sku.startsWith(product.sku + '-'))?.sku ?? sku;
const reviewRoles = ['admin','reviewer'];
const dispatchRoles = ['admin','supervisor'];
const sessionActionRoles = {manifest:['admin'],reopen:['admin'],physical:['supervisor'],approve:reviewRoles,dispatch:dispatchRoles,remove:['admin']};
const cartonsOf = m => m?.pallets?.flatMap(p => p.cartons) ?? m?.cartons ?? [];
const palletCsv = pallets => ['pallet_ref,pallet_epc,carton_ref,carton_epc,sku', ...pallets.flatMap(p => p.cartons.map(c =>
    [p.pallet,p.palletEpc,c.carton,c.epc,c.sku].map(v => '"' + String(v ?? '').replaceAll('"','""') + '"').join(',')))].join('\n');
const validateManifest = m => {
  if (!m || !Array.isArray(m.pallets) || !m.pallets.length) fail('Load a valid manifest.',400);
  return parseManifest(m.matchBy === 'sku' ? skuManifestCsv(m.pallets) : palletCsv(m.pallets));
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
    CREATE TABLE IF NOT EXISTS pallet_inventory (
      epc TEXT PRIMARY KEY, reference TEXT NOT NULL COLLATE NOCASE UNIQUE,
      sku TEXT NOT NULL, size TEXT NOT NULL, material TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pallet_manifests (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dashboard_sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, actor TEXT NOT NULL, session TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, session TEXT NOT NULL,
      role TEXT, actor_name TEXT, detail TEXT
    );
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL, last_contact_at TEXT NOT NULL,
      last_role TEXT, last_actor TEXT
    );
    CREATE TABLE IF NOT EXISTS settings_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL,
      revision INTEGER NOT NULL, controls_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS manifest_revisions (
      session_id TEXT NOT NULL, revision INTEGER NOT NULL, source TEXT, pallet_ref TEXT, pallet_epc TEXT,
      carton_count INTEGER NOT NULL, imported_at TEXT, manifest_json TEXT NOT NULL,
      PRIMARY KEY (session_id, revision)
    );
    CREATE TABLE IF NOT EXISTS pallet_attempts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, manifest_revision INTEGER, actor TEXT,
      locked_pallet TEXT, pallet_epc TEXT, result TEXT, started_at TEXT, ended_at TEXT,
      profile_json TEXT, observations_json TEXT
    );
    CREATE INDEX IF NOT EXISTS pallet_attempts_session ON pallet_attempts(session_id);
    CREATE TABLE IF NOT EXISTS scan_runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, pallet_epc TEXT, manifest_revision INTEGER,
      operator TEXT, source TEXT, state TEXT, status TEXT, expected_count INTEGER, matched_count INTEGER,
      missing_count INTEGER, extra_count INTEGER, percent INTEGER, reason TEXT, notes TEXT, error TEXT,
      started_at TEXT, ended_at TEXT, elapsed_seconds INTEGER, profile_json TEXT, result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS scan_runs_session ON scan_runs(session_id);
    CREATE TABLE IF NOT EXISTS scan_observations (
      run_id TEXT NOT NULL, epc TEXT NOT NULL, outcome TEXT NOT NULL, read_count INTEGER NOT NULL,
      rssi REAL, first_seen_at TEXT, last_seen_at TEXT,
      PRIMARY KEY (run_id, epc)
    );
    CREATE INDEX IF NOT EXISTS scan_observations_epc ON scan_observations(epc);
  `);
  const AUDIT_CAP = 300;
  const auditColumns = new Set(db.prepare('PRAGMA table_info(audit)').all().map(column => column.name));
  if (!auditColumns.has('role')) db.exec('ALTER TABLE audit ADD COLUMN role TEXT');
  if (!auditColumns.has('actor_name')) db.exec('ALTER TABLE audit ADD COLUMN actor_name TEXT');
  if (!auditColumns.has('detail')) db.exec('ALTER TABLE audit ADD COLUMN detail TEXT');
  const recordAudit = (user, action, sessionRef, detail = '') => {
    const at = time();
    db.prepare('INSERT INTO audit (at,actor,action,session,role,actor_name,detail) VALUES (?,?,?,?,?,?,?)')
      .run(at, user?.id ?? '', action, String(sessionRef ?? ''), user?.role ?? null, user?.name ?? null, detail);
    db.prepare('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT ?)').run(AUDIT_CAP);
    return at;
  };
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
  const stockOps = stockWorkflows(db,products,(user,action,ref,detail) => recordAudit(user,action,ref,detail));
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
  const inventoryOptions = () => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='inventory-options'").get()?.value ??
    JSON.stringify(defaultInventoryOptions));
  const settings = () => ({...JSON.parse(db.prepare("SELECT value FROM settings WHERE key='test-controls'").get()?.value ??
    '{"revision":0,"plan":[],"power":null}'),inventoryOptions:inventoryOptions()});
  const generation = () => Number(db.prepare("SELECT value FROM settings WHERE key='generation'").get()?.value ?? 0);
  const insertManifestRev = db.prepare(`INSERT INTO manifest_revisions
    (session_id,revision,source,pallet_ref,pallet_epc,carton_count,imported_at,manifest_json)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id,revision) DO UPDATE SET manifest_json=excluded.manifest_json`);
  const insertPalletAttempt = db.prepare(`INSERT INTO pallet_attempts
    (id,session_id,manifest_revision,actor,locked_pallet,pallet_epc,result,started_at,ended_at,profile_json,observations_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result,observations_json=excluded.observations_json`);
  const insertScanRun = db.prepare(`INSERT INTO scan_runs
    (id,session_id,pallet_epc,manifest_revision,operator,source,state,status,expected_count,matched_count,missing_count,extra_count,percent,reason,notes,error,started_at,ended_at,elapsed_seconds,profile_json,result_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    state=excluded.state,status=excluded.status,matched_count=excluded.matched_count,missing_count=excluded.missing_count,
    extra_count=excluded.extra_count,percent=excluded.percent,reason=excluded.reason,notes=excluded.notes,error=excluded.error,
    ended_at=excluded.ended_at,elapsed_seconds=excluded.elapsed_seconds,result_json=excluded.result_json`);
  const deleteObs = db.prepare('DELETE FROM scan_observations WHERE run_id=?');
  const insertObs = db.prepare('INSERT OR REPLACE INTO scan_observations (run_id,epc,outcome,read_count,rssi,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?)');
  function syncSessionRecords(s) {
    const revisions = new Map();
    for (const m of [...(s.manifestRevisions ?? []), ...(s.manifest ? [s.manifest] : [])]) {
      if (m) revisions.set(m.revision ?? 1,m);
    }
    for (const [rev,m] of revisions) {
      insertManifestRev.run(s.id,rev,m.source ?? null,m.pallet ?? null,m.palletEpc ?? null,
        expectedCartons(m),m.importedAt ?? null,JSON.stringify(m));
    }
    for (const [i,attempt] of (s.palletAttempts ?? []).entries()) {
      insertPalletAttempt.run(attempt.id ?? (s.id + ':attempt:' + i),s.id,attempt.manifestRevision ?? null,
        attempt.actor ?? null,attempt.lockedPallet ?? null,attempt.palletEpc ?? null,attempt.result ?? null,
        attempt.startedAt ?? null,attempt.endedAt ?? null,JSON.stringify(attempt.profile ?? null),JSON.stringify(attempt.observations ?? {}));
    }
    const palletEpcs = new Set((s.manifest?.pallets ?? (s.manifest?.palletEpc ? [s.manifest] : [])).map(p => p.palletEpc));
    for (const [i,run] of (s.runs ?? []).entries()) {
      const runId = run.id ?? (s.id + ':run:' + i);
      const r = run.result;
      const status = run.state === 'Interrupted' ? 'Interrupted' : (r?.status ?? run.state ?? null);
      insertScanRun.run(runId,s.id,run.palletEpc ?? null,run.manifestRevision ?? null,run.operator ?? null,
        run.source ?? null,run.state ?? null,status,r?.expected ?? null,r?.matched?.length ?? null,
        r?.missing?.length ?? null,r?.extra?.length ?? null,r?.percent ?? null,run.reason ?? null,
        run.note ?? run.notes ?? null,run.error ?? null,run.startedAt ?? null,run.endedAt ?? null,
        run.elapsedSeconds ?? null,JSON.stringify(run.profile ?? null),JSON.stringify(r ?? null));
      deleteObs.run(runId);
      const matchedSet = new Set(r?.matched ?? []);
      const extraSet = new Set(r?.extra ?? []);
      const seen = new Set();
      for (const [epc,info] of Object.entries(run.observations ?? {})) {
        seen.add(epc);
        const outcome = matchedSet.has(epc) ? 'matched' : extraSet.has(epc) ? 'extra' :
          (epc === run.palletEpc || palletEpcs.has(epc)) ? 'pallet_tag' : 'observed';
        const count = typeof info === 'number' ? info : (info?.count ?? 1);
        insertObs.run(runId,epc,outcome,count,info?.rssi ?? null,info?.first ?? null,info?.last ?? null);
      }
      for (const missingEpc of r?.missing ?? []) {
        if (!seen.has(missingEpc)) insertObs.run(runId,missingEpc,'missing',0,null,null,null);
      }
    }
  }
  atomic(() => {
    for (const row of db.prepare('SELECT body FROM sessions').all()) syncSessionRecords(JSON.parse(row.body));
    db.prepare('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT ?)').run(AUDIT_CAP);
  });
  function reset(user,input) {
    if (user.role !== 'admin') fail('Administrator access required.',403);
    if (input.confirm !== 'RESET') fail('Type RESET to confirm.',400);
    if (input.generation !== generation()) fail('The workspace changed. Refresh before resetting.');
    const next = generation() + 1;
    db.exec(`
      DELETE FROM operations;
      DELETE FROM audit;
      DELETE FROM devices;
      DELETE FROM settings_history;
      DELETE FROM manifest_revisions;
      DELETE FROM pallet_attempts;
      DELETE FROM scan_observations;
      DELETE FROM scan_runs;
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
    if (input.inventoryOption !== undefined) {
      const {group,action,label} = input.inventoryOption ?? {};
      const material = group === 'palletMaterials';
      const name = typeof label === 'string' ? label.trim() : '';
      const candidate = name.normalize('NFKD').replace(/[^a-z0-9]/gi,'').toUpperCase();
      const generated = candidate.length > 4 ? candidate.slice(0,Math.floor(candidate.length / 2)) : candidate;
      const code = String(input.inventoryOption?.code ?? '').trim().toUpperCase() || (material && action === 'add' ? generated : '');
      if (!material && action === 'add' && !code) fail('Enter a size code.',400);
      if (!Object.hasOwn(defaultInventoryOptions,group) || !/^[A-Z0-9]{1,20}$/.test(code)) fail('Enter a valid option code.',400);
      const options = current.inventoryOptions[group];
      if (action === 'add') {
        const displayName = name || code;
        const upperName = displayName.toUpperCase();
        const existing = options.find(option => option.code === code);
        const restoring = existing?.archived && (!material || existing.label.toUpperCase() === upperName);
        const conflict = options.some(option => option !== (restoring ? existing : null) &&
          (material || !option.archived) && (option.code === code ||
            option.label.toUpperCase() === upperName || option.label.toUpperCase() === code || option.code === upperName));
        if (displayName.length > 40 || conflict) fail('That option code or name is already in use.',400);
        if (restoring) {
          existing.label = displayName;
          delete existing.archived;
        } else options.push({code,label:displayName});
      } else if (action === 'remove') {
        const active = options.filter(option => !option.archived);
        const option = active.find(entry => entry.code === code);
        if (active.length <= 1 || !option) fail('Keep at least one option in each list.',400);
        option.archived = true;
      } else fail('Choose add or remove.',400);
      db.prepare("INSERT INTO settings VALUES ('inventory-options',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(current.inventoryOptions));
    }
    if (input.plan !== undefined) {
      if (typeof input.plan !== 'string' || input.plan.length > 12000) fail('Enter a valid test plan.',400);
      current.plan = input.plan.trim() ? parsePlan(input.plan) : [];
    }
    if (input.power !== undefined) {
      if (input.power !== null && (!Number.isInteger(input.power) || input.power < 5 || input.power > 30)) fail('Use 5 to 30 dBm.',400);
      current.power = input.power === null ? null : {requested:input.power,requestedAt:time(),by:user.name};
    }
    for (const key of ['stockPower','palletPower','lookupPower','identifyPower']) {
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
    db.prepare('INSERT INTO settings_history (at,actor,role,revision,controls_json) VALUES (?,?,?,?,?)')
      .run(time(),user.name,user.role,current.revision,JSON.stringify(current));
    recordAudit(user,'Settings updated','workspace',Object.keys(input).filter(k => !['operationId','revision'].includes(k)).join(','));
    return current;
  }
  const sample = source => db.prepare('SELECT value FROM settings WHERE key=?').get(source === 'C72 hardware' ? 'physical' : 'sample').value;
  const audit = (s,user,action,detail = '') => {
    const at = recordAudit(user,action,s.id,detail);
    s.logs.push({at,actor:user.name,action,detail});
  };
  function write(s, revision) {
    const snapshot = {...s};
    delete snapshot.workspaceRevision;
    db.prepare('INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, body=excluded.body')
      .run(s.id,revision,JSON.stringify(snapshot));
    syncSessionRecords(s);
    return readSession(s.id);
  }
  function recordDevice(deviceId, user) {
    const id = deviceId || 'default';
    const at = time();
    db.prepare(`INSERT INTO devices (device_id,first_seen_at,last_contact_at,last_role,last_actor) VALUES (?,?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET last_contact_at=excluded.last_contact_at,last_role=excluded.last_role,last_actor=excluded.last_actor`)
      .run(id,at,at,user?.role ?? null,user?.name ?? null);
  }
  const devices = () => db.prepare('SELECT device_id,last_contact_at,last_role,last_actor FROM devices ORDER BY last_contact_at ASC').all()
    .map(row => ({...(row.device_id !== 'default' ? {deviceId:row.device_id} : {}), lastContact:row.last_contact_at, lastRole:row.last_role, lastActor:row.last_actor}));
  function stock(epc) { return db.prepare('SELECT * FROM cartons WHERE epc=?').get(epc); }
  function expectedCartons(manifest) {
    return (manifest?.pallets ?? []).reduce((total,pallet) => total + palletCartonCount(pallet),0);
  }
  const requiredRows = manifest => (manifest?.pallets ?? []).flatMap(pallet => pallet.requirements ?? []);
  const verifiedCartons = s => {
    if (s.manifest?.matchBy !== 'sku') return cartonsOf(s.manifest);
    const runIds = new Set(Object.values(s.palletMatches ?? {}));
    return s.runs.filter(run => runIds.has(run.id) || (!s.palletMatches && s.confirmedAt && run === s.runs.at(-1)))
      .flatMap(run => run.result?.matchedCartons ?? []);
  };
  function skuCapacity(currentId,ignoreDrafts = []) {
    const available = new Map(products.map(product => [product.sku,0]));
    const otherSessions = activeSessions().filter(s => s.id !== currentId && !s.dispatchedAt);
    const otherDrafts = manifests().filter(draft => !ignoreDrafts.includes(draft.id) && draft.status === 'Manifest ready');
    const committed = [...otherSessions.map(s => s.manifest),...otherDrafts];
    const fixed = new Set(committed.flatMap(cartonsOf).map(carton => carton.epc));
    const counted = new Map();
    for (const session of otherSessions) {
      const matched = verifiedCartons(session);
      if (session.manifest?.matchBy !== 'sku') continue;
      const used = new Map();
      for (const carton of matched) {
        fixed.add(carton.epc);
        const row = stock(carton.epc);
        if (!row?.physical || row.state !== 'available') continue;
        const sku = cartonSku(row);
        used.set(sku,(used.get(sku) ?? 0) + 1);
      }
      counted.set(session.manifest,used);
    }
    for (const carton of stockOps.inventory()) {
      if (!carton.physical || carton.state !== 'available' || fixed.has(carton.epc)) continue;
      for (const sku of new Set([carton.sku,cartonSku(carton)])) available.set(sku,(available.get(sku) ?? 0) + 1);
    }
    for (const manifest of committed) {
      const used = counted.get(manifest);
      for (const {sku:storedSku,quantity} of requiredRows(manifest).sort((a,b) => (a.sku === productFamily(a.sku)) - (b.sku === productFamily(b.sku)))) {
        const sku = skuProduct(storedSku);
        let outstanding = quantity;
        for (const [key,count] of used ?? []) {
          if (key !== sku && productFamily(key) !== sku) continue;
          const covered = Math.min(outstanding,count);
          used.set(key,count - covered);
          outstanding -= covered;
        }
        for (const key of new Set([sku,productFamily(sku)])) available.set(key,(available.get(key) ?? 0) - outstanding);
      }
    }
    for (const [sku,count] of available) {
      if (productFamily(sku) !== sku) available.set(sku,Math.min(count,available.get(productFamily(sku))));
    }
    return available;
  }
  function checkStock(manifest,currentId,ignoreDrafts = []) {
    if (manifest.matchBy === 'sku') {
      const availability = skuCapacity(currentId,ignoreDrafts);
      for (const {sku:storedSku,quantity} of requiredRows(manifest)) {
        const sku = skuProduct(storedSku);
        const family = productFamily(sku);
        const available = Math.max(0,Math.min(availability.get(sku) ?? 0,availability.get(family) ?? 0));
        if (!eligible.has(family) || quantity > available) fail('Only ' + available + ' cartons of ' + sku + ' are available.');
        for (const key of new Set([sku,family])) availability.set(key,availability.get(key) - quantity);
      }
      return;
    }
    const removedPallet = db.prepare('SELECT 1 FROM pallet_inventory WHERE epc=? AND removed=1');
    if (manifest.pallets.some(pallet => removedPallet.get(pallet.palletEpc))) {
      fail('This manifest includes a pallet removed from inventory.');
    }
    const inventory = [];
    for (const c of cartonsOf(manifest)) {
      const carton = stock(c.epc);
      if (!eligible.has(c.sku) || carton?.sku !== c.sku) fail('EPC ' + c.epc + ' has no matching stock SKU.');
      if (carton.state === 'removed') fail('EPC ' + c.epc + ' was removed from stock.');
      if (carton.state === 'expected') fail('EPC ' + c.epc + ' has not been received.');
      inventory.push(carton);
    }
    const conflict = outboundManifestConflict(manifest,inventory,activeSessions(),currentId);
    if (conflict) fail(conflict);
    const expected = new Set(cartonsOf(manifest).map(c => c.epc));
    const draft = manifests().find(item => !ignoreDrafts.includes(item.id) &&
      ['Pallet scanned','Manifest ready'].includes(item.status) &&
      draftPallets(item).some(pallet => pallet.cartons.some(carton => expected.has(carton.epc))));
    if (draft) fail('This manifest contains cartons assigned to draft manifest ' + draft.reference + '. Remove that manifest or choose different cartons.');
    const skuSession = activeSessions().find(s => s.id !== currentId && s.manifest?.matchBy === 'sku' && !s.dispatchedAt &&
      verifiedCartons(s).some(carton => expected.has(carton.epc)));
    if (skuSession) fail('This manifest contains cartons assigned to ' + skuSession.testId + '.');
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
    const fromSessions = activeSessions().flatMap(verifiedCartons);
    return new Set([...fromDrafts,...fromSessions].map(carton => carton.epc));
  }
  function existingPallets() {
    const sessions = activeSessions();
    const sessionPallets = new Set(sessions.flatMap(session => session.manifest?.pallets ?? []).map(pallet => pallet.palletEpc));
    const sessionCartons = new Set(sessions.flatMap(session => cartonsOf(session.manifest)).map(carton => carton.epc));
    return manifests().filter(draft => draft.status === 'Manifest ready' && draft.matchBy !== 'sku').flatMap(draft => draftPallets(draft)
      .filter(pallet => !sessionPallets.has(pallet.palletEpc) &&
        pallet.cartons.every(carton => stock(carton.epc)?.state === 'available' && !sessionCartons.has(carton.epc)))
      .map(pallet => ({draftId:draft.id,...pallet})));
  }
  function readyManifest(draft,pallets,ignoreDrafts = [draft.id]) {
    if (pallets.reduce((total,pallet) => total + 1 + palletCartonCount(pallet),0) > 500) fail('A manifest can use up to 500 labels.',400);
    const csv = draft.matchBy === 'sku' ? skuManifestCsv(pallets) : palletCsv(pallets);
    checkStock(parseManifest(csv),undefined,ignoreDrafts);
    return {...draft,pallets,csv,status:'Manifest ready',generatedAt:time()};
  }
  function palletAvailable(epc,id) {
    if (stock(epc) || manifests().some(draft => draft.id !== id && draft.status !== 'Cancelled' && (draft.palletEpc === epc || draftPallets(draft).some(p => p.palletEpc === epc))) ||
        activeSessions().some(session => [session.manifest,...(session.manifestRevisions ?? [])].some(manifest =>
          manifest?.pallets?.some(pallet => pallet.palletEpc === epc) || cartonsOf(manifest).some(carton => carton.epc === epc)))) {
      fail('This EPC is already registered. Scan an unused pallet tag.');
    }
  }
  if (!db.prepare('PRAGMA table_info(pallet_inventory)').all().some(column => column.name === 'shape')) {
    db.exec("ALTER TABLE pallet_inventory ADD COLUMN shape TEXT NOT NULL DEFAULT 'Unspecified'");
  }
  if (!db.prepare('PRAGMA table_info(pallet_inventory)').all().some(column => column.name === 'removed')) {
    db.exec('ALTER TABLE pallet_inventory ADD COLUMN removed INTEGER NOT NULL DEFAULT 0');
  }
  function catalogPallet(pallet) {
    const {shape,removed,...record} = pallet;
    const identifier = /^PAL-[A-Z0-9]+-[A-Z0-9]+$/.test(pallet.sku) ? pallet.sku : palletIdentifier(pallet);
    return {...record,identifier};
  }
  function palletClaims() {
    const used = new Map();
    for (const draft of manifests().filter(row => row.status === 'Manifest ready')) {
      for (const pallet of draftPallets(draft)) !pallet.palletType && used.set(pallet.palletEpc,{id:draft.id,reference:draft.reference,status:'In manifest'});
    }
    for (const session of sessions().filter(row => row.dispatchedAt || !row.removedAt)) {
      for (const pallet of session.manifest?.pallets ?? []) {
        const actual = session.palletAttempts?.findLast(attempt => attempt.manifestRevision === session.manifest.revision &&
          attempt.palletEpc === pallet.palletEpc && attempt.result === 'Identified')?.actualPalletEpc;
        const epc = pallet.palletType ? actual : pallet.palletEpc;
        if (epc && used.get(epc)?.status !== 'Dispatched') {
          used.set(epc,{id:session.id,reference:session.testId,status:session.dispatchedAt ? 'Dispatched' : 'In session'});
        }
      }
    }
    return Object.fromEntries(used);
  }
  function palletCatalog() {
    const claims = palletClaims();
    return db.prepare('SELECT * FROM pallet_inventory WHERE removed=0 ORDER BY reference').all()
      .map(pallet => ({...catalogPallet(pallet),status:claims[pallet.epc]?.status ?? 'On hand'}));
  }
  function importPallets(text) {
    if (typeof text !== 'string') fail('Choose a pallet inventory CSV.',400);
    const columns = ['pallet_ref','pallet_epc','sku','size','material'];
    const header = text.split(/\r?\n/,1)[0].split(/[,;]/).map(cell => cell.trim().toLowerCase().replace(/^\uFEFF/,''));
    const legacy = header.includes('sku');
    const rows = parseCsvRows(text,legacy ? (header.includes('shape') ? [...columns,'shape'] : columns) :
      ['pallet_ref','pallet_epc','material','size']);
    const {palletMaterials,palletSizes} = inventoryOptions();
    if (rows.length > 500) fail('Import up to 500 pallets at a time.',400);
    const insert = db.prepare('INSERT INTO pallet_inventory (epc,reference,sku,size,material) VALUES (?,?,?,?,?)');
    const duplicate = db.prepare('SELECT 1 FROM pallet_inventory WHERE epc=? OR reference=?');
    for (const [reference,tag,code,size,oldMaterial] of rows) {
      const epc = normalizeEpc(tag);
      const material = legacy ? oldMaterial : code;
      if (!validEpc(epc) || ![reference,size,material].every(value => value && value.length <= 80 && !/^[=+@-]/.test(value))) {
        fail('Each pallet needs a valid reference, EPC, material and size.',400);
      }
      if (duplicate.get(epc,reference) || stock(epc)) fail('Pallet reference or EPC already exists: ' + reference + '.');
      palletAvailable(epc);
      const materialOption = palletMaterials.find(option => !option.archived && (option.code === material.toUpperCase() ||
        option.label.toUpperCase() === material.toUpperCase()));
      const sizeOption = palletSizes.find(option => !option.archived && (option.code === size.toUpperCase() || option.label.toUpperCase() === size.toUpperCase()));
      if (!legacy && (!materialOption || !sizeOption)) fail('Use a configured pallet material and size.',400);
      const identifier = materialOption && sizeOption ? 'PAL-' + materialOption.code + '-' + sizeOption.code : palletIdentifier({material,size});
      insert.run(epc,reference,identifier,sizeOption?.label ?? size,materialOption?.label ?? material);
    }
    return {imported:rows.length,reference:rows.length + ' pallets'};
  }
  function palletManifest(user,input,deviceId,devices) {
    if (input.action === 'remove-pallet') {
      if (deviceId || user.role !== 'admin') fail('Administrator access required.',403);
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (!reason || reason.length > 240) fail('Enter a removal reason of up to 240 characters.',400);
      const catalog = palletCatalog();
      const pallet = catalog.find(row => row.epc === normalizeEpc(input.epc));
      if (!pallet || pallet.status !== 'On hand') fail('Only an on-hand pallet can be removed.');
      const typedSlots = [
        ...manifests().filter(draft => draft.status === 'Manifest ready').flatMap(draftPallets),
        ...activeSessions().filter(session => !session.closedAt && !session.dispatchedAt).flatMap(session =>
          (session.manifest?.pallets ?? []).filter(slot => !palletRead(session,slot)))
      ].filter(slot => slot.palletType);
      if (typedSlots.some(slot => matchesPalletIdentifier(slot.palletType,pallet.identifier) &&
          catalog.filter(row => row.status === 'On hand' && matchesPalletIdentifier(slot.palletType,row.identifier)).length <=
          typedSlots.filter(other => other.palletType === slot.palletType).length)) {
        fail('This pallet type is needed for an open manifest or session.');
      }
      db.prepare('UPDATE pallet_inventory SET removed=1 WHERE epc=?').run(pallet.epc);
      stockOps.recordPalletRemoval(user,pallet,reason);
      return {reference:pallet.reference};
    }
    if (input.action === 'register-pallet') {
      if (!deviceId || user.role !== 'operator') fail('Operator access on the handheld is required.',403);
      const epc = normalizeEpc(input.epc);
      const {palletMaterials,palletSizes} = inventoryOptions();
      const material = palletMaterials.find(option => !option.archived && option.code === input.material);
      const size = palletSizes.find(option => !option.archived && option.code === input.size);
      if (!validEpc(epc) || !material || !size) fail('Choose a configured material and size, and scan a valid EPC.',400);
      const conflict = tagConflict(epc,null,verificationClaims(),palletClaims());
      if (conflict) fail(conflict);
      const identifier = 'PAL-' + material.code + '-' + size.code;
      const existing = db.prepare('SELECT * FROM pallet_inventory WHERE epc=?').get(epc);
      if (existing?.removed) fail('This pallet was removed from inventory.');
      if (existing && catalogPallet(existing).identifier === identifier) return palletCatalog().find(row => row.epc === epc);
      if (existing) fail('This pallet EPC is already registered.');
      palletAvailable(epc);
      const reference = 'PAL-' + epc.slice(-6);
      if (db.prepare('SELECT 1 FROM pallet_inventory WHERE reference=?').get(reference)) {
        fail('Another pallet already uses reference ' + reference + '.');
      }
      db.prepare('INSERT INTO pallet_inventory (epc,reference,sku,size,material) VALUES (?,?,?,?,?)')
        .run(epc,reference,identifier,size.label,material.label);
      return catalogPallet({epc,reference,sku:identifier,size:size.label,material:material.label});
    }
    if (['import-pallets','sku-pallet'].includes(input.action)) {
      if (deviceId || user.role !== 'admin') fail('Administrator access required.',403);
      if (input.action === 'import-pallets') return importPallets(input.csv);
      const draft = input.id ? manifests().find(row => row.id === input.id && row.status === 'Manifest ready' && row.matchBy === 'sku') : null;
      if (input.id && !draft) fail('Open a ready SKU manifest before adding a pallet.');
      const slots = new Set(draft && draftPallets(draft).map(pallet => pallet.palletEpc));
      const pallet = palletCatalog().find(row => row.status === 'On hand' && !slots.has(row.epc) &&
        (input.palletType ? row.identifier === input.palletType : row.epc === normalizeEpc(input.palletEpc)));
      if (!pallet) fail('Select a pallet currently on hand.');
      if (!Array.isArray(input.requirements) || !input.requirements.length) fail('Enter at least one carton quantity.',400);
      const requirements = input.requirements.map(row => ({sku:skuProduct(row.sku),quantity:row.quantity}));
      if (requirements.some(row => !eligible.has(productFamily(row.sku)) || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 499) ||
          new Set(requirements.map(row => row.sku)).size !== requirements.length) fail('Enter one whole quantity per product SKU.',400);
      const next = {pallet:pallet.reference,palletEpc:pallet.epc,cartons:[],requirements,...(input.palletType ? {palletType:pallet.identifier} : {})};
      const base = draft ?? {id:randomUUID(),reference:pallet.reference,matchBy:'sku',createdAt:time(),by:user.name};
      return savePalletManifest(readyManifest(base,[...draftPallets(base),next]));
    }
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
      const combined = readyManifest(draft,[...pallets,{pallet,palletEpc,cartons}],[draft.id,source.id]);
      const remaining = draftPallets(source).filter(entry => entry.palletEpc !== palletEpc);
      const last = remaining.at(-1);
      if (last) {
        const nextRef = remaining.some(entry => entry.pallet.toUpperCase() === source.reference.toUpperCase()) ? source.reference : remaining[0].pallet;
        savePalletManifest(readyManifest({...source,reference:nextRef,scanReference:undefined,palletEpc:last.palletEpc},remaining,[draft.id,source.id]));
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
      const session = create(user,{testId:input.testId,location:input.location,source:'C72 hardware',csv:draft.csv},[draft.id]);
      return savePalletManifest({...draft,sessionId:session.id,sessionRemovedAt:undefined,status:'Session created'});
    }
    fail('This action is unavailable for the pallet manifest.');
  }
  function hasVerifiedMatch(s) {
    if (s.manifest?.pallets?.length > 1) return !s.dispatchedAt && s.verifiedBy && s.confirmedAt && !pendingPallet(s);
    const run = s.runs.at(-1);
    return !s.dispatchedAt && s.verifiedBy && s.confirmedAt && s.identified && run?.state === 'Finished' &&
      run.manifestRevision === s.manifest?.revision && run.result?.status === 'Match' && expectedCartons(s.manifest) > 0;
  }
  function approveDispatch(s,user) {
    s.acceptedAt = time();
    s.dispatchApproval = {at:s.acceptedAt,by:user.name,role:user.role};
    audit(s,user,'Dispatch approved',user.name);
  }
  function dispatch(s,user) {
    if (!hasVerifiedMatch(s) || (s.manifest.matchBy === 'sku' && verifiedCartons(s).length !== expectedCartons(s.manifest))) {
      fail(s.testId + ' needs a verified pallet and a clean result.');
    }
    if (!s.dispatchApproval) {
      if (user.role !== 'admin') fail(s.testId + ' needs dispatch approval from the Administrator or Reviewer.');
      approveDispatch(s,user);
    }
    const cartons = verifiedCartons(s);
    stockOps.stageOutbound(user,s,cartons.map(carton => carton.epc));
    const deduct = db.prepare("UPDATE cartons SET state='dispatched', reservation=NULL WHERE epc=? AND state='available'");
    for (const carton of cartons) {
      const before = stock(carton.epc);
      if (deduct.run(carton.epc).changes !== 1) fail('Carton ' + carton.epc + ' is no longer on hand for ' + s.testId + '.');
      stockOps.dispatch(user,s,before,stock(carton.epc));
    }
    s.dispatchedAt = time();
    audit(s,user,'Dispatch confirmed',verifiedCartons(s).length + ' cartons');
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
    s.allocation = {cartons:expectedCartons(manifest),pallets:manifest.pallets.length};
  }
  function create(user, input, ignoreDrafts = []) {
    if (user.role !== 'admin') fail('Administrator access required.',403);
    const testId = String(input.testId ?? '').trim();
    const location = stockOps.chooseLocation({location:String(input.location ?? '').trim()});
    if (!testId || testId.length > 80) fail('Enter a valid session ID.',400);
    if (activeSessions().some(s => s.testId === testId)) fail('That session ID already exists.');
    if (!['C72 hardware','Simulation'].includes(input.source)) fail('Choose a valid reader source.',400);
    const csv = input.csv || (input.sample ? sample(input.source) : '');
    const manifest = csv ? parseManifest(csv) : null;
    let savedDraft;
    if (manifest?.matchBy === 'sku') {
      savedDraft = manifests().find(draft => draft.status === 'Manifest ready' &&
        draft.matchBy === 'sku' && skuManifestCsv(draftPallets(draft)) === skuManifestCsv(manifest.pallets));
      if (savedDraft) ignoreDrafts = [...new Set([...ignoreDrafts,savedDraft.id])];
      for (const pallet of manifest.pallets) {
        if (pallet.palletType) {
          const required = manifest.pallets.filter(row => row.palletType === pallet.palletType).length;
          if (palletCatalog().filter(row => matchesPalletIdentifier(pallet.palletType,row.identifier) && row.status === 'On hand').length < required) {
            fail('Too few pallets on hand for ' + pallet.palletType + '.');
          }
          continue;
        }
        const registered = palletCatalog().find(row => row.epc === pallet.palletEpc);
        if (!registered || (registered.status !== 'On hand' && !(savedDraft && registered.status === 'In manifest'))) {
          fail('Pallet ' + pallet.pallet + ' is unavailable in pallet inventory.');
        }
      }
    }
    if (manifest) {
      checkStock(manifest,undefined,ignoreDrafts);
      const owners = palletClaims();
      for (const pallet of manifest.pallets) {
        if (pallet.palletType) continue;
        const owner = owners[pallet.palletEpc];
        if (owner?.status === 'Dispatched') fail('Pallet already dispatched.');
        if (owner && !ignoreDrafts.includes(owner.id)) fail('Pallet assigned to ' + owner.reference + '.');
      }
    }
    const s = {
      id:input.id ?? randomUUID(), testId, location, level:'Ground', product:'Mixed cartons', palletType:'Mixed',
      label:'UHF', placement:'Long side', wrapping:'Unwrapped', shielding:'Not tested', method:'Walk around the pallet',
      planned:'Outbound pallet check', source:input.source, mode:'POC', creator:user.name, createdAt:time(),
      runs:[], logs:[], allocation:{}
    };
    if (manifest) {
      s.manifest = {...manifest,revision:1,source:input.sample ? 'Sample CSV' : 'Dashboard CSV',demo:!!input.sample,importedAt:time()};
      s.allocation = {cartons:expectedCartons(manifest),pallets:manifest.pallets.length};
    }
    audit(s,user,'Session created');
    const saved = write(s,1);
    if (savedDraft) savePalletManifest({...savedDraft,sessionId:saved.id,sessionRemovedAt:undefined,status:'Session created'});
    return saved;
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
      const linked = manifests().find(draft => draft.sessionId === s.id && draft.status === 'Session created');
      if (linked) {
        savePalletManifest(s.dispatchedAt ? {...linked,sessionRemovedAt:time()} : {...linked,sessionId:undefined,status:'Manifest ready'});
      }
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
      if (!hasVerifiedMatch(s)) fail('A clean result and verification are required.');
      if (s.dispatchApproval) return s;
      approveDispatch(s,user);
    } else if (input.action === 'dispatch' && input.confirmed === true) {
      return dispatch(s,user);
    } else fail('Action is unavailable for this role or session state.',403);
    return write(s,s.workspaceRevision + 1);
  }
  function verificationClaims() {
    return Object.fromEntries([
      ...manifests().filter(draft => draft.status === 'Manifest ready').flatMap(draft => cartonsOf(draft).map(carton => [carton.epc,draft.id])),
      ...activeSessions().filter(session => !session.dispatchedAt).flatMap(session => verifiedCartons(session).map(carton => [carton.epc,session.id]))
    ]);
  }
  function tagConflict(epc,sessionId,cartonClaims,palletOwners) {
    const pallet = palletOwners[epc], owner = cartonClaims[epc];
    if (pallet?.status === 'Dispatched' || stock(epc)?.state === 'dispatched') return 'Tag already dispatched.';
    if (pallet && pallet.id !== sessionId) return 'Pallet assigned to ' + (pallet.reference || 'another session') + '.';
    if (owner && owner !== sessionId) return 'Carton assigned to another session or manifest.';
    return '';
  }
  const palletRead = (s,pallet) => s.palletAttempts?.findLast(attempt =>
    attempt.manifestRevision === s.manifest.revision && attempt.palletEpc === pallet.palletEpc &&
    Object.hasOwn(attempt.observations ?? {},pallet.palletType ? attempt.actualPalletEpc : pallet.palletEpc));
  const hasPalletRead = (s,pallet) => Boolean(palletRead(s,pallet));
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
      s = create(user,{...incoming,location:incoming.location === 'Demo staging area' ? OUTBOUND_STAGING : incoming.location});
    } else if (s.removedAt || s.workspaceRevision !== change.revision || s.closedAt ||
        ((s.dispatchedAt || s.acceptedAt) && !incoming.closedAt)) {
      fail('Server session changed. Local evidence is still on the handheld.');
    }
    const wasConfirmed = Boolean(s.confirmedAt);
    let scanConflict;
    // Once approved, a closure may be recorded without touching the accepted evidence.
    const evidenceEditable = !s.dispatchedAt && !s.acceptedAt;
    if (evidenceEditable && user.role === 'admin') {
      if (incoming.manifest?.revision !== s.manifest?.revision && incoming.manifest && !s.confirmedAt) {
        const verified = validateManifest(incoming.manifest);
        checkStock(verified,s.id);
        if (s.manifest) (s.manifestRevisions ??= []).push(s.manifest);
        s.manifest = {...verified,revision:(s.manifest?.revision ?? 0) + 1,source:incoming.manifest.source,importedAt:time()};
        s.allocation = {cartons:expectedCartons(verified),pallets:verified.pallets.length};
        s.verifiedAt = s.verifiedBy = null;
        s.identified = false;
        delete s.palletMatches;
        audit(s,user,'Manifest saved');
      }
    } else if (evidenceEditable && user.role === 'supervisor') {
      if (incoming.verifiedAt && !s.verifiedAt && s.manifest && incoming.manifest?.revision === s.manifest.revision) {
        s.verifiedBy = user.name;
        s.verifiedAt = time();
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
          fail('The server requires verification before scanning.');
        }
        return s;
      }
      const multi = s.manifest.pallets.length > 1;
      const cartonOwners = verificationClaims(), palletOwners = palletClaims();
      const conflict = epc => tagConflict(epc,s.id,cartonOwners,palletOwners);
      const found = incoming.manifest?.palletEpc;
      const rejected = extraAttempts.find(attempt => {
        const epc = attempt.actualPalletEpc ?? attempt.palletEpc ?? (!multi && incoming.identified ? found : null);
        return epc && conflict(epc) && (attempt.result === 'Identified' || incoming.identified);
      });
      if (rejected) {
        scanConflict = conflict(rejected.actualPalletEpc ?? rejected.palletEpc ?? found);
        s.identified = false;
        (s.palletAttempts ??= []).push(...extraAttempts.map(attempt => ({
          ...attempt, result:'Unconfirmed', palletEpc:undefined, actualPalletEpc:undefined, actor:user.name
        })));
        for (const run of newRuns) {
          const epcs = Object.keys(run.observations ?? {}).map(normalizeEpc);
          const target = s.manifest.pallets.find(pallet => pallet.palletEpc === run.palletEpc);
          const manifest = target ? lockTo(s.manifest,target) : s.manifest;
          s.runs.push({...run,observations:run.observations ?? {},operator:user.name,state:'Interrupted',error:scanConflict,
            result:compareOutbound(manifest,epcs,[],new Set(epcs))});
        }
        audit(s,user,'Pallet scan blocked',scanConflict);
        db.prepare('INSERT INTO operations VALUES (?,?,?)').run(change.operationId,user.id,s.id);
        return {...write(s,s.workspaceRevision + 1),scanConflict};
      }
      if (!multi && !s.identified && incoming.identified && found) {
        const locked = s.manifest.pallets.find(p => p.palletEpc === found);
        const observation = incoming.palletAttempts?.at(-1)?.observations ?? {};
        if (locked && (locked.palletType ? extraAttempts.some(attempt => attempt.palletEpc === found && attempt.actualPalletEpc) :
            (!conflict(locked.palletEpc) && [locked.palletEpc,...locked.cartons.map(c => c.epc)]
              .some(epc => Object.hasOwn(observation,epc) && !conflict(epc))))) {
          s.manifest = {...s.manifest,...locked};
          s.identified = true;
        }
      }
      for (const attempt of extraAttempts) {
        const target = s.manifest.pallets.find(p => p.palletEpc === attempt.palletEpc);
        if (target?.palletType) {
          const actual = normalizeEpc(attempt.actualPalletEpc);
          const registered = palletCatalog().find(row => row.epc === actual);
          const blocked = conflict(actual);
          if (blocked) fail(blocked);
          const sameSlot = palletRead(s,target)?.actualPalletEpc === actual;
          const alreadyUsed = s.manifest.pallets.some(p => p !== target && palletRead(s,p)?.actualPalletEpc === actual);
          if (attempt.manifestRevision !== s.manifest.revision || attempt.result !== 'Identified' ||
              !Object.hasOwn(attempt.observations ?? {},actual) || !registered || !matchesPalletIdentifier(target.palletType,registered.identifier) ||
              (registered.status !== 'On hand' && !sameSlot) || alreadyUsed) fail('Pallet EPC is unavailable or does not match the required pallet type.');
        }
        (s.palletAttempts ??= []).push({...attempt,actor:user.name});
      }
      const skuConfirmedIds = new Set([...Object.values(s.palletMatches ?? {}),...Object.values(incoming.palletMatches ?? {})]);
      const skuTaken = new Map();
      const rememberSkuMatch = run => {
        if (s.manifest.matchBy === 'sku' && skuConfirmedIds.has(run.id) && run.state === 'Finished' && run.result?.status === 'Match') {
          for (const epc of run.result.matched) skuTaken.set(epc,run.palletEpc);
        }
      };
      s.runs.filter(run => run.manifestRevision === s.manifest.revision).forEach(rememberSkuMatch);
      for (const incomingRun of newRuns) {
        if (runIds.has(incomingRun.id)) continue;
        runIds.add(incomingRun.id);
        const target = s.manifest.pallets.find(pallet => pallet.palletEpc === incomingRun.palletEpc);
        const identified = multi ? target && !s.palletMatches?.[target.palletEpc] && hasPalletRead(s,target) : s.identified;
        const planned = target ?? (!multi ? s.manifest : null);
        const actual = planned?.palletType ? palletRead(s,planned)?.actualPalletEpc : planned?.palletEpc;
        if (actual && conflict(actual)) fail(conflict(actual));
        if (!identified || incomingRun.manifestRevision !== s.manifest.revision ||
            !['Finished','Interrupted'].includes(incomingRun.state) || incomingRun.source !== s.source) fail('Run does not match the current verified manifest.');
        const observations = incomingRun.observations ?? {};
        const manifest = multi ? lockTo(s.manifest,target) : {...s.manifest};
        if (target?.palletType) manifest.actualPalletEpc = actual;
        const epcs = Object.keys(observations).map(normalizeEpc);
        const blocked = new Set(epcs.filter(epc => conflict(epc) ||
          (skuTaken.has(epc) && skuTaken.get(epc) !== incomingRun.palletEpc)));
        const result = compareOutbound(manifest,epcs,manifest.requirements ? stockOps.inventory() : [],blocked);
        if (blocked.size) scanConflict ??= [...blocked].map(conflict).find(Boolean) || 'Carton already used on another pallet in this session.';
        const knownExtras = result.extra.flatMap(epc => {
          const carton = stock(epc);
          return carton ? [[epc,demoSku(cartonSku(carton))]] : [];
        });
        if (knownExtras.length) result.extraSkus = Object.fromEntries(knownExtras);
        const run = {...incomingRun,operator:user.name,observations,result};
        s.runs.push(run);
        rememberSkuMatch(run);
        audit(s,user,'Carton scan recorded',incomingRun.state === 'Interrupted' ? 'Interrupted' : result.status);
      }
      if (multi) {
        const confirmed = new Set(Object.values(incoming.palletMatches ?? {}));
        for (let target = pendingPallet(s); target; target = pendingPallet(s)) {
          const run = s.runs.findLast(candidate => candidate.manifestRevision === s.manifest.revision && candidate.palletEpc === target.palletEpc);
          if (!run || !confirmed.has(run.id) || run.state !== 'Finished' || run.result.status !== 'Match') break;
          if (s.manifest.matchBy === 'sku') {
            const used = new Set(s.runs.filter(candidate => Object.values(s.palletMatches ?? {}).includes(candidate.id))
              .flatMap(candidate => candidate.result.matched));
            if (run.result.matched.some(epc => used.has(epc))) break;
          }
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
    if (!wasConfirmed && hasVerifiedMatch(s)) {
      stockOps.stageOutbound(user,s,verifiedCartons(s).map(carton => carton.epc));
    }
    if (incoming.closedAt && !(scanConflict && !hasVerifiedMatch(s))) {
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
    const saved = write(s,s.workspaceRevision + 1);
    return scanConflict ? {...saved,scanConflict} : saved;
  }
  return {
    close:() => db.close(),
    dashboardSessionValid:(id,now) => Boolean(db.prepare('SELECT 1 FROM dashboard_sessions WHERE id=? AND expires>?').get(id,now)),
    addDashboardSession:(id,now,expires) => {
      db.prepare('DELETE FROM dashboard_sessions WHERE expires<=?').run(now);
      db.prepare('INSERT INTO dashboard_sessions (id,expires) VALUES (?,?)').run(id,expires);
    },
    removeDashboardSession:id => db.prepare('DELETE FROM dashboard_sessions WHERE id=?').run(id),
    records:() => ({sessions:activeSessions()}),
    removedSessions:() => sessions().filter(session => session.removedAt).map(session => session.id),
    outbound:(user,records) => ({
      approvable:reviewRoles.includes(user.role) ? records.filter(s => !s.dispatchApproval && hasVerifiedMatch(s)).map(s => s.id) : [],
      dispatchable:dispatchRoles.includes(user.role) ? records.filter(s => (s.dispatchApproval || user.role === 'admin') && hasVerifiedMatch(s) &&
        verifiedCartons(s).every(carton => stock(carton.epc)?.state === 'available')).map(s => s.id) : []
    }),
    sample,
    settings,
    outboundLocations:stockOps.outboundLocations,
    palletCatalog,
    skuAvailability:() => Object.fromEntries(skuCapacity()),
    generation,
    recordDevice,
    devices,
    reset:(user,input) => atomic(() => reset(user,input)),
    inventory:stockOps.inventory,
    stockTasks:() => ({tasks:stockOps.tasks().map(stockOps.tagged),locations:stockOps.locations(),
      locationRecords:stockOps.locationRecords(),warehouseLocations:stockOps.warehouseLocations(),countLocations:stockOps.countLocations(),
      outboundLocations:stockOps.outboundLocations(),stagingLocation:OUTBOUND_STAGING,events:stockOps.events()}),
    palletManifests:manifests,
    assignedCartonEpcs:() => [...assignedCartonEpcs()],
    verificationClaims,
    palletClaims,
    existingPallets,
    palletManifest:(user,input,deviceId,devices) => atomic(() => {
      const result = palletManifest(user,input,deviceId,devices);
      recordAudit(user,'Manifest ' + input.action,result?.id ?? input.id,input.reference ?? result?.reference ?? '');
      return result;
    }),
    stockHistory:stockOps.events,
    stockReport:stockOps.report,
    stockCommand:(user,input,dashboard) => atomic(() => {
      if (input.action === 'receive-carton') {
        const epc = normalizeEpc(input.epc);
        const conflict = tagConflict(epc,null,verificationClaims(),palletClaims());
        if (conflict) fail(conflict);
        if (db.prepare('SELECT 1 FROM pallet_inventory WHERE epc=?').get(epc)) fail('This EPC is already registered to a pallet.');
      }
      const location = dashboard && user.role === 'admin' && ['archive-location','rename-location'].includes(input.action) ?
        stockOps.locationRecords().find(row => row.id === input.locationId && !row.archived && !row.protected) : null;
      const sessionsAtLocation = location ? activeSessions().filter(s => !s.closedAt && !s.dispatchedAt && s.location === location.name) : [];
      if (input.action === 'archive-location' && sessionsAtLocation.length) fail('Close the outbound sessions at this location before archiving.');
      if (input.action === 'receive-carton') {
        const sizes = inventoryOptions().cartonSizes.filter(option => !option.archived);
        const size = input.size || (sizes.find(option => option.code === 'M') ?? sizes[0]).code;
        if (!input.variantSku && !sizes.some(option => option.code === size)) fail('Choose a configured carton size.',400);
        input = {...input,size,cartonSizes:sizes};
      }
      const capacityBefore = input.action === 'remove-carton' ? skuCapacity() : null;
      const result = stockOps.command(user,input,create,dashboard,epc =>
        activeSessions().some(s => (!s.dispatchedAt || input.action === 'untag') &&
          [...verifiedCartons(s),...cartonsOf(s.manifest)].some(c => c.epc === epc)) ||
        manifests().some(d => !['Cancelled','Session created'].includes(d.status) && draftPallets(d).some(p => p.cartons.some(c => c.epc === epc))));
      if (capacityBefore && [...skuCapacity()].some(([sku,count]) => count < Math.min(0,capacityBefore.get(sku) ?? 0))) {
        fail('This SKU is needed for an open manifest or session.');
      }
      if (input.action === 'rename-location' && result.reference && result.reference !== location?.name) {
        for (const session of sessionsAtLocation) {
          session.location = result.reference;
          audit(session,user,'Location renamed',location.name + ' to ' + result.reference);
          write(session,session.workspaceRevision + 1);
        }
      }
      return result;
    }),
    create:(user,input) => atomic(() => {
      if (user.role !== 'admin') fail('Administrator access required.',403);
      return create(user,input);
    }),
    action:(user,input,dashboard) => atomic(() => action(user,input,dashboard)),
    dispatchSelected:(user,input) => atomic(() => dispatchSelected(user,input)),
    sync:(user,input) => atomic(() => syncOne(user,input)),
    setControls:(user,input) => atomic(() => setControls(user,input)),
  };
}
