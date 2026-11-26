const prefix = 'keypharm-connected-v1';
const offline = 'Can’t reach the dashboard.';
const read = (key,fallback) => {
  try { return JSON.parse(localStorage.getItem(prefix + key) ?? 'null') ?? fallback; }
  catch { return fallback; }
};
const write = (key,value) => localStorage.setItem(prefix + key,JSON.stringify(value));
const fingerprint = (s, legacy = false) => JSON.stringify([
  s.manifest, s.verifiedAt, s.palletAttempts, s.runs?.filter(run => run.state !== 'Reading'),
  ...(legacy ? [] : [s.palletMatches,s.identified]),s.confirmedAt,s.closedAt,s.closure,s.logs?.filter(log => !log.action.endsWith('capture started'))
]);

export function workspaceClient(bridge) {
  if (!bridge?.workspaceRequest) return null;
  const pending = new Map();
  const client = {auth:read('-auth',null), samples:read('-samples',{}), stock:read('-stock',[]), state:'Unsynced'};
  client.stockTasks = [];
  client.palletTasks = [];
  client.removedSessions = new Set(read('-removed-sessions',[]));
  const demoRoles = {admin:'Administrator',operator:'Operator',supervisor:'Supervisor',reviewer:'Reviewer'};
  if (client.auth?.user.canSwitch && Object.hasOwn(demoRoles,client.auth.user.role)) {
    client.auth.user.name = demoRoles[client.auth.user.role];
  }
  let selectedRole = client.auth?.user.role ?? read('-role','operator');
  client.controls = read('-controls',{revision:0,plan:[],power:null});
  let base = read('-base',{});
  let queue = read('-queue',{});
  let controlsChange = read('-controls-change',null);
  let generation = read('-generation',0);
  let busy = false, refreshing;
  function adoptGeneration(next,clearRecords) {
    if (next === generation) return;
    clearRecords();
    base = {};
    queue = {};
    controlsChange = null;
    client.stock = [];
    client.stockTasks = [];
    client.removedSessions.clear();
    write('-removed-sessions',[]);
    client.controls = {revision:0,plan:[],power:null};
    write('-base',base);
    write('-queue',queue);
    write('-controls-change',controlsChange);
    write('-stock',client.stock);
    write('-controls',client.controls);
    write('-generation',next);
    generation = next;
  }
  const authorizationForRole = () => 'Bearer ' + client.auth?.token + (client.auth?.user.canSwitch ? '.' + client.auth.user.role : '');
  const actorKey = () => client.auth.user.id + '/' + client.auth.user.role;
  const request = (path,body,authorization = authorizationForRole()) => new Promise((resolve,reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(offline),{status:0}));
    },9000);
    pending.set(id,{resolve,reject,timer});
    bridge.workspaceRequest(id,path,authorization,body === undefined ? null : JSON.stringify(body));
  });
  client.receive = event => {
    const call = pending.get(event.id);
    if (!call) return;
    pending.delete(event.id);
    clearTimeout(call.timer);
    try {
      const data = JSON.parse(event.body);
      if (event.status < 200 || event.status >= 300) {
        const message = event.status === 0 || event.status >= 500 ? offline : data.message || 'Couldn’t complete the request.';
        call.reject(Object.assign(new Error(message),{status:event.status}));
      } else call.resolve(data);
    } catch (error) { call.reject(error); }
  };
  const hasLocalChanges = s => fingerprint(s) !== base[s.id] &&
    (s.palletMatches || fingerprint(s,true) !== base[s.id]);
  const changes = list => list.filter(s => !client.removedSessions.has(s.id) && (hasLocalChanges(s) || queue[s.id]));
  client.hasPending = list => changes(list).length > 0 || Boolean(controlsChange);
  client.stockPower = () => controlsChange?.stockPower ?? client.controls.stockPower ?? 10;
  client.sessionPowerOverride = id => {
    const pending = controlsChange?.sessionPowers;
    return pending && Object.hasOwn(pending,id) ? pending[id] : client.controls.sessionPowers?.[id];
  };
  client.updateControls = patch => {
    if (client.auth?.user.role !== 'admin') return;
    const priorPowers = controlsChange?.sessionPowers;
    controlsChange = {...controlsChange,...patch,revision:client.controls.revision,operationId:crypto.randomUUID()};
    if (patch.sessionPowers) controlsChange.sessionPowers = {...priorPowers,...patch.sessionPowers};
    write('-controls-change',controlsChange);
  };
  client.signIn = async (username,password) => {
    const result = await request('login',{},'Basic ' + btoa(username.trim() + ':' + password));
    if (result.user.canSwitch && Object.hasOwn(demoRoles,selectedRole)) {
      result.user = {...result.user,role:selectedRole,name:demoRoles[selectedRole]};
    }
    write('-auth',result);
    client.auth = result;
    return result.user;
  };
  client.signOut = list => {
    if (busy || client.hasPending(list)) throw new Error('Sync local changes before switching accounts.');
    write('-auth',null);
    client.auth = null;
    client.state = 'Unsynced';
  };
  client.switchTo = (role,list) => {
    if (!client.auth?.user.canSwitch || !Object.hasOwn(demoRoles,role) || role === client.auth.user.role) return client.auth?.user;
    if (busy || client.hasPending(list)) throw new Error('Sync local changes before switching accounts.');
    const user = {...client.auth.user,role,name:demoRoles[role]};
    selectedRole = role;
    write('-role',role);
    client.auth = {...client.auth,user};
    write('-auth',client.auth);
    client.state = 'Unsynced';
    client.message = '';
    return user;
  };
  client.reset = async (confirm,clearRecords) => {
    if (busy) throw new Error('Wait for the current sync to finish before resetting.');
    busy = true;
    try {
      const result = await request('reset',{generation,confirm});
      adoptGeneration(result.generation,clearRecords);
      client.state = 'Unsynced';
    } finally { busy = false; }
  };
  client.submitPalletScan = async (task,epc) => {
    if (refreshing) await refreshing;
    const result = await request('pallet-manifest',{action:'scan',id:task.id,scanReference:task.scanReference,epc,generation});
    client.palletTasks = client.palletTasks.filter(item => item.id !== task.id);
    return result;
  };
  client.stockAction = async (task,change) => {
    if (refreshing) await refreshing;
    if (busy) throw new Error('Wait for sync to finish before scanning.');
    busy = true;
    try {
      const result = await request('stock-action',{id:task.id,revision:task.revision,generation,operationId:crypto.randomUUID(),...change});
      client.stockTasks = client.stockTasks.map(item => item.id === result.id ? result : item);
      return result;
    } finally { busy = false; }
  };
  client.refresh = async (list,apply,safe,notify,clearRecords) => {
    if (!client.auth || busy || !safe()) return;
    busy = true;
    let finishRefresh;
    refreshing = new Promise(resolve => { finishRefresh = resolve; });
    client.state = 'Syncing';
    client.message = '';
    try {
      notify();
      let workspace = await request('workspace');
      if (!safe()) return;
      adoptGeneration(workspace.generation,clearRecords);
      client.removedSessions = new Set(workspace.removedSessions ?? []);
      write('-removed-sessions',[...client.removedSessions]);
      let uploaded = false;
      for (const current of changes(list())) {
        if (!safe()) return;
        if (client.auth.user.role === 'reviewer') break;
        const remote = workspace.sessions.find(s => s.id === current.id);
        const queued = queue[current.id];
        const cachedOnly = !hasLocalChanges(current) && (!queued || !hasLocalChanges(queued.session));
        const alreadySynced = remote && fingerprint(remote) === fingerprint(current) &&
          (!queued || fingerprint(queued.session) === fingerprint(remote));
        if (remote && (cachedOnly || alreadySynced)) {
          delete queue[current.id];
          base[current.id] = fingerprint(remote);
          write('-queue',queue);
          write('-base',base);
          if (current.workspaceRevision !== remote.workspaceRevision || fingerprint(current) !== fingerprint(remote)) apply(remote);
          continue;
        }
        const entry = queued ?? {
          operationId:crypto.randomUUID(),revision:current.workspaceRevision ?? 0,session:structuredClone(current),by:actorKey()
        };
        const formerDemoAccount = client.auth.user.id === 'testing' && entry.by === 'handheld/' + client.auth.user.role;
        if (entry.by !== actorKey() && !formerDemoAccount) {
          throw Object.assign(new Error('Switch to the role that recorded these changes to sync them.'),{status:409});
        }
        queue[current.id] = entry;
        write('-queue',queue);
        const server = await request('sync',{...entry,generation});
        uploaded = true;
        const newest = list().find(s => s.id === current.id);
        const unchanged = newest && fingerprint(newest) === fingerprint(entry.session);
        if (unchanged && safe()) apply(server);
        else if (newest) apply({...newest,workspaceRevision:server.workspaceRevision});
        base[server.id] = fingerprint(server);
        write('-base',base);
        delete queue[current.id];
        write('-queue',queue);
      }
      if (controlsChange && client.auth.user.role === 'admin') {
        const sent = controlsChange;
        const powerOnly = (sent.sessionPowers || sent.stockPower !== undefined) && sent.plan === undefined && sent.applied === undefined;
        const revision = powerOnly ? workspace.controls.revision : sent.revision;
        client.controls = await request('settings',{...sent,revision,generation});
        uploaded = true;
        if (controlsChange === sent) controlsChange = null;
        else controlsChange.revision = client.controls.revision;
        write('-controls-change',controlsChange);
      }
      if (uploaded) workspace = await request('workspace');
      if (!safe()) return;
      adoptGeneration(workspace.generation,clearRecords);
      client.controls = workspace.controls;
      write('-controls',client.controls);
      client.stock = workspace.inventory;
      write('-stock',client.stock);
      client.stockTasks = workspace.stockTasks ?? [];
      client.palletTasks = workspace.palletManifests ?? [];
      if (safe()) for (const server of workspace.sessions) {
        const local = list().find(s => s.id === server.id);
        if (local && (hasLocalChanges(local) || queue[local.id])) continue;
        if (!local || local.workspaceRevision !== server.workspaceRevision || fingerprint(local) !== fingerprint(server)) apply(server);
        base[server.id] = fingerprint(server);
      }
      write('-base',base);
      if (client.samples.Simulation === undefined || client.samples['C72 hardware'] === undefined) {
        const simulation = await request('sample');
        const physical = await request('physical-sample');
        client.samples = {Simulation:simulation.csv,'C72 hardware':physical.csv};
        write('-samples',client.samples);
      }
      client.state = client.hasPending(list()) ? 'Unsynced' : 'Synced';
      client.message = '';
    } catch (error) {
      if (error.status === 401) {
        write('-role',selectedRole);
        write('-auth',null);
        client.auth = null;
      }
      client.state = [401,403,409,422].includes(error.status) ? 'Needs review' : 'Unsynced';
      client.message = (error.status === 0 || error.status >= 500) && client.hasPending(list()) ?
        'Dashboard offline. Scans saved on this handheld will sync when it reconnects.' : error.message;
    } finally {
      if (client.state === 'Syncing') client.state = 'Unsynced';
      busy = false;
      refreshing = undefined;
      finishRefresh();
      notify();
    }
  };
  return client;
}
