import express from 'express';
import cookieSession from 'cookie-session';
import { Client } from '@notionhq/client';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { initDb, isEnabled as dbEnabled, users as dbUsers, secrets as dbSecrets } from './db.js';
import { decrypt, encrypt, isConfigured as secretsConfigured } from './secrets.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerConvertRoutes } from './src/routes/convert.js';
import { serializeDeal, serializeContactRow, queryAllDeals, fetchSalesProductMap } from './src/providers/notion/convert.js';
import { CONTACTS_DS, PULSE_RELATIONSHIPS } from './src/config/convert.js';
import { registerAttractRoutes } from './src/routes/attract.js';
import { registerWealthRoutes } from './src/routes/wealth.js';
import { registerScaleRoutes } from './src/routes/scale.js';
import { registerMessagesRoutes } from './src/routes/messages.js';
import { registerReferenceRoutes } from './src/routes/reference.js';
import { registerLegoRoutes } from './src/routes/lego.js';
import { registerDeliverRoutes } from './src/routes/deliver.js';

if (process.env.NODE_ENV !== 'production') {
  const { default: dotenv } = await import('dotenv');
  dotenv.config();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const GRETCHEN_USER_ID = 'cfe628e1-e7b8-4aed-8151-009b8bee5c9d';
const ALLOWED_EMAIL = 'gretchen@leftrightlabs.com';
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'leftrightlabs.com').toLowerCase();
// Owner is always allowed. Once the multi-user store is live, anyone on the
// allowed domain may sign in; with the store dormant we stay single-user (owner only).
function isAllowedEmail(email) {
  const e = String(email || '').toLowerCase();
  if (!e) return false;
  if (e === ALLOWED_EMAIL) return true;
  return dbEnabled() && e.endsWith('@' + ALLOWED_DOMAIN);
}
const WORK_TASKS_DS = '28c458f08cd9818599e7000bc2115872';
const LIFE_TASKS_DS = '265458f08cd981699efe000b4de14ca4';
// Follow-up sources beyond the two task DBs (deals + sales touchpoints). All
// four DBs share the "Follow Up" checkbox + "Follow Up By" date properties, so
// the toggle endpoint is DB-agnostic.
const SALES_PIPELINE_DS = 'cec1b3e9-791d-4a55-bd80-b0226552f543';
// CONTACTS_DS is imported from ./src/config/convert.js above.
const SPEAKING_OUTREACH_DS = '96f47e7e-9797-4d96-9abb-e5dcb7df13a3'; // SPEAKING OUTREACH [DB]
const WORK_PROJECTS_DS = '28c458f08cd98131a475000b81db3c1b';
const LIFE_PROJECTS_DS = '265458f08cd9814eaf0e000bceaa7f80';
const PROJECT_AREA_DS = 'd5b03c5c-9322-4345-91ea-f5731bf6d141';   // work AREA relation target
const PROJECT_SYSTEM_DS = 'af61f960-9aa0-46ce-996f-74090f39635f'; // work SYSTEM relation target
const PERSONAL_AREA_DS = '25a458f0-8cd9-8168-873c-000bc5960b8f';  // personal Area relation target
const PERSONAL_HUBS_DS = '265458f0-8cd9-819f-b45b-000b7b361a6b';  // personal HUBS relation target
const JOURNAL_DS = '25a458f08cd9804bb6d1000b78cb4186';
const JOURNAL_DB_ID = '25a458f08cd980f9991af90b30ec68d8';
const CACHE_TTL_MS = 60_000;
const TZ = 'America/Chicago';
const WEATHER_LAT = 32.837;  // Euless, TX
const WEATHER_LON = -97.082;
const DATA_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.metadata.readonly', // Reference zone — Drive file search (re-auth Google after deploy)
];
const LOGIN_SCOPES = ['openid', 'email', 'profile'];

const ACCOUNT_ENVS = {
  work: 'GOOGLE_REFRESH_TOKEN',
  personal: 'GOOGLE_REFRESH_TOKEN_PERSONAL',
};
const ACCOUNTS = ['work', 'personal'];

app.set('trust proxy', 1);
app.use(express.json());

app.use(cookieSession({
  name: 'lifeos.sid',
  keys: [process.env.SESSION_SECRET || 'lifeos-dev-secret-please-set-in-prod'],
  maxAge: 1000 * 60 * 60 * 24 * 60,
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
}));
// Touch session on every request so the 30-day window rolls forward from last use.
app.use((req, _res, next) => {
  if (req.session) req.session.t = Date.now();
  next();
});

const notion = process.env.NOTION_TOKEN
  ? new Client({ auth: process.env.NOTION_TOKEN })
  : null;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Per-request user context (set by middleware) so authedClient() and Notion
// scoping resolve to the signed-in user without threading through every call.
const userContext = new AsyncLocalStorage();
function currentUser() { return userContext.getStore()?.user || null; }
function currentNotionUserId() {
  const u = currentUser();
  if (!u) return GRETCHEN_USER_ID;   // no request context (e.g. background) → owner
  return u.notion_user_id || null;    // member without a resolved Notion id → none
}

// Resolve a user's Notion person id by matching their email to a workspace user.
let _notionUsersCache = null;
async function resolveNotionUserId(email) {
  if (!notion || !email) return null;
  try {
    if (!_notionUsersCache) {
      const out = []; let cursor;
      do {
        const r = await notion.users.list({ start_cursor: cursor, page_size: 100 });
        out.push(...r.results);
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      _notionUsersCache = out;
    }
    const e = String(email).toLowerCase();
    return _notionUsersCache.find((u) => u.type === 'person' && (u.person?.email || '').toLowerCase() === e)?.id || null;
  } catch (err) { console.error('[notion] user resolve failed:', err.message); return null; }
}

const cache = new Map();
const CACHE_TTL_OVERRIDES = {
  'attract-page': 15 * 60_000, // Attract page payload (Notion-derived): refresh every 15m
  'convert-page': 15 * 60_000, // Convert page payload (Notion + Xero): refresh every 15m
  'attract-next-focus': 6 * 60 * 60_000, // AI "what to focus on next" (healthy state): 6h
  'attract-insights': 6 * 60 * 60_000, // GA4 + AI analysis: refresh every 6h
  'ynab-networth': 60 * 60_000, // YNAB net worth: refresh hourly
  'ynab-wealth': 60 * 60_000, // YNAB wealth summary: refresh hourly
  'deliver-offers': 30 * 60_000, // Offer catalog: refresh every 30m
  'deliver-renewals': 30 * 60_000, // Care-plan renewals: refresh every 30m
  'deliver-page': 5 * 60_000, // Deliver dashboard (production projects + tasks): 5m
  'journal-rings': 5 * 60_000, // heavier query (per-row body-text check); cache longer
  'vto-goals': 10 * 60_000,    // goals rarely change
  'scale-systems': 10 * 60_000, // Business Functions change slowly (weekly review)
  'scale-scorecard': 5 * 60_000, // VTO targets + live actuals; refresh every 5m
  'active-projects': 5 * 60_000, // project status changes slowly
  'projects-list': 5 * 60_000,   // /today's slowest call (full project list) — keep warm
  'goals': 5 * 60_000,           // Q2 rocks change rarely; keeps /today's core warm
  'sales-pipeline': 5 * 60_000,  // deals move slowly within a session
  'calendar-today': 3 * 60_000,  // today's events; a few minutes stale is fine
  'projects-board': 5 * 60_000,  // Projects tab board (area/system maps + paginated projects)
  'weather': 20 * 60_000,        // current conditions change slowly
  'lego-summary': 10 * 60_000,   // LEGO collection/build rollups change slowly
  'needle-prod-projects': 30 * 60_000, // which projects are in the Production area changes slowly
};
async function cached(key, fn) {
  // Namespace per signed-in user so one person's cached data is never served to
  // another. Keys with no user context (background tasks) stay global.
  const u = userContext.getStore()?.user;
  const nsKey = u ? `${key}::${u.id || u.email}` : key;
  const ttl = CACHE_TTL_OVERRIDES[key] || CACHE_TTL_MS;
  const hit = cache.get(nsKey);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const value = await fn();
  cache.set(nsKey, { v: value, t: Date.now() });
  return value;
}

// Drop all cache entries for one user (used after they connect an account).
function clearUserCache(userKey) {
  if (!userKey) return;
  for (const key of [...cache.keys()]) if (key.endsWith('::' + userKey)) cache.delete(key);
}

// Invalidate a cached() base key across all per-user namespaced variants. cached()
// stores under `${key}::${userKey}`, so deleting the bare key alone is a no-op for
// signed-in requests — this clears the bare key and every `key::*` variant.
function clearCached(base) {
  for (const k of [...cache.keys()]) if (k === base || k.startsWith(base + '::')) cache.delete(k);
}

function originFromReq(req) {
  if (req) return `${req.protocol}://${req.get('host')}`;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${PORT}`;
}

function makeOAuthClient(req, callbackPath = '/auth/google/callback') {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${originFromReq(req)}${callbackPath}`,
  );
}

// Page through all results for a single flat filter — the Datasources API only
// reliably supports one level of compound nesting (and-of-properties or or-of-
// properties), so callers that need (A AND B) OR (C AND D) should make two
// separate calls and merge, rather than trying to nest and-inside-or.
async function pageThroughDS(dataSourceId, filter, sorts = [{ property: 'Due', direction: 'ascending' }]) {
  const results = [];
  let cursor;
  do {
    const r = await notion.dataSources.query({
      data_source_id: dataSourceId,
      filter,
      ...(sorts ? { sorts } : {}),
      page_size: 100,
      start_cursor: cursor,
    });
    results.push(...(r.results || []));
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return results;
}

async function queryTasks(dataSourceId, { peopleProp, myDayOnly } = {}) {
  const nid = peopleProp ? (currentNotionUserId() || '00000000-0000-0000-0000-000000000000') : null;
  const personCond = peopleProp ? [{ property: peopleProp, people: { contains: nid } }] : [];

  if (myDayOnly) {
    // Datasources API doesn't support and-inside-or, so run two flat queries in
    // parallel and merge: (1) active My Day tasks, (2) anything completed today.
    // Case (2) catches tasks where Notion unchecked My Day on completion.
    //
    // "Completed today" is timezone-sensitive: Notion stores Completed as a
    // datetime, so a task finished at 10pm Chicago is 03:00Z the NEXT UTC day.
    // A naive `date.equals(chicagoToday)` misses it. Instead we narrow generously
    // (anything since ~yesterday) in Notion, then do the exact Chicago-day match
    // in JS — handling both date-only values (written by our PATCH) and full
    // datetimes (written by Notion automations / manual completion).
    const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
    const today = fmt(new Date());
    const since = fmt(new Date(Date.now() - 36 * 3600 * 1000)); // ~yesterday, DST-safe
    const [active, recent] = await Promise.all([
      pageThroughDS(dataSourceId, { and: [
        { property: 'My Day', checkbox: { equals: true } },
        { property: 'Status', status: { does_not_equal: 'Done' } },
        ...personCond,
      ]}),
      pageThroughDS(dataSourceId, { and: [
        { property: 'Completed', date: { on_or_after: since } },
        ...personCond,
      ]}),
    ]);
    const done = recent.filter((p) => {
      const c = p.properties?.Completed?.date?.start;
      if (!c) return false;
      // Date-only values (length 10, 'YYYY-MM-DD') are already a calendar day;
      // datetimes get converted to the Chicago calendar day before comparing.
      const day = c.length === 10 ? c : fmt(new Date(c));
      return day === today;
    });
    // Deduplicate (a task on My Day completed today appears in both sets).
    const seen = new Set();
    const merged = [];
    for (const r of [...active, ...done]) {
      if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
    }
    return { results: merged };
  }

  // Non-myDay: single query, exclude all done tasks.
  const results = await pageThroughDS(dataSourceId, { and: [
    { property: 'Status', status: { does_not_equal: 'Done' } },
    ...personCond,
  ]});
  return { results };
}

function simplifyTask(page, source) {
  const props = page.properties || {};
  const due = props.Due?.date || {};
  const assignees = (props.Assigned?.people || []).map((u) => u.id);
  const following = (props.Following?.people || []).map((u) => u.id);
  return {
    id: page.id,
    name: props.Name?.title?.[0]?.plain_text || '(untitled)',
    source,
    status: props.Status?.status?.name || null,
    dueStart: due.start || null,
    dueEnd: due.end || null,
    edited: page.last_edited_time || null,
    myDay: !!props['My Day']?.checkbox,
    // A task recurs if the "Recurring?" checkbox is on OR it has a recur
    // interval configured. Many tasks (especially personal/LifeOS ones) drive
    // recurrence purely off Recur Unit/Interval with the checkbox left unchecked,
    // so the checkbox alone misses them.
    recurring: !!props['Recurring?']?.checkbox || (props['Recur Interval']?.number || 0) > 0,
    recurUnit: props['Recur Unit']?.select?.name || null,
    recurInterval: props['Recur Interval']?.number || null,
    estHours: props['Est Hours']?.number ?? null,
    priority: props.Priority?.select?.name || null,
    followUp: !!props['Follow Up']?.checkbox,   // "on my Today list" flag
    followUpBy: props['Follow Up By']?.date?.start || null,
    followUpOwnerId: (props['Follow Up Owner']?.people || [])[0]?.id || null,
    followUpOwnerName: (props['Follow Up Owner']?.people || [])[0]?.name || null,
    project: null,
    projectId: (props.Project?.relation || [])[0]?.id || null,
    assigneeIds: assignees,
    assigneeNames: (props.Assigned?.people || []).map((u) => u.name).filter(Boolean),
    assignedToMe: source === 'personal' ? (currentNotionUserId() === GRETCHEN_USER_ID) : assignees.includes(currentNotionUserId()),
    followingIds: following,
    followingNames: (props.Following?.people || []).map((u) => u.name).filter(Boolean),
    followingMe: following.includes(currentNotionUserId()),
    url: page.url,
  };
}

async function workTasks({ myDayOnly, allAssignees }) {
  const data = await queryTasks(WORK_TASKS_DS, {
    peopleProp: allAssignees ? undefined : 'Assigned',
    myDayOnly,
  });
  return data.results.map((p) => simplifyTask(p, 'work'));
}
async function lifeTasks({ myDayOnly }) {
  const data = await queryTasks(LIFE_TASKS_DS, { myDayOnly });
  return data.results.map((p) => simplifyTask(p, 'personal'));
}

function chicagoTodayRange() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
  const probe = new Date(`${date}T12:00:00Z`);
  const chiHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, hour: '2-digit' }).format(probe),
    10,
  );
  const offsetHrs = 12 - chiHour;
  const offset = `-${String(offsetHrs).padStart(2, '0')}:00`;
  return {
    start: `${date}T00:00:00${offset}`,
    end: `${date}T23:59:59${offset}`,
    date,
  };
}

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name],
    );
}

function parseFromHeader(value) {
  if (!value) return { name: '', email: '' };
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: '', email: value.trim() };
}

function findMimePart(payload, mimeType) {
  if (!payload) return null;
  // Match a part by mime type whether its body is inline (`data`) or delivered
  // as a separate attachment (`attachmentId`) — large HTML bodies (e.g. rich
  // newsletters) come through as attachments, not inline.
  if (payload.mimeType === mimeType && (payload.body?.data || payload.body?.attachmentId)) return payload;
  for (const part of payload.parts || []) {
    const found = findMimePart(part, mimeType);
    if (found) return found;
  }
  return null;
}

// Resolve a MIME part's decoded body — inline `data` if present, otherwise fetch
// the referenced attachment (Gmail offloads large part bodies to attachments).
async function resolveMimePartBody(gmail, messageId, part) {
  if (!part?.body) return null;
  if (part.body.data) return base64UrlDecode(part.body.data);
  if (part.body.attachmentId) {
    try {
      const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: part.body.attachmentId });
      if (att.data?.data) return base64UrlDecode(att.data.data);
    } catch (e) { console.error('attachment body fetch failed:', e.message); }
  }
  return null;
}

function base64UrlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function authedClient(account = 'work') {
  const u = currentUser();
  let token = null;
  if (u) {
    const enc = account === 'personal' ? u.google_refresh_token_personal : u.google_refresh_token;
    if (enc) { try { token = decrypt(enc); } catch (e) { token = null; } }
  }
  // Owner / single-user / no-context fallback to env tokens. A member without a
  // stored token gets NO client (empty data) — never the owner's mailbox.
  if (!token && (!u || u.role === 'owner')) {
    token = process.env[ACCOUNT_ENVS[account]] || null;
  }
  if (!token) return null;
  const oauth = makeOAuthClient();
  oauth.setCredentials({ refresh_token: token });
  return oauth;
}

function configuredAccounts() {
  return ACCOUNTS.filter((a) => !!process.env[ACCOUNT_ENVS[a]]);
}

// Persisted Slack user token (owner / single-user). Written by the OAuth callback
// so re-authorizing with new scopes takes effect immediately — no manual env paste.
// Disk survives within a Railway deploy; the env var is the cross-deploy fallback.
const SLACK_STATE_FILE = process.env.SLACK_STATE_FILE || join(process.cwd(), 'data', 'slack-state.json');
function loadSlackFileToken() {
  try { if (existsSync(SLACK_STATE_FILE)) { const s = JSON.parse(readFileSync(SLACK_STATE_FILE, 'utf8')); if (s?.user_token) return s.user_token; } }
  catch (e) { console.warn('[slack] load state failed:', e.message); }
  return null;
}
function saveSlackFileToken(tok) {
  try { const dir = dirname(SLACK_STATE_FILE); if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); writeFileSync(SLACK_STATE_FILE, JSON.stringify({ user_token: tok, savedAt: new Date().toISOString() }, null, 2)); }
  catch (e) { console.warn('[slack] save state failed:', e.message); }
}

// Resolve the Slack user token to post as. The signed-in user's own connected
// token wins; the owner (and single-user / background) falls back to the most
// recently authorized token on disk, then the env token. A member who hasn't
// connected Slack gets none — never the owner's, so a check-in is never posted
// under someone else's identity.
function currentSlackToken() {
  const u = currentUser();
  if (u && u.slack_user_token) {
    try { return decrypt(u.slack_user_token); } catch (e) { /* fall through */ }
  }
  if (!u || u.role === 'owner') return loadSlackFileToken() || process.env.SLACK_USER_TOKEN || null;
  return null;
}

// Dev-only: auto-authenticate so localhost preview doesn't need Google sign-in.
// Guard against Railway deployments where NODE_ENV may not be set to 'production'.
const IS_RAILWAY = !!(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME);
if (!IS_PROD && !IS_RAILWAY) {
  app.use((req, _res, next) => {
    if (!req.session.userEmail) {
      req.session.userEmail = ALLOWED_EMAIL;
      req.session.userName = 'Gretchen (dev)';
    }
    next();
  });
}

// ----- PUBLIC ROUTES (before requireAuth) -----

const PUBLIC_FILES = new Set([
  '/favicon.svg',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest',
]);
const staticOpts = {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    } else if (/\.(png|svg|ico|webmanifest)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
};
const publicStatic = express.static(join(__dirname, 'public'), staticOpts);
app.use((req, res, next) => {
  if (PUBLIC_FILES.has(req.path)) return publicStatic(req, res, next);
  next();
});

// Public health check — reports whether the multi-user store is connected.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: dbEnabled() });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), version: 'day-6' });
});

