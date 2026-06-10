import express from 'express';
import cookieSession from 'cookie-session';
import { Client } from '@notionhq/client';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

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
const WORK_TASKS_DS = '28c458f08cd9818599e7000bc2115872';
const LIFE_TASKS_DS = '265458f08cd981699efe000b4de14ca4';
const WORK_PROJECTS_DS = '28c458f08cd98131a475000b81db3c1b';
const LIFE_PROJECTS_DS = '265458f08cd9814eaf0e000bceaa7f80';
const JOURNAL_DS = '25a458f08cd9804bb6d1000b78cb4186';
const JOURNAL_DB_ID = '25a458f08cd980f9991af90b30ec68d8';
const CACHE_TTL_MS = 60_000;
const TZ = 'America/Chicago';
const DATA_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
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

const cache = new Map();
const CACHE_TTL_OVERRIDES = {
  'journal-rings': 5 * 60_000, // heavier query (per-row body-text check); cache longer
  'vto-goals': 10 * 60_000,    // goals rarely change
  'active-projects': 5 * 60_000, // project status changes slowly
};
async function cached(key, fn) {
  const ttl = CACHE_TTL_OVERRIDES[key] || CACHE_TTL_MS;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const value = await fn();
  cache.set(key, { v: value, t: Date.now() });
  return value;
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

async function queryTasks(dataSourceId, { peopleProp, myDayOnly } = {}) {
  const and = [{ property: 'Status', status: { does_not_equal: 'Done' } }];
  if (myDayOnly) and.push({ property: 'My Day', checkbox: { equals: true } });
  if (peopleProp) and.push({ property: peopleProp, people: { contains: GRETCHEN_USER_ID } });
  return notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: { and },
    sorts: [{ property: 'Due', direction: 'ascending' }],
    page_size: 100,
  });
}

function simplifyTask(page, source) {
  const props = page.properties || {};
  const due = props.Due?.date || {};
  return {
    id: page.id,
    name: props.Name?.title?.[0]?.plain_text || '(untitled)',
    source,
    status: props.Status?.status?.name || null,
    dueStart: due.start || null,
    dueEnd: due.end || null,
    edited: page.last_edited_time || null,
    myDay: !!props['My Day']?.checkbox,
    recurring: !!props['Recurring?']?.checkbox,
    recurUnit: props['Recur Unit']?.select?.name || null,
    recurInterval: props['Recur Interval']?.number || null,
    priority: props['Priority 2']?.select?.name || props.Priority?.status?.name || null,
    project: null,
    url: page.url,
  };
}

async function workTasks({ myDayOnly }) {
  const data = await queryTasks(WORK_TASKS_DS, { peopleProp: 'Assigned', myDayOnly });
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

function authedClient(account = 'work') {
  const token = process.env[ACCOUNT_ENVS[account]];
  if (!token) return null;
  const oauth = makeOAuthClient();
  oauth.setCredentials({ refresh_token: token });
  return oauth;
}

function configuredAccounts() {
  return ACCOUNTS.filter((a) => !!process.env[ACCOUNT_ENVS[a]]);
}

// Dev-only: auto-authenticate so localhost preview doesn't need Google sign-in.
if (!IS_PROD) {
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), version: 'day-6' });
});

app.get('/login', (req, res) => {
  if (req.session?.userEmail === ALLOWED_EMAIL) return res.redirect('/');
  const errMsg = req.query.error === 'denied'
    ? '<p style="color:#ff6b6b;margin-top:1rem;font-size:0.85rem">Access denied. This LifeOS is private.</p>'
    : '';
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>LifeOS — Sign in</title>
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
    <h1>LifeOS</h1>
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
    if (data.email !== ALLOWED_EMAIL) {
      return res.redirect('/login?error=denied');
    }
    req.session.userEmail = data.email;
    req.session.userName = data.name || data.email;
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
  if (req.session?.userEmail === ALLOWED_EMAIL) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'auth required' });
  }
  res.redirect('/login');
}

app.use(requireAuth);

// ----- PROTECTED ROUTES (below this point require login) -----

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
    const envName = ACCOUNT_ENVS[account];
    const oauth = makeOAuthClient(req);
    const { tokens } = await oauth.getToken(code);
    const refresh = tokens.refresh_token || '(none — revoke prior consent and try again)';
    res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>LifeOS — auth (${account})</title></head>
<body style="background:#0a0f1e;color:#f5f5f7;font-family:ui-monospace,Menlo,monospace;padding:2rem;line-height:1.5">
  <h1 style="color:#a7c140;font-family:Georgia,serif">Refresh token captured — ${account}</h1>
  <p>Copy this and add to Railway as <code style="background:#131a30;padding:0.1rem 0.4rem;border-radius:4px">${envName}</code>:</p>
  <pre style="background:#131a30;padding:1rem;border-radius:8px;overflow-x:auto;user-select:all">${refresh}</pre>
  <p style="opacity:0.6;font-size:0.85rem">Then redeploy. Do not share this token.</p>
</body></html>`);
  } catch (err) {
    res.status(500).send('OAuth error: ' + err.message);
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
  ['work-myday', 'life-myday', 'work-all', 'life-all', 'tasks-all', 'goals', 'review', 'xero-finance', 'journal-rings', 'calendar-today'].forEach(k => cache.delete(k));
}

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
      const tasksRes = await notion.dataSources.query({
        data_source_id: tasksDs,
        filter: {
          and: [
            { property: projectPropName, relation: { contains: proj.id } },
            { property: 'Milestone', checkbox: { equals: true } },
          ],
        },
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
    if (req.query.fresh === '1' || req.query.fresh === 'true') cache.delete('goals');
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
  const { source, name, status, priority, myDay, dueStart } = req.body || {};
  if (!source || !name) return res.status(400).json({ error: 'source and name are required' });
  try {
    const result = await createNotionTask({ source, name, status, priority, myDay, dueStart });
    invalidateTaskCaches();
    res.json({ ok: true, id: result.id, url: result.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { id } = req.params;
  const { name, status, dueStart, dueEnd, myDay, priority } = req.body || {};
  try {
    const properties = {};
    if (name !== undefined && name !== null) {
      properties.Name = { title: [{ text: { content: String(name) } }] };
    }
    if (status !== undefined) properties.Status = { status: { name: status } };
    if (dueStart !== undefined || dueEnd !== undefined) {
      properties.Due = dueStart
        ? { date: { start: dueStart, end: dueEnd || null } }
        : { date: null };
    }
    if (myDay !== undefined) properties['My Day'] = { checkbox: !!myDay };
    if (priority !== undefined) {
      properties['Priority 2'] = priority ? { select: { name: priority } } : { select: null };
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

app.get('/api/tasks/all', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const tasks = await cached('tasks-all', async () => {
      const [w, l] = await Promise.all([
        workTasks({ myDayOnly: false }),
        lifeTasks({ myDayOnly: false }),
      ]);
      return [...w, ...l];
    });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      unread: Array.isArray(msg.labelIds) ? msg.labelIds.includes('UNREAD') : false,
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

// ----- AI: Daily Brief -----

const BRIEF_SYSTEM = `You write a live Daily Focus briefing for Gretchen Cawthon — integrator and systems architect at Left Right Labs.

