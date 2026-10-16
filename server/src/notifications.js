import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError, invalid } from './api-errors.js';

const copy = (value) => structuredClone(value);
const required = (value, field, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw invalid(field, `must be nonempty text of at most ${max} characters without control characters`);
  }
  return value;
};

// Manager-owned inbox. A 202 means durable receipt, never that a turn ran or
// that the agent read the event. Terminal delivery is at least once across the
// crash between sendInput and persisting accepted; consumers ACK stable IDs.
export class NotificationInbox {
  constructor({ file, getSession, state, deliver, now = Date.now, settleMs = 15_000, retryMs = 5_000 }) {
    Object.assign(this, { file, getSession, state, deliver, now, settleMs, retryMs });
    this.rows = [];
    this.writes = Promise.resolve();
    this.active = new Set();
    this.idleSince = new Map();
    this.unavailable = false;
  }
  async init() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.notifications)) throw new Error('invalid notification inbox');
      this.rows = saved.notifications;
    } catch (error) {
      if (error.code !== 'ENOENT') { this.unavailable = true; return; } // preserve backlog; isolate this feature
    }
    if (this.rows.some(row => row.status === 'delivering')) {
      await this.change(rows => {
        for (const row of rows) if (row.status === 'delivering') {
          row.status = 'pending'; row.retryAt = 0; row.lastError = 'interrupted-delivery';
        }
      }).catch(() => { this.unavailable = true; });
    }
  }
  change(update) {
    const work = this.writes.then(async () => {
      if (this.unavailable) throw new ApiError(503, 'notification-storage-unavailable', 'Notification storage is unavailable. Retain and retry the event.');
      const rows = copy(this.rows);
      const result = update(rows);
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, notifications: rows })); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temp, this.file);
      } finally { await fs.unlink(temp).catch(() => {}); }
      this.rows = rows;
      return copy(result);
    });
    this.writes = work.catch(() => {});
    return work;
  }
  async enqueue(agentId, input) {
    const source = required(input?.source, 'source', 120);
    const eventId = required(input?.eventId, 'eventId', 256);
    if (typeof input?.text !== 'string' || !input.text.trim() || input.text.length > 40_000) throw invalid('text', 'must contain 1 to 40000 characters');
    const textHash = createHash('sha256').update(input.text).digest('hex');
    return this.change(rows => {
      const old = rows.find(row => row.agentId === agentId && row.source === source && row.eventId === eventId);
      if (old) {
        if ((old.textHash || createHash('sha256').update(old.text).digest('hex')) !== textHash) throw new ApiError(409, 'notification-conflict', 'This event ID already has different content.');
        return { notification: old, repeated: true };
      }
      if (rows.filter(row => row.status !== 'acknowledged').length >= 10_000) throw new ApiError(429, 'notification-capacity', 'The notification inbox is full; retain and retry the event.');
      const row = { id: randomUUID(), agentId, source, eventId, text: input.text, textHash, status: 'pending',
        receivedAt: new Date(this.now()).toISOString(), attempts: 0, retryAt: 0 };
      rows.push(row);
      return { notification: row, repeated: false };
    });
  }
  list(agentId) { return copy(this.rows.filter(row => row.agentId === agentId)); }
  async acknowledge(agentId, id) {
    return this.change(rows => {
      const row = rows.find(row => row.agentId === agentId && row.id === id);
      if (!row) throw new ApiError(404, 'not-found', 'Notification not found.');
      if (!['delivering', 'accepted', 'acknowledged'].includes(row.status)) throw new ApiError(409, 'notification-not-delivered', 'The notification has not been delivered yet.');
      row.status = 'acknowledged';
      row.acknowledgedAt ||= new Date(this.now()).toISOString();
      row.textHash ||= createHash('sha256').update(row.text).digest('hex');
      delete row.text; // retain compact identity/hash receipts for dedupe, not event bodies
      return row;
    });
  }
  async tick() {
    if (this.unavailable) return;
    const ids = [...new Set(this.rows.filter(row => row.status === 'pending').map(row => row.agentId))];
    await Promise.all(ids.map(id => this.dispatch(id)));
  }
  async dispatch(agentId) {
    if (this.active.has(agentId)) return;
    this.active.add(agentId);
    try {
      let session = this.getSession(agentId);
      if (!session || session.archivedAt) { this.idleSince.delete(agentId); return; }
      const state = await this.state(session);
      // Unknown, stopped and approval prompts do not authorize unattended input.
      if (state !== 'waiting') { this.idleSince.delete(agentId); return; }
      if (!this.idleSince.has(agentId)) this.idleSince.set(agentId, this.now());
      if (this.now() - this.idleSince.get(agentId) < this.settleMs) return;
      const next = this.rows.find(row => row.agentId === agentId && row.status === 'pending' && row.retryAt <= this.now());
      if (!next) return;
      await this.change(rows => {
        const row = rows.find(row => row.id === next.id);
        row.status = 'delivering'; row.attempts++; row.lastAttemptAt = new Date(this.now()).toISOString();
      });
      try {
        // Check again after disk I/O; the operator may have started a turn.
        if (await this.state(session) !== 'waiting') throw new ApiError(409, 'notification-busy', 'The agent became busy.');
        session = this.getSession(agentId);
        if (!session || session.archivedAt) throw new ApiError(409, 'notification-target-unavailable', 'The target is no longer available.');
        await this.deliver(session, next);
        await this.change(rows => {
          const row = rows.find(row => row.id === next.id);
          if (row.status !== 'acknowledged') { row.status = 'accepted'; }
          row.acceptedAt = new Date(this.now()).toISOString(); row.lastError = null;
        });
      } catch (error) {
        await this.change(rows => {
          const row = rows.find(row => row.id === next.id);
          if (row.status === 'acknowledged') return;
          row.status = 'pending';
          row.lastError = error instanceof ApiError ? error.code : 'delivery-failed';
          row.retryAt = this.now() + Math.min(60_000, this.retryMs * 2 ** Math.min(row.attempts - 1, 4));
        });
      }
      // Prevent a burst while the just-prompted CLI has not updated its trace.
      this.idleSince.delete(agentId);
    } finally { this.active.delete(agentId); }
  }
  start({ intervalMs = 2_000 } = {}) {
    this.timer = setInterval(() => this.tick().catch(error => console.error('[notifications]', error.code || 'dispatch-failed')), intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); }
}

