/* LRL OS — Sample / demo data overrides.
   Privacy "sample" mode (privacy.js) fabricates fake-but-coherent NUMBERS over
   the real response of every /api/* GET, so all pages demo safely with made-up
   figures while keeping real names (LEGO, Sundae, etc.).

   This file is for OPTIONAL curated overrides: if you want a specific endpoint to
   return a hand-crafted payload in demo mode instead of the auto-fabricated one,
   add it here keyed by its path (no query string). Example:

     window.LRL_SAMPLE['/api/convert'] = {
       asOf: new Date().toISOString(), quarterLabel: 'Q2 2026',
       deals: [{ id:'d1', name:'LEGO Masters — Brand Sprint', stage:'Proposal', value:48000, ... }],
       ...
     };

   Anything NOT listed here is auto-fabricated from the live shape, so cards can
   never blank out. Mutations (POST/PATCH/DELETE) are always faked in demo mode. */
window.LRL_SAMPLE = window.LRL_SAMPLE || {};
