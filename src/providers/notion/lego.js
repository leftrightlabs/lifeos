// Notion provider for the LEGO (Personal) domain — the swappable data-access seam.
// Reads the LEGO [DB]s and rolls them up into the LEGO tab's KPI summary + sections.
import {
  LEGO_SETS_DS, LEGO_MOCS_DS, LEGO_SHOWS_DS, PROJECTS_DS, LEGO_FOCUS_PAGE,
  SET_STATUS_NOT_OWNED, MOC_STATUS_BUILT, MOC_STATUS_ACTIVE,
} from '../../config/lego.js';

const NOT_OWNED = new Set(SET_STATUS_NOT_OWNED);
const BUILT = new Set(MOC_STATUS_BUILT);

// Page through an entire Notion data source (100 rows/call), like queryAllDeals.
async function queryAll(notion, dataSourceId, body = {}) {
  const all = [];
  let cursor;
  do {
    const r = await notion.dataSources.query({ data_source_id: dataSourceId, page_size: 100, start_cursor: cursor, ...body });
    all.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return all;
}

const num = (prop) => (typeof prop?.number === 'number' ? prop.number : 0);
const txt = (prop) => (prop?.rich_text || []).map((t) => t.plain_text).join('').trim();
const title = (prop) => prop?.title?.[0]?.plain_text || '';
// Page cover image (file URLs are presigned + expire ~1h; our 10-min cache keeps them fresh).
const cover = (page) => page?.cover?.external?.url || page?.cover?.file?.url || null;
const mapToSortedArray = (m) => Object.entries(m).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count);

// LEGO projects (PROJECTS filtered to the 👻 LEGO focus area). Best-effort: a missing
// share / renamed property returns null rather than breaking the whole summary.
async function getLegoProjects(notion) {
  try {
    const rows = await queryAll(notion, PROJECTS_DS, {
      filter: { property: 'Area', relation: { contains: LEGO_FOCUS_PAGE } },
    });
    return rows.map((pg) => {
      const p = pg.properties || {};
      return {
        name: title(p['Name']) || '(untitled project)',
        status: p['Status']?.status?.name || null,
        deadline: p['Target Deadline']?.date?.start || null,
        url: pg.url,
      };
    });
  } catch { return null; }
}

// Build the full LEGO tab payload. Sets + MOCs are required (errors propagate so the UI
// can surface "DB not shared with integration"); Shows + Projects are best-effort.
export async function getLegoSummary(notion) {
  if (!notion) return { configured: false };

  const [sets, mocs] = await Promise.all([
    queryAll(notion, LEGO_SETS_DS),
    queryAll(notion, LEGO_MOCS_DS),
  ]);

  // --- LEGO Sets → collection rollups + breakdowns + gallery ---
  let owned = 0, wishlist = 0, collectionValue = 0, totalPieces = 0, purchasePaid = 0, profit = 0;
  const themeMap = {}, statusMap = {};
  const setGallery = [];
  for (const s of sets) {
    const p = s.properties || {};
    const status = p['Status']?.select?.name || '';
    if (status === 'Wishlist') { wishlist++; continue; }
    if (NOT_OWNED.has(status)) continue; // Sold
    owned++;
    const cv = num(p['Current Value']);
    collectionValue += cv;
    totalPieces += num(p['Pieces']);
    purchasePaid += num(p['Purchase Price']);
    profit += num(p['Profit']);

    const theme = p['Theme']?.select?.name || 'Other';
    (themeMap[theme] ||= { count: 0, value: 0 }).count++; themeMap[theme].value += cv;
    const st = status || 'Uncategorized';
    (statusMap[st] ||= { count: 0, value: 0 }).count++; statusMap[st].value += cv;

    const image = txt(p['Image']) || cover(s);
    if (image) setGallery.push({ name: title(p['Set Name']), image, theme, status: st, value: cv });
  }
  setGallery.sort((a, b) => b.value - a.value);

  // --- LEGO MOCS → build rollups + pipeline (grouped by status) ---
  let mocsTotal = 0, mocsActive = 0, mocsBuilt = 0, awards = 0, activeName = null;
  const pipeline = {};
  const mocGallery = [];
  for (const m of mocs) {
    const p = m.properties || {};
    const status = p['Status']?.status?.name || 'Unsorted';
    mocsTotal++;
    if (status === MOC_STATUS_ACTIVE) { mocsActive++; if (!activeName) activeName = title(p['Name']) || null; }
    if (BUILT.has(status)) mocsBuilt++;
    const award = txt(p['Award']);
    if (award) awards++;
    const item = {
      name: title(p['Name']) || '(untitled MOC)',
      category: p['Category']?.select?.name || null,
      parts: num(p['Parts']) || null,
      award: award || null,
      image: cover(m),
    };
    (pipeline[status] ||= []).push(item);
    if (item.image && (BUILT.has(status) || award)) mocGallery.push(item);
  }

  const [nextConvention, projects] = await Promise.all([nextShow(notion), getLegoProjects(notion)]);

  return {
    configured: true,
    asOf: new Date().toISOString(),
    sets: { owned, wishlist, collectionValue, totalPieces, purchasePaid, profit },
    mocs: { total: mocsTotal, active: mocsActive, built: mocsBuilt, awards, activeName },
    nextConvention,
    collection: { byTheme: mapToSortedArray(themeMap).slice(0, 8), byStatus: mapToSortedArray(statusMap), gallery: setGallery.slice(0, 12) },
    pipeline, // { status: [ {name, category, parts, award, image}, ... ] }
    mocGallery: mocGallery.slice(0, 12),
    projects, // array of {name, status, deadline, url} or null
  };
}

// Next upcoming convention from LEGO SHOWS — best effort.
async function nextShow(notion) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const shows = await queryAll(notion, LEGO_SHOWS_DS);
    const upcoming = shows
      .map((row) => {
        const p = row.properties || {};
        return {
          name: title(p['Event']) || '(event)',
          date: p['Date']?.date?.start || null,
          status: p['Status']?.status?.name || '',
          location: txt(p['Location']),
        };
      })
      .filter((e) => e.date && e.date >= today && e.status !== 'Attended')
      .sort((a, b) => a.date.localeCompare(b.date));
    return upcoming[0] || null;
  } catch { return null; }
}
