/**
 * In-memory session store. Uploaded bytes live only in this Map for the
 * duration of one local working session: replacing the file bumps a
 * generation (so stale responses can never overwrite the new image) and
 * frees the previous buffer; idle sessions are swept periodically.
 */

import { parseFits, FitsError } from './fits.js';
import { buildWcs } from './wcs.js';
import { buildOverview } from './render.js';

const IDLE_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 8;

class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  create(id, buffer) {
    let image;
    try {
      image = parseFits(buffer);
    } catch (e) {
      throw e;
    }
    const wcs = buildWcs(image.header);
    const overview = buildOverview(image, 320);

    // Enforce a small LRU bound on retained sessions.
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      this.delete(oldest);
    }
    const session = {
      id,
      generation: 1,
      image,
      wcs,
      overview,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    const s = this.sessions.get(id);
    if (s) s.lastUsed = Date.now();
    return s;
  }

  /** Get a session only if the generation matches (stale-response guard). */
  getWithGeneration(id, gen) {
    const s = this.get(id);
    if (!s) return null;
    if (Number.isInteger(gen) && gen !== s.generation) {
      return { stale: true };
    }
    return s;
  }

  replace(id, buffer) {
    const old = this.sessions.get(id);
    this.delete(id);
    const s = this.create(id, buffer);
    if (old) s.generation = old.generation + 1;
    return s;
  }

  delete(id) {
    return this.sessions.delete(id);
  }

  sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastUsed > IDLE_TTL_MS) this.sessions.delete(id);
    }
  }

  get size() {
    return this.sessions.size;
  }
}

export { SessionStore, FitsError };
