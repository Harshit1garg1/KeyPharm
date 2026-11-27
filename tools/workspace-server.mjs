import {createServer} from 'node:http';
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspace} from './workspace-store.mjs';
import {roles as demoRoles,specEvidenceCsv} from '../app/src/main/assets/model.mjs';

const assets = fileURLToPath(new URL('../app/src/main/assets/', import.meta.url));
const storage = resolve(process.env.KEYPHARM_LOCAL_DATA || 'build/connected-poc');
await mkdir(storage,{recursive:true});
const credentialsPath = resolve(storage,'accounts.json');
const username = 'testing';
// Render sets RENDER=true. A hosted server is public, so it needs its own credentials from the environment.
const hosted = process.env.RENDER === 'true';
const password = process.env.KEYPHARM_PASSWORD || 'testing123';
const secret = process.env.KEYPHARM_SECRET;
if (hosted && (password === 'testing123' || password.length < 12)) {
  throw new Error('Set KEYPHARM_PASSWORD to at least 12 characters.');
}
if (hosted && !(secret?.length >= 32)) throw new Error('Set KEYPHARM_SECRET to at least 32 characters.');
let saved;
try { saved = JSON.parse(await readFile(credentialsPath,'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const account = {password,secret:secret || (saved?.[username]?.secret ?? randomBytes(32).toString('hex'))};
const accounts = {[username]:account};
if (!hosted && JSON.stringify(saved) !== JSON.stringify(accounts)) {
  const pending = credentialsPath + '.new';
  await writeFile(pending,JSON.stringify(accounts,null,2),{mode:0o600});
  await rename(pending,credentialsPath);
}
const token = username + '.' + createHmac('sha256',account.secret).update(password).digest('base64url');
const same = (a,b) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left,right);
};
const userForRole = role => Object.hasOwn(demoRoles,role) ? {id:username,role,name:demoRoles[role],canSwitch:true} : null;
const dashboardSessionSeconds = 12 * 60 * 60;
const dashboardCookie = 'keypharm_dashboard';
const setDashboardCookie = (res,value) => res.setHeader('Set-Cookie',dashboardCookie + '=' + value +
  '; Path=/; Max-Age=' + dashboardSessionSeconds + '; HttpOnly; SameSite=Strict' + (hosted ? '; Secure' : ''));
function startDashboardSession(res) {
  const now = Date.now();
  const id = randomBytes(24).toString('base64url');
  workspace.addDashboardSession(id,now,now + dashboardSessionSeconds * 1000);
  setDashboardCookie(res,id);
}
function authenticate(header = '',browserRole = 'operator') {
  const [scheme, input = ''] = header.split(' ');
  let role;
  if (scheme === 'Basic') {
    const decoded = Buffer.from(input,'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0 || decoded.slice(0,i) !== username || !same(password,decoded.slice(i + 1))) return null;
    role = browserRole;
  } else if (scheme === 'Bearer') {
    const [id,signature,requested,...extra] = input.split('.');
    if (extra.length || !same(token,id + '.' + signature)) return null;
    role = ['admin','supervisor'].includes(requested) ? requested : 'operator';
  } else return null;
  return userForRole(role);
}
const hardware = await readFile(resolve(assets,'private-live-sample.csv'),'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const workspace = createWorkspace(resolve(storage,'workspace.sqlite'),hardware);
const pages = new Map([
  ['/','dashboard.html'], ['/dashboard.css','dashboard.css'], ['/dashboard.mjs','dashboard.mjs'],
  ['/dashboard-theme.mjs','dashboard-theme.mjs'], ['/dashboard-model.mjs','dashboard-model.mjs'], ['/workspace-dashboard.mjs','workspace-dashboard.mjs'],
  ['/stock-dashboard.mjs','stock-dashboard.mjs'], ['/model.mjs','model.mjs'],
  ['/keypharm-favicon.svg','keypharm-favicon.svg'],
  ['/keypharm-logo-hd.png','keypharm-logo-hd.png'], ['/keypharm-logo.png','keypharm-logo.png'],
  ['/InterVariable.woff2','InterVariable.woff2']
]);
const mime = {html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',mjs:'text/javascript; charset=utf-8',png:'image/png',svg:'image/svg+xml',woff2:'font/woff2'};
const json = (res,status,body) => {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(body));
};
function dashboardSignIn(res,message = '') {
  res.writeHead(message ? 401 : 200,{'Content-Type':mime.html});
  res.end('<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Sign in | KeyPharm</title><link rel="stylesheet" href="/dashboard.css"><script type="module" src="/dashboard-theme.mjs"></script><main class="dashboard-sign-in">' +
    '<header><h1>Sign in</h1><div class="dashboard-toolbar-actions"><button type="button" id="dashboard-theme" aria-label="Dark mode" title="Dark mode" hidden></button></div></header>' + (message ? '<p role="alert">' + message + '</p>' : '') +
    '<form method="post" action="/dashboard/sign-in">' +
    '<label>Username<input name="username" autocomplete="username" required></label>' +
    '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>' +
    '<button class="primary-button">Sign in</button></form></main></html>');
}
async function payload(req,form = false) {
  const expected = form ? 'application/x-www-form-urlencoded' : 'application/json';
  if (req.headers['content-type']?.split(';')[0] !== expected) throw Object.assign(new Error('Unsupported request format.'),{status:415});
  let size = 0;
  const buffers = [];
  for await (const chunk of req) {
    if ((size += chunk.length) > 1_000_000) throw Object.assign(new Error('Request is too large.'),{status:413});
    buffers.push(chunk);
  }
  const text = Buffer.concat(buffers).toString('utf8');
  return form ? new URLSearchParams(text) : JSON.parse(text);
}
const server = createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; frame-ancestors 'none'; form-action 'self'");
  try {
    // Everything that reads the request stays inside try: an escaped error here stops the whole server.
    const path = new URL(req.url,'http://localhost').pathname;
    const authorization = req.headers.authorization;
    const role = req.headers['x-keypharm-role'] ?? 'operator';
    const handheld = authorization?.startsWith('Bearer ');
    const dashboardId = req.headers.cookie?.split(/;\s*/).find(value => value.startsWith(dashboardCookie + '='))?.slice(dashboardCookie.length + 1);
    const user = handheld || !dashboardId ? authenticate(authorization,role) :
      workspace.dashboardSessionValid(dashboardId,Date.now()) ? (authorization ? authenticate(authorization,role) : userForRole(role)) : null;
    const deviceHeader = req.headers['x-keypharm-device-id'];
    const deviceId = handheld && typeof deviceHeader === 'string' && /^[0-9a-f]{1,16}$/i.test(deviceHeader) ? deviceHeader.toLowerCase() : null;
    if (req.method === 'POST' && ['/dashboard/sign-in','/dashboard/sign-out'].includes(path)) {
      const origin = req.headers.origin;
      const localForm = origin === (hosted ? 'https://' : 'http://') + req.headers.host ||
        ((!origin || origin === 'null') && req.headers['sec-fetch-site'] === 'same-origin');
      if (!localForm) return json(res,403,{message:'Open the action from the KeyPharm dashboard.'});
      if (path === '/dashboard/sign-in') {
        const fields = await payload(req,true);
        if (fields.get('username') !== username || !same(password,fields.get('password') ?? '')) {
          return dashboardSignIn(res,'Check your username and password.');
        }
        if (dashboardId) workspace.removeDashboardSession(dashboardId);
        startDashboardSession(res);
        res.writeHead(303,{Location:'/'});
      } else {
        if (dashboardId) workspace.removeDashboardSession(dashboardId);
        setDashboardCookie(res,'signed-out');
        res.writeHead(303,{Location:'/dashboard/sign-in'});
      }
      return res.end();
    }
    if (req.method === 'GET' && path === '/dashboard/sign-in') return dashboardSignIn(res);
    const signInAsset = req.method === 'GET' && ['/dashboard.css','/dashboard-theme.mjs','/InterVariable.woff2'].includes(path);
    if (!user && !signInAsset) {
      if (path === '/' && req.method === 'GET') {
        res.writeHead(303,{Location:'/dashboard/sign-in'});
        return res.end();
      }
      return json(res,401,{message:'Sign in with a KeyPharm demo account.'});
    }
    if (req.method === 'GET') {
      if (path === '/records') return json(res,200,workspace.records());
      if (path === '/api/stock-workflows') {
        const devices = workspace.devices();
        return json(res,200,{...workspace.stockTasks(),devices,device:devices.at(-1)});
      }
      if (path === '/api/carton-history') {
        const epc = new URL(req.url,'http://localhost').searchParams.get('epc');
        if (!epc) return json(res,400,{message:'Choose a carton.'});
        return json(res,200,workspace.stockHistory(epc));
      }
      if (path === '/api/workspace') {
        if (handheld) workspace.recordDevice(deviceId ?? 'default',user);
        const {sessions} = workspace.records();
        const stockTasks = !handheld ? [] : workspace.stockTasks().tasks.filter(task =>
          (user.role === 'operator' && !['Reviewed','Cancelled'].includes(task.status)) || (user.role === 'admin' && task.type === 'receipt' && task.status !== 'Cancelled'));
        const palletManifests = !handheld && user.role === 'admin' ? workspace.palletManifests().filter(item => item.status !== 'Cancelled') :
          deviceId && user.role === 'operator' ? workspace.palletManifests().filter(item =>
            item.deviceId === deviceId && item.status === 'Awaiting pallet scan') : [];
        const managesManifests = !handheld && user.role === 'admin';
        return json(res,200,{user,generation:workspace.generation(),inventory:workspace.inventory(),palletManifests,
          ...(managesManifests ? {assignedCartonEpcs:workspace.assignedCartonEpcs(),existingPallets:workspace.existingPallets(),
            skuAvailability:workspace.skuAvailability()} : {}),
          palletInventory:workspace.palletCatalog(),
          ...(handheld ? {verificationClaims:workspace.verificationClaims(),palletClaims:workspace.palletClaims()} : {}),
          removedSessions:handheld ? workspace.removedSessions() : [],
          devices:!handheld ? workspace.devices() : [],
          controls:workspace.settings(),outboundLocations:workspace.outboundLocations(),sessions,stockTasks,...workspace.outbound(user,sessions)});
      }
      if (path === '/api/pallet-manifest.csv') {
        if (handheld || user.role !== 'admin') return json(res,403,{message:'Administrator access required.'});
        const id = new URL(req.url,'http://localhost').searchParams.get('id');
        const draft = workspace.palletManifests().find(item => item.id === id && item.status !== 'Cancelled');
        if (!draft?.csv) return json(res,404,{message:'Manifest not found.'});
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="pallet-manifest.csv"'});
        return res.end(draft.csv);
      }
      // Build each export before sending headers, so a failure can still return an error response.
      if (path === '/api/evidence.csv') {
        const body = specEvidenceCsv(workspace.records());
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="keypharm-evidence.csv"'});
        return res.end(body);
      }
      const report = /^\/api\/(stock|movements|receipts|counts|receipt-template)\.csv$/.exec(path);
      if (report) {
        const body = workspace.stockReport(report[1]);
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="keypharm-' + report[1] + '.csv"'});
        return res.end(body);
      }
      if (path === '/api/sample' || path === '/api/physical-sample') {
        return json(res,200,{csv:workspace.sample(path === '/api/physical-sample' ? 'C72 hardware' : 'Simulation')});
      }
      if (pages.has(path)) {
        const asset = pages.get(path);
        let content = await readFile(resolve(assets,asset));
        if (path === '/') {
          if (!dashboardId && !handheld) startDashboardSession(res);
          content = content.toString('utf8').replace('</head>',
            '<script type="module" src="workspace-dashboard.mjs"></script></head>');
        }
        res.writeHead(200,{'Content-Type':mime[asset.split('.').at(-1)]});
        return res.end(content);
      }
    }
    if (req.method === 'POST' && path.startsWith('/api/')) {
      // Browser requests use same-origin JSON. The native handheld transport has no Origin header.
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        return json(res,403,{message:'Open the API from the KeyPharm dashboard.'});
      }
      const body = await payload(req);
      if (path === '/api/login') {
        if (!req.headers.authorization?.startsWith('Basic ')) return json(res,401,{message:'Sign in with a password.'});
        return json(res,200,{user:{...user,role:'operator',name:demoRoles.operator,canSwitch:true},token});
      }
      if (path === '/api/reset') return json(res,200,workspace.reset(user,body));
      if ((body.generation ?? 0) !== workspace.generation()) {
        return json(res,409,{message:'Demo data was reset. Sync or refresh before making changes.'});
      }
      if (path === '/api/pallet-manifest') {
        if (handheld && (!deviceId || !['scan','register-pallet'].includes(body.action))) return json(res,403,{message:'A registered handheld is required for this scan.'});
        return json(res,200,workspace.palletManifest(user,body,deviceId,workspace.devices()
          .filter(device => device.deviceId && Date.now() - Date.parse(device.lastContact) < 60_000).map(device => device.deviceId)));
      }
      if (path === '/api/session') return json(res,201,workspace.create(user,body));
      if (path === '/api/action') return json(res,200,workspace.action(user,body,!handheld));
      if (path === '/api/dispatch') return json(res,200,workspace.dispatchSelected(user,body));
      if (path === '/api/stock-action') {
        if (body.reader === 'hardware' && !handheld) return json(res,403,{message:'Capture live RFID reads on the handheld.'});
        if (body.scenario && !handheld) return json(res,403,{message:'Run stock simulations on the handheld.'});
        if (body.action === 'receive-carton' && !handheld) return json(res,403,{message:'Receive cartons on the handheld.'});
        return json(res,200,workspace.stockCommand(user,body,!handheld));
      }
      if (path === '/api/sync') return json(res,200,workspace.sync(user,body));
      if (path === '/api/settings') return json(res,200,workspace.setControls(user,body));
    }
    return json(res,404,{message:'Page not found.'});
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const status = error.status || (error instanceof SyntaxError ? 400 : 422);
    if (status >= 500) console.error(error);
    return json(res,status,{message:status >= 500 ? 'Workspace is unavailable.' : error.message});
  }
});
const host = hosted ? '0.0.0.0' : '127.0.0.1';
server.listen(Number(process.env.KEYPHARM_PORT || (hosted && process.env.PORT) || 8790),host,() => {
  console.log('KeyPharm workspace: http://' + host + ':' + server.address().port);
  if (!hosted) console.log('Demo accounts file: ' + credentialsPath);
});
