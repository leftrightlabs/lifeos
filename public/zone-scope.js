// Per-user + per-mode scoping for the zone pages (the static-shell pages that
// share tokens.css + app.css). Two jobs:
//   1. Gate by role — team members (personalEnabled=false) get a work-only view:
//      the ALL/PERSONAL toggles stay hidden and the LIFE zones drop out.
//   2. Mode toggle — switch WORK/ALL/PERSONAL *in place* (reload the current
//      zone page in the new mode) instead of jumping to the index home. This
//      mirrors how the toggle behaves on the Today page.
// Fails open to the owner's ALL view on error.
(function () {
  const LIFE = ['/health', '/wealth', '/lego', '/relationships'];
  const WORK = ['/marketing', '/sales', '/production', '/scale'];
  const toggle = document.querySelector('.mode-toggle');

  // Lucide-style nav icons (stroke, currentColor) keyed by route — mirrors the
  // home page's iconed nav and the Today view.
  const NAV_ICONS = {
    '/today':    '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    '/messages': '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
    '/execute':  '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="m9 13 2 2 4-4"/>',
    '/marketing':'<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    '/sales':    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    '/production':'<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>',
    '/scale':    '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    '/reference':'<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    '/health':   '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    '/wealth':   '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
    '/lego':     '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    '/relationships':'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  };
  function injectNavIcons() {
    document.querySelectorAll('.nav .nav-btn').forEach((a) => {
      if (a.querySelector('.nav-ic')) return; // already iconed
      const path = NAV_ICONS[a.getAttribute('href')];
      if (!path) return;
      const ic = document.createElement('span');
      ic.className = 'nav-ic';
      ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
      a.insertBefore(ic, a.firstChild);
    });
  }
  injectNavIcons();

  // Read the mode each button represents, from its href (?mode=x) or its label.
  const btnMode = (b) => {
    const m = (b.getAttribute('href') || '').match(/mode=(\w+)/);
    return m ? m[1] : (b.textContent || '').trim().toLowerCase();
  };

  // Reflect the active mode (app.css colors .mode-btn.work/.all/.personal) and
  // make each button switch mode in place rather than navigate away.
  function wireToggle(mode) {
    if (!toggle) return;
    toggle.querySelectorAll('.mode-btn').forEach((b) => {
      const m = btnMode(b);
      b.classList.remove('work', 'all', 'personal');
      if (m === mode) b.classList.add(m);
      b.addEventListener('click', (e) => {
        e.preventDefault();
        if (m === mode) return;
        try { localStorage.setItem('lrl-mode', m); } catch (_) {}
        location.reload();
      });
    });
  }

  // Scope the nav to the current mode: work hides LIFE zones, personal hides
  // WORK zones, all shows everything. In a single mode the domain labels and
  // separators have nothing to divide, so hide them.
  function scopeNav(mode) {
    document.querySelectorAll('.nav .nav-btn').forEach((a) => {
      const h = a.getAttribute('href');
      const hide = (mode === 'work' && LIFE.includes(h)) || (mode === 'personal' && WORK.includes(h));
      a.style.display = hide ? 'none' : '';
    });
    const single = mode !== 'all';
    document.querySelectorAll('.nav .nav-domain, .nav .nav-sep').forEach((e) => {
      e.style.display = single ? 'none' : '';
    });
  }

  const apply = (canPersonal) => {
    const mode = canPersonal ? (localStorage.getItem('lrl-mode') || 'all') : 'work';
    document.body.dataset.mode = mode;
    wireToggle(mode);
    scopeNav(mode);
    if (canPersonal) { const t = document.querySelector('.mode-toggle'); if (t) t.style.display = 'flex'; }
  };

  fetch('/api/me')
    .then((r) => r.json())
    .then((me) => apply(!!(me && (me.personalEnabled === true || me.role === 'owner'))))
    .catch(() => apply(true)); // fail open to owner
})();
