// GA4 provider — the analytics data seam (Google Analytics Data API v1beta).
// Auth: a read-only service account key (path in GA_KEY_FILE, default
// ./ga-service-account.json) granted Viewer on each property. A future per-client
// install would swap this for the client's own OAuth/properties — same exports.
import { google } from 'googleapis';
import { existsSync } from 'node:fs';

const KEY_FILE = process.env.GA_KEY_FILE || 'ga-service-account.json';

// The GA4 properties we report on. (A client install would supply its own list.)
export const GA_PROPERTIES = [
  { id: '405950261', label: 'LRL Website' },
  { id: '495418896', label: 'Toolkit' },
];

export function gaConfigured() {
  return existsSync(KEY_FILE);
}

let _client = null;
function gaClient() {
  if (_client) return _client;
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  _client = google.analyticsdata({ version: 'v1beta', auth });
  return _client;
}

async function runReport(propertyId, requestBody) {
  const r = await gaClient().properties.runReport({ property: `properties/${propertyId}`, requestBody });
  return r.data;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const trendPct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);
const METRICS = [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }, { name: 'keyEvents' }];
const totalsOf = (data) => {
  const v = data.rows?.[0]?.metricValues || [];
  return { sessions: num(v[0]?.value), users: num(v[1]?.value), views: num(v[2]?.value), keyEvents: num(v[3]?.value) };
};

// "What's working" snapshot for one property: last-28d totals + trend vs the prior
// 28d, the top pages, and channel performance (sessions + key events / conversions).
export async function whatsWorking(propertyId, label) {
  const [curR, prevR, pagesR, chanR] = await Promise.all([
    runReport(propertyId, { dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }], metrics: METRICS }),
    runReport(propertyId, { dateRanges: [{ startDate: '56daysAgo', endDate: '29daysAgo' }], metrics: METRICS }),
    runReport(propertyId, {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 8,
    }),
    runReport(propertyId, {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 10,
    }),
  ]);

  const totals = totalsOf(curR);
  const prior = totalsOf(prevR);
  return {
    propertyId, label,
    totals, prior,
    trend: {
      sessions: trendPct(totals.sessions, prior.sessions),
      users: trendPct(totals.users, prior.users),
      keyEvents: trendPct(totals.keyEvents, prior.keyEvents),
    },
    topPages: (pagesR.rows || []).map((row) => ({
      path: row.dimensionValues?.[0]?.value || '(not set)',
      sessions: num(row.metricValues?.[0]?.value),
      keyEvents: num(row.metricValues?.[1]?.value),
    })),
    channels: (chanR.rows || []).map((row) => ({
      name: row.dimensionValues?.[0]?.value || '(unassigned)',
      sessions: num(row.metricValues?.[0]?.value),
      keyEvents: num(row.metricValues?.[1]?.value),
    })),
  };
}

// All configured properties, in parallel. Each property is independently guarded
// so one failure never blanks the whole report.
export async function whatsWorkingAll() {
  const results = await Promise.all(GA_PROPERTIES.map(async (p) => {
    try { return await whatsWorking(p.id, p.label); }
    catch (e) { return { propertyId: p.id, label: p.label, error: (e.message || String(e)).slice(0, 200) }; }
  }));
  return results;
}
