/* LRL OS — Shared collapsible-card behavior for zone pages.
   Pairs with styles/cards.css. today.html keeps its own (compatible) collapse
   logic; every other page loads this. Provides a global toggleCard(el) and
   auto-restores each [data-persist-key] card's collapsed state on load. Collapse
   state persists per calendar day (resets daily), matching today. */
(function () {
  'use strict';
  var STORE = 'lrl-card-sections';

  function dayKey() { return new Date().toISOString().slice(0, 10); }

  function read() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE) || '{}');
      if (s._date !== dayKey()) return { _date: dayKey() };
      return s;
    } catch (e) { return { _date: dayKey() }; }
  }
  function setSection(key, collapsed) {
    if (!key) return;
    var s = read();
    s[key] = collapsed;
    try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) {}
  }
  function getSection(key) {
    var s = read();
    return !!s[key];
  }

  // Toggle a card's collapsed state (called from the title row's onclick).
  window.toggleCard = function (el) {
    var c = el && el.closest ? el.closest('.t-card') : null;
    if (!c) return;
    c.classList.toggle('collapsed');
    if (c.dataset.persistKey) setSection(c.dataset.persistKey, c.classList.contains('collapsed'));
  };

  // Restore persisted collapsed state for every keyed card currently in the DOM.
  window.restoreCards = function (root) {
    var scope = root || document;
    var cards = scope.querySelectorAll('.t-card[data-persist-key]');
    for (var i = 0; i < cards.length; i++) {
      if (getSection(cards[i].dataset.persistKey)) cards[i].classList.add('collapsed');
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { window.restoreCards(); });
  } else { window.restoreCards(); }
})();
