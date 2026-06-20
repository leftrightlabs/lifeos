// YNAB provider — net worth + a full Wealth summary (budget, age of money,
// cash/debt, savings goals) via the YNAB REST API + a Personal Access Token
// (YNAB_TOKEN). Budget via YNAB_BUDGET_ID (G's personal budget). Env read lazily
// (server's dotenv loads after imports). Balances are milliunits; liabilities negative.
const token = () => process.env.YNAB_TOKEN || '';
const budget = () => process.env.YNAB_BUDGET_ID || 'last-used';

export function ynabConfigured() { return !!token(); }

async function ynabGet(path) {
  const url = `https://api.ynab.com/v1/budgets/${encodeURIComponent(budget())}${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`YNAB ${r.status}: ${body.slice(0, 160)}`);
  }
  return (await r.json()).data;
}

const m = (x) => (x || 0) / 1000; // milliunits -> currency
const LIQUID = new Set(['checking', 'cash']); // "cash on hand" — savings is tracked separately as the emergency fund

export async function getNetWorth() {
  const data = await ynabGet('/accounts');
  const accounts = (data.accounts || []).filter((a) => !a.deleted && !a.closed);
  let assets = 0, liabilities = 0;
  for (const a of accounts) { const b = m(a.balance); if (b >= 0) assets += b; else liabilities += b; }
  return { netWorth: Math.round(assets + liabilities), assets: Math.round(assets), liabilities: Math.round(liabilities), accountCount: accounts.length, asOf: new Date().toISOString() };
}

// Full Wealth-tab summary: net worth, emergency fund (savings), this month's
// budget, age of money, cash vs debt, and savings goals (the "Dreams & Goals" group).
export async function getWealthSummary() {
  const [acc, mon, cat] = await Promise.all([ynabGet('/accounts'), ynabGet('/months/current'), ynabGet('/categories')]);

  const accounts = (acc.accounts || []).filter((a) => !a.deleted && !a.closed);
  // The WF "Priority Credit Line" is a securities-backed line of credit (borrowed
  // against investments to subsidize the business). YNAB has it typed as otherAsset
  // with a negative balance, so match it by name/type and keep it OUT of consumer
  // debt — Gretchen tracks it separately from cards + the car loan.
  const isLineOfCredit = (a) => a.type === 'lineOfCredit' || /credit line|line of credit/i.test(a.name || '');
  let assets = 0, liabilities = 0, cash = 0, savings = 0, investments = 0, lineOfCredit = 0, otherDebt = 0;
  for (const a of accounts) {
    const b = m(a.balance);
    if (b >= 0) assets += b; else liabilities += b;
    if (LIQUID.has(a.type)) cash += b;
    if (a.type === 'savings') savings += b;
    if (a.type === 'otherAsset' && b > 0) investments += b; // brokerage / retirement
    if (b < 0) { if (isLineOfCredit(a)) lineOfCredit += b; else otherDebt += b; }
  }

  const month = mon.month || {};

  const goals = [];
  for (const g of (cat.category_groups || [])) {
    if (g.hidden || g.deleted || !/dream|goal/i.test(g.name)) continue;
    for (const c of g.categories) {
      if (c.hidden || c.deleted || !c.goal_target) continue;
      const target = m(c.goal_target), bal = m(c.balance);
      goals.push({
        name: c.name,
        balance: Math.round(bal),
        target: Math.round(target),
        pct: c.goal_percentage_complete ?? (target > 0 ? Math.min(100, Math.round((bal / target) * 100)) : 0),
      });
    }
  }

  return {
    netWorth: Math.round(assets + liabilities),
    cash: Math.round(cash),
    savings: Math.round(savings),
    emergencyFund: Math.round(savings), // per Gretchen: savings account is the emergency cushion
    debt: Math.round(-liabilities), // total owed (kept for back-compat)
    otherDebt: Math.round(-otherDebt), // cards + car loan
    lineOfCredit: Math.round(-lineOfCredit), // securities-backed LOC (business)
    investments: Math.round(investments), // brokerage + retirement
    month: {
      income: Math.round(m(month.income)),
      budgeted: Math.round(m(month.budgeted)),
      spent: Math.round(Math.abs(m(month.activity))),
      toBeBudgeted: Math.round(m(month.to_be_budgeted)),
      ageOfMoney: month.age_of_money ?? null,
    },
    goals,
    asOf: new Date().toISOString(),
  };
}
