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
  fetchVtoVision,
} from '../providers/notion/scale.js';
import {
  SYSTEM_ATTENTION_STATUSES,
  SYSTEM_HEALTH_RANK,
  SYSTEM_PRIORITY_RANK,
  QUICK_WIN_MIN_IMPACT,
  QUICK_WIN_MAX_EFFORT,
  SCORECARD_SOURCES,
  SCORECARD_SOURCE_TYPE,
  SCORECARD_PAIRS,
  SPEAKING_OUTREACH_DS,
  ISSUES_DS,
  VTO_VISION_DS,
} from '../config/scale.js';
// Reuse Convert's data primitives for the sales actuals (no Convert route changes).
import { queryAllDeals, serializeDeal, fetchSalesProductMap } from '../providers/notion/convert.js';
import { SALES_STAGE_GROUP, SALES_ACTIVITY_DS } from '../config/convert.js';

// Won-deal value + touchpoint count within an arbitrary [start, end] (inclusive).
async function computeConvertActuals(notion, cached, start, end) {
  const productMap = await fetchSalesProductMap(notion, cached).catch(() => ({}));
  const deals = (await queryAllDeals(notion)).map((pg) => serializeDeal(pg, productMap)).filter((d) => !d.archived);
  let dealsWonValue = 0;
  for (const d of deals) {
    if ((SALES_STAGE_GROUP[d.status] || 'open') !== 'won' || !d.dateWon) continue;
    if (d.dateWon >= start && d.dateWon <= end) dealsWonValue += d.value || 0;
  }
  let touchpoints = 0, cursor;
  do {
    const r = await notion.dataSources.query({
      data_source_id: SALES_ACTIVITY_DS,
      filter: { and: [
        { property: 'Timestamp', date: { on_or_after: start } },
        { property: 'Timestamp', date: { on_or_before: end } },
      ] },
      page_size: 100,
      start_cursor: cursor,
    });
    for (const pg of r.results) { if (pg.properties?.Timestamp?.date?.start) touchpoints++; }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return { dealsWonValue, touchpoints };
}

// Speaking "stages" (SPEAKING OUTREACH [DB]) tallied within [start, end] by the
// relevant date field: Booked = Booking Confirmed, Pitched = Date Pitched,
// Touchpoints = Last Touched. Small DB, so one full sweep tallies all three.
async function computeSpeakingActuals(notion, start, end) {
  const c = { stagesBooked: 0, stagesPitched: 0, stagesTouchpoints: 0 };
  const tally = (d, key) => { if (!d || d > end || d < start) return; c[key]++; };
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

// Map a metric Source → its actual for the period. `pnl` = {revenue, profit} for
// the quarter; cashCapacity (point-in-time) only passed for the current quarter.
function actualFor(source, pnl, conv, speaking, cashCapacity) {
  switch (source) {
    case 'Xero Revenue': return pnl ? pnl.revenue : null;
    case 'Xero Profit': return pnl ? pnl.profit : null;
    case 'Xero Cash Capacity': return cashCapacity != null ? cashCapacity : null;
    case 'Convert Touchpoints': return conv ? conv.touchpoints : null;
    case 'Convert Deals Won': return conv ? conv.dealsWonValue : null;
    case 'Speaking Stages Booked': return speaking ? speaking.stagesBooked : null;
    case 'Speaking Stages Pitched': return speaking ? speaking.stagesPitched : null;
    case 'Speaking Stages Touchpoints': return speaking ? speaking.stagesTouchpoints : null;
    default: return null;
  }
}

// Quarter goal = raw Goal × cadence multiplier (a quarter = 3 months ≈ 13 weeks).
// Cash Capacity is a point-in-time ratio, not accumulated, so it isn't scaled.
function quarterGoal(rawGoal, cadence, source) {
  if (rawGoal == null) return null;
  if (source === 'Xero Cash Capacity') return rawGoal;
  const mult = cadence === 'Quarterly' ? 1 : cadence === 'Weekly' ? 13 : 3;
  return rawGoal * mult;
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
  notion, cached, clearCached, computeXeroFinance, computeXeroQuotes, computeXeroQuarterlyRevenue,
  computeXeroPnlForRange, computeRecurringRevenueAvg, fetchQuarterlyTargets, fetchVtoGoals, chicagoToday, currentQuarter,
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

  // ── Scorecard for a specific quarter ("2026 Q2"), scored against live actuals
  // for THAT quarter's date range (current quarter capped at today; future → goals
  // only). Goals are scaled to the quarter (monthly×3, etc.) so a quarter total is
  // compared to a quarter goal.
  async function computeScorecardForQuarter(quarterLabel) {
    const today = chicagoToday();
    const pad = (n) => String(n).padStart(2, '0');
    const ym = String(quarterLabel || '').match(/(\d{4}).*?Q([1-4])/i);
    if (!ym) return null;
    const year = Number(ym[1]), qn = Number(ym[2]);
    const qStartMonth = (qn - 1) * 3 + 1, qEndMonth = qStartMonth + 2;
    const qStart = `${year}-${pad(qStartMonth)}-01`;
    const qEndFull = `${year}-${pad(qEndMonth)}-${pad(new Date(year, qEndMonth, 0).getDate())}`;
    const isFuture = qStart > today;
    const isCurrent = !isFuture && today <= qEndFull;
    const end = isCurrent ? today : qEndFull;

    const all = await fetchScorecardMetrics(notion, quarterLabel);
    const metrics = all.filter((mt) => SCORECARD_SOURCES.includes(mt.source));

    let pnl = null, cashCap = null, conv = null, speaking = null;
    if (!isFuture) {
      const needXero = metrics.some((mt) => mt.source.startsWith('Xero'));
      const needConvert = metrics.some((mt) => mt.source.startsWith('Convert'));
      const needSpeaking = metrics.some((mt) => mt.source.startsWith('Speaking'));
      if (needXero && computeXeroPnlForRange) {
        pnl = await withTimeout(cached(`xero-pnl-${qStart}-${end}`, () => computeXeroPnlForRange(qStart, end))).catch(() => null);
      }
      // Cash Capacity is point-in-time, so only the current quarter has a value.
      if (isCurrent && metrics.some((mt) => mt.source === 'Xero Cash Capacity')) {
        cashCap = await withTimeout(cached('xero-finance', computeXeroFinance))
          .then((f) => f?.cashCapacity ? Math.round((f.cashCapacity.months / 3) * 100) / 100 : null).catch(() => null);
      }
      if (needConvert) conv = await computeConvertActuals(notion, cached, qStart, end).catch(() => null);
      if (needSpeaking) speaking = await computeSpeakingActuals(notion, qStart, end).catch(() => null);
    }

    const scored = metrics.map((mt) => {
      const goal = quarterGoal(mt.goal, mt.cadence, mt.source);
      const breakEven = quarterGoal(mt.breakEven, mt.cadence, mt.source);
      const actual = isFuture ? null : actualFor(mt.source, pnl, conv, speaking, cashCap);
      const status = scoreStatus(actual, goal, breakEven, mt.direction);
      const pct = (actual != null && goal) ? Math.round((actual / goal) * 100) : null;
      return { ...mt, type: SCORECARD_SOURCE_TYPE[mt.source] || 'lagging', goal, breakEven, actual, status, kind: STATUS_KIND[status], period: quarterLabel, pct };
    });
    const rank = { red: 0, amber: 1, green: 2, unknown: 3 };
    scored.sort((a, b) => (rank[a.status] - rank[b.status]) || (a.metric || '').localeCompare(b.metric || ''));
    const offTrack = scored.filter((s) => s.status === 'red' || s.status === 'amber');
    return {
      quarter: quarterLabel,
      state: isFuture ? 'future' : isCurrent ? 'current' : 'past',
      metrics: scored,
      offTrack,
      counts: { total: scored.length, offTrack: offTrack.length },
      pairs: SCORECARD_PAIRS,
      asOf: new Date().toISOString(),
    };
  }

  // Current-quarter scorecard — feeds /api/scale/data (badge + initial paint).
  async function computeScorecard() {
    const [y, m] = chicagoToday().split('-').map(Number);
    return computeScorecardForQuarter(`${y} Q${Math.floor((m - 1) / 3) + 1}`);
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
        id: r.id,                    // project page id — for the edit modal
        name: r.name,
        quarter: r.quarter,          // parsed from the rock name (e.g. "2026 Q2")
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
        ['scale-systems', 'scale-scorecard', 'xero-finance', 'scale-quotes', 'scale-qtr-revenue', 'xero-recurring-rev-avg'].forEach((k) => clearCached(k));
      }
      const rocksCtx = { projectsDs: WORK_PROJECTS_DS, tasksDs: WORK_TASKS_DS, projectPropName: 'Project' };
      const year = Number(chicagoToday().slice(0, 4));
      const [sysR, scR, finR, quoteR, issR, rockR, qtrRevR, qtrGoalR, recurR, visionR] = await Promise.allSettled([
        cached('scale-systems', computeSystems),
        cached('scale-scorecard', computeScorecard),
        withTimeout(cached('xero-finance', computeXeroFinance)),
        withTimeout(cached('scale-quotes', computeXeroQuotes)),
        fetchIssues(notion),
        fetchRocks(notion, rocksCtx),
        computeXeroQuarterlyRevenue ? withTimeout(cached('scale-qtr-revenue', () => computeXeroQuarterlyRevenue(year))) : Promise.resolve(null),
        fetchQuarterlyTargets ? fetchQuarterlyTargets() : Promise.resolve({}),
        computeRecurringRevenueAvg ? withTimeout(cached('xero-recurring-rev-avg', computeRecurringRevenueAvg)) : Promise.resolve(null),
        fetchVtoVision(notion),
      ]);
      const val = (r) => (r.status === 'fulfilled' ? r.value : null);
      const systemsData = val(sysR);
      const scorecard = val(scR);
      const finRaw = val(finR);
      const quotes = val(quoteR);
      const teamIssues = (val(issR) || []).map((i) => ({ ...i, mine: (i.assignedIds || []).includes(meNotionId()) }));
      const rawRocks = val(rockR) || [];
      const qtrRevenue = val(qtrRevR) || {};
      const qtrTargets = val(qtrGoalR) || {};

      const finance = buildFinance(finRaw, quotes);
      const rocks = buildRocks(rawRocks);

      // ── VTO quarterly view: annual progress + per-quarter goal/actual ──
      // Goal per quarter = the Quarterly Targets DB value if set, else monthly
      // revenue goal × 3 (derived from finance.qtdRevenue.goal). Annual = sum.
      const monthlyRevGoal = finance?.qtdRevenue?.goal != null ? finance.qtdRevenue.goal / 3 : null;
      const quarterGoalFallback = monthlyRevGoal != null ? Math.round(monthlyRevGoal * 3) : null;
      const currentQ = Math.floor((Number(chicagoToday().slice(5, 7)) - 1) / 3) + 1;
      const vtoQuarterList = [1, 2, 3, 4].map((n) => {
        const label = `${year} Q${n}`;
        const state = n < currentQ ? 'past' : n === currentQ ? 'current' : 'future';
        const goal = qtrTargets[label] != null ? qtrTargets[label] : quarterGoalFallback;
        const actual = state === 'future' ? null : (qtrRevenue[n] ?? null);
        return { n, label, goal, actual, state };
      });
      const annualGoal = vtoQuarterList.reduce((s, q) => s + (q.goal || 0), 0) || null;

      // Projected annual revenue = collected YTD + invoiced-unpaid (A/R) +
      // ALL future accepted quotes + (12-month recurring avg × remaining months).
      const currentMonthNum = Number(chicagoToday().slice(5, 7));
      const remainingMonths = Math.max(0, 12 - currentMonthNum);
      const collectedYtd = finance?.ytdRevenue?.actual ?? null;
      const ar = finance?.ar ?? null;
      const quotesAvailable = quotes != null;
      const acceptedQuotes = quotesAvailable
        ? Math.round((quotes.accepted || []).reduce((s, qx) => s + (qx.total || 0), 0))
        : null;
      const recurringMonthly = val(recurR)?.avgMonthly != null ? Math.round(val(recurR).avgMonthly) : null;
      const recurringRest = recurringMonthly != null ? Math.round(recurringMonthly * remainingMonths) : null;
      const projectedAnnual = (collectedYtd != null)
        ? Math.round((collectedYtd || 0) + (ar || 0) + (acceptedQuotes || 0) + (recurringRest || 0))
        : null;

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

      // ── VTO Vision: attach live "current" to any 1-year goal with a Metric ──
      // (recurring = monthly avg; revenue/profit = YTD cash basis; speaking =
      // stages booked YTD). Debt Paydown has no live source yet → stays manual.
      const vision = val(visionR);
      if (vision && Array.isArray(vision.yearGoals) && vision.yearGoals.some((g) => g.metric)) {
        const yStart = `${year}-01-01`;
        const today = chicagoToday();
        const [ytdPnl, speakingYtd] = await Promise.all([
          computeXeroPnlForRange ? computeXeroPnlForRange(yStart, today).catch(() => null) : Promise.resolve(null),
          computeSpeakingActuals(notion, yStart, today).catch(() => null),
        ]);
        const currents = {
          'Recurring Revenue': recurringMonthly,
          'Revenue': ytdPnl?.revenue ?? null,
          'Profit': ytdPnl?.profit ?? null,
          'Speaking Stages': speakingYtd?.stagesBooked ?? null,
          // 'Debt Paydown' intentionally absent — no live source wired.
        };
        vision.yearGoals = vision.yearGoals.map((g) => ({
          ...g,
          current: g.metric && (g.metric in currents) ? currents[g.metric] : null,
        }));
      }

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
          ? { quarter: scorecard.quarter, state: scorecard.state, metrics: scorecard.metrics, offTrackCount, pairs: scorecard.pairs }
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
        vision,
        vto: {
          rocks,
          metrics: scorecard?.metrics || [],
          quarter: scorecard?.quarter || (currentQuarter ? currentQuarter().label : null),
          rocksOffTrack,
        },
        vtoQuarters: {
          year,
          currentQ,
          annual: {
            goal: annualGoal,
            actual: collectedYtd,            // collected YTD (cash basis)
            ar,                              // invoiced, not yet paid
            acceptedQuotes,                  // null when the quotes scope isn't granted
            recurringMonthly,
            recurringRest,                   // recurring × remaining full months
            remainingMonths,
            projected: projectedAnnual,      // collected + ar + quotes + recurringRest
          },
          quarters: vtoQuarterList,
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
  // ?quarter=2026 Q2 → that quarter's scorecard (lazy, cached per label). No
  // param → current quarter (used by the /today briefing peek).
  app.get('/api/scale/scorecard', async (req, res) => {
    try {
      const q = String(req.query.quarter || '').trim();
      const ym = q.match(/(\d{4}).*?Q([1-4])/i);
      const label = ym ? `${ym[1]} Q${ym[2]}` : null;
      if (label) {
        const key = `scale-scorecard-${label}`;
        if (req.query.fresh === '1' && clearCached) clearCached(key);
        return res.json(await cached(key, () => computeScorecardForQuarter(label)));
      }
      res.json(await cached('scale-scorecard', computeScorecard));
    } catch (err) { console.error('scale/scorecard error:', err.message); res.status(500).json({ error: err.message }); }
  });
  // Promote an auto-flag (or any text) into the Issues List (ISSUES [DB]) as a new
  // open issue. Severity → Priority (red = HIGH, amber = NORMAL); lands as "Current"
  // so it shows in the queue immediately. fetchIssues is uncached, so the next
  // /api/scale/data picks it up with no cache bust.
  app.post('/api/scale/issue', async (req, res) => {
    try {
      if (!notion) return res.status(500).json({ error: 'Notion not configured' });
      const title = String((req.body && req.body.message) || '').trim();
      if (!title) return res.status(400).json({ error: 'message required' });
      const priority = (req.body && req.body.severity) === 'red' ? 'HIGH' : 'NORMAL';
      const page = await notion.pages.create({
        parent: { type: 'data_source_id', data_source_id: ISSUES_DS },
        properties: {
          'Task Name': { title: [{ text: { content: title.slice(0, 1900) } }] },
          Status: { status: { name: 'Current' } },
          Priority: { select: { name: priority } },
        },
      });
      res.json({ ok: true, id: page.id, url: page.url });
    } catch (err) { console.error('scale/issue create error:', err.message); res.status(500).json({ error: err.message }); }
  });
  // Update an issue's Status (board column / Done) and/or Priority. Used by the
  // Issues board: drag between Current/Agenda, check-off to Done, change priority.
  app.patch('/api/scale/issue/:id', async (req, res) => {
    try {
      if (!notion) return res.status(500).json({ error: 'Notion not configured' });
      const { status, priority, title, order } = req.body || {};
      const props = {};
      if (status) props.Status = { status: { name: status } };
      if (priority) props.Priority = { select: { name: priority } }; // "none" is a real option
      if (typeof title === 'string' && title.trim()) props['Task Name'] = { title: [{ text: { content: title.trim().slice(0, 1900) } }] };
      if (typeof order === 'number') props['Board Order'] = { number: order };
      if (!Object.keys(props).length) return res.status(400).json({ error: 'nothing to update' });
      await notion.pages.update({ page_id: req.params.id, properties: props });
      res.json({ ok: true });
    } catch (err) { console.error('scale/issue patch error:', err.message); res.status(500).json({ error: err.message }); }
  });
  // Bulk drag-to-reorder: persist the new Board Order for the cards that moved.
  app.post('/api/scale/issues/reorder', async (req, res) => {
    try {
      if (!notion) return res.status(500).json({ error: 'Notion not configured' });
      const updates = (req.body && req.body.updates) || [];
      if (!Array.isArray(updates) || !updates.length) return res.status(400).json({ error: 'no updates' });
      await Promise.all(updates
        .filter((u) => u && u.id && typeof u.order === 'number')
        .map((u) => notion.pages.update({ page_id: u.id, properties: { 'Board Order': { number: u.order } } })));
      res.json({ ok: true });
    } catch (err) { console.error('scale/issues reorder error:', err.message); res.status(500).json({ error: err.message }); }
  });

  // ── VTO Vision in-app editing (writes to VTO [DB]) ──
  // Build a Notion properties patch from a request body; only keys present are set.
  const visionProps = (b) => {
    const p = {};
    if (typeof b.item === 'string') p.Item = { title: [{ text: { content: b.item.trim().slice(0, 1900) } }] };
    if (b.section) p.Section = { select: { name: b.section } };
    if ('field' in b) p.Field = b.field ? { select: { name: b.field } } : { select: null };
    if (typeof b.detail === 'string') p.Detail = { rich_text: b.detail ? [{ text: { content: b.detail.slice(0, 1900) } }] : [] };
    if ('sort' in b && b.sort != null) p.Sort = { number: Number(b.sort) };
    if ('metric' in b) p.Metric = b.metric ? { select: { name: b.metric } } : { select: null };
    if ('target' in b) p.Target = (b.target != null && b.target !== '') ? { number: Number(b.target) } : { number: null };
    if ('done' in b) p.Done = { checkbox: !!b.done };
    return p;
  };
  app.post('/api/scale/vision', async (req, res) => {
    try {
      if (!notion) return res.status(500).json({ error: 'Notion not configured' });
      const b = req.body || {};
      if (!b.section || typeof b.item !== 'string' || !b.item.trim()) return res.status(400).json({ error: 'section + item required' });
      const page = await notion.pages.create({ parent: { type: 'data_source_id', data_source_id: VTO_VISION_DS }, properties: visionProps(b) });
      res.json({ ok: true, id: page.id });
    } catch (err) { console.error('scale/vision create error:', err.message); res.status(500).json({ error: err.message }); }
  });
  app.patch('/api/scale/vision/:id', async (req, res) => {
    try {
      if (!notion) return res.status(500).json({ error: 'Notion not configured' });
      const props = visionProps(req.body || {});
      if (!Object.keys(props).length) return res.status(400).json({ error: 'nothing to update' });
      await notion.pages.update({ page_id: req.params.id, properties: props });
      res.json({ ok: true });
    } catch (err) { console.error('scale/vision patch error:', err.message); res.status(500).json({ error: err.message }); }
  });
  app.delete('/api/scale/vision/:id', async (req, res) => {
    try {
      if (!notion) return res.status(500).json({ error: 'Notion not configured' });
      await notion.pages.update({ page_id: req.params.id, archived: true });
      res.json({ ok: true });
    } catch (err) { console.error('scale/vision delete error:', err.message); res.status(500).json({ error: err.message }); }
  });
}
