// YNAB provider — net worth via the YNAB REST API + a Personal Access Token
// (YNAB_TOKEN in .env; budget via YNAB_BUDGET_ID, default the special "last-used").
// YNAB stores balances in milliunits and liability balances as negative, so the
// signed sum of open, non-deleted account balances IS net worth.
// Env read lazily (server's dotenv loads after imports).
const token = () => process.env.YNAB_TOKEN || '';
const budget = () => process.env.YNAB_BUDGET_ID || 'last-used';

export function ynabConfigured() { return !!token(); }

export async function getNetWorth() {
  const url = `https://api.ynab.com/v1/budgets/${encodeURIComponent(budget())}/accounts`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`YNAB ${r.status}: ${body.slice(0, 160)}`);
  }
  const data = await r.json();
  const accounts = (data.data?.accounts || []).filter((a) => !a.deleted && !a.closed);
  let assets = 0, liabilities = 0;
  for (const a of accounts) {
    const bal = (a.balance || 0) / 1000; // milliunits -> currency units
    if (bal >= 0) assets += bal; else liabilities += bal;
  }
  return {
    netWorth: Math.round(assets + liabilities),
    assets: Math.round(assets),
    liabilities: Math.round(liabilities), // negative
    accountCount: accounts.length,
    asOf: new Date().toISOString(),
  };
}
