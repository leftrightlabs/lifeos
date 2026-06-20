// Scale zone routes: "Systems to fix" (Business Functions) and "Scorecard
// off-track" (VTO targets scored against live Xero + Convert actuals).
import { fetchBusinessFunctions, fetchScorecardMetrics } from '../providers/notion/scale.js';
import {
  SYSTEM_ATTENTION_STATUSES,
  SYSTEM_HEALTH_RANK,
  SYSTEM_PRIORITY_RANK,
  QUICK_WIN_MIN_IMPACT,
  QUICK_WIN_MAX_EFFORT,
  SCORECARD_SOURCES,
  SPEAKING_OUTREACH_DS,
} from '../config/scale.js';
// Reuse Convert's data primitives for the sales actuals (no Convert route changes).
import { queryAllDeals, serializeDeal, fetchSalesProductMap } from '../providers/notion/convert.js';
import { SALES_STAGE_GROUP, SALES_ACTIVITY_DS } from '../config/convert.js';

// Won-deal value + touchpoint counts for the current month and quarter.
async function computeConvertActuals(notion, cached, monthStart, quarterStart, today) {
  const productMap = await fetchSalesProductMap(notion, cached).catch(() => ({}));
  const deals = (await queryAllDeals(notion)).map((pg) => serializeDeal(pg, productMap)).filter((d) => !d.archived);
  let dealsWonValueMonth = 0, dealsWonValueQuarter = 0;
  for (const d of deals) {
    if ((SALES_STAGE_GROUP[d.status] || 'open') !== 'won' || !d.dateWon) continue;
    if (d.dateWon >= quarterStart && d.dateWon <= today) dealsWonValueQuarter += d.value || 0;
    if (d.dateWon >= monthStart && d.dateWon <= today) dealsWonValueMonth += d.value || 0;
  }
  let touchpointsMonth = 0, touchpointsQuarter = 0, cursor;
  do {
    const r = await notion.dataSources.query({
      data_source_id: SALES_ACTIVITY_DS,
      filter: { and: [
        { property: 'Timestamp', date: { on_or_after: quarterStart } },
        { property: 'Timestamp', date: { on_or_before: today } },
      ] },
      page_size: 100,
      start_cursor: cursor,
    });
    for (const pg of r.results) {
      const ts = pg.properties?.Timestamp?.date?.start?.slice(0, 10);
      if (!ts) continue;
      touchpointsQuarter++;
      if (ts >= monthStart) touchpointsMonth++;
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return { dealsWonValueMonth, dealsWonValueQuarter, touchpointsMonth, touchpointsQuarter };
}

// Speaking "stages" (SPEAKING OUTREACH [DB]) — counts by the relevant date field
// in the period: Booked = Booking Confirmed, Pitched = Date Pitched, Touchpoints =
// Last Touched. Small DB, so one full sweep tallies all three.
async function computeSpeakingActuals(notion, monthStart, quarterStart, today) {
  const c = {
    stagesBookedMonth: 0, stagesBookedQuarter: 0,
    stagesPitchedMonth: 0, stagesPitchedQuarter: 0,
    stagesTouchpointsMonth: 0, stagesTouchpointsQuarter: 0,
  };
  const tally = (d, base) => {
    if (!d || d > today || d < quarterStart) return;
    c[base + 'Quarter']++;
    if (d >= monthStart) c[base + 'Month']++;
  };
  let cursor;
  do {
    const r = await notion.dataSources.query({ data_source_id: SPEAKING_OUTREACH_DS, page_size: 100, start_cursor: cursor });
    for (const pg of r.results) {
      const p = pg.properties || {};
      tally(p['Booking Confirmed']?.date?.start?.slice(0, 10), 'stagesBooked');
      tally(p['Date Pitched']?.date?.start?.slice(0, 10), 'stagesPitched');
      tally(p['Last Touched']?.date?.start?.slice(0, 10), 'stagesTouchpoints');
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return c;
}

// Map a metric's Source + cadence → its live actual.
function actualFor(source, cadence, fin, conv, speaking) {
  const q = cadence === 'Quarterly';
  switch (source) {
    case 'Xero Revenue': return fin ? (q ? fin.qtdRevenue : fin.mtdRevenue) : null;
    case 'Xero Profit': return fin ? (q ? fin.qtdNet : fin.mtdNet) : null;
    case 'Xero Cash Capacity': return fin?.cashCapacity ? Math.round((fin.cashCapacity.months / 3) * 100) / 100 : null;
    case 'Convert Touchpoints': return conv ? (q ? conv.touchpointsQuarter : conv.touchpointsMonth) : null;
    case 'Convert Deals Won': return conv ? (q ? conv.dealsWonValueQuarter : conv.dealsWonValueMonth) : null;
    case 'Speaking Stages Booked': return speaking ? (q ? speaking.stagesBookedQuarter : speaking.stagesBookedMonth) : null;
    case 'Speaking Stages Pitched': return speaking ? (q ? speaking.stagesPitchedQuarter : speaking.stagesPitchedMonth) : null;
    case 'Speaking Stages Touchpoints': return speaking ? (q ? speaking.stagesTouchpointsQuarter : speaking.stagesTouchpointsMonth) : null;
    default: return null;
  }
}

// Red / amber / green honoring Direction + Break Even.
function scoreStatus(actual, goal, breakEven, direction) {
  if (actual == null || goal == null) return 'unknown';
  const up = !direction || direction.includes('higher');
  if (up) return actual >= goal ? 'green' : (breakEven != null && actual >= breakEven ? 'amber' : 'red');
  return actual <= goal ? 'green' : (breakEven != null && actual <= breakEven ? 'amber' : 'red');
}

export function registerScaleRoutes(app, { notion, cached, computeXeroFinance, chicagoToday }) {
  // Systems that need attention, ranked: urgency (Health Status) → Priority →
  // impact-per-effort, with a quick-win flag (high impact, low effort).
  app.get('/api/scale/systems', async (_req, res) => {
    try {
      const data = await cached('scale-systems', async () => {
        const all = await fetchBusinessFunctions(notion);
        const attention = all.filter((s) => SYSTEM_ATTENTION_STATUSES.includes(s.health));

        const ratio = (s) =>
          s.impact != null && s.effort ? s.impact / s.effort : (s.impact != null ? s.impact : 0);
        const score = (s) =>
          (SYSTEM_HEALTH_RANK[s.health] || 0) * 100 +
          (SYSTEM_PRIORITY_RANK[s.priority] || 0) * 10 +
          ratio(s);
        const quickWin = (s) =>
          s.impact != null && s.impact >= QUICK_WIN_MIN_IMPACT &&
          s.effort != null && s.effort > 0 && s.effort <= QUICK_WIN_MAX_EFFORT;

        attention.sort((a, b) => score(b) - score(a));
        const systems = attention.map((s) => ({ ...s, quickWin: quickWin(s) }));

        const counts = {
          total: all.length,
          attention: attention.length,
          brokenOrMissing: all.filter((s) => s.health === 'Broken' || s.health === 'Missing').length,
          critical: attention.filter((s) => s.priority === 'Critical').length,
        };
        return { systems, counts, asOf: new Date().toISOString() };
      });
      res.json(data);
    } catch (err) {
      console.error('scale/systems error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Scorecard off-track: VTO metrics for the current quarter, each scored against
  // its live actual (Xero finance / Convert sales). Only off-track (amber/red) drives
  // the Act card; all scored metrics are returned for the board.
  app.get('/api/scale/scorecard', async (_req, res) => {
    try {
      const data = await cached('scale-scorecard', async () => {
        const today = chicagoToday();
        const [y, m] = today.split('-').map(Number);
        const pad = (n) => String(n).padStart(2, '0');
        const monthStart = `${y}-${pad(m)}-01`;
        const qn = Math.floor((m - 1) / 3) + 1;
        const quarterStart = `${y}-${pad((qn - 1) * 3 + 1)}-01`;
        const quarterLabel = `${y} Q${qn}`;

        const all = await fetchScorecardMetrics(notion, quarterLabel);
        const metrics = all.filter((mt) => SCORECARD_SOURCES.includes(mt.source));
        const needXero = metrics.some((mt) => mt.source.startsWith('Xero'));
        const needConvert = metrics.some((mt) => mt.source.startsWith('Convert'));
        const needSpeaking = metrics.some((mt) => mt.source.startsWith('Speaking'));

        const fin = needXero ? await cached('xero-finance', computeXeroFinance).catch(() => null) : null;
        const conv = needConvert
          ? await computeConvertActuals(notion, cached, monthStart, quarterStart, today).catch(() => null)
          : null;
        const speaking = needSpeaking
          ? await computeSpeakingActuals(notion, monthStart, quarterStart, today).catch(() => null)
          : null;

        const scored = metrics.map((mt) => {
          const actual = actualFor(mt.source, mt.cadence, fin, conv, speaking);
          const status = scoreStatus(actual, mt.goal, mt.breakEven, mt.direction);
          const period = mt.cadence === 'Quarterly' ? 'this quarter' : (mt.cadence === 'Weekly' ? 'this week' : 'this month');
          const pct = (actual != null && mt.goal) ? Math.round((actual / mt.goal) * 100) : null;
          return { ...mt, actual, status, period, pct };
        });
        const rank = { red: 0, amber: 1, green: 2, unknown: 3 };
        scored.sort((a, b) => (rank[a.status] - rank[b.status]) || (a.metric || '').localeCompare(b.metric || ''));
        const offTrack = scored.filter((s) => s.status === 'red' || s.status === 'amber');
        return {
          quarter: quarterLabel,
          metrics: scored,
          offTrack,
          counts: { total: scored.length, offTrack: offTrack.length },
          asOf: new Date().toISOString(),
        };
      });
      res.json(data);
    } catch (err) {
      console.error('scale/scorecard error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
