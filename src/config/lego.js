// LEGO (Personal) config — Notion data-source IDs for the LEGO command-center tab.
// Pure data, no runtime deps. Imported by the route + Notion provider.
// IDs are the underlying data-source (collection) IDs from the LEGO [DB]s.

export const LEGO_SETS_DS = '290458f0-8cd9-8162-8c45-000b3a0b9162';        // LEGO Sets [DB]
export const LEGO_MOCS_DS = '93d32b32-4320-40c1-a30e-8b24a14360b4';        // LEGO MOCS [DB]
export const LEGO_POSTS_DS = '3cf92c85-ee43-4925-8a49-7181abddab2b';       // LEGO Posts [DB]
export const LEGO_CHANNELS_DS = '42f8c38f-d860-40dd-86c2-039d44e0632a';    // LEGO Channels [DB]
export const LEGO_INSPIRATION_DS = '260458f0-8cd9-800f-8d0d-000b14b538a1'; // LEGO Inspiration [DB]
export const LEGO_SHOWS_DS = 'c0e7ee0c-b158-4738-ba59-59919544674e';       // LEGO SHOWS (conventions/events)
export const PROJECTS_DS = '265458f0-8cd9-814e-af0e-000bceaa7f80';         // PROJECTS [DB] (filtered to the LEGO focus)
export const LEGO_FOCUS_PAGE = '290458f0-8cd9-80e5-8bee-ec3ada91b5cc';     // 👻 LEGO page in FOCUS — target of PROJECTS.Area

// LEGO Sets Status values that count as physically owned (excludes Wishlist + Sold).
export const SET_STATUS_NOT_OWNED = ['Wishlist', 'Sold'];

// LEGO MOCS Status values in the "complete" group — i.e., a build that got finished.
export const MOC_STATUS_BUILT = ['Display Ready', 'On Loan', 'Gifted', 'Digital Render', 'Disassembled'];
// The "in progress" status — what we surface as an Active MOC.
export const MOC_STATUS_ACTIVE = 'Building';