// Registered through the same admission, audit, privacy, JSON and error
// adapters as other agent APIs. Self-registration is explicit, not a peer
// prompt, and never invents a sender identity.
export function notificationRoutes(api, { inbox, getSession, promptable }) {
  const target = req => {
    const session = getSession(req.params.id);
    if (!session) throw new ApiError(404, 'not-found', 'Agent not found.');
    if (!promptable(session)) throw new ApiError(400, 'invalid-input', 'This pane takes no notifications.');
    return session;
  };
  const authorize = req => {
    const session = target(req);
    const origin = req.operationOrigin?.id;
    if (origin !== session.id && origin !== 'operator') throw new ApiError(403, 'notification-origin', 'Only the target agent or operator can register or acknowledge its notifications.');
    return session;
  };
  api.get('/api/agents/:id/notifications', (req, res) => {
    target(req);
    res.set('Cache-Control', 'no-store').status(inbox.unavailable ? 503 : 200).json({ available: !inbox.unavailable,
      ...(inbox.unavailable ? { code: 'notification-storage-unavailable', error: 'Notification storage is unavailable.' } : {}),
      notifications: inbox.list(req.params.id) });
  });
  api.post('/api/agents/:id/notifications', async (req, res) => {
    const session = authorize(req);
    const result = await inbox.enqueue(session.id, req.body);
    res.status(202).json({ ok: true, ...result });
  });
  api.post('/api/agents/:id/notifications/:notificationId/ack', async (req, res) => {
    const session = authorize(req);
    res.json({ ok: true, notification: await inbox.acknowledge(session.id, req.params.notificationId) });
  });
}

// Native state for shared Codex and task lifecycle for legacy Codex are stronger
// evidence than a static terminal screen while a tool or goal is running.
export function notificationReadiness({ locked, info, runtime, running, digest, derive }) {
  return async session => {
    if (locked()) return 'unknown';
    const activity = info(session.id);
    if (activity?.inputRequired) return 'input-required';
    if (runtime.shared(session)) {
      const status = await runtime.refresh(session);
      return status?.status === 'idle' ? 'waiting' : 'working';
    }
    if (!running(session.id)) return 'stopped';
    if (session.cli === 'codex' && (await digest(session))?.activity !== 'waiting') return 'working';
    return derive(session, activity);
  };
}
