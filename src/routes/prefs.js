// Per-user UI preferences (card order, etc.). Cross-device when the DB is enabled
// (stored on users.prefs JSONB); falls back to a local JSON file in single-user /
// dev mode (no DATABASE_URL). Shallow-merges patches so callers send only what changed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isEnabled as dbEnabled, users as dbUsers } from '../../db.js';

const LOCAL_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.lrl-prefs.json');
function readLocal() { try { return existsSync(LOCAL_FILE) ? JSON.parse(readFileSync(LOCAL_FILE, 'utf8')) : {}; } catch { return {}; } }
function writeLocal(obj) { try { writeFileSync(LOCAL_FILE, JSON.stringify(obj)); } catch { /* best-effort */ } }

export function registerPrefsRoutes(app, ctx) {
  const { ALLOWED_EMAIL } = ctx;
  // Stable per-user target: the DB user id in prod, else the email (single-user/dev).
  const target = (req) => (dbEnabled() && req.session?.userId)
    ? { db: true, id: req.session.userId }
    : { db: false, id: (req.session?.userEmail || ALLOWED_EMAIL || 'owner').toLowerCase() };

  app.get('/api/prefs', async (req, res) => {
    try {
      const t = target(req);
      const prefs = t.db ? ((await dbUsers.getById(t.id))?.prefs || {}) : (readLocal()[t.id] || {});
      res.json({ prefs });
    } catch { res.json({ prefs: {} }); }
  });

  app.post('/api/prefs', async (req, res) => {
    try {
      const t = target(req);
      const patch = (req.body && req.body.prefs) || {};
      if (t.db) {
        const cur = (await dbUsers.getById(t.id))?.prefs || {};
        const merged = { ...cur, ...patch };
        await dbUsers.setPrefs(t.id, merged);
        return res.json({ ok: true, prefs: merged });
      }
      const all = readLocal();
      all[t.id] = { ...(all[t.id] || {}), ...patch };
      writeLocal(all);
      res.json({ ok: true, prefs: all[t.id] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
