// Notion provider for the Sales/Convert domain — the swappable data-access seam.
// A future Supabase (or other) provider would expose the same named exports.
import { SALES_PIPELINE_DS, SALES_PRODUCTS_DS } from '../../config/convert.js';

export async function fetchSalesProductMap(notion, cached) {
  return cached('sales-product-map', async () => {
    const map = {};
    let cursor;
    do {
      const r = await notion.dataSources.query({ data_source_id: SALES_PRODUCTS_DS, page_size: 100, start_cursor: cursor });
      for (const p of r.results) {
        const name = p.properties?.['Product Name']?.title?.[0]?.plain_text || '';
        if (name) map[p.id.replace(/-/g, '')] = name;
      }
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    return map;
  });
}

export function serializeDeal(page, productMap, opts = {}) {
  const p = page.properties || {};
  const rt = (prop) => (prop?.rich_text || []).map((t) => t.plain_text).join('');
  const archivedName = p.Archived?.status?.name || p.Archived?.select?.name || '';
  const out = {
    id: page.id,
    url: page.url,
    name: p['Deal Name']?.title?.[0]?.plain_text || '(untitled deal)',
    value: typeof p['Deal Value']?.number === 'number' ? p['Deal Value'].number : null,
    status: p['Pipeline Status']?.status?.name || null,
    typeOfSale: p['Type of Sale']?.select?.name || null,
    callBooked: p['Call Booked']?.date?.start || null,
    callCompleted: p['Call Completed']?.date?.start || null,
    dateWon: p['Date Won']?.date?.start || null,
    dateLost: p['Date Lost']?.date?.start || null,
    followUp: (p['Follow Up Owner']?.people || []).length > 0,
    followUpBy: p['Follow Up By']?.date?.start || null,
    followUpOwnerId: (p['Follow Up Owner']?.people || [])[0]?.id || null,
    followUpOwnerName: (p['Follow Up Owner']?.people || [])[0]?.name || null,
    lastTouched: p['Last Touched']?.rollup?.date?.start || p['Last Touched']?.rollup?.array?.[0]?.date?.start || p['Last Touched']?.date?.start || null,
    assignedTo: meKey((p['Assigned To']?.people || [])[0]?.name || ''),
    assignedIds: (p['Assigned To']?.people || []).map((u) => u.id),
    products: (p['Product Interest']?.relation || []).map((r) => productMap[r.id.replace(/-/g, '')]).filter(Boolean),
    productIds: (p['Product Interest']?.relation || []).map((r) => r.id.replace(/-/g, '')),
    archived: archivedName === '__YES__',
    created: page.created_time || null,
  };
  const recon = rt(p.Recon);
  if (opts.includeRecon) out.recon = recon;
  out.hasRecon = !!recon.trim();
  return out;
}

export async function queryAllDeals(notion) {
  const all = [];
  let cursor;
  do {
    const r = await notion.dataSources.query({
      data_source_id: SALES_PIPELINE_DS,
      sorts: [{ property: 'Deal Value', direction: 'descending' }],
      page_size: 100,
      start_cursor: cursor,
    });
    all.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return all;
}

// Map a Notion "Assigned To" person name to the app's me-mode key.
function meKey(name) {
  return /trina/i.test(name || '') ? 'trina' : /gretchen/i.test(name || '') ? 'gretchen' : (name ? 'other' : null);
}

export function serializeContactRow(page) {
  const p = page.properties || {};
  const lt = p['Last Touched']?.date?.start || null;
  const assignedName = (p['Assigned To']?.people || [])[0]?.name || '';
  return {
    id: page.id,
    url: page.url,
    name: p['Full Name']?.title?.[0]?.plain_text || '(no name)',
    relationship: p['Relationship']?.select?.name || null,
    stage: p['Stage']?.select?.name || null,
    track: p['Track']?.select?.name || null,
    source: p['Source']?.select?.name || null,
    assignedTo: meKey(assignedName),
    assignedToName: assignedName || null,
    assignedIds: (p['Assigned To']?.people || []).map((u) => u.id),
    lastTouched: lt,
  };
}
