// Durable attribution, not authentication. This file is owned by AM, never by
// a Codex tool process. All writes use an exclusive lock and atomic replacement.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class CodexBindingError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => new CodexBindingError(code);
export const validThreadId = (id) => typeof id === 'string'
  && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const validPath = (p) => typeof p === 'string' && path.isAbsolute(p) && !/[\x00-\x1f]/.test(p);
export function endpointIdentity({ socket, home, uid = process.getuid?.() }) {
  if (!validPath(socket) || !validPath(home) || !Number.isSafeInteger(uid)) throw fail('endpoint-invalid');
  return createHash('sha256').update(JSON.stringify([uid, socket, home])).digest('hex');
}
function validate(records) {
  if (!Array.isArray(records) || records.length > 10000) throw fail('bindings-invalid');
  const sessions = new Set(), threads = new Set();
  for (const r of records) {
    if (!r || !validId(r.amSessionId) || !validThreadId(r.amSessionUuid) || !validThreadId(r.threadId)
        || !/^[a-f0-9]{64}$/.test(r.endpointId) || !validPath(r.cwd)
        || !Number.isSafeInteger(r.revision) || r.revision < 1
        || typeof r.boundAt !== 'string' || !Number.isFinite(Date.parse(r.boundAt))) throw fail('bindings-invalid');
    const key = `${r.endpointId}:${r.threadId}`;
    if (sessions.has(r.amSessionId) || threads.has(key)) throw fail('bindings-ambiguous');
    sessions.add(r.amSessionId); threads.add(key);
  }
  return records;
}

