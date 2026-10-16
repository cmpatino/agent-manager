// Exercise the production route adapter and durable dispatcher without a CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { NotificationInbox, notificationRoutes } from '../src/notifications.js';
import { ApiError, apiRoutes, apiErrorHandler, errorEnvelope } from '../src/api-errors.js';
import { createRequestPolicy, requestAdmission, REQUEST_HEADERS } from '../src/request-admission.js';
import { createValidator } from '../src/api-validation.js';
import { operationMiddleware } from '../src/operations.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'am-notifications-'));
test.after(() => fs.rm(root, { recursive: true, force: true }));
let serial = 0;
async function fixture(options = {}) {
  let clock = 100_000;
  let status = 'waiting';
  let session = { id: 'agent', cli: 'codex', name: 'Agent' };
  const sent = [];
  const settings = { file: path.join(root, `${++serial}.json`), getSession: () => session,
    state: async () => status, deliver: async (_s, event) => { sent.push(event); }, now: () => clock,
    settleMs: 10, retryMs: 5, ...options };
  const inbox = new NotificationInbox(settings);
  await inbox.init();
  return { inbox, settings, sent, status: value => status = value, advance: ms => clock += ms,
    session: value => session = value,
    enqueue: eventId => inbox.enqueue('agent', { source: 'test-board', eventId, text: `Read external event ${eventId}.` }),
    settle: async () => { await inbox.tick(); clock += 11; await inbox.tick(); } };
}

test('busy and unknown targets defer, idle must settle, accepted is distinct from target ACK', async () => {
  const f = await fixture();
  const { notification } = await f.enqueue('one');
  for (const state of ['working', 'unknown', 'input-required', 'stopped']) {
    f.status(state); await f.settle(); assert.equal(f.sent.length, 0);
  }
  f.status('waiting'); await f.inbox.tick(); assert.equal(f.sent.length, 0);
  f.advance(11); await f.inbox.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.inbox.list('agent')[0].status, 'accepted');
  await f.inbox.tick(); assert.equal(f.sent.length, 1);
  await f.inbox.acknowledge('agent', notification.id);
  const row = f.inbox.list('agent')[0];
  assert.equal(row.status, 'acknowledged'); assert.equal(row.text, undefined);
  assert.equal((await f.enqueue('one')).repeated, true);
});

test('failed wake remains pending; new arrivals persist and all survive restart with dedupe', async () => {
  let reject = true;
  const f = await fixture({ deliver: async () => { if (reject) throw new ApiError(409, 'input-not-ready', 'private error'); } });
  const one = await f.enqueue('one');
  await f.settle();
  assert.equal(f.inbox.list('agent')[0].lastError, 'input-not-ready');
  assert.equal(f.inbox.list('agent')[0].status, 'pending');
  await f.enqueue('two');
  const restarted = new NotificationInbox(f.settings); await restarted.init();
  assert.equal(restarted.list('agent').length, 2);
  assert.equal((await restarted.enqueue('agent', { source: 'test-board', eventId: 'one', text: 'Read external event one.' })).notification.id, one.notification.id);
  await assert.rejects(restarted.enqueue('agent', { source: 'test-board', eventId: 'one', text: 'changed' }), { code: 'notification-conflict' });
  reject = false; f.advance(100); await restarted.tick(); f.advance(11); await restarted.tick();
  assert.equal(restarted.list('agent')[0].status, 'accepted');
  const again = new NotificationInbox(f.settings); await again.init();
  assert.equal(again.list('agent')[0].status, 'accepted');
});

test('a crash with delivering persisted retries the same durable event ID', async () => {
  const f = await fixture(); const { notification } = await f.enqueue('one');
  await f.inbox.change(rows => { rows[0].status = 'delivering'; });
  const restarted = new NotificationInbox(f.settings); await restarted.init();
  assert.equal(restarted.list('agent')[0].status, 'pending');
  assert.equal(restarted.list('agent')[0].lastError, 'interrupted-delivery');
  await restarted.tick(); f.advance(11); await restarted.tick();
  assert.equal(f.sent[0].id, notification.id);
});

test('ACK arriving during actual delivery wins over completion and over later failure', async () => {
  for (const laterFailure of [false, true]) {
    let f;
    f = await fixture({ deliver: async (_s, row) => {
      await f.inbox.acknowledge('agent', row.id);
      if (laterFailure) throw Error('uncertain after actual delivery');
    } });
    await f.enqueue('ack-race'); await f.settle();
    assert.equal(f.inbox.list('agent')[0].status, 'acknowledged');
    await f.settle(); assert.equal(f.inbox.list('agent')[0].attempts, 1);
  }
});

