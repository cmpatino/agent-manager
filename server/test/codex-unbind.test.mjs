// Removing a Codex binding when its AM session is deleted (#172).
//
// The file was append-only, so a deleted session left a record keyed on
// (endpointId, threadId) that nothing could clear — and because that key is
// unique, the thread could never be bound or imported again. The only remedy
// was hand-editing the file, which is how it acquires the malformed byte that
// breaks every Codex launch.
//
// Removal is the dangerous direction, not the safe one: an unbound Codex
// session launches a STANDALONE writer, and the thread this record names is
// owned by the shared server. So the record may only go once the session is
// gone, and remove() refuses while it still exists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUEST_HEADERS } from '../src/request-admission.js';
import { CodexBindings, endpointIdentity } from '../src/codex-bindings.js';

const THREAD = (n) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const ENDPOINT = endpointIdentity({ socket: '/tmp/am-unbind.sock', home: '/tmp/am-unbind-home', uid: process.getuid() });

// ---------------------------------------------------------------- unit

const unit = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-unbind-'));
  const cwd = fs.realpathSync(dir);
  const bindings = new CodexBindings(path.join(dir, 'codex-bindings.json'));
  const live = new Set();
  const sessionExists = (id) => live.has(id);
  const add = (id, thread) => {
    live.add(id);
    const session = { id, cli: 'codex', sessionUuid: crypto.randomUUID() };
    bindings.bind({ session, threadId: thread, endpointId: ENDPOINT, cwd, expectedRevision: 0 });
    return session;
  };
  return { dir, cwd, bindings, live, sessionExists, add,
    clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('a removed binding frees its thread to be bound again', () => {
  const f = unit();
  try {
    const a = f.add('sess-a', THREAD(1));
    assert.throws(() => f.bindings.bind({ session: { id: 'sess-b', cli: 'codex', sessionUuid: crypto.randomUUID() },
      threadId: THREAD(1), endpointId: ENDPOINT, cwd: f.cwd, expectedRevision: 0 }), { code: 'binding-conflict' });

    f.live.delete(a.id);
    const removed = f.bindings.remove({ sessionId: a.id, sessionExists: f.sessionExists });
    assert.equal(removed.threadId, THREAD(1));
    assert.equal(f.bindings.forSession(a.id), null);
    assert.equal(f.bindings.resolve(ENDPOINT, THREAD(1)), null);

    const b = f.bindings.bind({ session: { id: 'sess-b', cli: 'codex', sessionUuid: crypto.randomUUID() },
      threadId: THREAD(1), endpointId: ENDPOINT, cwd: f.cwd, expectedRevision: 0 });
    assert.equal(b.amSessionId, 'sess-b');
  } finally { f.clean(); }
});

test('a binding is never removed out from under a session that still exists', () => {
  const f = unit();
  try {
    const a = f.add('sess-a', THREAD(1));
    // Live: removing it would leave a Codex session that launches standalone.
    assert.throws(() => f.bindings.remove({ sessionId: a.id, sessionExists: f.sessionExists }),
      { code: 'binding-session-live' });
    assert.equal(f.bindings.forSession(a.id).threadId, THREAD(1), 'the record is untouched');
    // And again under the lock: the caller's check raced the lock wait.
    f.live.delete(a.id);
    let asked = 0;
    assert.throws(() => f.bindings.remove({ sessionId: a.id, sessionExists: () => ++asked > 1 }),
      { code: 'binding-session-live' });
    assert.ok(asked > 1, 're-checked after the read, not only before the lock');
    assert.equal(f.bindings.forSession(a.id).threadId, THREAD(1));
  } finally { f.clean(); }
});

test('pruning an unbound session is not an error, and leaves other records alone', () => {
  const f = unit();
  try {
    f.add('sess-a', THREAD(1));
    f.add('sess-b', THREAD(2));
    assert.equal(f.bindings.remove({ sessionId: 'sess-never-bound', sessionExists: () => false }), null);
    f.live.delete('sess-a');
    f.bindings.remove({ sessionId: 'sess-a', sessionExists: f.sessionExists });
    assert.equal(f.bindings.forSession('sess-a'), null);
    assert.equal(f.bindings.forSession('sess-b').threadId, THREAD(2), "the other session's binding survives");
  } finally { f.clean(); }
});

test('removal is atomic, locked, and leaves nothing behind', () => {
  const f = unit();
  try {
    f.add('sess-a', THREAD(1));
    f.add('sess-b', THREAD(2));
    f.live.delete('sess-a');
    // Someone else holds the lock: refuse rather than write beside them.
    const lock = `${f.bindings.file}.lock`;
    fs.writeFileSync(lock, '');
    assert.throws(() => f.bindings.remove({ sessionId: 'sess-a', sessionExists: f.sessionExists }),
      { code: 'bindings-busy' });
    fs.unlinkSync(lock);

    f.bindings.remove({ sessionId: 'sess-a', sessionExists: f.sessionExists });
    const left = fs.readdirSync(f.dir).filter((n) => n.includes('codex-bindings'));
    assert.deepEqual(left, ['codex-bindings.json'], `no temp or lock files left: ${left.join(', ')}`);
    const raw = JSON.parse(fs.readFileSync(f.bindings.file, 'utf8'));
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.bindings.map((r) => r.amSessionId), ['sess-b']);
    assert.equal(f.bindings.read().length, 1, 'the file still passes validation');
  } finally { f.clean(); }
});

