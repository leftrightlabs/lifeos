// Deliver zone routes — the two wired sections: Offer catalog health (Products)
// and Care-plan renewals (Web Properties). The project sections render client-
// side from the shared projects board, so they have no endpoint here.
import { fetchOffers, fetchWebProperties } from '../providers/notion/deliver.js';
import { OFFER_LADDER, UPSELL_PLANS, RENEWAL_HORIZON_DAYS } from '../config/deliver.js';

export function registerDeliverRoutes(app, ctx) {
  const { notion, cached, cache, userContext, chicagoTodayISODate } = ctx;
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
}
