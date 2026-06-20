// LEGO (Personal) routes — Notion-powered. Mirrors the Wealth route shape.
import { getLegoSummary } from '../providers/notion/lego.js';

export function registerLegoRoutes(app, ctx) {
  const { notion, cached, cache, userContext } = ctx;

  // GET /api/lego/summary — LEGO-tab KPIs (collection, builds, next convention).
  app.get('/api/lego/summary', async (req, res) => {
    try {
      if (!notion) return res.json({ configured: false });
      if (req.query.fresh === '1') {
        const u = userContext.getStore()?.user;
        cache.delete(u ? `lego-summary::${u.id || u.email}` : 'lego-summary');
      }
      const data = await cached('lego-summary', () => getLegoSummary(notion));
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
