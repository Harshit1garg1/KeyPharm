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
const password = 'testing123';
let saved;
try { saved = JSON.parse(await readFile(credentialsPath,'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const account = {password,secret:saved?.[username]?.secret ?? randomBytes(32).toString('hex')};
const accounts = {[username]:account};
if (JSON.stringify(saved) !== JSON.stringify(accounts)) {
  const pending = credentialsPath + '.new';
  await writeFile(pending,JSON.stringify(accounts,null,2),{mode:0o600});
  await rename(pending,credentialsPath);
}
const token = username + '.' + createHmac('sha256',account.secret).update(password).digest('base64url');
const same = (a,b) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left,right);
};
function authenticate(header = '',browserRole = 'operator') {
  const [scheme, input = ''] = header.split(' ');
  let role;
  if (scheme === 'Basic') {
    const decoded = Buffer.from(input,'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0 || decoded.slice(0,i) !== username || !same(password,decoded.slice(i + 1))) return null;
    role = browserRole;
  } else if (scheme === 'Bearer') {
    const [id,signature,requested = 'operator',...extra] = input.split('.');
    if (extra.length || !same(token,id + '.' + signature)) return null;
    role = requested;
  } else return null;
  return Object.hasOwn(demoRoles,role) ? {id:username,role,name:demoRoles[role],canSwitch:true} : null;
}
const hardware = await readFile(resolve(assets,'private-live-sample.csv'),'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const workspace = createWorkspace(resolve(storage,'workspace.sqlite'),hardware);
let handheldContact;
const pages = new Map([
  ['/','dashboard.html'], ['/dashboard.css','dashboard.css'], ['/dashboard.mjs','dashboard.mjs'],
  ['/dashboard-model.mjs','dashboard-model.mjs'], ['/workspace-dashboard.mjs','workspace-dashboard.mjs'],
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
async function payload(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw Object.assign(new Error('Send JSON.'),{status:415});
  let size = 0;
  const buffers = [];
  for await (const chunk of req) {
    if ((size += chunk.length) > 1_000_000) throw Object.assign(new Error('Request is too large.'),{status:413});
    buffers.push(chunk);
  }
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
}
const server = createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; frame-ancestors 'none'; form-action 'self'");
  const path = new URL(req.url,'http://localhost').pathname;
  const user = authenticate(req.headers.authorization,req.headers['x-keypharm-role']);
  const handheld = req.headers.authorization?.startsWith('Bearer ');
  try {
    if (!user) {
      if (path === '/') res.setHeader('WWW-Authenticate','Basic realm="KeyPharm local demonstration"');
      return json(res,401,{message:'Sign in with a KeyPharm demo account.'});
    }
    if (req.method === 'GET') {
      if (path === '/records') return json(res,200,workspace.records());
      if (path === '/api/stock-workflows') return json(res,200,{...workspace.stockTasks(),device:handheldContact});
      if (path === '/api/carton-history') {
        const epc = new URL(req.url,'http://localhost').searchParams.get('epc');
        if (!epc) return json(res,400,{message:'Choose a carton.'});
        return json(res,200,workspace.stockHistory(epc));
      }
      if (path === '/api/workspace') {
        if (handheld) {
          const id = req.headers['x-keypharm-device-id'];
          const deviceId = typeof id === 'string' && /^[0-9a-f]{1,16}$/i.test(id) ? id : handheldContact?.deviceId;
          handheldContact = {lastContact:new Date().toISOString(),deviceId};
        }
        const {sessions} = workspace.records();
        const stockTasks = !handheld ? [] : workspace.stockTasks().tasks.filter(task =>
          (user.role === 'operator' && !['Reviewed','Cancelled'].includes(task.status)) || (user.role === 'admin' && task.type === 'receipt'));
        return json(res,200,{user,generation:workspace.generation(),inventory:workspace.inventory(),
          controls:workspace.settings(),sessions,stockTasks,...workspace.outbound(user,sessions)});
      }
      if (path === '/api/evidence.csv') {
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="keypharm-evidence.csv"'});
        return res.end(specEvidenceCsv(workspace.records()));
      }
      const report = /^\/api\/(stock|movements|receipts|counts|receipt-template)\.csv$/.exec(path);
      if (report) {
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="keypharm-' + report[1] + '.csv"'});
        return res.end(workspace.stockReport(report[1]));
      }
      if (path === '/api/sample' || path === '/api/physical-sample') {
        return json(res,200,{csv:workspace.sample(path === '/api/physical-sample' ? 'C72 hardware' : 'Simulation')});
      }
      if (pages.has(path)) {
        const asset = pages.get(path);
        let content = await readFile(resolve(assets,asset));
        if (path === '/') content = content.toString('utf8').replace('</head>',
          '<script type="module" src="workspace-dashboard.mjs"></script></head>');
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
        return json(res,200,{user,token});
      }
      if (path === '/api/reset') return json(res,200,workspace.reset(user,body));
      if ((body.generation ?? 0) !== workspace.generation()) {
        return json(res,409,{message:'Demo data was reset. Sync or refresh before making changes.'});
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
    const status = error.status || (error instanceof SyntaxError ? 400 : 422);
    if (status >= 500) console.error(error);
    return json(res,status,{message:status >= 500 ? 'Workspace is unavailable.' : error.message});
  }
});
server.listen(Number(process.env.KEYPHARM_PORT || 8790),'127.0.0.1',() => {
  console.log('KeyPharm workspace: http://127.0.0.1:' + server.address().port);
  console.log('Demo accounts file: ' + credentialsPath);
});
