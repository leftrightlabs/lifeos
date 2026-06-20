// Scale zone routes. Today: "Systems to fix" from the Business Functions DB.
import { fetchBusinessFunctions } from '../providers/notion/scale.js';
import {
  SYSTEM_ATTENTION_STATUSES,
  SYSTEM_HEALTH_RANK,
  SYSTEM_PRIORITY_RANK,
  QUICK_WIN_MIN_IMPACT,
  QUICK_WIN_MAX_EFFORT,
} from '../config/scale.js';

export function registerScaleRoutes(app, { notion, cached }) {
  // Systems that need attention, ranked: urgency (Health Status) → Priority →
  // impact-per-effort, with a quick-win flag (high impact, low effort).
  app.get('/api/scale/systems', async (_req, res) => {
    try {
      const data = await cached('scale-systems', async () => {
        const all = await fetchBusinessFunctions(notion);
        const attention = all.filter((s) => SYSTEM_ATTENTION_STATUSES.includes(s.health));

        const ratio = (s) =>
          s.impact != null && s.effort ? s.impact / s.effort : (s.impact != null ? s.impact : 0);
        const score = (s) =>
          (SYSTEM_HEALTH_RANK[s.health] || 0) * 100 +
          (SYSTEM_PRIORITY_RANK[s.priority] || 0) * 10 +
          ratio(s);
        const quickWin = (s) =>
          s.impact != null && s.impact >= QUICK_WIN_MIN_IMPACT &&
          s.effort != null && s.effort > 0 && s.effort <= QUICK_WIN_MAX_EFFORT;

        attention.sort((a, b) => score(b) - score(a));
        const systems = attention.map((s) => ({ ...s, quickWin: quickWin(s) }));

        const counts = {
          total: all.length,
          attention: attention.length,
          brokenOrMissing: all.filter((s) => s.health === 'Broken' || s.health === 'Missing').length,
          critical: attention.filter((s) => s.priority === 'Critical').length,
        };
        return { systems, counts, asOf: new Date().toISOString() };
      });
      res.json(data);
    } catch (err) {
      console.error('scale/systems error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
