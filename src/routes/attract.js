import { whatsWorkingAll, gaConfigured } from '../providers/google/analytics.js';

export function registerAttractRoutes(app, ctx) {
  const { notion, cache, cached, currentQuarter, chicagoTodayISODate, chicagoDateNDaysAgo, dashifyId, anthropic, userContext } = ctx;

// =========================== MARKETING PUBLISHING ===========================
const MARKETING_ASSETS_DS = '4170ff99-ce76-42b5-bcf2-7f672c362ec4';
const MARKETING_CHANNELS_DS = '87918a28-58ab-43d9-a038-7f0adec3f5d5';

// The asset's per-channel published-URL columns. Each field name is identical
// to the channel's "Channel Name" in CHANNELS [DB], which lets us map an
// asset's CHANNELS relation straight onto the field to paste the live URL into.
const MARKETING_CHANNEL_FIELDS = [
  'LinkedIn (Gretchen)', 'LinkedIn (Trina)', 'LinkedIn (Company)',
  'Facebook Page', 'Facebook Group', 'FB Profile (Gretchen)',
  'Instagram', 'YouTube', 'Brandwave', 'LRL Blog',
];

function marketingPlatform(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('linkedin')) return 'linkedin';
  if (n.includes('instagram')) return 'instagram';
  if (n.includes('facebook') || n.startsWith('fb ')) return 'facebook';
  if (n.includes('youtube')) return 'youtube';
  if (n.includes('blog')) return 'blog';
  if (n.includes('brandwave') || n.includes('email') || n.includes('wave')) return 'email';
  return 'other';
}


function invalidateMarketingCaches() {
  for (const k of cache.keys()) if (k.startsWith('marketing-')) cache.delete(k);
}

