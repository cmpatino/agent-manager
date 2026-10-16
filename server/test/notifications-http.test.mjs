// Full msgboard HTTP -> Python listener -> Manager -> native Codex queue path.
// All peers are local fixtures; no production credentials, board, or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { nativeFetch as fetch } from './native-client.mjs';
import { CodexBindings, endpointIdentity } from '../src/codex-bindings.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-notification-http-'));
const data = path.join(root, 'data'), home = path.join(root, 'home');
const work = path.join(data, 'workspaces', 'fixture'), socket = path.join(root, 'codex.sock');
for (const dir of [work, home, path.join(home, 'sessions')]) fs.mkdirSync(dir, { recursive: true });
const threadId = randomUUID();
const session = { id: 'notify-fixture', name: 'Notification fixture', cli: 'codex', path: 'fixture',
  sessionUuid: randomUUID(), codexSessionId: threadId, codexSharedOnly: true,
  everStarted: true, createdAt: new Date().toISOString() };
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([session]));
const rollout = path.join(home, 'sessions', 'fixture.jsonl');
fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: work } }) + '\n');

let nativeStatus = 'active';
const submitted = [], nativeCalls = [];
const daemon = http.createServer(), wss = new WebSocketServer({ server: daemon });
wss.on('connection', ws => ws.on('message', raw => {
  const message = JSON.parse(raw);
  nativeCalls.push(message.method);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { codexHome: home, userAgent: 'fixture/0.162.1' };
  else if (message.method === 'thread/turns/list') result = { data: [] };
  else if (message.method === 'thread/queue/add') {
    submitted.push(message.params);
    result = { queuedSubmission: { id: 'queued-' + submitted.length, clientUserMessageId: message.params.clientUserMessageId } };
  } else {
    assert.ok(['thread/read', 'thread/resume'].includes(message.method), 'unexpected native method: ' + message.method);
    result = { thread: { id: threadId, cwd: work, path: rollout, status: { type: nativeStatus },
      canAcceptDirectInput: true, parentThreadId: null } };
  }
  ws.send(JSON.stringify({ id: message.id, result }));
}));
await new Promise(resolve => daemon.listen(socket, resolve));
fs.chmodSync(socket, 0o600);
new CodexBindings(path.join(data, 'codex-bindings.json')).bind({ session, threadId,
  endpointId: endpointIdentity({ socket, home }), cwd: work, expectedRevision: 0 });

// Real HTTP exercises token/header handling, not an injected Python transport.
const boardRequests = [];
const board = http.createServer((req, res) => {
  boardRequests.push({ url: req.url, authorization: req.headers.authorization });
  const cursor = Number(new URL(req.url, 'http://fixture').searchParams.get('after'));
  const messages = cursor < 2 ? [{ id: 2, reason: 'mention', channel_id: 12,
    sender: { external_id: 'synthetic-person' }, body: 'Synthetic notification test only.' }] : [];
  // Model the parked request; avoid an unrealistic empty-response busy loop.
  const timer = setTimeout(() => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ messages, next_cursor: 2, has_more: false }));
  }, messages.length ? 0 : 250);
  res.once('close', () => clearTimeout(timer));
});
await new Promise(resolve => board.listen(0, '127.0.0.1', resolve));
const free = net.createServer().listen(0, '127.0.0.1');
await once(free, 'listening');
const port = free.address().port;
await new Promise(resolve => free.close(resolve));
const base = `http://127.0.0.1:${port}`, serverDir = fileURLToPath(new URL('../', import.meta.url));
const preload = path.join(root, 'preload.mjs');
fs.writeFileSync(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const original=cp.execFile;cp.execFile=(...args)=>{if(args[1]?.includes('--version')){queueMicrotask(()=>args.at(-1)(new Error('fixture')));return;}return original(...args)};
syncBuiltinESMExports();globalThis.fetch=async()=>new Response(JSON.stringify({private:true}),{status:200});`);
const tokenFile = path.join(root, 'token.json'), stateFile = path.join(root, 'listener-state.json');
fs.writeFileSync(tokenFile, '{"token":"synthetic-test-token"}', { mode: 0o600 });
const configFile = path.join(root, 'listener-config.json');
fs.writeFileSync(configFile, JSON.stringify({ boardUrl: `http://127.0.0.1:${board.address().port}`,
  managerUrl: base, handle: 'synthetic-agent', agentId: session.id, tokenFile, stateFile, initialCursor: 1 }));
