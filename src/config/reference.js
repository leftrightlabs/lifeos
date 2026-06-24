// Reference zone config — universal search across Notion / Gmail / Drive /
// Contacts. Pure data, no runtime deps.

// Known data sources.
export const CONTACTS_DS = '28d458f0-8cd9-8178-b291-000bdc3fb399'; // CONTACTS [DB] (work)

// Confirmed data_source_ids (resolved from the DB links Gretchen sent).
export const PLAYBOOK_DS = '0b89df5d-fd80-468f-b295-b27f35128f90';      // PLAYBOOK [DB] — work pinned docs
export const NOTES_DS = '';                                            // personal pinned docs — no DB provided yet
export const TESTIMONIALS_DS = '57dd02a5-68cb-4b83-bd38-15aa4ddd3ce4'; // TESTIMONIALS [DB]
export const PEOPLE_DS = '265458f0-8cd9-819b-a23d-000b8013ea0b';       // PEOPLE [DB] — personal contacts

// The "favorited/pinned" checkbox property — confirmed "Favorite" (not "Favorited")
// in both PLAYBOOK and TESTIMONIALS.
export const PINNED_PROP = { playbook: 'Favorite', notes: 'Favorite' };

// Per-source result caps (BUILD-SPEC §4).
export const CAPS = { notion: 10, drive: 8, slack: 8, gmail: 8, contacts: 8 };

// Notion database_id (no dashes, as page.parent.database_id returns) → type label.
// Used to label universal-search hits by which DB they came from.
export const NOTION_DB_TYPE = {
  // filled opportunistically; unknown DBs fall back to 'Doc'
};

// Google Drive mimeType → type label (BUILD-SPEC §5).
export const DRIVE_TYPE = {
  'application/vnd.google-apps.presentation': 'Deck',
  'application/vnd.google-apps.spreadsheet': 'Sheet',
  'application/vnd.google-apps.document': 'Doc',
  'application/vnd.google-apps.folder': 'Folder',
  'application/pdf': 'PDF',
};