test('archiving/deleting during final async state check prevents delivery', async () => {
  for (const archived of [false, true]) {
    let checks = 0; let f;
    f = await fixture({ state: async () => { if (++checks === 3) f.session(archived ? {id:'agent',archivedAt:'today'} : null); return 'waiting'; } });
    await f.enqueue('gone'); await f.settle();
    assert.equal(f.sent.length, 0);
    assert.equal(f.inbox.list('agent')[0].lastError, 'notification-target-unavailable');
  }
});

test('failed persistence cannot return an accepted receipt or advance in-memory state', async () => {
  const f = await fixture();
  const block = path.join(root, 'not-a-directory'); await fs.writeFile(block, 'x');
  f.inbox.file = path.join(block, 'inbox.json');
  await assert.rejects(f.enqueue('write-fail'));
  assert.equal(f.inbox.list('agent').length, 0);
});

test('production route admission, origin, dedupe, busy dispatch, ACK authorization and restart', async () => {
  const f = await fixture();
  const app = express(); const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  app.use(requestAdmission(createRequestPolicy({ PORT: String(server.address().port) })));
  app.use(express.json());
  const operations = [];
  app.use(operationMiddleware({ resolveOrigin: raw => ['agent', 'peer', 'operator'].includes(raw) ? {id:raw,type:'agent'} : null,
    appendRecord: record => { operations.push(record); } }));
  app.use(errorEnvelope);
  const api = apiRoutes(app, createValidator({cliExists:()=>true,sessionExists:()=>true,groupExists:()=>true}));
  notificationRoutes(api, { inbox: f.inbox, getSession: id => id === 'agent' ? {id,cli:'codex'} : null, promptable:()=>true });
  app.use(apiErrorHandler);
  const post = async (route, body, from = 'agent', intent = true) => {
    const response = await fetch(base + route + '?from=' + from, { method:'POST', headers:{'content-type':'application/json',...(intent ? REQUEST_HEADERS : {})}, body:JSON.stringify(body) });
    return {status:response.status, body:await response.json()};
  };
  const body = {source:'test-board',eventId:'route',text:'External content'};
  try {
    assert.equal((await post('/api/agents/agent/notifications',body,'agent',false)).status,403);
    assert.equal((await post('/api/agents/agent/notifications',body,'peer')).status,403);
    assert.equal((await post('/api/agents/agent/notifications',{},'agent')).status,400);
    const first = await post('/api/agents/agent/notifications',body);
    assert.equal(first.status,202); assert.equal(first.body.notification.status,'pending');
    const duplicate = await post('/api/agents/agent/notifications',body);
    assert.equal(duplicate.body.repeated,true); assert.equal(duplicate.body.notification.id,first.body.notification.id);
    f.status('working'); await f.settle(); assert.equal(f.sent.length,0);
    const route = '/api/agents/agent/notifications/' + first.body.notification.id + '/ack';
    assert.equal((await post(route,{})).status,409);
    f.status('waiting'); await f.settle(); assert.equal(f.sent.length,1);
    assert.equal((await post(route,{},'peer')).status,403);
    assert.equal((await post(route,{})).body.notification.status,'acknowledged');
    const restarted = new NotificationInbox(f.settings); await restarted.init();
    assert.equal(restarted.list('agent')[0].status,'acknowledged');
    assert.ok(operations.some(row=>row.origin.id==='agent' && row.status===202));
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

test('corrupt durable inbox isolates notifications without erasing the file', async () => {
  const f = await fixture();
  const corrupt = '{invalid'; await fs.writeFile(f.settings.file,corrupt);
  const restarted = new NotificationInbox(f.settings); await restarted.init();
  assert.equal(restarted.unavailable,true);
  await restarted.tick(); assert.equal(f.sent.length,0);
  await assert.rejects(restarted.enqueue('agent',{source:'board',eventId:'1',text:'hi'}),{code:'notification-storage-unavailable'});
  assert.equal(await fs.readFile(f.settings.file,'utf8'),corrupt);
});

test('actual readiness adapter never treats a static Codex tool or approval prompt as idle', async () => {
  const { notificationReadiness } = await import('../src/notifications.js');
  let activity = 'working', shared = false, native = 'working', approval = null;
  const state = notificationReadiness({locked:()=>false,info:()=>({inputRequired:approval}),runtime:{shared:()=>shared,refresh:async()=>({status:native})},
    running:()=>true,digest:async()=>({activity}),derive:()=> 'waiting'});
  assert.equal(await state({id:'agent',cli:'codex'}),'working');
  activity = null; assert.equal(await state({id:'agent',cli:'codex'}),'working');
  activity = 'waiting'; assert.equal(await state({id:'agent',cli:'codex'}),'waiting');
  approval = {kind:'permission'}; assert.equal(await state({id:'agent',cli:'codex'}),'input-required');
  approval = null; shared = true; native = 'needs-input';
  assert.equal(await state({id:'agent',cli:'codex'}),'working');
  native = 'idle'; assert.equal(await state({id:'agent',cli:'codex'}),'waiting');
});
