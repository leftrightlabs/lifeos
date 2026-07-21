// Deliver zone routes — the two wired sections: Offer catalog health (Products)
// and Care-plan renewals (Web Properties). The project sections render client-
// side from the shared projects board, so they have no endpoint here.
import { fetchOffers, fetchWebProperties } from '../providers/notion/deliver.js';
import {
  OFFER_LADDER, UPSELL_PLANS, RENEWAL_HORIZON_DAYS,
  TASKS_DS, PROJECTS_DS, TIME_LOG_DS, PRODUCTION_AREA_ID,
  SUPPORT_USER_ID, TRINA_USER_ID, CLIENT_WAITING, WAIT_STALE_DAYS, ATRISK_MARGIN,
  INVOICE_READY, INVOICE_DONE, SCORE_WEIGHTS,
} from '../config/deliver.js';

export function registerDeliverRoutes(app, ctx) {
  const { notion, cached, cache, userContext, chicagoTodayISODate,
    chicagoDateNDaysAgo, dashifyId, GRETCHEN_USER_ID, currentNotionUserId, currentUser, anthropic } = ctx;
  const bust = (key) => { const u = userContext.getStore()?.user; cache.delete(u ? `${key}::${u.id || u.email}` : key); };

  // GET /api/deliver/offers — offer-ladder health: which rungs are live vs empty,
  // plus drafts to finish (gap-fillers first).
  app.get('/api/deliver/offers', async (req, res) => {
    try {
      if (req.query.fresh === '1') bust('deliver-offers');
      const offers = await cached('deliver-offers', () => fetchOffers(notion));
      const isLive = (o) => o.status === 'Published';
      const ladder = OFFER_LADDER.map((cat) => {
        const inCat = offers.filter((o) => o.categories.includes(cat));
        return { name: cat, total: inCat.length, live: inCat.filter(isLive).length };
      });
      const gaps = new Set(ladder.filter((l) => l.live === 0).map((l) => l.name));
      const drafts = offers
        .filter((o) => !isLive(o))
        .map((o) => ({
          name: o.name, status: o.status, url: o.url, notionUrl: o.notionUrl,
          categories: o.categories,
          fillsGap: o.categories.some((c) => gaps.has(c)),
        }))
        .sort((a, b) => (Number(b.fillsGap) - Number(a.fillsGap)) || (Number(!!b.url) - Number(!!a.url)));
      const offerList = offers.map((o) => ({ name: o.name, categories: o.categories, status: o.status, url: o.url, notionUrl: o.notionUrl }));
      res.json({ ladder, drafts, offers: offerList, totalOffers: offers.length, asOf: new Date().toISOString() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/deliver/renewals — care plans coming up for renewal + upsell paths.
  app.get('/api/deliver/renewals', async (req, res) => {
    try {
      if (req.query.fresh === '1') bust('deliver-renewals');
      const props = await cached('deliver-renewals', () => fetchWebProperties(notion));
      const today = chicagoTodayISODate();
      const t0 = new Date(today + 'T00:00:00Z').getTime();
      const daysLeft = (iso) => iso ? Math.round((new Date(iso + 'T00:00:00Z').getTime() - t0) / 86400000) : null;

      const renewals = props
        .filter((w) => w.planEnd)
        .map((w) => ({ domain: w.domain, plan: w.plan, planEnd: w.planEnd, daysLeft: daysLeft(w.planEnd), autoRenew: w.autoRenew, notionUrl: w.notionUrl }))
        .filter((w) => w.daysLeft != null && w.daysLeft <= RENEWAL_HORIZON_DAYS)
        .sort((a, b) => a.daysLeft - b.daysLeft);

      const upsells = props
        .filter((w) => UPSELL_PLANS.includes(w.plan))
        .map((w) => ({ domain: w.domain, plan: w.plan, notionUrl: w.notionUrl }))
        .sort((a, b) => a.domain.localeCompare(b.domain));

      const byPlan = {};
      props.forEach((w) => { if (w.plan) byPlan[w.plan] = (byPlan[w.plan] || 0) + 1; });

      res.json({ renewals, upsells, byPlan, total: props.length, horizon: RENEWAL_HORIZON_DAYS, asOf: new Date().toISOString() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CLIENT-WORK DELIVERY DASHBOARD — the main /deliver view.
  // Scope: PRODUCTION-area projects only. isCalm is derived from 6 live queries.
  // ══════════════════════════════════════════════════════════════════════════

  const hhmmToHours = (s) => { if (!s || typeof s !== 'string') return 0; const m = s.match(/(\d+):(\d+):?(\d+)?/); return m ? (+m[1]) + (+m[2]) / 60 + (m[3] ? (+m[3]) / 3600 : 0) : 0; };
  const dayDiff = (iso, today) => iso ? Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(iso.slice(0, 10) + 'T00:00:00Z')) / 864e5) : null;
  const mondayISO = (today) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  const serTask = (page) => {
    const p = page.properties || {};
    return {
      id: page.id, url: page.url,
      name: p.Name?.title?.[0]?.plain_text || '(untitled)',
      status: p.Status?.status?.name || null,
      assignees: (p.Assigned?.people || []).map((u) => u.id),
      assigneeNames: (p.Assigned?.people || []).map((u) => u.name).filter(Boolean),
      projectId: (p.Project?.relation || [])[0]?.id || null,
      due: p.Due?.date?.start || null,
      est: typeof p['Est Hours']?.number === 'number' ? p['Est Hours'].number : null,
      logged: p['Total Logged (hrs)']?.formula?.number || 0,
      waiting: p.Waiting?.select?.name || null,
      waitDate: p['Wait Date']?.date?.start || null,
      recurring: !!p['Recurring?']?.checkbox || (p['Recur Interval']?.number || 0) > 0,
      snooze: p.Snooze?.date?.start || null,
      invoice: (p.Invoice?.multi_select || []).map((o) => o.name),
      completed: p.Completed?.date?.start || null,
      edited: page.last_edited_time || null,
    };
  };
  const serProject = (page) => {
    const p = page.properties || {};
    const td = p['Target Deadline']?.date || {};
    return {
      id: page.id, url: page.url,
      name: p.Name?.title?.[0]?.plain_text || '(untitled)',
      status: p.Status?.status?.name || null,
      deadline: td.end || td.start || null,
      assignees: [...(p.Assigned?.people || []).map((u) => u.id), ...(p.Owner?.people || []).map((u) => u.id)],
      estHours: typeof p['Est. Hours']?.formula?.number === 'number' ? p['Est. Hours'].formula.number : 0,
      trackedHours: hhmmToHours(p['Time Tracked']?.formula?.string),
      completed: p.Completed?.date?.start || null,
      edited: page.last_edited_time || null,
    };
  };

  // Fetch all PRODUCTION projects + their active tasks + recently-completed tasks.
  // Cached (Notion-heavy); request-time derivation (scope, conditions) is cheap.
  async function buildDeliver() {
    const today = chicagoTodayISODate();
    const pageThrough = async (args) => {
      const out = []; let cursor;
      do { const r = await notion.dataSources.query({ ...args, page_size: 100, start_cursor: cursor }); out.push(...r.results); cursor = r.has_more ? r.next_cursor : null; } while (cursor);
      return out;
    };
    const projPages = await pageThrough({ data_source_id: PROJECTS_DS, filter: { and: [{ property: 'Archived', checkbox: { equals: false } }, { property: 'AREA', relation: { contains: PRODUCTION_AREA_ID } }] } });
    const projects = projPages.map(serProject);
    const prodIds = new Set(projects.map((p) => p.id));

    const activePages = await pageThrough({ data_source_id: TASKS_DS, filter: { property: 'Status', status: { does_not_equal: 'Done' } } });
    const active = activePages.map(serTask).filter((t) => t.projectId && prodIds.has(t.projectId));

    const sinceDone = chicagoDateNDaysAgo(35);
    const donePages = await pageThrough({ data_source_id: TASKS_DS, filter: { and: [{ property: 'Status', status: { equals: 'Done' } }, { property: 'Completed', date: { on_or_after: sinceDone } }] }, sorts: [{ property: 'Completed', direction: 'descending' }] });
    const doneRecent = donePages.map(serTask).filter((t) => t.projectId && prodIds.has(t.projectId));

    return { asOf: new Date().toISOString(), today, projects, active, doneRecent };
  }

  // Derive the full page payload for a given Me-scope from the cached raw data.
  function derive(data, me) {
    const today = data.today;
    // Session-aware: "mine" means assigned to the signed-in user, not always Gretchen.
    const meId = (typeof currentNotionUserId === 'function' ? currentNotionUserId() : null) || GRETCHEN_USER_ID;
    const monday = mondayISO(today);
    const projName = {}; data.projects.forEach((p) => { projName[p.id] = p.name; });
    const avatar = (ids, names) => {
      const id = ids[0]; const nm = names[0] || '';
      const init = (nm.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();
      const cls = id === GRETCHEN_USER_ID ? 'gc' : id === TRINA_USER_ID ? 'tf' : id === SUPPORT_USER_ID ? 'sup' : 'nw';
      return { init, cls, name: nm };
    };
    const inScope = (ids) => !me || ids.includes(meId) || ids.length === 0;
    const tagT = (t) => {
      const isDone = t.status === 'Done';
      return {
        ...t, projectName: projName[t.projectId] || '—',
        mine: t.assignees.includes(meId), outsourced: t.assignees.includes(SUPPORT_USER_ID),
        av: avatar(t.assignees, t.assigneeNames),
        // Done tasks are never "overdue/due" — those flags drive urgency styling.
        overdue: !isDone && !!t.due && t.due < today, dueToday: !isDone && t.due === today, dueTomorrow: !isDone && t.due === addDays(today, 1),
      };
    };

    // Snoozed tasks drop out of the active surface (hero, sections, conditions)
    // until their Snooze date passes — "deferred, not dismissed; resurfaces later".
    const active = data.active.map(tagT).filter((t) => inScope(t.assignees) && !(t.snooze && t.snooze > today));
    const doneRecent = data.doneRecent.map(tagT).filter((t) => inScope(t.assignees));

    // Project scope (Me): assigned/owner OR contains one of my active tasks.
    const myTaskProj = new Set(data.active.filter((t) => t.assignees.includes(meId)).map((t) => t.projectId));
    const projects = data.projects.filter((p) => !me || p.assignees.includes(meId) || myTaskProj.has(p.id));
    const isActiveProj = (p) => p.status && !/^(done|complete|completed|on hold|not started|archived|cancelled)$/i.test(p.status);

    // Per-project rollup from the fetched window (work-done% is windowed → indicative).
    const projStat = {};
    for (const p of projects) {
      const act = active.filter((t) => t.projectId === p.id);
      const doneWin = doneRecent.filter((t) => t.projectId === p.id).length;
      const total = act.length + doneWin;
      const overdueN = act.filter((t) => t.overdue).length;
      const timeUsedPct = p.estHours > 0 ? Math.round((p.trackedHours / p.estHours) * 100) : null;
      const workDonePct = total > 0 ? Math.round((doneWin / total) * 100) : null;
      const atRisk = overdueN > 0 || (timeUsedPct != null && workDonePct != null && (timeUsedPct - workDonePct) >= ATRISK_MARGIN);
      projStat[p.id] = { overdueN, timeUsedPct, workDonePct, atRisk, openCount: act.length };
    }

    // ── The 6 calm conditions ──
    const overdueTasks = active.filter((t) => t.overdue);
    const activeProjs = projects.filter(isActiveProj);
    const missingDeadline = activeProjs.filter((p) => !p.deadline);
    const staleClientWaits = active.filter((t) => CLIENT_WAITING.includes(t.waiting) && (dayDiff(t.waitDate || t.edited, today) || 0) >= WAIT_STALE_DAYS);
    const atRiskProjects = activeProjs.filter((p) => projStat[p.id]?.atRisk);
    const missingEstimate = active.filter((t) => t.est == null);
    const unbilled = doneRecent.filter((t) => t.invoice.some((v) => INVOICE_READY.includes(v)) && !t.invoice.includes(INVOICE_DONE));

    const conditions = [
      { key: 'overdue', label: 'No overdue tasks', pass: overdueTasks.length === 0, n: overdueTasks.length },
      { key: 'deadlines', label: 'Every project has a deadline', pass: missingDeadline.length === 0, n: missingDeadline.length },
      { key: 'waits', label: 'No stale client waits', pass: staleClientWaits.length === 0, n: staleClientWaits.length },
      { key: 'risk', label: 'No projects at risk', pass: atRiskProjects.length === 0, n: atRiskProjects.length },
      { key: 'estimates', label: 'All active tasks estimated', pass: missingEstimate.length === 0, n: missingEstimate.length },
      { key: 'billing', label: 'Nothing unbilled & complete', pass: unbilled.length === 0, n: unbilled.length },
    ];
    const isCalm = conditions.every((c) => c.pass);

    // ── THE ONE THING (§7) ── (recurring tasks excluded — they read as perpetually
    // overdue and aren't the kind of single decision the hero is meant to surface)
    const w = SCORE_WEIGHTS;
    const scored = active.filter((t) => !t.recurring).map((t) => {
      const st = projStat[t.projectId] || {};
      const blocks = Math.max(0, (st.openCount || 1) - 1); // other open tasks on the same project
      const days = dayDiff(t.edited, today) || 0;
      const urg = t.overdue ? 1 : t.dueToday ? 0.8 : t.dueTomorrow ? 0.5 : 0;
      const blk = Math.min(1, blocks / 3);
      const rsk = st.atRisk ? 1 : 0;
      const stl = Math.min(1, days / 14);
      const fresh = days > 14 ? 0.5 : 1;
      const score = (w.urgency * urg + w.blocking * blk + w.risk * rsk + w.staleness * stl) * fresh;
      return { t, score, blocks, days, stale: days > 14 };
    }).sort((a, b) => b.score - a.score);
    const top = scored[0];
    const hero = top && top.score > 0 ? {
      id: top.t.id, name: top.t.name, url: top.t.url, projectName: top.t.projectName,
      av: top.t.av, due: top.t.due, est: top.t.est, logged: top.t.logged,
      overdue: top.t.overdue, dueToday: top.t.dueToday,
      overdueDays: top.t.overdue ? Math.abs(dayDiff(top.t.due, today)) : 0,
      blocks: top.blocks, stale: top.stale, staleDays: top.days,
    } : null;

    // ── Gamification (§8) ──
    const shippedThisWeek = doneRecent.filter((t) => t.completed && t.completed >= monday).length;
    const lastWeekStart = addDays(monday, -7);
    const lastWeek = doneRecent.filter((t) => t.completed && t.completed >= lastWeekStart && t.completed < monday).length;
    const doneDates = new Set(doneRecent.map((t) => t.completed).filter(Boolean));
    let streak = 0, cur = today;
    for (let i = 0; i < 60; i++) {
      const d = new Date(cur + 'T00:00:00Z'); const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
      if (doneDates.has(cur)) streak++; else if (weekend || i === 0) { /* immune / today-in-progress */ } else break;
      cur = new Date(d.getTime() - 864e5).toISOString().slice(0, 10);
    }
    const closed30 = projects.filter((p) => p.completed && (dayDiff(p.completed, today) || 99) <= 30);
    const onTimeN = closed30.filter((p) => p.deadline && p.completed <= p.deadline).length;
    const onTimeRate = closed30.length ? Math.round((onTimeN / closed30.length) * 100) : null;
    const untouched5 = activeProjs.filter((p) => (dayDiff(p.edited, today) || 0) >= 5);
    const allTouched48 = activeProjs.every((p) => (dayDiff(p.edited, today) || 0) < 2);
    const momentum = untouched5.length >= 3 ? { label: 'Stalling', tone: 'red', detail: `${untouched5.length} projects no movement 5d+` }
      : allTouched48 ? { label: 'Strong', tone: 'green', detail: 'all projects touched <48h' }
      : { label: 'Steady', tone: 'amber', detail: `${activeProjs.length} active projects` };

    // ── Section data ──
    const taskRow = (t) => ({
      id: t.id, name: t.name, url: t.url, projectName: t.projectName, av: t.av,
      status: t.status, due: t.due, est: t.est, logged: t.logged, outsourced: t.outsourced,
      overdue: t.overdue, dueToday: t.dueToday, dueTomorrow: t.dueTomorrow,
      overdueDays: t.overdue ? Math.abs(dayDiff(t.due, today)) : 0,
      waiting: t.waiting, waitDays: t.waiting ? (dayDiff(t.waitDate || t.edited, today) || 0) : null,
      invoice: t.invoice, mine: t.mine,
    });
    const comingDue = active.filter((t) => t.overdue || t.dueToday || t.dueTomorrow)
      .sort((a, b) => (a.due || '9') < (b.due || '9') ? -1 : 1).map(taskRow);
    const waiting = active.filter((t) => t.waiting).sort((a, b) => (dayDiff(b.waitDate || b.edited, today) || 0) - (dayDiff(a.waitDate || a.edited, today) || 0)).map(taskRow);
    const delegated = active.filter((t) => (t.outsourced || (!t.mine && t.assignees.length)) && /doing|agenda|planned|waiting/i.test(t.status || ''))
      .sort((a, b) => (dayDiff(a.edited, today) || 0) - (dayDiff(b.edited, today) || 0)).map(taskRow);
    const readyToBill = unbilled.map(taskRow);

    const projRow = (p) => ({ id: p.id, name: p.name, url: p.url, status: p.status, deadline: p.deadline, av: avatar(p.assignees, []), ...projStat[p.id] });
    const atRiskRows = atRiskProjects.map(projRow);
    const onTrack = activeProjs.filter((p) => !projStat[p.id]?.atRisk).map(projRow);
    const onHold = projects.filter((p) => /on hold|hold/i.test(p.status || '')).map(projRow);
    const notStarted = projects.filter((p) => /not started/i.test(p.status || '')).map(projRow);

    const dataToFix = {
      missingEstimates: { count: missingEstimate.length, tasks: missingEstimate.slice(0, 12).map(taskRow) },
      doneNoTime: { count: doneRecent.filter((t) => t.completed >= monday && (t.logged || 0) < 0.01).length, tasks: doneRecent.filter((t) => t.completed >= monday && (t.logged || 0) < 0.01).slice(0, 12).map(taskRow) },
      missingDeadlines: { count: missingDeadline.length, projects: missingDeadline.map((p) => ({ id: p.id, name: p.name, url: p.url })) },
    };

    const stressedCount = overdueTasks.length + atRiskProjects.length + staleClientWaits.length;
    const nextDeadline = activeProjs.filter((p) => p.deadline && p.deadline >= today).sort((a, b) => a.deadline < b.deadline ? -1 : 1)[0] || null;

    // ── MY WORK (execution view) ── always the SIGNED-IN user's own actionable
    // production tasks, independent of the Me toggle (this view is inherently
    // "me"). Strict: assigned to me only — never unassigned, never someone else's.
    // Grouped client-side (by project / status / due). Computed from the raw
    // active set so the Overview's me-scoping never narrows it.
    // allWork = every active production task (any assignee); myWork = just mine.
    // The ME toggle switches between them on the client (ME on → myWork). Rows
    // carry an avatar, so in the all-team view you can see who owns each task.
    // Active tasks + recently-completed (last ~35d) so the Done status filter can
    // reveal finished work; Done is hidden by default client-side.
    const workBase = [...data.active, ...data.doneRecent].map(tagT)
      .filter((t) => !(t.snooze && t.snooze > today) && !t.recurring)
      .sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1);
    const allWork = workBase.map(taskRow);
    const myWork = workBase.filter((t) => t.assignees.includes(meId)).map(taskRow);

    // ── NEEDS AN OWNER (PM surface) ── active tasks with no assignee. With the
    // strict Me scope, these no longer masquerade as anyone's work, so the PM
    // Overview surfaces them explicitly: "these need an owner assigned".
    const needsOwner = data.active.map(tagT)
      .filter((t) => t.assignees.length === 0 && !(t.snooze && t.snooze > today) && !t.recurring)
      .sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1)
      .map(taskRow);

    return {
      asOf: data.asOf, today, me, isCalm, conditions,
      banner: { stressedCount, overdue: overdueTasks.length, atRisk: atRiskProjects.length, staleWaits: staleClientWaits.length },
      hero,
      pulse: { shippedThisWeek, lastWeek, streak, onTimeRate, momentum },
      sections: { comingDue, atRisk: atRiskRows, waiting, delegated, dataToFix, readyToBill, onTrack, onHold, notStarted, needsOwner },
      myWork, myWorkCount: myWork.length, allWork, allWorkCount: allWork.length,
      calm: { activeCount: activeProjs.length, nextDeadline: nextDeadline ? { name: nextDeadline.name, deadline: nextDeadline.deadline } : null },
    };
  }

  // GET /api/deliver?me=0|1 — full page payload.
  app.get('/api/deliver', async (req, res) => {
    if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
    try {
      if (req.query.fresh === '1') bust('deliver-page');
      const data = await cached('deliver-page', buildDeliver);
      res.json(derive(data, req.query.me === '1'));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/deliver/me — is the Me toggle available (owner only)?
  app.get('/api/deliver/me', (req, res) => {
    res.json({ owner: (currentUser()?.role || 'owner') === 'owner' });
  });

  // POST /api/deliver/log-time { taskId, taskName, hours, note } → TIME LOG entry.
  app.post('/api/deliver/log-time', async (req, res) => {
    if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
    const { taskId, taskName, hours, note } = req.body || {};
    const h = Number(hours);
    if (!taskId || !(h > 0)) return res.status(400).json({ error: 'taskId and positive hours are required' });
    try {
      await notion.pages.create({
        parent: { type: 'data_source_id', data_source_id: TIME_LOG_DS },
        properties: {
          'Log Entry': { title: [{ text: { content: `${(taskName || 'Task').slice(0, 120)} — ${h}h` } }] },
          'Actual (hours)': { number: h },
          Task: { relation: [{ id: dashifyId(taskId) }] },
          'Date Logged': { date: { start: chicagoTodayISODate() } },
          Person: { people: [{ id: GRETCHEN_USER_ID }] },
          ...(note && String(note).trim() ? { Notes: { rich_text: [{ text: { content: String(note).slice(0, 1900) } }] } } : {}),
        },
      });
      bust('deliver-page');
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/deliver/estimate { taskId, hours } → write Est Hours on the task.
  app.post('/api/deliver/estimate', async (req, res) => {
    if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
    const { taskId, hours } = req.body || {};
    const h = Number(hours);
    if (!taskId || !(h > 0)) return res.status(400).json({ error: 'taskId and positive hours are required' });
    try {
      await notion.pages.update({ page_id: dashifyId(taskId), properties: { 'Est Hours': { number: h } } });
      bust('deliver-page');
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/deliver/done { taskId } → mark task Done.
  app.post('/api/deliver/done', async (req, res) => {
    if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
    const { taskId } = req.body || {};
    if (!taskId) return res.status(400).json({ error: 'taskId is required' });
    try {
      await notion.pages.update({ page_id: dashifyId(taskId), properties: { Status: { status: { name: 'Done' } } } });
      bust('deliver-page');
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Phase 2 actions (draft-first — nothing auto-sends) ──

  // POST /api/deliver/draft { kind, taskName, projectName, waiting, days } → a
  // copy-ready reminder (to a client) or nudge (to support) drafted by Claude.
  app.post('/api/deliver/draft', async (req, res) => {
    if (!anthropic) return res.status(503).json({ error: 'AI not configured' });
    const { kind = 'reminder', taskName = '', projectName = '', waiting = '', days = null } = req.body || {};
    try {
      const ctxLines = [
        `Task / deliverable: ${taskName || '(unnamed)'}`,
        projectName ? `Project: ${projectName}` : '',
        waiting ? `Currently waiting on: ${waiting}` : '',
        days != null ? `Days stalled: ${days}` : '',
      ].filter(Boolean);
      const instr = kind === 'nudge'
        ? 'Write a short, friendly internal Slack nudge to the support/contractor teammate who owns this task, gently checking on status and asking for an ETA. Casual, collegial, no pressure.'
        : 'Write a short, warm reminder message to the CLIENT, nudging them on what we are waiting for so we can keep their project moving. Polite, professional, makes it easy for them to respond.';
      const prompt = `You write for Left Right Labs, a brand + website design agency.\n\n${instr}\n\nContext:\n- ${ctxLines.join('\n- ')}\n\nRules: 3–5 sentences. Use a real, human tone. No subject line, no placeholders like [Name], no preamble — just the message text ready to paste and send.`;
      const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
      res.json({ kind, message: (msg.content?.[0]?.text || '').trim() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/deliver/snooze { taskId, days } → set the task's Snooze date to
  // today+days; the aggregator hides it from the active view until then.
  app.post('/api/deliver/snooze', async (req, res) => {
    if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
    const { taskId, days } = req.body || {};
    const n = Number(days);
    if (!taskId || !(n > 0)) return res.status(400).json({ error: 'taskId and positive days are required' });
    try {
      const d = new Date(chicagoTodayISODate() + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + n);
      const until = d.toISOString().slice(0, 10);
      await notion.pages.update({ page_id: dashifyId(taskId), properties: { Snooze: { date: { start: until } } } });
      bust('deliver-page');
      res.json({ ok: true, until });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/deliver/mark-invoiced { taskId } → add "Invoiced" to the task's
  // Invoice multi-select (preserving existing values). Reversible; the actual
  // invoice is created by the user in Xero (read-only integration here).
  app.post('/api/deliver/mark-invoiced', async (req, res) => {
    if (!notion) return res.status(500).json({ error: 'NOTION_TOKEN not configured' });
    const { taskId } = req.body || {};
    if (!taskId) return res.status(400).json({ error: 'taskId is required' });
    try {
      const pg = await notion.pages.retrieve({ page_id: dashifyId(taskId) });
      const cur = (pg.properties?.Invoice?.multi_select || []).map((o) => o.name);
      const next = [...new Set([...cur, INVOICE_DONE])].map((name) => ({ name }));
      await notion.pages.update({ page_id: dashifyId(taskId), properties: { Invoice: { multi_select: next } } });
      bust('deliver-page');
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
