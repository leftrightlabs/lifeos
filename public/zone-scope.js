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
  const WORK = ['/attract', '/convert', '/deliver', '/scale'];
  const toggle = document.querySelector('.mode-toggle');

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
