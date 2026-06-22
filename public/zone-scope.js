// Per-user scoping for zone pages.
// Team members (personalEnabled=false / role!=owner) get a work-only view:
// hide the ALL/PERSONAL mode toggles and the LIFE nav zones, matching the
// Today page. Owner sees everything. Fails open to the owner view on error.
(function () {
  fetch('/api/me')
    .then((r) => r.json())
    .then((me) => {
      const canPersonal = me && (me.personalEnabled === true || me.role === 'owner');
      if (canPersonal) return;

      // Mode toggle: keep WORK, drop ALL + PERSONAL.
      document.querySelectorAll('.mode-toggle .mode-btn').forEach((b) => {
        if ((b.textContent || '').trim().toUpperCase() !== 'WORK') b.style.display = 'none';
      });

      // LIFE nav zones: hide the personal-domain links.
      const LIFE = ['/health', '/wealth', '/lego', '/relationships'];
      document.querySelectorAll('.nav .nav-btn').forEach((a) => {
        if (LIFE.includes(a.getAttribute('href'))) a.style.display = 'none';
      });
      // With only work zones left, the domain labels (LIFE / WORK) and the
      // separators have nothing to divide — hide them all.
      document.querySelectorAll('.nav .nav-domain, .nav .nav-sep').forEach((e) => {
        e.style.display = 'none';
      });
    })
    .catch(() => {});
})();
