// Wealth (Personal) routes — YNAB-powered.
import { getNetWorth, getWealthSummary, ynabConfigured } from '../providers/ynab/networth.js';

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

  // GET /api/wealth/summary — full Wealth-tab data (net worth, budget, age of money, cash/debt, goals).
  app.get('/api/wealth/summary', async (req, res) => {
    try {
      if (!ynabConfigured()) return res.json({ configured: false });
      if (req.query.fresh === '1') {
        const u = userContext.getStore()?.user;
        cache.delete(u ? `ynab-wealth::${u.id || u.email}` : 'ynab-wealth');
      }
      const data = await cached('ynab-wealth', () => getWealthSummary());
      res.json({ configured: true, ...data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
