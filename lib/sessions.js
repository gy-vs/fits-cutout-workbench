// In-memory, session-only storage. Nothing is written to disk; sessions are
// released explicitly on replace/unload and evicted after an idle timeout.
import { randomUUID } from 'node:crypto';
import { buildOverview } from './pixels.js';
import { buildGraticule, clipGraticule } from './grid.js';
import { fail } from './errors.js';

const IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 8;

export class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.timer = setInterval(() => this.sweep(), 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  create({ name, buffer, image }) {
    if (this.sessions.size >= MAX_SESSIONS) {
      // Evict least recently used.
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (oldest) this.release(oldest.id);
    }
    const id = randomUUID();
    const session = {
      id, name, buffer, image,
      createdAt: Date.now(), lastUsed: Date.now(),
      latestCutoutSeq: 0,
      jobs: new Map(),
      _overview: null,
      _grid: null
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw fail('SESSION_NOT_FOUND', `找不到会话 ${id}（可能已随文件替换或页面关闭而释放）`);
    s.lastUsed = Date.now();
    return s;
  }

  overview(id) {
    const s = this.get(id);
    if (!s._overview) s._overview = buildOverview(s.image);
    return s._overview;
  }

  grid(id) {
    const s = this.get(id);
    if (!s._grid) {
      const g = buildGraticule(s.image);
      s._grid = {
        raLines: clipGraticule(g.raLines, s.image.width, s.image.height),
        decLines: clipGraticule(g.decLines, s.image.width, s.image.height),
        bounds: g.bounds, steps: g.steps
      };
    }
    return s._grid;
  }

  putJob(id, job) {
    const s = this.get(id);
    const jobId = randomUUID();
    s.jobs.set(jobId, { ...job, createdAt: Date.now() });
    // Keep only the newest few jobs per session.
    if (s.jobs.size > 5) {
      const firstKey = s.jobs.keys().next().value;
      s.jobs.delete(firstKey);
    }
    return jobId;
  }

  getJob(id, jobId) {
    const s = this.get(id);
    const job = s.jobs.get(jobId);
    if (!job) throw fail('SESSION_NOT_FOUND', '该切片结果已过期，请重新框选区域');
    return job;
  }

  release(id) {
    const s = this.sessions.get(id);
    if (s) {
      // Explicitly drop references so buffers can be collected promptly.
      s.buffer = null; s.image = null; s._overview = null; s._grid = null;
      s.jobs.clear();
      this.sessions.delete(id);
      return true;
    }
    return false;
  }

  sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastUsed > IDLE_TTL_MS) this.release(id);
    }
  }

  close() {
    clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) this.release(id);
  }
}