let manager, listener, logs = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 35_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    if (manager?.exitCode !== null) throw Error('Manager exited: ' + logs.slice(-2000));
    await delay(200);
  }
  throw Error('Timed out: ' + description + '\n' + logs.slice(-2000));
}
async function request(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-am-origin': session.id },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
const notifications = async () => (await request(`/api/agents/${session.id}/notifications`)).body.notifications;
async function startManager() {
  manager = spawn(process.execPath, ['--import', preload, 'src/index.js'], { cwd: serverDir,
    env: { PATH: process.env.PATH, HOME: home, DATA_DIR: data, PORT: String(port), AM_BIND_HOST: '127.0.0.1',
      PUBLIC_DIR: path.join(root, 'public'), CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'),
      AM_REPIN_DIR: path.join(root, 'repin'), AM_INPUT_REQUIRED_DIR: path.join(root, 'input'),
      AM_BASHRC: '/nonexistent', AM_CODEX_SHARED_SOCKET: socket, AM_CODEX_SHARED_HOME: home, AM_CODEX_BINDINGS_PILOT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  manager.stdout.on('data', chunk => { logs += chunk; });
  manager.stderr.on('data', chunk => { logs += chunk; });
  await until(() => request('/api/health').then(r => r.status === 200).catch(() => false), 'Manager startup');
}
function startListener() {
  listener = spawn('python3', ['-u', path.join(serverDir, '../scripts/msgboard/listener.py'), '--config', configFile],
    { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  listener.stdout.on('data', chunk => { logs += chunk; });
  listener.stderr.on('data', chunk => { logs += chunk; });
}
async function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
}
try {
  await startManager(); startListener();
  await until(async () => (await notifications())?.length === 1, 'Python adapter registers fetched mention');
  const received = (await notifications())[0];
  assert.equal(received.status, 'pending');
  assert.equal(received.eventId, '2');
  await delay(2500); // Let a real dispatcher tick observe the active thread.
  assert.equal(submitted.length, 0, 'working agent must not receive input');
  assert.equal((await request(`/api/agents/${session.id}/prompt?from=${session.id}`, { text: 'must still reject self-prompt' })).status, 400);
  nativeStatus = 'idle';
  await until(async () => (await notifications())[0]?.status === 'accepted', 'settled idle task receives native queue input');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].clientUserMessageId, received.id);
  assert.match(submitted[0].input[0].text, /external notification from msgboard:/);
  assert.ok(submitted[0].input[0].text.includes(stateFile));
  assert.ok(boardRequests.every(r => r.authorization === 'Bearer synthetic-test-token'));
  assert.ok(!nativeCalls.some(method => ['turn/start', 'turn/steer', 'turn/interrupt'].includes(method)));

  // Recreate both processes from disk; accepted is not an excuse to resend.
  await stop(listener); await stop(manager);
  await startManager(); startListener();
  assert.equal((await notifications())[0].status, 'accepted');
  const ack = await request(`/api/agents/${session.id}/notifications/${received.id}/ack?from=${session.id}`, {});
  assert.equal(ack.status, 200); assert.equal(ack.body.notification.status, 'acknowledged');
  await until(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')).events['2'].managerStatus === 'acknowledged', 'adapter observes target acknowledgement');
  assert.equal(submitted.length, 1, 'restart must not duplicate accepted notification');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).cursor, 2);
  console.log('PASS full notification HTTP path: fetch, durable receipt, busy deferral, idle native wake, ACK, restart and dedupe; self-prompt guard intact.');
} finally {
  await stop(listener); await stop(manager);
  board.closeAllConnections(); await new Promise(resolve => board.close(resolve));
  for (const ws of wss.clients) ws.terminate();
  await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => daemon.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
