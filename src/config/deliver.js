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
