// Per-user scoping for zone pages.
// Team members (personalEnabled=false / role!=owner) get a work-only view:
// hide the ALL/PERSONAL mode toggles and the LIFE nav zones, matching the
// Today page. Owner sees everything. Fails open to the owner view on error.
(function () {
  // The mode toggle is hidden by default (inline style) so it never flashes for
  // team members; reveal it only once we confirm the owner.
  const revealToggle = () => { const t = document.querySelector('.mode-toggle'); if (t) t.style.display = 'flex'; };

  fetch('/api/me')
    .then((r) => r.json())
    .then((me) => {
      const canPersonal = me && (me.personalEnabled === true || me.role === 'owner');
      if (canPersonal) { revealToggle(); return; }

      // Team members: the mode toggle stays hidden (work is the only mode).

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
    .catch(revealToggle); // fail open to owner view
})();
