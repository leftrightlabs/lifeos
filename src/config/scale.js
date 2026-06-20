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
];
