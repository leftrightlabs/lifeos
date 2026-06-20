// Scale zone — Notion data-access seam for the Business Functions ("systems") DB
// and the VTO Scorecard (targets scored against live systems).
// Swappable: a non-Notion provider would expose the same serialized shape.
import { BUSINESS_FUNCTIONS_DS, VTO_SCORECARD_DS } from '../../config/scale.js';

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
