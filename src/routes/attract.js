import { whatsWorkingAll, gaConfigured } from '../providers/google/analytics.js';
import { ytWhatsWorking, ytConfigured } from '../providers/google/youtube.js';

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
    assigned: (p.Assigned?.people || []).map((u) => ({ id: u.id, name: u.name })),
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
      // Trimmed shape for the stat-card drill-down lists (and future "me" filtering).
      const trim = (a) => ({ id: a.id, name: a.name, publishDate: a.publishDate, status: a.status, url: a.url, assigned: a.assigned || [] });
      let publishedYear = 0, publishedQuarter = 0, publishedMonth = 0;
      const yearAssets = [], quarterAssets = [], monthAssets = [];
      const channelTally = {};
      const channelPlatform = {};
      for (const a of assets) {
        const d = a.publishDate; if (!d) continue;
        publishedYear++; yearAssets.push(trim(a));
        if (d >= monthStart && d <= today) { publishedMonth++; monthAssets.push(trim(a)); }
        if (d >= q.start && d <= q.end) {
          publishedQuarter++; quarterAssets.push(trim(a));
          // Tally where it went (targeted channels ∪ channels with a live URL).
          for (const c of a.channels) { channelTally[c.name] = (channelTally[c.name] || 0) + 1; channelPlatform[c.name] = c.platform; }
        }
      }
      // Most-recent first for the drill-down lists.
      for (const l of [yearAssets, quarterAssets, monthAssets]) l.sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || ''));
      const byChannel = Object.entries(channelTally)
        .map(([name, count]) => ({ name, count, platform: channelPlatform[name] || 'other' }))
        .sort((a, b) => b.count - a.count);
      return { quarterLabel: q.label, publishedQuarter, publishedMonth, publishedYear, byChannel, quarterAssets, monthAssets, yearAssets };
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
          out.push({ id: a.id, url: a.url, name: a.name, status: a.status, publishDate: a.publishDate, formats: a.formats, contentType: a.contentType, hasMedia: a.media.length > 0, assigned: a.assigned });
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

  // GET /api/attract/insights — GA4 web + YouTube "what's working" + AI suggestions.
  app.get('/api/attract/insights', async (req, res) => {
    try {
      if (!gaConfigured() && !ytConfigured()) return res.json({ configured: false, properties: [], youtube: null, suggestions: [] });
      if (req.query.fresh === '1') {
        const u = userContext.getStore()?.user;
        cache.delete(u ? `attract-insights::${u.id || u.email}` : 'attract-insights');
      }
      const data = await cached('attract-insights', async () => {
        const [properties, youtube] = await Promise.all([
          gaConfigured() ? whatsWorkingAll() : Promise.resolve([]),
          ytConfigured() ? ytWhatsWorking().catch((e) => ({ label: 'YouTube', error: (e.message || String(e)).slice(0, 200) })) : Promise.resolve(null),
        ]);
        const okGa = properties.filter((p) => !p.error);
        const okYt = youtube && !youtube.error ? youtube : null;
        let suggestions = [];
        if (anthropic && (okGa.length || okYt)) {
          try {
            const tp = (n) => (n == null ? 'n/a' : (n >= 0 ? '+' : '') + n + '%');
            const gaSummary = okGa.map((p) => {
              const pages = p.topPages.slice(0, 5).map((x) => `${x.path} (${x.sessions} sessions, ${x.keyEvents} conv)`).join('; ');
              const chans = p.channels.slice(0, 6).map((x) => `${x.name} (${x.sessions} sessions, ${x.keyEvents} conv)`).join('; ');
              return `WEB PROPERTY "${p.label}" — last 28d vs prior 28d: ${p.totals.sessions} sessions (${tp(p.trend.sessions)}), ${p.totals.users} users, ${p.totals.keyEvents} conversions (${tp(p.trend.keyEvents)}).\n  Top pages: ${pages}\n  Channels: ${chans}`;
            }).join('\n\n');
            const ytSummary = okYt ? `YOUTUBE CHANNEL "${okYt.channelTitle}" — ${okYt.subscribers} subscribers, ${okYt.videoCount} videos, ${okYt.totalViews} lifetime views, recent uploads average ${okYt.recentAvgViews} views.\n  Top recent videos: ${okYt.topVideos.map((v) => `"${v.title}" (${v.views} views, ${v.likes} likes, ${v.comments} comments)`).join('; ')}` : '';
            const summary = [gaSummary, ytSummary].filter(Boolean).join('\n\n');
            const noConv = okGa.length && okGa.every((p) => p.totals.keyEvents === 0);
            const prompt = `You are the marketing analyst for Left Right Labs (a brand + website design agency). Below is the last 28 days of data across web (Google Analytics: the main site + the "Toolkit" lead-gen funnels) and YouTube.\n\n${summary}\n\nGive 4-6 short, specific, action-oriented insights — each ONE sentence, grounded in these exact numbers (name the page, channel, video, or property). Balance the insights roughly evenly across web (GA) and YouTube: include at least two web/GA insights and at least two YouTube insights.${noConv ? ' Also: GA4 conversions/key events are not set up yet (web conversions show 0), so make ONE insight recommend marking the opt-in completions as Key Events in GA4.' : ''} Reply with ONLY a JSON array of strings, nothing else.`;
            const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] });
            const text = (msg.content?.[0]?.text) || '[]';
            const mm = text.match(/\[[\s\S]*\]/);
            if (mm) suggestions = JSON.parse(mm[0]);
          } catch (e) { console.error('attract-insights ai:', e.message); }
        }
        return { asOf: new Date().toISOString(), properties, youtube, suggestions };
      });
      res.json({ configured: true, ...data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── ISO-week math on YYYY-MM-DD strings (UTC-noon to dodge TZ drift) ──
  const _monday = (iso) => { const [y,m,d]=iso.split('-').map(Number); const dt=new Date(Date.UTC(y,m-1,d,12)); dt.setUTCDate(dt.getUTCDate()-((dt.getUTCDay()+6)%7)); return dt; };
  const _ymd = (dt) => dt.toISOString().slice(0,10);
  const _add = (dt,n) => { const x=new Date(dt); x.setUTCDate(x.getUTCDate()+n); return x; };
  const _dow = (iso) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(iso+'T12:00:00Z').getUTCDay()];
  const _mon = (iso) => new Date(iso+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
  const PUB='Published', SCHED='Scheduled';
  const _ready = (s) => s===SCHED || s===PUB;
  const _plat  = (a) => (a.channels?.[0]?.platform) || marketingPlatform(a.name);
  const _platLabel = { linkedin:'LinkedIn', instagram:'Instagram', facebook:'Facebook', youtube:'YouTube', email:'Email', blog:'Blog', other:'Post' };
  const _slotState = (a, today) => a.status===PUB ? 'done' : (a.publishDate && a.publishDate < today) ? 'overdue' : a.status===SCHED ? 'scheduled' : 'needs-copy';

  // GET /api/attract — full page payload (weekly pulse, featured post, queue,
  // 6-week runway, ahead-of-schedule, pageState) derived live from MARKETING
  // ASSETS. In-memory cached (15 min) like the rest of this domain — no DB cache.
  async function buildAttractPayload() {
        const channelMap = await fetchMarketingChannelMap();
        const today = chicagoTodayISODate();
        const wk = _monday(today);
        const rangeStart = _ymd(_add(wk, -28));   // 4 wks back (overdue context)
        const rangeEnd   = _ymd(_add(wk, 41));     // 6 wks ahead (incl. this week)
        const pages = []; let cursor;
        do {
          const r = await notion.dataSources.query({ data_source_id: MARKETING_ASSETS_DS, filter: { and: [
            { property: 'Publish Date', date: { on_or_after: rangeStart } },
            { property: 'Publish Date', date: { on_or_before: rangeEnd } },
          ] }, sorts: [{ property: 'Publish Date', direction: 'ascending' }], page_size: 100, start_cursor: cursor });
          pages.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
        } while (cursor);
        const assets = pages.map((pg) => serializeMarketingAsset(pg, channelMap)).filter((a) => a.publishDate);

        const weekStart = _ymd(wk), weekEnd = _ymd(_add(wk, 6));
        const thisWeek = assets.filter((a) => a.publishDate >= weekStart && a.publishDate <= weekEnd);
        const postedThisWeek = thisWeek.filter((a) => a.status === PUB).length;

        // Weekly pulse slots (this week, chronological)
        const slots = thisWeek.slice().sort((a, b) => a.publishDate.localeCompare(b.publishDate))
          .map((a) => ({ title: a.name, channel: _platLabel[_plat(a)] || 'Post', day: _dow(a.publishDate), state: _slotState(a, today), url: a.url }));

        // 6-week runway coverage
        const runwayWeeks = [];
        for (let i = 0; i < 6; i++) {
          const s = _ymd(_add(wk, i * 7)), e = _ymd(_add(wk, i * 7 + 6));
          const wa = assets.filter((a) => a.publishDate >= s && a.publishDate <= e);
          const ready = wa.filter((a) => _ready(a.status)).length;
          runwayWeeks.push({ label: `${_mon(s)}–${_mon(e)}`, weekStart: s, isThisWeek: i === 0,
            planned: wa.length, ready, covered: ready >= 3,
            slots: wa.slice(0, 3).map((a) => ({ state: _slotState(a, today), channel: _plat(a), day: _dow(a.publishDate), title: a.name })) });
        }
        const weeksCovered = runwayWeeks.filter((w) => w.covered).length;
        const runwayStatus = weeksCovered >= 4 ? 'good' : weeksCovered >= 2 ? 'warn' : 'bad';

        // Featured post: overdue → due today → due this week → needs copy
        const open = assets.filter((a) => a.status !== PUB);
        const featuredAsset =
          open.filter((a) => a.publishDate < today).sort((a, b) => a.publishDate.localeCompare(b.publishDate))[0] ||
          open.filter((a) => a.publishDate === today)[0] ||
          open.filter((a) => a.publishDate > today && a.publishDate <= weekEnd).sort((a, b) => a.publishDate.localeCompare(b.publishDate))[0] ||
          open.filter((a) => a.status === 'Drafting' || a.status === 'Review')[0] || open[0] || null;

        const toFeatured = async (a) => {
          if (!a) return null;
          const copy = await fetchMarketingCopy(a.id).catch(() => []);
          const od = a.publishDate < today, isToday = a.publishDate === today, sched = a.status === SCHED;
          const daysOver = od ? Math.round((Date.parse(today) - Date.parse(a.publishDate)) / 86400000) : 0;
          return {
            id: a.id, url: a.url, title: a.name,
            series: a.primaryTopic || a.contentType || 'Marketing',
            channel: _platLabel[_plat(a)] || 'Post',
            tags: [_platLabel[_plat(a)] || 'Post', ...(a.formats || []).slice(0, 1), a.primaryTopic].filter(Boolean),
            urgency: od ? 'red' : (a.status === 'Drafting' || a.status === 'Review') ? 'amber' : sched ? 'green' : 'purple',
            statusClass: od ? 'overdue' : sched ? 'scheduled' : 'needs-copy',
            statusText: od ? `Overdue · ${daysOver} day${daysOver === 1 ? '' : 's'}` : isToday ? 'Due today' : sched ? `Scheduled · ${_mon(a.publishDate)}` : a.status,
            caption: (copy.find((s) => s.text)?.text) || a.notes || '',
            image: (a.media || []).length === 0,
            goal: a.primaryTopic ? `Campaign · ${a.primaryTopic}` : null,
          };
        };
        const featuredPost = await toFeatured(featuredAsset);

        // Queue: this week, open, excluding the featured post (priority order)
        const order = { overdue: 0, 'needs-copy': 1, scheduled: 2, done: 3 };
        const queue = thisWeek.filter((a) => a.status !== PUB && (!featuredAsset || a.id !== featuredAsset.id))
          .map((a) => ({ id: a.id, url: a.url, title: a.name, channel: _platLabel[_plat(a)] || 'Post',
            state: _slotState(a, today), statusText: a.status === SCHED ? `Scheduled · ${_mon(a.publishDate)}` : a.status,
            caption: '', tags: [_platLabel[_plat(a)] || 'Post', a.primaryTopic].filter(Boolean) }))
          .sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));

        // Ahead-of-schedule: next 3 scheduled, in the future
        const aheadPosts = assets.filter((a) => a.status === SCHED && a.publishDate > today)
          .sort((a, b) => a.publishDate.localeCompare(b.publishDate)).slice(0, 3)
          .map((a) => ({ id: a.id, url: a.url, title: a.name, day: _dow(a.publishDate), date: _mon(a.publishDate).toUpperCase(),
            channel: _platLabel[_plat(a)] || 'Post', platform: _plat(a), meta: [a.primaryTopic, a.contentType].filter(Boolean).join(' · ') }));

        const pageState = (postedThisWeek >= 3 && weeksCovered >= 4) ? 'healthy' : postedThisWeek > 0 ? 'in-progress' : 'stressed';

        return {
          asOf: new Date().toISOString(), pageState,
          weeklyPulse: { weekLabel: `${_mon(weekStart)}–${_mon(weekEnd)}`, slots, postedCount: postedThisWeek, targetCount: 3,
            runway: { weeksCovered, totalWeeks: 6, gaugePct: Math.round((weeksCovered / 6) * 100), status: runwayStatus } },
          featuredPost, queue, runwayWeeks, aheadPosts,
        };
  }

  app.get('/api/attract', async (req, res) => {
    if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
    try {
      if (req.query.fresh === '1') cache.delete('attract-page');
      res.json(await cached('attract-page', buildAttractPayload));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── POST ACTIONS (Phase 4) — write to Notion, bust caches, return fresh payload ──
  const _refreshAttract = () => { cache.delete('attract-page'); invalidateMarketingCaches(); };

  // PATCH /api/attract/posts/:id/publish — mark the asset Published.
  app.patch('/api/attract/posts/:id/publish', async (req, res) => {
    if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
    try {
      await notion.pages.update({ page_id: dashifyId(req.params.id), properties: { Status: { status: { name: 'Published' } } } });
      _refreshAttract();
      res.json(await buildAttractPayload());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/attract/posts/:id/snooze — push the Publish Date to tomorrow.
  app.post('/api/attract/posts/:id/snooze', async (req, res) => {
    if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
    try {
      await notion.pages.update({ page_id: dashifyId(req.params.id), properties: { 'Publish Date': { date: { start: chicagoDateNDaysAgo(-1) } } } });
      _refreshAttract();
      res.json(await buildAttractPayload());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── AI features (Phase 6) ──
  const DRAFT_PROMPTS = {
    linkedin: 'Write a full LinkedIn post in Left Right Labs\' voice (confident, plain-spoken, anti-hype). End with ONE comment-trigger CTA.',
    youtube: 'Write a YouTube video outline: a strong 10-second hook, 4–6 section beats, and 3 thumbnail-text options.',
    instagram: 'Write an Instagram caption plus a 3-beat Reel hook (or a 5-slide carousel outline). Punchy, scroll-stopping.',
    email: 'Write 3 subject-line options, a short email body, and ONE clear CTA (give the button text).',
    facebook: 'Write a Facebook boost brief: audience targeting, suggested budget + duration, the goal, and the post angle.',
    other: 'Write social copy in Left Right Labs\' voice with one clear CTA.',
  };

  // POST /api/attract/draft — generate channel-specific copy with Claude.
  app.post('/api/attract/draft', async (req, res) => {
    if (!anthropic) return res.status(503).json({ error: 'AI not configured' });
    const { channel = 'other', title = '', series = '', goal = '' } = req.body || {};
    const instr = DRAFT_PROMPTS[(channel || 'other').toLowerCase()] || DRAFT_PROMPTS.other;
    try {
      const prompt = `You are the content writer for Left Right Labs, a brand + website design agency. ${instr}\n\nContext:\n- Channel: ${channel}\n- Working title / idea: ${title || '(none given)'}\n- Series: ${series || '(standalone)'}\n- Goal it serves: ${goal || '(general awareness)'}\n\nWrite the draft now — tight and ready to edit. No preamble, just the content.`;
      const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 900, messages: [{ role: 'user', content: prompt }] });
      res.json({ channel, title, draft: (msg.content?.[0]?.text || '').trim() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/attract/next-focus — one-line "what to focus on next" for the
  // healthy state. Cached (AI cost); returns { focus: null } if AI is off.
  app.get('/api/attract/next-focus', async (req, res) => {
    if (!anthropic) return res.json({ focus: null });
    try {
      if (req.query.fresh === '1') cache.delete('attract-next-focus');
      const data = await cached('attract-next-focus', async () => {
        const p = await cached('attract-page', buildAttractPayload);
        const prompt = `You are the marketing strategist for Left Right Labs. This week's content is fully published and the runway is healthy (${p.weeklyPulse.runway.weeksCovered} of 6 weeks covered). In ONE sentence (max 22 words), name the single highest-leverage thing to focus on next week to keep momentum. No preamble.`;
        const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 120, messages: [{ role: 'user', content: prompt }] });
        return { focus: (msg.content?.[0]?.text || '').trim() || null };
      });
      res.json(data);
    } catch (err) { res.json({ focus: null }); }
  });

  // GET /api/attract/channels/:channel/refresh — bust the channel-insights
  // cache so the next /api/attract/insights pull is fresh from the live APIs.
  app.get('/api/attract/channels/:channel/refresh', async (req, res) => {
    try {
      const u = userContext.getStore()?.user;
      cache.delete('attract-insights');
      if (u) cache.delete(`attract-insights::${u.id || u.email}`);
      res.json({ ok: true, channel: req.params.channel });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return { MARKETING_ASSETS_DS, fetchMarketingChannelMap, serializeMarketingAsset };
}