export class CodexBindings {
  constructor(file, io = fs) { this.file = file; this.io = io; }
  read() {
    const io = this.io;
    let fd;
    try {
      fd = io.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const st = io.fstatSync(fd);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) throw fail('bindings-invalid');
      const data = JSON.parse(io.readFileSync(fd, 'utf8'));
      if (data?.version !== 1) throw fail('bindings-invalid');
      return validate(data.bindings);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      if (error instanceof CodexBindingError) throw error;
      throw fail('bindings-unavailable');
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  forSession(sessionId) { return this.read().find((r) => r.amSessionId === sessionId) || null; }
  resolve(endpointId, threadId) {
    if (!validThreadId(threadId)) throw fail('thread-invalid');
    return this.read().find((r) => r.endpointId === endpointId && r.threadId === threadId) || null;
  }
  bind({ session, threadId, endpointId, cwd, expectedRevision, sessionExists }) {
    if (session?.cli !== 'codex' || !validId(session.id) || !validThreadId(session.sessionUuid)
        || !validThreadId(threadId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw fail('binding-invalid');
    const io = this.io, lock = `${this.file}.lock`;
    let lockFd, tmp, fd;
    try {
      // A leftover lock is intentionally NOT removed automatically after a crash.
      // The operator must verify that no AM writer is alive before repairing it.
      lockFd = io.openSync(lock, 'wx', 0o600);
      const records = this.read();
      const current = records.find((r) => r.amSessionId === session.id);
      if (current) {
        if (current.amSessionUuid === session.sessionUuid && current.threadId === threadId
            && current.endpointId === endpointId && current.cwd === cwd
            && (expectedRevision === 0 || expectedRevision === current.revision)) {
          fd = io.openSync(path.dirname(this.file), 'r');
          io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
          return current;
        }
        throw fail('binding-conflict');
      }
      // Reconcile leftovers before deciding there is a conflict.
      //
      // A record whose AM session no longer exists cannot be used — every read
      // path rejects it (contextForThread's identity check) — but it still owns
      // its (endpointId, threadId) key, so it blocks the thread from ever being
      // bound or imported again. That is #172 reappearing, and it is reachable
      // two ways that no amount of care in the delete route removes: a prune
      // that could not commit, and a crash between the session rename and the
      // bindings rename.
      //
      // So the next genuine bind clears them. Here, rather than on boot,
      // because here is where the session list is authoritative and already in
      // hand: an empty or half-loaded roster at startup would look like every
      // binding being an orphan. Only callers that can prove it pass the
      // predicate; without it nothing is pruned.
      let kept = records;
      if (sessionExists) {
        kept = records.filter((r) => r.amSessionId === session.id || sessionExists(r.amSessionId));
        for (const r of records) {
          if (!kept.includes(r)) console.warn(`[codex] dropping binding for deleted session ${r.amSessionId} (thread ${r.threadId})`);
        }
      }
      if (expectedRevision !== 0 || kept.some((r) => r.endpointId === endpointId && r.threadId === threadId)) throw fail('binding-conflict');
      const record = { amSessionId: session.id, amSessionUuid: session.sessionUuid, endpointId,
        threadId, cwd, revision: 1, boundAt: new Date().toISOString() };
      const next = validate([...kept, record]);
      tmp = `${this.file}.${randomUUID()}.tmp`;
      fd = io.openSync(tmp, 'wx', 0o600);
      io.writeFileSync(fd, JSON.stringify({ version: 1, bindings: next }, null, 2) + '\n');
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      io.renameSync(tmp, this.file); tmp = undefined;
      // No success before both the file and directory entry are durable. If the
      // directory sync fails, report uncertainty; retry observes the same tuple.
      fd = io.openSync(path.dirname(this.file), 'r');
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      return record;
    } catch (error) {
      if (error instanceof CodexBindingError) throw error;
      if (error.code === 'EEXIST' && lockFd === undefined) throw fail('bindings-busy');
      throw fail('bindings-write-failed');
    } finally {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      if (tmp) { try { io.unlinkSync(tmp); } catch {} }
      if (lockFd !== undefined) { io.closeSync(lockFd); io.unlinkSync(lock); }
    }
  }
  /**
   * Drop one session's binding, so its thread can be bound or imported again.
   * Returns the record that was removed, or null if there was nothing to remove
   * — a session that was never bound is not an error to prune.
   *
   * REFUSES WHILE THAT AM SESSION STILL EXISTS. An unbound Codex session
   * launches a standalone writer (see commandFor), and the thread this record
   * names is owned by the shared server, so dropping the record out from under
   * a live session is the one way this file can cause the harm it exists to
   * prevent. The caller therefore prunes only after the session is gone from
   * the store, and passes the predicate that proves it; it is re-checked under
   * the lock, after the read, because the caller's check raced the lock wait.
   *
   * Same durability as bind(): exclusive lock, temp file, fsync, rename, then
   * fsync of the directory entry.
   */
  remove({ sessionId, sessionExists }) {
    if (!validId(sessionId) || typeof sessionExists !== 'function') throw fail('binding-invalid');
    if (sessionExists(sessionId)) throw fail('binding-session-live');
    const io = this.io, lock = `${this.file}.lock`;
    let lockFd, tmp, fd;
    try {
      lockFd = io.openSync(lock, 'wx', 0o600);
      const records = this.read();
      const record = records.find((r) => r.amSessionId === sessionId);
      if (!record) return null;
      if (sessionExists(sessionId)) throw fail('binding-session-live');
      const next = validate(records.filter((r) => r.amSessionId !== sessionId));
      tmp = `${this.file}.${randomUUID()}.tmp`;
      fd = io.openSync(tmp, 'wx', 0o600);
      io.writeFileSync(fd, JSON.stringify({ version: 1, bindings: next }, null, 2) + '\n');
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      io.renameSync(tmp, this.file); tmp = undefined;
      fd = io.openSync(path.dirname(this.file), 'r');
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      return record;
    } catch (error) {
      if (error instanceof CodexBindingError) throw error;
      if (error.code === 'EEXIST' && lockFd === undefined) throw fail('bindings-busy');
      throw fail('bindings-write-failed');
    } finally {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      if (tmp) { try { io.unlinkSync(tmp); } catch {} }
      if (lockFd !== undefined) { io.closeSync(lockFd); io.unlinkSync(lock); }
    }
  }
}