CRITICAL: This is a LIVE check based on the current time, NOT a recap of the whole day. Focus only on:
- What's UPCOMING on her calendar (events starting after now)
- Tasks still open on her My Day list
- Anything time-sensitive that's slipping (overdue, deadline approaching)
- One forward-looking observation: what to prioritize next, what to skip, what's worth pausing for

DO NOT recap events or work she's already completed. DO NOT mention things in the past. Look forward.

Voice: direct, warm, casual. Like a friend who knows her day. Uses ellipses sometimes; never em-dashes. No corporate tone. No "let's" or "looks like you've got a busy afternoon!" Skip preambles.

Format: 3-4 sentences. Plain text — no markdown, no bullets, no headers.

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
      priority: props['Priority 2']?.select?.name || props.Priority?.status?.name || null,
      myDay: !!props['My Day']?.checkbox,
      hasProject: projectRel.length > 0,
      projectIds: projectRel.map((r) => r.id),
      edited: p.last_edited_time || null,
      url: p.url,
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
  return { all, overdue, noProjectNoDue, stale, stuckWaiting };
}

app.get('/api/review', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const data = await cached('review', async () => {
      const activeProjectIds = await cached('active-projects', fetchActiveProjectIds);
      const [work, personal] = await Promise.all([
        reviewTasksForSource(WORK_TASKS_DS, 'work', 'Assigned', activeProjectIds),
        reviewTasksForSource(LIFE_TASKS_DS, 'personal', null, activeProjectIds),
      ]);
      const combine = (k) => [...work[k], ...personal[k]];
      return {
        overdue: combine('overdue'),
        noProjectNoDue: combine('noProjectNoDue'),
        stale: combine('stale'),
        stuckWaiting: combine('stuckWaiting'),
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
    textProp: 'Morning Ritual',
    doneProp: 'Morning Done',
    steps: ['birthdays', 'inboxes', 'notionComments', 'slackMessages', 'reviewCalendar', 'braindump', 'sequence', 'checkin', 'marketing', 'salesTouchpoints'],
  },
  evening: {
    textProp: 'Evening Ritual',
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
      hasMorningProperty: !!row.properties?.['Morning Ritual'],
      hasEveningProperty: !!row.properties?.['Evening Ritual'],
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
  const [work, life] = await Promise.all([
    notion.dataSources.query({
      data_source_id: WORK_PROJECTS_DS,
      filter: { property: 'Archived', checkbox: { equals: false } },
      page_size: 100,
    }).catch(() => ({ results: [] })),
    notion.dataSources.query({
      data_source_id: LIFE_PROJECTS_DS,
      filter: { property: 'Archived', checkbox: { equals: false } },
      page_size: 100,
    }).catch(() => ({ results: [] })),
  ]);
  return [
    ...work.results.map((p) => ({ id: p.id, source: 'work', name: p.properties.Name?.title?.[0]?.plain_text || '(untitled)' })),
    ...life.results.map((p) => ({ id: p.id, source: 'personal', name: p.properties.Name?.title?.[0]?.plain_text || '(untitled)' })),
  ];
}

async function gatherTodayContext() {
  const [calEvents, workMyDay, lifeMyDay, goals] = await Promise.all([
    Promise.all(configuredAccounts().map((a) => fetchToday(a).catch(() => []))).then((r) => r.flat()),
    workTasks({ myDayOnly: true }).catch(() => []),
    lifeTasks({ myDayOnly: true }).catch(() => []),
    cached('goals', async () => {
      const [w, l] = await Promise.all([
        fetchGoalsForSource(WORK_PROJECTS_DS, WORK_TASKS_DS, 'work', 'Project'),
        fetchGoalsForSource(LIFE_PROJECTS_DS, LIFE_TASKS_DS, 'personal', 'Project'),
      ]);
      return [...w, ...l];
    }).catch(() => []),
  ]);
  return { calEvents, workMyDay, lifeMyDay, goals };
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
  const workActionable = workMyDay.filter((t) => !isWaiting(t));
  const workWaiting = workMyDay.filter(isWaiting);
  const lifeActionable = lifeMyDay.filter((t) => !isWaiting(t));
  const lifeWaiting = lifeMyDay.filter(isWaiting);
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
  const cacheKey = `focus-${today}-${bucket}`;
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
      system: BRIEF_SYSTEM,
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
- create_task: a new Notion task. source = "work" or "personal". Required: name. Optional: dueStart (YYYY-MM-DD), myDay (boolean), priority ("URGENT" | "HIGH" | "NORMAL" | null), projectId (uuid from the project list), projectRef (string — the exact "name" of a create_project action earlier in this same plan; the server resolves it to the new project's id after creation), status ("Planned" | "Doing" | "Waiting" | "Agenda" | "Done" — defaults to Planned), body (string — appears as paragraph(s) in the Notion task page body; use this to preserve email context, URLs, or notes. Plain text only, separate paragraphs with blank lines).
- update_task: change fields on an existing Notion task. Required: taskId (uuid from ALL OPEN TASKS context — use the EXACT id shown). Optional: dueStart (YYYY-MM-DD, or empty string "" to clear), dueEnd, myDay (boolean), priority ("URGENT" | "HIGH" | "NORMAL"), status ("Done" | "Doing" | "Planned" | "Agenda" | "Waiting"), name (string).
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
Priority defaults to null. Only set HIGH/URGENT if she signals urgency.
Date parsing: "tomorrow", "Friday", "next week" — anchor to today's date.

Each action gets a short "label" (e.g. "Task: Email Trina about Rock 3 → work, due Fri Jun 12, My Day").

Be conservative on captures. If she dumps 12 thoughts, emit 12 actions — don't bundle. If something is ambiguous, skip it.
Be helpful on queries. If she asks something and you don't have the data, say so plainly.`;

const TRIAGE_JSON_HINT = `Return ONLY valid JSON in this exact shape, no prose, no markdown, no code fences:
{
  "intro": "one sentence, warm casual tone",
  "actions": [
    { "type": "create_project", "label": "short summary", "source": "work"|"personal", "name": "project name" },
    { "type": "create_task", "label": "short summary", "source": "work"|"personal", "name": "task name", "dueStart": "YYYY-MM-DD" (optional), "myDay": true|false (optional), "priority": "URGENT"|"HIGH"|"NORMAL" (optional), "status": "Planned"|"Doing"|"Waiting"|"Agenda" (optional, default Planned), "projectId": "uuid" (optional), "projectRef": "exact name of a create_project in this same plan" (optional), "body": "optional multi-line plain text — email link, notes, context" },
    { "type": "update_task", "label": "short summary of what's changing", "taskId": "exact uuid from ALL OPEN TASKS", "dueStart": "YYYY-MM-DD"|"" (optional), "myDay": true|false (optional), "priority": "URGENT"|"HIGH"|"NORMAL" (optional), "status": "Done"|"Doing"|"Planned"|"Agenda"|"Waiting" (optional), "name": "new name" (optional) },
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
    catch (e) { return res.status(500).json({ error: 'invalid JSON from model: ' + e.message, raw }); }
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

async function createNotionTask({ source, name, dueStart, myDay, priority, projectId, body, status }) {
  const dsId = TASK_DS_BY_SOURCE[source];
  if (!dsId) throw new Error(`unknown source: ${source}`);
  const properties = {
    Name: { title: [{ text: { content: name } }] },
    Status: { status: { name: status || 'Planned' } },
  };
  if (myDay) properties['My Day'] = { checkbox: true };
  if (dueStart) properties.Due = { date: { start: dueStart, end: null } };
  if (priority) properties['Priority 2'] = { select: { name: priority } };
  if (projectId) properties.Project = { relation: [{ id: projectId }] };
  if (source === 'work') {
    properties.Assigned = { people: [{ id: GRETCHEN_USER_ID }] };
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
  if (priority !== undefined && priority !== null) properties['Priority 2'] = priority ? { select: { name: priority } } : { select: null };
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
    return { name, status, project: projName };
  };
  const all = pages.map(decorate);
  return {
    doing: all.filter((t) => t.status === 'Doing' || t.status === 'Planned'),
    waiting: all.filter((t) => t.status === 'Waiting'),
  };
}

function formatCheckinMessage({ events, doing, waiting }) {
  const lines = [];
  if (events.length) {
    lines.push('*Here are the meetings I have today:*', '');
    events.forEach((e, i) => {
      const time = e.allDay ? 'All day' : fmtCheckinTime(e.start);
      const label = e.isInternal ? `${e.title} [LRL Team]` : e.title;
      lines.push(`${i + 1}. ${label} (${time})`);
    });
    lines.push('');
  }
  if (doing.length) {
    lines.push(`*Here's what I'm working on:*`, '');
    doing.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.name} | ${t.project}`);
    });
    lines.push('');
  }
  if (waiting.length) {
    lines.push(`*Here's what I'm waiting on:*`, '');
    waiting.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.name} | ${t.project}`);
    });
    lines.push('');
  }
  return lines.join('\n').trim();
}

app.get('/api/checkin/compose', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    // Compose always fetches fresh from Notion — also bust task caches so
    // Today's Quest reflects the same My Day state on next render.
    invalidateTaskCaches();
    const [events, tasks] = await Promise.all([
      checkinFetchCalendar().catch((err) => {
        console.error('Checkin calendar error:', err.message);
        return [];
      }),
      checkinFetchTasks(),
    ]);
    const message = formatCheckinMessage({
      events,
      doing: tasks.doing,
      waiting: tasks.waiting,
    });
    res.json({
      message,
      counts: { events: events.length, doing: tasks.doing.length, waiting: tasks.waiting.length },
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
  // Prefer the user token (post as the actual user) when configured,
  // otherwise fall back to the bot token (posts as the LifeOS app).
  const userToken = process.env.SLACK_USER_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  console.log('[checkin] tokens — user:', userToken ? userToken.slice(0,5) : 'MISSING', 'bot:', botToken ? botToken.slice(0,5) : 'MISSING');
  const token = userToken || botToken;
  if (!token) return res.status(500).json({ error: 'Slack token not configured (set SLACK_USER_TOKEN or SLACK_BOT_TOKEN)' });
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

const XERO_SCOPES = [
  'offline_access',
  'accounting.reports.aged.read',
  'accounting.reports.banksummary.read',
  'accounting.reports.profitandloss.read',
  'accounting.reports.balancesheet.read',
  'accounting.contacts.read',
  'accounting.banktransactions.read',
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
}
let _xeroRefresh = loadXeroPersistedToken() || process.env.XERO_REFRESH_TOKEN || null;
if (_xeroRefresh) console.log('[xero] init token source:', loadXeroPersistedToken() ? 'disk' : 'env');

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

async function xeroGet(path, params) {
  const token = await getXeroAccessToken();
  const tenantId = process.env.XERO_TENANT_ID || '';
  if (!tenantId) throw new Error('XERO_TENANT_ID missing — visit /auth/xero to authorize');
  const url = `https://api.xero.com${path}` + (params ? `?${new URLSearchParams(params)}` : '');
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json',
    },
  });
  if (!r.ok) throw new Error(`Xero API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

app.get('/auth/xero', (req, res) => {
  if (!process.env.XERO_CLIENT_ID) return res.status(500).send('Set XERO_CLIENT_ID in Railway first.');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.XERO_CLIENT_ID,
    redirect_uri: `${originFromReq(req)}/auth/xero/callback`,
    scope: XERO_SCOPES.join(' '),
    state: 'lifeos',
  });
  res.redirect(`https://login.xero.com/identity/connect/authorize?${params}`);
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
<p>Then redeploy. <a href="/">Back to LifeOS →</a></p>
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

app.get('/api/finance/xero', async (_req, res) => {
  try {
    const data = await cached('xero-finance', async () => {
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

      const xLog = (name) => (err) => { console.error(`[xero] ${name} failed:`, err.message); return null; };
      const [bankRaw, mtdRaw, qtdRaw, ytdRaw, burnRaw, bsRaw, vtoGoals] = await Promise.all([
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
      ]);
      const bank = bankRaw ? parseBankSummary(bankRaw.Reports?.[0]) : { accounts: [], totalCash: 0 };
      const mtd = mtdRaw ? parseProfitAndLoss(mtdRaw.Reports?.[0]) : { income: 0, expenses: 0, net: 0 };
      const qtd = qtdRaw ? parseProfitAndLoss(qtdRaw.Reports?.[0]) : { income: 0, expenses: 0, net: 0 };
      const ytd = ytdRaw ? parseProfitAndLoss(ytdRaw.Reports?.[0]) : { income: 0, expenses: 0, net: 0 };
      const burn = burnRaw ? parseProfitAndLoss(burnRaw.Reports?.[0]) : { income: 0, expenses: 0, net: 0 };
      const bs = bsRaw ? parseBalanceSheet(bsRaw.Reports?.[0]) : { accountsReceivable: 0, accountsPayable: 0 };
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
      const runwayMonths = monthlyBurn > 0 ? bank.totalCash / monthlyBurn : null;

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
        goals: {
          revenue: revenueGoals,
          profit: profitGoals,
        },
        asOf: new Date().toISOString(),
      };
    });
    res.json(data);
  } catch (err) {
    console.error('Xero finance error:', err.message);
    const needsAuth = /XERO_(REFRESH_TOKEN|TENANT_ID)/.test(err.message)
      || /invalid_grant|invalid_token|unauthorized/i.test(err.message);
    res.status(500).json({ error: err.message, needsAuth });
  }
});

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
<p style="margin-top:24px"><a href="/">← Back to LifeOS</a></p>
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