app.get('/login', (req, res) => {
  if (req.session?.userEmail === ALLOWED_EMAIL) return res.redirect('/');
  const errMsg = req.query.error === 'denied'
    ? '<p style="color:#ff6b6b;margin-top:1rem;font-size:0.85rem">Access denied. This LRL OS is private.</p>'
    : '';
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>LRL OS — Sign in</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
<meta name="theme-color" content="#0a0f1e"/>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Montserrat:wght@400;500&display=swap" rel="stylesheet"/>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;background:#0a0f1e;color:#f5f5f7;font-family:'Montserrat',sans-serif}
  body{display:flex;align-items:center;justify-content:center;padding:1.5rem}
  .card{text-align:center;max-width:380px}
  h1{font-family:'Playfair Display',Georgia,serif;font-size:clamp(3rem,9vw,5.5rem);font-weight:700;transform:scaleY(1.2);transform-origin:top left;display:inline-block;line-height:1}
  .sub{margin-top:1.25rem;font-size:0.7rem;color:#a7c140;letter-spacing:0.35em;text-transform:uppercase}
  .signin{margin-top:2.5rem;display:inline-flex;align-items:center;gap:0.7rem;padding:0.85rem 1.5rem;background:#a7c140;color:#0a0f1e;border:none;border-radius:999px;font-family:'Montserrat',sans-serif;font-weight:600;font-size:0.85rem;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;cursor:pointer;transition:all 0.15s}
  .signin:hover{background:#c5dc78}
  .signin svg{width:16px;height:16px}
</style>
</head><body>
  <div class="card">
    <h1>LRL OS</h1>
    <div class="sub">Private command center</div>
    <a class="signin" href="/auth/login">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.35 11.1H12v3.2h5.35c-.5 2.4-2.55 4.1-5.35 4.1a6 6 0 1 1 0-12c1.5 0 2.85.55 3.9 1.45l2.4-2.4A9.4 9.4 0 0 0 12 2.4 9.6 9.6 0 1 0 21.35 14a8.7 8.7 0 0 0 0-2.9z"/></svg>
      Sign in with Google
    </a>
    ${errMsg}
  </div>
</body></html>`);
});

app.get('/auth/login', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
  }
  const oauth = makeOAuthClient(req, '/auth/login/callback');
  const url = oauth.generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: LOGIN_SCOPES,
  });
  res.redirect(url);
});

app.get('/auth/login/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');
    const oauth = makeOAuthClient(req, '/auth/login/callback');
    const { tokens } = await oauth.getToken(code);
    oauth.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth });
    const { data } = await oauth2.userinfo.get();
    const email = (data.email || '').toLowerCase();
    if (!isAllowedEmail(email)) {
      return res.redirect('/login?error=denied');
    }
    req.session.userEmail = email;
    req.session.userName = data.name || email;
    // Multi-user: create/refresh the user row and remember the id for scoping.
    if (dbEnabled()) {
      try {
        const u = await dbUsers.upsertByEmail({ email, name: data.name || null });
        req.session.userId = u.id;
        req.session.role = u.role;
      } catch (e) {
        console.error('[auth] user upsert failed:', e.message); // non-fatal — let them in
      }
    }
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Login error: ' + err.message);
  }
});

app.get('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ----- AUTH GATE -----

function requireAuth(req, res, next) {
  if (isAllowedEmail(req.session?.userEmail)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'auth required' });
  }
  res.redirect('/login');
}

app.use(requireAuth);

// Load the signed-in user (with tokens + Notion id) and bind it to an async
// context so authedClient() and Notion scoping resolve per-user without threading.
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  let user = null;
  try {
    if (dbEnabled() && req.session?.userId) user = await dbUsers.getById(req.session.userId);
  } catch (e) { /* fall through to owner fallback */ }
  if (!user) {
    const email = (req.session?.userEmail || ALLOWED_EMAIL).toLowerCase();
    const isOwner = email === ALLOWED_EMAIL;
    user = { id: null, email, name: req.session?.userName || 'Gretchen',
      role: isOwner ? 'owner' : 'member',
      notion_user_id: isOwner ? GRETCHEN_USER_ID : null,
      personal_enabled: isOwner };
  } else if (user.role === 'owner' && !user.notion_user_id) {
    user.notion_user_id = GRETCHEN_USER_ID;
  } else if (user.role !== 'owner' && !user.notion_user_id) {
    // Member: resolve their Notion identity once (by email), then persist it.
    const nid = await resolveNotionUserId(user.email);
    if (nid) { user.notion_user_id = nid; try { await dbUsers.setNotionUserId(user.id, nid); } catch (e) {} }
  }
  req.user = user;
  userContext.run({ user }, next);
});

// Current user's profile — drives the client bootstrap (name, theme, role, and
// which tabs/modes are available). Falls back to the single-user owner when the
// store is dormant or the row is missing.
app.get('/api/me', async (req, res) => {
  if (!IS_PROD && req.query.as === 'member') {
    return res.json({ id: 'dev-member', email: 'member@' + ALLOWED_DOMAIN, name: 'Dev Member', role: 'member', personalEnabled: false, gmailConnected: false, theme: 'indigo', timezone: TZ });
  }
  if (dbEnabled() && req.session?.userId) {
    try {
      const u = await dbUsers.getById(req.session.userId);
      if (u) return res.json({
        id: u.id, email: u.email, name: u.name, role: u.role,
        notionUserId: u.notion_user_id || null,
        personalEnabled: u.personal_enabled, gmailConnected: !!u.google_refresh_token,
        slackConnected: !!u.slack_user_token || (u.role === 'owner' && !!process.env.SLACK_USER_TOKEN),
        theme: u.theme, timezone: u.timezone,
      });
    } catch (e) { /* fall through to owner fallback */ }
  }
  const isOwner = (req.session?.userEmail || '').toLowerCase() === ALLOWED_EMAIL;
  res.json({
    id: null,
    email: req.session?.userEmail || ALLOWED_EMAIL,
    name: req.session?.userName || 'Gretchen',
    role: isOwner ? 'owner' : 'member',
    notionUserId: isOwner ? GRETCHEN_USER_ID : null,
    personalEnabled: isOwner,
    gmailConnected: isOwner,
    slackConnected: isOwner && !!process.env.SLACK_USER_TOKEN,
    theme: 'indigo',
    timezone: TZ,
  });
});

// ----- PROTECTED ROUTES (below this point require login) -----

// Root route must come BEFORE express.static so it sets no-cache headers
// consistently (express.static would otherwise serve index.html for "/").
// Home is now the Today view; the legacy dashboard stays reachable at /index.
app.get(['/', '/today'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(join(__dirname, 'public', 'today.html'));
});
app.get('/index', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Whether the signed-in request belongs to a personal-enabled user (the owner).
// Mirrors /api/me so server-side gating matches what the client sees.
async function reqPersonalEnabled(req) {
  if (!IS_PROD && req.query.as === 'member') return false; // dev test hook
  if (dbEnabled() && req.session?.userId) {
    try { const u = await dbUsers.getById(req.session.userId); if (u) return !!u.personal_enabled; } catch (e) { /* fall through */ }
  }
  return (req.session?.userEmail || ALLOWED_EMAIL).toLowerCase() === ALLOWED_EMAIL;
}

function serveZone(zone) {
  return (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(join(__dirname, 'public', `${zone}.html`));
  };
}

// Work zones — available to every authenticated team member.
['scale','messages','planning','reference'].forEach(zone => {
  app.get(`/${zone}`, serveZone(zone));
});
// Renamed zones: the page files stay attract.html / convert.html / deliver.html,
// but the public routes are /marketing, /sales and /production. Old paths
// 301-redirect so existing links/bookmarks keep working.
app.get('/marketing', serveZone('attract'));
app.get('/sales', serveZone('convert'));
app.get('/production', serveZone('deliver'));
app.get('/attract', (_req, res) => res.redirect(301, '/marketing'));
app.get('/win', (_req, res) => res.redirect(301, '/sales'));
app.get('/delight', (_req, res) => res.redirect(301, '/production'));
app.get('/convert', (_req, res) => res.redirect(301, '/sales'));
app.get('/deliver', (_req, res) => res.redirect(301, '/production'));
app.get('/execute', (_req, res) => res.redirect(301, '/planning'));

// Personal (LIFE) zones — owner only. Team members are redirected to Today.
['health','wealth','lego','relationships'].forEach(zone => {
  app.get(`/${zone}`, async (req, res) => {
    if (!(await reqPersonalEnabled(req))) return res.redirect('/today');
    serveZone(zone)(req, res);
  });
});

// ── Today UI state (One Thing pick + status) — synced across a user's devices.
// Stored server-side keyed by the signed-in email (same account on every device),
// so it works regardless of whether the multi-user DB is enabled. In-memory with
// best-effort JSON-file persistence across restarts; the state self-resets daily.
const TODAY_STATE_FILE = join(__dirname, '.data', 'today-state.json');
let _todayState = {};
try { if (existsSync(TODAY_STATE_FILE)) _todayState = JSON.parse(readFileSync(TODAY_STATE_FILE, 'utf8')) || {}; } catch (e) { _todayState = {}; }
function _persistTodayState() {
  try { mkdirSync(dirname(TODAY_STATE_FILE), { recursive: true }); writeFileSync(TODAY_STATE_FILE, JSON.stringify(_todayState)); } catch (e) { /* ephemeral fallback to memory */ }
}
function _todayStateKey(req) { return String(req.session?.userEmail || ALLOWED_EMAIL || 'owner').toLowerCase(); }

app.get('/api/today/state', (req, res) => {
  res.json(_todayState[_todayStateKey(req)] || {});
});
app.put('/api/today/state', (req, res) => {
  const b = req.body || {};
  // One Thing pick is scoped per mode (otWork / otPersonal). Accept the legacy
  // single otOverride as the work pick for older clients.
  _todayState[_todayStateKey(req)] = {
    date: String(b.date || ''),
    otWork: b.otWork ?? b.otOverride ?? null,
    otPersonal: b.otPersonal ?? null,
    onething: b.onething ?? null,
  };
  _persistTodayState();
  res.json({ ok: true, stored: true });
});

app.use(express.static(join(__dirname, 'public'), staticOpts));

app.get('/api/me', (req, res) => {
  res.json({ email: req.session.userEmail, name: req.session.userName });
});

app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
  }
  const account = req.query.account === 'personal' ? 'personal' : 'work';
  const oauth = makeOAuthClient(req);
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: DATA_SCOPES,
    state: account,
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');
    const account = state === 'personal' ? 'personal' : 'work';
    const oauth = makeOAuthClient(req);
    const { tokens } = await oauth.getToken(code);
    const refresh = tokens.refresh_token;
    // Multi-user: store the refresh token in the signed-in user's row (encrypted)
    // and return them to the app — no manual env paste.
    if (dbEnabled() && req.session?.userId && refresh && secretsConfigured()) {
      try {
        await dbUsers.setGoogleToken(req.session.userId, account, encrypt(refresh));
        clearUserCache(req.session.userId);
        return res.redirect('/?connected=' + account);
      } catch (e) {
        console.error('[auth] store google token failed:', e.message);
      }
    }
    // Fallback (single-user / owner env-token setup): show the token to paste.
    const envName = ACCOUNT_ENVS[account];
    const shown = refresh || '(none — revoke prior consent and try again)';
    res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>LRL OS — auth (${account})</title></head>
<body style="background:#0a0f1e;color:#f5f5f7;font-family:ui-monospace,Menlo,monospace;padding:2rem;line-height:1.5">
  <h1 style="color:#a7c140;font-family:Georgia,serif">Refresh token captured — ${account}</h1>
  <p>Copy this and add to Railway as <code style="background:#131a30;padding:0.1rem 0.4rem;border-radius:4px">${envName}</code>:</p>
  <pre style="background:#131a30;padding:1rem;border-radius:8px;overflow-x:auto;user-select:all">${shown}</pre>
  <p style="opacity:0.6;font-size:0.85rem">Then redeploy. Do not share this token.</p>
</body></html>`);
  } catch (err) {
    res.status(500).send('OAuth error: ' + err.message);
  }
});

// ----- SLACK OAuth (per-user, so check-ins post as the signed-in user) -----
// Requires a Slack app with the user scopes below, its OAuth redirect set to
// `${origin}/auth/slack/callback`, and SLACK_CLIENT_ID / SLACK_CLIENT_SECRET.
// chat:write powers check-in posting; the *:history + *:read + users:read scopes
// let the Messages zone read your unread DMs and channels. Re-authorize at
// /auth/slack after adding the new scopes to the Slack app.
const SLACK_USER_SCOPES = 'chat:write,channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read';
app.get('/auth/slack', (req, res) => {
  if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) {
    return res.status(500).send('SLACK_CLIENT_ID / SLACK_CLIENT_SECRET not configured');
  }
  const redirectUri = `${originFromReq(req)}/auth/slack/callback`;
  const url = 'https://slack.com/oauth/v2/authorize?' + new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    user_scope: SLACK_USER_SCOPES,
    redirect_uri: redirectUri,
  }).toString();
  res.redirect(url);
});

app.get('/auth/slack/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');
    const redirectUri = `${originFromReq(req)}/auth/slack/callback`;
    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    const data = await tokenRes.json();
    if (!data.ok) throw new Error(data.error || 'oauth failed');
    // The user token (xoxp-…) lives under authed_user.access_token.
    const userToken = data.authed_user?.access_token;
    if (!userToken) throw new Error('no user token returned (check the user_scope)');
    // Persist to disk so the new token takes effect immediately (the Messages zone
    // reads it via currentSlackToken) — no manual env paste / redeploy needed.
    saveSlackFileToken(userToken);
    clearCached('messages-slack');
    if (dbEnabled() && req.session?.userId && secretsConfigured()) {
      await dbUsers.setSlackToken(req.session.userId, encrypt(userToken));
      clearUserCache(req.session.userId);
    }
    return res.redirect('/messages?connected=slack');
  } catch (err) {
    res.status(500).send('Slack OAuth error: ' + err.message);
  }
});

