// Scale zone — Notion data-access seam for the Business Functions ("systems") DB,
// the VTO Scorecard (targets scored against live systems), the IDS issue queue,
// and the quarterly Rocks. Swappable: a non-Notion provider would expose the
// same serialized shapes.
import {
  BUSINESS_FUNCTIONS_DS,
  VTO_SCORECARD_DS,
  ISSUES_DS,
  ISSUE_QUEUE_STATUSES,
  ISSUE_PRIORITY_RANK,
  rockStatusFromPct,
} from '../../config/scale.js';

const txt = (rt) => (rt && rt.length ? rt.map((t) => t.plain_text).join('') : '');

export function serializeScorecardMetric(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    metric: txt(p.Metric?.title),
    goal: p.Goal?.number ?? null,
    breakEven: p['Break Even']?.number ?? null,
    cadence: p.Cadence?.select?.name || null,       // Weekly | Monthly | Quarterly
    direction: p.Direction?.select?.name || null,   // "↑ higher is better" | "↓ lower is better"
    category: p.Category?.select?.name || null,
    unit: txt(p.Unit?.rich_text) || null,
    source: p.Source?.select?.name || null,         // e.g. "Xero Revenue"
    quarter: p.Quarter?.select?.name || null,       // e.g. "2026 Q2"
  };
}

// Scorecard metric rows tagged for a given quarter (e.g. "2026 Q2").
export async function fetchScorecardMetrics(notion, quarterLabel) {
  if (!notion) return [];
  const res = await notion.dataSources.query({
    data_source_id: VTO_SCORECARD_DS,
    filter: { property: 'Quarter', select: { equals: quarterLabel } },
    page_size: 50,
  });
  return res.results.map(serializeScorecardMetric);
}

export function serializeBusinessFunction(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    name: txt(p['System Name']?.title),
    health: p['Health Status']?.status?.name || null,
    priority: p.Priority?.select?.name || null,
    func: p.Function?.select?.name || null,
    impact: p['Impact Score']?.number ?? null,
    effort: p['Effort to Fix']?.number ?? null,
    maturity: p['Maturity Score']?.formula?.number ?? p['Maturity Score']?.number ?? null,
    owner: p.Owner?.people?.[0]?.name || null,
    nextActions: txt(p['Next Actions']?.rich_text),
    whatsMissing: txt(p["What's Missing"]?.rich_text),
  };
}