// =========================== SALES PIPELINE ===========================
const SALES_PIPELINE_DS = 'cec1b3e9-791d-4a55-bd80-b0226552f543';
const SALES_PRODUCTS_DS = '6e492b13-f5c7-4b8f-812e-3e05f1dc48ee';

// Canonical funnel order + grouping (open vs won vs lost). Mirrors the
// Pipeline Status options in Notion's SALES PIPELINE board.
const SALES_STAGES = [
  { name: 'New / To Qualify', group: 'open' },
  { name: 'Engaged / In Conversation', group: 'open' },
  { name: 'Consult Scheduled', group: 'open' },
  { name: 'No Show / Reschedule', group: 'open' },
  { name: 'Consult Completed', group: 'open' },
  { name: 'Build Scope', group: 'open' },
  { name: 'Decision Pending', group: 'open' },
  { name: 'On Hold', group: 'open' },
  { name: 'Closed Won', group: 'won' },
  { name: 'Closed Lost', group: 'lost' },
];
const SALES_STAGE_INDEX = Object.fromEntries(SALES_STAGES.map((s, i) => [s.name, i]));
const SALES_STAGE_GROUP = Object.fromEntries(SALES_STAGES.map((s) => [s.name, s.group]));

// product page-id (dashless) -> Product Name
async function fetchSalesProductMap() {
  return cached('sales-product-map', async () => {
    const map = {};
    let cursor;
    do {
      const r = await notion.dataSources.query({ data_source_id: SALES_PRODUCTS_DS, page_size: 100, start_cursor: cursor });
      for (const p of r.results) {
        const name = p.properties?.['Product Name']?.title?.[0]?.plain_text || '';
        if (name) map[p.id.replace(/-/g, '')] = name;
      }
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    return map;
  });
}

function serializeDeal(page, productMap, opts = {}) {
  const p = page.properties || {};
  const rt = (prop) => (prop?.rich_text || []).map((t) => t.plain_text).join('');
  const archivedName = p.Archived?.status?.name || p.Archived?.select?.name || '';
  const out = {
    id: page.id,
    url: page.url,
    name: p['Deal Name']?.title?.[0]?.plain_text || '(untitled deal)',
    value: typeof p['Deal Value']?.number === 'number' ? p['Deal Value'].number : null,
    status: p['Pipeline Status']?.status?.name || null,
    typeOfSale: p['Type of Sale']?.select?.name || null,
    callBooked: p['Call Booked']?.date?.start || null,
    callCompleted: p['Call Completed']?.date?.start || null,
    dateWon: p['Date Won']?.date?.start || null,
    dateLost: p['Date Lost']?.date?.start || null,
    products: (p['Product Interest']?.relation || []).map((r) => productMap[r.id.replace(/-/g, '')]).filter(Boolean),
    archived: archivedName === '__YES__',
    created: page.created_time || null,
  };
  const recon = rt(p.Recon);
  if (opts.includeRecon) out.recon = recon;
  out.hasRecon = !!recon.trim();
  return out;
}

async function queryAllDeals() {
  const all = [];
  let cursor;
  do {
    const r = await notion.dataSources.query({
      data_source_id: SALES_PIPELINE_DS,
      sorts: [{ property: 'Deal Value', direction: 'descending' }],
      page_size: 100,
      start_cursor: cursor,
    });
    all.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return all;
}

// GET /api/sales/pipeline — open deals grouped by stage + headline metrics.
app.get('/api/sales/pipeline', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') cache.delete('sales-pipeline');
    const data = await cached('sales-pipeline', async () => {
      const productMap = await fetchSalesProductMap().catch(() => ({}));
      const pages = await queryAllDeals();
      const deals = pages.map((pg) => serializeDeal(pg, productMap)).filter((d) => !d.archived);
      const q = currentQuarter();
      const openStages = SALES_STAGES.filter((s) => s.group === 'open');
      const stages = openStages.map((s) => ({ name: s.name, deals: [], count: 0, value: 0 }));
      const byName = Object.fromEntries(stages.map((s) => [s.name, s]));
      let openCount = 0, openValue = 0;
      const won = { count: 0, value: 0 }, lost = { count: 0 };
      const recentWins = [];
      for (const d of deals) {
        const grp = SALES_STAGE_GROUP[d.status] || 'open';
        if (grp === 'open') {
          const bucket = byName[d.status] || byName['New / To Qualify'];
          if (bucket) { bucket.deals.push(d); bucket.count++; bucket.value += d.value || 0; }
          openCount++; openValue += d.value || 0;
        } else if (grp === 'won') {
          if (d.dateWon && d.dateWon >= q.start && d.dateWon <= q.end) { won.count++; won.value += d.value || 0; }
          recentWins.push(d);
        } else if (grp === 'lost') {
          if (d.dateLost && d.dateLost >= q.start && d.dateLost <= q.end) lost.count++;
        }
      }
      recentWins.sort((a, b) => (b.dateWon || '').localeCompare(a.dateWon || ''));
      const decided = won.count + lost.count;
      return {
        stages: stages.filter((s) => s.count > 0),
        openCount, openValue,
        won, lost,
        winRate: decided ? Math.round((won.count / decided) * 100) : null,
        quarterLabel: q.label,
        recentWins: recentWins.slice(0, 12),
      };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/sales/deal/:id — full single deal incl. the Recon brief.
app.get('/api/sales/deal/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const productMap = await fetchSalesProductMap().catch(() => ({}));
    const page = await notion.pages.retrieve({ page_id: dashifyId(req.params.id) });
    res.json({ deal: serializeDeal(page, productMap, { includeRecon: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/sales/deal/:id — move stage, edit value, mark won/lost.
app.patch('/api/sales/deal/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { status, value, dateWon, dateLost } = req.body || {};
  try {
    const properties = {};
    if (status !== undefined && status !== null) {
      properties['Pipeline Status'] = { status: { name: status } };
      // Stamp the win/loss date automatically when entering a closed stage.
      if (status === 'Closed Won' && dateWon === undefined) properties['Date Won'] = { date: { start: chicagoTodayISODate() } };
      if (status === 'Closed Lost' && dateLost === undefined) properties['Date Lost'] = { date: { start: chicagoTodayISODate() } };
    }
    if (value !== undefined) properties['Deal Value'] = { number: value === null || value === '' ? null : Number(value) };
    if (dateWon !== undefined) properties['Date Won'] = dateWon ? { date: { start: dateWon } } : { date: null };
    if (dateLost !== undefined) properties['Date Lost'] = dateLost ? { date: { start: dateLost } } : { date: null };
    if (!Object.keys(properties).length) return res.status(400).json({ error: 'no supported fields to update' });
    await notion.pages.update({ page_id: dashifyId(req.params.id), properties });
    cache.delete('sales-pipeline');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =========================== SALES PULSE TRACKER ===========================
const CONTACTS_DS = '28d458f0-8cd9-8178-b291-000bdc3fb399';
const SALES_ACTIVITY_DS = 'b5d8dd3c-303b-49c2-96cf-23b2cfa476ae';
const TRINA_USER_ID = 'eea4c3fe-668e-4ce7-a8e8-30314ff7f986';
const PULSE_RELATIONSHIPS = ['Alumni', 'Network Partner', 'Lead', 'Active Client'];
// Touchpoint types that count as low-lift "pulse" outreach (vs. real sales moves)
const PULSE_TOUCHPOINTS = ['👋 General Touchpoint', '🙏 Thank You / Nurture'];
const PULSE_GOAL = 85;
const SALES_GOAL = 15;

// Plain UTC date math on YYYY-MM-DD strings (all values here are date-only).
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekStartISO(iso) {
  // Monday of the week containing iso.
  const d = new Date(iso + 'T00:00:00Z');
  const back = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return addDaysISO(iso, -back);
}

function serializeContactRow(page) {
  const p = page.properties || {};
  const lt = p['Last Touched']?.date?.start || null;
  return {
    id: page.id,
    name: p['Full Name']?.title?.[0]?.plain_text || '(no name)',
    relationship: p['Relationship']?.select?.name || null,
    lastTouched: lt,
  };
}

// GET /api/sales/overdue — active-relationship contacts, never/oldest touched first.
app.get('/api/sales/overdue', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    // Optional ?rel= filters to a single relationship (else all four).
    const rel = PULSE_RELATIONSHIPS.includes(req.query.rel) ? req.query.rel : null;
    const cacheKey = rel ? `sales-overdue-${rel}` : 'sales-overdue';
    if (req.query.fresh === '1') cache.delete(cacheKey);
    const data = await cached(cacheKey, async () => {
      // Two bounded, parallel queries instead of paginating the whole (800+)
      // contact list — never-touched, plus oldest-touched (Notion-sorted). This
      // surfaces exactly the most-overdue without the multi-second full sweep.
      const relFilter = rel
        ? { property: 'Relationship', select: { equals: rel } }
        : { or: PULSE_RELATIONSHIPS.map((name) => ({ property: 'Relationship', select: { equals: name } })) };
      const baseAnd = (extra) => ({ and: [ { property: 'Archive', checkbox: { equals: false } }, relFilter, extra ] });
      const [neverRes, touchedRes] = await Promise.all([
        notion.dataSources.query({ data_source_id: CONTACTS_DS, filter: baseAnd({ property: 'Last Touched', date: { is_empty: true } }), page_size: 100 }),
        notion.dataSources.query({ data_source_id: CONTACTS_DS, filter: baseAnd({ property: 'Last Touched', date: { is_not_empty: true } }), sorts: [{ property: 'Last Touched', direction: 'ascending' }], page_size: 60 }),
      ]);
      const today = chicagoTodayISODate();
      const out = [...neverRes.results, ...touchedRes.results].map(serializeContactRow);
      out.forEach((c) => { c.daysSince = c.lastTouched ? Math.max(0, Math.round((new Date(today) - new Date(c.lastTouched)) / 864e5)) : null; });
      // Never-touched first (alphabetical), then oldest-touched first.
      out.sort((a, b) => {
        if (!a.lastTouched && !b.lastTouched) return a.name.localeCompare(b.name);
        if (!a.lastTouched) return -1;
        if (!b.lastTouched) return 1;
        return a.lastTouched.localeCompare(b.lastTouched);
      });
      return { contacts: out, total: out.length, more: neverRes.has_more || touchedRes.has_more };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/sales/pulse — this-week pulse vs sales counts, goals, and weekly streak.
app.get('/api/sales/pulse', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') cache.delete('sales-pulse');
    const data = await cached('sales-pulse', async () => {
      const today = chicagoTodayISODate();
      const curMon = weekStartISO(today);
      const sinceMon = addDaysISO(curMon, -7 * 26); // ~26 weeks of history for the streak
      const rows = [];
      let cursor;
      do {
        const r = await notion.dataSources.query({
          data_source_id: SALES_ACTIVITY_DS,
          filter: { property: 'Timestamp', date: { on_or_after: sinceMon } },
          page_size: 100,
          start_cursor: cursor,
        });
        for (const pg of r.results) {
          const ts = pg.properties?.Timestamp?.date?.start;
          const type = pg.properties?.['Touchpoint Type']?.select?.name || '';
          if (ts) rows.push({ week: weekStartISO(ts.slice(0, 10)), isPulse: PULSE_TOUCHPOINTS.includes(type) });
        }
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      // Tally per week.
      const wk = {};
      for (const r of rows) { const w = (wk[r.week] = wk[r.week] || { pulse: 0, sales: 0 }); if (r.isPulse) w.pulse++; else w.sales++; }
      const cur = wk[curMon] || { pulse: 0, sales: 0 };
      // Streak: count consecutive met weeks ending at the current week. A current
      // week that hasn't hit goal yet doesn't break the streak (it's in progress).
      let streak = 0, wkCursor = curMon, first = true;
      for (let i = 0; i < 60; i++) {
        const c = wk[wkCursor] || { pulse: 0, sales: 0 };
        const met = c.sales >= SALES_GOAL;
        if (met) streak++;
        else if (first) { /* current week not yet met — skip, don't break */ }
        else break;
        first = false;
        wkCursor = addDaysISO(wkCursor, -7);
      }
      return {
        pulse: cur.pulse, pulseGoal: PULSE_GOAL,
        sales: cur.sales, salesGoal: SALES_GOAL,
        streak, weekStart: curMon, weekEnd: addDaysISO(curMon, 6),
      };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/sales/contacts?q= — search active contacts for the drawer dropdown.
app.get('/api/sales/contacts', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const q = (req.query.q || '').trim();
    const filter = q
      ? { and: [ { property: 'Archive', checkbox: { equals: false } }, { property: 'Full Name', title: { contains: q } } ] }
      : { property: 'Archive', checkbox: { equals: false } };
    const r = await notion.dataSources.query({
      data_source_id: CONTACTS_DS,
      filter,
      sorts: q ? undefined : [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: 25,
    });
    res.json({ contacts: r.results.map(serializeContactRow) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sales/touchpoint — log an activity + bump the contact's Last Touched.
app.post('/api/sales/touchpoint', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { contactId, contactName, touchpointType, channel, notes, loggedBy, timestamp } = req.body || {};
  if (!contactId || !touchpointType) return res.status(400).json({ error: 'contactId and touchpointType are required' });
  const when = /^\d{4}-\d{2}-\d{2}$/.test(timestamp || '') ? timestamp : chicagoTodayISODate();
  try {
    const title = `${(contactName || 'Contact')} — ${touchpointType}`;
    const properties = {
      Description: { title: [{ text: { content: title.slice(0, 200) } }] },
      'Touchpoint Type': { select: { name: touchpointType } },
      Timestamp: { date: { start: when } },
      Contact: { relation: [{ id: dashifyId(contactId) }] },
      'Logged By': { people: [{ id: loggedBy === 'Trina' ? TRINA_USER_ID : GRETCHEN_USER_ID }] },
    };
    if (channel) properties.Channel = { select: { name: channel } };
    if (notes && String(notes).trim()) properties.Notes = { rich_text: [{ text: { content: String(notes).slice(0, 1900) } }] };
    const page = await notion.pages.create({ parent: { type: 'data_source_id', data_source_id: SALES_ACTIVITY_DS }, properties });
    // Bump Last Touched on the contact to the interaction date.
    try { await notion.pages.update({ page_id: dashifyId(contactId), properties: { 'Last Touched': { date: { start: when } } } }); } catch (e) { console.error('Last Touched update failed:', e.message); }
    cache.delete('sales-pulse');
    for (const k of cache.keys()) if (k.startsWith('sales-overdue')) cache.delete(k);
    res.json({ ok: true, id: page.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =========================== MARKETING PUBLISHING ===========================
const MARKETING_ASSETS_DS = '4170ff99-ce76-42b5-bcf2-7f672c362ec4';
const MARKETING_CHANNELS_DS = '87918a28-58ab-43d9-a038-7f0adec3f5d5';

// The asset's per-channel published-URL columns. Each field name is identical
// to the channel's "Channel Name" in CHANNELS [DB], which lets us map an
// asset's CHANNELS relation straight onto the field to paste the live URL into.
const MARKETING_CHANNEL_FIELDS = [
  'LinkedIn (Gretchen)', 'LinkedIn (Trina)', 'LinkedIn (Company)',
  'Facebook Page', 'Facebook Group', 'FB Profile (Gretchen)',
  'Instagram', 'YouTube', 'Brandwave', 'LRL Blog',
];

function marketingPlatform(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('linkedin')) return 'linkedin';
  if (n.includes('instagram')) return 'instagram';
  if (n.includes('facebook') || n.startsWith('fb ')) return 'facebook';
  if (n.includes('youtube')) return 'youtube';
  if (n.includes('blog')) return 'blog';
  if (n.includes('brandwave') || n.includes('email') || n.includes('wave')) return 'email';
  return 'other';
}

function dashifyId(id) {
  const s = String(id || '').replace(/-/g, '');
  return s.length === 32
    ? `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`
    : id;
}

function invalidateMarketingCaches() {
  for (const k of cache.keys()) if (k.startsWith('marketing-')) cache.delete(k);
}

// channel page-id (dashless) -> Channel Name
async function fetchMarketingChannelMap() {
  return cached('marketing-channel-map', async () => {
    const map = {};
    let cursor;
    do {
      const r = await notion.dataSources.query({ data_source_id: MARKETING_CHANNELS_DS, page_size: 100, start_cursor: cursor });
      for (const p of r.results) {
        const name = p.properties?.['Channel Name']?.title?.[0]?.plain_text || '';
        if (name) map[p.id.replace(/-/g, '')] = name;
      }
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    return map;
  });
}

function marketingFileEntry(f, assetIdDashless, idx) {
  const name = f.name || 'file';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const isImage = ['png','jpg','jpeg','gif','webp','heic','svg','bmp'].includes(ext);
  const isPdf = ext === 'pdf';
  const isVideo = ['mp4','mov','webm','m4v'].includes(ext);
  return {
    name, ext,
    kind: isImage ? 'image' : isPdf ? 'pdf' : isVideo ? 'video' : 'other',
    // Always proxy through our server: Notion's signed URLs expire (~1h) and
    // block cross-origin download. ?dl=1 forces an attachment download.
    src: `/api/marketing/media?asset=${assetIdDashless}&idx=${idx}`,
    download: `/api/marketing/media?asset=${assetIdDashless}&idx=${idx}&dl=1`,
  };
}

function serializeMarketingAsset(page, channelMap, opts = {}) {
  const p = page.properties || {};
  const rt = (prop) => (prop?.rich_text || []).map((t) => t.plain_text).join('');
  const idDashless = page.id.replace(/-/g, '');
  const media = (p.Media?.files || []).map((f, i) => marketingFileEntry(f, idDashless, i));

  // Channels: targeted (from CHANNELS relation, mapped by name to a field) first,
  // then any field that already holds a live URL even if not explicitly targeted.
  const channels = [];
  const seen = new Set();
  const targetedNames = (p.CHANNELS?.relation || [])
    .map((r) => channelMap[r.id.replace(/-/g, '')])
    .filter(Boolean);
  for (const name of targetedNames) {
    if (MARKETING_CHANNEL_FIELDS.includes(name) && !seen.has(name)) {
      seen.add(name);
      channels.push({ name, field: name, platform: marketingPlatform(name), url: p[name]?.url || '', targeted: true });
    }
  }
  for (const field of MARKETING_CHANNEL_FIELDS) {
    const val = p[field]?.url || '';
    if (val && !seen.has(field)) {
      seen.add(field);
      channels.push({ name: field, field, platform: marketingPlatform(field), url: val, targeted: false });
    }
  }

  return {
    id: page.id,
    url: page.url,
    name: p['Asset Name']?.title?.[0]?.plain_text || '(untitled)',
    status: p.Status?.status?.name || null,
    publishDate: p['Publish Date']?.date?.start || null,
    formats: (p.Format?.multi_select || []).map((o) => o.name),
    contentType: p['Content Type']?.select?.name || null,
    needs: (p.Needs?.multi_select || []).map((o) => o.name),
    primaryTopic: rt(p['Primary Topic']),
    notes: rt(p.Notes),
    media,
    channels,
  };
}

function marketingRichText(block) {
  const t = block[block.type];
  return (t?.rich_text || []).map((r) => r.plain_text).join('');
}

// Parse a page body into copy "sections" split on headings/dividers, so the UI
// can offer a Copy button per section (e.g. "LinkedIn Caption", "First Comment").
async function fetchMarketingCopy(pageId) {
  const blocks = [];
  let cursor;
  try {
    do {
      const r = await notion.blocks.children.list({ block_id: pageId, page_size: 100, start_cursor: cursor });
      blocks.push(...r.results);
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
  } catch (_) { return []; }
  const sections = [];
  let cur = { heading: '', lines: [] };
  const flush = () => { if (cur.heading || cur.lines.join('').trim()) sections.push({ heading: cur.heading, text: cur.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() }); };
  for (const b of blocks) {
    const type = b.type;
    if (type === 'heading_1' || type === 'heading_2' || type === 'heading_3') {
      flush(); cur = { heading: marketingRichText(b), lines: [] };
    } else if (type === 'divider') {
      flush(); cur = { heading: '', lines: [] };
    } else if (type === 'bulleted_list_item' || type === 'numbered_list_item') {
      cur.lines.push('• ' + marketingRichText(b));
    } else if (type === 'to_do') {
      cur.lines.push((b.to_do?.checked ? '☑ ' : '☐ ') + marketingRichText(b));
    } else if (['paragraph','quote','callout','heading_toggle','toggle'].includes(type)) {
      cur.lines.push(marketingRichText(b));
    }
  }
  flush();
  return sections.filter((s) => s.heading || s.text);
}

// GET /api/marketing/today — the publish queue: overdue + due-today (with copy),
// plus a lightweight look at the next 7 days and what already went out today.
app.get('/api/marketing/today', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') cache.delete('marketing-today');
    const data = await cached('marketing-today', async () => {
      const channelMap = await fetchMarketingChannelMap();
      const today = chicagoTodayISODate();
      const backBound = chicagoDateNDaysAgo(30);   // overdue up to 30d back
      const weekEnd = chicagoDateNDaysAgo(-7);      // 7 days ahead
      const r = await notion.dataSources.query({
        data_source_id: MARKETING_ASSETS_DS,
        filter: { and: [
          { property: 'Publish Date', date: { on_or_after: backBound } },
          { property: 'Publish Date', date: { on_or_before: weekEnd } },
        ] },
        sorts: [{ property: 'Publish Date', direction: 'ascending' }],
        page_size: 100,
      });
      const assets = r.results.map((pg) => serializeMarketingAsset(pg, channelMap));
      const overdue = [], dueToday = [], thisWeek = [], publishedToday = [];
      for (const a of assets) {
        const d = a.publishDate;
        if (a.status === 'Published') { if (d === today) publishedToday.push(a); continue; }
        if (d < today) overdue.push(a);
        else if (d === today) dueToday.push(a);
        else thisWeek.push(a);
      }
      // Fetch copy only for the actionable queue (overdue + today) to keep it fast.
      await Promise.all([...overdue, ...dueToday].map(async (a) => { a.copy = await fetchMarketingCopy(a.id); }));
      return { today, overdue, dueToday, thisWeek, publishedToday };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/marketing/stats — OKR-shaped output: published counts for the
// quarter / month / year, plus a per-channel breakdown for the quarter.
app.get('/api/marketing/stats', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') cache.delete('marketing-stats');
    const data = await cached('marketing-stats', async () => {
      const channelMap = await fetchMarketingChannelMap();
      const today = chicagoTodayISODate();
      const q = currentQuarter();
      const yearStart = today.slice(0, 4) + '-01-01';
      const monthStart = today.slice(0, 7) + '-01';
      // Pull everything published since the start of the year (covers all 3 windows).
      const pages = [];
      let cursor;
      do {
        const r = await notion.dataSources.query({
          data_source_id: MARKETING_ASSETS_DS,
          filter: { and: [
            { property: 'Status', status: { equals: 'Published' } },
            { property: 'Publish Date', date: { on_or_after: yearStart } },
          ] },
          page_size: 100,
          start_cursor: cursor,
        });
        pages.push(...r.results);
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      const assets = pages.map((pg) => serializeMarketingAsset(pg, channelMap));
      let publishedYear = 0, publishedQuarter = 0, publishedMonth = 0;
      const channelTally = {};
      const channelPlatform = {};
      for (const a of assets) {
        const d = a.publishDate; if (!d) continue;
        publishedYear++;
        if (d >= monthStart && d <= today) publishedMonth++;
        if (d >= q.start && d <= q.end) {
          publishedQuarter++;
          // Tally where it went (targeted channels ∪ channels with a live URL).
          for (const c of a.channels) { channelTally[c.name] = (channelTally[c.name] || 0) + 1; channelPlatform[c.name] = c.platform; }
        }
      }
      const byChannel = Object.entries(channelTally)
        .map(([name, count]) => ({ name, count, platform: channelPlatform[name] || 'other' }))
        .sort((a, b) => b.count - a.count);
      return { quarterLabel: q.label, publishedQuarter, publishedMonth, publishedYear, byChannel };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/marketing/calendar?month=YYYY-MM — lightweight month grid data.
app.get('/api/marketing/calendar', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : chicagoTodayISODate().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const start = `${month}-01`;
    const end = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    const cacheKey = `marketing-cal-${month}`;
    if (req.query.fresh === '1') cache.delete(cacheKey);
    const data = await cached(cacheKey, async () => {
      const channelMap = await fetchMarketingChannelMap();
      const out = [];
      let cursor;
      do {
        const r = await notion.dataSources.query({
          data_source_id: MARKETING_ASSETS_DS,
          filter: { and: [
            { property: 'Publish Date', date: { on_or_after: start } },
            { property: 'Publish Date', date: { on_or_before: end } },
          ] },
          sorts: [{ property: 'Publish Date', direction: 'ascending' }],
          page_size: 100,
          start_cursor: cursor,
        });
        for (const pg of r.results) {
          const a = serializeMarketingAsset(pg, channelMap);
          out.push({ id: a.id, url: a.url, name: a.name, status: a.status, publishDate: a.publishDate, formats: a.formats, contentType: a.contentType, hasMedia: a.media.length > 0 });
        }
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      const days = {};
      for (const a of out) { if (!a.publishDate) continue; (days[a.publishDate] = days[a.publishDate] || []).push(a); }
      return { month, days };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/marketing/asset/:id — a single asset with full copy (lazy detail).
app.get('/api/marketing/asset/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const channelMap = await fetchMarketingChannelMap();
    const page = await notion.pages.retrieve({ page_id: dashifyId(req.params.id) });
    const asset = serializeMarketingAsset(page, channelMap);
    asset.copy = await fetchMarketingCopy(page.id);
    res.json({ asset });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/marketing/asset/:id — update status, publish date, per-channel URLs.
app.patch('/api/marketing/asset/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { status, publishDate, channelUrls } = req.body || {};
  try {
    const properties = {};
    if (status !== undefined && status !== null) properties.Status = { status: { name: status } };
    if (publishDate !== undefined) properties['Publish Date'] = publishDate ? { date: { start: publishDate } } : { date: null };
    for (const [field, url] of Object.entries(channelUrls || {})) {
      if (MARKETING_CHANNEL_FIELDS.includes(field)) properties[field] = { url: url ? String(url) : null };
    }
    if (!Object.keys(properties).length) return res.status(400).json({ error: 'no supported fields to update' });
    await notion.pages.update({ page_id: dashifyId(req.params.id), properties });
    invalidateMarketingCaches();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/marketing/media?asset=<id>&idx=<n>[&dl=1] — proxy a Media file so it
// never 404s on an expired signed URL and can be force-downloaded.
app.get('/api/marketing/media', async (req, res) => {
  if (!notion) return res.status(500).end('no notion');
  try {
    const idx = parseInt(req.query.idx || '0', 10);
    const page = await notion.pages.retrieve({ page_id: dashifyId(req.query.asset || '') });
    const files = page.properties?.Media?.files || [];
    const f = files[idx];
    if (!f) return res.status(404).end('not found');
    const url = f.type === 'external' ? f.external?.url : f.file?.url;
    if (!url) return res.status(404).end('no url');
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).end('upstream failed');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    const name = (f.name || 'download').replace(/["\r\n]/g, '');
    res.setHeader('Content-Disposition', `${req.query.dl === '1' ? 'attachment' : 'inline'}; filename="${name}"`);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) { res.status(500).end(err.message); }
});

const server = app.listen(PORT, () => {
  console.log(`LifeOS listening on port ${PORT}`);
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
