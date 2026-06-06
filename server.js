import express from 'express';
import { Client } from '@notionhq/client';
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

app.use(express.static(join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), version: 'day-2' });
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

const server = app.listen(PORT, () => {
  console.log(`LifeOS listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