// Returns every Business Function row (paginated), serialized.
export async function fetchBusinessFunctions(notion) {
  if (!notion) return [];
  const out = [];
  let cursor;
  do {
    const res = await notion.dataSources.query({
      data_source_id: BUSINESS_FUNCTIONS_DS,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const pg of res.results) out.push(serializeBusinessFunction(pg));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ── PULSE: IDS issue queue ──
export function serializeIssue(page) {
  const p = page.properties || {};
  const priority = p.Priority?.select?.name || null;
  return {
    id: page.id,
    notionUrl: page.url,
    name: txt(p['Task Name']?.title) || txt(p.Name?.title) || '(untitled)',
    status: p.Status?.status?.name || p.Status?.select?.name || null,
    priority,
    assigned: (p.Assigned?.people || []).map((u) => u.name).filter(Boolean).join(', ') || null,
    assignedIds: (p.Assigned?.people || []).map((u) => u.id),
    due: p.Due?.date?.start || null,
    // "Date added" for the Issues board — Notion's page creation timestamp.
    createdTime: p['Created time']?.created_time || page.created_time || null,
    // Manual board ordering (drag-to-reorder); null until the user arranges.
    order: typeof p['Board Order']?.number === 'number' ? p['Board Order'].number : null,
  };
}

// Open IDS-queue issues (Current/Agenda), sorted URGENT → HIGH → NORMAL.
export async function fetchIssues(notion) {
  if (!notion) return [];
  const res = await notion.dataSources.query({
    data_source_id: ISSUES_DS,
    filter: { or: ISSUE_QUEUE_STATUSES.map((s) => ({ property: 'Status', status: { equals: s } })) },
    page_size: 50,
  });
  const issues = res.results.map(serializeIssue);
  // Manual Board Order first (issues the user has arranged); the rest fall back
  // to priority. Within "ordered", lower number = higher on the board.
  issues.sort((a, b) => {
    const ao = a.order, bo = b.order;
    if (ao != null && bo != null) return ao - bo;
    if (ao != null) return -1;
    if (bo != null) return 1;
    return (ISSUE_PRIORITY_RANK[b.priority] || 0) - (ISSUE_PRIORITY_RANK[a.priority] || 0);
  });
  return issues;
}

// ── VTO: quarterly Rocks ──
// Reads % complete from the Progress formula when present; otherwise derives it
// from milestone completion (BUILD-SPEC §9). Milestones are fetched per-rock
// (there are only a handful), giving us the "next action" line too.
export function serializeRock(page) {
  const p = page.properties || {};
  let pct = null;
  const pf = p.Progress?.formula;
  if (pf) {
    if (typeof pf.number === 'number') pct = pf.number <= 1 ? Math.round(pf.number * 100) : Math.round(pf.number);
    else if (pf.string) { const n = parseFloat(pf.string); if (!Number.isNaN(n)) pct = n <= 1 ? Math.round(n * 100) : Math.round(n); }
  }
  const name = txt(p.Name?.title) || '(untitled)';
  // Quarter is derived from the rock name (convention: "2026 Q2 Rocks - 5 - …").
  // Used to group MOCs by quarter on the VTO tab.
  const qm = name.match(/\b(20\d\d)\s*Q([1-4])\b/i);
  const quarter = qm ? `${qm[1]} Q${qm[2]}` : null;
  return {
    id: page.id,
    notionUrl: page.url,
    name,
    quarter,
    owner: p.Assigned?.people?.[0]?.name || null,
    ownerIds: (p.Assigned?.people || []).map((u) => u.id),
    function: p.Function?.select?.name || null,
    status: p.Status?.status?.name || null,
    deadline: p['Target Deadline']?.date?.start || p['Target Deadline']?.date?.end || p.Due?.date?.start || null,
    pct,
  };
}

export async function fetchRocks(notion, { projectsDs, tasksDs, projectPropName = 'Project' }) {
  if (!notion) return [];
  let res;
  try {
    res = await notion.dataSources.query({
      data_source_id: projectsDs,
      filter: { property: 'ROCK', checkbox: { equals: true } },
      page_size: 50,
    });
  } catch (err) {
    console.error('scale rocks query failed:', err.message);
    return [];
  }
  return Promise.all(res.results.map(async (page) => {
    const rock = serializeRock(page);
    // Every task in a Rock project counts toward progress (the Milestone field
    // is no longer used to gate this) → fallback % + next action.
    let milestones = [];
    try {
      const t = await notion.dataSources.query({
        data_source_id: tasksDs,
        filter: { property: projectPropName, relation: { contains: page.id } },
        sorts: [{ property: 'Due', direction: 'ascending' }, { timestamp: 'created_time', direction: 'ascending' }],
        page_size: 100,
      });
      milestones = t.results.map((m) => ({
        name: m.properties.Name?.title?.[0]?.plain_text || '(untitled)',
        done: m.properties.Status?.status?.name === 'Done',
      }));
    } catch (err) {
      console.error(`scale rock milestones (${page.id}) failed:`, err.message);
    }
    const total = milestones.length;
    const done = milestones.filter((m) => m.done).length;
    if (rock.pct == null && total > 0) rock.pct = Math.round((done / total) * 100);
    if (rock.pct == null) rock.pct = 0;
    const nextMs = milestones.find((m) => !m.done);
    rock.nextAction = nextMs ? nextMs.name : null;
    rock.milestonesDone = done;
    rock.milestonesTotal = total;
    rock.statusKey = rockStatusFromPct(rock.pct);
    return rock;
  }));
}
