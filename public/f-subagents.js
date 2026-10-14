'use strict';
// F: subagents + cost by model. Registers FEAT.subagents { chatBar, homeTiles }.
(() => {
  const FAMS = ['opus', 'sonnet', 'haiku', 'fable', 'other'];
  const FAM_LABEL = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', other: 'Other' };
  const famOf = id => { const m = String(id || '').toLowerCase(); return m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : (m.includes('fable') || m.includes('mythos')) ? 'fable' : 'other'; };
  const money = v => v == null ? '–' : v > 0 && v < 0.01 ? '<$0.01' : v < 10 ? '$' + v.toFixed(2) : '$' + v.toFixed(0);
  const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's' : Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm'; };
  const tok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0);
  const modelBadge = a => { const id = a.modelId || a.model; const fam = famOf(id); const nm = id ? (typeof modelName === 'function' ? modelName(id) : id) : '?'; return h('span', { class: 'sa-mod sa-f-' + fam, title: id || '' }, nm); };
  const agentDur = a => dur((a.running ? Date.now() : a.lastAt) - a.startedAt);

  // ---- per-session data, shared by all chips of that session -------------------------------------------------
  const DATA = new Map();     // tmux name -> { at, j, err }
  const CHIPS = new Set();    // { el, name }
  const fetchAgents = async name => {
    const e = DATA.get(name) || {}; if (e.busy) return; e.busy = true; DATA.set(name, e);
    try { e.j = await api('subagents/' + encodeURIComponent(name)); e.err = null; } catch (x) { e.err = x; if (!e.j) e.j = { agents: [] }; }
    e.busy = false; e.at = Date.now(); paintChips(name);
    if (e.j && e.j.partial && !e.more) { e.more = true; setTimeout(() => { e.more = false; fetchAgents(name); }, 300); }   // server parses a bounded amount per call: ask again until complete
  };
  function chipLabel(agents) {
    const run = agents.filter(a => a.running).length;
    return run ? { t: '◇ ' + run + ' running', run: true } : { t: '◇ ' + agents.length + ' agent' + (agents.length === 1 ? '' : 's'), run: false };
  }
  function paintChips(name) {
    for (const c of CHIPS) {
      if (c.name !== name) continue;
      const ag = (DATA.get(name)?.j?.agents) || [];
      if (!ag.length) { c.el.style.display = 'none'; continue; }
      const l = chipLabel(ag); c.el.style.display = ''; c.el.textContent = l.t; c.el.classList.toggle('sa-run', l.run);
      c.el.title = ag.length + ' subagent' + (ag.length === 1 ? '' : 's') + ' in this session · ' + money(ag.reduce((s, a) => s + a.cost, 0)) + ' API-equivalent';
    }
  }
  let ticker = null;
  function tick() {
    for (const c of [...CHIPS]) if (!c.el.isConnected && Date.now() - c.born > 3000) CHIPS.delete(c);
    if (!CHIPS.size) { clearInterval(ticker); ticker = null; return; }
    if (document.hidden) return;
    for (const n of new Set([...CHIPS].map(c => c.name))) fetchAgents(n);
  }

  function chatBar(name) {
    const el = h('button', { class: 'btn sm sa-chip', style: 'display:none', onclick: () => sheet(name) });
    const c = { el, name, born: Date.now() }; CHIPS.add(c);
    const e = DATA.get(name); if (e && e.j) paintChips(name);
    if (!e || !e.at || Date.now() - e.at > 3000) setTimeout(() => { if (el.isConnected) fetchAgents(name); }, 0);
    if (!ticker) ticker = setInterval(tick, 5000);
    return el;
  }

  // ---- the sheet ------------------------------------------------------------------------------------------
  function sheet(name, agentId) {
    const m = $('#modal'); m.classList.remove('hidden');
    const st = { agent: null, timer: null };
    let box = null; const owns = () => box && m.firstChild === box && !m.classList.contains('hidden');
    const cleanup = () => { clearInterval(st.timer); document.removeEventListener('keydown', esc, true); if (m.onclick === onOut) m.onclick = null; };
    const close = () => { const mine = owns(); cleanup(); if (mine) m.classList.add('hidden'); };
    const esc = e => { if (!owns()) return cleanup(); if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (st.agent) { st.agent = null; draw(); } else close(); } };
    const onOut = e => { if (e.target === m) close(); };
    document.addEventListener('keydown', esc, true);
    const title = h('h3', null, '◇ Subagents');
    const back = h('button', { class: 'btn sm ghost', onclick: () => { st.agent = null; draw(); } }, '← all');
    const body = h('div', { class: 'sa-body' });
    box = h('div', { class: 'box sa-box' }, h('div', { class: 'sa-head' }, back, title, h('span', { class: 'sa-sp' }), h('span', { class: 'dim mono sa-sess' }, name), h('button', { class: 'btn sm ghost icon', title: 'close (Esc)', onclick: close }, ico('x', 15))), body);
    m.replaceChildren(box); m.onclick = onOut;
    let list = (DATA.get(name)?.j?.agents) || null; let detail = null; let want = agentId || null;

    function drawList() {
      const ag = list || [];
      title.textContent = '◇ Subagents' + (ag.length ? ' · ' + ag.length : '');
      if (list == null) return body.replaceChildren(h('div', { class: 'sa-empty dim' }, 'Loading…'));
      if (!ag.length) return body.replaceChildren(h('div', { class: 'sa-empty dim' }, 'No subagents in this session yet.'));
      const total = ag.reduce((s, a) => s + a.cost, 0);
      const rows = ag.slice().reverse().map(a => h('button', { class: 'sa-row' + (a.running ? ' sa-run' : ''), onclick: () => { st.agent = a; detail = null; draw(); } },
        h('div', { class: 'sa-r1' }, h('span', { class: 'sa-type' }, a.type), modelBadge(a), a.running ? h('span', { class: 'sa-live' }, 'running') : null, a.background ? h('span', { class: 'sa-bg dim' }, 'bg') : null, h('span', { class: 'sa-sp' }), h('span', { class: 'mono sa-cost' }, money(a.cost))),
        h('div', { class: 'sa-desc' }, a.description || '(no description)'),
        h('div', { class: 'sa-r3 dim mono' }, agentDur(a), ' · ', a.tools + ' tool' + (a.tools === 1 ? '' : 's'), ' · ', tok(a.tokens.out) + ' out', ' · ', ago(a.startedAt) + ' ago'),
        a.flag ? h('div', { class: 'sa-flag' }, '⚠ ' + a.flag) : null));
      body.replaceChildren(h('div', { class: 'sa-sum dim mono' }, ag.filter(a => a.running).length + ' running · ' + money(total) + ' API-equivalent'), ...rows);
    }
    function drawDetail() {
      const a = st.agent; title.textContent = '◇ ' + a.type;
      const head = h('div', { class: 'sa-dh' }, modelBadge(a), a.running ? h('span', { class: 'sa-live' }, 'running') : null, h('span', { class: 'mono dim' }, agentDur(a) + ' · ' + money(a.cost) + ' · ' + a.tools + ' tools'), h('div', { class: 'sa-desc', style: 'flex-basis:100%' }, a.description || ''), a.flag ? h('div', { class: 'sa-flag', style: 'flex-basis:100%' }, '⚠ ' + a.flag) : null);
      if (!detail) return body.replaceChildren(head, h('div', { class: 'sa-empty dim' }, 'Loading…'));
      if (detail.error) return body.replaceChildren(head, h('div', { class: 'sa-empty dim' }, detail.error));
      const steps = detail.steps.map(s => s.k === 'text' ? h('div', { class: 'sa-step sa-st-text ttext', html: mdLite(s.text) }) : h('div', { class: 'sa-step sa-st-tool mono' }, h('b', null, s.name), ' ', s.summary));
      const open = body.querySelector('.sa-prompt')?.open;
      body.replaceChildren(head,
        h('details', { class: 'sa-prompt', open: open || null }, h('summary', null, 'prompt'), h('pre', { class: 'sa-pre' }, detail.prompt || '')),
        h('div', { class: 'sa-h' }, 'steps' + (detail.steps.length >= 60 ? ' (last 60)' : '')),
        h('div', { class: 'sa-steps' }, ...steps),
        detail.result ? h('div', { class: 'sa-h' }, 'result') : null,
        detail.result ? h('div', { class: 'sa-result ttext', html: mdLite(detail.result) }) : null);
    }
    function draw() {
      back.style.display = st.agent ? '' : 'none';
      const sc = body.scrollTop; const bottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      if (st.agent) drawDetail(); else drawList();
      body.scrollTop = st.agent && bottom && detail ? body.scrollHeight : sc;
    }
    async function refresh() {
      if (!owns()) return cleanup();
      try { await fetchAgents(name); list = DATA.get(name)?.j?.agents || []; } catch {}
      if (want && !st.agent) { st.agent = list.find(a => a.agentId === want) || null; want = null; }
      if (st.agent) {
        const fresh = list.find(a => a.agentId === st.agent.agentId); if (fresh) st.agent = fresh;
        const id = st.agent.agentId;
        try { const d = await api('subagents/' + encodeURIComponent(name) + '?agent=' + encodeURIComponent(id)); if (st.agent && st.agent.agentId === id) detail = d; } catch (e) { if (st.agent && st.agent.agentId === id) detail = { error: e.message }; }
      }
      if (owns()) draw(); else cleanup();
    }
    draw(); refresh(); st.timer = setInterval(refresh, 4000);
  }

  // ---- Home tile: cost by model -----------------------------------------------------------------------------
  const T = { el: null, models: null, flagged: [], at: 0, busy: false, sig: '' };
  async function loadTile() {
    if (T.busy) return; T.busy = true;
    try {
      T.models = await api('usage/models?days=7');
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0); const flagged = [];
      // one session at a time, and only the ones that can be running subagents (+ the open chat), so a restart does not fan out to every session
      const BUSY = new Set(['working', 'background', 'needs-you', 'permission']);
      const names = (S.runtime.sessions || []).filter(s => s.claude && (BUSY.has(s.claude.state) || s.name === (typeof TERM !== 'undefined' && TERM.active))).map(s => s.name);
      for (const n of names) {
        try {
          let j = await api('subagents/' + encodeURIComponent(n));
          for (let i = 0; j.partial && i < 40; i++) { await new Promise(r => setTimeout(r, 150)); j = await api('subagents/' + encodeURIComponent(n)); }
          for (const a of j.agents) if (a.flag && a.startedAt >= midnight.getTime()) flagged.push({ ...a, session: n });
        } catch {}
      }
      flagged.sort((x, y) => y.startedAt - x.startedAt); T.flagged = flagged;
    } catch {} finally { T.busy = false; T.at = Date.now(); paintTile(); if (typeof renderFeatHome === 'function') try { renderFeatHome(); } catch {} }
  }
  function stack(by, total, big) {
    const bar = h('div', { class: 'sa-stack' + (big ? ' sa-big' : '') });
    if (!(total > 0)) { bar.append(h('i', { class: 'sa-f-none', style: 'flex:1' })); return bar; }
    for (const f of FAMS) if (by[f] > 0) bar.append(h('i', { class: 'sa-bg-' + f, style: `flex:${by[f]}`, title: `${FAM_LABEL[f]} ${money(by[f])}` }));
    return bar;
  }
  const legend = by => h('div', { class: 'sa-legend' }, ...FAMS.filter(f => by[f] > 0).map(f => h('span', { class: 'sa-lg' }, h('i', { class: 'sa-bg-' + f }), FAM_LABEL[f] + ' ', h('b', { class: 'mono' }, money(by[f])))));
  function paintTile() {
    const el = T.el; const M = T.models; if (!el || !M) return;
    const sig = JSON.stringify([M, T.flagged.map(a => a.agentId)]);
    if (sig === T.sig) return; T.sig = sig;
    const today = M.days[M.days.length - 1]; const tTot = FAMS.reduce((s, f) => s + today.byFamily[f], 0); const wTot = FAMS.reduce((s, f) => s + M.totals.byFamily[f], 0);
    const max = Math.max(0.0001, ...M.days.map(d => FAMS.reduce((s, f) => s + d.byFamily[f], 0)));
    const cols = M.days.map(d => {
      const t = FAMS.reduce((s, f) => s + d.byFamily[f], 0);
      const col = h('div', { class: 'sa-col', title: d.day + ' · ' + money(t) }, h('div', { class: 'sa-colbar', style: `height:${Math.max(t > 0 ? 3 : 0, t / max * 100)}%` }, ...FAMS.slice().reverse().filter(f => d.byFamily[f] > 0).map(f => h('i', { class: 'sa-bg-' + f, style: `flex:${d.byFamily[f]}` }))), h('span', { class: 'sa-cl dim' }, new Date(d.day + 'T12:00').toLocaleDateString([], { weekday: 'narrow' })));
      return col;
    });
    const splitTot = M.totals.main + M.totals.sub;
    el.replaceChildren(...[
      h('div', { class: 'k' }, h('span', null, 'Cost by model'), h('span', { class: 'dim sa-note' }, 'API-equivalent')),
      h('div', { class: 'sa-grid' },
        h('div', { class: 'sa-part' },
          h('div', { class: 'sa-lbl' }, 'Today ', h('b', { class: 'mono' }, money(tTot))), stack(today.byFamily, tTot, true), legend(today.byFamily),
          h('div', { class: 'sa-lbl', style: 'margin-top:10px' }, '7 days ', h('b', { class: 'mono' }, money(wTot))), stack(M.totals.byFamily, wTot, true), legend(M.totals.byFamily)),
        h('div', { class: 'sa-part' },
          h('div', { class: 'sa-cols' }, ...cols),
          h('div', { class: 'sa-lbl', style: 'margin-top:10px' }, 'Main threads vs subagents (7 d)'),
          h('div', { class: 'sa-stack' }, splitTot > 0 ? h('i', { class: 'sa-bg-main', style: `flex:${M.totals.main}` }) : h('i', { class: 'sa-f-none', style: 'flex:1' }), M.totals.sub > 0 ? h('i', { class: 'sa-bg-sub', style: `flex:${M.totals.sub}` }) : null),
          h('div', { class: 'sa-legend' }, h('span', { class: 'sa-lg' }, h('i', { class: 'sa-bg-main' }), 'Main ', h('b', { class: 'mono' }, money(M.totals.main))), h('span', { class: 'sa-lg' }, h('i', { class: 'sa-bg-sub' }), 'Subagents ', h('b', { class: 'mono' }, money(M.totals.sub)))))),
      T.flagged.length ? h('div', { class: 'sa-fl' }, h('div', { class: 'sa-lbl' }, '⚠ Flagged today'), ...T.flagged.slice(0, 5).map(a => h('div', { class: 'sa-flrow' }, h('span', { class: 'sa-flag' }, a.flag), h('span', { class: 'dim sa-fld' }, (a.description || a.type) + ' · ' + a.session), h('b', { class: 'mono' }, money(a.cost))))) : null].filter(Boolean));
  }
  function homeTiles() {
    if (!T.el) T.el = h('div', { class: 'tile sa-tile' });
    if (!document.hidden && Date.now() - T.at > 60000) loadTile();
    return T.models ? T.el : null;
  }

  // ?subagents=<tmux name>[&agent=<id>] or &chip=1: opens that chat with the sheet on top (screenshots / tests)
  function deepLink(q) {
    const n = q.get('subagents'); if (!n) return false;
    history.replaceState(null, '', location.pathname);
    TERM.mode = 'chat'; try { localStorage.setItem('bd.mode', 'chat'); } catch {}
    openTerm(n);
    if (q.get('chip')) setTimeout(() => { const sc = document.querySelector('.cscroll'); if (sc) sc.scrollTop = 0; }, 3500);   // &chip=1: show the chat bar (screenshots)
    else setTimeout(() => sheet(n, q.get('agent')), 2500);
    return true;
  }

  FEAT.subagents = { chatBar, homeTiles, deepLink };
})();
