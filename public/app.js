/* SQL Lab — front end. Plain JavaScript, no build step. */
(() => {
  'use strict';

  const STORE_KEY = 'sqllab.v1';
  const SOLUTION_UNLOCK_ATTEMPTS = 2;

  const $ = (id) => document.getElementById(id);
  const els = {
    sidebar: $('sidebar'), crumb: $('crumb'), title: $('exTitle'), context: $('exContext'),
    instructions: $('exInstructions'), number: $('exNumber'), hintArea: $('hintArea'),
    hintBtn: $('hintBtn'), hintBtnText: $('hintBtnText'), solutionBtn: $('solutionBtn'),
    chips: $('tableChips'), schema: $('schemaPanel'), feedback: $('feedback'),
    result: $('resultArea'), meta: $('resultMeta'), runBtn: $('runBtn'), submitBtn: $('submitBtn'),
    resetBtn: $('resetBtn'), progressFill: $('progressFill'), progressText: $('progressText'),
    statusPill: $('statusPill'), statusText: $('statusText'), expectedTab: $('expectedTab'),
    modal: $('modal'), modalTitle: $('modalTitle'), modalBody: $('modalBody'), modalActions: $('modalActions'),
    pane: document.querySelector('#instructionsPane .pane-scroll'),
  };

  let course = null;          // { modules, schema }
  let flat = [];              // [{ module, exercise, index, moduleIndex }]
  let current = null;         // entry from flat
  let editor = null;          // CodeMirror instance (or textarea fallback)
  let busy = false;
  let activeTab = 'result';
  let lastResult = null;
  let lastExpected = null;
  let statusError = null;

  // ---- Persistence ---------------------------------------------------------

  const state = loadState();
  function loadState() {
    const empty = { solved: {}, code: {}, attempts: {}, hints: {}, revealed: {}, current: null };
    try {
      return { ...empty, ...(JSON.parse(localStorage.getItem(STORE_KEY)) || {}) };
    } catch {
      return empty;
    }
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode etc. */ }
  }

  // ---- Utilities -----------------------------------------------------------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
  // Tiny markdown: paragraphs, "- " lists, ``` code blocks, `code`, **bold**.
  function markdown(text) {
    const lines = String(text || '').split('\n');
    let html = '';
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
    const flushList = () => { if (list) { html += `<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`; list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('```')) {
        flushPara(); flushList();
        const code = [];
        while (++i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i]);
        html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
      } else if (/^\s*-\s+/.test(line)) {
        flushPara();
        (list = list || []).push(line.replace(/^\s*-\s+/, ''));
      } else if (!line.trim()) {
        flushPara(); flushList();
      } else {
        flushList();
        para.push(line.trim());
      }
    }
    flushPara(); flushList();
    return html;
  }
  function formatBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  async function api(path, body) {
    const res = await fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    return res.json();
  }

  // ---- Editor --------------------------------------------------------------

  function setupEditor() {
    const textarea = $('editor');
    const runKeys = { 'Ctrl-Enter': () => run(), 'Cmd-Enter': () => run(), 'Shift-Ctrl-Enter': () => submit(), 'Shift-Cmd-Enter': () => submit() };
    if (window.CodeMirror) {
      const tables = {};
      for (const t of course.schema.tables) tables[t.name] = t.columns.map((c) => c[0]);
      editor = CodeMirror.fromTextArea(textarea, {
        mode: 'text/x-sql',
        lineNumbers: true,
        indentUnit: 2,
        tabSize: 2,
        matchBrackets: true,
        lineWrapping: false,
        extraKeys: {
          ...runKeys,
          'Ctrl-Space': 'autocomplete',
          Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('  ', 'end')),
        },
        hintOptions: { tables, completeSingle: false },
      });
      // Highlight the ___ blanks.
      editor.addOverlay({
        token(stream) {
          if (stream.match('___')) return 'blank';
          while (stream.next() != null && !stream.match('___', false)) { /* skip */ }
          return null;
        },
      });
      editor.on('change', () => {
        if (current) { state.code[current.exercise.id] = editor.getValue(); saveState(); }
      });
    } else {
      // Fallback if the CDN can't be reached: a plain textarea.
      editor = {
        getValue: () => textarea.value,
        setValue: (v) => { textarea.value = v; },
        focus: () => textarea.focus(),
        refresh: () => {},
        clearHistory: () => {},
      };
      textarea.addEventListener('input', () => {
        if (current) { state.code[current.exercise.id] = textarea.value; saveState(); }
      });
      textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.shiftKey ? submit() : run(); }
      });
    }
  }

  // ---- Rendering -----------------------------------------------------------

  function renderSidebar() {
    els.sidebar.innerHTML = course.modules.map((m, mi) => {
      const done = m.exercises.filter((e) => state.solved[e.id]).length;
      const items = m.exercises.map((e, ei) => {
        const cls = ['ex-link'];
        if (state.solved[e.id]) cls.push('solved');
        else if (state.revealed[e.id]) cls.push('revealed');
        if (current && current.exercise.id === e.id) cls.push('active');
        return `<button class="${cls.join(' ')}" data-id="${esc(e.id)}">
          <span class="ex-icon">${state.solved[e.id] ? '✓' : ''}</span>
          <span>${mi + 1}.${ei + 1} ${esc(e.title)}</span>
        </button>`;
      }).join('');
      return `<div class="module">
        <div class="module-head">
          <div class="module-num">Module ${mi + 1}</div>
          <div class="module-title">${esc(m.title)}</div>
          <div class="module-count">${done} / ${m.exercises.length} completed</div>
        </div>
        ${items}
      </div>`;
    }).join('');

    const solved = flat.filter((f) => state.solved[f.exercise.id]).length;
    els.progressText.textContent = `${solved} / ${flat.length}`;
    els.progressFill.style.width = `${flat.length ? (solved / flat.length) * 100 : 0}%`;
  }

  function renderExercise() {
    const { module, exercise: ex, moduleIndex, index } = current;
    els.crumb.textContent = `Module ${moduleIndex + 1} · ${module.title}`;
    els.title.textContent = ex.title;
    els.context.innerHTML = markdown(ex.context);
    els.instructions.innerHTML = (ex.instructions || []).map((i) => `<li>${inline(i)}</li>`).join('');
    els.number.textContent = `Exercise ${moduleIndex + 1}.${index + 1}`;

    // Tables
    els.chips.innerHTML = (ex.tables || []).map((t) => `<button class="chip" data-table="${esc(t)}">${esc(t)}</button>`).join('');
    els.schema.innerHTML = '';

    renderHints();
    editor.setValue(state.code[ex.id] ?? ex.starter);
    editor.clearHistory();
    editor.refresh();

    // Reset output
    lastResult = null;
    lastExpected = null;
    hideFeedback();
    els.expectedTab.hidden = !(state.solved[ex.id] || state.revealed[ex.id]);
    switchTab('result');
    els.result.innerHTML = '<div class="empty">Run your code to see the result here. <kbd>Ctrl</kbd> + <kbd>Enter</kbd></div>';
    els.meta.textContent = '';
    els.pane.scrollTop = 0;
    renderSidebar();
  }

  function renderHints() {
    const ex = current.exercise;
    const shown = state.hints[ex.id] || 0;
    const hints = ex.hints || [];
    let html = hints.slice(0, shown).map((h, i) => `<div class="hint"><b>Hint ${i + 1}:</b> ${inline(h)}</div>`).join('');
    if (state.revealed[ex.id]) {
      html += `<div class="hint solution-box"><b>Solution</b><pre><code>${esc(ex.solution)}</code></pre>
        <button class="btn ghost" id="useSolution">Copy into editor</button></div>`;
    }
    els.hintArea.innerHTML = html;
    els.hintBtn.disabled = shown >= hints.length;
    els.hintBtnText.textContent = shown >= hints.length ? 'No more hints' : shown ? 'Take another hint' : 'Take a hint';
    const attempts = state.attempts[ex.id] || 0;
    const unlocked = state.solved[ex.id] || attempts >= SOLUTION_UNLOCK_ATTEMPTS || shown >= hints.length;
    els.solutionBtn.hidden = !!state.revealed[ex.id];
    els.solutionBtn.disabled = !unlocked;
    els.solutionBtn.title = unlocked ? '' : 'Unlocks after a couple of attempts or once you have used all hints';
    const use = $('useSolution');
    if (use) use.onclick = () => { editor.setValue(ex.solution); editor.focus(); };
  }

  function renderSchema(tableName) {
    const t = course.schema.tables.find((x) => x.name === tableName);
    if (!t) return;
    els.schema.innerHTML = `<div class="desc"><code>${esc(course.schema.dataset)}.${esc(t.name)}</code> — ${esc(t.description)}</div>
      <table>${t.columns.map(([c, type]) => `<tr><td>${esc(c)}</td><td>${esc(type)}</td></tr>`).join('')}</table>`;
  }

  function renderTable(result) {
    if (!result) return '<div class="empty">Nothing to show yet.</div>';
    if (!result.columns.length) return '<div class="empty">The query returned no columns.</div>';
    if (!result.rows.length) return '<div class="empty">The query returned 0 rows.</div>';
    const head = result.columns.map((c, i) => `<th>${esc(c)}<span class="type">${esc((result.types || [])[i] || '')}</span></th>`).join('');
    const body = result.rows.map((row, r) => `<tr><td class="rownum">${r + 1}</td>${row.map((v) => {
      if (v === null || v === undefined) return '<td class="null">NULL</td>';
      if (typeof v === 'number') return `<td class="num">${esc(Number.isInteger(v) ? v : +v.toFixed(6))}</td>`;
      if (typeof v === 'object') return `<td title="${esc(JSON.stringify(v))}">${esc(JSON.stringify(v))}</td>`;
      return `<td title="${esc(v)}">${esc(v)}</td>`;
    }).join('')}</tr>`).join('');
    return `<table class="grid"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function renderMeta(result) {
    if (!result) { els.meta.textContent = ''; return; }
    const shown = result.rows.length;
    const total = result.totalRows ?? shown;
    const rowsText = total > shown ? `showing ${shown} of ${total.toLocaleString('en')} rows` : `${total.toLocaleString('en')} row${total === 1 ? '' : 's'}`;
    const parts = [rowsText, `${formatBytes(result.bytesProcessed)} processed`];
    if (result.ms != null) parts.push(`${(result.ms / 1000).toFixed(1)} s`);
    if (result.cacheHit) parts.push('cached');
    els.meta.textContent = parts.join(' · ');
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'result') {
      if (lastResult) { els.result.innerHTML = renderTable(lastResult); renderMeta(lastResult); }
    } else {
      loadExpected();
    }
  }

  async function loadExpected() {
    const ex = current.exercise;
    if (lastExpected) { els.result.innerHTML = renderTable(lastExpected); renderMeta(lastExpected); return; }
    els.result.innerHTML = '<div class="empty">Loading the expected output…</div>';
    els.meta.textContent = '';
    const data = await api(`/api/expected/${encodeURIComponent(ex.id)}`).catch((e) => ({ ok: false, error: e.message }));
    if (current.exercise.id !== ex.id || activeTab !== 'expected') return;
    if (!data.ok) { els.result.innerHTML = `<div class="error-text">${esc(data.error)}</div>`; return; }
    lastExpected = data.result;
    els.result.innerHTML = renderTable(lastExpected);
    renderMeta(lastExpected);
  }

  function showFeedback(kind, title, message, withNext) {
    const icon = { ok: '✓', bad: '✕', err: '!' }[kind];
    els.feedback.className = `feedback ${kind}`;
    els.feedback.innerHTML = `<span class="fb-icon">${icon}</span>
      <div class="fb-body"><b>${esc(title)}</b>${inline(message || '')}</div>
      ${withNext ? '<button class="btn primary" id="nextBtn">Next exercise →</button>' : ''}`;
    els.feedback.hidden = false;
    const next = $('nextBtn');
    if (next) next.onclick = goNext;
  }
  function hideFeedback() { els.feedback.hidden = true; }

  // ---- Actions -------------------------------------------------------------

  function setBusy(btn, on) {
    busy = on;
    btn.classList.toggle('busy', on);
    els.runBtn.disabled = on;
    els.submitBtn.disabled = on;
  }

  async function run() {
    if (busy || !current) return;
    setBusy(els.runBtn, true);
    hideFeedback();
    switchTab('result');
    try {
      const data = await api('/api/run', { sql: editor.getValue() });
      if (!data.ok) {
        lastResult = null;
        els.result.innerHTML = '';
        els.meta.textContent = '';
        showFeedback('err', 'Your query has an error', data.error);
      } else {
        lastResult = data.result;
        els.result.innerHTML = renderTable(lastResult);
        renderMeta(lastResult);
      }
    } catch (e) {
      showFeedback('err', 'Could not reach the local server', 'Is it still running? Start it again with npm start.');
    } finally {
      setBusy(els.runBtn, false);
    }
  }

  async function submit() {
    if (busy || !current) return;
    const ex = current.exercise;
    setBusy(els.submitBtn, true);
    hideFeedback();
    switchTab('result');
    try {
      const data = await api('/api/submit', { exerciseId: ex.id, sql: editor.getValue() });
      if (!data.ok) {
        lastResult = null;
        els.result.innerHTML = '';
        els.meta.textContent = '';
        showFeedback('err', 'Your query has an error', data.error);
        bumpAttempts(ex.id);
        return;
      }
      lastResult = data.result;
      els.result.innerHTML = renderTable(lastResult);
      renderMeta(lastResult);
      if (data.grade.correct) {
        const first = !state.solved[ex.id];
        state.solved[ex.id] = true;
        saveState();
        els.expectedTab.hidden = false;
        const isLast = flat.indexOf(current) === flat.length - 1;
        showFeedback('ok', first ? 'Correct!' : 'Correct again!', data.grade.message, !isLast);
        renderSidebar();
        renderHints();
      } else {
        bumpAttempts(ex.id);
        showFeedback('bad', 'Not quite', data.grade.message);
      }
    } catch (e) {
      showFeedback('err', 'Could not reach the local server', 'Is it still running? Start it again with npm start.');
    } finally {
      setBusy(els.submitBtn, false);
    }
  }

  function bumpAttempts(id) {
    state.attempts[id] = (state.attempts[id] || 0) + 1;
    saveState();
    renderHints();
  }

  function goTo(id) {
    const entry = flat.find((f) => f.exercise.id === id) || flat[0];
    current = entry;
    state.current = entry.exercise.id;
    saveState();
    renderExercise();
  }

  function goNext() {
    const i = flat.indexOf(current);
    if (i < flat.length - 1) goTo(flat[i + 1].exercise.id);
  }

  function modal(title, bodyHtml, actions) {
    els.modalTitle.textContent = title;
    els.modalBody.innerHTML = bodyHtml;
    els.modalActions.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = `btn ${a.kind || 'ghost'}`;
      b.textContent = a.label;
      b.onclick = () => { els.modal.hidden = true; a.onClick?.(); };
      els.modalActions.appendChild(b);
    }
    els.modal.hidden = false;
  }

  // ---- Status --------------------------------------------------------------

  async function checkStatus() {
    els.statusPill.className = 'status-pill';
    els.statusText.textContent = 'Connecting…';
    try {
      const s = await api('/api/status');
      if (s.ok) {
        statusError = null;
        els.statusPill.className = 'status-pill ok';
        els.statusText.textContent = `BigQuery · ${s.projectId}`;
        els.statusPill.title = 'Connected to BigQuery';
      } else {
        statusError = s.error;
        els.statusPill.className = 'status-pill err';
        els.statusText.textContent = 'Not connected — click for details';
        els.statusPill.title = s.error;
      }
    } catch {
      statusError = 'The local server is not responding.';
      els.statusPill.className = 'status-pill err';
      els.statusText.textContent = 'Server not running';
    }
  }

  // ---- Init ----------------------------------------------------------------

  async function init() {
    try {
      course = await api('/api/course');
    } catch {
      document.body.innerHTML = '<p style="padding:40px">Could not load the course. Start the app with <code>npm start</code> and open http://localhost:3000.</p>';
      return;
    }
    course.modules.forEach((m, mi) => m.exercises.forEach((e, ei) => flat.push({ module: m, exercise: e, index: ei, moduleIndex: mi })));
    setupEditor();

    els.sidebar.addEventListener('click', (e) => {
      const b = e.target.closest('.ex-link');
      if (b) goTo(b.dataset.id);
    });
    els.chips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const open = chip.classList.contains('open');
      els.chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('open'));
      if (open) { els.schema.innerHTML = ''; return; }
      chip.classList.add('open');
      renderSchema(chip.dataset.table);
    });
    els.hintBtn.onclick = () => {
      const id = current.exercise.id;
      state.hints[id] = Math.min((state.hints[id] || 0) + 1, (current.exercise.hints || []).length);
      saveState();
      renderHints();
    };
    els.solutionBtn.onclick = () => {
      modal('Show the solution?', '<p>Try one more time first? Seeing the solution is fine — but you\'ll learn more if you type it yourself afterwards.</p>', [
        { label: 'Keep trying' },
        { label: 'Show solution', kind: 'primary', onClick: () => {
          state.revealed[current.exercise.id] = true;
          saveState();
          els.expectedTab.hidden = false;
          renderHints();
          renderSidebar();
        } },
      ]);
    };
    els.resetBtn.onclick = () => {
      modal('Reset the code?', '<p>This replaces your code with the starter code for this exercise.</p>', [
        { label: 'Cancel' },
        { label: 'Reset', kind: 'primary', onClick: () => { editor.setValue(current.exercise.starter); delete state.code[current.exercise.id]; saveState(); } },
      ]);
    };
    els.runBtn.onclick = run;
    els.submitBtn.onclick = submit;
    document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
    $('toggleSidebar').onclick = () => { els.sidebar.classList.toggle('collapsed'); editor.refresh(); };
    els.statusPill.onclick = () => {
      if (!statusError) return;
      modal('Not connected to BigQuery', `<p>${inline(statusError)}</p>
        <p>Check the setup steps in <code>README.md</code>, then click <b>Try again</b>.</p>`, [
        { label: 'Close' },
        { label: 'Try again', kind: 'primary', onClick: checkStatus },
      ]);
    };
    els.modal.addEventListener('click', (e) => { if (e.target === els.modal) els.modal.hidden = true; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') els.modal.hidden = true; });

    goTo(state.current);
    checkStatus();
  }

  init();
})();
