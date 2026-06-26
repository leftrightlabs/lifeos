import { SALES_STAGES, SALES_STAGE_GROUP, CONTACTS_DS, SALES_ACTIVITY_DS, TRINA_USER_ID, PULSE_RELATIONSHIPS, PULSE_TOUCHPOINTS, PULSE_GOAL, SALES_GOAL, CONVERT_FOLLOWUP_STAGES } from '../config/convert.js';
import { serializeDeal, serializeContactRow, queryAllDeals, fetchSalesProductMap } from '../providers/notion/convert.js';

export function registerConvertRoutes(app, ctx) {
  const { notion, cache, cached, userContext, currentQuarter, chicagoToday, chicagoTodayISODate, fetchVtoGoals, dashifyId, GRETCHEN_USER_ID, currentNotionUserId, computeXeroFinance, computeXeroQuotes, computeRecurringAvg, anthropic } = ctx;


// GET /api/convert/pipeline — open deals grouped by stage + headline metrics.
app.get('/api/convert/pipeline', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') cache.delete('sales-pipeline');
    const data = await cached('sales-pipeline', async () => {
      const productMap = await fetchSalesProductMap(notion, cached).catch(() => ({}));
      const pages = await queryAllDeals(notion);
      const deals = pages.map((pg) => serializeDeal(pg, productMap)).filter((d) => !d.archived);
      const q = currentQuarter();
      const openStages = SALES_STAGES.filter((s) => s.group === 'open');
      const stages = openStages.map((s) => ({ name: s.name, deals: [], count: 0, value: 0 }));
      const byName = Object.fromEntries(stages.map((s) => [s.name, s]));
      let openCount = 0, openValue = 0;
      const won = { count: 0, value: 0 }, lost = { count: 0 };
      const recentWins = [];
      for (const d of deals) {
        const grp = SALES_STAGE_GROUP[d.status] || 'open';
        if (grp === 'open') {
          const bucket = byName[d.status] || byName['New / To Qualify'];
          if (bucket) { bucket.deals.push(d); bucket.count++; bucket.value += d.value || 0; }
          openCount++; openValue += d.value || 0;
        } else if (grp === 'won') {
          if (d.dateWon && d.dateWon >= q.start && d.dateWon <= q.end) { won.count++; won.value += d.value || 0; }
          recentWins.push(d);
        } else if (grp === 'lost') {
          if (d.dateLost && d.dateLost >= q.start && d.dateLost <= q.end) lost.count++;
        }
      }
      recentWins.sort((a, b) => (b.dateWon || '').localeCompare(a.dateWon || ''));
      const decided = won.count + lost.count;
      return {
        stages: stages.filter((s) => s.count > 0),
        openCount, openValue,
        won, lost,
        winRate: decided ? Math.round((won.count / decided) * 100) : null,
        quarterLabel: q.label,
        recentWins: recentWins.slice(0, 12),
      };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/convert/deal/:id — full single deal incl. the Recon brief.
app.get('/api/convert/deal/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const productMap = await fetchSalesProductMap(notion, cached).catch(() => ({}));
    const page = await notion.pages.retrieve({ page_id: dashifyId(req.params.id) });
    res.json({ deal: serializeDeal(page, productMap, { includeRecon: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/convert/deal/:id — move stage, edit value, mark won/lost.
app.patch('/api/convert/deal/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { status, value, dateWon, dateLost } = req.body || {};
  try {
    const properties = {};
    if (status !== undefined && status !== null) {
      properties['Pipeline Status'] = { status: { name: status } };
      // Stamp the win/loss date automatically when entering a closed stage.
      if (status === 'Closed Won' && dateWon === undefined) properties['Date Won'] = { date: { start: chicagoTodayISODate() } };
      if (status === 'Closed Lost' && dateLost === undefined) properties['Date Lost'] = { date: { start: chicagoTodayISODate() } };
    }
    if (value !== undefined) properties['Deal Value'] = { number: value === null || value === '' ? null : Number(value) };
    if (dateWon !== undefined) properties['Date Won'] = dateWon ? { date: { start: dateWon } } : { date: null };
    if (dateLost !== undefined) properties['Date Lost'] = dateLost ? { date: { start: dateLost } } : { date: null };
    if (!Object.keys(properties).length) return res.status(400).json({ error: 'no supported fields to update' });
    await notion.pages.update({ page_id: dashifyId(req.params.id), properties });
    cache.delete('sales-pipeline');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Plain UTC date math on YYYY-MM-DD strings (all values here are date-only).
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekStartISO(iso) {
  // Monday of the week containing iso.
  const d = new Date(iso + 'T00:00:00Z');
  const back = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return addDaysISO(iso, -back);
}


// GET /api/convert/overdue — active-relationship contacts, never/oldest touched first.
app.get('/api/convert/overdue', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    // Optional ?rel= filters to a single relationship (else all four).
    const rel = PULSE_RELATIONSHIPS.includes(req.query.rel) ? req.query.rel : null;
    const cacheKey = rel ? `sales-overdue-${rel}` : 'sales-overdue';
    if (req.query.fresh === '1') cache.delete(cacheKey);
    const data = await cached(cacheKey, async () => {
      // Two bounded, parallel queries instead of paginating the whole (800+)
      // contact list — never-touched, plus oldest-touched (Notion-sorted). This
      // surfaces exactly the most-overdue without the multi-second full sweep.
      const relFilter = rel
        ? { property: 'Relationship', select: { equals: rel } }
        : { or: PULSE_RELATIONSHIPS.map((name) => ({ property: 'Relationship', select: { equals: name } })) };
      const baseAnd = (extra) => ({ and: [ { property: 'Archive', checkbox: { equals: false } }, relFilter, extra ] });
      const [neverRes, touchedRes] = await Promise.all([
        notion.dataSources.query({ data_source_id: CONTACTS_DS, filter: baseAnd({ property: 'Last Touched', date: { is_empty: true } }), page_size: 100 }),
        notion.dataSources.query({ data_source_id: CONTACTS_DS, filter: baseAnd({ property: 'Last Touched', date: { is_not_empty: true } }), sorts: [{ property: 'Last Touched', direction: 'ascending' }], page_size: 60 }),
      ]);
      const today = chicagoTodayISODate();
      const out = [...neverRes.results, ...touchedRes.results].map(serializeContactRow);
      out.forEach((c) => { c.daysSince = c.lastTouched ? Math.max(0, Math.round((new Date(today) - new Date(c.lastTouched)) / 864e5)) : null; });
      // Never-touched first (alphabetical), then oldest-touched first.
      out.sort((a, b) => {
        if (!a.lastTouched && !b.lastTouched) return a.name.localeCompare(b.name);
        if (!a.lastTouched) return -1;
        if (!b.lastTouched) return 1;
        return a.lastTouched.localeCompare(b.lastTouched);
      });
      return { contacts: out, total: out.length, more: neverRes.has_more || touchedRes.has_more };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET /api/convert/act — the Convert zone "Act" layer: gap-to-quarter, the deals
// that would close it, stage-aware follow-ups due, and stale deals to prune.
// Composes the existing pipeline + VTO revenue goal + Contacts (now incl. Stage);
// wires no new Notion databases.
app.get('/api/convert/act', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') {
      const u = userContext.getStore()?.user;
      cache.delete(u ? `convert-act::${u.id || u.email}` : 'convert-act');
    }
    const data = await cached('convert-act', async () => {
      const LATE = new Set(['Consult Completed', 'Build Scope', 'Decision Pending']);
      const q = currentQuarter();
      const productMap = await fetchSalesProductMap(notion, cached).catch(() => ({}));
      const deals = (await queryAllDeals(notion)).map((pg) => serializeDeal(pg, productMap)).filter((d) => !d.archived);

      let booked = 0, openValue = 0, openCount = 0;
      const late = [], onHold = [];
      for (const d of deals) {
        const grp = SALES_STAGE_GROUP[d.status] || 'open';
        if (grp === 'won') { if (d.dateWon && d.dateWon >= q.start && d.dateWon <= q.end) booked += d.value || 0; continue; }
        if (grp === 'lost') continue;
        openCount++; openValue += d.value || 0;
        if (LATE.has(d.status)) late.push(d);
        if (d.status === 'On Hold') onHold.push(d);
      }
      late.sort((a, b) => (b.value || 0) - (a.value || 0));
      onHold.sort((a, b) => (a.created || '').localeCompare(b.created || ''));

      // Quarterly revenue goal = VTO "Revenue" monthly goal × 3 (mirrors periodGoals.qtd).
      const goals = await fetchVtoGoals().catch(() => ({}));
      const monthlyRev = goals.revenue?.goal ?? null;
      const goal = monthlyRev != null ? monthlyRev * 3 : null;
      const remaining = goal != null ? Math.max(0, goal - booked) : null;

      // Stage-aware follow-ups: active-conversation contacts, most-overdue first.
      let followups = [];
      try {
        const r = await notion.dataSources.query({
          data_source_id: CONTACTS_DS,
          filter: { and: [
            { property: 'Archive', checkbox: { equals: false } },
            { or: CONVERT_FOLLOWUP_STAGES.map((s) => ({ property: 'Stage', select: { equals: s } })) },
          ] },
          sorts: [{ property: 'Last Touched', direction: 'ascending' }],
          page_size: 40,
        });
        const todayMs = Date.parse(chicagoTodayISODate() + 'T00:00:00Z');
        followups = r.results.map(serializeContactRow).map((c) => ({
          ...c,
          daysSince: c.lastTouched ? Math.max(0, Math.round((todayMs - Date.parse(c.lastTouched + 'T00:00:00Z')) / 864e5)) : null,
        }));
        followups.sort((a, b) => {
          if (!a.lastTouched && !b.lastTouched) return 0;
          if (!a.lastTouched) return -1; if (!b.lastTouched) return 1;
          return a.lastTouched.localeCompare(b.lastTouched);
        });
      } catch (e) { console.error('convert:followups', e.message); }

      return {
        quarterLabel: q.label,
        gap: { goal, booked, remaining, pct: goal ? Math.min(1, booked / goal) : null },
        closeTheGap: late.slice(0, 6).map((d) => ({ id: d.id, name: d.name, value: d.value, status: d.status, url: d.url })),
        followups: followups.slice(0, 8),
        prune: onHold.slice(0, 6).map((d) => ({ id: d.id, name: d.name, value: d.value, status: d.status, url: d.url })),
        openValue, openCount,
      };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/convert/pulse — this-week pulse vs sales counts, goals, and weekly streak.
app.get('/api/convert/pulse', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') cache.delete('sales-pulse');
    const data = await cached('sales-pulse', async () => {
      const today = chicagoTodayISODate();
      const curMon = weekStartISO(today);
      const sinceMon = addDaysISO(curMon, -7 * 26); // ~26 weeks of history for the streak
      const rows = [];
      let cursor;
      do {
        const r = await notion.dataSources.query({
          data_source_id: SALES_ACTIVITY_DS,
          filter: { property: 'Timestamp', date: { on_or_after: sinceMon } },
          page_size: 100,
          start_cursor: cursor,
        });
        for (const pg of r.results) {
          const ts = pg.properties?.Timestamp?.date?.start;
          const type = pg.properties?.['Touchpoint Type']?.select?.name || '';
          if (ts) { const d = ts.slice(0, 10); rows.push({ date: d, week: weekStartISO(d), isPulse: PULSE_TOUCHPOINTS.includes(type) }); }
        }
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      // Tally per week + month-to-date / quarter-to-date accumulation.
      const wk = {};
      const q = currentQuarter();
      const monthStart = today.slice(0, 7) + '-01';
      const month = { pulse: 0, sales: 0 }, quarter = { pulse: 0, sales: 0 };
      for (const r of rows) {
        const w = (wk[r.week] = wk[r.week] || { pulse: 0, sales: 0 }); if (r.isPulse) w.pulse++; else w.sales++;
        if (r.date >= monthStart && r.date <= today) { if (r.isPulse) month.pulse++; else month.sales++; }
        if (r.date >= q.start && r.date <= today) { if (r.isPulse) quarter.pulse++; else quarter.sales++; }
      }
      const cur = wk[curMon] || { pulse: 0, sales: 0 };
      // Streak: count consecutive met weeks ending at the current week. A current
      // week that hasn't hit goal yet doesn't break the streak (it's in progress).
      let streak = 0, wkCursor = curMon, first = true;
      for (let i = 0; i < 60; i++) {
        const c = wk[wkCursor] || { pulse: 0, sales: 0 };
        const met = c.sales >= SALES_GOAL;
        if (met) streak++;
        else if (first) { /* current week not yet met — skip, don't break */ }
        else break;
        first = false;
        wkCursor = addDaysISO(wkCursor, -7);
      }
      return {
        pulse: cur.pulse, pulseGoal: PULSE_GOAL,
        sales: cur.sales, salesGoal: SALES_GOAL,
        streak, weekStart: curMon, weekEnd: addDaysISO(curMon, 6),
        month: { total: month.pulse + month.sales, pulse: month.pulse, sales: month.sales },
        quarter: { total: quarter.pulse + quarter.sales, pulse: quarter.pulse, sales: quarter.sales },
        quarterLabel: q.label,
      };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/convert/contacts?q= — search active contacts for the drawer dropdown.
app.get('/api/convert/contacts', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const q = (req.query.q || '').trim();
    const filter = q
      ? { and: [ { property: 'Archive', checkbox: { equals: false } }, { property: 'Full Name', title: { contains: q } } ] }
      : { property: 'Archive', checkbox: { equals: false } };
    const r = await notion.dataSources.query({
      data_source_id: CONTACTS_DS,
      filter,
      sorts: q ? undefined : [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: 25,
    });
    res.json({ contacts: r.results.map(serializeContactRow) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/convert/touchpoint — log an activity + bump the contact's Last Touched.
app.post('/api/convert/touchpoint', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { contactId, contactName, touchpointType, channel, notes, loggedBy, timestamp } = req.body || {};
  if (!contactId || !touchpointType) return res.status(400).json({ error: 'contactId and touchpointType are required' });
  const when = /^\d{4}-\d{2}-\d{2}$/.test(timestamp || '') ? timestamp : chicagoTodayISODate();
  try {
    const title = `${(contactName || 'Contact')} — ${touchpointType}`;
    const properties = {
      Description: { title: [{ text: { content: title.slice(0, 200) } }] },
      'Touchpoint Type': { select: { name: touchpointType } },
      Timestamp: { date: { start: when } },
      Contact: { relation: [{ id: dashifyId(contactId) }] },
      'Logged By': { people: [{ id: loggedBy === 'Trina' ? TRINA_USER_ID : GRETCHEN_USER_ID }] },
    };
    if (channel) properties.Channel = { select: { name: channel } };
    if (notes && String(notes).trim()) properties.Notes = { rich_text: [{ text: { content: String(notes).slice(0, 1900) } }] };
    const page = await notion.pages.create({ parent: { type: 'data_source_id', data_source_id: SALES_ACTIVITY_DS }, properties });
    // Bump Last Touched on the contact to the interaction date.
    try { await notion.pages.update({ page_id: dashifyId(contactId), properties: { 'Last Touched': { date: { start: when } } } }); } catch (e) { console.error('Last Touched update failed:', e.message); }
    cache.delete('sales-pulse');
    for (const k of cache.keys()) if (k.startsWith('sales-overdue')) cache.delete(k);
    res.json({ ok: true, id: page.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/convert/touchpoints?period=month|quarter — list activity rows for a period with full detail.
app.get('/api/convert/touchpoints', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    const period = req.query.period === 'quarter' ? 'quarter' : 'month';
    const today = chicagoTodayISODate();
    const q = currentQuarter();
    const start = period === 'quarter' ? q.start : today.slice(0, 7) + '-01';
    const rows = [];
    let cursor;
    do {
      const r = await notion.dataSources.query({
        data_source_id: SALES_ACTIVITY_DS,
        filter: { and: [
          { property: 'Timestamp', date: { on_or_after: start } },
          { property: 'Timestamp', date: { on_or_before: today } },
        ]},
        sorts: [{ property: 'Timestamp', direction: 'descending' }],
        page_size: 100,
        start_cursor: cursor,
      });
      for (const pg of r.results) {
        const p = pg.properties || {};
        const ts = p.Timestamp?.date?.start?.slice(0, 10);
        if (!ts) continue;
        const contactRel = (p.Contact?.relation || [])[0];
        const contactId = contactRel?.id?.replace(/-/g, '') || null;
        rows.push({
          id: (pg.id || '').replace(/-/g, ''),
          date: ts,
          contactId,
          contactName: null,
          type: p['Touchpoint Type']?.select?.name || '',
          channel: p.Channel?.select?.name || '',
          notes: p.Notes?.rich_text?.[0]?.plain_text || '',
          loggedBy: (p['Logged By']?.people || [])[0]?.name || '',
          url: pg.url || `https://www.notion.so/${(pg.id || '').replace(/-/g, '')}`,
          contactUrl: contactId ? `https://www.notion.so/${contactId}` : null,
        });
      }
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    // Batch-resolve contact names from the Contact relation.
    const uniqueIds = [...new Set(rows.map(r => r.contactId).filter(Boolean))];
    const nameMap = {};
    await Promise.all(uniqueIds.map(async id => {
      try {
        const pg = await notion.pages.retrieve({ page_id: dashifyId(id) });
        const p = pg.properties || {};
        nameMap[id] = p['Full Name']?.title?.[0]?.plain_text || '(no name)';
      } catch (_) { nameMap[id] = null; }
    }));
    for (const r of rows) {
      r.contactName = (r.contactId && nameMap[r.contactId]) || '—';
    }
    res.json({ touchpoints: rows, period, total: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/convert/touchpoint/:id — update an existing activity row.
app.patch('/api/convert/touchpoint/:id', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  const { touchpointType, channel, notes, loggedBy, timestamp } = req.body || {};
  try {
    const properties = {};
    if (touchpointType) properties['Touchpoint Type'] = { select: { name: touchpointType } };
    if (timestamp && /^\d{4}-\d{2}-\d{2}$/.test(timestamp)) properties.Timestamp = { date: { start: timestamp } };
    if (loggedBy) properties['Logged By'] = { people: [{ id: loggedBy === 'Trina' ? TRINA_USER_ID : GRETCHEN_USER_ID }] };
    if (notes !== undefined) properties.Notes = String(notes).trim() ? { rich_text: [{ text: { content: String(notes).slice(0, 1900) } }] } : { rich_text: [] };
    if (channel !== undefined) properties.Channel = channel ? { select: { name: channel } } : { select: null };
    await notion.pages.update({ page_id: dashifyId(req.params.id), properties });
    cache.delete('sales-pulse');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/convert — full page payload (active contacts classified, open deals,
// this-week touchpoint count, Q2 revenue). The 6 calm conditions + Do This Next
// are computed client-side from this, per the reference logic. Cached 15 min.
app.get('/api/convert', async (req, res) => {
  if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
  try {
    if (req.query.fresh === '1') cache.delete('convert-page');
    const data = await cached('convert-page', async () => {
      const today = chicagoTodayISODate();
      const monday = weekStartISO(today);

      // The working set = contacts in an active sales conversation (Stage in
      // CONVERT_FOLLOWUP_STAGES) plus all Active Clients. This is what drives the
      // page — NOT all 700+ leads (touching every lead daily is never achievable,
      // so the calm state would never turn green). Conditions 1 & 2 evaluate the
      // active-conversation subset (`activeConvo`); the Clients tab uses the rest.
      const contactPages = [];
      let c1;
      do {
        const r = await notion.dataSources.query({
          data_source_id: CONTACTS_DS,
          filter: { and: [
            { property: 'Archive', checkbox: { equals: false } },
            { or: [
              ...CONVERT_FOLLOWUP_STAGES.map((s) => ({ property: 'Stage', select: { equals: s } })),
              { property: 'Relationship', select: { equals: 'Active Client' } },
            ] },
          ] },
          page_size: 100, start_cursor: c1,
        });
        contactPages.push(...r.results);
        c1 = r.has_more ? r.next_cursor : null;
      } while (c1);
      // Notion id of the signed-in user, for the global "assigned to me" filter.
      const nid = (typeof currentNotionUserId === 'function' ? currentNotionUserId() : null) || GRETCHEN_USER_ID;
      const contacts = contactPages.map(serializeContactRow)
        .map((c) => ({ ...c, activeConvo: CONVERT_FOLLOWUP_STAGES.includes(c.stage), mine: (c.assignedIds || []).includes(nid) }));

      // Open deals.
      const productMap = await fetchSalesProductMap(notion, cached).catch(() => ({}));
      const deals = (await queryAllDeals(notion))
        .map((pg) => serializeDeal(pg, productMap))
        .filter((d) => !d.archived && !['Closed Won', 'Closed Lost'].includes(d.status))
        .map((d) => ({ url: d.url, id: d.id, name: d.name, stage: d.status, value: d.value, lastTouched: d.lastTouched, assignedTo: d.assignedTo, mine: (d.assignedIds || []).includes(nid) }));

      // Touchpoints logged this week (SALES ACTIVITY entries since Monday).
      let touchpointsThisWeek = 0, c2;
      do {
        const r = await notion.dataSources.query({
          data_source_id: SALES_ACTIVITY_DS,
          filter: { property: 'Timestamp', date: { on_or_after: monday } },
          page_size: 100, start_cursor: c2,
        });
        touchpointsThisWeek += r.results.length;
        c2 = r.has_more ? r.next_cursor : null;
      } while (c2);

      // Revenue from Xero: collected QTD, outstanding invoices, approved quotes,
      // and a 12-month avg recurring projection for the remainder of the quarter.
      let revenue = null;
      if (computeXeroFinance) {
        try {
          const [fin, quoteData, recurData, goals] = await Promise.all([
            cached('xero-finance', computeXeroFinance),
            computeXeroQuotes ? computeXeroQuotes().catch(() => null) : Promise.resolve(null),
            computeRecurringAvg ? cached('xero-recurring-avg', computeRecurringAvg).catch(() => null) : Promise.resolve(null),
            cached('vto-goals', fetchVtoGoals).catch(() => ({})),
          ]);

          const q = currentQuarter();
          const qEndDate = new Date(q.end + 'T23:59:59Z');
          const msRemaining = Math.max(0, qEndDate - Date.now());
          const monthsRemainingInQtr = msRemaining / (1000 * 60 * 60 * 24 * 30.44);

          const recurringAvg = recurData?.avgMonthly || 0;
          // Exclude quotes whose issue date falls in a future quarter.
          const thisQtrQuotes = (quoteData?.accepted || []).filter(qx => !qx.date || qx.date <= q.end);
          const approvedQuotesTotal = thisQtrQuotes.reduce((s, qx) => s + (qx.total || 0), 0);
          const openQuotesTotal = quoteData?.open?.reduce((s, qx) => s + (qx.total || 0), 0) || 0;

          const monthlyRevGoal = goals?.revenue?.goal ?? null;
          const goal = monthlyRevGoal != null ? monthlyRevGoal * 3 : 120000;

          revenue = {
            collected: fin.qtdRevenue || 0,
            invoiced: fin.accountsReceivable || 0,
            acceptedQuotes: approvedQuotesTotal,
            quotesAvailable: quoteData !== null,
            approvedQuotesTotal,
            openQuotesTotal,
            recurringAvg,
            recurringRemaining: recurringAvg * monthsRemainingInQtr,
            monthsRemainingInQtr,
            goal,
          };
        } catch (e) { revenue = null; }
      }

      return { asOf: new Date().toISOString(), quarterLabel: currentQuarter().label, contacts, deals, touchpointsThisWeek, revenue };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/convert/draft — draft a short, personalized follow-up message with
// Claude, using the contact's relationship/stage/source/recency for context.
app.post('/api/convert/draft', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'AI not configured' });
  const { name = '', contactId = '' } = req.body || {};
  try {
    const ctxLines = [];
    if (contactId) {
      try {
        const pg = await notion.pages.retrieve({ page_id: dashifyId(contactId) });
        const c = serializeContactRow(pg);
        let days = null;
        if (c.lastTouched) days = Math.round((Date.parse(chicagoTodayISODate()) - Date.parse(c.lastTouched)) / 86400000);
        if (c.relationship) ctxLines.push(`Relationship: ${c.relationship}`);
        if (c.stage) ctxLines.push(`Pipeline stage: ${c.stage}`);
        if (c.source) ctxLines.push(`How they found us: ${c.source}`);
        ctxLines.push(days != null ? `Last contact: ${days} days ago` : 'No prior contact logged');
      } catch (_) { /* fall back to name-only */ }
    }
    const prompt = `You write warm, concise follow-ups for Left Right Labs, a brand + website design agency.\n\n`
      + `Draft a short follow-up message to ${name || 'this contact'} that re-opens the conversation without being pushy.\n`
      + (ctxLines.length ? `\nContext:\n- ${ctxLines.join('\n- ')}\n` : '')
      + `\nRules: 3–5 sentences. Friendly, human, professional. Use their first name. No subject line, no placeholders, no preamble — just the message text ready to send.`;
    const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
    res.json({ name, message: (msg.content?.[0]?.text || '').trim() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

}

