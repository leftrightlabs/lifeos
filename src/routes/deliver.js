// Deliver zone routes — a client-delivery "Act" layer over the existing projects
// board. Reuses the cached projects board (no new Notion reads); just computes the
// delivery signals Gretchen acts on: overdue, due-soon, undated, and workload.
// Mirrors the register<Zone>Routes(app, ctx) seam used by Convert/Attract/Wealth.

const ACTIVE = new Set(['Active', 'Ongoing']);

// Target delivery date for a project: prefer the range end, then an explicit due,
// then deadline. (Notion's atRisk flag is unpopulated, so risk is derived here.)
function targetDate(p) {
  return p.end || p.due || p.deadline || null;
}

// Whole days between two YYYY-MM-DD dates (b - a).
function daysBetween(aISO, bISO) {
  const a = new Date(aISO + 'T00:00:00Z').getTime();
  const b = new Date(bISO + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

function addDays(iso, n) {
  return new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
}

export function registerDeliverRoutes(app, ctx) {
  const { cached, cache, userContext, fetchProjectsBoard, chicagoTodayISODate } = ctx;

  // GET /api/deliver/act — overdue / due-soon / undated / workload across active
  // WORK projects (PRODUCTION is the client-delivery area, but we span all active
  // work so nothing client-facing is missed).
  app.get('/api/deliver/act', async (req, res) => {
    try {
      if (req.query.fresh === '1') {
        const u = userContext.getStore()?.user;
        cache.delete(u ? `projects-board::${u.id || u.email}` : 'projects-board');
      }
      const board = await cached('projects-board', fetchProjectsBoard);
      const today = chicagoTodayISODate();
      const horizon = addDays(today, 14);

      const active = (board.projects || []).filter((p) => p.source === 'work' && ACTIVE.has(p.status));

      const slim = (p) => ({
        id: p.id, name: p.name, url: p.url || null, status: p.status,
        area: p.area || null, owners: p.owners || [], target: targetDate(p),
        rock: !!p.rock, taskMeta: p.taskMeta || null,
      });

      const overdue = active
        .filter((p) => { const t = targetDate(p); return t && t < today; })
        .map((p) => ({ ...slim(p), daysOverdue: daysBetween(targetDate(p), today) }))
        .sort((a, b) => b.daysOverdue - a.daysOverdue);

      const dueSoon = active
        .filter((p) => { const t = targetDate(p); return t && t >= today && t <= horizon; })
        .map((p) => ({ ...slim(p), inDays: daysBetween(today, targetDate(p)) }))
        .sort((a, b) => a.inDays - b.inDays);

      const undated = active.filter((p) => !targetDate(p)).map(slim);

      const ownerCounts = {};
      for (const p of active) for (const o of (p.owners || [])) ownerCounts[o] = (ownerCounts[o] || 0) + 1;
      const byOwner = Object.entries(ownerCounts).map(([owner, n]) => ({ owner, n })).sort((a, b) => b.n - a.n);

      const all = active.map(slim).sort((a, b) => (a.target || '9999-99-99').localeCompare(b.target || '9999-99-99'));

      res.json({
        today,
        summary: { active: active.length, production: active.filter((p) => p.area === 'PRODUCTION').length },
        overdue, dueSoon, undated, byOwner, all,
        asOf: new Date().toISOString(),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