app.get('/api/tasks/work-myday', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const tasks = await cached('work-myday', () => workTasks({ myDayOnly: true }));
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/life-myday', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const tasks = await cached('life-myday', () => lifeTasks({ myDayOnly: true }));
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/work-all', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const tasks = await cached('work-all', () => workTasks({ myDayOnly: false }));
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/life-all', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const tasks = await cached('life-all', () => lifeTasks({ myDayOnly: false }));
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function invalidateTaskCaches() {
  const bases = ['work-myday', 'life-myday', 'work-all', 'life-all', 'tasks-all', 'tasks-all-board', 'goals', 'review', 'xero-finance', 'journal-rings', 'calendar-today', 'followups-all'];
  for (const key of [...cache.keys()]) {
    if (bases.includes(key.split('::')[0])) cache.delete(key); // clears every per-user variant
  }
}

app.get('/api/workspace/members', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (!_notionUsersCache) {
      const out = []; let cursor;
      do {
        const r = await notion.users.list({ start_cursor: cursor, page_size: 100 });
        out.push(...r.results);
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      _notionUsersCache = out;
    }
    const members = _notionUsersCache
      .filter((u) => u.type === 'person')
      .map((u) => ({ id: u.id, name: u.name, email: u.person?.email || null }));
    res.json({ members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight cache-bust for the Today view's auto-refresh: clears ONLY the
// My-Day task caches — NOT goals (which does an expensive per-rock milestone
// recompute) or Xero/brief. Keeps the 60s poll cheap so it doesn't trip Notion's
// rate limit. Rocks/goals refresh on manual ↻ or full page load.
app.get('/api/refresh-tasks', (_req, res) => {
  ['work-myday', 'life-myday'].forEach(clearCached);
  res.json({ ok: true });
});

async function fetchGoalsForSource(projectsDs, tasksDs, source, projectPropName) {
  let projectsRes;
  try {
    projectsRes = await notion.dataSources.query({
      data_source_id: projectsDs,
      filter: { property: 'ROCK', checkbox: { equals: true } },
      page_size: 50,
    });
  } catch (err) {
    // A renamed/missing ROCK property (or any query failure) on one database
    // should degrade to "no rocks" for that source — never throw and take down
    // the whole /api/goals call (and with it the work rocks + daily brief).
    console.error(`Rocks query failed for ${source}:`, err.message);
    return [];
  }
  return Promise.all(projectsRes.results.map(async (proj) => {
    const props = proj.properties || {};
    let milestones = [];
    try {
      // Every task in a Rock project is treated as a milestone — progress tracks
      // task completion across the whole rock, so the bar moves as tasks get
      // checked off (the Milestone field is no longer used to gate this).
      const tasksRes = await notion.dataSources.query({
        data_source_id: tasksDs,
        filter: { property: projectPropName, relation: { contains: proj.id } },
        sorts: [
          { property: 'Due', direction: 'ascending' },
          { timestamp: 'created_time', direction: 'ascending' },
        ],
        page_size: 100,
      });
      milestones = tasksRes.results.map((t) => ({
        id: t.id,
        name: t.properties.Name?.title?.[0]?.plain_text || '(untitled)',
        done: t.properties.Status?.status?.name === 'Done',
        dueStart: t.properties.Due?.date?.start || null,
        url: t.url,
      }));
    } catch (err) {
      console.error(`Milestones for goal ${proj.id} failed:`, err.message);
    }
    return {
      id: proj.id,
      source,
      name: props.Name?.title?.[0]?.plain_text || '(untitled)',
      status: props.Status?.status?.name || null,
      targetDeadline: props['Target Deadline']?.date?.start || null,
      url: proj.url,
      milestones,
      progress: {
        done: milestones.filter((m) => m.done).length,
        total: milestones.length,
      },
    };
  }));
}

app.get('/api/goals', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    // ?fresh=1 bypasses the 60s cache so milestone completion state reflects
    // the current Notion truth immediately (used by the app's Refresh button
    // and the auto-resync when the tab regains focus).
    if (req.query.fresh === '1' || req.query.fresh === 'true') clearCached('goals');
    const goals = await cached('goals', async () => {
      const [work, life] = await Promise.all([
        fetchGoalsForSource(WORK_PROJECTS_DS, WORK_TASKS_DS, 'work', 'Project'),
        fetchGoalsForSource(LIFE_PROJECTS_DS, LIFE_TASKS_DS, 'personal', 'Project'),
      ]);
      return [...work, ...life];
    });
    res.json({ goals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { source, name, status, priority, myDay, dueStart, dueEnd, projectId, taskBody, estHours } = req.body || {};
  if (!source || !name) return res.status(400).json({ error: 'source and name are required' });
  try {
    const result = await createNotionTask({ source, name, status, priority, myDay, dueStart, dueEnd, projectId: projectId || undefined, body: taskBody || undefined, estHours });
    invalidateTaskCaches();
    res.json({ ok: true, id: result.id, url: result.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reminders/sync — called by iOS Shortcut to push a single Reminder
// into the personal Notion tasks database.
app.post('/api/reminders/sync', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { title, notes, dueDate } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    const result = await createNotionTask({
      source: 'personal',
      name: String(title).trim(),
      body: notes ? String(notes).trim() : undefined,
      dueStart: dueDate ? String(dueDate).trim() : undefined,
      status: 'Planned',
    });
    invalidateTaskCaches();
    res.json({ ok: true, id: result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects — active (non-archived) work + personal projects for the
// task project selector. [{ id, source: 'work'|'personal', name }]
app.get('/api/projects', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') clearCached('projects-list');
    const all = await cached('projects-list', fetchActiveProjects);
    // Return every non-archived project (each carrying its status). The client
    // shows only active statuses in the picker menu, but needs the full set to
    // resolve the *name* of a task's current project even when that project is
    // no longer in an active state.
    res.json({ projects: all });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Build an id -> title map for a relation target data source (paginated).
async function fetchRelationNameMap(dsId) {
  const map = {};
  if (!notion) return map;
  let cursor;
  do {
    const r = await notion.dataSources
      .query({ data_source_id: dsId, page_size: 100, start_cursor: cursor })
      .catch(() => ({ results: [], has_more: false }));
    for (const pg of r.results) {
      const titleProp = Object.values(pg.properties || {}).find((x) => x.type === 'title');
      map[pg.id] = titleProp?.title?.[0]?.plain_text || '(untitled)';
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return map;
}

// Project ids whose AREA is "Production" — where all client (billable) projects
// live. Used to scope the needle's "closed without time logged" nudge to billable
// work. Returns a Set of WORK_PROJECTS page ids.
async function productionProjectIds() {
  if (!notion) return new Set();
  const norm = (s) => (s || '').replace(/[^a-z]/gi, '').toLowerCase();
  const areaMap = await fetchRelationNameMap(PROJECT_AREA_DS);
  const prodAreaId = Object.keys(areaMap).find((id) => norm(areaMap[id]) === 'production');
  const ids = new Set();
  if (!prodAreaId) return ids;
  let cursor;
  do {
    const r = await notion.dataSources.query({
      data_source_id: WORK_PROJECTS_DS,
      filter: { property: 'AREA', relation: { contains: prodAreaId } },
      page_size: 100,
      start_cursor: cursor,
    }).catch(() => ({ results: [], has_more: false }));
    for (const p of r.results) ids.add(p.id);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return ids;
}

// Resolve a single page's title directly (cached). Fallback for relation ids the
// prefetched name maps don't cover — e.g. Area/System pages a data-source query
// didn't surface — so every relation defined in Notion still resolves to a name.
const _relTitleCache = new Map();
async function resolvePageTitle(id) {
  if (!notion || !id) return null;
  if (_relTitleCache.has(id)) return _relTitleCache.get(id);
  let title = null;
  try {
    const pg = await notion.pages.retrieve({ page_id: id });
    const tp = Object.values(pg.properties || {}).find((x) => x.type === 'title');
    title = tp?.title?.[0]?.plain_text || null;
  } catch (e) { /* unreadable — leave null */ }
  _relTitleCache.set(id, title);
  return title;
}

// Full board of projects (work + personal) for the Projects tab: status,
// area/system (resolved to names), owners, dates, derived at-risk. The two
// DBs differ — work: AREA/SYSTEM/Assigned/Due; personal: Area only, no
// SYSTEM, no Due, owners come from a relation (and aren't shown anyway).
async function fetchProjectsBoard() {
  if (!notion) return { projects: [], areas: [], systems: [] };
  const [workAreaMap, systemMap, personalAreaMap, personalHubMap] = await Promise.all([
    fetchRelationNameMap(PROJECT_AREA_DS).catch(() => ({})),
    fetchRelationNameMap(PROJECT_SYSTEM_DS).catch(() => ({})),
    fetchRelationNameMap(PERSONAL_AREA_DS).catch(() => ({})),
    fetchRelationNameMap(PERSONAL_HUBS_DS).catch(() => ({})),
  ]);
  const queryAll = async (dsId) => {
    const pages = [];
    let cursor;
    do {
      const r = await notion.dataSources.query({
        data_source_id: dsId,
        filter: { property: 'Archived', checkbox: { equals: false } },
        page_size: 100,
        start_cursor: cursor,
      });
      pages.push(...r.results);
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    return pages;
  };
  const [workPages, personalPages] = await Promise.all([
    queryAll(WORK_PROJECTS_DS),
    queryAll(LIFE_PROJECTS_DS),
  ]);

  // Backfill any Area/System relation ids the prefetched maps don't cover (some
  // relation targets aren't surfaced by a single data-source query), so projects
  // like the Q2 Rocks still show their TRACTION/EOS area + system.
  const extra = {};
  const missing = new Set();
  const collectMissing = (rel, map) => (rel || []).forEach((r) => { if (r.id && !map[r.id]) missing.add(r.id); });
  for (const p of workPages) {
    collectMissing(p.properties.AREA?.relation, workAreaMap);
    collectMissing(p.properties.SYSTEM?.relation, systemMap);
  }
  for (const p of personalPages) {
    collectMissing(p.properties.Area?.relation, personalAreaMap);
    collectMissing(p.properties.HUBS?.relation, personalHubMap);
  }
  await Promise.all([...missing].map(async (id) => { const t = await resolvePageTitle(id); if (t) extra[id] = t; }));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const build = (p, source, areas, systems, owners) => {
    const pr = p.properties;
    const status = pr.Status?.status?.name || null;
    // Dates: a Target Deadline RANGE (start + end, via Notion's end-date toggle)
    // is the source of truth for the project's start→end. Otherwise fall back
    // to Created (start) and the single deadline / Due (end).
    const tdStart = pr['Target Deadline']?.date?.start || null;
    const tdEnd = pr['Target Deadline']?.date?.end || null;
    const dueStart = pr.Due?.date?.start || null;
    const created = pr.Created?.created_time || null;
    let start, end, rangeStart = null;
    if (tdEnd) { start = tdStart; end = tdEnd; rangeStart = tdStart; }
    else { start = created; end = tdStart || dueStart || null; }
    // Active-task breakdown string, e.g. "Planned: 20 | Agenda: 2 | Waiting: 1".
    const taskMeta = pr['Task Meta']?.formula?.string || pr['Active Tasks']?.formula?.string || '';
    // Progress fraction 0..1 (personal projects expose it; work doesn't).
    const pf = pr.Progress?.formula;
    let progress = null;
    if (pf) {
      if (typeof pf.number === 'number') progress = pf.number;
      else if (pf.string) { const n = parseFloat(pf.string); if (!Number.isNaN(n)) progress = n; }
    }
    return {
      id: p.id,
      url: p.url,
      source,
      name: pr.Name?.title?.[0]?.plain_text || '(untitled)',
      status,
      area: areas[0] || null,
      areas,
      system: systems[0] || null,
      systems,
      owners,
      // Personal projects are inherently the user's; work projects are "mine" when
      // the signed-in user is one of the Notion assignees. Drives the "Me" filter.
      assignedToMe: source === 'personal'
        ? true
        : (pr.Assigned?.people || []).some((u) => u.id === currentNotionUserId()),
      start,
      end,
      rangeStart,        // non-null only when Target Deadline is a real range
      deadline: tdStart,
      due: dueStart,
      created,
      completed: pr.Completed?.date?.start || null,
      rock: !!pr.ROCK?.checkbox,
      taskMeta,
      progress,
      atRisk: !!end && status !== 'Done' && new Date(end).getTime() < todayMs,
    };
  };

  const workProjects = workPages.map((p) => build(
    p, 'work',
    (p.properties.AREA?.relation || []).map((r) => workAreaMap[r.id] || extra[r.id]).filter(Boolean),
    (p.properties.SYSTEM?.relation || []).map((r) => systemMap[r.id] || extra[r.id]).filter(Boolean),
    (p.properties.Assigned?.people || []).map((u) => u.name).filter(Boolean),
  ));
  const personalProjects = personalPages.map((p) => build(
    p, 'personal',
    (p.properties.Area?.relation || []).map((r) => personalAreaMap[r.id] || extra[r.id]).filter(Boolean),
    (p.properties.HUBS?.relation || []).map((r) => personalHubMap[r.id] || extra[r.id]).filter(Boolean),
    [],   // personal projects don't surface owner avatars
  ));

  const projects = [...workProjects, ...personalProjects];
  const areas = [...new Set(projects.flatMap((p) => p.areas))].sort();
  const systems = [...new Set(projects.flatMap((p) => p.systems))].sort();
  // Assignable relation options (id + name) for the in-card editors / drag-drop.
  const optList = (map) => Object.entries(map).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const options = {
    workArea: optList(workAreaMap),
    system: optList(systemMap),
    personalArea: optList(personalAreaMap),
    hubs: optList(personalHubMap),
  };
  return { projects, areas, systems, options };
}

// GET /api/projects/board — everything the Projects tab needs.
app.get('/api/projects/board', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') clearCached('projects-board');
    const data = await cached('projects-board', fetchProjectsBoard);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/diag — pinpoints why a project's Area/System isn't resolving.
// Reports what the integration's relation-name maps contain, and for each work
// project that has Area/System relations but resolves to no name, probes the
// relation ids: are they in the map, does the query even return them, and can
// the page be retrieved directly (vs. a permission error).
app.get('/api/projects/diag', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  if (currentUser()?.role !== 'owner') return res.status(403).json({ error: 'owner only' });
  try {
    // Which integration is the server actually using? Match this name against the
    // database's Connections list to confirm the right integration is connected.
    let botUser = null;
    try { const me = await notion.users.me(); botUser = { name: me.name, id: me.id, type: me.type }; }
    catch (e) { botUser = { error: e.code || e.message }; }
    const areaMap = await fetchRelationNameMap(PROJECT_AREA_DS).catch((e) => ({ __error: e.message }));
    const sysMap = await fetchRelationNameMap(PROJECT_SYSTEM_DS).catch((e) => ({ __error: e.message }));
    const pages = [];
    let cursor;
    do {
      const r = await notion.dataSources.query({
        data_source_id: WORK_PROJECTS_DS,
        filter: { property: 'Archived', checkbox: { equals: false } },
        page_size: 100, start_cursor: cursor,
      });
      pages.push(...r.results);
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    const unresolved = [];
    for (const p of pages) {
      const aRel = p.properties.AREA?.relation || [];
      const sRel = p.properties.SYSTEM?.relation || [];
      const aNames = aRel.map((r) => areaMap[r.id]).filter(Boolean);
      const sNames = sRel.map((r) => sysMap[r.id]).filter(Boolean);
      if ((aRel.length && !aNames.length) || (sRel.length && !sNames.length)) {
        const probes = [];
        for (const r of [...aRel, ...sRel]) {
          const probe = { id: r.id, inAreaMap: !!areaMap[r.id], inSysMap: !!sysMap[r.id] };
          try {
            const pg = await notion.pages.retrieve({ page_id: r.id });
            const tp = Object.values(pg.properties || {}).find((x) => x.type === 'title');
            probe.retrieveTitle = tp?.title?.[0]?.plain_text || null;
          } catch (e) { probe.retrieveError = e.code || e.message; }
          probes.push(probe);
        }
        unresolved.push({
          name: p.properties.Name?.title?.[0]?.plain_text || '(untitled)',
          areaRelCount: aRel.length, areaHasMore: !!p.properties.AREA?.has_more,
          systemRelCount: sRel.length, systemHasMore: !!p.properties.SYSTEM?.has_more,
          probes,
        });
      }
    }
    // Direct read probe of known TRACTION-bucket pages: does the integration have
    // page-level access at all, and what error does Notion return if not?
    const knownIds = {
      'TRACTION (area)': '290458f0-8cd9-80ea-acd8-de8f210cb22f',
      'GROWTH (area)': '290458f0-8cd9-8062-9fe6-df6c6d9a9267',
      'EOS (system)': '25b34cc1-0f2f-4699-9792-c2ff3aa202c9',
    };
    const knownProbes = {};
    for (const [label, id] of Object.entries(knownIds)) {
      try {
        const pg = await notion.pages.retrieve({ page_id: id });
        const tp = Object.values(pg.properties || {}).find((x) => x.type === 'title');
        knownProbes[label] = { ok: true, title: tp?.title?.[0]?.plain_text || null };
      } catch (e) { knownProbes[label] = { ok: false, error: e.code || e.message }; }
    }
    res.json({
      botUser,
      knownProbes,
      areaMap: areaMap.__error ? areaMap : { count: Object.keys(areaMap).length, titles: Object.values(areaMap) },
      systemMap: sysMap.__error ? sysMap : { count: Object.keys(sysMap).length, titles: Object.values(sysMap) },
      workProjectCount: pages.length,
      unresolvedCount: unresolved.length,
      unresolved: unresolved.slice(0, 25),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current weather for Euless, TX via Open-Meteo (no API key needed).
async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America%2FChicago`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('weather upstream ' + r.status);
  const d = await r.json();
  const cur = d.current || {};
  if (cur.temperature_2m == null) throw new Error('no current weather');
  return { tempF: Math.round(cur.temperature_2m), code: cur.weather_code ?? null, at: cur.time || null };
}
app.get('/api/weather', async (req, res) => {
  try {
    if (req.query.fresh === '1') cache.delete('weather');
    const w = await cached('weather', fetchWeather);
    res.json(w);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// PATCH /api/projects/:id — quick edits from the Projects tab card.
// Both DBs share the Status + Target Deadline property names.
app.patch('/api/projects/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { id } = req.params;
  const { name, status, deadlineStart, deadlineEnd, area, system, source } = req.body || {};
  try {
    const properties = {};
    if (name !== undefined && name !== null && String(name).trim()) {
      properties.Name = { title: [{ text: { content: String(name).trim() } }] };
    }
    if (status !== undefined) properties.Status = { status: { name: status } };
    // deadlineStart + optional deadlineEnd → Target Deadline (range when both set).
    if (deadlineStart !== undefined || deadlineEnd !== undefined) {
      properties['Target Deadline'] = deadlineStart
        ? { date: { start: deadlineStart, end: deadlineEnd || null } }
        : { date: null };
    }
    // Relation property names differ by DB: work uses AREA/SYSTEM, personal
    // uses Area/HUBS (the Focus + Hubs dimensions). A null id clears it.
    const areaProp = source === 'personal' ? 'Area' : 'AREA';
    const systemProp = source === 'personal' ? 'HUBS' : 'SYSTEM';
    if (area !== undefined) properties[areaProp] = { relation: area ? [{ id: area }] : [] };
    if (system !== undefined) properties[systemProp] = { relation: system ? [{ id: system }] : [] };
    if (!Object.keys(properties).length) return res.status(400).json({ error: 'No supported fields to update' });
    await notion.pages.update({ page_id: id, properties });
    clearCached('projects-board');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { id } = req.params;
  const { name, status, dueStart, dueEnd, myDay, priority, projectId, estHours, assigneeIds, followingIds, clearFollowUp, onList, followUpBy, followUpOwnerId } = req.body || {};
  try {
    const properties = {};
    if (clearFollowUp || onList !== undefined || followUpBy !== undefined || followUpOwnerId !== undefined) {
      applyFollowupProps(properties, { clear: clearFollowUp, onList, followUpBy, followUpOwnerId });
    }
    if (name !== undefined && name !== null) {
      properties.Name = { title: [{ text: { content: String(name) } }] };
    }
    if (status !== undefined) {
      properties.Status = { status: { name: status } };
      if (status === 'Done') {
        const todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
        properties.Completed = { date: { start: todayISO } };
      }
    }
    // Est Hours is a number property that only exists on the work DB. A null
    // clears it; a finite number sets it. (Personal tasks never send this.)
    if (estHours !== undefined) {
      const n = estHours === null || estHours === '' ? null : Number(estHours);
      properties['Est Hours'] = { number: Number.isFinite(n) ? n : null };
    }
    if (dueStart !== undefined || dueEnd !== undefined) {
      properties.Due = dueStart
        ? { date: { start: dueStart, end: dueEnd || null } }
        : { date: null };
    }
    if (myDay !== undefined) properties['My Day'] = { checkbox: !!myDay };
    if (priority !== undefined) {
      properties['Priority'] = priority ? { select: { name: priority } } : { select: null };
    }
    // projectId: a uuid sets the Project relation; null/'' clears it.
    if (projectId !== undefined) {
      properties.Project = projectId ? { relation: [{ id: projectId }] } : { relation: [] };
    }
    if (assigneeIds !== undefined) {
      properties.Assigned = { people: (Array.isArray(assigneeIds) ? assigneeIds : []).map((id) => ({ id })) };
    }
    if (followingIds !== undefined) {
      properties.Following = { people: (Array.isArray(followingIds) ? followingIds : []).map((id) => ({ id })) };
    }
    if (!Object.keys(properties).length) {
      return res.status(400).json({ error: 'No supported fields to update' });
    }
    await notion.pages.update({ page_id: id, properties });
    invalidateTaskCaches();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    await notion.pages.update({ page_id: dashifyId(req.params.id), archived: true });
    invalidateTaskCaches();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add/remove the current user from a task's "Following" people property.
// Body: { follow: boolean } (defaults to follow). Returns the resulting state.
app.post('/api/tasks/:id/follow', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const follow = req.body?.follow !== false;
  const pageId = dashifyId(req.params.id);
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const current = (page.properties?.Following?.people || []).map((p) => p.id);
    const me = currentNotionUserId();
    if (!me) return res.status(400).json({ error: 'no Notion identity for this user yet' });
    const has = current.includes(me);
    let next = current;
    if (follow && !has) next = [...current, me];
    else if (!follow && has) next = current.filter((id) => id !== me);
    if (next !== current) {
      await notion.pages.update({ page_id: pageId, properties: { Following: { people: next.map((id) => ({ id })) } } });
      invalidateTaskCaches();
    }
    res.json({ ok: true, following: next.includes(me) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Follow-ups -----------------------------------------------------------
// A universal follow-up flag on work tasks, life tasks, deals, and sales
// touchpoints. Every follow-up has an OWNER (the "Follow Up Owner" person) so
// the queue is personal: GET returns only items owned by the current user, whose
// "Follow Up By" is empty OR on/before today (future-dated reminders stay quiet).
// Flagging assigns an owner (default: yourself, but you can hand it to a teammate).
// PATCH is DB-agnostic: all four DBs share the same property names.
const FOLLOWUP_SOURCES = [
  { ds: WORK_TASKS_DS, kind: 'task', source: 'work', titleProp: 'Name' },
  { ds: LIFE_TASKS_DS, kind: 'task', source: 'personal', titleProp: 'Name' },
  { ds: SALES_PIPELINE_DS, kind: 'deal', source: 'sales', titleProp: 'Deal Name' },
  // Sales touchpoints intentionally excluded — you follow up on the CONTACT, not
  // a single logged activity (a touchpoint row's title is just its type).
  { ds: CONTACTS_DS, kind: 'contact', source: 'sales', titleProp: 'Full Name' },
  { ds: SPEAKING_OUTREACH_DS, kind: 'speaking', source: 'sales', titleProp: 'Name' },
];

async function fetchFollowupsFor({ ds, kind, source, titleProp }, today, nid) {
  // Owner-scoped AND on-my-list: only items whose Follow Up Owner is the current
  // user and whose Follow Up (on-list) checkbox is on. The checkbox — not the due
  // date — is the visibility gate, so the owner controls their own Today list.
  // No shared sort property across the DBs → skip Notion sorting; sort in JS.
  const pages = await pageThroughDS(ds, { and: [
    { property: 'Follow Up Owner', people: { contains: nid } },
    { property: 'Follow Up', checkbox: { equals: true } },
  ] }, null);
  const out = [];
  for (const pg of pages) {
    const props = pg.properties || {};
    const by = props['Follow Up By']?.date?.start || null;
    out.push({
      id: pg.id,
      title: (props[titleProp]?.title?.[0]?.plain_text || '(untitled)'),
      kind,
      source,
      followUpBy: by,
      followUpOwnerId: (props['Follow Up Owner']?.people || [])[0]?.id || null,
      status: props.Status?.status?.name || props['Pipeline Status']?.status?.name || props.Stage?.select?.name || null,
      // Context: tasks resolve a project name client-side from this id; deals/
      // touchpoints carry a channel/type hint the client can show as a sub-line.
      projectId: (props.Project?.relation || [])[0]?.id || null,
      channel: props.Channel?.select?.name || props['Touchpoint Type']?.select?.name || null,
      edited: pg.last_edited_time || null,
      url: pg.url,
    });
  }
  return out;
}

app.get('/api/followups', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const nid = currentNotionUserId();
    if (!nid) return res.json({ items: [], count: 0 }); // no Notion identity → nothing to scope to
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    const items = await cached('followups-all', async () => {
      const groups = await Promise.all(FOLLOWUP_SOURCES.map((s) => fetchFollowupsFor(s, today, nid)));
      const flat = groups.flat();
      // Undated first, then by soonest follow-up date; stable-ish by edited time.
      flat.sort((a, b) => {
        if (!a.followUpBy && b.followUpBy) return -1;
        if (a.followUpBy && !b.followUpBy) return 1;
        if (a.followUpBy && b.followUpBy) return a.followUpBy.localeCompare(b.followUpBy);
        return (b.edited || '').localeCompare(a.edited || '');
      });
      return flat;
    });
    res.json({ items, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apply follow-up changes to a Notion `properties` object (shared by this toggle
// and the task/deal PATCH). A follow-up behaves like a to-do:
//   • Follow Up Owner (person) — who's doing it (single assignment)
//   • Follow Up By  (date)     — the due date
//   • Follow Up     (checkbox) — "on my Today list" (the owner's declutter control)
// Options:
//   clear:true               → complete/resolve: clear owner + on-list + date
//   onList (bool)            → set the on-my-day checkbox
//   followUpOwnerId provided → set/clear the owner
//   followUpBy provided      → set/clear the due date
function applyFollowupProps(properties, { clear, onList, followUpBy, followUpOwnerId }) {
  if (clear) {
    properties['Follow Up Owner'] = { people: [] };
    properties['Follow Up'] = { checkbox: false };
    properties['Follow Up By'] = { date: null };
    return;
  }
  if (followUpOwnerId !== undefined) {
    properties['Follow Up Owner'] = followUpOwnerId
      ? { people: [{ id: dashifyId(followUpOwnerId) }] } : { people: [] };
  }
  if (onList !== undefined) properties['Follow Up'] = { checkbox: !!onList };
  if (followUpBy !== undefined) {
    properties['Follow Up By'] = followUpBy ? { date: { start: followUpBy } } : { date: null };
  }
}

// Universal toggle — works on any follow-up DB (shared property names).
// Body: { clear? (complete), onList? (on my day), followUpBy?, followUpOwnerId? }.
app.patch('/api/followup/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const properties = {};
    applyFollowupProps(properties, req.body || {});
    if (!Object.keys(properties).length) return res.status(400).json({ error: 'No fields to update' });
    await notion.pages.update({ page_id: dashifyId(req.params.id), properties });
    clearCached('followups-all');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/all', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const tasks = await cached('tasks-all-board', async () => {
      const [w, l, projects] = await Promise.all([
        workTasks({ myDayOnly: false, allAssignees: true }),
        lifeTasks({ myDayOnly: false }),
        cached('projects-list', fetchActiveProjects),
      ]);
      // Resolve each task's project name from its relation id so the Tasks tab
      // can group/label by project (simplifyTask only captures projectId).
      const nameById = new Map(projects.map((p) => [p.id, p.name]));
      const all = [...w, ...l];
      for (const t of all) {
        if (t.projectId) t.project = nameById.get(t.projectId) || null;
      }
      return all;
    });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VIP senders for the Messages "Needs Attention" lane. Env-driven so clients can
// be added without a deploy; defaults to the core team. Lowercased name/email
// fragments — a match on either flags the sender.
const MESSAGES_VIP = (process.env.MESSAGES_VIP_EMAILS || 'trina@leftrightlabs.com,natasha@leftrightlabs.com')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

async function fetchInbox(account, userIndex, opts = {}) {
  const auth = authedClient(account);
  if (!auth) return [];
  const gmail = google.gmail({ version: 'v1', auth });
  const q = opts.q || 'in:inbox is:unread newer_than:7d';
  const maxResults = opts.maxResults || 15;
  const list = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults,
  });
  const ids = (list.data.messages || []).map((m) => m.id);
  if (!ids.length) return [];
  const details = await Promise.all(
    ids.map((id) =>
      gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      }),
    ),
  );
  return details.map((d) => {
    const msg = d.data;
    const headers = Object.fromEntries(
      (msg.payload?.headers || []).map((h) => [h.name, h.value]),
    );
    const from = parseFromHeader(headers.From);
    const unread = Array.isArray(msg.labelIds) ? msg.labelIds.includes('UNREAD') : false;
    const hay = `${from.name || ''} ${from.email || ''}`.toLowerCase();
    const isVIP = MESSAGES_VIP.some((v) => hay.includes(v));
    return {
      id: msg.id,
      account,
      threadId: msg.threadId,
      subject: headers.Subject || '(no subject)',
      fromName: from.name || from.email,
      fromEmail: from.email,
      snippet: decodeEntities(msg.snippet || ''),
      date: headers.Date || null,
      internalDate: msg.internalDate ? Number(msg.internalDate) : null,
      unread,
      // Importance is computed server-side (never a manual flag). needsReply is a
      // pragmatic v1 proxy — a VIP whose message is still unread likely awaits us.
      isVIP,
      needsReply: isVIP && unread,
      category: account === 'personal' ? 'PERSONAL' : 'WORK',
      url: `https://mail.google.com/mail/u/${userIndex}/#inbox/${msg.threadId}`,
    };
  });
}

// Build the Gmail search query for the Comms tab. The Comms surface shows
// the inbox itself — controlled by the read-status filter the user picks.
function commsGmailQuery(status, days) {
  const span = `newer_than:${Math.max(1, Math.min(days || 30, 90))}d`;
  if (status === 'read') return `in:inbox -is:unread ${span}`;
  if (status === 'all') return `in:inbox ${span}`;
  return `in:inbox is:unread ${span}`; // default = unread
}

app.get('/api/comms/gmail', async (req, res) => {
  const accounts = configuredAccounts();
  if (!accounts.length) {
    return res.status(500).json({ error: 'No Google refresh tokens configured' });
  }
  // status: 'unread' (default) | 'read' | 'all'
  const status = ['read', 'all', 'unread'].includes(req.query.status) ? req.query.status : 'unread';
  const days = Number(req.query.days) || (status === 'unread' ? 7 : 30);
  const max = status === 'unread' ? 25 : 75; // wider net when showing more
  const cacheKey = `gmail-inbox-${status}-${days}`;
  try {
    const threads = await cached(cacheKey, async () => {
      const q = commsGmailQuery(status, days);
      const results = await Promise.all(
        accounts.map((a, i) => fetchInbox(a, i, { q, maxResults: max }).catch((err) => {
          console.error(`Gmail ${a} error:`, err.message);
          return [];
        })),
      );
      return results.flat().sort((a, b) => (b.internalDate || 0) - (a.internalDate || 0));
    });
    res.json({ threads, status, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch full message body and mark as read
app.get('/api/comms/message/:id', async (req, res) => {
  const { id } = req.params;
  const account = req.query.account || 'work';
  const accounts = configuredAccounts();
  const target = accounts.includes(account) ? account : accounts[0];
  if (!target) return res.status(500).json({ error: 'No account configured' });
  try {
    const auth = authedClient(target);
    const gmail = google.gmail({ version: 'v1', auth });
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const data = msg.data;
    const hdrs = Object.fromEntries((data.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
    const htmlPart = findMimePart(data.payload, 'text/html');
    const textPart = findMimePart(data.payload, 'text/plain');
    const [bodyHtml, bodyText] = await Promise.all([
      resolveMimePartBody(gmail, id, htmlPart),
      resolveMimePartBody(gmail, id, textPart),
    ]);
    const from = parseFromHeader(hdrs.from || '');
    // Mark as read — best-effort, scope may not exist yet
    gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['UNREAD'] } }).catch(() => {});
    res.json({
      id, threadId: data.threadId, account: target,
      subject: hdrs.subject || '(no subject)',
      from: { name: from.name, email: from.email },
      to: hdrs.to || '',
      date: hdrs.date || '',
      messageId: hdrs['message-id'] || '',
      references: hdrs.references || '',
      bodyHtml, bodyText,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a reply
app.post('/api/comms/reply', async (req, res) => {
  const { threadId, to, subject, body, messageId, references, account } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'Reply body required' });
  const accounts = configuredAccounts();
  const target = (account && accounts.includes(account)) ? account : accounts[0];
  if (!target) return res.status(500).json({ error: 'No account configured' });
  try {
    const auth = authedClient(target);
    const gmail = google.gmail({ version: 'v1', auth });
    const replySubject = subject?.startsWith('Re:') ? subject : `Re: ${subject || ''}`;
    const refs = [references, messageId].filter(Boolean).join(' ').trim();
    const mime = [
      `To: ${to}`,
      `Subject: ${replySubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      messageId ? `In-Reply-To: ${messageId}` : null,
      refs ? `References: ${refs}` : null,
      '',
      body.trim(),
    ].filter(l => l !== null).join('\r\n');
    const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } });
    for (const k of [...cache.keys()].filter(k => k.startsWith('gmail-'))) cache.delete(k);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trash a single message
app.delete('/api/comms/message/:id', async (req, res) => {
  const { id } = req.params;
  const account = req.query.account || 'work';
  const accounts = configuredAccounts();
  const target = accounts.includes(account) ? account : accounts[0];
  if (!target) return res.status(500).json({ error: 'No account configured' });
  try {
    const auth = authedClient(target);
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.trash({ userId: 'me', id });
    for (const k of [...cache.keys()].filter(k => k.startsWith('gmail-'))) cache.delete(k);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI-assisted task suggestion from an email
const TASK_ACTIVE_STATUSES = ['Planned', 'Active', 'Ongoing', 'Billing', 'Doing'];
app.post('/api/comms/suggest-task', async (req, res) => {
  const { subject, from, bodyText, account } = req.body || {};
  const source = account === 'personal' ? 'personal' : 'work';
  try {
    const allProjects = await cached('projects-list', fetchActiveProjects);
    const projects = allProjects.filter(p => p.source === source && TASK_ACTIVE_STATUSES.includes(p.status));
    const projectList = projects.length
      ? projects.map(p => `${p.id}\t${p.name}`).join('\n')
      : '(no active projects)';
    let taskName = subject ? `Follow up: ${subject}` : 'Email task';
    let projectId = null, projectName = null;
    if (anthropic) {
      const prompt = [
        `You are building a Notion task from an email for Gretchen Cawthon, Integrator at Left Right Labs.`,
        ``,
        `Email:`,
        `From: ${from || 'unknown'}`,
        `Subject: ${subject || '(none)'}`,
        `Preview: ${(bodyText || '').slice(0, 600)}`,
        ``,
        `Active ${source} projects (id<TAB>name):`,
        projectList,
        ``,
        `Return JSON only — no explanation:`,
        `{ "taskName": "verb-first action task (≤80 chars)", "projectId": "uuid or null", "projectName": "matched name or null" }`,
        ``,
        `Rules for taskName: start with a verb, be specific. E.g. "Reply to Jeff re: BrickScore launch" not "Email from Jeff".`,
        `Rules for projectId: pick the UUID of the most relevant project above, or null.`,
      ].join('\n');
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const m = text.match(/\{[\s\S]*?\}/);
      if (m) {
        const s = JSON.parse(m[0]);
        if (s.taskName) taskName = s.taskName;
        if (s.projectId && projects.find(p => p.id === s.projectId)) {
          projectId = s.projectId;
          projectName = s.projectName || projects.find(p => p.id === s.projectId)?.name || null;
        }
      }
    }
    res.json({ ok: true, taskName, projectId, projectName });
  } catch (err) {
    const fallback = subject ? `Follow up: ${subject}` : 'Email task';
    res.json({ ok: false, taskName: fallback, projectId: null, projectName: null });
  }
});

// Archive a single message (remove INBOX label)
app.post('/api/comms/message/:id/archive', async (req, res) => {
  const { id } = req.params;
  const account = req.body?.account || req.query.account || 'work';
  const accounts = configuredAccounts();
  const target = accounts.includes(account) ? account : accounts[0];
  if (!target) return res.status(500).json({ error: 'No account configured' });
  try {
    const auth = authedClient(target);
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['INBOX'] } });
    for (const k of [...cache.keys()].filter(k => k.startsWith('gmail-'))) cache.delete(k);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Archive multiple messages
app.post('/api/comms/messages/archive-batch', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items required' });
  try {
    const accounts = configuredAccounts();
    const byAccount = {};
    for (const { id, account } of items) {
      const target = (account && accounts.includes(account)) ? account : accounts[0];
      if (!byAccount[target]) byAccount[target] = [];
      byAccount[target].push(id);
    }
    await Promise.all(
      Object.entries(byAccount).flatMap(([target, ids]) => {
        const auth = authedClient(target);
        const gmail = google.gmail({ version: 'v1', auth });
        return ids.map(id => gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['INBOX'] } }));
      })
    );
    for (const k of [...cache.keys()].filter(k => k.startsWith('gmail-'))) cache.delete(k);
    res.json({ ok: true, archived: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI draft reply
app.post('/api/comms/draft-reply', async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { subject, from, bodyText } = req.body || {};
  if (!bodyText && !subject) return res.status(400).json({ error: 'Message content required' });
  try {
    const userPrompt = [
      'Write a reply to this email on behalf of Gretchen Cawthon, Integrator at Left Right Labs.',
      'Match the tone of the original. Be concise and direct — 2–4 sentences is usually right.',
      'Return ONLY the reply body. No greeting like "Dear X:", no subject line, no full signature.',
      '',
      `From: ${from || '(unknown)'}`,
      `Subject: ${subject || '(none)'}`,
      '',
      (bodyText || '').slice(0, 3000),
    ].join('\n');
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const draft = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    res.json({ draft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trash multiple messages
app.post('/api/comms/messages/trash-batch', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items required' });
  try {
    const accounts = configuredAccounts();
    const byAccount = {};
    for (const { id, account } of items) {
      const target = (account && accounts.includes(account)) ? account : accounts[0];
      if (!byAccount[target]) byAccount[target] = [];
      byAccount[target].push(id);
    }
    await Promise.all(
      Object.entries(byAccount).flatMap(([target, ids]) => {
        const auth = authedClient(target);
        const gmail = google.gmail({ version: 'v1', auth });
        return ids.map(id => gmail.users.messages.trash({ userId: 'me', id }));
      })
    );
    for (const k of [...cache.keys()].filter(k => k.startsWith('gmail-'))) cache.delete(k);
    res.json({ ok: true, trashed: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function chicagoWeekRange(weekOffset = 0) {
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
  const probe = new Date(`${todayStr}T12:00:00Z`);
  const chiHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, hour: '2-digit' }).format(probe),
    10,
  );
  const offsetHrs = 12 - chiHour;
  const tzOffset = `-${String(offsetHrs).padStart(2, '0')}:00`;
  const [y, m, d] = todayStr.split('-').map(Number);
  const refDate = new Date(Date.UTC(y, m - 1, d));
  const dow = refDate.getUTCDay(); // 0=Sun
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const startUTC = new Date(Date.UTC(y, m - 1, d + daysToMon + weekOffset * 7));
  const endUTC = new Date(Date.UTC(startUTC.getUTCFullYear(), startUTC.getUTCMonth(), startUTC.getUTCDate() + 6));
  const startStr = startUTC.toISOString().slice(0, 10);
  const endStr = endUTC.toISOString().slice(0, 10);
  return { start: `${startStr}T00:00:00${tzOffset}`, end: `${endStr}T23:59:59${tzOffset}`, startStr, endStr };
}

async function fetchToday(account) {
  const auth = authedClient(account);
  if (!auth) return [];
  const cal = google.calendar({ version: 'v3', auth });
  const range = chicagoTodayRange();
  const { data } = await cal.events.list({
    calendarId: 'primary',
    timeMin: range.start,
    timeMax: range.end,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: TZ,
  });
  return (data.items || []).map((e) => ({
    id: e.id,
    account,
    title: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    allDay: !!e.start?.date,
    location: e.location || null,
    url: e.htmlLink,
  }));
}

app.get('/api/calendar/today', async (_req, res) => {
  const accounts = configuredAccounts();
  if (!accounts.length) {
    return res.status(500).json({ error: 'No Google refresh tokens configured' });
  }
  try {
    const events = await cached('calendar-today', async () => {
      const results = await Promise.all(
        accounts.map((a) => fetchToday(a).catch((err) => {
          console.error(`Calendar ${a} error:`, err.message);
          return [];
        })),
      );
      return results.flat().sort((a, b) => {
        if (a.allDay && !b.allDay) return -1;
        if (!a.allDay && b.allDay) return 1;
        return new Date(a.start).getTime() - new Date(b.start).getTime();
      });
    });
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/calendar/week', async (req, res) => {
  const accounts = configuredAccounts();
  if (!accounts.length) return res.status(500).json({ error: 'No Google refresh tokens configured' });
  try {
    const weekOffset = parseInt(req.query.offset || '0', 10) || 0;
    const range = chicagoWeekRange(weekOffset);
    const results = await Promise.all(accounts.map(async (account) => {
      const auth = authedClient(account);
      if (!auth) return [];
      const cal = google.calendar({ version: 'v3', auth });
      const { data } = await cal.events.list({
        calendarId: 'primary',
        timeMin: range.start,
        timeMax: range.end,
        singleEvents: true,
        orderBy: 'startTime',
        timeZone: TZ,
      });
      return (data.items || []).map((e) => ({
        id: e.id,
        account,
        title: e.summary || '(no title)',
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        allDay: !!e.start?.date,
        location: e.location || null,
        url: e.htmlLink,
      }));
    }));
    const events = results.flat().sort((a, b) => {
      if (a.allDay && !b.allDay) return -1;
      if (!a.allDay && b.allDay) return 1;
      return new Date(a.start) - new Date(b.start);
    });
    res.json({ events, weekStart: range.startStr, weekEnd: range.endStr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- AI: Daily Brief -----

const BRIEF_SYSTEM = (name) => `You write a live Daily Focus briefing for ${name || 'the signed-in user'}, addressed directly to them.

CRITICAL: This is a LIVE check based on the current time, NOT a recap of the whole day. Focus only on:
- What's UPCOMING on your calendar (events starting after now)
- Tasks still open on your My Day list
- Anything time-sensitive that's slipping (overdue, deadline approaching)
- One forward-looking observation: what to prioritize next, what to skip, what's worth pausing for

DO NOT recap events or work already completed. DO NOT mention things in the past. Look forward.

Voice: direct, warm, casual. Like a friend who knows your day. Uses ellipses sometimes; never em-dashes. No corporate tone. No "let's" or "looks like you've got a busy afternoon!" Skip preambles.

Format: 3-4 short key points, each a single crisp sentence — no run-ons, no compound clauses. Each point is a distinct observation. Plain text — no markdown, no bullets, no headers. Write like a briefing card, not a paragraph.

Reference real specifics: names, times, project names. Surface tension if something matters (overdue, soon-due). End with one grounding observation about what's ahead.`;

function chicagoTodayDateLabel() {
  const now = new Date();
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(now);
}

function chicagoTodayISODate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function chicagoNowParts() {
  const now = new Date();
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(now),
    10,
  );
  const timeLabel = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(now);
  let bucket;
  if (hour < 5) bucket = 'late-night';
  else if (hour < 11) bucket = 'morning';
  else if (hour < 14) bucket = 'midday';
  else if (hour < 18) bucket = 'afternoon';
  else if (hour < 22) bucket = 'evening';
  else bucket = 'night';
  return { hour, timeLabel, bucket };
}

const briefCache = new Map();
const BRIEF_TTL_MS = 1000 * 60 * 60 * 2;

// ----- REVIEW (inbox-zero queries) -----

const REVIEW_STALE_DAYS = 14;
const REVIEW_WAITING_DAYS = 7;
// Stale-bucket cutoff: tasks with a due date this far in the future are
// treated as long-term reminders, not actionable-but-neglected work. Keeps
// "scheduled for 2030" reminders out of the stale queue.
const REVIEW_STALE_FUTURE_HORIZON_DAYS = 30;

function daysSince(iso) {
  if (!iso) return Infinity;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// Returns days from Chicago "today" to the given ISO date. Positive = future,
// negative = past, 0 = today. Uses date-only comparison (no time-of-day drift).
function daysUntilDate(iso) {
  if (!iso) return Infinity;
  const todayMs = Date.parse(chicagoTodayISODate() + 'T00:00:00Z');
  const dueMs = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(dueMs)) return Infinity;
  return Math.round((dueMs - todayMs) / 86400000);
}

// Statuses on the Projects DB that count as "live work" for the Review tab.
// Tasks attached to projects outside this set are hidden from the Review queues —
// the review tab is for nudging open work, not surfacing tasks on paused/done projects.
const ACTIVE_PROJECT_STATUSES = new Set(['Active', 'Ongoing']);

async function fetchProjectStatusMap(projectsDs) {
  const map = new Map();
  if (!notion) return map;
  let cursor;
  do {
    const res = await notion.dataSources.query({
      data_source_id: projectsDs,
      page_size: 100,
      start_cursor: cursor,
    });
    res.results.forEach((p) => {
      const status = p.properties?.Status?.status?.name || null;
      map.set(p.id, status);
    });
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return map;
}

// Returns a Set of project page IDs (across both Work + Life projects DBs) whose
// Status is in ACTIVE_PROJECT_STATUSES. Used by the Review tab to filter out
// tasks tied to inactive projects.
async function fetchActiveProjectIds() {
  const [workMap, lifeMap] = await Promise.all([
    fetchProjectStatusMap(WORK_PROJECTS_DS),
    fetchProjectStatusMap(LIFE_PROJECTS_DS),
  ]);
  const activeIds = new Set();
  for (const [id, status] of workMap) if (ACTIVE_PROJECT_STATUSES.has(status)) activeIds.add(id);
  for (const [id, status] of lifeMap) if (ACTIVE_PROJECT_STATUSES.has(status)) activeIds.add(id);
  return activeIds;
}

// Returns true if a task row's properties indicate it's a recurring task or
// already has a future occurrence scheduled — in either case, we hide it from
// the Review tab (recurring tasks self-manage; future-occurrence ones aren't
// actionable yet). Defensive against a few common Notion property spellings.
function isRecurringOrFutureScheduled(props) {
  if (!props) return false;
  // Recurring checkbox — accept both "Recurring?" and "Recurring"
  if (props['Recurring?']?.checkbox) return true;
  if (props['Recurring']?.checkbox) return true;
  // Next Occurrence — accept a few spellings; could be a date, formula, or text field
  const occCandidates = ['Next Occurrence', 'Next occurrence', 'Next Occurence', 'Next occurence'];
  for (const key of occCandidates) {
    const v = props[key];
    if (!v) continue;
    if (v.date?.start) return true;
    if (v.formula?.date?.start) return true;
    if (v.formula?.string && v.formula.string.trim()) return true;
    if (v.formula?.number != null) return true;
    if (Array.isArray(v.rich_text) && v.rich_text.length > 0) return true;
  }
  return false;
}

async function reviewTasksForSource(taskDs, source, peopleProp, activeProjectIds) {
  // Get all open tasks (Status != Done) — already have these helpers
  const data = await queryTasks(taskDs, { peopleProp, myDayOnly: false });
  const rawAll = data.results.map((p) => {
    const props = p.properties || {};
    const due = props.Due?.date || {};
    const projectRel = props.Project?.relation || [];
    return {
      id: p.id,
      name: props.Name?.title?.[0]?.plain_text || '(untitled)',
      source,
      status: props.Status?.status?.name || null,
      dueStart: due.start || null,
      dueEnd: due.end || null,
      priority: props.Priority?.select?.name || null,
      myDay: !!props['My Day']?.checkbox,
      hasProject: projectRel.length > 0,
      projectIds: projectRel.map((r) => r.id),
      projectId: projectRel[0]?.id || null,
      edited: p.last_edited_time || null,
      url: p.url,
      assigneeCount: (props.Assigned?.people || []).length,
      _recurringOrFuture: isRecurringOrFutureScheduled(props),
    };
  });
  // Combined filter:
  //   - Drop recurring or future-scheduled tasks (they aren't actionable here)
  //   - Drop tasks attached only to inactive projects (no-project tasks stay)
  const all = rawAll.filter((t) => {
    if (t._recurringOrFuture) return false;
    if (activeProjectIds && t.hasProject && !t.projectIds.some((id) => activeProjectIds.has(id))) return false;
    return true;
  });
  const todayISO = chicagoTodayISODate();
  const overdue = all.filter((t) => {
    const d = t.dueEnd || t.dueStart;
    return d && d < todayISO && t.status !== 'Done';
  });
  const noProjectNoDue = all.filter((t) => !t.hasProject && !t.dueStart);
  const stale = all.filter((t) => {
    if (daysSince(t.edited) < REVIEW_STALE_DAYS) return false;
    // Skip long-term reminders: anything due 30+ days from now isn't stale,
    // it's just scheduled for later. Reviewing it now is noise.
    const due = t.dueStart || t.dueEnd;
    if (due && daysUntilDate(due) >= REVIEW_STALE_FUTURE_HORIZON_DAYS) return false;
    return true;
  });
  const stuckWaiting = all.filter((t) => t.status === 'Waiting' && daysSince(t.edited) >= REVIEW_WAITING_DAYS);
  // Unassigned only applies to work tasks — personal tasks have no Assigned field.
  const unassigned = source === 'work' ? all.filter((t) => t.assigneeCount === 0) : [];
  return { all, overdue, noProjectNoDue, stale, stuckWaiting, unassigned };
}

app.get('/api/review', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const data = await cached('review', async () => {
      const [activeProjectIds, projects] = await Promise.all([
        cached('active-projects', fetchActiveProjectIds),
        cached('projects-list', fetchActiveProjects),
      ]);
      const nameById = new Map(projects.map((p) => [p.id, p.name]));
      const [work, personal, workAll] = await Promise.all([
        reviewTasksForSource(WORK_TASKS_DS, 'work', 'Assigned', activeProjectIds),
        reviewTasksForSource(LIFE_TASKS_DS, 'personal', null, activeProjectIds),
        // Separate unfiltered query to find work tasks with no assignee at all
        reviewTasksForSource(WORK_TASKS_DS, 'work', null, activeProjectIds),
      ]);
      const combine = (k) => [...work[k], ...personal[k]].map((t) => ({
        ...t,
        project: t.projectId ? (nameById.get(t.projectId) || null) : null,
      }));
      const unassigned = workAll.all
        .filter((t) => t.assigneeCount === 0)
        .map((t) => ({ ...t, project: t.projectId ? (nameById.get(t.projectId) || null) : null }));
      return {
        overdue: combine('overdue'),
        noProjectNoDue: combine('noProjectNoDue'),
        stale: combine('stale'),
        stuckWaiting: combine('stuckWaiting'),
        unassigned,
        thresholds: { staleDays: REVIEW_STALE_DAYS, waitingDays: REVIEW_WAITING_DAYS },
      };
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====== JOURNAL (health rings + streaks) ======
const JOURNAL_TARGETS = {
  protein: 120,   // grams
  sleepHours: 8,  // hours
};

function chicagoToday() {
  // Returns YYYY-MM-DD for today in America/Chicago
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}
function chicagoDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function currentQuarter() {
  // Returns { label, start, end, totalDays, elapsedDays, days[] } for the quarter containing today (Chicago time).
  const todayStr = chicagoToday();
  const [y, m, d] = todayStr.split('-').map(Number);
  const qIdx = Math.floor((m - 1) / 3); // 0,1,2,3
  const startMonth = qIdx * 3;           // 0,3,6,9
  const endMonth = startMonth + 2;       // 2,5,8,11
  const startDate = new Date(y, startMonth, 1);
  const endDate = new Date(y, endMonth + 1, 0); // last day of end month
  const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  const start = fmt(startDate);
  const end = fmt(endDate);
  const totalDays = Math.round((endDate - startDate) / 86400000) + 1;
  const todayDate = new Date(y, m - 1, d);
  const elapsedDays = Math.min(totalDays, Math.round((todayDate - startDate) / 86400000) + 1);
  const days = [];
  for (let i = 0; i < elapsedDays; i++) {
    const dt = new Date(startDate);
    dt.setDate(dt.getDate() + i);
    days.push(fmt(dt));
  }
  return { label: `Q${qIdx+1} ${y}`, start, end, totalDays, elapsedDays, days };
}

function readJournalRow(page) {
  const p = page.properties || {};
  const num = (key) => (p[key]?.number ?? null);
  const dateVal = p.Date?.date?.start || null;
  return {
    id: page.id,
    date: dateVal,
    protein: num('Protein'),
    sleepHours: num('Sleep Hours'),
    walkMinutes: num('Walk Minutes'),
    swimMinutes: num('Swim Minutes'),
    hrv: num('HRV'),
    steps: num('Steps'),
    weight: num('Weight'),
  };
}

async function queryJournalRange(startDate, endDate) {
  if (!notion) return [];
  const filter = {
    and: [
      { property: 'Date', date: { on_or_after: startDate } },
      { property: 'Date', date: { on_or_before: endDate } },
    ],
  };
  const out = [];
  let cursor;
  do {
    const r = await notion.dataSources.query({
      data_source_id: JOURNAL_DS,
      filter,
      sorts: [{ property: 'Date', direction: 'descending' }],
      page_size: 100,
      start_cursor: cursor,
    });
    out.push(...r.results.map(readJournalRow));
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

function blockHasText(block) {
  const textTypes = ['paragraph','heading_1','heading_2','heading_3','bulleted_list_item','numbered_list_item','toggle','quote','callout','to_do'];
  if (!textTypes.includes(block.type)) return false;
  const rt = block[block.type]?.rich_text || [];
  return rt.some((t) => (t.plain_text || '').trim().length > 0);
}

async function pageHasBodyText(pageId) {
  try {
    // Page size 50 is plenty — we only need to know if ANY block has text
    const r = await notion.blocks.children.list({ block_id: pageId, page_size: 50 });
    return r.results.some(blockHasText);
  } catch (err) {
    return false;
  }
}

async function attachJournalBodyFlags(rows) {
  const CONCURRENCY = 6;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((r) => pageHasBodyText(r.id)));
    chunk.forEach((r, j) => { r.hasBody = results[j]; });
  }
}

function calculateStreak(rows, predicate) {
  // rows are sorted descending by date. Walk from today backwards.
  const byDate = new Map(rows.filter(r => r.date).map(r => [r.date, r]));
  let streak = 0;
  for (let i = 0; ; i++) {
    const d = chicagoDateNDaysAgo(i);
    const row = byDate.get(d);
    const hit = predicate(row);
    if (hit) streak++;
    else if (i === 0 && !row) {
      // today hasn't been logged yet — don't break the streak; just skip
      continue;
    } else break;
    if (i > 365) break; // safety cap
  }
  return streak;
}

app.get('/api/journal/rings', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const data = await cached('journal-rings', async () => {
      const quarter = currentQuarter();
      const endDate = chicagoToday();
      // Fetch from quarter start (or 90d back, whichever is earlier) through today
      const ninetyAgo = chicagoDateNDaysAgo(90);
      const startDate = quarter.start < ninetyAgo ? quarter.start : ninetyAgo;
      const rows = await queryJournalRange(startDate, endDate);
      // Attach hasBody flag to every row (parallel, concurrency-capped)
      await attachJournalBodyFlags(rows);
      const today = rows.find(r => r.date === endDate) || null;

      const streaks = {
        walking:  calculateStreak(rows, r => r && (r.walkMinutes || 0) > 0),
        swimming: calculateStreak(rows, r => r && (r.swimMinutes || 0) > 0),
        journal:  calculateStreak(rows, r => r && r.hasBody),
        protein:  calculateStreak(rows, r => r && (r.protein || 0) >= JOURNAL_TARGETS.protein),
        sleep:    calculateStreak(rows, r => r && (r.sleepHours || 0) >= JOURNAL_TARGETS.sleepHours),
      };

      // Quarter day-by-day series + attainment
      const byDate = new Map(rows.filter(r => r.date).map(r => [r.date, r]));
      const series = quarter.days.map(d => {
        const r = byDate.get(d) || null;
        return {
          date: d,
          protein: r?.protein ?? null,
          sleepHours: r?.sleepHours ?? null,
          walkMinutes: r?.walkMinutes ?? null,
          swimMinutes: r?.swimMinutes ?? null,
          hrv: r?.hrv ?? null,
          logged: !!r,
          hasBody: !!r?.hasBody,
        };
      });
      const hit = (test) => series.filter(test).length;
      const attainment = {
        protein:  { hit: hit(d => (d.protein || 0) >= JOURNAL_TARGETS.protein), days: series.length },
        sleep:    { hit: hit(d => (d.sleepHours || 0) >= JOURNAL_TARGETS.sleepHours), days: series.length },
        walking:  { hit: hit(d => (d.walkMinutes || 0) > 0), days: series.length },
        swimming: { hit: hit(d => (d.swimMinutes || 0) > 0), days: series.length },
        journal:  { hit: hit(d => d.hasBody), days: series.length },
      };
      const hrvValsQ = series.filter(d => d.hrv != null).map(d => d.hrv);
      const hrvQuarter = hrvValsQ.length ? {
        avg: Math.round(hrvValsQ.reduce((a,b) => a+b, 0) / hrvValsQ.length),
        min: Math.min(...hrvValsQ),
        max: Math.max(...hrvValsQ),
        count: hrvValsQ.length,
      } : null;

      // Last 7 days for HRV sparkline (the today card)
      const last7 = [];
      for (let i = 0; i < 7; i++) {
        const d = chicagoDateNDaysAgo(i);
        const row = byDate.get(d) || null;
        last7.push({ date: d, hrv: row?.hrv ?? null });
      }
      const hrvValues = last7.filter(d => d.hrv != null).map(d => d.hrv);
      const hrvAvg7 = hrvValues.length ? Math.round(hrvValues.reduce((a,b) => a+b, 0) / hrvValues.length) : null;

      return {
        today,
        streaks,
        targets: JOURNAL_TARGETS,
        hrv: { today: today?.hrv ?? null, avg7: hrvAvg7, trend: last7, quarter: hrvQuarter },
        quarter: {
          label: quarter.label,
          start: quarter.start,
          end: quarter.end,
          totalDays: quarter.totalDays,
          elapsedDays: quarter.elapsedDays,
          series,
          attainment,
        },
      };
    });
    res.json(data);
  } catch (err) {
    console.error('Journal rings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function findOrCreateTodayRow() {
  const today = chicagoToday();
  const existing = await notion.dataSources.query({
    data_source_id: JOURNAL_DS,
    filter: { property: 'Date', date: { equals: today } },
    page_size: 1,
  });
  if (existing.results.length) return existing.results[0];
  // Build "YYYY-MM-DD Dayname" title
  const d = new Date(today + 'T12:00:00');
  const dayName = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' });
  const title = `${today} ${dayName}`;
  const created = await notion.pages.create({
    parent: { type: 'data_source_id', data_source_id: JOURNAL_DS },
    properties: {
      Title: { title: [{ text: { content: title } }] },
      Date: { date: { start: today } },
    },
  });
  return created;
}

app.patch('/api/journal/today', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const body = req.body || {};
  const FIELD_MAP = {
    protein: 'Protein',
    sleepHours: 'Sleep Hours',
    walkMinutes: 'Walk Minutes',
    swimMinutes: 'Swim Minutes',
    hrv: 'HRV',
    steps: 'Steps',
    weight: 'Weight',
  };
  const properties = {};
  for (const [key, propName] of Object.entries(FIELD_MAP)) {
    if (body[key] !== undefined) {
      const v = body[key];
      properties[propName] = { number: (v === '' || v === null) ? null : Number(v) };
    }
  }
  if (Object.keys(properties).length === 0) {
    return res.status(400).json({ error: 'no recognized fields in body' });
  }
  try {
    const row = await findOrCreateTodayRow();
    await notion.pages.update({ page_id: row.id, properties });
    cache.delete('journal-rings');
    res.json({ ok: true, id: row.id });
  } catch (err) {
    console.error('Journal update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ====== RITUAL state (cross-device sync via JOURNAL row) ======
// Today's morning/evening ritual checklists stored as JSON blobs in
// rich-text properties on today's JOURNAL row, plus a sibling Checkbox
// property that auto-flips when ALL configured steps are checked.
//
// Required JOURNAL properties:
//   - "Morning Ritual" (Text)        "Morning Done" (Checkbox)
//   - "Evening Ritual" (Text)        "Evening Done" (Checkbox)

const RITUAL_CONFIGS = {
  morning: {
    textProp: 'Morning Routine',
    doneProp: 'Morning Done',
    steps: ['birthdays', 'inboxes', 'notionComments', 'slackMessages', 'reviewCalendar', 'braindump', 'sequence', 'checkin', 'linkedinComments', 'marketing', 'salesTouchpoints'],
  },
  evening: {
    textProp: 'Evening Routine',
    doneProp: 'Evening Done',
    steps: ['sales', 'projectTime', 'captures', 'meals', 'journal', 'exercise'],
  },
};

function readRitualFromPage(page, ritualName) {
  const cfg = RITUAL_CONFIGS[ritualName];
  if (!cfg) return {};
  const prop = page?.properties?.[cfg.textProp];
  if (!prop || prop.type !== 'rich_text') return {};
  const txt = (prop.rich_text || []).map(r => r.plain_text || '').join('');
  if (!txt.trim()) return {};
  try { return JSON.parse(txt); } catch (e) { return {}; }
}

function ritualStateProperty(state, ritualName) {
  const cfg = RITUAL_CONFIGS[ritualName];
  if (!cfg) return {};
  const json = JSON.stringify(state || {});
  const allDone = cfg.steps.every((k) => !!state?.[k]);
  return {
    [cfg.textProp]: { rich_text: [{ text: { content: json } }] },
    [cfg.doneProp]: { checkbox: allDone },
  };
}

app.get('/api/ritual/today', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const today = chicagoToday();
    const existing = await notion.dataSources.query({
      data_source_id: JOURNAL_DS,
      filter: { property: 'Date', date: { equals: today } },
      page_size: 1,
    });
    if (!existing.results.length) {
      return res.json({ morning: {}, evening: {}, dayHasRow: false });
    }
    const row = existing.results[0];
    res.json({
      morning: readRitualFromPage(row, 'morning'),
      evening: readRitualFromPage(row, 'evening'),
      dayHasRow: true,
      hasMorningProperty: !!row.properties?.['Morning Routine'],
      hasEveningProperty: !!row.properties?.['Evening Routine'],
    });
  } catch (err) {
    console.error('Ritual GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/ritual/today', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const ritualName = (req.query.ritual || 'morning').toLowerCase();
  if (!RITUAL_CONFIGS[ritualName]) {
    return res.status(400).json({ error: `unknown ritual: ${ritualName}` });
  }
  const { state } = req.body || {};
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'state object required' });
  try {
    const row = await findOrCreateTodayRow();
    await notion.pages.update({ page_id: row.id, properties: ritualStateProperty(state, ritualName) });
    res.json({ ok: true });
  } catch (err) {
    console.error('Ritual PATCH error:', err.message);
    const propName = RITUAL_CONFIGS[ritualName].textProp;
    const doneName = RITUAL_CONFIGS[ritualName].doneProp;
    const hint = (err.message.includes(propName) || err.message.includes(doneName))
      ? `Add "${propName}" (Text) and "${doneName}" (Checkbox) properties to your JOURNAL DB.`
      : undefined;
    res.status(500).json({ error: err.message, hint });
  }
});

async function fetchActiveProjects() {
  if (!notion) return [];
  // Page through every non-archived project so a task's project can always be
  // resolved by id (the DBs can exceed Notion's 100-row page limit).
  const allPages = async (dsId) => {
    const out = [];
    let cursor;
    do {
      const res = await notion.dataSources.query({
        data_source_id: dsId,
        filter: { property: 'Archived', checkbox: { equals: false } },
        page_size: 100,
        start_cursor: cursor,
      }).catch(() => ({ results: [], has_more: false }));
      out.push(...(res.results || []));
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    return out;
  };
  const [work, life] = await Promise.all([
    allPages(WORK_PROJECTS_DS),
    allPages(LIFE_PROJECTS_DS),
  ]);
  const map = (p, source) => ({ id: p.id, source, name: p.properties.Name?.title?.[0]?.plain_text || '(untitled)', status: p.properties.Status?.status?.name || null });
  return [
    ...work.map((p) => map(p, 'work')),
    ...life.map((p) => map(p, 'personal')),
  ];
}

async function gatherTodayContext() {
  // Only the owner (personal enabled) gets personal/life context. Members see
  // work only, so the owner's personal tasks/goals never bleed into their brief.
  // No request context (background jobs) → treat as owner/full.
  const u = currentUser();
  const personalOn = u ? !!u.personal_enabled : true;
  const [calEvents, workMyDay, lifeMyDay, goals] = await Promise.all([
    Promise.all(configuredAccounts().map((a) => fetchToday(a).catch(() => []))).then((r) => r.flat()),
    workTasks({ myDayOnly: true }).catch(() => []),
    personalOn ? lifeTasks({ myDayOnly: true }).catch(() => []) : Promise.resolve([]),
    cached('goals', async () => {
      const [w, l] = await Promise.all([
        fetchGoalsForSource(WORK_PROJECTS_DS, WORK_TASKS_DS, 'work', 'Project'),
        fetchGoalsForSource(LIFE_PROJECTS_DS, LIFE_TASKS_DS, 'personal', 'Project'),
      ]);
      return [...w, ...l];
    }).catch(() => []),
  ]);
  const scopedGoals = personalOn ? goals : goals.filter((g) => g.source === 'work');
  return { calEvents, workMyDay, lifeMyDay, goals: scopedGoals };
}

function buildBriefUserPrompt({ calEvents, workMyDay, lifeMyDay, goals }) {
  const dateLabel = chicagoTodayDateLabel();
  const { timeLabel } = chicagoNowParts();
  const nowMs = Date.now();
  const upcoming = [];
  const past = [];
  for (const e of calEvents) {
    if (e.allDay) {
      upcoming.push(e);
      continue;
    }
    const endMs = new Date(e.end || e.start).getTime();
    if (endMs > nowMs) upcoming.push(e);
    else past.push(e);
  }
  const fmtEvent = (e) => {
    const start = e.allDay
      ? 'all-day'
      : new Date(e.start).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    return `  - ${start} [${e.account}] ${e.title}${e.location ? ` (${e.location})` : ''}`;
  };
  const upcomingLines = upcoming.map(fmtEvent);
  const pastSummary = past.length ? `(${past.length} earlier event${past.length === 1 ? '' : 's'} already done — do not mention)` : '';
  const taskLine = (t) => `  - [${t.source}] ${t.name}${t.dueStart ? ` (due ${t.dueStart})` : ''}${t.priority ? ` [${t.priority}]` : ''}`;
  const isWaiting = (t) => t.status === 'Waiting';
  // queryTasks(myDayOnly) also returns tasks completed today (so the plan can
  // show them struck-through). They're done — never surface them in the brief's
  // forward-looking ACTIONABLE buckets, or it'll tell her to do finished work.
  const isDone = (t) => t.status === 'Done';
  const workActionable = workMyDay.filter((t) => !isWaiting(t) && !isDone(t));
  const workWaiting = workMyDay.filter((t) => isWaiting(t) && !isDone(t));
  const lifeActionable = lifeMyDay.filter((t) => !isWaiting(t) && !isDone(t));
  const lifeWaiting = lifeMyDay.filter((t) => isWaiting(t) && !isDone(t));
  const goalsLines = goals.map((g) => {
    const pct = g.progress.total ? Math.round((g.progress.done / g.progress.total) * 100) : 0;
    return `  - [${g.source}] ${g.name} — ${g.progress.done}/${g.progress.total} milestones (${pct}%)${g.targetDeadline ? `, target ${g.targetDeadline}` : ''}`;
  });
  const waitingTotal = workWaiting.length + lifeWaiting.length;
  return [
    `It is ${dateLabel} — ${timeLabel} (America/Chicago).`,
    '',
    `UPCOMING events (after now) (${upcoming.length}):`,
    upcomingLines.length ? upcomingLines.join('\n') : '  (nothing left on the calendar today)',
    pastSummary,
    '',
    `Work ACTIONABLE tasks — Doing/Planned/Agenda (${workActionable.length}):`,
    workActionable.length ? workActionable.map(taskLine).join('\n') : '  (none)',
    '',
    `Personal ACTIONABLE tasks (${lifeActionable.length}):`,
    lifeActionable.length ? lifeActionable.map(taskLine).join('\n') : '  (none)',
    '',
    `WAITING-ON tasks (${waitingTotal}) — blocked on someone else, DO NOT nudge her to action these. At most: suggest a follow-up nudge if it's been a while.`,
    waitingTotal ? [...workWaiting, ...lifeWaiting].map(taskLine).join('\n') : '  (none)',
    '',
    `Active goals (${goals.length}):`,
    goalsLines.length ? goalsLines.join('\n') : '  (none flagged)',
    '',
    'Write the Daily Focus. Look forward, not back. Only mention tasks from the ACTIONABLE buckets as things to do today. The WAITING-ON tasks are blocked — never tell her to do them; you may suggest a brief follow-up nudge if relevant.',
  ].join('\n');
}

async function dailyFocusHandler(req, res) {
  if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const today = chicagoTodayISODate();
  const { bucket } = chicagoNowParts();
  const force = req.query.force === '1' || req.query.force === 'true';
  // Scope the cache per signed-in user so one person's focus (and their calendar/
  // tasks) is never served to another.
  const u = currentUser();
  const userKey = u ? (u.id || u.email) : 'anon';
  const cacheKey = `focus-${today}-${bucket}-${userKey}`;
  if (!force) {
    const hit = briefCache.get(cacheKey);
    if (hit && Date.now() - hit.t < BRIEF_TTL_MS) {
      return res.json({ brief: hit.v, cached: true, ts: hit.t, bucket });
    }
  }
  try {
    const ctx = await gatherTodayContext();
    const userPrompt = buildBriefUserPrompt(ctx);
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 600,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: BRIEF_SYSTEM(u?.name),
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    briefCache.set(cacheKey, { v: text, t: Date.now() });
    res.json({ brief: text, cached: false, ts: Date.now(), bucket });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
app.get('/api/ai/daily-focus', dailyFocusHandler);
app.get('/api/ai/daily-brief', dailyFocusHandler); // legacy alias

// ----- AI: Triage (braindump → plan → apply) -----

const TRIAGE_SYSTEM = `You are Gretchen's AI assistant embedded in her LifeOS dashboard. You're a general-purpose AI like Claude itself — you can answer ANY question she has, not just questions about her dashboard data. Use your own knowledge freely.

On top of general capability, you have three LifeOS-specific powers:

1. CAPTURE — turn her input into a structured plan of tasks/events she reviews and applies.
2. SEARCH — find specific projects, tasks, calendar events, or context from the data in this prompt.
3. ANSWER — respond to questions, help her think through things, summarize what's on her plate.

If she asks a general question (definitions, how-to, opinions, code, anything) — just answer it like Claude would. Don't apologize that the topic isn't in her LifeOS data; that's not the bar. Only mention LifeOS data when the question is specifically about her work, her schedule, her projects, or her tasks. Web research is not available — if you genuinely don't know something current, say so briefly.

Context about Gretchen:
- Integrator at Left Right Labs (LRL). Work tasks → WORK TASKS [DB]. Personal/life tasks → LifeOS TASKS.
- Two calendars: work (leftrightlabs.com) and personal.

Voice: direct, warm, casual. Like a friend who knows her day. Ellipses fine, never em-dashes. No corporate tone, no "I'll help you with that", no "Great question!". Skip preambles.

How to decide the response shape:

- If she's asking a QUESTION or asking you to FIND something ("find my bluebonnets project", "what's on my list today", "where's that task about X", "summarize my week") — put your COMPLETE answer in "intro" (multi-line is fine — use \\n for line breaks inside the JSON string). Reference specifics from the context. When you reference a project, include its Notion link in the form https://www.notion.so/leftrightlabs/<id-without-dashes>. Leave "actions" empty for pure queries.

CRITICAL: Your entire response must be ONE JSON object and NOTHING else — no markdown after it, no commentary, no follow-up questions outside the JSON. If you want to ask a follow-up question or list items in a structured way, put that text INSIDE the "intro" string with \\n line breaks.
- If she's CAPTURING new things ("add a task to...", "schedule...", "remind me to..."), keep "intro" short ("Got it...", "On the list...") and emit one action per discrete intent in "actions".
- If she's doing BOTH (e.g. "what's my next milestone on Rock 1 and add a task to do it"), do both — meaningful intro answer + relevant actions.

Action types you can emit:
- create_project: a new Notion project (in the work SYSTEMS or personal FOCUS database). source = "work" or "personal". Required: name. Use this when she says things like "set up a project for X" or "create a course / launch / build / area called Y". A project is a container for related tasks (vs. a single task).
- create_task: a new Notion task. source = "work" or "personal". Required: name. Optional: dueStart (YYYY-MM-DD), myDay (boolean), priority ("URGENT" | "HIGH" | "MEDIUM" | "LOW" | null), projectId (uuid from the project list), projectRef (string — the exact "name" of a create_project action earlier in this same plan; the server resolves it to the new project's id after creation), status ("Planned" | "Doing" | "Waiting" | "Agenda" | "Done" — defaults to Planned), body (string — appears as paragraph(s) in the Notion task page body; use this to preserve email context, URLs, or notes. Plain text only, separate paragraphs with blank lines).
- update_task: change fields on an existing Notion task. Required: taskId (uuid from ALL OPEN TASKS context — use the EXACT id shown). Optional: dueStart (YYYY-MM-DD, or empty string "" to clear), dueEnd, myDay (boolean), priority ("URGENT" | "HIGH" | "MEDIUM" | "LOW"), status ("Done" | "Doing" | "Planned" | "Agenda" | "Waiting"), name (string).
- create_event: a calendar event. account = "work" or "personal". Required: title, start, end. If allDay=true, start/end are YYYY-MM-DD; otherwise ISO datetime with America/Chicago offset (-05:00 CDT or -06:00 CST). location optional.

For "create a project + add these tasks to it" patterns, emit create_project FIRST, then create_task actions with projectRef set to the project's name (exact string match, case-insensitive). The apply step links them automatically.

For update_task: she'll often say things like "move X to next Friday" or "push the dentist appointment to next week" or "reset the date on Y". Find the matching task in ALL OPEN TASKS by name match, use its exact taskId.

Routing heuristics:
- LRL/clients/business/marketing/work-finance → "work"
- Health/LEGO/household/family/personal finance/errands → "personal"
- If unclear, prefer "personal"

Email handling:
- The INBOX section in the dynamic context lists recent unread emails from her Gmail (subject, sender, snippet, URL). You CAN read these — they are real emails she has.
- When she says things like "turn these emails into tasks", "add the bricklink orders as waiting tasks", "make a follow-up from this email", use the actual subject/sender/snippet from the INBOX. Do NOT use placeholder text like "Email from #1".
- Match emails by sender, subject keyword, or recency as she describes them. If she says "the two bricklink emails", look for INBOX entries with "bricklink" in sender or subject.
- When creating a task from an email, ALWAYS include the body field with: subject line, sender, the email URL (so she can click through), and the snippet if useful. Format the body as plain text, multi-line. Example body value: "From: BrickLink <noreply@bricklink.com>\\nSubject: Order #5012345 confirmed\\n\\nhttps://mail.google.com/mail/u/0/#inbox/188abc\\n\\nSnippet: Your order from PartsKing has been confirmed and is being prepared..."
- If she's creating a waiting/follow-up task from an email, set status: "Waiting".

My Day defaults to false. Set true only if she signals today/tomorrow or time-sensitivity.
Priority defaults to null. Only set MEDIUM/HIGH/URGENT if she signals priority. Use URGENT for today/critical, HIGH for this week, MEDIUM for general importance.
Date parsing: "tomorrow", "Friday", "next week" — anchor to today's date.

Each action gets a short "label" (e.g. "Task: Email Trina about Rock 3 → work, due Fri Jun 12, My Day").

Be conservative on captures. If she dumps 12 thoughts, emit 12 actions — don't bundle. If something is ambiguous, skip it.
Be helpful on queries. If she asks something and you don't have the data, say so plainly.`;

const TRIAGE_JSON_HINT = `Return ONLY valid JSON in this exact shape, no prose, no markdown, no code fences:
{
  "intro": "one sentence, warm casual tone",
  "actions": [
    { "type": "create_project", "label": "short summary", "source": "work"|"personal", "name": "project name" },
    { "type": "create_task", "label": "short summary", "source": "work"|"personal", "name": "task name", "dueStart": "YYYY-MM-DD" (optional), "myDay": true|false (optional), "priority": "URGENT"|"HIGH"|"MEDIUM"|"LOW" (optional), "status": "Planned"|"Doing"|"Waiting"|"Agenda" (optional, default Planned), "projectId": "uuid" (optional), "projectRef": "exact name of a create_project in this same plan" (optional), "body": "optional multi-line plain text — email link, notes, context" },
    { "type": "update_task", "label": "short summary of what's changing", "taskId": "exact uuid from ALL OPEN TASKS", "dueStart": "YYYY-MM-DD"|"" (optional), "myDay": true|false (optional), "priority": "URGENT"|"HIGH"|"MEDIUM"|"LOW" (optional), "status": "Done"|"Doing"|"Planned"|"Agenda"|"Waiting" (optional), "name": "new name" (optional) },
    { "type": "create_event", "label": "short summary", "account": "work"|"personal", "title": "event title", "start": "ISO datetime with TZ offset, or YYYY-MM-DD if allDay", "end": "same format", "allDay": true|false (optional), "location": "optional string" }
  ]
}`;

app.post('/api/ai/triage', async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { text, history } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const todayLabel = chicagoTodayDateLabel();
    const todayISO = chicagoTodayISODate();
    const projects = await cached('triage-projects', fetchActiveProjects);
    const ctx = await gatherTodayContext();
    const allOpenTasks = await cached('tasks-all', async () => {
      const [w, l] = await Promise.all([
        workTasks({ myDayOnly: false }),
        lifeTasks({ myDayOnly: false }),
      ]);
      return [...w, ...l];
    });
    // Gmail inbox for capture — wider scope than the Comms tab. We pull recent
    // inbox messages (read or unread, last 30d, up to 50 per account) so the
    // model can find emails she's already opened, like order confirmations or
    // older threads. Distinct cache key from 'gmail-inbox' so the Comms tab
    // keeps its tighter unread-last-7d view.
    const gmailThreads = await cached('gmail-capture', async () => {
      const accounts = configuredAccounts();
      if (!accounts.length) return [];
      const results = await Promise.all(
        accounts.map((a, i) => fetchInbox(a, i, {
          q: 'in:inbox newer_than:30d',
          maxResults: 50,
        }).catch((err) => {
          console.error(`Gmail ${a} error (triage):`, err.message);
          return [];
        })),
      );
      return results.flat().sort((a, b) => (b.internalDate || 0) - (a.internalDate || 0));
    }).catch(() => []);
    const workProjects = projects.filter((p) => p.source === 'work');
    const lifeProjects = projects.filter((p) => p.source === 'personal');
    const projectList = [
      'PROJECTS (use these IDs when assigning tasks; also use to answer search questions):',
      'Work:',
      ...workProjects.map((p) => `  - ${p.id}: ${p.name}`),
      'Personal:',
      ...lifeProjects.map((p) => `  - ${p.id}: ${p.name}`),
    ].join('\n');
    const calendarLines = ctx.calEvents.map((e) => {
      const t = e.allDay ? 'all-day' : new Date(e.start).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
      return `  - ${t} [${e.account}] ${e.title}`;
    });
    const myDayLines = [...ctx.workMyDay, ...ctx.lifeMyDay].map((t) => `  - [${t.source}] ${t.name}${t.dueStart ? ` (due ${t.dueStart})` : ''}`);
    const goalLines = ctx.goals.map((g) => `  - [${g.source}] ${g.name} — ${g.progress.done}/${g.progress.total} milestones`);
    const allTaskLines = allOpenTasks.slice(0, 300).map((t) => `  - id=${t.id} [${t.source}] ${t.name}${t.dueStart ? ` · due ${t.dueStart}` : ''}${t.status && t.status !== 'Planned' ? ` · ${t.status}` : ''}${t.myDay ? ' · MyDay' : ''}`);

    // STATIC context — cached. Stable across many turns; only changes when projects/tasks change in Notion.
    const staticContext = [
      TRIAGE_SYSTEM,
      '',
      projectList,
      '',
      `ALL OPEN TASKS (${allOpenTasks.length}):`,
      allTaskLines.join('\n'),
      '',
      TRIAGE_JSON_HINT,
    ].join('\n');

    const inboxLines = gmailThreads.slice(0, 50).map((t) => {
      const from = (t.fromName && t.fromName !== t.fromEmail) ? `${t.fromName} <${t.fromEmail || ''}>` : (t.fromEmail || '?');
      const subj = (t.subject || '(no subject)').slice(0, 140);
      const snip = (t.snippet || '').slice(0, 160);
      const when = t.internalDate ? new Date(t.internalDate).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }) : '';
      return `  - [${t.account}]${when ? ` ${when}` : ''} from: ${from} · subject: "${subj}"${snip ? ` · snippet: ${snip}` : ''} · url: ${t.url}`;
    });
    // DYNAMIC context — varies each request. Today's date, calendar, my-day, goals, inbox + user input.
    const dynamicContext = [
      `Today is ${todayLabel} (${todayISO}).`,
      '',
      `TODAY'S CALENDAR (${ctx.calEvents.length}):`,
      calendarLines.length ? calendarLines.join('\n') : '  (nothing scheduled)',
      '',
      `TODAY'S MY DAY (${ctx.workMyDay.length + ctx.lifeMyDay.length}):`,
      myDayLines.length ? myDayLines.join('\n') : '  (none)',
      '',
      `ACTIVE GOALS (${ctx.goals.length}):`,
      goalLines.length ? goalLines.join('\n') : '  (none)',
      '',
      `INBOX — recent emails (read or unread), last 30 days (${gmailThreads.length}):`,
      inboxLines.length ? inboxLines.join('\n') : '  (no recent inbox messages, or Gmail not configured)',
      '',
      `Gretchen's input:\n"""\n${text.trim()}\n"""`,
    ].join('\n');
    // Build message history: prior turns (user/assistant pairs) + new user message
    const priorMessages = Array.isArray(history) ? history.filter(
      m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()
    ).map(m => ({ role: m.role, content: m.content })) : [];
    const messages = [...priorMessages, { role: 'user', content: dynamicContext }];
    console.log('[ai/triage debug] system len:', staticContext.length, 'messages len:', messages.length, 'last msg type:', typeof messages[messages.length-1].content);
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: staticContext, cache_control: { type: 'ephemeral' } }],
      messages,
    }).catch(err => {
      console.error('[ai/triage] anthropic error:', err.message, err.status);
      throw err;
    });
    if (msg.usage) {
      console.log(`[ai/triage] usage: input=${msg.usage.input_tokens} cache_read=${msg.usage.cache_read_input_tokens || 0} cache_write=${msg.usage.cache_creation_input_tokens || 0} output=${msg.usage.output_tokens}`);
    }
    const textBlock = msg.content.find((b) => b.type === 'text');
    if (!textBlock) return res.status(500).json({ error: 'no text in response' });
    let raw = textBlock.text.trim();
    // Strip code fences if model added them
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    // Defensive: extract just the first top-level JSON object (in case model added extra prose)
    function extractFirstJson(s) {
      const start = s.indexOf('{');
      if (start < 0) return null;
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (c === '\\') { esc = true; continue; }
          if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
      }
      return null;
    }
    const jsonStr = extractFirstJson(raw) || raw;
    let plan;
    try { plan = JSON.parse(jsonStr); }
    catch (e) {
      // Model returned prose instead of JSON — show it as a conversational reply rather than 500-ing
      if (!raw.trim().startsWith('{')) { plan = { intro: raw.trim(), actions: [] }; }
      else { return res.status(500).json({ error: 'invalid JSON from model: ' + e.message, raw }); }
    }
    const u = msg.usage || {};
    res.json({ plan, projects, _usage: {
      input_tokens: u.input_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
      output_tokens: u.output_tokens,
    }});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const TASK_DS_BY_SOURCE = { work: WORK_TASKS_DS, personal: LIFE_TASKS_DS };
const PROJECT_DS_BY_SOURCE = { work: WORK_PROJECTS_DS, personal: LIFE_PROJECTS_DS };
const PROJECT_PROP_BY_SOURCE = { work: 'Project', personal: 'Project' };

async function createNotionProject({ source, name }) {
  const dsId = PROJECT_DS_BY_SOURCE[source];
  if (!dsId) throw new Error(`unknown source: ${source}`);
  if (!name) throw new Error('name is required');
  const page = await notion.pages.create({
    parent: { type: 'data_source_id', data_source_id: dsId },
    properties: {
      Name: { title: [{ text: { content: name } }] },
    },
  });
  return { id: page.id, name, url: page.url };
}

async function createNotionTask({ source, name, dueStart, dueEnd, myDay, priority, projectId, body, status, estHours }) {
  const dsId = TASK_DS_BY_SOURCE[source];
  if (!dsId) throw new Error(`unknown source: ${source}`);
  const properties = {
    Name: { title: [{ text: { content: name } }] },
    Status: { status: { name: status || 'Planned' } },
  };
  if (myDay) properties['My Day'] = { checkbox: true };
  if (dueStart) properties.Due = { date: { start: dueStart, end: dueEnd || null } };
  if (priority) properties['Priority'] = { select: { name: priority } };
  // Est Hours only exists on the work DB — guard so a personal create can't 400.
  if (source === 'work' && estHours !== undefined && estHours !== null && estHours !== '') {
    const n = Number(estHours);
    if (Number.isFinite(n)) properties['Est Hours'] = { number: n };
  }
  if (projectId) properties.Project = { relation: [{ id: projectId }] };
  if (source === 'work') {
    const nid = currentNotionUserId();
    if (nid) properties.Assigned = { people: [{ id: nid }] };
  }
  const createArgs = {
    parent: { type: 'data_source_id', data_source_id: dsId },
    properties,
  };
  // If body is provided (e.g. email context, notes, links), drop it onto the
  // page as paragraph blocks. Split on blank lines so multi-paragraph bodies
  // render cleanly in Notion. Each paragraph capped at Notion's text limit.
  if (body && String(body).trim()) {
    const paragraphs = String(body).trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    createArgs.children = paragraphs.map((p) => ({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: p.slice(0, 1900) } }],
      },
    }));
  }
  const page = await notion.pages.create(createArgs);
  return { id: page.id, url: page.url };
}

async function updateNotionTask({ taskId, name, status, dueStart, dueEnd, myDay, priority }) {
  if (!taskId) throw new Error('taskId is required');
  const properties = {};
  if (name !== undefined && name !== null) properties.Name = { title: [{ text: { content: name } }] };
  if (status !== undefined && status !== null) properties.Status = { status: { name: status } };
  if (dueStart !== undefined) {
    properties.Due = dueStart ? { date: { start: dueStart, end: dueEnd || null } } : { date: null };
  }
  if (myDay !== undefined && myDay !== null) properties['My Day'] = { checkbox: !!myDay };
  if (priority !== undefined && priority !== null) properties['Priority'] = priority ? { select: { name: priority } } : { select: null };
  if (!Object.keys(properties).length) throw new Error('no fields to update');
  await notion.pages.update({ page_id: taskId, properties });
  return { id: taskId, url: `https://www.notion.so/leftrightlabs/${taskId.replace(/-/g, '')}` };
}

async function createCalendarEvent({ account, title, start, end, allDay, location }) {
  const auth = authedClient(account);
  if (!auth) throw new Error(`account not configured: ${account}`);
  const cal = google.calendar({ version: 'v3', auth });
  const body = {
    summary: title,
    location: location || undefined,
    start: allDay ? { date: start } : { dateTime: start, timeZone: TZ },
    end: allDay ? { date: end } : { dateTime: end, timeZone: TZ },
  };
  const { data } = await cal.events.insert({ calendarId: 'primary', requestBody: body });
  return { id: data.id, url: data.htmlLink };
}

async function updateCalendarEvent({ account, id, title, start, end, allDay, location }) {
  const auth = authedClient(account);
  if (!auth) throw new Error(`account not configured: ${account}`);
  const cal = google.calendar({ version: 'v3', auth });
  const patch = {};
  if (title !== undefined) patch.summary = title;
  if (location !== undefined) patch.location = location || null;
  if (start !== undefined || end !== undefined || allDay !== undefined) {
    // For any time-related change, fetch the existing event so we keep whichever
    // side wasn't explicitly passed (start or end or allDay).
    const { data: existing } = await cal.events.get({ calendarId: 'primary', eventId: id });
    const isAllDay = allDay !== undefined ? !!allDay : !!existing.start?.date;
    const finalStart = start !== undefined ? start : (existing.start?.dateTime || existing.start?.date);
    const finalEnd = end !== undefined ? end : (existing.end?.dateTime || existing.end?.date);
    patch.start = isAllDay ? { date: finalStart } : { dateTime: finalStart, timeZone: TZ };
    patch.end = isAllDay ? { date: finalEnd } : { dateTime: finalEnd, timeZone: TZ };
  }
  const { data } = await cal.events.patch({ calendarId: 'primary', eventId: id, requestBody: patch });
  return { id: data.id, url: data.htmlLink };
}

async function deleteCalendarEvent({ account, id }) {
  const auth = authedClient(account);
  if (!auth) throw new Error(`account not configured: ${account}`);
  const cal = google.calendar({ version: 'v3', auth });
  await cal.events.delete({ calendarId: 'primary', eventId: id });
  return { id, deleted: true };
}

app.post('/api/calendar/events/:account', async (req, res) => {
  const { account } = req.params;
  try {
    const r = await createCalendarEvent({ ...req.body, account });
    cache.delete('calendar-today');
    res.json(r);
  } catch (err) {
    console.error('Calendar create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/calendar/events/:account/:id', async (req, res) => {
  const { account, id } = req.params;
  try {
    const r = await updateCalendarEvent({ ...req.body, account, id });
    cache.delete('calendar-today');
    res.json(r);
  } catch (err) {
    console.error('Calendar update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/calendar/events/:account/:id', async (req, res) => {
  const { account, id } = req.params;
  try {
    const r = await deleteCalendarEvent({ account, id });
    cache.delete('calendar-today');
    res.json(r);
  } catch (err) {
    console.error('Calendar delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ====== DAILY SLACK CHECK-IN ======
// Mirrors the "Daily Check-In" skill: aggregates today's calendar + MY DAY tasks
// into a formatted message, then posts to #lrl_team via Slack bot token.

const CHECKIN_EXCLUDE_TITLES = [
  'admin', 'finances', 'stand up rock review', 'lrl l10', 'focus sprint',
];
const LRL_DOMAIN = '@leftrightlabs.com';
const CHECKIN_SLACK_CHANNEL = process.env.SLACK_CHECKIN_CHANNEL || 'CT32H7ATS'; // #lrl_team

function fmtCheckinTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  // "1:00 PM" — no leading zero, no timezone suffix
  return d.toLocaleTimeString('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

async function checkinFetchCalendar() {
  const auth = authedClient('work');
  if (!auth) throw new Error('Work Google account not configured');
  const cal = google.calendar({ version: 'v3', auth });
  const range = chicagoTodayRange();
  const { data } = await cal.events.list({
    calendarId: 'primary',
    timeMin: range.start,
    timeMax: range.end,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: TZ,
  });
  const items = (data.items || [])
    .filter((e) => {
      // Skip canceled events (Google sets status, or the organizer
      // leaves a "Canceled: ..." stub on attendees' calendars)
      if (e.status === 'cancelled') return false;
      const titleRaw = (e.summary || '').trim();
      if (/^canc?elled?\s*:/i.test(titleRaw)) return false;
      // Skip events the user has declined
      const myAttendee = (e.attendees || []).find((a) => a.self);
      if (myAttendee && myAttendee.responseStatus === 'declined') return false;
      const title = titleRaw.toLowerCase();
      return !CHECKIN_EXCLUDE_TITLES.some((ex) => title.includes(ex));
    })
    .map((e) => {
      const attendees = e.attendees || [];
      const hasAttendees = attendees.length > 0;
      const allInternal =
        hasAttendees &&
        attendees.every((a) => a.email && a.email.toLowerCase().endsWith(LRL_DOMAIN));
      return {
        title: e.summary || '(no title)',
        start: e.start?.dateTime || e.start?.date,
        allDay: !!e.start?.date,
        isInternal: allInternal,
      };
    });
  return items;
}

async function checkinFetchTasks() {
  const data = await queryTasks(WORK_TASKS_DS, { peopleProp: 'Assigned', myDayOnly: true });
  const pages = data.results.filter((p) => {
    // queryTasks(myDayOnly) also returns anything completed today (to catch tasks
    // Notion auto-unchecks on completion). The check-in only lists what's actually
    // planned for today, so keep only genuine My Day tasks — this mirrors Today's
    // Plan and drops e.g. a recurring task that was completed then rescheduled to
    // Planned with My Day unchecked.
    if (!p.properties?.['My Day']?.checkbox) return false;
    const name = (p.properties?.Name?.title?.[0]?.plain_text || '').toLowerCase();
    // Exclude any "Daily Planning" task (e.g. "Daily Planning", "G's Daily Planning", etc.)
    return !name.includes('daily planning');
  });
  // Resolve unique project IDs to names (cached per-request)
  const projectIds = new Set();
  for (const p of pages) {
    const rel = p.properties?.Project?.relation || [];
    for (const r of rel) projectIds.add(r.id);
  }
  const projectNames = new Map();
  await Promise.all(
    [...projectIds].map(async (id) => {
      try {
        const proj = await notion.pages.retrieve({ page_id: id });
        const title =
          proj.properties?.Name?.title?.[0]?.plain_text ||
          proj.properties?.Title?.title?.[0]?.plain_text ||
          '(unnamed)';
        projectNames.set(id, title);
      } catch (e) {
        projectNames.set(id, '(unnamed)');
      }
    }),
  );
  const decorate = (p) => {
    const name = p.properties?.Name?.title?.[0]?.plain_text || '(untitled)';
    const status = p.properties?.Status?.status?.name || '';
    const rel = p.properties?.Project?.relation || [];
    const projId = rel[0]?.id;
    const projName = projId ? projectNames.get(projId) || '(no project)' : '(no project)';
    return { id: p.id, name, status, project: projName };
  };
  const all = pages.map(decorate);
  return {
    planning: all.filter((t) => t.status === 'Planned'),
    doing:    all.filter((t) => t.status === 'Doing'),
    waiting:  all.filter((t) => t.status === 'Waiting'),
    agenda:   all.filter((t) => t.status === 'Agenda'),
  };
}

function applyCheckinOrder(tasks, orderIds) {
  if (!orderIds || !orderIds.length) return tasks;
  const indexMap = new Map(orderIds.map((id, i) => [id, i]));
  return tasks.slice().sort((a, b) => {
    const ai = indexMap.has(a.id) ? indexMap.get(a.id) : Infinity;
    const bi = indexMap.has(b.id) ? indexMap.get(b.id) : Infinity;
    return ai - bi;
  });
}

function formatCheckinMessage({ events, planning, doing, waiting, agenda }) {
  const lines = [];
  if (events.length) {
    lines.push('*Meetings today:*', '');
    events.forEach((e, i) => {
      const time = e.allDay ? 'All day' : fmtCheckinTime(e.start);
      const label = e.isInternal ? `${e.title} [LRL Team]` : e.title;
      lines.push(`${i + 1}. ${label} (${time})`);
    });
    lines.push('');
  }
  if (planning.length) {
    lines.push(`*Planning to work on:*`, '');
    planning.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.name} | ${t.project}`);
    });
    lines.push('');
  }
  if (doing.length) {
    lines.push(`*Currently doing:*`, '');
    doing.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.name} | ${t.project}`);
    });
    lines.push('');
  }
  if (waiting.length) {
    lines.push(`*Waiting on:*`, '');
    waiting.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.name} | ${t.project}`);
    });
    lines.push('');
  }
  if (agenda.length) {
    lines.push(`*Agenda / need to discuss:*`, '');
    agenda.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.name} | ${t.project}`);
    });
    lines.push('');
  }
  return lines.join('\n').trim();
}

app.get('/api/checkin/compose', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    // Compose always fetches fresh from Notion — also bust task caches so
    // Today's Quest reflects the same My Day state on next render.
    invalidateTaskCaches();
    let orderIds = [];
    try { if (req.query.order) orderIds = JSON.parse(req.query.order); } catch (_) {}
    const [events, tasks] = await Promise.all([
      checkinFetchCalendar().catch((err) => {
        console.error('Checkin calendar error:', err.message);
        return [];
      }),
      checkinFetchTasks(),
    ]);
    const message = formatCheckinMessage({
      events,
      planning: applyCheckinOrder(tasks.planning, orderIds),
      doing:    applyCheckinOrder(tasks.doing,    orderIds),
      waiting:  applyCheckinOrder(tasks.waiting,  orderIds),
      agenda:   applyCheckinOrder(tasks.agenda,   orderIds),
    });
    res.json({
      message,
      counts: { events: events.length, planning: tasks.planning.length, doing: tasks.doing.length, waiting: tasks.waiting.length, agenda: tasks.agenda.length },
      channel: CHECKIN_SLACK_CHANNEL,
      slackEnabled: !!process.env.SLACK_BOT_TOKEN,
    });
  } catch (err) {
    console.error('Checkin compose error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/checkin/diag', (_req, res) => {
  const u = process.env.SLACK_USER_TOKEN || '';
  const b = process.env.SLACK_BOT_TOKEN || '';
  res.json({
    userTokenPresent: !!u,
    userTokenPrefix: u ? u.slice(0, 5) : null,
    botTokenPresent: !!b,
    botTokenPrefix: b ? b.slice(0, 5) : null,
    willPostAs: u ? 'user' : (b ? 'bot' : 'none'),
  });
});

app.post('/api/checkin/send', async (req, res) => {
  // Post as the signed-in user's own Slack account when connected; the owner
  // falls back to the env user token. A member who hasn't connected Slack is
  // asked to connect rather than posting under the owner's identity.
  const userToken = currentSlackToken();
  const botToken = process.env.SLACK_BOT_TOKEN;
  const u = currentUser();
  if (!userToken && u && u.role !== 'owner') {
    return res.status(409).json({ error: 'slack_not_connected', connectUrl: '/auth/slack' });
  }
  const token = userToken || botToken;
  if (!token) return res.status(500).json({ error: 'Slack token not configured (connect Slack or set SLACK_USER_TOKEN / SLACK_BOT_TOKEN)' });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const postRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: CHECKIN_SLACK_CHANNEL,
        text,
        mrkdwn: true,
      }),
    });
    const postData = await postRes.json();
    if (!postData.ok) throw new Error(`Slack: ${postData.error || 'post failed'}`);
    // Permalink fetch — bot token works even if posting as user, so prefer
    // it for the permalink lookup since it doesn't count against user rate limits.
    let permalink = null;
    try {
      const linkRes = await fetch(
        `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(CHECKIN_SLACK_CHANNEL)}&message_ts=${encodeURIComponent(postData.ts)}`,
        { headers: { Authorization: `Bearer ${botToken || token}` } },
      );
      const linkData = await linkRes.json();
      if (linkData.ok) permalink = linkData.permalink;
    } catch (_) {}
    res.json({ ok: true, ts: postData.ts, permalink, channel: postData.channel, postedAs: userToken ? 'user' : 'bot' });
  } catch (err) {
    console.error('Checkin send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =================== XERO (Finance tab) ===================

// This Xero app uses the NEW granular scopes (Xero is phasing out broad ones).
// Confirmed against the app's allowed-scope list in the developer portal:
// there is no `accounting.transactions.read` (superseded) — invoices/bills are
// now read via `accounting.invoices.read`. Request only scopes in that list.
const XERO_SCOPES = [
  'offline_access',
  'accounting.reports.aged.read',
  'accounting.reports.banksummary.read',
  'accounting.reports.profitandloss.read',
  'accounting.reports.balancesheet.read',
  'accounting.contacts.read',
  'accounting.banktransactions.read',
  'accounting.invoices.read',   // NEW: invoices + bills (Type=ACCPAY) — Scale overdue nudges
];

let _xeroAccess = { token: null, exp: 0 };

// Xero rotates the refresh token on every refresh. Persist the latest one
// to disk so it survives in-memory restarts within a single Railway deploy.
// (Across full code deploys the filesystem may reset; the env-var fallback
// handles cold starts in that case.)
const XERO_STATE_FILE = process.env.XERO_STATE_FILE || join(process.cwd(), 'data', 'xero-state.json');
function loadXeroPersistedToken() {
  try {
    if (existsSync(XERO_STATE_FILE)) {
      const s = JSON.parse(readFileSync(XERO_STATE_FILE, 'utf8'));
      if (s && s.refresh_token) return s.refresh_token;
    }
  } catch (e) { console.warn('[xero] load state failed:', e.message); }
  return null;
}
function saveXeroPersistedToken(token) {
  try {
    const dir = dirname(XERO_STATE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(XERO_STATE_FILE, JSON.stringify({ refresh_token: token, savedAt: new Date().toISOString() }, null, 2));
  } catch (e) { console.warn('[xero] save state failed:', e.message); }
  // Durable copy in Postgres — survives Railway deploys (disk is ephemeral, and
  // Xero rotates the token each refresh so the env fallback goes stale).
  dbSecrets.set('xero_refresh_token', token).catch(() => {});
}
let _xeroRefresh = loadXeroPersistedToken() || process.env.XERO_REFRESH_TOKEN || null;
if (_xeroRefresh) console.log('[xero] init token source:', loadXeroPersistedToken() ? 'disk' : 'env');
// After the DB is up, prefer the durable token (the most recently rotated one).
// Disk/env are only the cold-start fallback before this resolves.
async function hydrateXeroTokenFromDb() {
  try {
    const t = await dbSecrets.get('xero_refresh_token');
    if (t && t !== _xeroRefresh) { _xeroRefresh = t; console.log('[xero] token rehydrated from db'); }
  } catch (e) { /* DB off or not seeded yet → keep disk/env */ }
}

function xeroAuthHeader() {
  const id = process.env.XERO_CLIENT_ID || '';
  const secret = process.env.XERO_CLIENT_SECRET || '';
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

async function getXeroAccessToken() {
  if (_xeroAccess.token && Date.now() < _xeroAccess.exp - 60_000) return _xeroAccess.token;
  if (!_xeroRefresh) throw new Error('XERO_REFRESH_TOKEN missing — visit /auth/xero to authorize');
  if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
    throw new Error('XERO_CLIENT_ID or XERO_CLIENT_SECRET missing');
  }
  const r = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: xeroAuthHeader(),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: _xeroRefresh }),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(`Xero refresh failed: ${d.error_description || d.error || r.status}`);
  _xeroAccess = { token: d.access_token, exp: Date.now() + (d.expires_in || 1800) * 1000 };
  if (d.refresh_token && d.refresh_token !== _xeroRefresh) {
    _xeroRefresh = d.refresh_token;
    saveXeroPersistedToken(_xeroRefresh);
  }
  return _xeroAccess.token;
}

// Xero throttles to ~5 concurrent requests per tenant (429 over that), and the
// finance dashboard fires ~13 report calls at once — uncapped, the losers come
// back as 429 → null → zeros (the classic "cash $0 / QTD $0 but YTD fine" bug).
// Gate every call through a small semaphore and retry 429s (honoring Retry-After)
// so a burst completes reliably instead of getting throttled to zeros.
const XERO_MAX_CONCURRENT = 4;
let _xeroActive = 0;
const _xeroWaiters = [];
function _acquireXero() {
  if (_xeroActive < XERO_MAX_CONCURRENT) { _xeroActive++; return Promise.resolve(); }
  return new Promise((resolve) => _xeroWaiters.push(resolve));
}
function _releaseXero() {
  _xeroActive--;
  const next = _xeroWaiters.shift();
  if (next) { _xeroActive++; next(); }
}

async function xeroGet(path, params) {
  const tenantId = process.env.XERO_TENANT_ID || '';
  if (!tenantId) throw new Error('XERO_TENANT_ID missing — visit /auth/xero to authorize');
  const url = `https://api.xero.com${path}` + (params ? `?${new URLSearchParams(params)}` : '');
  await _acquireXero();
  try {
    for (let attempt = 0; ; attempt++) {
      const token = await getXeroAccessToken();
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, 'Xero-tenant-id': tenantId, Accept: 'application/json' },
      });
      if (r.status === 429 && attempt < 5) {
        const retryAfter = Number(r.headers.get('Retry-After')) || (attempt + 1) * 2;
        await new Promise((res) => setTimeout(res, Math.min(retryAfter, 15) * 1000));
        continue;
      }
      if (!r.ok) throw new Error(`Xero API ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    }
  } finally {
    _releaseXero();
  }
}

// Read-only Xero connection diagnostic (no secret values exposed) — pinpoints
// WHY revenue shows "Xero not connected": missing config, a failing token
// refresh (with Xero's exact error), a missing tenant id, or a slow finance
// compute that the page's 10s timeout would cut off.
app.get('/api/xero/diag', async (_req, res) => {
  const out = {
    refreshTokenLoaded: !!_xeroRefresh,
    dbEnabled: dbEnabled(),
    config: {
      clientId: !!process.env.XERO_CLIENT_ID,
      clientSecret: !!process.env.XERO_CLIENT_SECRET,
      tenantId: !!process.env.XERO_TENANT_ID,
      encryptionKey: !!process.env.ENCRYPTION_KEY,
    },
  };
  try { out.dbTokenPresent = !!(await dbSecrets.get('xero_refresh_token')); }
  catch (e) { out.dbTokenPresent = 'error: ' + e.message; }
  try {
    const t0 = Date.now();
    await getXeroAccessToken();
    out.tokenRefresh = { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    out.tokenRefresh = { ok: false, error: e.message };
  }
  if (out.tokenRefresh.ok) {
    try {
      const t0 = Date.now();
      const fin = await computeXeroFinance();
      out.financeCompute = { ok: true, ms: Date.now() - t0, qtdRevenue: fin?.qtdRevenue ?? null, exceeds10sTimeout: (Date.now() - t0) > 10000 };
    } catch (e) { out.financeCompute = { ok: false, error: e.message }; }
  }
  res.json(out);
});

app.get('/auth/xero', (req, res) => {
  if (!process.env.XERO_CLIENT_ID) return res.status(500).send('Set XERO_CLIENT_ID in Railway first.');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.XERO_CLIENT_ID,
    redirect_uri: `${originFromReq(req)}/auth/xero/callback`,
    scope: XERO_SCOPES.join(' '),
    state: 'lifeos',
  });
  // Xero reads a "+" in the query-string scope as a literal char, not a space,
  // so a multi-scope request fails with invalid_scope. Force %20-encoded spaces.
  res.redirect(`https://login.xero.com/identity/connect/authorize?${params.toString().replace(/\+/g, '%20')}`);
});

app.get('/auth/xero/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code received');
  try {
    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: xeroAuthHeader(),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${originFromReq(req)}/auth/xero/callback`,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || tokens.error) {
      return res.status(500).type('html').send(`<pre>Token exchange failed: ${tokens.error_description || tokens.error || tokenRes.status}</pre>`);
    }
    const connRes = await fetch('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const connections = await connRes.json();
    const conn = connections?.[0];
    if (!conn) return res.status(500).send('No Xero connections found');
    // Cache in-memory + persist to disk so live API works without redeploy
    _xeroAccess = { token: tokens.access_token, exp: Date.now() + (tokens.expires_in || 1800) * 1000 };
    _xeroRefresh = tokens.refresh_token;
    saveXeroPersistedToken(_xeroRefresh);
    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Xero connected</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0f1e;color:#f5f5f7;padding:32px;line-height:1.6;max-width:700px;margin:0 auto}
h1{color:#10b981;font-size:22px;margin:0 0 8px}h2{font-size:14px;color:#a5b4fc;letter-spacing:.1em;text-transform:uppercase;margin:24px 0 8px}
pre{background:#131a30;padding:14px 16px;border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.5;border:1px solid rgba(255,255,255,0.06)}
a{color:#5d9cec}</style></head><body>
<h1>✓ Xero connected to ${conn.tenantName}</h1>
<p>The connection is live in this session. To make it survive server restarts, add these to Railway env vars:</p>
<h2>Add to Railway</h2>
<pre>XERO_REFRESH_TOKEN=${tokens.refresh_token}
XERO_TENANT_ID=${conn.tenantId}</pre>
<p>Then redeploy. <a href="/">Back to LRL OS →</a></p>
</body></html>`);
  } catch (err) {
    res.status(500).type('html').send(`<pre>OAuth error: ${err.message}</pre>`);
  }
});

// --- Xero report parsers ---
function flattenReportRows(rows) {
  const out = [];
  const walk = (arr) => {
    for (const r of arr || []) {
      if (r.Rows) walk(r.Rows);
      else out.push(r);
    }
  };
  walk(rows);
  return out;
}
function cellVal(row, idx) { return row?.Cells?.[idx]?.Value ?? ''; }
function parseNum(s) { const n = parseFloat(String(s).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; }

function parseBankSummary(report) {
  // BankSummary rows: header row, then per-account rows with [Account, Opening, Cash In, Cash Out, FX, Closing]
  const accounts = [];
  let totalCash = 0;
  for (const section of report?.Rows || []) {
    if (section.RowType !== 'Section') continue;
    for (const row of section.Rows || []) {
      if (row.RowType !== 'Row' && row.RowType !== 'SummaryRow') continue;
      const name = cellVal(row, 0);
      const closing = parseNum(cellVal(row, row.Cells.length - 1));
      if (row.RowType === 'SummaryRow' || /^total/i.test(name)) {
        totalCash = closing;
      } else if (name) {
        accounts.push({ name, balance: closing });
      }
    }
  }
  return { accounts, totalCash };
}

function parseProfitAndLoss(report) {
  // Xero P&L: nested sections (Income / COGS / Expenses / etc.) each ending
  // in a SummaryRow. Cell 0 is label, last cell is amount (works for
  // single-period AND multi-period reports).
  let income = 0, expenses = 0, net = 0;
  const rows = flattenReportRows(report?.Rows);
  const rowValue = (r) => {
    const cells = r.Cells || [];
    // Walk from the right to find the first non-zero value (current period
    // in multi-period reports is usually the last column).
    for (let i = cells.length - 1; i >= 1; i--) {
      const v = parseNum(cells[i].Value);
      if (v !== 0) return v;
    }
    return parseNum(cells[1]?.Value);
  };
  for (const r of rows) {
    const label = String(cellVal(r, 0)).toLowerCase().trim();
    if (!label) continue;
    const val = rowValue(r);
    if (/^total\s*(trading\s*)?(income|revenue|sales)\b/.test(label)) {
      if (val) income = val;
    }
    // Catch many flavors of expense totals
    else if (
      /^total\s+.*(operating\s*expense|expense|outgoing)/.test(label) ||
      /^total\s+cost\s+of\s+good/.test(label) ||
      /^total\s+cogs\b/.test(label) ||
      label === 'total expenses' ||
      label === 'total operating expenses' ||
      label === 'total less operating expenses'
    ) {
      if (val) expenses = Math.max(expenses, Math.abs(val));
    }
    else if (
      /^net\s+(profit|loss|income|earnings)\b/.test(label) ||
      /^profit\/\(loss\)/.test(label) ||
      /^profit\s+before\s+tax/.test(label) ||
      /^operating\s+profit/.test(label)
    ) {
      if (val) net = val;
    }
  }
  if (net === 0 && (income || expenses)) net = income - expenses;
  return { income, expenses, net };
}

function parseBalanceSheet(report) {
  let ar = 0, ap = 0;
  const rows = flattenReportRows(report?.Rows);
  for (const r of rows) {
    const label = String(cellVal(r, 0)).toLowerCase();
    const val = parseNum(cellVal(r, 1));
    if (/accounts receivable/.test(label) || /trade debtors/.test(label) || /total receivable/.test(label)) {
      if (val) ar = Math.max(ar, val);
    }
    if (/accounts payable/.test(label) || /trade creditors/.test(label) || /total payable/.test(label)) {
      if (val) ap = Math.max(ap, Math.abs(val));
    }
  }
  return { accountsReceivable: ar, accountsPayable: ap };
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Compute the full Xero finance payload (extracted so the Scale scorecard can
// reuse the same QTD/MTD figures via the shared `xero-finance` cache key).
async function computeXeroFinance() {
      // Use Chicago time for all date boundaries (Railway runs UTC, which
      // would otherwise shift "today" by ±1 day in the evening).
      const todayStr = chicagoToday(); // YYYY-MM-DD in America/Chicago
      const [yNum, mNum] = todayStr.split('-').map(Number);
      const pad = (n) => String(n).padStart(2, '0');
      const monthStart = `${yNum}-${pad(mNum)}-01`;
      const qStart = Math.floor((mNum - 1) / 3) * 3 + 1;
      const quarterStart = `${yNum}-${pad(qStart)}-01`;
      const yearStart = `${yNum}-01-01`;
      // 3 full months prior, ending last day of last month
      const burnStartM = mNum - 3;
      const burnStartY = burnStartM < 1 ? yNum - 1 : yNum;
      const burnStartMonth = ((burnStartM - 1 + 12) % 12) + 1;
      const burnStart = `${burnStartY}-${pad(burnStartMonth)}-01`;
      const burnEndM = mNum - 1;
      const burnEndY = burnEndM < 1 ? yNum - 1 : yNum;
      const burnEndMonth = ((burnEndM - 1 + 12) % 12) + 1;
      const burnEndLastDay = new Date(burnEndY, burnEndMonth, 0).getDate();
      const burnEnd = `${burnEndY}-${pad(burnEndMonth)}-${pad(burnEndLastDay)}`;

      // Last 6 months (incl. current, capped at today) for the revenue-by-month chart.
      // Explicit per-month P&L calls reuse the battle-tested single-period parser
      // and keep month labels + ordering fully under our control.
      const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const trendMonths = [];
      for (let k = 5; k >= 0; k--) {
        let mm = mNum - k, yy = yNum;
        while (mm < 1) { mm += 12; yy -= 1; }
        const lastDay = new Date(yy, mm, 0).getDate();
        trendMonths.push({
          year: yy, month: mm, label: MONTH_ABBR[mm - 1],
          fromDate: `${yy}-${pad(mm)}-01`,
          toDate: k === 0 ? todayStr : `${yy}-${pad(mm)}-${pad(lastDay)}`,
          partial: k === 0,
        });
      }

      const xLog = (name) => (err) => { console.error(`[xero] ${name} failed:`, err.message); return null; };
      const trendPromises = trendMonths.map((mo) =>
        xeroGet('/api.xro/2.0/Reports/ProfitAndLoss', { fromDate: mo.fromDate, toDate: mo.toDate, paymentsOnly: 'true' }).catch(xLog(`P&L ${mo.label}`))
      );
      const [bankRaw, mtdRaw, qtdRaw, ytdRaw, burnRaw, bsRaw, vtoGoals, ...trendRaw] = await Promise.all([
        // BankSummary takes a single optional `date` (closing date), NOT a
        // fromDate/toDate range. Pass today's date so closing balances are
        // as of today.
        xeroGet('/api.xro/2.0/Reports/BankSummary', { date: todayStr }).catch(xLog('BankSummary')),
        // paymentsOnly=true → cash basis (money actually moved, not invoiced)
        xeroGet('/api.xro/2.0/Reports/ProfitAndLoss', { fromDate: monthStart, toDate: todayStr, paymentsOnly: 'true' }).catch(xLog('P&L MTD')),
        xeroGet('/api.xro/2.0/Reports/ProfitAndLoss', { fromDate: quarterStart, toDate: todayStr, paymentsOnly: 'true' }).catch(xLog('P&L QTD')),
        xeroGet('/api.xro/2.0/Reports/ProfitAndLoss', { fromDate: yearStart, toDate: todayStr, paymentsOnly: 'true' }).catch(xLog('P&L YTD')),
        xeroGet('/api.xro/2.0/Reports/ProfitAndLoss', { fromDate: burnStart, toDate: burnEnd, paymentsOnly: 'true' }).catch(xLog('P&L burn')),
        xeroGet('/api.xro/2.0/Reports/BalanceSheet', { date: todayStr }).catch(xLog('BalanceSheet')),
        cached('vto-goals', fetchVtoGoals),
        ...trendPromises,
      ]);
      const bank = bankRaw ? parseBankSummary(bankRaw.Reports?.[0]) : { accounts: [], totalCash: 0 };
      const mtd = mtdRaw ? parseProfitAndLoss(mtdRaw.Reports?.[0]) : { income: 0, expenses: 0, net: 0 };
      const qtd = qtdRaw ? parseProfitAndLoss(qtdRaw.Reports?.[0]) : { income: 0, expenses: 0, net: 0 };
      const ytd = ytdRaw ? parseProfitAndLoss(ytdRaw.Reports?.[0]) : { income: 0, expenses: 0, net: 0 };
      const burn = burnRaw ? parseProfitAndLoss(burnRaw.Reports?.[0]) : { income: 0, expenses: 0, net: 0 };
      const bs = bsRaw ? parseBalanceSheet(bsRaw.Reports?.[0]) : { accountsReceivable: 0, accountsPayable: 0 };
      const revenueTrend = trendMonths.map((mo, i) => {
        const pl = trendRaw[i] ? parseProfitAndLoss(trendRaw[i].Reports?.[0]) : { income: 0, net: 0 };
        return { label: mo.label, year: mo.year, month: mo.month, revenue: pl.income, net: pl.net, partial: mo.partial };
      });
      // Diagnostic: if YTD has income but zero expenses, the parser missed the
      // expense rows. Log the raw labels so we can tune the regex.
      if (ytd.income > 0 && ytd.expenses === 0 && ytdRaw) {
        const labels = flattenReportRows(ytdRaw.Reports?.[0]?.Rows)
          .map(r => cellVal(r, 0))
          .filter(Boolean);
        console.warn('[xero] P&L YTD has income but 0 expenses. Labels in report:', labels);
      }

      // Categorize accounts: anything with negative balance OR matching
      // /credit|\bcc\b/ in the name is a credit card; everything else is a
      // regular bank account.
      const bankAccounts = [];
      const creditCards = [];
      for (const a of bank.accounts) {
        const looksLikeCard = /credit|\bcc\b/i.test(a.name) || a.balance < 0;
        if (looksLikeCard) creditCards.push(a);
        else bankAccounts.push(a);
      }
      const bankTotal = bankAccounts.reduce((s, a) => s + a.balance, 0);
      const creditTotal = creditCards.reduce((s, a) => s + a.balance, 0);
      // Monthly burn = avg of last 3 full months expenses
      const monthlyBurn = burn.expenses / 3;
      // Runway = liquid bank cash ÷ burn. Use bankTotal (positive bank accounts
      // only), NOT bank.totalCash — Xero's "Total" row nets in credit-card
      // balances, which would understate runway (cash $68k vs net $8k). Card
      // debt is a liability tracked separately, not a reduction of cash on hand.
      const runwayMonths = monthlyBurn > 0 ? bankTotal / monthlyBurn : null;

      // Cash Capacity = Relay OPEX + Relay Revenue, divided by $30K/mo burn assumption.
      // Goal: $90K = 3 months runway.
      const CASH_CAPACITY_MONTHLY = 30000;
      const CASH_CAPACITY_GOAL = 90000;
      // Match any order ("OPEX 2706 RELAY" vs "Relay OPEX")
      const relayOpex = bank.accounts.find(a => /relay/i.test(a.name) && /opex/i.test(a.name));
      const relayRevenue = bank.accounts.find(a => /relay/i.test(a.name) && /revenue/i.test(a.name));
      const ccAmount = (relayOpex?.balance || 0) + (relayRevenue?.balance || 0);
      const cashCapacity = {
        amount: ccAmount,
        months: Math.round((ccAmount / CASH_CAPACITY_MONTHLY) * 10) / 10,
        monthlyBurnAssumed: CASH_CAPACITY_MONTHLY,
        goalAmount: CASH_CAPACITY_GOAL,
        goalMonths: CASH_CAPACITY_GOAL / CASH_CAPACITY_MONTHLY,
        pctToGoal: Math.min(100, Math.round((ccAmount / CASH_CAPACITY_GOAL) * 100)),
        accounts: [
          relayOpex ? { name: relayOpex.name, balance: relayOpex.balance } : null,
          relayRevenue ? { name: relayRevenue.name, balance: relayRevenue.balance } : null,
        ].filter(Boolean),
        accountsFound: !!(relayOpex && relayRevenue),
      };

      const revenueGoals = periodGoals(vtoGoals?.revenue, mNum);
      const profitGoals  = periodGoals(vtoGoals?.profit, mNum);
      return {
        currency: 'USD',
        cashOnHand: bank.totalCash,
        accounts: bank.accounts,
        bankAccounts,
        creditCards,
        bankTotal,
        creditTotal,
        mtdRevenue: mtd.income,
        mtdExpenses: mtd.expenses,
        mtdNet: mtd.net,
        qtdRevenue: qtd.income,
        qtdExpenses: qtd.expenses,
        qtdNet: qtd.net,
        ytdRevenue: ytd.income,
        ytdExpenses: ytd.expenses,
        ytdNet: ytd.net,
        monthlyBurn,
        runwayMonths: runwayMonths != null ? Math.round(runwayMonths * 10) / 10 : null,
        accountsReceivable: bs.accountsReceivable,
        accountsPayable: bs.accountsPayable,
        cashCapacity,
        revenueTrend,
        goals: {
          revenue: revenueGoals,
          profit: profitGoals,
        },
        asOf: new Date().toISOString(),
      };
}

app.get('/api/finance/xero', async (_req, res) => {
  try {
    const [data, recur] = await Promise.all([
      cached('xero-finance', computeXeroFinance),
      cached('xero-recurring-rev-avg', computeRecurringRevenueAvg).catch(() => null),
    ]);
    res.json({ ...data, recurringRevenueAvg: recur?.avgMonthly ?? null, recurringRevenue12mo: recur?.total12 ?? null });
  } catch (err) {
    console.error('Xero finance error:', err.message);
    const needsAuth = /XERO_(REFRESH_TOKEN|TENANT_ID)/.test(err.message)
      || /invalid_grant|invalid_token|unauthorized/i.test(err.message);
    res.status(500).json({ error: err.message, needsAuth });
  }
});

// Diagnostic: dump the trailing-12-month P&L row labels + values so we can see
// exactly how Xero names the Recurring Revenue line(s) and why the avg is $0.
app.get('/api/finance/recurring-diag', async (_req, res) => {
  try {
    const todayStr = chicagoToday();
    const [yNum, mNum] = todayStr.split('-').map(Number);
    const pad = (n) => String(n).padStart(2, '0');
    let startM = mNum - 11, startY = yNum;
    while (startM < 1) { startM += 12; startY -= 1; }
    const fromDate = `${startY}-${pad(startM)}-01`;
    const raw = await xeroGet('/api.xro/2.0/Reports/ProfitAndLoss', { fromDate, toDate: todayStr, paymentsOnly: 'true' });
    const rows = flattenReportRows(raw?.Reports?.[0]?.Rows);
    const rowValue = (r) => { const c = r.Cells || []; for (let i = c.length - 1; i >= 1; i--) { const v = parseNum(c[i].Value); if (v) return v; } return 0; };
    const allLabels = rows.map((r) => ({ label: String(r.Cells?.[0]?.Value || ''), type: r.RowType, value: rowValue(r) })).filter((x) => x.label);
    const recurringLike = allLabels.filter((x) => /recurr/i.test(x.label));
    res.json({ fromDate, toDate: todayStr, matched: recurringRevenueFromReport(raw?.Reports?.[0]), recurringLike, allLabels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Xero Quotes for the Scale revenue projection: accepted (committed) + sent
// (open pipeline). These need the `accounting.transactions.read` scope, which is
// NOT in this Xero app's allowed-scope list (see XERO_SCOPES note) — so quotes are
// unavailable and the projection degrades to recurring-revenue only. Kept as a
// no-op (returns null) so the projection code path stays intact if that ever
// changes; flip ENABLED to true once the scope is grantable.
// Xero returns dates as /Date(milliseconds+offset)/ — convert to YYYY-MM-DD.
function parseXeroDate(val) {
  if (!val) return null;
  const m = String(val).match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (m) return new Date(parseInt(m[1], 10)).toISOString().slice(0, 10);
  return String(val).slice(0, 10); // already ISO
}

async function computeXeroQuotes() {
  const ENABLED = true;
  if (!ENABLED) return null;
  try {
    const norm = (qs) => (qs || []).map((q) => ({
      total: Number(q.Total) || 0,
      expiryDate: parseXeroDate(q.ExpiryDate),
      date: parseXeroDate(q.Date),
    }));
    const [acc, sent] = await Promise.all([
      xeroGet('/api.xro/2.0/Quotes', { Status: 'ACCEPTED' }).catch((e) => { console.error('[xero] Quotes ACCEPTED failed:', e.message); return null; }),
      xeroGet('/api.xro/2.0/Quotes', { Status: 'SENT' }).catch((e) => { console.error('[xero] Quotes SENT failed:', e.message); return null; }),
    ]);
    if (!acc && !sent) return null; // scope likely not granted yet
    return {
      accepted: norm(acc?.Quotes),
      open: norm(sent?.Quotes),
      asOf: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[xero] quotes error:', err.message);
    return null;
  }
}

// Average monthly income over the last 12 months — single P&L call, cached separately.
async function computeRecurringAvg() {
  const todayStr = chicagoToday();
  const [yNum, mNum] = todayStr.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  let startM = mNum - 11, startY = yNum;
  while (startM < 1) { startM += 12; startY -= 1; }
  const fromDate = `${startY}-${pad(startM)}-01`;
  try {
    const raw = await xeroGet('/api.xro/2.0/Reports/ProfitAndLoss', { fromDate, toDate: todayStr, paymentsOnly: 'true' });
    const pl = raw ? parseProfitAndLoss(raw.Reports?.[0]) : { income: 0 };
    return { totalIncome: pl.income, avgMonthly: pl.income / 12 };
  } catch (e) {
    console.error('[xero] recurringAvg error:', e.message);
    return { totalIncome: 0, avgMonthly: 0 };
  }
}

// Sum the "Recurring Revenue" income line(s) from a Xero P&L report — the live
// account is "GET SUPPORT:Recurring Revenue". Match any "recurring revenue" line
// but EXCLUDE "Non-Recurring Revenue" (a separate account) and subtotal rows.
function recurringRevenueFromReport(report) {
  const rows = flattenReportRows(report?.Rows);
  const rowValue = (r) => { const c = r.Cells || []; for (let i = c.length - 1; i >= 1; i--) { const v = parseNum(c[i].Value); if (v) return v; } return 0; };
  let sum = 0, hit = false;
  for (const r of rows) {
    const l = String(r.Cells?.[0]?.Value || '').trim();
    if (/recurring\s*revenue/i.test(l) && !/non-?\s*recurring/i.test(l) && !/^total/i.test(l)) { sum += rowValue(r); hit = true; }
  }
  return hit ? sum : 0;
}

// Rolling last-12-months Recurring Revenue (the Xero "Recurring Revenue" account)
// ÷ 12. Cash basis, matching the rest of the finance view.
async function computeRecurringRevenueAvg() {
  const todayStr = chicagoToday();
  const [yNum, mNum] = todayStr.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  let startM = mNum - 11, startY = yNum;
  while (startM < 1) { startM += 12; startY -= 1; }
  const fromDate = `${startY}-${pad(startM)}-01`;
  try {
    const raw = await xeroGet('/api.xro/2.0/Reports/ProfitAndLoss', { fromDate, toDate: todayStr, paymentsOnly: 'true' });
    const total12 = raw ? recurringRevenueFromReport(raw.Reports?.[0]) : 0;
    return { total12, avgMonthly: Math.round(total12 / 12) };
  } catch (e) {
    console.error('[xero] recurringRevenueAvg error:', e.message);
    return { total12: 0, avgMonthly: 0 };
  }
}

const VTO_SCORECARD_DS = 'c359c68c-02bb-4fae-b4cb-3a512e5eafab';

async function fetchVtoGoals() {
  if (!notion) return {};
  try {
    const data = await notion.dataSources.query({
      data_source_id: VTO_SCORECARD_DS,
      page_size: 50,
    });
    const goals = {};
    for (const page of data.results) {
      const props = page.properties || {};
      const name = props.Metric?.title?.[0]?.plain_text;
      if (!name) continue;
      goals[name.toLowerCase()] = {
        name,
        goal: props.Goal?.number ?? null,
        breakEven: props['Break Even']?.number ?? null,
        cadence: props.Cadence?.select?.name || null,
        direction: props.Direction?.select?.name || null,
        unit: props.Unit?.rich_text?.[0]?.plain_text || null,
      };
    }
    return goals;
  } catch (err) {
    console.warn('[vto] goals fetch failed:', err.message);
    return {};
  }
}

// Per-quarter revenue goals from the existing VTO Scorecard DB. Each quarter has
// a "Xero Revenue" metric row tagged with a Quarter ("2026 Q2") and a Goal. The
// Goal is per its Cadence, so the quarter goal = Goal × (Monthly→3, Weekly→13,
// Quarterly→1). Returns { '2026 Q2': quarterGoal, … }; quarters without a row
// fall back to the monthly-goal×3 derivation in the route.
async function fetchQuarterlyTargets() {
  if (!notion) return {};
  try {
    const data = await notion.dataSources.query({
      data_source_id: VTO_SCORECARD_DS,
      filter: { property: 'Source', select: { equals: 'Xero Revenue' } },
      page_size: 50,
    });
    const out = {};
    for (const page of data.results) {
      const p = page.properties || {};
      const q = p.Quarter?.select?.name;
      const goal = p.Goal?.number;
      if (!q || typeof goal !== 'number') continue;
      const cadence = p.Cadence?.select?.name;
      const mult = cadence === 'Quarterly' ? 1 : cadence === 'Weekly' ? 13 : 3; // Monthly default
      out[q] = Math.round(goal * mult);
    }
    return out;
  } catch (err) {
    console.warn('[vto] quarterly revenue goals fetch failed:', err.message);
    return {};
  }
}

// Collected (cash-basis) revenue per quarter of `year` from Xero. Past + current
// quarters return a number (current capped at today); future quarters → null.
// Reuses the same P&L endpoint + parser as computeXeroFinance.
async function computeXeroQuarterlyRevenue(year) {
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = chicagoToday();
  const [tY, tM] = todayStr.split('-').map(Number);
  const curQ = Math.floor((tM - 1) / 3) + 1;
  const out = {};
  const jobs = [];
  for (let q = 1; q <= 4; q++) {
    if (year > tY || (year === tY && q > curQ)) { out[q] = null; continue; }
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const lastDay = new Date(year, endMonth, 0).getDate();
    const fromDate = `${year}-${pad(startMonth)}-01`;
    const toDate = (year === tY && q === curQ) ? todayStr : `${year}-${pad(endMonth)}-${pad(lastDay)}`;
    jobs.push(
      xeroGet('/api.xro/2.0/Reports/ProfitAndLoss', { fromDate, toDate, paymentsOnly: 'true' })
        .then((raw) => { out[q] = raw ? (parseProfitAndLoss(raw.Reports?.[0]).income || 0) : null; })
        .catch(() => { out[q] = null; }),
    );
  }
  await Promise.all(jobs);
  return out;
}

// Cash-basis revenue + profit (net) for an arbitrary date range — used by the
// per-quarter scorecard. Returns null on failure so callers degrade gracefully.
async function computeXeroPnlForRange(fromDate, toDate) {
  try {
    const raw = await xeroGet('/api.xro/2.0/Reports/ProfitAndLoss', { fromDate, toDate, paymentsOnly: 'true' });
    const pl = raw ? parseProfitAndLoss(raw.Reports?.[0]) : { income: 0, net: 0 };
    return { revenue: Math.round(pl.income || 0), profit: Math.round(pl.net || 0) };
  } catch (e) {
    console.error('[xero] pnlForRange error:', e.message);
    return null;
  }
}

// Period multipliers for monthly metrics → MTD/QTD/YTD goal values
function periodGoals(monthlyMetric, currentMonth) {
  if (!monthlyMetric || monthlyMetric.goal == null) return null;
  const goal = monthlyMetric.goal;
  const be = monthlyMetric.breakEven;
  return {
    mtd: { goal, breakEven: be },
    qtd: { goal: goal * 3, breakEven: be != null ? be * 3 : null },
    ytd: { goal: goal * currentMonth, breakEven: be != null ? be * currentMonth : null },
  };
}

// One-click sync of monthly Xero P&L into the VTO Weekly Actuals DB.
// Creates one Revenue row + one Profit row per month in the current quarter,
// using cash basis to match how she views her dashboard.
const VTO_ACTUALS_DS = '4c032800-ae59-4e2c-bc56-98efd87143d2';
const VTO_REVENUE_METRIC = '37a458f0-8cd9-81e3-bab7-c26cab799a4c';
const VTO_PROFIT_METRIC  = '37a458f0-8cd9-814a-9c8d-fdce184b9c25';

app.get('/api/finance/sync-vto-quarter', async (_req, res) => {
  if (!notion) return res.status(500).type('html').send('<pre>NOTION_TOKEN not configured</pre>');
  try {
    const todayStr = chicagoToday();
    const [yNum, mNum] = todayStr.split('-').map(Number);
    const pad = (n) => String(n).padStart(2, '0');
    const qStartMonth = Math.floor((mNum - 1) / 3) * 3 + 1;
    const quarterLabel = `Q${Math.floor((mNum - 1) / 3) + 1} ${yNum}`;

    // Check for existing actuals so we don't duplicate
    const existing = await notion.dataSources.query({
      data_source_id: VTO_ACTUALS_DS,
      page_size: 100,
    });
    const existingKeys = new Set(existing.results.map((r) => {
      const metricRel = r.properties?.Metric?.relation?.[0]?.id || '';
      const weekEnd = r.properties?.['Week Ending']?.date?.start || '';
      return `${metricRel}::${weekEnd}`;
    }));

    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const created = [];
    const skipped = [];
    for (let i = 0; i < 3; i++) {
      const m = qStartMonth + i;
      if (m > mNum) break; // future month — skip
      const monthStart = `${yNum}-${pad(m)}-01`;
      const lastDay = new Date(yNum, m, 0).getDate();
      const isCurrentMonth = m === mNum;
      const monthEnd = isCurrentMonth ? todayStr : `${yNum}-${pad(m)}-${pad(lastDay)}`;

      const pnlRaw = await xeroGet('/api.xro/2.0/Reports/ProfitAndLoss', {
        fromDate: monthStart,
        toDate: monthEnd,
        paymentsOnly: 'true',
      });
      const pnl = parseProfitAndLoss(pnlRaw.Reports?.[0]);
      const label = `${monthNames[m-1]} ${yNum}`;
      const notes = isCurrentMonth
        ? `Cash basis P&L from Xero. Partial month — through ${todayStr}.`
        : 'Cash basis P&L from Xero. Full month.';

      // Revenue row
      const revKey = `${VTO_REVENUE_METRIC}::${monthEnd}`;
      if (existingKeys.has(revKey)) {
        skipped.push({ metric: 'Revenue', month: label, reason: 'already exists' });
      } else {
        await notion.pages.create({
          parent: { type: 'data_source_id', data_source_id: VTO_ACTUALS_DS },
          properties: {
            Entry:        { title: [{ text: { content: `Revenue · ${label}` } }] },
            Metric:       { relation: [{ id: VTO_REVENUE_METRIC }] },
            Actual:       { number: pnl.income },
            'Week Ending':{ date: { start: monthEnd } },
            Notes:        { rich_text: [{ text: { content: notes } }] },
          },
        });
        created.push({ metric: 'Revenue', month: label, value: pnl.income, date: monthEnd });
      }

      // Profit row (net)
      const profKey = `${VTO_PROFIT_METRIC}::${monthEnd}`;
      if (existingKeys.has(profKey)) {
        skipped.push({ metric: 'Profit', month: label, reason: 'already exists' });
      } else {
        await notion.pages.create({
          parent: { type: 'data_source_id', data_source_id: VTO_ACTUALS_DS },
          properties: {
            Entry:        { title: [{ text: { content: `Profit · ${label}` } }] },
            Metric:       { relation: [{ id: VTO_PROFIT_METRIC }] },
            Actual:       { number: pnl.net },
            'Week Ending':{ date: { start: monthEnd } },
            Notes:        { rich_text: [{ text: { content: notes } }] },
          },
        });
        created.push({ metric: 'Profit', month: label, value: pnl.net, date: monthEnd });
      }
    }

    const fmt = (n) => new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', maximumFractionDigits: 0 }).format(n);
    const rows = created.map(c => `<tr><td>${c.metric}</td><td>${c.month}</td><td style="text-align:right">${fmt(c.value)}</td><td>${c.date}</td></tr>`).join('');
    const skipRows = skipped.map(s => `<tr><td>${s.metric}</td><td>${s.month}</td><td colspan="2" style="color:rgba(245,245,247,0.5)">${s.reason}</td></tr>`).join('');
    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>VTO sync</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0f1e;color:#f5f5f7;padding:32px;max-width:780px;margin:0 auto;line-height:1.5}
h1{color:#10b981;font-size:22px;margin:0 0 6px}h2{font-size:13px;color:rgba(245,245,247,0.55);letter-spacing:.12em;text-transform:uppercase;margin:22px 0 10px;font-weight:700}
table{width:100%;border-collapse:collapse;background:#131a30;border-radius:10px;overflow:hidden}td,th{padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.06);text-align:left;font-size:13px}
th{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:rgba(245,245,247,0.55);font-weight:700}tr:last-child td{border-bottom:none}
a{color:#818cf8;text-decoration:none}a:hover{text-decoration:underline}</style></head><body>
<h1>✓ Synced ${quarterLabel} to VTO Actuals</h1>
<p>Cash-basis Revenue + Profit pulled from Xero for each month and written to the VTO Weekly Actuals DB in Notion.</p>
${created.length ? `<h2>Created (${created.length})</h2><table><tr><th>Metric</th><th>Month</th><th style="text-align:right">Value</th><th>Date</th></tr>${rows}</table>` : ''}
${skipped.length ? `<h2>Skipped (${skipped.length})</h2><table><tr><th>Metric</th><th>Month</th><th colspan="2">Reason</th></tr>${skipRows}</table>` : ''}
<p style="margin-top:24px"><a href="/">← Back to LRL OS</a></p>
</body></html>`);
  } catch (err) {
    console.error('VTO sync error:', err.message);
    res.status(500).type('html').send(`<pre style="color:#ff7a6b;font-family:system-ui;padding:20px">VTO sync failed: ${err.message}</pre>`);
  }
});

app.post('/api/ai/triage/apply', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { actions } = req.body || {};
  if (!Array.isArray(actions)) return res.status(400).json({ error: 'actions array required' });
  const results = [];
  // Process in order so a create_project's new id is available to a
  // subsequent create_task that references the project by name.
  const newProjectsByName = new Map(); // lowercased project name -> { id, source }
  for (const a of actions) {
    try {
      if (a.type === 'create_project') {
        if (!a.source || !a.name) throw new Error('create_project requires source + name');
        const r = await createNotionProject(a);
        newProjectsByName.set(a.name.toLowerCase().trim(), { id: r.id, source: a.source });
        results.push({ action: a, ok: true, result: r });
      } else if (a.type === 'create_task') {
        if (!a.source || !a.name) throw new Error('create_task requires source + name');
        // If create_task references a project by name (e.g. projectRef), resolve
        // it to the id of a just-created project of the same source.
        const taskArgs = { ...a };
        if (!taskArgs.projectId && a.projectRef) {
          const matched = newProjectsByName.get(String(a.projectRef).toLowerCase().trim());
          if (matched && matched.source === a.source) taskArgs.projectId = matched.id;
        }
        const r = await createNotionTask(taskArgs);
        results.push({ action: a, ok: true, result: r });
      } else if (a.type === 'update_task') {
        if (!a.taskId) throw new Error('update_task requires taskId');
        const r = await updateNotionTask(a);
        results.push({ action: a, ok: true, result: r });
      } else if (a.type === 'create_event') {
        if (!a.account || !a.title || !a.start || !a.end) throw new Error('create_event requires account, title, start, end');
        const r = await createCalendarEvent(a);
        results.push({ action: a, ok: true, result: r });
      } else {
        throw new Error(`unsupported action type: ${a.type}`);
      }
    } catch (err) {
      results.push({ action: a, ok: false, error: err.message });
    }
  }
  invalidateTaskCaches();
  cache.delete('calendar-today');
  res.json({ results });
});

// ===== Convert / Sales domain — routes in src/routes/convert.js; data in src/providers/notion/convert.js =====
registerConvertRoutes(app, { notion, cache, cached, userContext, currentQuarter, chicagoToday, chicagoTodayISODate, fetchVtoGoals, dashifyId, GRETCHEN_USER_ID, currentNotionUserId, computeXeroFinance, computeXeroQuotes, computeRecurringAvg, anthropic });

function dashifyId(id) {
  const s = String(id || '').replace(/-/g, '');
  return s.length === 32
    ? `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`
    : id;
}

// ===== Attract / Marketing domain — extracted to src/routes/attract.js =====
const { MARKETING_ASSETS_DS, fetchMarketingChannelMap, serializeMarketingAsset } =
  registerAttractRoutes(app, { notion, cache, cached, currentQuarter, chicagoTodayISODate, chicagoDateNDaysAgo, dashifyId, anthropic, userContext, currentNotionUserId, GRETCHEN_USER_ID });
registerWealthRoutes(app, { cached, cache, userContext });
registerScaleRoutes(app, {
  notion, cached, clearCached, computeXeroFinance, computeXeroQuotes, computeXeroQuarterlyRevenue,
  computeXeroPnlForRange, computeRecurringRevenueAvg, fetchQuarterlyTargets, fetchVtoGoals, chicagoToday, currentQuarter,
  WORK_PROJECTS_DS, WORK_TASKS_DS, currentNotionUserId, GRETCHEN_USER_ID,
});
// Reuses the existing Slack user-token OAuth (/auth/slack) + currentSlackToken().
// The Messages zone reads unreads, so the OAuth user_scope was widened to include
// the history/read scopes (see /auth/slack above).
registerMessagesRoutes(app, { notion, cached, clearCached, getSlackUserToken: currentSlackToken, ownNotionUserId: GRETCHEN_USER_ID, WORK_PROJECTS_DS, WORK_TASKS_DS });
registerReferenceRoutes(app, { notion, cached, authedClient, configuredAccounts, fetchInbox, google });
registerLegoRoutes(app, { notion, cache, cached, userContext });

// ===== Deliver domain — wired sections (offers + care-plan renewals); project sections render client-side =====
registerDeliverRoutes(app, { notion, cached, cache, userContext, chicagoTodayISODate, chicagoDateNDaysAgo, dashifyId, GRETCHEN_USER_ID, currentNotionUserId, currentUser, anthropic });

// =========================== MOVE THE NEEDLE (Phase 0) ===========================
// GET /api/needle/today — ONE ranked, cross-zone "what to do next" list. This is
// a composing endpoint: it reuses the existing fetchers/serializers (projects
// board, deals pipeline, overdue contacts, marketing assets) and only PEEKS the
// already-cached Xero result for finance — it wires no new Notion databases.
// Each zone source is guarded independently so one failure never blanks the panel.
const NEEDLE_ZONE_LABEL = { attract: 'Attract', convert: 'Convert', deliver: 'Deliver', scale: 'Scale' };
const NEEDLE_LATE_DEAL_STAGES = new Set(['Consult Completed', 'Build Scope', 'Decision Pending']);
const fmtUSD = (n) => (typeof n === 'number' && isFinite(n)) ? '$' + Math.round(n).toLocaleString('en-US') : null;

app.get('/api/needle/today', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') {
      const u = userContext.getStore()?.user;
      cache.delete(u ? `needle-today::${u.id || u.email}` : 'needle-today');
    }
    const data = await cached('needle-today', async () => {
      const today = chicagoTodayISODate();
      const todayMs = Date.parse(today + 'T00:00:00Z');

      // ---- DELIVER: ready-to-bill (cash on the table) + overdue/at-risk work projects ----
      const deliver = await (async () => {
        const out = [];
        try {
          const { projects } = await fetchProjectsBoard();
          for (const p of projects) {
            if (p.source !== 'work') continue;
            if (p.status === 'Billing') {
              out.push({ id: `project:${p.id}`, zone: 'deliver', title: p.name, url: p.url,
                why: 'Ready to invoice — cash on the table', score: 100,
                action: { label: 'Open in Projects', kind: 'jump', tab: 'projects' } });
            } else if (p.atRisk) {
              out.push({ id: `project:${p.id}`, zone: 'deliver', title: p.name, url: p.url,
                why: `Past deadline${p.rock ? ' · Quarterly Rock' : ''} — unblock or re-date`,
                score: p.rock ? 78 : 62,
                action: { label: 'Open in Projects', kind: 'jump', tab: 'projects' } });
            }
          }
        } catch (e) { console.error('needle:deliver', e.message); }
        // Upcoming high-priority tasks (mine, due soon or overdue) — check off inline.
        try {
          const nid = currentNotionUserId();
          const soon = chicagoDateNDaysAgo(-3); // 3 days ahead
          const tr = await notion.dataSources.query({
            data_source_id: WORK_TASKS_DS,
            filter: { and: [
              { property: 'Status', status: { does_not_equal: 'Done' } },
              { property: 'Assigned', people: { contains: nid || '00000000-0000-0000-0000-000000000000' } },
              { property: 'Due', date: { on_or_before: soon } },
            ] },
            sorts: [{ property: 'Due', direction: 'ascending' }],
            page_size: 25,
          });
          out.push(...tr.results.map((p) => simplifyTask(p, 'work')).map((t) => {
            const dueMs = t.dueStart ? Date.parse(t.dueStart + 'T00:00:00Z') : null;
            const dd = dueMs != null ? Math.round((dueMs - todayMs) / 864e5) : 99;
            const pri = (t.priority || '').toLowerCase();
            const score = (dd < 0 ? 76 : dd === 0 ? 70 : dd === 1 ? 64 : dd <= 3 ? 58 : 50) + (/urgent|high/.test(pri) ? 12 : /low/.test(pri) ? -8 : 0);
            const when = dd < 0 ? `${Math.abs(dd)}d overdue` : dd === 0 ? 'due today' : `due in ${dd}d`;
            return { id: `task:${t.id}`, zone: 'deliver', title: t.name, url: t.url,
              why: `${t.priority || 'Task'} · ${when}`, score,
              action: { label: 'Done', kind: 'complete-task', taskId: t.id } };
          }).sort((a, b) => b.score - a.score).slice(0, 3));
        } catch (e) { console.error('needle:tasks', e.message); }
        // Client/project work closed recently with NO time logged — billing-leak nudge (TIME LOG [DB] rollup).
        // Window on the COMPLETED date (not last-edited) so the Notion-transition backlog — old tasks
        // bulk-edited during migration but completed long ago — doesn't get falsely flagged.
        try {
          const sinceDone = chicagoDateNDaysAgo(7); // completed within the last week
          const prodIds = await cached('needle-prod-projects', productionProjectIds); // billable = task's project is in the Production area
          const dn = await notion.dataSources.query({
            data_source_id: WORK_TASKS_DS,
            filter: { and: [
              { property: 'Status', status: { equals: 'Done' } },
              { property: 'Completed', date: { on_or_after: sinceDone } },
            ] },
            sorts: [{ property: 'Completed', direction: 'descending' }],
            page_size: 40,
          });
          const cards = [];
          for (const p of dn.results) {
            const props = p.properties || {};
            const manual = props['Manual Time (Hours)']?.rollup?.number || 0;
            const ext = props['External Logged (hrs)']?.number || 0;
            const trackedMins = props['Time Tracked (Mins)']?.formula?.number || 0;
            if (manual + ext + trackedMins / 60 > 0.001) continue;             // time recorded — skip
            if (!(props['Project']?.relation || []).some((r) => prodIds.has(r.id))) continue; // Production-area (client/billable) work only
            const t = simplifyTask(p, 'work');
            const comp = props['Completed']?.date?.start || null;
            const compMs = comp ? Date.parse(comp.slice(0, 10) + 'T00:00:00Z') : null;
            const ago = compMs != null ? Math.round((todayMs - compMs) / 864e5) : null;
            const when = ago == null ? '' : ago <= 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago}d ago`;
            cards.push({ id: `notime:${t.id}`, zone: 'deliver', title: t.name, url: t.url,
              why: `Closed ${when} · no time logged — log to bill`,
              score: 60 - Math.min(ago || 0, 7),   // freshest closes rank highest; below urgent due/overdue
              action: { label: 'Log time', kind: 'link', url: t.url } });
          }
          out.push(...cards.sort((a, b) => b.score - a.score).slice(0, 2));
        } catch (e) { console.error('needle:notime', e.message); }
        return out;
      })();

      // ---- CONVERT: close-the-quarter deals (late stage, by value) + overdue follow-ups ----
      const convert = await (async () => {
        const out = [];
        try {
          const productMap = await fetchSalesProductMap(notion, cached).catch(() => ({}));
          const deals = (await queryAllDeals(notion)).map((pg) => serializeDeal(pg, productMap));
          deals
            .filter((d) => !d.archived && NEEDLE_LATE_DEAL_STAGES.has(d.status))
            .sort((a, b) => (b.value || 0) - (a.value || 0))
            .slice(0, 4)
            .forEach((d) => {
              const v = fmtUSD(d.value);
              const closing = d.status === 'Decision Pending';
              out.push({ id: `deal:${d.id}`, zone: 'convert', title: d.name, url: d.url,
                why: `${d.status}${v ? ` · ${v}` : ''}${closing ? ' — push to close' : ''}`,
                score: (closing ? 86 : 80) + Math.min((d.value || 0) / 2000, 12),
                action: { label: 'Open in Convert', kind: 'jump', tab: 'pipeline' } });
            });
        } catch (e) { console.error('needle:deals', e.message); }
        try {
          // Bounded overdue-contacts query, mirrors /api/convert/overdue (never-touched + oldest).
          const relFilter = { or: PULSE_RELATIONSHIPS.map((name) => ({ property: 'Relationship', select: { equals: name } })) };
          const baseAnd = (extra) => ({ and: [{ property: 'Archive', checkbox: { equals: false } }, relFilter, extra] });
          const [neverRes, touchedRes] = await Promise.all([
            notion.dataSources.query({ data_source_id: CONTACTS_DS, filter: baseAnd({ property: 'Last Touched', date: { is_empty: true } }), page_size: 20 }),
            notion.dataSources.query({ data_source_id: CONTACTS_DS, filter: baseAnd({ property: 'Last Touched', date: { is_not_empty: true } }), sorts: [{ property: 'Last Touched', direction: 'ascending' }], page_size: 20 }),
          ]);
          const contacts = [...neverRes.results, ...touchedRes.results].map(serializeContactRow);
          contacts.forEach((c) => { c.daysSince = c.lastTouched ? Math.max(0, Math.round((todayMs - Date.parse(c.lastTouched + 'T00:00:00Z')) / 864e5)) : null; });
          contacts
            .sort((a, b) => { if (!a.lastTouched && !b.lastTouched) return a.name.localeCompare(b.name); if (!a.lastTouched) return -1; if (!b.lastTouched) return 1; return a.lastTouched.localeCompare(b.lastTouched); })
            .slice(0, 3)
            .forEach((c) => {
              const never = !c.lastTouched;
              out.push({ id: `contact:${c.id}`, zone: 'convert', title: c.name,
                why: never ? `${c.relationship || 'Contact'} · never contacted` : `${c.relationship || 'Contact'} · no touch in ${c.daysSince}d`,
                score: never ? 72 : 48 + Math.min((c.daysSince || 0) / 3, 22),
                action: { label: 'Log a touch', kind: 'touchpoint', contactId: c.id, contactName: c.name } });
            });
        } catch (e) { console.error('needle:overdue', e.message); }
        // Speaking stages pitched but not booked → follow up to lock the booking.
        try {
          const r = await notion.dataSources.query({
            data_source_id: '96f47e7e-9797-4d96-9abb-e5dcb7df13a3',
            filter: { or: [
              { property: 'Status', status: { equals: 'Pitched' } },
              { property: 'Status', status: { equals: 'Following Up' } },
            ] },
            sorts: [{ property: 'Last Touched', direction: 'ascending' }],
            page_size: 10,
          });
          r.results.slice(0, 3).forEach((p) => {
            const name = p.properties?.Name?.title?.[0]?.plain_text || '(opportunity)';
            const status = p.properties?.Status?.status?.name || 'Pitched';
            const lt = p.properties?.['Last Touched']?.date?.start || null;
            const dSince = lt ? Math.max(0, Math.round((todayMs - Date.parse(lt + 'T00:00:00Z')) / 864e5)) : null;
            out.push({ id: `speak:${p.id}`, zone: 'convert', title: name, url: p.url,
              why: `${status} — follow up to book${dSince != null ? ` · ${dSince}d since touch` : ''}`,
              score: 56 + (dSince != null ? Math.min(dSince / 5, 14) : 6),
              action: { label: 'Open', kind: 'jump', tab: 'pipeline' } });
          });
        } catch (e) { console.error('needle:speaking', e.message); }
        return out;
      })();

      // ---- ATTRACT: content overdue to publish ----
      const attract = await (async () => {
        const out = [];
        try {
          const channelMap = await fetchMarketingChannelMap().catch(() => ({}));
          const r = await notion.dataSources.query({
            data_source_id: MARKETING_ASSETS_DS,
            filter: { and: [
              { property: 'Publish Date', date: { on_or_before: today } },
              { property: 'Status', status: { does_not_equal: 'Published' } },
            ] },
            sorts: [{ property: 'Publish Date', direction: 'ascending' }],
            page_size: 10,
          });
          r.results.map((pg) => serializeMarketingAsset(pg, channelMap)).forEach((a) => {
            const dOver = a.publishDate ? Math.max(0, Math.round((todayMs - Date.parse(a.publishDate + 'T00:00:00Z')) / 864e5)) : 0;
            const blockers = (a.needs && a.needs.length) ? ` · ${a.needs.join(', ')}` : '';
            out.push({ id: `asset:${a.id}`, zone: 'attract', title: a.name, url: a.url,
              why: `Overdue to publish${dOver ? ` ${dOver}d` : ''}${blockers}`,
              score: 55 + Math.min(dOver, 20),
              action: { label: 'Open in Attract', kind: 'jump', tab: 'marketing' } });
          });
        } catch (e) { console.error('needle:attract', e.message); }
        // Finished content with no publish date → schedule it.
        try {
          const cmap = await fetchMarketingChannelMap().catch(() => ({}));
          const rNS = await notion.dataSources.query({
            data_source_id: MARKETING_ASSETS_DS,
            filter: { and: [
              { property: 'Status', status: { equals: 'Approved' } },
              { property: 'Publish Date', date: { is_empty: true } },
            ] },
            page_size: 10,
          });
          rNS.results.map((pg) => serializeMarketingAsset(pg, cmap)).forEach((a) => {
            out.push({ id: `asset-ns:${a.id}`, zone: 'attract', title: a.name, url: a.url,
              why: 'Approved — needs a publish date', score: 52,
              action: { label: 'Open', kind: 'jump', tab: 'marketing' } });
          });
        } catch (e) { console.error('needle:attract-ns', e.message); }
        return out;
      })();

      // ---- SCALE: revenue/runway + scorecard (cached peeks) + overdue invoices/bills (Xero) ----
      const scale = await (async () => {
        const out = [];
        try {
          const u = userContext.getStore()?.user;
          const fin = cache.get(u ? `xero-finance::${u.id || u.email}` : 'xero-finance')?.v;
          if (fin) {
            const goal = fin.goals?.revenue?.qtd;
            const actual = fin.qtdRevenue;
            if (typeof goal === 'number' && typeof actual === 'number' && goal > 0 && actual < goal) {
              out.push({ id: 'finance:revenue', zone: 'scale', title: 'Quarterly revenue behind goal',
                why: `${fmtUSD(goal - actual)} to go · ${fmtUSD(actual)} of ${fmtUSD(goal)} QTD`,
                score: 68, action: { label: 'Open in Scale', kind: 'jump', tab: 'finance' } });
            } else if (typeof fin.runwayMonths === 'number' && fin.runwayMonths > 0 && fin.runwayMonths < 4) {
              out.push({ id: 'finance:runway', zone: 'scale', title: 'Cash runway is short',
                why: `${fin.runwayMonths} months of runway — tighten spend / accelerate collections`,
                score: 66, action: { label: 'Open in Scale', kind: 'jump', tab: 'finance' } });
            }
          }
        } catch (e) { console.error('needle:scale', e.message); }
        // Scorecard metrics off-track (peek the cached Scale scorecard, if loaded).
        try {
          const u = userContext.getStore()?.user;
          const sc = cache.get(u ? `scale-scorecard::${u.id || u.email}` : 'scale-scorecard')?.v;
          (sc?.offTrack || []).slice(0, 2).forEach((mt) => {
            const fmtN = (n) => (typeof n === 'number' ? Math.round(n).toLocaleString('en-US') : n);
            const vs = (mt.actual != null && mt.goal != null) ? ` · ${fmtN(mt.actual)} of ${fmtN(mt.goal)} ${mt.period || ''}`.trimEnd() : '';
            out.push({ id: `metric:${mt.id || mt.metric}`, zone: 'scale',
              title: mt.metric || 'Scorecard metric',
              why: `${mt.status === 'red' ? 'Behind goal' : 'At risk'}${vs}`,
              score: mt.status === 'red' ? 67 : 57,
              action: { label: 'Open in Scale', kind: 'jump', tab: 'finance' } });
          });
        } catch (e) { console.error('needle:scorecard', e.message); }
        // Overdue invoices (AR) + bills (AP) from Xero — needs accounting.invoices.read scope.
        try {
          const parseXDate = (xd) => { const m = /\/Date\((\d+)/.exec(String(xd || '')); return m ? new Date(+m[1]).toISOString().slice(0, 10) : null; };
          const d = await xeroGet('/api.xro/2.0/Invoices', { Statuses: 'AUTHORISED', order: 'DueDate' });
          const overdue = (d.Invoices || [])
            .map((inv) => ({ id: inv.InvoiceID, number: inv.InvoiceNumber || '', contact: inv.Contact?.Name || '', due: parseXDate(inv.DueDate), amountDue: inv.AmountDue || 0, type: inv.Type }))
            .filter((i) => i.amountDue > 0 && i.due && i.due < today);
          overdue.filter((i) => i.type === 'ACCREC').slice(0, 2).forEach((inv) => {
            const dOver = Math.round((todayMs - Date.parse(inv.due + 'T00:00:00Z')) / 864e5);
            out.push({ id: `xinv:${inv.id}`, zone: 'scale',
              title: `${inv.contact || 'Customer'} — ${fmtUSD(inv.amountDue)} overdue`,
              why: `Invoice ${inv.number} · ${dOver}d overdue — chase payment`,
              score: 62 + Math.min(dOver / 3, 18),
              action: { label: 'Open', kind: 'link', url: `https://go.xero.com/app/invoicing/view/${inv.id}` } });
          });
          overdue.filter((i) => i.type === 'ACCPAY').slice(0, 1).forEach((bill) => {
            const dOver = Math.round((todayMs - Date.parse(bill.due + 'T00:00:00Z')) / 864e5);
            out.push({ id: `xbill:${bill.id}`, zone: 'scale',
              title: `Bill overdue — ${fmtUSD(bill.amountDue)} to ${bill.contact || 'supplier'}`,
              why: `Bill ${bill.number} · ${dOver}d overdue — pay or schedule`,
              score: 58 + Math.min(dOver / 4, 12),
              action: { label: 'Open', kind: 'link', url: `https://go.xero.com/app/bills/view/${bill.id}` } });
          });
        } catch (e) { console.error('needle:xero-overdue', e.message); }
        return out;
      })();

      // ---- Merge: guarantee each zone's top nudge (cross-zone mix), then fill to 6, max 2/zone ----
      const byZone = { attract, convert, deliver, scale };
      const ranked = {};
      for (const z of Object.keys(byZone)) ranked[z] = byZone[z].slice().sort((a, b) => b.score - a.score).slice(0, 2);
      let picked = Object.keys(byZone).map((z) => ranked[z][0]).filter(Boolean);
      const rest = Object.keys(byZone).map((z) => ranked[z][1]).filter(Boolean).sort((a, b) => b.score - a.score);
      picked.push(...rest.slice(0, Math.max(0, 6 - picked.length)));
      picked.sort((a, b) => b.score - a.score);
      picked = picked.slice(0, 6).map((c) => ({ ...c, zoneLabel: NEEDLE_ZONE_LABEL[c.zone] }));
      return { asOf: new Date().toISOString(), cards: picked };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 404 — branded not-found page ──
// Fell through every route + static file. JSON for API paths; the branded page
// (with a button back to /today) for everything else.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(join(__dirname, 'public', '404.html'));
});

const server = app.listen(PORT, () => {
  console.log(`LRL OS listening on port ${PORT}`);
  // Phase 0 (multi-user foundation): bring up the per-user store if DATABASE_URL
  // is configured. No-ops in single-user mode, so this never blocks serving.
  initDb({
    email: ALLOWED_EMAIL,
    name: 'Gretchen Cawthon',
    notionUserId: GRETCHEN_USER_ID,
    timezone: TZ,
    weatherLat: WEATHER_LAT,
    weatherLon: WEATHER_LON,
    refreshTokenWork: process.env.GOOGLE_REFRESH_TOKEN || null,
    refreshTokenPersonal: process.env.GOOGLE_REFRESH_TOKEN_PERSONAL || null,
  }).then(hydrateXeroTokenFromDb).catch((e) => console.error('[db] init failed:', e.message));
});

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish, then exit. A hard timeout guarantees we exit before Railway's grace
// window expires and escalates to SIGKILL (which is what produced the noisy
// "npm error signal SIGTERM" on every deploy).
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down gracefully`);
  server.close(() => {
    console.log('HTTP server closed cleanly');
    process.exit(0);
  });
  // Don't let keep-alive connections hold us open past the deploy grace window.
  setTimeout(() => {
    console.warn('Forcing exit after shutdown timeout');
    process.exit(0);
  }, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Safety net: an unhandled async rejection or thrown error anywhere in a
// request handler would otherwise terminate the process (Node ≥15 exits on
// unhandled rejections), which Railway sees as a crash and restarts — the
// "crashes then eventually loads" symptom. Log loudly and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (kept alive):', err);
});
