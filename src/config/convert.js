// Sales / Convert config — data-source IDs, stage taxonomy, pulse + follow-up
// constants. Pure data, no runtime deps. Imported by the routes + Notion provider.

export const SALES_PIPELINE_DS = 'cec1b3e9-791d-4a55-bd80-b0226552f543';
export const SALES_PRODUCTS_DS = '6e492b13-f5c7-4b8f-812e-3e05f1dc48ee';
// Canonical funnel order + grouping (open vs won vs lost). Mirrors the
// Pipeline Status options in Notion's SALES PIPELINE board.
export const SALES_STAGES = [
  { name: 'New / To Qualify', group: 'open' },
  { name: 'Engaged / In Conversation', group: 'open' },
  { name: 'Consult Scheduled', group: 'open' },
  { name: 'No Show / Reschedule', group: 'open' },
  { name: 'Consult Completed', group: 'open' },
  { name: 'Build Scope', group: 'open' },
  { name: 'Decision Pending', group: 'open' },
  { name: 'On Hold', group: 'open' },
  { name: 'Closed Won', group: 'won' },
  { name: 'Closed Lost', group: 'lost' },
];
export const SALES_STAGE_INDEX = Object.fromEntries(SALES_STAGES.map((s, i) => [s.name, i]));
export const SALES_STAGE_GROUP = Object.fromEntries(SALES_STAGES.map((s) => [s.name, s.group]));
export const CONTACTS_DS = '28d458f0-8cd9-8178-b291-000bdc3fb399';
export const SALES_ACTIVITY_DS = 'b5d8dd3c-303b-49c2-96cf-23b2cfa476ae';
export const SPEAKING_OUTREACH_DS = '96f47e7e-9797-4d96-9abb-e5dcb7df13a3';
// Speaking pipeline (the "Stages" tab): funnel order + active-vs-closed grouping.
// Mirrors the Status options in Notion's SPEAKING OUTREACH board.
export const SPEAKING_STAGES = [
  { name: 'Researching', group: 'open' },
  { name: 'Pitched', group: 'open' },
  { name: 'Following Up', group: 'open' },
  { name: 'Scheduled', group: 'open' },
  { name: 'Completed', group: 'closed' },
  { name: 'Not A Fit', group: 'closed' },
  { name: 'Declined', group: 'closed' },
  { name: 'No Response', group: 'closed' },
];
export const TRINA_USER_ID = 'eea4c3fe-668e-4ce7-a8e8-30314ff7f986';
export const PULSE_RELATIONSHIPS = ['Alumni', 'Network Partner', 'Lead', 'Active Client'];
// Touchpoint types that count as low-lift "pulse" outreach (vs. real sales moves)
export const PULSE_TOUCHPOINTS = ['👋 General Touchpoint', '🙏 Thank You / Nurture'];
export const PULSE_GOAL = 85;
export const SALES_GOAL = 15;
// Contact Stages that represent an active sales conversation worth chasing.
export const CONVERT_FOLLOWUP_STAGES = [
  '02. First touch sent', '03. In conversation', '04. Follow-up pending',
  '05. Call invited', '06. Call booked', '07. Reconnected',
  '08. Needs identified', '09. Offer invited', '10. Proposal sent',
];
