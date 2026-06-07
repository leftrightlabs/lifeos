import express from 'express';
import cookieSession from 'cookie-session';
import { Client } from '@notionhq/client';
import { google } from 'googleapis';
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

const server = app.listen(PORT, () => {
  console.log(`LifeOS listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
