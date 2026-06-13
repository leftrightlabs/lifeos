// Phase 0 — per-user storage foundation (multi-user build).
//
// DORMANT until DATABASE_URL is set: with no DATABASE_URL, initDb() is a no-op
// and the app behaves exactly as the single-user version. `pg` is imported
// dynamically so the app boots fine even when pg isn't installed locally.
import { randomUUID } from 'node:crypto';
import { encrypt, isConfigured as secretsConfigured } from './secrets.js';

let pool = null;     // pg Pool, or null when disabled
let enabled = false; // true only after a successful connect + schema ensure

export function isEnabled() { return enabled; }

export async function query(text, params) {
  if (!pool) throw new Error('database not enabled (DATABASE_URL not set)');
  return pool.query(text, params);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                            TEXT PRIMARY KEY,
  email                         TEXT UNIQUE NOT NULL,
  name                          TEXT,
  title                         TEXT,
  role                          TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'member'
  notion_user_id                TEXT,                             -- Notion person id (assignee filter)
  google_refresh_token          TEXT,                             -- encrypted (work Google account)
  google_refresh_token_personal TEXT,                             -- encrypted (owner only)
  slack_user_token              TEXT,                             -- encrypted (Phase 5)
  slack_channel                 TEXT,                             -- Phase 5
  theme                         TEXT DEFAULT 'indigo',
  timezone                      TEXT DEFAULT 'America/Chicago',
  weather_lat                   DOUBLE PRECISION,
  weather_lon                   DOUBLE PRECISION,
  personal_enabled              BOOLEAN NOT NULL DEFAULT FALSE,    -- only the owner gets personal mode
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at                 TIMESTAMPTZ
);
`;

async function ensureSchema() {
  await pool.query(SCHEMA);
}

// Seed the owner row from the existing env tokens so the live single-user setup
// keeps working once we flip to DB-backed auth in Phase 1. Idempotent: it never
// overwrites a token that's already stored (so app-captured tokens win).
async function seedOwner(seed) {
  if (!seed?.email) return;
  await pool.query(
    `INSERT INTO users (id, email, name, role, notion_user_id, timezone, weather_lat, weather_lon, personal_enabled)
     VALUES ($1, $2, $3, 'owner', $4, $5, $6, $7, TRUE)
     ON CONFLICT (email) DO UPDATE SET role = 'owner', personal_enabled = TRUE, updated_at = now()`,
    [randomUUID(), seed.email, seed.name || null, seed.notionUserId || null,
     seed.timezone || null, seed.weatherLat ?? null, seed.weatherLon ?? null],
  );
  if (seed.refreshTokenWork && secretsConfigured()) {
    await pool.query(
      `UPDATE users SET google_refresh_token = $2, updated_at = now()
       WHERE email = $1 AND google_refresh_token IS NULL`,
      [seed.email, encrypt(seed.refreshTokenWork)],
    );
  }
  if (seed.refreshTokenPersonal && secretsConfigured()) {
    await pool.query(
      `UPDATE users SET google_refresh_token_personal = $2, updated_at = now()
       WHERE email = $1 AND google_refresh_token_personal IS NULL`,
      [seed.email, encrypt(seed.refreshTokenPersonal)],
    );
  }
}

// Bring up the store. Returns true if enabled, false if dormant. Never throws
// to the caller for an unreachable DB — logs and leaves the app in single-user
// mode so serving is never blocked.
export async function initDb(ownerSeed) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('[db] DATABASE_URL not set — multi-user storage dormant (single-user mode)');
    return false;
  }
  const { default: pg } = await import('pg');
  const noSsl = /localhost|127\.0\.0\.1|railway\.internal/.test(url);
  pool = new pg.Pool({
    connectionString: url,
    ssl: noSsl ? false : { rejectUnauthorized: false },
    max: 5,
  });
  // Railway's private network can take a few seconds to come up at boot, so the
  // first connect may time out — retry with backoff before giving up.
  const attempts = 6;
  for (let i = 1; i <= attempts; i++) {
    try {
      await ensureSchema();
      break;
    } catch (e) {
      if (i === attempts) { pool = null; throw e; } // surfaced to caller's .catch — stays single-user
      console.warn(`[db] connect attempt ${i}/${attempts} failed (${e.code || e.message}); retrying in ${i * 2}s`);
      await new Promise((r) => setTimeout(r, i * 2000));
    }
  }
  enabled = true;
  if (!secretsConfigured()) {
    console.warn('[db] ENCRYPTION_KEY not set/invalid — refresh tokens will NOT be stored. ' +
      'Set ENCRYPTION_KEY to a base64 32-byte value, then redeploy.');
  }
  try {
    await seedOwner(ownerSeed);
  } catch (e) {
    console.error('[db] owner seed failed:', e.message);
  }
  console.log('[db] connected — multi-user storage enabled');
  return true;
}

// ── User accessors (used by Phase 1/2) ─────────────────────────────────────
export const users = {
  async getByEmail(email) {
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] || null;
  },
  async getById(id) {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  },
  // Create on first login, or refresh name + last_login on return.
  async upsertByEmail({ email, name }) {
    const { rows } = await query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
         SET name = COALESCE(EXCLUDED.name, users.name),
             last_login_at = now(),
             updated_at = now()
       RETURNING *`,
      [randomUUID(), email, name || null],
    );
    return rows[0];
  },
  async setGoogleToken(id, account, encToken) {
    const col = account === 'personal' ? 'google_refresh_token_personal' : 'google_refresh_token';
    await query(`UPDATE users SET ${col} = $2, updated_at = now() WHERE id = $1`, [id, encToken]);
  },
  async setNotionUserId(id, notionId) {
    await query('UPDATE users SET notion_user_id = $2, updated_at = now() WHERE id = $1', [id, notionId]);
  },
};
