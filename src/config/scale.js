// Scale zone config — Business Functions ("systems to fix") data source + mappings.
// The actual Notion table name stays as-is for accuracy (see the naming convention
// note in app-structure memory). A future non-Notion provider would map differently.

export const BUSINESS_FUNCTIONS_DS = 'd300f413-7fba-4cdb-a0ad-6536391e18e7';

// Health Status values that mean "needs attention" — mirrors the DB's built-in
// "Action Needed" view (everything that isn't Solid / Functional).
export const SYSTEM_ATTENTION_STATUSES = ['Broken', 'Missing', 'Needs Build', 'Needs Review'];

// Urgency + priority weights for ranking which systems to surface first.
export const SYSTEM_HEALTH_RANK = { Broken: 3, Missing: 3, 'Needs Build': 2, 'Needs Review': 1 };
export const SYSTEM_PRIORITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };

// A "quick win" = high impact, low effort (the mockup's framing).
export const QUICK_WIN_MIN_IMPACT = 4; // Impact Score is a 1-5 scale
export const QUICK_WIN_MAX_EFFORT = 2; // Effort to Fix is a 1-5 scale

// --- Scorecard off-track (VTO Scorecard scored against live systems) ---
export const VTO_SCORECARD_DS = 'c359c68c-02bb-4fae-b4cb-3a512e5eafab';
// Speaking engagements ("stages") — SPEAKING OUTREACH [DB]; "booked" = Booking Confirmed set.
export const SPEAKING_OUTREACH_DS = '96f47e7e-9797-4d96-9abb-e5dcb7df13a3';
// The "Source" select on each metric → which live actual the app computes.
// Only these are wired; rows with any other (or empty) Source are left out.
export const SCORECARD_SOURCES = [
  'Xero Revenue',
  'Xero Profit',
  'Xero Cash Capacity',
  'Convert Touchpoints',
  'Convert Deals Won',
  'Speaking Stages Booked',
  'Speaking Stages Pitched',
  'Speaking Stages Touchpoints',
];

// Scorecard Source → leading/lagging display type (BUILD-SPEC §7). A leading
// metric is an input the CEO can push this week; lagging is the outcome.
export const SCORECARD_SOURCE_TYPE = {
  'Convert Touchpoints': 'leading',
  'Convert Deals Won': 'lagging',
  'Speaking Stages Booked': 'lagging',
  'Speaking Stages Pitched': 'leading',
  'Speaking Stages Touchpoints': 'leading',
  'Xero Revenue': 'lagging',
  'Xero Profit': 'lagging',
  'Xero Cash Capacity': 'lagging',
  Manual: 'lagging',
};

// Scorecard leading→lagging pairs, by metric NAME (case-insensitive), shown as
// rows on the Scorecard tab: input on the left drives the outcome on the right.
// Pairs whose metric rows don't exist yet render as "not tracked yet" until added
// to the VTO Scorecard DB (and a data Source is wired for the actual).
export const SCORECARD_PAIRS = [
  ['Touchpoints', 'Deals Won'],
  ['Stages Pitched', 'Stages Booked'],
  ['Marketing Content Published', 'New Opt-Ins'],
  ['Stages Published', 'Leads Generated'],
  ['Web Care Plans Pitched', 'New Web Care Plans'],
];

// --- PULSE: IDS issue queue (ISSUES [DB]) ---
// The build spec lists the *database* id (2ce458f08cd980fb9eb6e194e9122386); the
// Notion API's dataSources.query needs the *data source* id, which differs — it's
// the collection id resolved from that database.
export const ISSUES_DS = '2ce458f0-8cd9-808a-92d3-000be8dd7983';
// Statuses that belong in the IDS queue, and the priority ordering for it.
export const ISSUE_QUEUE_STATUSES = ['Current', 'Agenda'];
export const ISSUE_PRIORITY_RANK = { URGENT: 3, HIGH: 2, NORMAL: 1, LOW: 0 };

// --- VTO: Quarterly Rocks (WORK PROJECTS [DB], ROCK checkbox) ---
// Status thresholds from a rock's % complete (BUILD-SPEC §9).
export function rockStatusFromPct(pct) {
  if (pct == null) return 'notStarted';
  if (pct >= 100) return 'complete';
  if (pct >= 70) return 'onTrack';
  if (pct >= 40) return 'atRisk';
  if (pct > 0) return 'offTrack';
  return 'notStarted';
}
