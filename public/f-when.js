'use strict';
FEAT.when = (() => {
  const pad = n => String(n).padStart(2, '0');
  const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const dayOf = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
  const dayLabel = t => {
    const today = dayOf(Date.now()), d = dayOf(t);
    if (d === today) return 'Today';
    if (d === addDays(today, 1)) return 'Tomorrow';
    return new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  };

  function picker(initial, onChange) {
    let at = initial;
    const view = new Date(at); view.setDate(1);
    const dateL = h('span', { class: 'wp-d' }), timeL = h('span', { class: 'wp-t' });
    const field = h('button', { type: 'button', class: 'wp-field', onclick: () => toggle() }, ico('calendar', 15), dateL, h('i', { class: 'wp-sep' }), timeL, h('span', { class: 'wp-chev' }, ico('chevronDown', 13)));
    const head = h('div', { class: 'wp-head' }), grid = h('div', { class: 'wp-grid' });
    const hours = h('div', { class: 'wp-col' }), mins = h('div', { class: 'wp-col' });
    const pop = h('div', { class: 'wp-pop hidden' },
      h('div', { class: 'wp-cal' }, head, grid),
      h('div', { class: 'wp-time' }, h('div', { class: 'wp-tl' }, 'Time'), h('div', { class: 'wp-cols' }, hours, mins)));

    const paintField = () => { dateL.textContent = dayLabel(at); timeL.textContent = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); };
    const emit = t => { at = t; paintField(); draw(); onChange(at); };
    const withDay = (y, m, d) => { const n = new Date(at); n.setFullYear(y, m, d); return n.getTime(); };
    const withTime = (hh, mm) => { const n = new Date(at); n.setHours(hh, mm, 0, 0); return n.getTime(); };

    function draw() {
      const today = dayOf(Date.now()), sel = dayOf(at);
      const y = view.getFullYear(), m = view.getMonth();
      const canPrev = new Date(y, m, 1).getTime() > today;
      head.replaceChildren(
        h('button', { type: 'button', class: 'wp-nav prev', title: 'previous month', disabled: !canPrev, onclick: () => { view.setMonth(m - 1); draw(); } }, ico('chevronRight', 15)),
        h('span', { class: 'wp-m' }, view.toLocaleDateString([], { month: 'long', year: 'numeric' })),
        h('button', { type: 'button', class: 'wp-nav', title: 'next month', onclick: () => { view.setMonth(m + 1); draw(); } }, ico('chevronRight', 15)));
      const cells = DOW.map(d => h('span', { class: 'wp-dow' }, d));
      for (let i = (new Date(y, m, 1).getDay() + 6) % 7; i > 0; i--) cells.push(h('span'));
      const days = new Date(y, m + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        const t = new Date(y, m, d).getTime();
        cells.push(h('button', { type: 'button', class: 'wp-day' + (t === today ? ' today' : '') + (t === sel ? ' on' : ''), disabled: t < today, onclick: () => emit(withDay(y, m, d)) }, String(d)));
      }
      grid.replaceChildren(...cells);
      const cur = new Date(at), now = new Date(), isToday = sel === today;
      hours.replaceChildren(...Array.from({ length: 24 }, (_, hh) => h('button', { type: 'button', class: 'wp-tm' + (hh === cur.getHours() ? ' on' : ''), disabled: isToday && hh < now.getHours(), onclick: () => emit(withTime(hh, cur.getMinutes())) }, pad(hh))));
      const steps = [...new Set([...Array.from({ length: 12 }, (_, i) => i * 5), cur.getMinutes()])].sort((a, b) => a - b);
      mins.replaceChildren(...steps.map(mm => h('button', { type: 'button', class: 'wp-tm' + (mm === cur.getMinutes() ? ' on' : ''), disabled: isToday && cur.getHours() === now.getHours() && mm < now.getMinutes(), onclick: () => emit(withTime(cur.getHours(), mm)) }, pad(mm))));
    }
    const scrollTimes = () => requestAnimationFrame(() => { for (const col of [hours, mins]) { const on = col.querySelector('.on'); if (on) col.scrollTop = on.offsetTop - col.clientHeight / 2 + on.offsetHeight / 2; } });
    const toggle = open => {
      const on = open ?? pop.classList.contains('hidden');
      pop.classList.toggle('hidden', !on); field.classList.toggle('on', on);
      if (on) { view.setTime(new Date(at).getTime()); view.setDate(1); draw(); scrollTimes(); }
    };
    const set = t => { at = t; paintField(); if (!pop.classList.contains('hidden')) { draw(); scrollTimes(); } };
    paintField();
    return { field, pop, set, close: () => toggle(false) };
  }

  return { picker };
})();
