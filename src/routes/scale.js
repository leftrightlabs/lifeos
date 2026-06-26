// Scale zone — the EOS operating view. One aggregate endpoint, GET /api/scale/data,
// returns five tabs of state (PULSE / SCORECARD / FINANCE / SYSTEMS / VTO) plus the
// auto-computed stressed|calm state. Notion + Xero are fetched in parallel with
// Promise.allSettled; any failed slice degrades to null and the UI handles it.
//
// Data sources: BUSINESS FUNCTIONS [DB] (systems), VTO SCORECARD [DB] (metrics),
// ISSUES [DB] (IDS queue), WORK PROJECTS [DB] ROCK=true (rocks), Xero (finance +
// quotes), and Convert/Speaking activity for the live scorecard actuals.
import {
  fetchBusinessFunctions,
  fetchScorecardMetrics,
  fetchIssues,
  fetchRocks,
} from '../providers/notion/scale.js';
import {
  SYSTEM_ATTENTION_STATUSES,
  SYSTEM_HEALTH_RANK,
  SYSTEM_PRIORITY_RANK,
  QUICK_WIN_MIN_IMPACT,
  QUICK_WIN_MAX_EFFORT,
  SCORECARD_SOURCES,
  SCORECARD_SOURCE_TYPE,
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

// green/amber/red → the spec's metric-status vocabulary for the badge.
const STATUS_KIND = { green: 'on', amber: 'at-risk', red: 'behind', unknown: 'unknown' };

export function registerScaleRoutes(app, {
  notion, cached, clearCached, computeXeroFinance, computeXeroQuotes, chicagoToday, currentQuarter,
  WORK_PROJECTS_DS, WORK_TASKS_DS, currentNotionUserId, GRETCHEN_USER_ID,
}) {
  // Notion id of the signed-in user, for the global "assigned to me" filter.
  const meNotionId = () => (typeof currentNotionUserId === 'function' ? currentNotionUserId() : null) || GRETCHEN_USER_ID;
  // Xero is the slow/flaky dependency: on a cold cache or token-refresh stall it
  // can HANG (not error), which would stall the whole request until Railway's
  // gateway kills it ("upstream error"). Bound it so a hang resolves to null and
  // the page still renders everything else. (Same fix as /api/convert.)
  const withTimeout = (promise, ms = 10000) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('xero timeout')), ms)),
  ]);
  // ── Systems (BUSINESS FUNCTIONS) ──
  // Ranks systems needing attention (urgency → priority → impact/effort), flags
  // quick wins, splits into fix-first / quick-wins, and counts the healthy ones.
  async function computeSystems() {
    const all = await fetchBusinessFunctions(notion);
    const attention = all.filter((s) => SYSTEM_ATTENTION_STATUSES.includes(s.health));

    const ratio = (s) => (s.impact != null && s.effort ? s.impact / s.effort : (s.impact != null ? s.impact : 0));
    const score = (s) =>
      (SYSTEM_HEALTH_RANK[s.health] || 0) * 100 +
      (SYSTEM_PRIORITY_RANK[s.priority] || 0) * 10 +
      ratio(s);
    const isQuickWin = (s) =>
      s.impact != null && s.impact >= QUICK_WIN_MIN_IMPACT &&
      s.effort != null && s.effort > 0 && s.effort <= QUICK_WIN_MAX_EFFORT;

    attention.sort((a, b) => score(b) - score(a));
    const flagged = attention.map((s) => ({ ...s, quickWin: isQuickWin(s) }));

    const fixFirst = flagged.filter((s) => s.priority === 'Critical');
    const quickWins = flagged.filter((s) => s.quickWin && s.priority !== 'Critical');
    const inSplit = new Set([...fixFirst, ...quickWins].map((s) => s.id));
    const needsReview = flagged.filter((s) => !inSplit.has(s.id));
    const healthy = all
      .filter((s) => !SYSTEM_ATTENTION_STATUSES.includes(s.health))
      .sort((a, b) => (b.maturity ?? 0) - (a.maturity ?? 0));

    const counts = {
      total: all.length,
      critical: flagged.filter((s) => s.priority === 'Critical').length,
      criticalBrokenMissing: flagged.filter((s) => s.priority === 'Critical' && (s.health === 'Broken' || s.health === 'Missing')).length,
      brokenMissing: all.filter((s) => s.health === 'Broken' || s.health === 'Missing').length,
      needsAttention: attention.length,
      healthy: healthy.length,
    };
    return { systems: flagged, fixFirst, quickWins, needsReview, healthy, counts, asOf: new Date().toISOString() };
  }

  // ── Scorecard (VTO metrics scored against live actuals) ──
  async function computeScorecard() {
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

    const fin = needXero ? await withTimeout(cached('xero-finance', computeXeroFinance)).catch(() => null) : null;
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
      return { ...mt, type: SCORECARD_SOURCE_TYPE[mt.source] || 'lagging', actual, status, kind: STATUS_KIND[status], period, pct };
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
  }

  // ── Finance (Xero) + revenue projection ──
  function buildFinance(fin, quotes) {
    if (!fin) return null;
    const today = chicagoToday();
    const q = currentQuarter();
    // Recurring = avg of the last 3 complete months' revenue (BUILD-SPEC §3B).
    const complete = (fin.revenueTrend || []).filter((mo) => !mo.partial);
    const last3 = complete.slice(-3);
    const recurring = last3.length ? Math.round(last3.reduce((s, mo) => s + (mo.revenue || 0), 0) / last3.length) : 0;

    let acceptedInQuarter = 0;
    if (quotes?.accepted) {
      for (const qt of quotes.accepted) {
        const d = qt.expiryDate || qt.date;
        if (d && d >= today && d <= q.end) acceptedInQuarter += qt.total;
      }
    }
    const openTotal = quotes?.open ? quotes.open.reduce((s, qt) => s + qt.total, 0) : 0;
    const pipeline = Math.round(openTotal * 0.20);
    const projectedRemaining = recurring + Math.round(acceptedInQuarter) + pipeline;
    const collected = Math.round(fin.qtdRevenue || 0);

    const projection = {
      recurring,
      acceptedQuotes: Math.round(acceptedInQuarter),
      pipeline,
      projectedRemaining,
      collected,
      total: collected + projectedRemaining,
      goal: fin.goals?.revenue?.qtd?.goal ?? null,
      quotesAvailable: !!quotes,
    };

    const revenueByMonth = (fin.revenueTrend || []).map((mo) => ({
      month: mo.label, amount: Math.round(mo.revenue || 0), isProjected: false, partial: !!mo.partial,
    }));
    // One forward-looking bar: next month's expected recurring revenue.
    revenueByMonth.push({ month: 'Proj.', amount: recurring, isProjected: true });

    return {
      cashOnHand: fin.cashOnHand,
      creditCards: fin.creditTotal,
      runway: { months: fin.runwayMonths, burnRate: fin.monthlyBurn },
      ar: fin.accountsReceivable,
      ap: fin.accountsPayable,
      mtdNet: fin.mtdNet,
      ytdRevenue: { actual: fin.ytdRevenue, goal: fin.goals?.revenue?.ytd?.goal ?? null },
      qtdRevenue: { actual: fin.qtdRevenue, goal: fin.goals?.revenue?.qtd?.goal ?? null },
      mtdRevenue: { actual: fin.mtdRevenue, goal: fin.goals?.revenue?.mtd?.goal ?? null },
      monthlyGoal: fin.goals?.revenue?.mtd?.goal ?? null,
      breakEven: fin.goals?.revenue?.mtd?.breakEven ?? null,
      projection,
      bankAccounts: fin.bankAccounts || [],
      creditCardAccounts: fin.creditCards || [],
      revenueByMonth,
      asOf: fin.asOf,
    };
  }

  // ── VTO rocks ──
  function buildRocks(rawRocks) {
    return (rawRocks || []).map((r) => {
      const daysToDeadline = r.deadline
        ? Math.round((Date.parse(r.deadline + 'T00:00:00Z') - Date.parse(chicagoToday() + 'T00:00:00Z')) / 86400000)
        : null;
      return {
        name: r.name,
        owner: r.owner,
        mine: (r.ownerIds || []).includes(meNotionId()),
        function: r.function,
        status: r.statusKey,         // complete|onTrack|atRisk|offTrack|notStarted
        notionStatus: r.status,
        pct: r.pct,
        nextAction: r.nextAction,
        dueDate: r.deadline,
        daysToDeadline,
        milestonesDone: r.milestonesDone,
        milestonesTotal: r.milestonesTotal,
        notionUrl: r.notionUrl,
      };
    });
  }

  // ── Auto-flags (BUILD-SPEC §5) ──
  function computeAutoFlags({ finance, scorecard, systemsData, rocks }) {
    const flags = [];
    const today = chicagoToday();
    const [y, m, d] = today.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();

    // Flag 1 — Revenue gap (pacing vs monthly goal).
    if (finance?.mtdRevenue?.goal) {
      const goal = finance.mtdRevenue.goal;
      const actual = finance.mtdRevenue.actual || 0;
      const pacing = (d / daysInMonth) * goal;
      let sev = null;
      if (actual < pacing * 0.5) sev = 'red';
      else if (actual < pacing * 0.8) sev = 'amber';
      if (sev) {
        const pct = goal ? Math.round((actual / goal) * 100) : 0;
        flags.push({ type: 'revenue-gap', severity: sev, source: 'Scorecard',
          message: `Revenue gap: $${Math.round(actual).toLocaleString()} collected vs $${Math.round(goal).toLocaleString()} goal (${pct}%)` });
      }
    }

    // Flag 2 — Pipeline thin (stages pitched vs quarterly pace).
    const pitched = (scorecard?.metrics || []).find((mt) => mt.source === 'Speaking Stages Pitched');
    if (pitched && pitched.goal && currentQuarter) {
      const q = currentQuarter();
      const elapsed = q.elapsedDays || 0;
      const totalDays = q.totalDays || 91;
      const pacing = (elapsed / totalDays) * pitched.goal;
      const actual = pitched.actual || 0;
      let sev = null;
      if (actual < pacing * 0.3) sev = 'red';
      else if (actual < pacing * 0.6) sev = 'amber';
      if (sev) {
        const pacePct = pacing ? Math.round((actual / pacing) * 100) : 0;
        flags.push({ type: 'pipeline-thin', severity: sev, source: 'Scorecard',
          message: `Pipeline thin: ${actual} stages pitched vs ${pitched.goal} quarterly target (${pacePct}% of pace)` });
      }
    }

    // Flag 3 — Critical system gaps.
    const critGaps = systemsData?.counts?.criticalBrokenMissing || 0;
    if (critGaps > 0) {
      flags.push({ type: 'critical-systems', severity: 'red', source: 'Systems',
        message: `${critGaps} critical business system${critGaps > 1 ? 's are' : ' is'} Broken or Missing` });
    }

    // Flag 4 — Low runway.
    const months = finance?.runway?.months;
    if (typeof months === 'number') {
      let sev = null;
      if (months < 2) sev = 'red';
      else if (months < 3) sev = 'amber';
      if (sev) {
        flags.push({ type: 'low-runway', severity: sev, source: 'Finance',
          message: `Cash runway at ${months.toFixed(1)} months — tighten spend / accelerate collections` });
      }
    }

    // Flag 5 — Rocks off track with < 14 days to deadline.
    const offRocks = (rocks || []).filter((r) => (r.status === 'offTrack' || r.status === 'atRisk') && r.daysToDeadline != null && r.daysToDeadline < 14);
    if (offRocks.length > 0) {
      flags.push({ type: 'rocks-off-track', severity: 'amber', source: 'VTO',
        message: `${offRocks.length} rock${offRocks.length > 1 ? 's' : ''} off track with < 14 days to quarter deadline` });
    }

    return flags;
  }

  // ── Hero card (BUILD-SPEC §6) ──
  function pickHero({ systemsData, autoFlags, rocks }) {
    const sys = systemsData?.systems || [];
    const byImpact = (a, b) => (b.impact ?? 0) - (a.impact ?? 0);
    const missing = sys.filter((s) => s.priority === 'Critical' && s.health === 'Missing').sort(byImpact);
    if (missing[0]) return { kind: 'system', framing: 'crisis', ...missing[0] };
    const broken = sys.filter((s) => s.priority === 'Critical' && s.health === 'Broken').sort(byImpact);
    if (broken[0]) return { kind: 'system', framing: 'crisis', ...broken[0] };
    if (autoFlags.length) {
      const worst = autoFlags.find((f) => f.severity === 'red') || autoFlags[0];
      return { kind: 'flag', framing: 'crisis', ...worst };
    }
    const offRock = (rocks || []).filter((r) => r.status === 'offTrack' || r.status === 'atRisk')
      .sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0))[0];
    if (offRock) return { kind: 'rock', framing: 'crisis', ...offRock };
    // Calm: highest-impact "Needs Review" system as a growth move.
    const review = sys.filter((s) => s.health === 'Needs Review').sort(byImpact)[0]
      || (systemsData?.needsReview || []).sort(byImpact)[0];
    if (review) return { kind: 'system', framing: 'growth', ...review };
    return null;
  }

  // ── Aggregate endpoint ──
  app.get('/api/scale/data', async (req, res) => {
    try {
      if (req.query.fresh === '1' && clearCached) {
        ['scale-systems', 'scale-scorecard', 'xero-finance', 'scale-quotes'].forEach((k) => clearCached(k));
      }
      const rocksCtx = { projectsDs: WORK_PROJECTS_DS, tasksDs: WORK_TASKS_DS, projectPropName: 'Project' };
      const [sysR, scR, finR, quoteR, issR, rockR] = await Promise.allSettled([
        cached('scale-systems', computeSystems),
        cached('scale-scorecard', computeScorecard),
        withTimeout(cached('xero-finance', computeXeroFinance)),
        withTimeout(cached('scale-quotes', computeXeroQuotes)),
        fetchIssues(notion),
        fetchRocks(notion, rocksCtx),
      ]);
      const val = (r) => (r.status === 'fulfilled' ? r.value : null);
      const systemsData = val(sysR);
      const scorecard = val(scR);
      const finRaw = val(finR);
      const quotes = val(quoteR);
      const teamIssues = (val(issR) || []).map((i) => ({ ...i, mine: (i.assignedIds || []).includes(meNotionId()) }));
      const rawRocks = val(rockR) || [];

      const finance = buildFinance(finRaw, quotes);
      const rocks = buildRocks(rawRocks);

      const autoFlags = computeAutoFlags({ finance, scorecard, systemsData, rocks });
      const heroIssue = pickHero({ systemsData, autoFlags, rocks });

      // State (BUILD-SPEC §4).
      const offTrackCount = scorecard?.counts?.offTrack ?? 0;
      const critical = systemsData?.counts?.critical ?? 0;
      const brokenMissing = systemsData?.counts?.brokenMissing ?? 0;
      const runwayMonths = finance?.runway?.months;
      const stressed = autoFlags.length > 0
        || offTrackCount > 3
        || (critical > 0 && brokenMissing > 0)
        || (typeof runwayMonths === 'number' && runwayMonths < 3);

      const rocksOffTrack = rocks.filter((r) => r.status === 'offTrack' || r.status === 'atRisk').length;

      res.json({
        refreshedAt: new Date().toISOString(),
        state: stressed ? 'stressed' : 'calm',
        degraded: {
          systems: systemsData == null,
          scorecard: scorecard == null,
          finance: finance == null,
          issues: issR.status !== 'fulfilled',
          rocks: rockR.status !== 'fulfilled',
          quotes: !quotes,
        },
        pulse: { autoFlags, teamIssues, heroIssue },
        scorecard: scorecard
          ? { quarter: scorecard.quarter, metrics: scorecard.metrics, offTrackCount }
          : null,
        finance,
        systems: systemsData
          ? {
              counts: systemsData.counts,
              fixFirst: systemsData.fixFirst,
              quickWins: systemsData.quickWins,
              needsReview: systemsData.needsReview,
              healthy: systemsData.healthy,
              remainingCount: systemsData.needsReview.length,
            }
          : null,
        vto: {
          rocks,
          metrics: scorecard?.metrics || [],
          quarter: scorecard?.quarter || (currentQuarter ? currentQuarter().label : null),
          rocksOffTrack,
        },
      });
    } catch (err) {
      console.error('scale/data error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Legacy split endpoints — kept for the /today briefing peeks (cached keys
  // 'scale-systems' / 'scale-scorecard') and any direct callers.
  app.get('/api/scale/systems', async (_req, res) => {
    try { res.json(await cached('scale-systems', computeSystems)); }
    catch (err) { console.error('scale/systems error:', err.message); res.status(500).json({ error: err.message }); }
  });
  app.get('/api/scale/scorecard', async (_req, res) => {
    try { res.json(await cached('scale-scorecard', computeScorecard)); }
    catch (err) { console.error('scale/scorecard error:', err.message); res.status(500).json({ error: err.message }); }
  });
}
