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

  // ── Open in Notion: app-first with a browser fallback ──
  // shell.js loads last on every page, so these become the canonical globals
  // (overriding any page-local copies). Default: hand off to the Notion app via
  // the notion:// scheme. If the app grabs focus we're done; if nothing takes
  // over within a short beat (app not installed), fall back to the web — a new
  // tab when allowed, same tab if the popup is blocked.
  window.toNotionLink = function (url) {
    if (!url) return url;
    var m = String(url).match(/([a-f0-9]{32})/i);
    if (m) return 'notion://www.notion.so/' + m[1];
    if (url.indexOf('https://www.notion.so/') === 0) return url.replace('https://', 'notion://');
    if (url.indexOf('https://app.notion.com/') === 0) return url.replace('https://app.notion.com/', 'notion://www.notion.so/');
    return url;
  };
  window.openNotion = function (url) {
    if (!url) return;
    var deep = window.toNotionLink(url);
    if (!deep || deep.indexOf('notion://') !== 0) { window.open(url, '_blank', 'noopener'); return; }
    var handled = false;
    var cancel = function () { handled = true; };
    var vis = function () { if (document.hidden) handled = true; };
    window.addEventListener('blur', cancel, { once: true });
    document.addEventListener('visibilitychange', vis, { once: true });
    setTimeout(function () {
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', vis);
      if (!handled && !document.hidden) {
        var w = window.open(url, '_blank', 'noopener');
        if (!w) window.location.href = url; // popup blocked → same tab
      }
    }, 1200);
    window.location.href = deep;
  };

  // ── NAV DATA ──
  var NAV_WORK = [
    { label: 'TODAY',      href: '/today' },
    { label: 'PLANNING',   href: '/planning' },
    { label: 'MESSAGES',   href: '/messages' },
    { sep: true },
    { domain: 'WORK' },
    { label: 'MARKETING',  href: '/marketing' },
    { label: 'SALES',      href: '/sales' },
    { label: 'PRODUCTION', href: '/production' },
    { label: 'SCALE',      href: '/scale' },
    { label: 'REFERENCE',  href: '/reference' },
  ];
  var NAV_PERSONAL = [
    { label: 'TODAY',      href: '/today' },
    { label: 'PLANNING',   href: '/planning' },
    { label: 'MESSAGES',   href: '/messages' },
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
    { label: 'PLANNING', href: '/planning' },
    { label: 'MESSAGES', href: '/messages' },
  ];

  // Lucide-style nav icons (stroke, currentColor) keyed by route.
  var NAV_ICONS = {
    '/today':     '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    '/messages':  '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
    '/planning':  '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="m9 13 2 2 4-4"/>',
    '/marketing': '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    '/sales':     '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/>',
    '/production':'<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
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
  // active tab is always visible (e.g. landing on /marketing while mode is 'all').
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

  // The shared app footer — same component on today + every zone page (matches the
  // today.html footer: theme · privacy · refresh · refreshed-stamp · log out).
  function footerHTML() {
    return '<div class="app-footer">' +
      '<button type="button" class="footer-btn" data-action="theme" onclick="window.LRLShell&&LRLShell.toggleTheme()" title="Toggle theme"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></button>' +
      privacyBtnHTML() +
      '<button type="button" class="footer-btn" data-action="refresh" onclick="window.LRLShell&&LRLShell.refresh()" title="Refresh">↻</button>' +
      '<span class="footer-stamp" id="footerStamp"></span>' +
      '<a class="footer-logout" href="/auth/logout" title="Log out">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
        '<span>Log out</span>' +
      '</a>' +
    '</div>';
  }

  // Theme toggle (parity with today's footer — toggles the .light class + swaps icon).
  function toggleTheme() {
    var isLight = document.documentElement.classList.toggle('light');
    var b = document.querySelector('.app-footer .footer-btn[data-action="theme"]');
    if (b) { b.innerHTML = isLight ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>'; b.classList.toggle('active', isLight); }
  }

  // "Refreshed <date> · <time>" stamp.
  function stampRefreshed() {
    var el = document.getElementById('footerStamp');
    if (!el) return;
    var now = new Date();
    var mo = now.toLocaleString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    var ti = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    el.textContent = 'Refreshed ' + mo + ' · ' + ti;
  }

  // Refresh button. A page can expose window.lrlFooterRefresh() for an in-place data
  // reload (today does); otherwise we fall back to a full page reload.
  function refresh() {
    var b = document.querySelector('.app-footer .footer-btn[data-action="refresh"]');
    if (!window.lrlFooterRefresh) { location.reload(); return; }
    if (b) { b.innerHTML = '<span class="spin">↻</span>'; b.disabled = true; }
    Promise.resolve().then(window.lrlFooterRefresh).then(stampRefreshed).catch(function (e) { console.error('footer refresh', e); }).then(function () {
      if (b) { b.innerHTML = '↻'; b.disabled = false; }
    });
  }

  // Append the shared footer once, on every shell.js page (today + zones), regardless
  // of whether the topbar shell is mounted. Edit footerHTML/cards.css to restyle once.
  function mountFooter() {
    if (document.querySelector('.app-footer')) return;
    var ft = document.createElement('div');
    ft.innerHTML = footerHTML();
    document.body.appendChild(ft.firstChild);
    var tb = document.querySelector('.app-footer .footer-btn[data-action="theme"]');
    if (tb && document.documentElement.classList.contains('light')) { tb.textContent = '☀️'; tb.classList.add('active'); }
    stampRefreshed();
    if (window.LRLPrivacy && LRLPrivacy.sync) LRLPrivacy.sync();
  }

  // Live date + quarter + days-left, shown in the top bar on every page.
  function metaText() {
    var now = new Date();
    var wd = now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    var mo = now.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    var q = Math.floor(now.getMonth() / 3) + 1;
    var qEnd = new Date(now.getFullYear(), q * 3, 0);          // last day of the quarter
    var daysLeft = Math.max(0, Math.ceil((qEnd - now) / 86400000));
    return wd + ' ' + mo + ' ' + now.getDate() + ' · Q' + q + ' · ' + daysLeft + ' DAYS LEFT';
  }

  function shellHTML() {
    return '' +
      '<div class="topbar-wrap"><div class="topbar">' +
        '<div class="topbar-left">' +
          '<a href="/today" class="logo"><span class="logo-mark">◆</span> LRL OS</a>' +
          '<span class="app-meta" id="appMeta">' + metaText() + '</span>' +
        '</div>' +
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
  // Normalize the current path to a nav href, e.g. '/marketing/' -> '/marketing'.
  function activeHref() {
    var p = (location.pathname || '/').replace(/\/+$/, '').replace(/\.html$/, '');
    if (p === '' || p === '/') p = '/today';
    return p;
  }

  function mount() {
    var host = document.getElementById('lrl-shell');
    if (!host) return;

    host.innerHTML = shellHTML();
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
    metaText: metaText,
    // ME mode (global "assigned to me" filter)
    meMode: getMe,
    setMe: setMe,
    toggleMe: toggleMe,
    syncMePill: syncMePill,
    // Shared footer
    mountFooter: mountFooter,
    toggleTheme: toggleTheme,
    refresh: refresh,
    stampRefreshed: stampRefreshed,
  };

  // mount() draws the topbar/nav only when a #lrl-shell host exists (zone pages);
  // mountFooter() runs on every shell.js page (today included) so the footer is global.
  function init() { mount(); mountFooter(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