// channel page-id (dashless) -> Channel Name
async function fetchMarketingChannelMap() {
  return cached('marketing-channel-map', async () => {
    const map = {};
    let cursor;
    do {
      const r = await notion.dataSources.query({ data_source_id: MARKETING_CHANNELS_DS, page_size: 100, start_cursor: cursor });
      for (const p of r.results) {
        const name = p.properties?.['Channel Name']?.title?.[0]?.plain_text || '';
        if (name) map[p.id.replace(/-/g, '')] = name;
      }
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    return map;
  });
}

function marketingFileEntry(f, assetIdDashless, idx) {
  const name = f.name || 'file';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const isImage = ['png','jpg','jpeg','gif','webp','heic','svg','bmp'].includes(ext);
  const isPdf = ext === 'pdf';
  const isVideo = ['mp4','mov','webm','m4v'].includes(ext);
  return {
    name, ext,
    kind: isImage ? 'image' : isPdf ? 'pdf' : isVideo ? 'video' : 'other',
    // Always proxy through our server: Notion's signed URLs expire (~1h) and
    // block cross-origin download. ?dl=1 forces an attachment download.
    src: `/api/attract/media?asset=${assetIdDashless}&idx=${idx}`,
    download: `/api/attract/media?asset=${assetIdDashless}&idx=${idx}&dl=1`,
  };
}

function serializeMarketingAsset(page, channelMap, opts = {}) {
  const p = page.properties || {};
  const rt = (prop) => (prop?.rich_text || []).map((t) => t.plain_text).join('');
  const idDashless = page.id.replace(/-/g, '');
  const media = (p.Media?.files || []).map((f, i) => marketingFileEntry(f, idDashless, i));

  // Channels: targeted (from CHANNELS relation, mapped by name to a field) first,
  // then any field that already holds a live URL even if not explicitly targeted.
  const channels = [];
  const seen = new Set();
  const targetedNames = (p.CHANNELS?.relation || [])
    .map((r) => channelMap[r.id.replace(/-/g, '')])
    .filter(Boolean);
  for (const name of targetedNames) {
    if (MARKETING_CHANNEL_FIELDS.includes(name) && !seen.has(name)) {
      seen.add(name);
      channels.push({ name, field: name, platform: marketingPlatform(name), url: p[name]?.url || '', targeted: true });
    }
  }
  for (const field of MARKETING_CHANNEL_FIELDS) {
    const val = p[field]?.url || '';
    if (val && !seen.has(field)) {
      seen.add(field);
      channels.push({ name: field, field, platform: marketingPlatform(field), url: val, targeted: false });
    }
  }

  return {
    id: page.id,
    url: page.url,
    name: p['Asset Name']?.title?.[0]?.plain_text || '(untitled)',
    status: p.Status?.status?.name || null,
    publishDate: p['Publish Date']?.date?.start || null,
    formats: (p.Format?.multi_select || []).map((o) => o.name),
    contentType: p['Content Type']?.select?.name || null,
    needs: (p.Needs?.multi_select || []).map((o) => o.name),
    primaryTopic: rt(p['Primary Topic']),
    notes: rt(p.Notes),
    media,
    channels,
  };
}

function marketingRichText(block) {
  const t = block[block.type];
  return (t?.rich_text || []).map((r) => r.plain_text).join('');
}

// Parse a page body into copy "sections" split on headings/dividers, so the UI
// can offer a Copy button per section (e.g. "LinkedIn Caption", "First Comment").
async function fetchMarketingCopy(pageId) {
  const blocks = [];
  let cursor;
  try {
    do {
      const r = await notion.blocks.children.list({ block_id: pageId, page_size: 100, start_cursor: cursor });
      blocks.push(...r.results);
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
  } catch (_) { return []; }
  const sections = [];
  let cur = { heading: '', lines: [] };
  const flush = () => { if (cur.heading || cur.lines.join('').trim()) sections.push({ heading: cur.heading, text: cur.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() }); };
  for (const b of blocks) {
    const type = b.type;
    if (type === 'heading_1' || type === 'heading_2' || type === 'heading_3') {
      flush(); cur = { heading: marketingRichText(b), lines: [] };
    } else if (type === 'divider') {
      flush(); cur = { heading: '', lines: [] };
    } else if (type === 'bulleted_list_item' || type === 'numbered_list_item') {
      cur.lines.push('• ' + marketingRichText(b));
    } else if (type === 'to_do') {
      cur.lines.push((b.to_do?.checked ? '☑ ' : '☐ ') + marketingRichText(b));
    } else if (['paragraph','quote','callout','heading_toggle','toggle'].includes(type)) {
      cur.lines.push(marketingRichText(b));
    }
  }
  flush();
  return sections.filter((s) => s.heading || s.text);
}

// GET /api/attract/today — the publish queue: overdue + due-today (with copy),
// plus a lightweight look at the next 7 days and what already went out today.
app.get('/api/attract/today', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') cache.delete('marketing-today');
    const data = await cached('marketing-today', async () => {
      const channelMap = await fetchMarketingChannelMap();
      const today = chicagoTodayISODate();
      const backBound = chicagoDateNDaysAgo(30);   // overdue up to 30d back
      const weekEnd = chicagoDateNDaysAgo(-7);      // 7 days ahead
      const r = await notion.dataSources.query({
        data_source_id: MARKETING_ASSETS_DS,
        filter: { and: [
          { property: 'Publish Date', date: { on_or_after: backBound } },
          { property: 'Publish Date', date: { on_or_before: weekEnd } },
        ] },
        sorts: [{ property: 'Publish Date', direction: 'ascending' }],
        page_size: 100,
      });
      const assets = r.results.map((pg) => serializeMarketingAsset(pg, channelMap));
      const overdue = [], dueToday = [], thisWeek = [], publishedToday = [];
      for (const a of assets) {
        const d = a.publishDate;
        if (a.status === 'Published') { if (d === today) publishedToday.push(a); continue; }
        if (d < today) overdue.push(a);
        else if (d === today) dueToday.push(a);
        else thisWeek.push(a);
      }
      // Fetch copy only for the actionable queue (overdue + today) to keep it fast.
      await Promise.all([...overdue, ...dueToday].map(async (a) => { a.copy = await fetchMarketingCopy(a.id); }));
      return { today, overdue, dueToday, thisWeek, publishedToday };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/attract/stats — OKR-shaped output: published counts for the
// quarter / month / year, plus a per-channel breakdown for the quarter.
app.get('/api/attract/stats', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') cache.delete('marketing-stats');
    const data = await cached('marketing-stats', async () => {
      const channelMap = await fetchMarketingChannelMap();
      const today = chicagoTodayISODate();
      const q = currentQuarter();
      const yearStart = today.slice(0, 4) + '-01-01';
      const monthStart = today.slice(0, 7) + '-01';
      // Pull everything published since the start of the year (covers all 3 windows).
      const pages = [];
      let cursor;
      do {
        const r = await notion.dataSources.query({
          data_source_id: MARKETING_ASSETS_DS,
          filter: { and: [
            { property: 'Status', status: { equals: 'Published' } },
            { property: 'Publish Date', date: { on_or_after: yearStart } },
          ] },
          page_size: 100,
          start_cursor: cursor,
        });
        pages.push(...r.results);
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      const assets = pages.map((pg) => serializeMarketingAsset(pg, channelMap));
      let publishedYear = 0, publishedQuarter = 0, publishedMonth = 0;
      const channelTally = {};
      const channelPlatform = {};
      for (const a of assets) {
        const d = a.publishDate; if (!d) continue;
        publishedYear++;
        if (d >= monthStart && d <= today) publishedMonth++;
        if (d >= q.start && d <= q.end) {
          publishedQuarter++;
          // Tally where it went (targeted channels ∪ channels with a live URL).
          for (const c of a.channels) { channelTally[c.name] = (channelTally[c.name] || 0) + 1; channelPlatform[c.name] = c.platform; }
        }
      }
      const byChannel = Object.entries(channelTally)
        .map(([name, count]) => ({ name, count, platform: channelPlatform[name] || 'other' }))
        .sort((a, b) => b.count - a.count);
      return { quarterLabel: q.label, publishedQuarter, publishedMonth, publishedYear, byChannel };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/attract/calendar?month=YYYY-MM — lightweight month grid data.
app.get('/api/attract/calendar', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : chicagoTodayISODate().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const start = `${month}-01`;
    const end = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    const cacheKey = `marketing-cal-${month}`;
    if (req.query.fresh === '1') cache.delete(cacheKey);
    const data = await cached(cacheKey, async () => {
      const channelMap = await fetchMarketingChannelMap();
      const out = [];
      let cursor;
      do {
        const r = await notion.dataSources.query({
          data_source_id: MARKETING_ASSETS_DS,
          filter: { and: [
            { property: 'Publish Date', date: { on_or_after: start } },
            { property: 'Publish Date', date: { on_or_before: end } },
          ] },
          sorts: [{ property: 'Publish Date', direction: 'ascending' }],
          page_size: 100,
          start_cursor: cursor,
        });
        for (const pg of r.results) {
          const a = serializeMarketingAsset(pg, channelMap);
          out.push({ id: a.id, url: a.url, name: a.name, status: a.status, publishDate: a.publishDate, formats: a.formats, contentType: a.contentType, hasMedia: a.media.length > 0 });
        }
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      const days = {};
      for (const a of out) { if (!a.publishDate) continue; (days[a.publishDate] = days[a.publishDate] || []).push(a); }
      return { month, days };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/attract/asset/:id — a single asset with full copy (lazy detail).
app.get('/api/attract/asset/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const channelMap = await fetchMarketingChannelMap();
    const page = await notion.pages.retrieve({ page_id: dashifyId(req.params.id) });
    const asset = serializeMarketingAsset(page, channelMap);
    asset.copy = await fetchMarketingCopy(page.id);
    res.json({ asset });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/attract/asset/:id — update status, publish date, per-channel URLs.
app.patch('/api/attract/asset/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { status, publishDate, channelUrls } = req.body || {};
  try {
    const properties = {};
    if (status !== undefined && status !== null) properties.Status = { status: { name: status } };
    if (publishDate !== undefined) properties['Publish Date'] = publishDate ? { date: { start: publishDate } } : { date: null };
    for (const [field, url] of Object.entries(channelUrls || {})) {
      if (MARKETING_CHANNEL_FIELDS.includes(field)) properties[field] = { url: url ? String(url) : null };
    }
    if (!Object.keys(properties).length) return res.status(400).json({ error: 'no supported fields to update' });
    await notion.pages.update({ page_id: dashifyId(req.params.id), properties });
    invalidateMarketingCaches();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/attract/media?asset=<id>&idx=<n>[&dl=1] — proxy a Media file so it
// never 404s on an expired signed URL and can be force-downloaded.
app.get('/api/attract/media', async (req, res) => {
  if (!notion) return res.status(500).end('no notion');
  try {
    const idx = parseInt(req.query.idx || '0', 10);
    const page = await notion.pages.retrieve({ page_id: dashifyId(req.query.asset || '') });
    const files = page.properties?.Media?.files || [];
    const f = files[idx];
    if (!f) return res.status(404).end('not found');
    const url = f.type === 'external' ? f.external?.url : f.file?.url;
    if (!url) return res.status(404).end('no url');
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).end('upstream failed');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    const name = (f.name || 'download').replace(/["\r\n]/g, '');
    res.setHeader('Content-Disposition', `${req.query.dl === '1' ? 'attachment' : 'inline'}; filename="${name}"`);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) { res.status(500).end(err.message); }
});

  // GET /api/attract/insights — GA4 "what's working" across both properties + AI suggestions.
  app.get('/api/attract/insights', async (req, res) => {
    try {
      if (!gaConfigured()) return res.json({ configured: false, properties: [], suggestions: [] });
      if (req.query.fresh === '1') {
        const u = userContext.getStore()?.user;
        cache.delete(u ? `attract-insights::${u.id || u.email}` : 'attract-insights');
      }
      const data = await cached('attract-insights', async () => {
        const properties = await whatsWorkingAll();
        const ok = properties.filter((p) => !p.error);
        let suggestions = [];
        if (anthropic && ok.length) {
          try {
            const tp = (n) => (n == null ? 'n/a' : (n >= 0 ? '+' : '') + n + '%');
            const summary = ok.map((p) => {
              const pages = p.topPages.slice(0, 5).map((x) => `${x.path} (${x.sessions} sessions, ${x.keyEvents} conv)`).join('; ');
              const chans = p.channels.slice(0, 6).map((x) => `${x.name} (${x.sessions} sessions, ${x.keyEvents} conv)`).join('; ');
              return `PROPERTY "${p.label}" — last 28d vs prior 28d: ${p.totals.sessions} sessions (${tp(p.trend.sessions)}), ${p.totals.users} users, ${p.totals.keyEvents} conversions (${tp(p.trend.keyEvents)}).\n  Top pages: ${pages}\n  Channels: ${chans}`;
            }).join('\n\n');
            const noConv = ok.every((p) => p.totals.keyEvents === 0);
            const prompt = `You are the marketing analyst for Left Right Labs (a brand + website design agency). Google Analytics, last 28 days vs the prior 28, for two web properties (the main site and the "Toolkit" that hosts lead-gen opt-in funnels):\n\n${summary}\n\nGive 3-5 short, specific, action-oriented insights — each ONE sentence, grounded in these exact numbers (name the page, channel, or property). Focus on what is driving growth and leads and what to do next.${noConv ? ' IMPORTANT: conversions/key events are not set up in GA4 yet (all show 0), so base insights on traffic + engagement, and make ONE insight recommend marking the opt-in completions as Key Events in GA4 so lead conversions can be tracked.' : ''} Reply with ONLY a JSON array of strings, nothing else.`;
            const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: prompt }] });
            const text = (msg.content?.[0]?.text) || '[]';
            const mm = text.match(/\[[\s\S]*\]/);
            if (mm) suggestions = JSON.parse(mm[0]);
          } catch (e) { console.error('attract-insights ai:', e.message); }
        }
        return { asOf: new Date().toISOString(), properties, suggestions };
      });
      res.json({ configured: true, ...data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return { MARKETING_ASSETS_DS, fetchMarketingChannelMap, serializeMarketingAsset };
}
