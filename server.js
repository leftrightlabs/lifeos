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
const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

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
  res.json({ ok: true, ts: new Date().toISOString(), version: 'day-3' });
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

app.get('/auth/google', (_req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
  }
  const oauth = makeOAuthClient();
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: CALENDAR_SCOPES,
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');
    const oauth = makeOAuthClient();
    const { tokens } = await oauth.getToken(code);
    const refresh = tokens.refresh_token || '(none — try /auth/google again, may need to revoke prior consent)';
    res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>LifeOS — auth</title></head>
<body style="background:#0a0f1e;color:#f5f5f7;font-family:ui-monospace,Menlo,monospace;padding:2rem;line-height:1.5">
  <h1 style="color:#a7c140;font-family:Georgia,serif">Refresh token captured</h1>
  <p>Copy this and add to Railway as <code style="background:#131a30;padding:0.1rem 0.4rem;border-radius:4px">GOOGLE_REFRESH_TOKEN</code>:</p>
  <pre style="background:#131a30;padding:1rem;border-radius:8px;overflow-x:auto;user-select:all">${refresh}</pre>
  <p style="opacity:0.6;font-size:0.85rem">Then redeploy. Do not share this token.</p>
</body></html>`);
  } catch (err) {
    res.status(500).send('OAuth error: ' + err.message);
  }
});

app.get('/api/calendar/today', async (_req, res) => {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    return res.status(500).json({ error: 'GOOGLE_REFRESH_TOKEN not configured' });
  }
  try {
    const events = await cached('calendar-today', async () => {
      const oauth = makeOAuthClient();
      oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      const cal = google.calendar({ version: 'v3', auth: oauth });
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
        title: e.summary || '(no title)',
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        allDay: !!e.start?.date,
        location: e.location || null,
        url: e.htmlLink,
      }));
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
