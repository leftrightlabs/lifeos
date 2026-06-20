// Scale zone — Notion data-access seam for the Business Functions ("systems") DB.
// Swappable: a non-Notion provider would expose the same serialized shape.
import { BUSINESS_FUNCTIONS_DS } from '../../config/scale.js';

const txt = (rt) => (rt && rt.length ? rt.map((t) => t.plain_text).join('') : '');

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
