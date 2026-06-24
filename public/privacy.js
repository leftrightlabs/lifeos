/* LRL OS — Privacy / demo control.
   Load this in <head> (before page scripts) on every page so it can:
   1. Apply the privacy class pre-paint (no flash of real data).
   2. Install a fetch interceptor that, in SAMPLE mode, serves coherent fake
      fixtures for GET /api/* and blocks every mutation (so demos never touch
      real Notion/Xero/etc. data).

   Three modes, persisted in localStorage['lrl-privacy']:
     off    — real data, fully visible.
     blur   — real data, sensitive numbers + names blurred (CSS).
     sample — fabricated demo data from window.LRL_SAMPLE (sample-data.js).

   The toggle BUTTON is rendered by shell.js (zone pages) / today.html, which
   call window.LRLPrivacy.cycle(). */
(function () {
  'use strict';

  var MODES = ['off', 'blur', 'sample'];

  function get() {
    try {
      var v = localStorage.getItem('lrl-privacy');
      return MODES.indexOf(v) >= 0 ? v : 'off';
    } catch (e) { return 'off'; }
  }

  // Apply the html class as early as possible to avoid an unblurred flash.
  function applyClass(mode) {
    var el = document.documentElement;
    el.classList.toggle('privacy-blur', mode === 'blur');
    el.classList.toggle('privacy-sample', mode === 'sample');
  }
  applyClass(get());

  function jsonResponse(obj) {
    return new Response(JSON.stringify(obj == null ? {} : obj), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  // Normalize a request URL to a path (no origin, no query) for fixture lookup.
  function pathOf(url) {
    return String(url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/\/$/, '') || '/';
  }

  // ── SAMPLE-DATA FABRICATION ──
  // In sample mode we keep the REAL response SHAPE (so no card can break or blank)
  // but replace sensitive NUMBERS with plausible made-up values. Magnitudes are
  // anchored to the real value so gauges/bars stay coherent and you get a natural
  // mix of good and not-so-good. Names/text (LEGO, Sundae, clients) pass through.

  // Leaf keys to never touch (ids, dates, geometry, enumerable position, labels).
  var KEEP_KEY = /(id$|_id|guid|uuid|timestamp|^ts$|time$|date|created|updated|year|lat|lng|lon|index|^idx$|order|width|height|x$|y$|color|hex|rgb|url|href|email|status|state|key|type|tone|cls|label|name|title)/i;

  function hash01(s) {
    var h = 2166136261;
    for (var i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  }
  // Classify a value by its full PATH (so nested keys like qtdRevenue.actual or
  // runway.months inherit the right concept). Returns a concept or null.
  function classify(p) {
    p = String(p).toLowerCase();
    // Money first — so burnRate/runRate-style keys aren't mistaken for percentages.
    if (/\.ar$|\.ap$|cash|revenue|balance|owed|invoice|receivable|payable|mrr|arr|net\b|mtdnet|collected|invoiced|price|cost|profit|payroll|expense|amount|burn|credit|goal|deal|pipeline|\bvalue$|\bval$/.test(p)) return 'money';
    if (/pct|percent|rate|score|progress|util/.test(p)) return 'pct';
    if (/month/.test(p)) return 'month';
    if (/week/.test(p)) return 'week';
    if (/day|days/.test(p)) return 'day';
    if (/hour|est$|logged/.test(p)) return 'hour';
    if (/count|num$|\.n$|total|overdue|atrisk|risk|stressed|shipped|streak|blocks|points|open|done|sent|opens|clicks|views|reach|followers|subscribers|qty|deals|touch|new\b|cards|accounts/.test(p)) return 'count';
    return null;
  }
  // Fabricate a plausible value for a concept, seeded so it's stable within a load.
  function fakeByConcept(c, n, seed) {
    if (!isFinite(n) || Math.abs(n) > 1e11) return n;   // timestamp-ish → keep
    var r = hash01(seed), neg = n < 0, isInt = Number.isInteger(n);
    switch (c) {
      case 'pct':   return (Math.abs(n) <= 1.0001 && !isInt) ? Math.round((0.18 + r * 0.74) * 100) / 100 : Math.round(18 + r * 74);
      case 'money': { var big = hash01(seed + 'b') < 0.6; var d = big ? Math.round(4 + r * 176) * 1000 : Math.round(300 + r * 8700); return neg ? -d : d; }
      case 'month': return Math.round(2 + r * 12);
      case 'week':  return Math.round(2 + r * 26);
      case 'day':   return Math.round(1 + r * 40);
      case 'hour':  { var h = Math.round((1 + r * 32) * 2) / 2; return isInt ? Math.round(h) : h; }
      case 'count': return Math.round(r * 26);
    }
    return n;
  }
  // Fake-but-stable names for demo mode. Same real string always maps to the same
  // fake one (deterministic), so the demo stays internally consistent.
  var PEOPLE = ['Jordan Avery', 'Casey Monroe', 'Riley Hawkins', 'Morgan Ellis', 'Taylor Brooks', 'Devin Parker', 'Quinn Sutton', 'Harper Nolan', 'Avery Sinclair', 'Reese Caldwell', 'Sloane Whitman', 'Emerson Vale'];
  var COMPANIES = ['Brightwave Studio', 'Northpeak Wellness', 'Harbor & Co', 'Vellum Press', 'Sunset Yoga Collective', 'Maple Lane Books', 'Ridgeline Coaching', 'Lumen Health', 'Cobalt & Finch', 'Wildgrove Media', 'Cedar & Sage', 'Atlas Forge'];
  var SERVICES = ['Brand Refresh', 'Website Build', 'Launch Sprint', 'Rebrand', 'Funnel Buildout', 'Content System', 'Identity Design', 'Site Redesign', 'Brand Sprint'];
  function pick(list, s) { return list[Math.floor(hash01(s) * list.length) % list.length]; }
  function fakePerson(s) { return pick(PEOPLE, 'p' + s); }
  function fakeCompanyProject(s) { return pick(COMPANIES, 'c' + s) + ' — ' + pick(SERVICES, 's' + s); }

  // Decide whether a string value is a client/person identity to scrub, based on
  // its PATH (so it works for array elements too). Returns the fake name or null.
  // LRL's own project names (LEGO, Sundae, internal rocks/issues) are NOT scrubbed.
  function scrubName(path, val) {
    if (!val || typeof val !== 'string' || val.length > 120) return null;
    var p = String(path).toLowerCase();
    // Never touch ids/urls/emails/status/enums — they aren't display names.
    if (/id$|ids?\.|_id|guid|uuid|url|href|email|status|^.*\.type$/.test(p)) return null;
    // Person-name fields, anywhere (assignee/owner/sender/etc.).
    if (/assignedtoname|assignee|assigned$|\bowner\b|\.by$|sender|loggedby|author|\.av\.name$|contactname/.test(p)) return fakePerson(val);
    // Convert pipeline: deal names → fake "Company — Service"; contact names → person.
    if (/\/api\/convert/.test(p)) {
      if (/\.deals?\b/.test(p) && /\.name$/.test(p)) return fakeCompanyProject(val);
      if (/\.contacts?\b/.test(p) && /\.name$/.test(p)) return fakePerson(val);
    }
    // Deliver is client work: project names → fake "Company — Service".
    if (/\/api\/deliver/.test(p) && /projectname$/.test(p)) return fakeCompanyProject(val);
    return null;
  }

  function fakeMoneyStr(m, seed) {
    var suffix = (m.match(/[kKmM]\b/) || [''])[0];
    var r = hash01(seed + m);
    var n = suffix ? (suffix.toLowerCase() === 'm' ? (1 + r * 9).toFixed(1) : Math.round(5 + r * 295))
                   : Math.round(500 + r * 240000).toLocaleString();
    return '$' + n + suffix;
  }
  function fab(node, path) {
    if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) node[i] = fab(node[i], path + '.' + i); return node; }
    if (node && typeof node === 'object') { for (var k in node) if (Object.prototype.hasOwnProperty.call(node, k)) node[k] = fabValue(k, node[k], path + '.' + k); return node; }
    return node;
  }
  function fabValue(key, val, path) {
    if (typeof val === 'number') {
      if (KEEP_KEY.test(key)) return val;            // ids/dates/geometry → keep
      var c = classify(path);
      return c ? fakeByConcept(c, val, path) : val;  // unknown numbers stay real (safe)
    }
    if (typeof val === 'string') {
      var fakeName = scrubName(path, val);
      if (fakeName != null) return fakeName;
      return val.replace(/\$\s?[\d,]+(?:\.\d+)?\s?[kKmM]?/g, function (m) { return fakeMoneyStr(m, path); });
    }
    if (val && typeof val === 'object') return fab(val, path);
    return val;
  }

  // ── FETCH INTERCEPTOR ──
  // Installed once, always; only acts when the current mode is 'sample'.
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  if (realFetch) {
    window.fetch = function (input, init) {
      try {
        if (get() === 'sample') {
          var url = (typeof input === 'string') ? input : (input && input.url) || '';
          var path = pathOf(url);
          if (path.indexOf('/api/') === 0) {
            var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            // Never mutate real data during a demo — fake a success.
            if (method !== 'GET') return Promise.resolve(jsonResponse({ ok: true, demo: true }));
            // Explicit curated fixture wins (sample-data.js → window.LRL_SAMPLE).
            var fx = (window.LRL_SAMPLE || {})[path];
            if (fx !== undefined) return Promise.resolve(jsonResponse(typeof fx === 'function' ? fx() : fx));
            // Otherwise fetch the real response and fabricate its numbers in place.
            return realFetch(input, init).then(function (resp) {
              return resp.clone().json().then(function (data) {
                return jsonResponse(fab(data, path));
              }).catch(function () { return resp; });   // non-JSON → pass through
            }).catch(function () { return jsonResponse({}); });
          }
        }
      } catch (e) { /* fall through to real fetch */ }
      return realFetch(input, init);
    };
  }

  // ── PUBLIC API ──
  function set(mode, opts) {
    if (MODES.indexOf(mode) < 0) mode = 'off';
    var prev = get();
    try { localStorage.setItem('lrl-privacy', mode); } catch (e) {}
    applyClass(mode);
    sync(mode);
    // Entering OR leaving sample changes the data source, so reload to re-run
    // every fetch through (or around) the interceptor.
    var crossesSample = (mode === 'sample') !== (prev === 'sample');
    if (crossesSample && !(opts && opts.noReload)) { location.reload(); return; }
    if (typeof window.onPrivacyChange === 'function') window.onPrivacyChange(mode);
  }

  function cycle() { set(MODES[(MODES.indexOf(get()) + 1) % MODES.length]); }

  // Update every privacy button on the page to reflect the current mode.
  function sync(mode) {
    mode = mode || get();
    var btns = document.querySelectorAll('.privacy-btn');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.dataset.privacy = mode;
      b.setAttribute('aria-label', 'Privacy: ' + mode + ' (click to change)');
      b.title = mode === 'off' ? 'Privacy off — click to blur' :
                mode === 'blur' ? 'Blurred — click for demo data' :
                'Demo data — click to turn off';
      var label = b.querySelector('.privacy-label');
      if (label) label.textContent = mode === 'sample' ? 'DEMO' : mode === 'blur' ? 'BLUR' : '';
    }
  }

  window.LRLPrivacy = { get: get, set: set, cycle: cycle, sync: sync, MODES: MODES };

  // Keep buttons in sync once the DOM (and shell-rendered button) is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { sync(get()); });
  } else { sync(get()); }
})();
