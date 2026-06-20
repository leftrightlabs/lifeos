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
