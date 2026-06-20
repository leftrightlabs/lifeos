// Wealth (Personal) routes. Currently: net worth from YNAB.
import { getNetWorth, ynabConfigured } from '../providers/ynab/networth.js';

export function registerWealthRoutes(app, ctx) {
  const { cached, cache, userContext } = ctx;

  // GET /api/wealth/networth — net worth from YNAB (open accounts, signed sum).
  app.get('/api/wealth/networth', async (req, res) => {
    try {
      if (!ynabConfigured()) return res.json({ configured: false });
      if (req.query.fresh === '1') {
        const u = userContext.getStore()?.user;
        cache.delete(u ? `ynab-networth::${u.id || u.email}` : 'ynab-networth');
      }
      const data = await cached('ynab-networth', () => getNetWorth());
      res.json({ configured: true, ...data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
