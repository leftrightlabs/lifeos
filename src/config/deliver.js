// Deliver zone config — Notion data sources + constants for the wired sections
// (Offer catalog health, Care-plan renewals). Project data comes from the
// shared projects board, not here.

// PRODUCTS [DB] — same data source the Convert product map uses.
export const PRODUCTS_DS = '6e492b13-f5c7-4b8f-812e-3e05f1dc48ee';
// WEB PROPERTIES [DB] — client sites + care plans.
export const WEB_PROPERTIES_DS = '2ff458f0-8cd9-815d-b2d1-000bb71f994c';

// The offer ladder, in customer-journey order (matches the Products "Categories" options).
export const OFFER_LADDER = ['GET CLEAR', 'GET NOTICED', 'GET PAID', 'GET SUPPORT'];

// Care-plan tiers that have room to upsell toward PLUS.
export const UPSELL_PLANS = ['LITE', 'BASIC'];
// Surface a renewal as "coming up" within this many days (or already past).
export const RENEWAL_HORIZON_DAYS = 60;

// ── Client-work delivery dashboard (the main /deliver view) ──────────────────
// Data sources (confirmed live). Dashless ids work with the Notion SDK.
export const TASKS_DS = '28c458f08cd9818599e7000bc2115872';     // TASKS [DB]
export const PROJECTS_DS = '28c458f08cd98131a475000b81db3c1b';  // PROJECTS [DB] (work)
export const TIME_LOG_DS = '476db980-1828-4803-ab89-b8ef9715db40'; // TIME LOG [DB]; back-relation prop = "Task"
export const PRODUCTION_AREA_ID = '28d458f0-8cd9-80f5-a97e-d61fc5e9d079'; // PROJECTS.AREA → "PRODUCTION"

// People (Notion user ids).
export const SUPPORT_USER_ID = '768b5e31-550d-4358-a762-b59a3018543e'; // support@ → "outsourced"
export const TRINA_USER_ID = 'eea4c3fe-668e-4ce7-a8e8-30314ff7f986';

// A task counts as a "client wait" (calm condition #3) when its Waiting select
// is one of these. Other Waiting values (Third-Party, Paused, Delegate, Team,
// Unscoped Request) still show in "Waiting on others" but don't gate calm on
// the client-stale rule.
export const CLIENT_WAITING = ['Client Response', 'Client Approval'];
export const WAIT_STALE_DAYS = 7;     // condition #3 threshold
export const ATRISK_MARGIN = 15;      // §6: flag when time_used% − work_done% ≥ this points

// "Ready to bill" = Invoice multi-select carries one of these AND not yet Invoiced.
export const INVOICE_READY = ['Unbilled Activity', 'Invoice on Completion'];
export const INVOICE_DONE = 'Invoiced';

// One Thing scoring weights (§7).
export const SCORE_WEIGHTS = { urgency: 0.30, blocking: 0.30, risk: 0.25, staleness: 0.15 };
