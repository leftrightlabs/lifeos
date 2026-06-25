/* LRL OS — Reusable "Edit Project" modal.
   Any page can open it:  window.openProjectModal(project, { onSaved })
   where project = { id, name, source ('work'|'personal'), status, end (YYYY-MM-DD) }.
   Saves via PATCH /api/projects/:id. Self-contained: injects its own markup +
   styles (using the shared CSS variables), so it works on today + every zone page. */
(function () {
  'use strict';

  var STATUSES = ['Active', 'Ongoing', 'Planned', 'On Hold', 'Billing', 'Done'];
  var ctx = null;   // { id, source, onSaved }

  function injectStyles() {
    if (document.getElementById('pm-styles')) return;
    var css = ''
      + '.pm-modal{position:fixed;inset:0;background:rgba(5,8,14,.78);backdrop-filter:blur(4px);display:none;align-items:flex-start;justify-content:center;padding:56px 18px;z-index:600;overflow-y:auto}'
      + '.pm-modal.open{display:flex}'
      + '.pm-content{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px;max-width:480px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,.6)}'
      + '.pm-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}'
      + '.pm-title{font-size:20px;font-weight:800;color:var(--text)}'
      + '.pm-close{background:none;border:1px solid var(--border);color:var(--text-3);width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:18px;line-height:1}'
      + '.pm-close:hover{color:var(--text)}'
      + '.pm-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;padding:4px 11px;border-radius:999px;margin-bottom:16px}'
      + '.pm-pill.work{background:var(--work-soft);color:#7FA8FF}'
      + '.pm-pill.personal{background:var(--personal-soft);color:var(--personal)}'
      + '.pm-field{margin-bottom:14px}'
      + '.pm-field label{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px}'
      + '.pm-field input,.pm-field select{width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-family:inherit;font-size:14px;color:var(--text)}'
      + '.pm-field input:focus,.pm-field select:focus{outline:none;border-color:var(--accent)}'
      + '.pm-clear{float:right;background:none;border:none;color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;font-weight:700}'
      + '.pm-clear:hover{color:var(--text)}'
      + '.pm-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:18px;padding-top:14px;border-top:1px solid var(--border-soft)}'
      + '.pm-btn{padding:10px 18px;border-radius:8px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;border:1px solid transparent}'
      + '.pm-btn.ghost{background:none;border-color:var(--border);color:var(--text-2)}'
      + '.pm-btn.ghost:hover{color:var(--text);border-color:var(--text-3)}'
      + '.pm-btn.primary{background:var(--accent);color:#fff}'
      + '.pm-btn.primary:hover{filter:brightness(1.1)}'
      + '.pm-open-link{margin-right:auto;font-size:12px;color:var(--text-3);text-decoration:none}'
      + '.pm-open-link:hover{color:var(--text)}';
    var s = document.createElement('style');
    s.id = 'pm-styles'; s.textContent = css;
    document.head.appendChild(s);
  }

  function ensureModal() {
    injectStyles();
    if (document.getElementById('pmModal')) return;
    var el = document.createElement('div');
    el.className = 'pm-modal';
    el.id = 'pmModal';
    el.innerHTML = ''
      + '<div class="pm-content" role="dialog" aria-modal="true">'
      +   '<div class="pm-head"><div class="pm-title">Edit Project</div><button class="pm-close" id="pmClose" aria-label="Close">×</button></div>'
      +   '<div class="pm-pill work" id="pmPill"><span id="pmPillLabel">Work</span></div>'
      +   '<div class="pm-field"><label>Project name</label><input type="text" id="pmName" placeholder="Project name"></div>'
      +   '<div class="pm-field"><label>Status</label><select id="pmStatus">' + STATUSES.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select></div>'
      +   '<div class="pm-field"><label>Target deadline <button type="button" class="pm-clear" id="pmClear">Clear</button></label><input type="date" id="pmDeadline"></div>'
      +   '<div class="pm-actions">'
      +     '<a class="pm-open-link" id="pmOpen" href="#" target="_blank" rel="noopener">Open in Notion ↗</a>'
      +     '<button class="pm-btn ghost" id="pmCancel">Cancel</button>'
      +     '<button class="pm-btn primary" id="pmSave">Save</button>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(el);

    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    document.getElementById('pmClose').addEventListener('click', close);
    document.getElementById('pmCancel').addEventListener('click', close);
    document.getElementById('pmClear').addEventListener('click', function () { document.getElementById('pmDeadline').value = ''; });
    document.getElementById('pmSave').addEventListener('click', save);
  }

  function close() { var m = document.getElementById('pmModal'); if (m) m.classList.remove('open'); ctx = null; }

  function save() {
    if (!ctx) return;
    var name = document.getElementById('pmName').value.trim();
    var status = document.getElementById('pmStatus').value;
    var deadline = document.getElementById('pmDeadline').value || null;
    var btn = document.getElementById('pmSave');
    btn.disabled = true; btn.textContent = '…';
    fetch('/api/projects/' + ctx.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || undefined, status: status, deadlineStart: deadline, source: ctx.source }),
    }).then(function (r) {
      if (!r.ok) throw new Error('save failed');
      var saved = { name: name, status: status, end: deadline };
      if (typeof ctx.onSaved === 'function') ctx.onSaved(saved);
      close();
    }).catch(function () {
      btn.disabled = false; btn.textContent = 'Save';
      alert("Couldn't save the project. Try again.");
    });
  }

  window.openProjectModal = function (project, opts) {
    if (!project || !project.id) return;
    opts = opts || {};
    ensureModal();
    ctx = { id: project.id, source: project.source === 'personal' ? 'personal' : 'work', onSaved: opts.onSaved };
    var personal = ctx.source === 'personal';
    var pill = document.getElementById('pmPill');
    pill.className = 'pm-pill ' + (personal ? 'personal' : 'work');
    document.getElementById('pmPillLabel').textContent = personal ? 'Personal' : 'Work';
    document.getElementById('pmName').value = project.name || '';
    var st = document.getElementById('pmStatus');
    // Preserve whatever the project's real status is, even if it's not a preset,
    // so saving without touching it never silently changes the status.
    var opts = STATUSES.slice();
    if (project.status && opts.indexOf(project.status) < 0) opts.unshift(project.status);
    st.innerHTML = opts.map(function (s) { return '<option>' + s + '</option>'; }).join('');
    st.value = project.status || 'Active';
    document.getElementById('pmDeadline').value = (project.end || project.deadline || '').slice(0, 10);
    var open = document.getElementById('pmOpen');
    if (project.url) { open.href = project.url; open.style.display = ''; } else { open.style.display = 'none'; }
    document.getElementById('pmModal').classList.add('open');
    setTimeout(function () { document.getElementById('pmName').focus(); }, 30);
  };
})();
