import express from 'express';
import cookieSession from 'cookie-session';
import { Client } from '@notionhq/client';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
  ['work-myday', 'life-myday', 'work-all', 'life-all', 'tasks-all', 'goals', 'review'].forEach(k => cache.delete(k));
}

async function fetchGoalsForSource(projectsDs, tasksDs, source, projectPropName) {
  const projectsRes = await notion.dataSources.query({
    data_source_id: projectsDs,
    filter: { property: 'GOAL', checkbox: { equals: true } },
    page_size: 50,
  });
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

app.get('/api/goals', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
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

app.patch('/api/tasks/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { id } = req.params;
  const { status, dueStart, dueEnd, myDay } = req.body || {};
  try {
    const properties = {};
    if (status !== undefined) properties.Status = { status: { name: status } };
    if (dueStart !== undefined || dueEnd !== undefined) {
      properties.Due = dueStart
        ? { date: { start: dueStart, end: dueEnd || null } }
        : { date: null };
    }
    if (myDay !== undefined) properties['My Day'] = { checkbox: !!myDay };
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

async function fetchInbox(account, userIndex) {
  const auth = authedClient(account);
  if (!auth) return [];
  const gmail = google.gmail({ version: 'v1', auth });
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:inbox is:unread newer_than:7d',
    maxResults: 15,
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
      url: `https://mail.google.com/mail/u/${userIndex}/#inbox/${msg.threadId}`,
    };
  });
}

app.get('/api/comms/gmail', async (_req, res) => {
  const accounts = configuredAccounts();
  if (!accounts.length) {
    return res.status(500).json({ error: 'No Google refresh tokens configured' });
  }
  try {
    const threads = await cached('gmail-inbox', async () => {
      const results = await Promise.all(
        accounts.map((a, i) => fetchInbox(a, i).catch((err) => {
          console.error(`Gmail ${a} error:`, err.message);
          return [];
        })),
      );
      return results.flat().sort((a, b) => (b.internalDate || 0) - (a.internalDate || 0));
    });
    res.json({ threads });
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

function daysSince(iso) {
  if (!iso) return Infinity;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

async function reviewTasksForSource(taskDs, source, peopleProp) {
  // Get all open tasks (Status != Done) — already have these helpers
  const data = await queryTasks(taskDs, { peopleProp, myDayOnly: false });
  const all = data.results.map((p) => {
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
      edited: p.last_edited_time || null,
      url: p.url,
    };
  });
  const todayISO = chicagoTodayISODate();
  const overdue = all.filter((t) => {
    const d = t.dueEnd || t.dueStart;
    return d && d < todayISO && t.status !== 'Done';
  });
  const noProjectNoDue = all.filter((t) => !t.hasProject && !t.dueStart);
  const stale = all.filter((t) => daysSince(t.edited) >= REVIEW_STALE_DAYS);
  const stuckWaiting = all.filter((t) => t.status === 'Waiting' && daysSince(t.edited) >= REVIEW_WAITING_DAYS);
  return { all, overdue, noProjectNoDue, stale, stuckWaiting };
}

app.get('/api/review', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const data = await cached('review', async () => {
      const [work, personal] = await Promise.all([
        reviewTasksForSource(WORK_TASKS_DS, 'work', 'Assigned'),
        reviewTasksForSource(LIFE_TASKS_DS, 'personal', null),
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
      Name: { title: [{ text: { content: title } }] },
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
  const workTasksLines = workMyDay.map(taskLine);
  const lifeTasksLines = lifeMyDay.map(taskLine);
  const goalsLines = goals.map((g) => {
    const pct = g.progress.total ? Math.round((g.progress.done / g.progress.total) * 100) : 0;
    return `  - [${g.source}] ${g.name} — ${g.progress.done}/${g.progress.total} milestones (${pct}%)${g.targetDeadline ? `, target ${g.targetDeadline}` : ''}`;
  });
  return [
    `It is ${dateLabel} — ${timeLabel} (America/Chicago).`,
    '',
    `UPCOMING events (after now) (${upcoming.length}):`,
    upcomingLines.length ? upcomingLines.join('\n') : '  (nothing left on the calendar today)',
    pastSummary,
    '',
    `Work My Day — still open (${workMyDay.length}):`,
    workTasksLines.length ? workTasksLines.join('\n') : '  (none)',
    '',
    `Personal My Day — still open (${lifeMyDay.length}):`,
    lifeTasksLines.length ? lifeTasksLines.join('\n') : '  (none)',
    '',
    `Active goals (${goals.length}):`,
    goalsLines.length ? goalsLines.join('\n') : '  (none flagged)',
    '',
    'Write the Daily Focus. Look forward, not back.',
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
- create_task: a new Notion task. source = "work" or "personal". Required: name. Optional: dueStart (YYYY-MM-DD), myDay (boolean), priority ("URGENT" | "HIGH" | "NORMAL" | null), projectId (uuid from the project list).
- update_task: change fields on an existing Notion task. Required: taskId (uuid from ALL OPEN TASKS context — use the EXACT id shown). Optional: dueStart (YYYY-MM-DD, or empty string "" to clear), dueEnd, myDay (boolean), priority ("URGENT" | "HIGH" | "NORMAL"), status ("Done" | "Doing" | "Planned" | "Agenda" | "Waiting"), name (string).
- create_event: a calendar event. account = "work" or "personal". Required: title, start, end. If allDay=true, start/end are YYYY-MM-DD; otherwise ISO datetime with America/Chicago offset (-05:00 CDT or -06:00 CST). location optional.

For update_task: she'll often say things like "move X to next Friday" or "push the dentist appointment to next week" or "reset the date on Y". Find the matching task in ALL OPEN TASKS by name match, use its exact taskId.

Routing heuristics:
- LRL/clients/business/marketing/work-finance → "work"
- Health/LEGO/household/family/personal finance/errands → "personal"
- If unclear, prefer "personal"

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
    { "type": "create_task", "label": "short summary", "source": "work"|"personal", "name": "task name", "dueStart": "YYYY-MM-DD" (optional), "myDay": true|false (optional), "priority": "URGENT"|"HIGH"|"NORMAL" (optional), "projectId": "uuid" (optional) },
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

    // DYNAMIC context — varies each request. Today's date, calendar, my-day, goals + user input.
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
const PROJECT_PROP_BY_SOURCE = { work: 'Project', personal: 'Project' };

async function createNotionTask({ source, name, dueStart, myDay, priority, projectId }) {
  const dsId = TASK_DS_BY_SOURCE[source];
  if (!dsId) throw new Error(`unknown source: ${source}`);
  const properties = {
    Name: { title: [{ text: { content: name } }] },
    Status: { status: { name: 'Planned' } },
  };
  if (myDay) properties['My Day'] = { checkbox: true };
  if (dueStart) properties.Due = { date: { start: dueStart, end: null } };
  if (priority) properties['Priority 2'] = { select: { name: priority } };
  if (projectId) properties.Project = { relation: [{ id: projectId }] };
  if (source === 'work') {
    properties.Assigned = { people: [{ id: GRETCHEN_USER_ID }] };
  }
  const page = await notion.pages.create({
    parent: { type: 'data_source_id', data_source_id: dsId },
    properties,
  });
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
      const title = (e.summary || '').toLowerCase();
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
    const name = p.properties?.Name?.title?.[0]?.plain_text || '';
    // Exclude "Daily Planning" per the skill spec
    return !/^daily planning$/i.test(name.trim());
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

app.post('/api/checkin/send', async (req, res) => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'SLACK_BOT_TOKEN not configured' });
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
    // Fetch permalink (best-effort)
    let permalink = null;
    try {
      const linkRes = await fetch(
        `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(CHECKIN_SLACK_CHANNEL)}&message_ts=${encodeURIComponent(postData.ts)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const linkData = await linkRes.json();
      if (linkData.ok) permalink = linkData.permalink;
    } catch (_) {}
    res.json({ ok: true, ts: postData.ts, permalink, channel: postData.channel });
  } catch (err) {
    console.error('Checkin send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/triage/apply', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { actions } = req.body || {};
  if (!Array.isArray(actions)) return res.status(400).json({ error: 'actions array required' });
  const results = [];
  for (const a of actions) {
    try {
      if (a.type === 'create_task') {
        if (!a.source || !a.name) throw new Error('create_task requires source + name');
        const r = await createNotionTask(a);
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

const server = app.listen(PORT, () => {
  console.log(`LifeOS listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
