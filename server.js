import express from 'express';
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

const GRETCHEN_USER_ID = 'cfe628e1-e7b8-4aed-8151-009b8bee5c9d';
const WORK_TASKS_DS = '28c458f08cd9818599e7000bc2115872';
const LIFE_TASKS_DS = '265458f08cd981699efe000b4de14ca4';
const CACHE_TTL_MS = 60_000;
const TZ = 'America/Chicago';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];

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

async function queryMyDay(dataSourceId, peopleProp) {
  const and = [
    { property: 'Status', status: { does_not_equal: 'Done' } },
    { property: 'My Day', checkbox: { equals: true } },
  ];
  if (peopleProp) {
    and.push({ property: peopleProp, people: { contains: GRETCHEN_USER_ID } });
  }
  return notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: { and },
    sorts: [{ property: 'Due', direction: 'ascending' }],
  });
}

function simplifyTask(page) {
  const props = page.properties || {};
  return {
    id: page.id,
    title: props.Name?.title?.[0]?.plain_text || '(untitled)',
    status: props.Status?.status?.name || null,
    due: props.Due?.date?.start || null,
    priority: props.Priority?.status?.name || null,
    url: page.url,
  };
}

function makeOAuthClient() {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${host}/auth/google/callback`,
  );
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

app.use(express.static(join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), version: 'day-4' });
});

app.get('/api/tasks/work-myday', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const data = await cached('work', () => queryMyDay(WORK_TASKS_DS, 'Assigned'));
    res.json({ tasks: data.results.map(simplifyTask) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/life-myday', async (_req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const data = await cached('life', () => queryMyDay(LIFE_TASKS_DS, null));
    res.json({ tasks: data.results.map(simplifyTask) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
  }
  const account = req.query.account === 'personal' ? 'personal' : 'work';
  const oauth = makeOAuthClient();
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
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
    const oauth = makeOAuthClient();
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

const ACCOUNT_ENVS = {
  work: 'GOOGLE_REFRESH_TOKEN',
  personal: 'GOOGLE_REFRESH_TOKEN_PERSONAL',
};
const ACCOUNTS = ['work', 'personal'];

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
