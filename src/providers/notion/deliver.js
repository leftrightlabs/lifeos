// Deliver provider — Notion data access for the wired sections (offers + care
// plans). The swappable seam: app/zone logic stays in the route; only this file
// knows Notion property shapes. Mirrors the Convert provider's query pattern.
import { PRODUCTS_DS, WEB_PROPERTIES_DS } from '../../config/deliver.js';

const title = (p) => (p && p.title && p.title[0] && p.title[0].plain_text) || '';
const rtext = (p) => (p && p.rich_text && p.rich_text[0] && p.rich_text[0].plain_text) || '';
const sel = (p) => (p && p.select && p.select.name) || null;
const msel = (p) => ((p && p.multi_select) || []).map((o) => o.name);
const chk = (p) => !!(p && p.checkbox);
const dstart = (p) => (p && p.date && p.date.start) || null;

async function queryAll(notion, dsId) {
  const out = [];
  let cursor;
  do {
    const r = await notion.dataSources.query({ data_source_id: dsId, page_size: 100, start_cursor: cursor });
    out.push(...(r.results || []));
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

// Offers (PRODUCTS [DB]) → { name, categories[], status, url, notionUrl }, archived dropped.
export async function fetchOffers(notion) {
  const pages = await queryAll(notion, PRODUCTS_DS);
  return pages.map((pg) => {
    const p = pg.properties || {};
    return {
      name: title(p['Product Name']),
      categories: msel(p['Categories']),
      status: sel(p['Published Status']) || 'Draft',
      url: rtext(p['URL']) || null,
      notionUrl: pg.url,
      archived: chk(p['Archived']),
    };
  }).filter((o) => !o.archived && o.name);
}

// Web properties (WEB PROPERTIES [DB]) → { domain, plan, planEnd, autoRenew, notionUrl }, archived dropped.
export async function fetchWebProperties(notion) {
  const pages = await queryAll(notion, WEB_PROPERTIES_DS);
  return pages.map((pg) => {
    const p = pg.properties || {};
    return {
      domain: title(p['Domain']),
      plan: sel(p['Site Support Plan']),
      planEnd: dstart(p['Plan End']),
      autoRenew: chk(p['Domain Auto-Renews']),
      notionUrl: pg.url,
      archived: chk(p['Archive']),
    };
  }).filter((w) => !w.archived && w.domain);
}