// ---------------------------------------------------------------- the route

const api = async (fn) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-unbind-api-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const data = path.join(root, 'data');
  // cwd, not the runner's: `node --test server/test/...` runs from the repo root.
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = spawn(process.execPath, ['src/index.js'], { cwd: serverDir, stdio: ['ignore', 'ignore', 'ignore'], env: {
    PATH: process.env.PATH, HOME: home, DATA_DIR: data, PORT: String(port),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), AM_REPIN_DIR: path.join(root, 'repin'),
    AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), AM_BASHRC: '/nonexistent',
  } });
  const call = async (route, init = {}) => {
    const res = await fetch(origin + route, { ...init, headers: {
      ...REQUEST_HEADERS, 'x-am-origin': 'operator', 'content-type': 'application/json', ...init.headers } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    for (let n = 0; ; n++) {
      if (await fetch(origin + '/api/health').then((r) => r.ok).catch(() => false)) break;
      assert.ok(n < 150 && server.exitCode === null, 'isolated backend started');
      await new Promise((r) => setTimeout(r, 100));
    }
    await fn({ call, bindings: new CodexBindings(path.join(data, 'codex-bindings.json')), data });
  } finally {
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
};

// The bound session the route has to cope with, built through the real API so
// nothing about it is invented here except the binding itself.
const boundSession = async ({ call, bindings, data }, name, thread) => {
  const created = await call('/api/sessions', { method: 'POST', body: JSON.stringify({ name, cli: 'codex', path: '.' }) });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  const session = (await call('/api/sessions')).body.find((s) => s.id === created.body.id);
  bindings.bind({ session, threadId: thread, endpointId: ENDPOINT, expectedRevision: 0,
    cwd: fs.realpathSync(path.join(data, 'workspaces', session.path ?? session.id)) });
  assert.equal(bindings.forSession(session.id).threadId, thread);
  return session;
};

test('deleting a bound session removes it and frees its thread', async () => {
  await api(async (ctx) => {
    const session = await boundSession(ctx, 'shared-a', THREAD(1));
    // Before: the delete route's own first step refused, so the session could
    // not be removed at all and its record could never be cleared.
    assert.equal((await ctx.call(`/api/sessions/${session.id}/archive`, { method: 'POST' })).status, 200);
    const deleted = await ctx.call(`/api/sessions/${session.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal((await ctx.call('/api/sessions')).body.find((s) => s.id === session.id), undefined);
    assert.equal(ctx.bindings.forSession(session.id), null, 'the binding went with it');
    assert.equal(ctx.bindings.resolve(ENDPOINT, THREAD(1)), null, 'and the thread can be bound again');
  });
});

test('archiving a bound session keeps its binding', async () => {
  await api(async (ctx) => {
    const session = await boundSession(ctx, 'shared-b', THREAD(2));
    assert.equal((await ctx.call(`/api/sessions/${session.id}/archive`, { method: 'POST' })).status, 200);
    // Archiving is reversible; an unarchived session has to find its thread.
    assert.equal(ctx.bindings.forSession(session.id)?.threadId, THREAD(2));
    assert.equal((await ctx.call(`/api/sessions/${session.id}/unarchive`, { method: 'POST' })).status, 200);
    assert.equal(ctx.bindings.forSession(session.id)?.threadId, THREAD(2));
  });
});

test('a session delete that cannot commit leaves the binding alone', async () => {
  await api(async (ctx) => {
    const session = await boundSession(ctx, 'shared-d', THREAD(4));
    assert.equal((await ctx.call(`/api/sessions/${session.id}/archive`, { method: 'POST' })).status, 200);

    // The half-commit this guards: store.remove() used to drop the row from
    // memory and only LOG a failed write, so store.get() answered null over a
    // row still on disk — the prune then passed its live-session check and took
    // the binding, and the session came back on the next boot unbound.
    //
    // Fail exactly that one write and nothing else: a directory where
    // sessions.json should be makes its rename EISDIR, while the group and
    // order files beside it are untouched. A read-only data directory would
    // also fail steps earlier in the route and prove nothing about this one.
    const file = path.join(ctx.data, 'sessions.json');
    const rows = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    let deleted;
    try { deleted = await ctx.call(`/api/sessions/${session.id}`, { method: 'DELETE' }); }
    finally { fs.rmdirSync(file); fs.writeFileSync(file, rows); }
    assert.notEqual(deleted.status, 200, 'a delete that cannot commit must not report success');

    assert.equal(ctx.bindings.forSession(session.id)?.threadId, THREAD(4),
      'the binding outlives a delete that did not commit');
    // And the row the delete failed to remove is still on disk, which is what
    // makes keeping the binding the right answer rather than a missed cleanup.
    assert.deepEqual(JSON.parse(rows).map((row) => row.id).filter((id) => id === session.id), [session.id]);
  });
});

test('a stranded binding is cleared by the next genuine bind, not by hand', () => {
  const f = unit();
  try {
    // What a failed prune — or a crash between the two renames — leaves: a
    // record owning a thread, and no session it belongs to.
    f.add('sess-gone', THREAD(1));
    f.live.delete('sess-gone');
    assert.throws(() => f.bindings.bind({ session: { id: 'sess-new', cli: 'codex', sessionUuid: crypto.randomUUID() },
      threadId: THREAD(1), endpointId: ENDPOINT, cwd: f.cwd, expectedRevision: 0 }),
      { code: 'binding-conflict' }, 'without a session list, nothing is assumed');

    const bound = f.bindings.bind({ session: { id: 'sess-new', cli: 'codex', sessionUuid: crypto.randomUUID() },
      threadId: THREAD(1), endpointId: ENDPOINT, cwd: f.cwd, expectedRevision: 0, sessionExists: f.sessionExists });
    assert.equal(bound.amSessionId, 'sess-new');
    assert.deepEqual(f.bindings.read().map((r) => r.amSessionId), ['sess-new'], 'the leftover went with it');
  } finally { f.clean(); }
});

test('reconciliation never touches a record whose session is still there', () => {
  const f = unit();
  try {
    f.add('sess-live', THREAD(1));
    f.add('sess-gone', THREAD(2));
    f.live.delete('sess-gone');
    f.bindings.bind({ session: { id: 'sess-new', cli: 'codex', sessionUuid: crypto.randomUUID() },
      threadId: THREAD(3), endpointId: ENDPOINT, cwd: f.cwd, expectedRevision: 0, sessionExists: f.sessionExists });
    assert.deepEqual(f.bindings.read().map((r) => r.amSessionId).sort(), ['sess-live', 'sess-new']);
  } finally { f.clean(); }
});

test('an ordinary stop is still refused for a bound session', async () => {
  await api(async (ctx) => {
    const session = await boundSession(ctx, 'shared-c', THREAD(3));
    const stopped = await ctx.call(`/api/sessions/${session.id}/stop`, { method: 'POST' });
    assert.equal(stopped.status, 409);
    assert.equal(stopped.body.code, 'codex-shared-stop-unsupported');
    assert.equal(ctx.bindings.forSession(session.id)?.threadId, THREAD(3), 'and nothing was pruned');
  });
});
