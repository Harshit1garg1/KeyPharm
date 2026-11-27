// Starts the real workspace server and checks how it behaves on a local PC and on Render.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseManifest} from '../app/src/main/assets/model.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const password = 'a-long-render-test-password';
const secret = 'render-test-secret-0123456789abcdef';
const hosted = {RENDER:'true', PORT:'0', KEYPHARM_PASSWORD:password, KEYPHARM_SECRET:secret};

async function start(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'keypharm-server-'));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('KEYPHARM_') && !['RENDER','PORT'].includes(key)));
  const child = spawn(process.execPath, ['tools/workspace-server.mjs'],
    {cwd:root, env:{...env, KEYPHARM_LOCAL_DATA:directory, ...extra}});
  const exited = new Promise(done => child.once('exit', done));
  t.after(async () => { child.kill(); await exited; await rm(directory, {recursive:true, force:true}); });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const address = await new Promise(done => {
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = /KeyPharm workspace: http:\/\/([\d.]+):(\d+)/.exec(output);
      if (found) done({host:found[1], port:Number(found[2])});
    });
    exited.then(code => done({code}));
  });
  return {...address, directory, errors:() => errors};
}

function call({port}, path, headers = {}, body) {
  return new Promise((done, failed) => {
    const req = request({host:'127.0.0.1', port, path, method:body === undefined ? 'GET' : 'POST', headers}, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => done({status:res.statusCode, headers:res.headers, text}));
    });
    req.on('error', failed);
    req.end(body);
  });
}

const login = (server, secretWord) => call(server, '/api/login', {'Content-Type':'application/json',
  Authorization:'Basic ' + Buffer.from('testing:' + secretWord).toString('base64')}, '{}');
const signIn = (server, scheme) => call(server, '/dashboard/sign-in', {'Content-Type':'application/x-www-form-urlencoded',
  Origin:scheme + '://127.0.0.1:' + server.port}, new URLSearchParams({username:'testing', password}).toString());

test('local run stays on loopback with the demo password', async t => {
  const server = await start(t, {KEYPHARM_PORT:'0', PORT:'1'});
  assert.equal(server.host, '127.0.0.1');
  assert.equal((await login(server, 'testing123')).status, 200);
});

for (const [name, env] of [
  ['no password', {KEYPHARM_PASSWORD:''}],
  ['the demo password', {KEYPHARM_PASSWORD:'testing123'}],
  ['a short password', {KEYPHARM_PASSWORD:'short'}],
  ['no secret', {KEYPHARM_SECRET:''}]
]) {
  test('Render refuses to start with ' + name, async t => {
    const server = await start(t, {...hosted, ...env});
    assert.notEqual(server.code, undefined, 'server started');
    assert.notEqual(server.code, 0);
    assert.match(server.errors(), /KEYPHARM_(PASSWORD|SECRET)/);
  });
}

test('Render listens publicly, uses its own password and keeps tokens across restarts', async t => {
  const first = await start(t, hosted);
  assert.equal(first.host, '0.0.0.0');
  assert.equal((await login(first, 'testing123')).status, 401);
  const response = await login(first, password);
  assert.equal(response.status, 200);
  assert.equal(existsSync(join(first.directory, 'accounts.json')), false, 'credentials written to disk');
  const second = await start(t, hosted);
  const {token} = JSON.parse(response.text);
  assert.equal((await call(second, '/api/workspace', {Authorization:'Bearer ' + token})).status, 200);
});

test('a malformed request path does not stop the server', async t => {
  const server = await start(t, hosted);
  assert.ok((await call(server, '//')).status < 500);
  assert.equal((await login(server, password)).status, 200);
});

test('a failing export returns an error and leaves the server running', async t => {
  const server = await start(t, hosted);
  const {token} = JSON.parse((await login(server, password)).text);
  const send = async (role, path, body) => {
    const response = await call(server, path, {'Content-Type':'application/json',
      Authorization:'Bearer ' + token + '.' + role}, JSON.stringify(body));
    assert.ok(response.status < 300, path + ' ' + response.text);
    return JSON.parse(response.text);
  };
  const {csv} = JSON.parse((await call(server, '/api/sample', {Authorization:'Bearer ' + token + '.admin'})).text);
  const manifest = parseManifest(csv);
  let session = await send('admin', '/api/session',
    {testId:'KP-EXPORT', location:'Staging', source:'Simulation', sample:true});
  session = await send('supervisor', '/api/action',
    {id:session.id, revision:session.workspaceRevision, action:'physical', confirmed:true});
  const now = new Date().toISOString();
  await send('operator', '/api/sync', {id:session.id, revision:session.workspaceRevision, operationId:randomUUID(),
    session:{...session, identified:true,
      palletAttempts:[{startedAt:now, observations:{[session.manifest.palletEpc]:{count:1}}}],
      runs:[{id:randomUUID(), state:'Finished', source:'Simulation', manifestRevision:session.manifest.revision,
        startedAt:now, endedAt:now, observations:{}, method:{toString:0, valueOf:0}}]}});
  const exported = await call(server, '/api/evidence.csv', {Authorization:'Bearer ' + token + '.admin'});
  assert.ok(exported.status >= 400, 'export unexpectedly succeeded');
  assert.equal((await login(server, password)).status, 200);
});

test('Render dashboard sign-in accepts the HTTPS origin and sets a Secure cookie', async t => {
  const server = await start(t, hosted);
  const ok = await signIn(server, 'https');
  assert.equal(ok.status, 303);
  assert.match(String(ok.headers['set-cookie']), /; Secure/);
  assert.equal((await signIn(server, 'http')).status, 403);
});
