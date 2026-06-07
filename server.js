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
const CACHE_TTL_MS = 60_000;
const TZ = 'America/Chicago';
const DATA_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
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
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
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
  ['work-myday', 'life-myday', 'work-all', 'life-all', 'tasks-all', 'goals'].forEach(k => cache.delete(k));
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

const BRIEF_SYSTEM = `You write daily briefings for Gretchen Cawthon — integrator and systems architect at Left Right Labs.

Voice: direct, warm, casual. Like a friend who knows her day. Uses ellipses sometimes; never em-dashes. No corporate tone. No "let's" or "looks like you've got a busy day ahead!" Skip preambles.

Format: 3-4 sentences. Plain text — no markdown, no bullets, no headers.

Reference real specifics from her data: names, times, project names. Surface tension if something matters (overdue rock, deadline approaching, streak about to break). End with one grounding observation about the day or week — not advice, just noticing.`;

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

const briefCache = new Map();
const BRIEF_TTL_MS = 1000 * 60 * 60 * 4;

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
  const events = calEvents.map((e) => {
    const start = e.allDay
      ? 'all-day'
      : new Date(e.start).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    return `  - ${start} [${e.account}] ${e.title}${e.location ? ` (${e.location})` : ''}`;
  });
  const taskLine = (t) => `  - [${t.source}] ${t.name}${t.dueStart ? ` (due ${t.dueStart})` : ''}${t.priority ? ` [${t.priority}]` : ''}`;
  const workTasksLines = workMyDay.map(taskLine);
  const lifeTasksLines = lifeMyDay.map(taskLine);
  const goalsLines = goals.map((g) => {
    const pct = g.progress.total ? Math.round((g.progress.done / g.progress.total) * 100) : 0;
    return `  - [${g.source}] ${g.name} — ${g.progress.done}/${g.progress.total} milestones (${pct}%)${g.targetDeadline ? `, target ${g.targetDeadline}` : ''}`;
  });
  return [
    `Today is ${dateLabel}.`,
    '',
    `Calendar today (${events.length}):`,
    events.length ? events.join('\n') : '  (nothing scheduled)',
    '',
    `Work My Day (${workMyDay.length}):`,
    workTasksLines.length ? workTasksLines.join('\n') : '  (none)',
    '',
    `Personal My Day (${lifeMyDay.length}):`,
    lifeTasksLines.length ? lifeTasksLines.join('\n') : '  (none)',
    '',
    `Active goals (${goals.length}):`,
    goalsLines.length ? goalsLines.join('\n') : '  (none flagged)',
    '',
    'Write the brief.',
  ].join('\n');
}

app.get('/api/ai/daily-brief', async (_req, res) => {
  if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const today = chicagoTodayISODate();
  const cacheKey = `brief-${today}`;
  const hit = briefCache.get(cacheKey);
  if (hit && Date.now() - hit.t < BRIEF_TTL_MS) {
    return res.json({ brief: hit.v, cached: true, ts: hit.t });
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
    res.json({ brief: text, cached: false, ts: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- AI: Triage (braindump → plan → apply) -----

const TRIAGE_SYSTEM = `You convert Gretchen's braindumps into a structured plan of actions for her LifeOS dashboard.

Context about Gretchen:
- Integrator at Left Right Labs (LRL). Work tasks live in WORK TASKS [DB]. Personal/life tasks live in LifeOS TASKS.
- Two calendars: work (leftrightlabs.com) and personal.
- Today's date and weekday will be provided.

Voice in "intro" field: direct, warm, casual. Ellipses fine, never em-dashes. No preamble, no "I'll help you with that". Lead with what you're putting on the list.

Action types you can emit:
- create_task: a Notion task. source = "work" or "personal". Required: name. Optional: dueStart (YYYY-MM-DD), myDay (boolean), priority ("URGENT" | "HIGH" | "NORMAL" | null).
- create_event: a calendar event. account = "work" or "personal". Required: title, start, end. If allDay=true, start/end are YYYY-MM-DD; otherwise ISO datetime with America/Chicago offset (-05:00 CDT or -06:00 CST). location optional.

Routing heuristics:
- Anything LRL, clients (Trina, Natasha, Adriana, Lisa, etc.), business, marketing, finance-for-LRL → source/account = "work"
- Anything health, LEGO, household, family, personal finance, errands → source/account = "personal"
- If unclear, prefer "personal"

My Day defaults to false. Set true only if she explicitly says today/tomorrow or makes it sound time-sensitive.

Priority defaults to null. Only set HIGH/URGENT if she signals urgency ("urgent", "critical", "asap", "by end of day").

Date parsing: "tomorrow" = next calendar day. "Friday" = next upcoming Friday. "next week" = next Monday. Use the provided today date as the anchor.

Each action also gets a "label" — a short human-readable summary (e.g. "Task: Email Trina about Rock 3 → work, due Fri Jun 12, My Day").

Be conservative. If she dumps 12 thoughts, emit 12 actions — don't bundle. If something is ambiguous (a vent that's not actionable), skip it.`;

const TRIAGE_JSON_HINT = `Return ONLY valid JSON in this exact shape, no prose, no markdown, no code fences:
{
  "intro": "one sentence, warm casual tone",
  "actions": [
    { "type": "create_task", "label": "short summary", "source": "work"|"personal", "name": "task name", "dueStart": "YYYY-MM-DD" (optional), "myDay": true|false (optional), "priority": "URGENT"|"HIGH"|"NORMAL" (optional) },
    { "type": "create_event", "label": "short summary", "account": "work"|"personal", "title": "event title", "start": "ISO datetime with TZ offset, or YYYY-MM-DD if allDay", "end": "same format", "allDay": true|false (optional), "location": "optional string" }
  ]
}`;

app.post('/api/ai/triage', async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const todayLabel = chicagoTodayDateLabel();
    const todayISO = chicagoTodayISODate();
    const userPrompt = `Today is ${todayLabel} (${todayISO}).\n\nBraindump:\n"""\n${text.trim()}\n"""\n\n${TRIAGE_JSON_HINT}`;
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: TRIAGE_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const textBlock = msg.content.find((b) => b.type === 'text');
    if (!textBlock) return res.status(500).json({ error: 'no text in response' });
    let raw = textBlock.text.trim();
    // Strip code fences if model added them
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let plan;
    try { plan = JSON.parse(raw); }
    catch (e) { return res.status(500).json({ error: 'invalid JSON from model: ' + e.message, raw }); }
    res.json({ plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const TASK_DS_BY_SOURCE = { work: WORK_TASKS_DS, personal: LIFE_TASKS_DS };
const PROJECT_PROP_BY_SOURCE = { work: 'Project', personal: 'Project' };

async function createNotionTask({ source, name, dueStart, myDay, priority }) {
  const dsId = TASK_DS_BY_SOURCE[source];
  if (!dsId) throw new Error(`unknown source: ${source}`);
  const properties = {
    Name: { title: [{ text: { content: name } }] },
    Status: { status: { name: 'Planned' } },
  };
  if (myDay) properties['My Day'] = { checkbox: true };
  if (dueStart) properties.Due = { date: { start: dueStart, end: null } };
  if (priority) properties['Priority 2'] = { select: { name: priority } };
  if (source === 'work') {
    properties.Assigned = { people: [{ id: GRETCHEN_USER_ID }] };
  }
  const page = await notion.pages.create({
    parent: { type: 'data_source_id', data_source_id: dsId },
    properties,
  });
  return { id: page.id, url: page.url };
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
