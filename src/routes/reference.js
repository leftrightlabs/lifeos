// Reference zone — universal search across Notion, Gmail, Google Drive, and
// Contacts. Each source is fetched in parallel and a failing source is logged
// and skipped (never kills the response). Slack is intentionally not wired
// (search.all needs a paid plan + search:read scope).
import {
  CONTACTS_DS, PLAYBOOK_DS, NOTES_DS, TESTIMONIALS_DS, PEOPLE_DS,
  PINNED_PROP, CAPS, NOTION_DB_TYPE, DRIVE_TYPE,
} from '../config/reference.js';

const txt = (rt) => (rt && rt.length ? rt.map((t) => t.plain_text).join('') : '');
const titleOf = (p) => {
  const props = p.properties || {};
  const t = Object.values(props).find((v) => v?.type === 'title');
  return txt(t?.title) || 'Untitled';
};
const propText = (p, name) => {
  const v = (p.properties || {})[name];
  if (!v) return '';
  if (v.type === 'rich_text') return txt(v.rich_text);
  if (v.type === 'select') return v.select?.name || '';
  if (v.type === 'multi_select') return (v.multi_select || []).map((x) => x.name).join(', ');
  if (v.type === 'title') return txt(v.title);
  return '';
};

export function registerReferenceRoutes(app, {
  notion, cached, authedClient, configuredAccounts, fetchInbox, google,
}) {
  // ── individual source searches (each returns normalized rows) ──
  async function searchNotion(q) {
    if (!notion) return [];
    const r = await notion.search({ query: q, filter: { property: 'object', value: 'page' }, page_size: CAPS.notion });
    return (r.results || []).filter((p) => p.object === 'page').map((p) => {
      const dbId = p.parent?.database_id?.replace(/-/g, '') || '';
      return {
        source: 'notion',
        type: NOTION_DB_TYPE[dbId] || 'Doc',
        title: titleOf(p),
        meta: ['Notion', propText(p, 'Area') || propText(p, 'Category') || ''].filter(Boolean).join(' · '),
        url: p.url,
        updatedAt: p.last_edited_time,
      };
    });
  }

  async function searchDrive(q) {
    const accounts = configuredAccounts();
    if (!accounts.length || !google) return [];
    const safe = String(q).replace(/['\\]/g, '\\$&');
    const out = [];
    await Promise.all(accounts.map(async (account) => {
      try {
        const auth = authedClient(account);
        const drive = google.drive({ version: 'v3', auth });
        const r = await drive.files.list({
          q: `fullText contains '${safe}' and trashed=false`,
          fields: 'files(id,name,mimeType,webViewLink,modifiedTime)',
          pageSize: CAPS.drive,
          orderBy: 'modifiedTime desc',
          corpora: 'allDrives', includeItemsFromAllDrives: true, supportsAllDrives: true,
        });
        for (const f of (r.data.files || [])) {
          out.push({
            source: 'drive',
            type: DRIVE_TYPE[f.mimeType] || 'File',
            title: f.name,
            meta: `Google Drive (${account})`,
            url: f.webViewLink,
            updatedAt: f.modifiedTime,
          });
        }
      } catch (e) { console.error(`[reference] Drive (${account}) failed:`, e.message); }
    }));
    return out;
  }

  async function searchGmail(q) {
    const accounts = configuredAccounts();
    if (!accounts.length) return [];
    const results = await Promise.all(accounts.map((account, i) =>
      fetchInbox(account, i, { q, maxResults: CAPS.gmail }).catch((e) => { console.error(`[reference] Gmail (${account}) failed:`, e.message); return []; })
    ));
    return results.flat().map((m) => ({
      source: 'gmail',
      type: 'Email',
      title: m.subject || '(no subject)',
      meta: m.fromName || m.fromEmail || '',
      url: m.url,
      updatedAt: m.internalDate ? new Date(m.internalDate).toISOString() : (m.date || null),
    }));
  }

  async function searchContacts(q) {
    if (!notion) return [];
    const ql = q.toLowerCase();
    const out = [];
    await Promise.all([CONTACTS_DS, PEOPLE_DS].filter(Boolean).map(async (ds) => {
      try {
        const r = await notion.dataSources.query({ data_source_id: ds, page_size: 100 });
        for (const p of r.results) {
          const name = titleOf(p);
          if (!name.toLowerCase().includes(ql)) continue;
          out.push({
            source: 'contacts',
            type: 'Contact',
            title: name,
            meta: [propText(p, 'Role'), propText(p, 'Company') || propText(p, 'Organization')].filter(Boolean).join(' · ') || 'Contact',
            url: p.url,
            updatedAt: p.last_edited_time,
          });
        }
      } catch (e) { console.error('[reference] Contacts failed:', e.message); }
    }));
    return out.slice(0, CAPS.contacts);
  }

  // ── GET /api/reference/search ──
  app.get('/api/reference/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    const source = req.query.source || 'all';
    if (q.length < 2) return res.json([]);
    try {
      const jobs = [];
      const wants = (s) => source === 'all' ? ['notion', 'drive', 'gmail'].includes(s) : source === s;
      if (wants('notion')) jobs.push(searchNotion(q));
      if (wants('drive')) jobs.push(searchDrive(q));
      if (wants('gmail')) jobs.push(searchGmail(q));
      if (source === 'contacts') jobs.push(searchContacts(q));
      const settled = await Promise.allSettled(jobs);
      let rows = [];
      for (const s of settled) { if (s.status === 'fulfilled') rows = rows.concat(s.value); else console.error('[reference] source rejected:', s.reason?.message); }
      // newest first within the flat list; the client groups by source.
      rows.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      res.json(rows);
    } catch (err) {
      console.error('reference/search error:', err.message);
      res.status(500).json({ error: err.message, results: [] });
    }
  });

  // ── pinned docs (favorited) ──
  async function fetchPinned(ds, propName) {
    if (!notion || !ds) return [];
    try {
      const r = await notion.dataSources.query({
        data_source_id: ds,
        filter: { property: propName, checkbox: { equals: true } },
        page_size: 12,
      });
      return r.results.map((p) => ({
        type: (propText(p, 'Type') || 'Doc').toUpperCase(),
        title: titleOf(p),
        meta: [propText(p, 'Area') || propText(p, 'Focus'), propText(p, 'System') || propText(p, 'Hub')].filter(Boolean).join(' · '),
        url: p.url,
      }));
    } catch (e) { console.error('[reference] pinned failed:', e.message); return []; }
  }

  app.get('/api/reference/pinned', async (req, res) => {
    const mode = req.query.mode === 'personal' ? 'personal' : 'work';
    const ds = mode === 'personal' ? NOTES_DS : PLAYBOOK_DS;
    const prop = mode === 'personal' ? PINNED_PROP.notes : PINNED_PROP.playbook;
    res.json(await fetchPinned(ds, prop));
  });

  app.get('/api/reference/contacts', async (req, res) => {
    const mode = req.query.mode === 'personal' ? 'personal' : 'work';
    const ds = mode === 'personal' ? PEOPLE_DS : CONTACTS_DS;
    if (!notion || !ds) return res.json([]);
    try {
      const r = await notion.dataSources.query({
        data_source_id: ds,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
        page_size: 5,
      });
      res.json(r.results.map((p) => ({
        name: titleOf(p),
        // PEOPLE [DB]: Title = job title, Relationship = multi-select. CONTACTS [DB]
        // (work): Role/Company/Relationship. Pick whatever's present.
        sub: [propText(p, 'Role') || propText(p, 'Title'), propText(p, 'Company') || propText(p, 'Organization') || propText(p, 'Relationship')].filter(Boolean).join(' · '),
        url: p.url,
      })));
    } catch (e) { console.error('[reference] contacts failed:', e.message); res.json([]); }
  });

  app.get('/api/reference/testimonials', async (_req, res) => {
    if (!notion || !TESTIMONIALS_DS) return res.json([]);
    try {
      // TESTIMONIALS [DB]: title "Testimonial" = client name; "Short Quote 1" = pull
      // quote. Company/Client are rollup/relation (not plain text) so the title is
      // the reliable author. Prefer favorited, newest first.
      const r = await notion.dataSources.query({
        data_source_id: TESTIMONIALS_DS,
        filter: { property: 'Favorite', checkbox: { equals: true } },
        page_size: 3,
      }).catch(() => notion.dataSources.query({ data_source_id: TESTIMONIALS_DS, page_size: 3 }));
      let rows = r.results;
      if (!rows.length) rows = (await notion.dataSources.query({ data_source_id: TESTIMONIALS_DS, page_size: 3 })).results;
      res.json(rows.map((p) => ({
        quote: propText(p, 'Short Quote 1') || propText(p, 'Full Transcript') || titleOf(p),
        author: titleOf(p).replace(/\s*[-–—]\s*testimonial\s*$/i, '').trim(),
        role: propText(p, 'Industry') || '',
        url: p.url,
      })));
    } catch (e) { console.error('[reference] testimonials failed:', e.message); res.json([]); }
  });
}
