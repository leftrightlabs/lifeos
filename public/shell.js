/* LRL OS — Shared app shell (topbar + nav).
   Single source of truth for the top bar, navigation, mode toggle, and icons.
   Every page renders the same chrome from this file so they never drift.

   Two ways to use it:
   • Zone pages: drop `<div id="lrl-shell"></div>` where the topbar/nav goes and
     include this script. It auto-mounts, derives the active tab from the URL,
     reads the mode from localStorage, fetches /api/me for the personal gate, and
     wires the mode toggle. Pages that filter their content by mode can define
     `window.onShellModeChange = fn` to react.
   • today.html: consumes the exported nav data/render via window.LRLShell while
     keeping its own richer mode logic (weekend screen, streaks, FAB color). */
(function () {
  'use strict';

  // ── NAV DATA ──
  var NAV_WORK = [
    { label: 'TODAY',      href: '/today' },
    { label: 'MESSAGES',   href: '/messages' },
    { label: 'EXECUTE',    href: '/execute' },
    { sep: true },
    { domain: 'WORK' },
    { label: 'ATTRACT',    href: '/attract' },
    { label: 'CONVERT',    href: '/convert' },
    { label: 'DELIVER',    href: '/deliver' },
    { label: 'SCALE',      href: '/scale' },
    { label: 'REFERENCE',  href: '/reference' },
  ];
  var NAV_PERSONAL = [
    { label: 'TODAY',      href: '/today' },
    { label: 'MESSAGES',   href: '/messages' },
    { label: 'EXECUTE',    href: '/execute' },
    { label: 'REFERENCE',  href: '/reference' },
    { sep: true },
    { domain: 'LIFE' },
    { label: 'HEALTH',         href: '/health' },
    { label: 'WEALTH',         href: '/wealth' },
    { label: 'LEGO',           href: '/lego' },
    { label: 'RELATIONSHIPS',  href: '/relationships' },
  ];
  var NAV_ALL = [
    { label: 'TODAY',    href: '/today' },
    { label: 'MESSAGES', href: '/messages' },
    { label: 'EXECUTE',  href: '/execute' },
  ];

  // Lucide-style nav icons (stroke, currentColor) keyed by route.
  var NAV_ICONS = {
    '/today':     '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    '/messages':  '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
    '/execute':   '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="m9 13 2 2 4-4"/>',
    '/attract':   '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    '/convert':   '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    '/deliver':   '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>',
    '/scale':     '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    '/reference': '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    '/health':    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    '/wealth':    '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
    '/lego':      '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    '/relationships': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  };

  function navSvg(href) {
    var p = NAV_ICONS[href];
    if (!p) return '';
    return '<span class="nav-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg></span>';
  }

  // ── MODE ──
  var IS_WEEKEND = [0, 6].indexOf(new Date().getDay()) !== -1;

  function getMode() {
    try {
      var m = localStorage.getItem('lrl-mode');
      if (m === 'work' || m === 'all' || m === 'personal') return m;
    } catch (e) {}
    return IS_WEEKEND ? 'personal' : 'all';
  }

  function listForMode(mode) {
    return mode === 'personal' ? NAV_PERSONAL : mode === 'all' ? NAV_ALL : NAV_WORK;
  }

  // ── ME MODE ──
  // A global "show only items assigned to me" filter. Persists across pages and
  // both view modes (work/personal); pages react via window.onMeModeChange(on).
  function getMe() {
    try { return localStorage.getItem('lrl-me-mode') === '1'; } catch (e) { return false; }
  }
  function setMe(on) {
    on = !!on;
    try { localStorage.setItem('lrl-me-mode', on ? '1' : '0'); } catch (e) {}
    syncMePill(on);
    if (typeof window.onMeModeChange === 'function') window.onMeModeChange(on);
  }
  function toggleMe() { setMe(!getMe()); }
  function syncMePill(on, root) {
    var scope = root || document;
    var pills = scope.querySelectorAll('.me-pill');
    for (var i = 0; i < pills.length; i++) {
      pills[i].classList.toggle('active', !!on);
      if (pills[i].setAttribute) pills[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function hasHref(list, href) {
    for (var i = 0; i < list.length; i++) if (list[i].href === href) return true;
    return false;
  }

  // Which nav list to actually render: start from the mode's list, but if the
  // page we're on isn't in it, fall back to whichever list contains it so the
  // active tab is always visible (e.g. landing on /attract while mode is 'all').
  function pickList(mode, activeHref) {
    var list = listForMode(mode);
    if (!activeHref || hasHref(list, activeHref)) return list;
    if (hasHref(NAV_WORK, activeHref)) return NAV_WORK;
    if (hasHref(NAV_PERSONAL, activeHref)) return NAV_PERSONAL;
    return list;
  }

  // ── MARKUP ──
  function modeToggleHTML() {
    return '' +
      '<div class="mode-toggle" id="modeToggle">' +
        '<button class="mode-btn" data-mode="work" title="Work mode">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>' +
        '</button>' +
        '<button class="mode-btn" data-mode="personal" title="Personal mode">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>' +
        '</button>' +
      '</div>';
  }

  // Triple-state privacy toggle (off → blur → sample). Logic lives in privacy.js
  // (window.LRLPrivacy). Rendered in the shared footer so it sits in the same place
  // (the footer) on every page, matching today.html.
  function privacyBtnHTML() {
    return '<button type="button" class="footer-btn privacy-btn" id="privacyBtn" title="Privacy" onclick="window.LRLPrivacy&&LRLPrivacy.cycle()">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>' +
      '<span class="privacy-label"></span>' +
    '</button>';
  }

  function footerHTML() {
    return '<div class="app-footer">' + privacyBtnHTML() + '</div>';
  }

  function shellHTML() {
    return '' +
      '<div class="topbar-wrap"><div class="topbar">' +
        '<a href="/today" class="logo"><span class="logo-mark">◆</span> LRL OS</a>' +
        '<div class="topbar-right">' +
          modeToggleHTML() +
          '<button type="button" class="me-pill" id="mePill" aria-pressed="false" title="Show only items assigned to me">ME</button>' +
        '</div>' +
      '</div></div>' +
      '<div class="nav-wrap"><nav class="nav" id="nav"></nav></div>';
  }

  // Render the nav links into `navEl`. opts: { mode, active, canPersonal }.
  function renderNav(navEl, opts) {
    if (!navEl) return;
    opts = opts || {};
    var mode = opts.mode || getMode();
    var active = opts.active;
    var canPersonal = opts.canPersonal !== false;
    var items = pickList(mode, active);
    // Team members only have work zones — domain labels/separators divide nothing.
    if (!canPersonal) items = items.filter(function (it) { return !it.sep && !it.domain; });
    navEl.innerHTML = items.map(function (item) {
      if (item.sep) return '<div class="nav-sep"></div>';
      if (item.domain) return '<span class="nav-domain">' + item.domain + '</span>';
      var isActive = active && item.href === active;
      return '<a href="' + item.href + '" class="nav-btn' + (isActive ? ' active' : '') + '">' + navSvg(item.href) + item.label + '</a>';
    }).join('');
  }

  function syncModeButtons(mode, root) {
    var scope = root || document;
    var btns = scope.querySelectorAll('#modeToggle .mode-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.mode === mode);
    }
  }

  // ── ZONE-PAGE MOUNT ──
  // Normalize the current path to a nav href, e.g. '/attract/' -> '/attract'.
  function activeHref() {
    var p = (location.pathname || '/').replace(/\/+$/, '').replace(/\.html$/, '');
    if (p === '' || p === '/') p = '/today';
    return p;
  }

  function mount() {
    var host = document.getElementById('lrl-shell');
    if (!host) return;

    host.innerHTML = shellHTML();
    // Shared footer (privacy toggle) at the end of the page — same spot as today.html.
    if (!document.querySelector('.app-footer')) {
      var ft = document.createElement('div');
      ft.innerHTML = footerHTML();
      document.body.appendChild(ft.firstChild);
    }
    var navEl = document.getElementById('nav');
    var active = activeHref();
    var state = { mode: getMode(), canPersonal: true, active: active };

    function paint() {
      renderNav(navEl, state);
      syncModeButtons(state.mode);
    }

    // Repaint and notify content-aware pages (e.g. messages filters by mode).
    function applyMode() {
      paint();
      if (typeof window.onShellModeChange === 'function') window.onShellModeChange(state.mode);
    }

    // Default toggle: deselecting the active mode returns to ALL. If switching to
    // a mode whose nav doesn't include the current page (e.g. clicking PERSONAL
    // while on a work zone), go home to /today where that mode applies; otherwise
    // re-render in place and let the page react via onShellModeChange.
    function onToggle(m) {
      var next = state.mode === m ? 'all' : m;
      try { localStorage.setItem('lrl-mode', next); } catch (e) {}
      state.mode = next;
      if (!hasHref(listForMode(next), active)) {
        window.location = '/today';
        return;
      }
      paint();
      if (typeof window.onShellModeChange === 'function') window.onShellModeChange(next);
    }

    host.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var btn = e.target.closest('.mode-btn');
      if (btn && btn.dataset.mode) { onToggle(btn.dataset.mode); return; }
      if (e.target.closest('.me-pill')) toggleMe();
    });

    applyMode();
    // Sync the ME pill and notify the page of the persisted me-mode on load.
    syncMePill(getMe());
    if (typeof window.onMeModeChange === 'function') window.onMeModeChange(getMe());
    // Reflect the persisted privacy mode on the shell-rendered button.
    if (window.LRLPrivacy) window.LRLPrivacy.sync();

    // Refine the personal gate from the server, then re-render if it changed.
    fetch('/api/me').then(function (r) { return r.json(); }).then(function (me) {
      if (me && (me.personalEnabled === true || me.role === 'owner')) {
        state.canPersonal = true;
      } else if (me) {
        state.canPersonal = false;
        // Team members are work-only: hide the toggle and force work mode.
        var toggle = document.getElementById('modeToggle');
        if (toggle) toggle.style.display = 'none';
        if (state.mode !== 'work') {
          state.mode = 'work';
          try { localStorage.setItem('lrl-mode', 'work'); } catch (e) {}
        }
      }
      applyMode();
    }).catch(function () {});
  }

  // ── EXPORTS ──
  window.LRLShell = {
    NAV_WORK: NAV_WORK,
    NAV_PERSONAL: NAV_PERSONAL,
    NAV_ALL: NAV_ALL,
    NAV_ICONS: NAV_ICONS,
    navSvg: navSvg,
    listForMode: listForMode,
    pickList: pickList,
    renderNav: renderNav,
    syncModeButtons: syncModeButtons,
    getMode: getMode,
    modeToggleHTML: modeToggleHTML,
    // ME mode (global "assigned to me" filter)
    meMode: getMe,
    setMe: setMe,
    toggleMe: toggleMe,
    syncMePill: syncMePill,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
