/* Panels, inspector, menus, search, import/export and boot. */
(function () {
  'use strict';
  const App = window.App;
  const state = App.state;
  const esc = App.esc;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

  const TYPES = ['generic', 'lamp', 'switch', 'relay', 'fuse', 'connector', 'ground', 'motor', 'battery', 'gauge', 'sender',
    'ignition', 'engine', 'alternator', 'starter', 'accessory', 'horn', 'terminal', 'splice', 'panel'];
  const TYPE_LABEL = {
    lamp: 'Lamps', switch: 'Switches', relay: 'Relays & flashers', fuse: 'Fuses', connector: 'Connectors', ground: 'Grounds',
    motor: 'Motors', battery: 'Battery', gauge: 'Gauges & instruments', sender: 'Senders', ignition: 'Ignition', engine: 'Engine',
    alternator: 'Charging', starter: 'Starting', accessory: 'Accessories', horn: 'Horns', terminal: 'Terminals', splice: 'Splices',
    panel: 'Sheet & annotations', generic: 'Other components',
  };
  const STYLES = ['box', 'lamp', 'switch', 'relay', 'fuse', 'connector', 'ground', 'motor', 'battery', 'terminal', 'note'];
  const GAUGES = ['0.5 mm²', '0.75 mm²', '1.0 mm²', '1.5 mm²', '2.5 mm²', '4 mm²', '6 mm²', '22 AWG', '20 AWG', '18 AWG', '16 AWG', '14 AWG', '12 AWG', '10 AWG', '8 AWG', '4 AWG', '2 AWG'];
  // ISO sizes in points, landscape
  const PAGE_PRESETS = [['A4', 841.89, 595.28], ['A3', 1190.55, 841.89], ['A2', 1683.78, 1190.55], ['A1', 2383.94, 1683.78], ['A0', 3370.39, 2383.94]];
  const PAGE_STEP = 200;

  // ------------------------------------------------------------------ templates
  function connectorTemplate(n) {
    const pitch = 8, h = n * pitch + 2, pins = [], bridges = [];
    for (let i = 0; i < n; i++) {
      pins.push({ name: i + 1 + 'A', x: 0, y: 5 + i * pitch });
      pins.push({ name: i + 1 + 'B', x: 12, y: 5 + i * pitch });
      bridges.push(['p' + (2 * i + 1), 'p' + (2 * i + 2)]);
    }
    return { key: 'conn' + n, menu: `Inline connector (${n}-way)`, name: `Connector (${n}-way)`, style: 'connector', type: 'connector', prefix: 'CONN', w: 12, h, pins, bridges };
  }
  App.templates = [
    { key: 'box2', menu: 'Component (2 pin)', name: 'Component', style: 'box', type: 'generic', prefix: 'C', w: 30, h: 14, pins: [{ name: '1', x: 0, y: 7 }, { name: '2', x: 30, y: 7 }] },
    { key: 'box4', menu: 'Module (4 pin)', name: 'Module', style: 'box', type: 'generic', prefix: 'C', w: 30, h: 24, pins: [{ name: '1', x: 0, y: 6 }, { name: '2', x: 0, y: 18 }, { name: '3', x: 30, y: 6 }, { name: '4', x: 30, y: 18 }] },
    { key: 'lamp', name: 'Lamp', style: 'lamp', type: 'lamp', prefix: 'LAMP', w: 14, h: 14, pins: [{ name: '+', x: 0, y: 7 }, { name: '-', x: 14, y: 7 }] },
    { key: 'switch', name: 'Switch', style: 'switch', type: 'switch', prefix: 'SW', w: 20, h: 12, pins: [{ name: '1', x: 0, y: 6 }, { name: '2', x: 20, y: 6 }] },
    { key: 'relay', menu: 'Relay (5 pin: 30/85/86/87/87a)', name: 'Relay', style: 'relay', type: 'relay', prefix: 'RLY', w: 30, h: 26,
      pins: [{ name: '30', x: 0, y: 7 }, { name: '85', x: 0, y: 19 }, { name: '87', x: 30, y: 5 }, { name: '87a', x: 30, y: 13 }, { name: '86', x: 30, y: 21 }] },
    { key: 'fuse', name: 'Fuse', style: 'fuse', type: 'fuse', prefix: 'FUSE', w: 8, h: 18, pins: [{ name: 'IN', x: 4, y: 0 }, { name: 'OUT', x: 4, y: 18 }] },
    connectorTemplate(2), connectorTemplate(4), connectorTemplate(6),
    { key: 'ground', name: 'Ground', style: 'ground', type: 'ground', prefix: 'GND', w: 10, h: 9, pins: [{ name: 'GND', x: 5, y: 0 }] },
    { key: 'motor', name: 'Motor', style: 'motor', type: 'motor', prefix: 'MTR', w: 14, h: 14, pins: [{ name: '+', x: 0, y: 7 }, { name: '-', x: 14, y: 7 }] },
    { key: 'battery', name: 'Battery', style: 'battery', type: 'battery', prefix: 'BAT', w: 24, h: 14, pins: [{ name: '-', x: 0, y: 7 }, { name: '+', x: 24, y: 7 }] },
    { key: 'terminal', menu: 'Terminal / ring lug', name: 'Terminal', style: 'terminal', type: 'terminal', prefix: 'T', w: 6, h: 6, pins: [{ name: '1', x: 3, y: 3 }], showLabel: false },
    { key: 'note', name: 'Text note', style: 'note', type: 'panel', prefix: 'NOTE', w: 60, h: 8, pins: [], text: 'Note', fontSize: 6 },
  ];

  // ------------------------------------------------------------------ toasts / tooltip / download
  App.toast = function (msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3200);
  };
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  }
  const fileStem = () => (state.doc.meta.title || 'harness').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'harness';

  function swatch(w) {
    const st = typeof w === 'string' ? colorStyleByCode(w) : App.wireStyle(w);
    const tr = st.tracer ? `<i style="background:${st.tracer}"></i>` : '';
    return `<span class="swatch" style="background:${st.hex}" title="${esc(st.name)}">${tr}</span>`;
  }
  /** swatches for colour pickers always show the OEM colour itself */
  function colorStyleByCode(code) {
    const def = App.colorDef(code) || { code, name: code, hex: '#888888' };
    return { code: def.code, name: def.name, hex: def.hex, tracer: def.tracer || null };
  }

  // ------------------------------------------------------------------ reveal
  App.reveal = function (box) {
    const r = $('#canvas').getBoundingClientRect();
    const v = App.view;
    const sw = (box.x1 - box.x0) * v.k, sh = (box.y1 - box.y0) * v.k;
    if (sw < 24 && sh < 24) {
      App.zoomTo(box, Math.max(40, (box.x1 - box.x0) * 1.5));
    } else if (sw > r.width * 0.9 || sh > r.height * 0.9) {
      App.zoomTo(box, 20);
    } else {
      v.tx = r.width / 2 - ((box.x0 + box.x1) / 2) * v.k;
      v.ty = r.height / 2 - ((box.y0 + box.y1) / 2) * v.k;
      App.applyView();
    }
    App.render();
  };
  function wireBox(ids) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      const w = App.wire(id);
      if (!w) continue;
      for (const [x, y] of App.wirePoints(w)) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    return { x0, y0, x1, y1 };
  }
  function selectComp(id, reveal) {
    App.select('comp', id);
    if (reveal) App.reveal(App.compBounds(App.comp(id)));
  }
  function selectWires(ids, reveal, trace) {
    state.sel.comps.clear();
    state.sel.wires = new Set(ids);
    state.highlight = trace ? new Set(ids) : null;
    App.emit('selection');
    if (reveal) App.reveal(wireBox(ids));
  }
  App.selectCircuit = function (circuit) {
    const ids = state.doc.wires.filter((w) => w.circuit === circuit).map((w) => w.id);
    selectWires(ids, true, true);
  };

  // ------------------------------------------------------------------ left panel
  const filters = { components: '', wires: '', circuits: '' };
  function renderTabs() {
    const tab = state.prefs.leftTab;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    const body = $('#tab-body');
    if (body.dataset.tab !== tab) {
      body.dataset.tab = tab;
      body.innerHTML = ['components', 'wires', 'circuits'].includes(tab)
        ? `<input class="filter" type="search" placeholder="Filter…" value="${esc(filters[tab])}"><div class="list"></div>`
        : '<div class="list"></div>';
      const f = $('.filter', body);
      if (f) f.addEventListener('input', () => {
        filters[tab] = f.value;
        renderTabList();
      });
    }
    renderTabList();
  }
  function renderTabList() {
    const tab = state.prefs.leftTab;
    const list = $('#tab-body .list');
    if (!list) return;
    ({ components: listComponents, wires: listWires, circuits: listCircuits, colours: listColours, view: listView })[tab](list);
  }

  function listComponents(el) {
    const q = filters.components.trim().toLowerCase();
    const groups = {};
    for (const c of state.doc.components) {
      if (c.style === 'splice' && !q) continue;
      const hay = (c.name + ' ' + c.id + ' ' + c.type).toLowerCase();
      if (q && !hay.includes(q)) continue;
      (groups[c.type || 'generic'] = groups[c.type || 'generic'] || []).push(c);
    }
    const order = Object.keys(TYPE_LABEL);
    const keys = Object.keys(groups).sort((a, b) => (order.indexOf(a) + 100 * (a === 'panel')) - (order.indexOf(b) + 100 * (b === 'panel')));
    if (!keys.length) {
      el.innerHTML = '<div class="empty">No matching components.</div>';
      return;
    }
    const wireCount = {};
    for (const w of state.doc.wires) {
      wireCount[w.from.c] = (wireCount[w.from.c] || 0) + 1;
      wireCount[w.to.c] = (wireCount[w.to.c] || 0) + 1;
    }
    let s = '';
    for (const k of keys) {
      const items = groups[k].slice().sort((a, b) => a.name.localeCompare(b.name));
      s += `<details class="list-group" open><summary>${esc(TYPE_LABEL[k] || k)} <span class="count">${items.length}</span></summary>`;
      for (const c of items) {
        const sel = state.sel.comps.has(c.id) ? ' selected' : '';
        const n = wireCount[c.id] || 0;
        s += `<div class="row${sel}" data-comp="${esc(c.id)}"><span class="grow">${esc(c.name)}</span><span class="muted small">${c.type === 'panel' ? '' : n + ' wire' + (n === 1 ? '' : 's')}</span></div>`;
      }
      s += '</details>';
    }
    if (!q) s += `<div class="hint">${state.doc.components.filter((c) => c.style === 'splice').length} splices hidden — type in the filter to find them.</div>`;
    el.innerHTML = s;
    $$('[data-comp]', el).forEach((r) => r.addEventListener('click', () => selectComp(r.dataset.comp, true)));
  }

  function listWires(el) {
    const q = filters.wires.trim().toLowerCase();
    const rows = [];
    for (const w of state.doc.wires) {
      const from = App.endLabel(w.from), to = App.endLabel(w.to);
      const st = App.wireStyle(w);
      const hay = [w.circuit, st.name, st.code, from, to, w.id, w.gauge].join(' ').toLowerCase();
      if (q && !hay.includes(q)) continue;
      rows.push({ w, from, to, st });
    }
    rows.sort((a, b) => (a.w.circuit || '~').localeCompare(b.w.circuit || '~') || a.from.localeCompare(b.from));
    if (!rows.length) {
      el.innerHTML = '<div class="empty">No matching wires.</div>';
      return;
    }
    let s = '<table class="grid"><thead><tr><th>Circuit</th><th></th><th>From → To</th></tr></thead><tbody>';
    for (const { w, from, to } of rows) {
      const sel = state.sel.wires.has(w.id) ? ' selected' : '';
      s += `<tr class="clickable${sel}" data-wire="${esc(w.id)}"><td class="mono">${esc(w.circuit || '—')}</td><td>${swatch(w)}</td><td>${esc(from)}<br><span class="muted">→ ${esc(to)}</span></td></tr>`;
    }
    s += '</tbody></table>';
    el.innerHTML = s;
    $$('[data-wire]', el).forEach((r) => r.addEventListener('click', () => selectWires([r.dataset.wire], true)));
  }

  function circuitsMap() {
    const m = new Map();
    for (const w of state.doc.wires) {
      const k = w.circuit || '';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(w);
    }
    return m;
  }
  function circuitEnds(ws) {
    // endpoints of a circuit that are not splices or shared between its own wires
    const ends = [];
    for (const w of ws) for (const e of [w.from, w.to]) {
      const c = App.comp(e.c);
      if (c && c.style !== 'splice') ends.push(c.name);
    }
    return [...new Set(ends)];
  }
  function listCircuits(el) {
    const q = filters.circuits.trim().toLowerCase();
    const m = circuitsMap();
    const keys = [...m.keys()].filter((k) => k).sort();
    let s = '';
    for (const k of keys) {
      const ws = m.get(k);
      const ends = circuitEnds(ws);
      const hay = (k + ' ' + ends.join(' ') + ' ' + ws.map((w) => App.wireStyle(w).name).join(' ')).toLowerCase();
      if (q && !hay.includes(q)) continue;
      const sw = [...new Set(ws.map((w) => w.color))].map((code) => swatch(ws.find((w) => w.color === code))).join('');
      const sel = ws.every((w) => state.sel.wires.has(w.id)) ? ' selected' : '';
      s += `<div class="row${sel}" data-circuit="${esc(k)}"><span class="mono">${esc(k)}</span>${sw}<span class="grow muted small" title="${esc(ends.join(' · '))}">${esc(ends.join(' · '))}</span><span class="count">${ws.length}</span></div>`;
    }
    const un = m.get('') || [];
    if (!s) s = '<div class="empty">No matching circuits.</div>';
    if (un.length && !q) s += `<div class="hint">${un.length} wires have no circuit number (internal leads, battery cables, plug tails…). Find them in the Wires tab.</div>`;
    el.innerHTML = s;
    $$('[data-circuit]', el).forEach((r) => r.addEventListener('click', () => App.selectCircuit(r.dataset.circuit)));
  }

  function listColours(el) {
    const doc = state.doc;
    const uses = {};
    for (const w of doc.wires) uses[w.color] = (uses[w.color] || 0) + 1;
    const mfUses = {};
    for (const c of doc.colors) if (c.mf) mfUses[c.mf] = (mfUses[c.mf] || 0) + (uses[c.code] || 0);
    const mfOptions = (cur) => '<option value="">—</option>' + doc.mfColors.map((m) => `<option value="${esc(m.code)}"${m.code === cur ? ' selected' : ''}>${esc(m.code)}</option>`).join('');
    let s = `<div class="hint">Wire colours used on the drawing, and the harness colour each one is built in. Switch between them with <b>OEM / Mad Folk</b> in the toolbar.</div>
      <div class="section" style="margin-top:4px;border:0;padding-top:0"><div class="title">OEM colours <button class="btn small" data-add="oem">Add</button></div>
      <table class="grid"><thead><tr><th></th><th>Code</th><th>Name</th><th>Built as</th><th>#</th><th></th></tr></thead><tbody>`;
    doc.colors.forEach((c, i) => {
      s += `<tr data-i="${i}" data-set="colors"><td><input type="color" data-f="hex" value="${esc(c.hex)}"></td><td><input data-f="code" class="mono" value="${esc(c.code)}"></td>
        <td><input data-f="name" value="${esc(c.name)}"></td><td><select data-f="mf">${mfOptions(c.mf)}</select></td><td class="muted">${uses[c.code] || 0}</td>
        <td>${uses[c.code] ? '' : '<button class="btn small" data-del title="Remove unused colour">✕</button>'}</td></tr>`;
    });
    s += `</tbody></table></div><div class="section"><div class="title">Harness (Mad Folk) colours <button class="btn small" data-add="mf">Add</button></div>
      <table class="grid"><thead><tr><th></th><th>Code</th><th>Name</th><th>Trace</th><th>#</th><th></th></tr></thead><tbody>`;
    doc.mfColors.forEach((c, i) => {
      s += `<tr data-i="${i}" data-set="mfColors"><td><input type="color" data-f="hex" value="${esc(c.hex)}"></td><td><input data-f="code" class="mono" value="${esc(c.code)}"></td>
        <td><input data-f="name" value="${esc(c.name)}"></td><td><input type="color" data-f="tracer" value="${esc(c.tracer || '#000000')}" title="Trace colour"${c.tracer ? '' : ' style="opacity:.35"'}></td>
        <td class="muted">${mfUses[c.code] || 0}</td><td>${mfUses[c.code] ? '' : '<button class="btn small" data-del title="Remove unused colour">✕</button>'}</td></tr>`;
    });
    s += '</tbody></table><div class="hint">Set a trace colour to draw a striped wire; click ✕ next to an unused colour to remove it.</div></div>';
    el.innerHTML = s;
    $$('tr[data-set]', el).forEach((tr) => {
      const set = tr.dataset.set, i = +tr.dataset.i;
      $$('[data-f]', tr).forEach((inp) => inp.addEventListener('change', () => {
        const f = inp.dataset.f;
        App.mutate(() => {
          const item = state.doc[set][i];
          const old = item[f];
          let v = inp.value.trim();
          if (f === 'code') {
            if (!v || state.doc[set].some((o, j) => j !== i && o.code === v)) {
              App.toast('Colour codes must be unique and not empty.', 'warn');
              return;
            }
            if (set === 'colors') for (const w of state.doc.wires) if (w.color === old) w.color = v;
            else for (const c of state.doc.colors) if (c.mf === old) c.mf = v;
          }
          if (f === 'mf' && !v) v = undefined;
          item[f] = v;
        });
      }));
      const del = $('[data-del]', tr);
      if (del) del.addEventListener('click', () => App.mutate(() => state.doc[set].splice(i, 1)));
    });
    $$('[data-add]', el).forEach((b) => b.addEventListener('click', () => {
      const set = b.dataset.add === 'oem' ? 'colors' : 'mfColors';
      App.mutate(() => {
        let n = 1;
        while (state.doc[set].some((c) => c.code === 'NEW' + n)) n++;
        state.doc[set].push({ code: 'NEW' + n, name: 'New colour', hex: '#808080' });
      });
    }));
  }

  function listView(el) {
    const p = state.prefs;
    const doc = state.doc;
    const chk = (k, label) => `<label class="check"><input type="checkbox" data-pref="${k}"${p[k] ? ' checked' : ''}> ${label}</label>`;
    const used = App.storageUsed();
    const quota = 5 * 1024 * 1024;
    el.innerHTML = `
      <div class="section" style="margin-top:0;border:0;padding-top:0"><div class="title">Drawing</div>
        ${chk('showPanels', 'Show sheet border, title block &amp; notes')}
        ${chk('hops', 'Draw crossover hops')}
        ${chk('rounded', 'Rounded wire corners')}
        ${chk('autoLabels', 'Auto-place labels on unlabelled wires')}
        ${chk('dim', 'Dim everything else when tracing')}
      </div>
      <div class="section"><div class="title">Grid</div>
        ${chk('showGrid', 'Show grid')}
        ${chk('snap', 'Snap to grid')}
        <div class="field"><label>Grid size</label><select data-pref-num="grid">${[0.5, 1, 2, 2.5, 5].map((g) => `<option${g === p.grid ? ' selected' : ''}>${g}</option>`).join('')}</select></div>
      </div>
      <div class="section"><div class="title">Reference underlay</div>
        ${chk('showRef', 'Show reference image under the drawing')}
        <div class="field"><label>Opacity</label><input type="range" min="0.05" max="1" step="0.05" data-pref-range="refOpacity" value="${p.refOpacity}"></div>
        <div class="hint">${state.refData ? 'Using your uploaded image.' : doc.reference && doc.reference.href ? 'Using the original drawing.' : 'No reference image yet.'}</div>
        <div class="actions"><button class="btn small" data-act="ref-upload">Use an image…</button>${state.refData ? '<button class="btn small" data-act="ref-clear">Remove uploaded image</button>' : ''}</div>
      </div>
      <div class="section"><div class="title">Document</div>
        <div class="field"><label>Title</label><input data-meta="title" value="${esc(doc.meta.title || '')}"></div>
        <div class="field"><label>Drawing no.</label><input data-meta="drawingNo" value="${esc(doc.meta.drawingNo || '')}"></div>
        <div class="field"><label>Description</label><textarea data-meta="description">${esc(doc.meta.description || '')}</textarea></div>
      </div>
      <div class="section"><div class="title">Canvas</div>
        <div class="field"><label>Size (pt)</label><div class="pair"><input data-page="w" type="number" step="1" value="${doc.page.w}"><input data-page="h" type="number" step="1" value="${doc.page.h}"></div></div>
        <div class="field"><label>Paper</label><select data-act="page-preset"><option value="">Custom</option>${PAGE_PRESETS.map(([name, w, h]) => `<option value="${name}"${w === doc.page.w && h === doc.page.h ? ' selected' : ''}>${name} landscape</option>`).join('')}</select></div>
        <div class="field"><label>Extend</label><div class="actions" style="margin-top:0">${['left', 'right', 'top', 'bottom'].map((d) => `<button class="btn small" data-extend="${d}">${{ left: '← Left', right: 'Right →', top: '↑ Top', bottom: 'Bottom ↓' }[d]}</button>`).join('')}</div></div>
        <div class="actions"><button class="btn small" data-act="page-fit">Grow to fit drawing</button></div>
        <div class="hint">Each click adds ${PAGE_STEP} pt. Extending left or top moves the whole drawing so everything keeps its place on screen.</div>
      </div>
      ${App.cloud && App.cloud.enabled ? `<div class="section"><div class="title">Storage</div>
        <div class="hint">Shared harnesses are stored on the server and backed up to R2 shortly after each change. Find older snapshots under <b>Backups</b> in the harness menu.</div></div>` : `<div class="section"><div class="title">Browser storage</div>
        <div class="meter"><i style="width:${Math.min(100, (used / quota) * 100).toFixed(1)}%"></i></div>
        <div class="hint">${(used / 1048576).toFixed(2)} MB of about 5 MB used by saved harnesses. Export JSON from the harness menu to keep a backup.</div>
      </div>`}`;
    $$('[data-pref]', el).forEach((i) => i.addEventListener('change', () => setPref(i.dataset.pref, i.checked)));
    $$('[data-pref-num]', el).forEach((i) => i.addEventListener('change', () => setPref(i.dataset.prefNum, parseFloat(i.value))));
    $$('[data-pref-range]', el).forEach((i) => i.addEventListener('input', () => setPref(i.dataset.prefRange, parseFloat(i.value))));
    $$('[data-meta]', el).forEach((i) => i.addEventListener('change', () => App.mutate(() => (doc.meta[i.dataset.meta] = i.value))));
    $$('[data-page]', el).forEach((i) => i.addEventListener('change', () => {
      const v = parseFloat(i.value);
      if (v > 10) App.resizePage(i.dataset.page === 'w' ? v : doc.page.w, i.dataset.page === 'h' ? v : doc.page.h);
    }));
    $('[data-act="page-preset"]', el).addEventListener('change', (e) => {
      const p = PAGE_PRESETS.find(([name]) => name === e.target.value);
      if (p) App.resizePage(p[1], p[2]);
    });
    $$('[data-extend]', el).forEach((b) => b.addEventListener('click', () => {
      const d = b.dataset.extend;
      const dx = d === 'left' ? PAGE_STEP : 0, dy = d === 'top' ? PAGE_STEP : 0;
      const w = doc.page.w + (d === 'left' || d === 'right' ? PAGE_STEP : 0);
      const h = doc.page.h + (d === 'top' || d === 'bottom' ? PAGE_STEP : 0);
      growPage(w, h, dx, dy);
    }));
    $('[data-act="page-fit"]', el).addEventListener('click', () => {
      const b = App.contentBounds();
      const m = 20;
      // whole grid squares, so shifted parts stay on the grid
      const dx = b && b.x0 - m < 0 ? Math.ceil((m - b.x0) / 50) * 50 : 0;
      const dy = b && b.y0 - m < 0 ? Math.ceil((m - b.y0) / 50) * 50 : 0;
      const w = Math.max(doc.page.w + dx, b ? Math.ceil(b.x1 + dx + m) : 0);
      const h = Math.max(doc.page.h + dy, b ? Math.ceil(b.y1 + dy + m) : 0);
      if (w === doc.page.w && h === doc.page.h) return App.toast('The drawing already fits on the page.');
      growPage(w, h, dx, dy);
    });
    const up = $('[data-act="ref-upload"]', el);
    if (up) up.addEventListener('click', () => $('#file-ref').click());
    const clr = $('[data-act="ref-clear"]', el);
    if (clr) clr.addEventListener('click', () => {
      App.setReferenceImage(null);
      renderTabList();
    });
  }
  function growPage(w, h, dx, dy) {
    App.resizePage(w, h, dx, dy);
    // keep the drawing still on screen when it moves to make room on the left or top
    App.view.tx -= dx * App.view.k;
    App.view.ty -= dy * App.view.k;
    App.applyView();
  }
  function setPref(k, v) {
    state.prefs[k] = v;
    App.savePrefs();
    App.resetRenderCache();
    App.render();
    syncToolbar();
  }

  // ------------------------------------------------------------------ inspector
  function field(label, html) {
    return `<div class="field"><label>${label}</label>${html}</div>`;
  }
  function renderInspector() {
    const el = $('#inspector');
    const nc = state.sel.comps.size, nw = state.sel.wires.size;
    if (nc === 1 && nw === 0) return inspectComponent(el, App.comp([...state.sel.comps][0]));
    if (nw === 1 && nc === 0) return inspectWire(el, App.wire([...state.sel.wires][0]));
    if (nc + nw > 1) return inspectMulti(el);
    inspectDocument(el);
  }

  function inspectDocument(el) {
    const doc = state.doc;
    const comps = doc.components.filter((c) => c.type !== 'panel' && c.style !== 'splice').length;
    const circuits = new Set(doc.wires.map((w) => w.circuit).filter(Boolean)).size;
    el.innerHTML = `<h3>${esc(doc.meta.title || 'Untitled harness')}</h3>
      <div class="sub">${esc(doc.meta.description || '')}</div>
      <table class="grid"><tbody>
        <tr><td>Components</td><td>${comps}</td></tr>
        <tr><td>Wires</td><td>${doc.wires.length}</td></tr>
        <tr><td>Circuits</td><td>${circuits}</td></tr>
        <tr><td>Splices</td><td>${doc.components.filter((c) => c.style === 'splice').length}</td></tr>
        ${doc.meta.drawingNo ? `<tr><td>Drawing</td><td>${esc(doc.meta.drawingNo)}</td></tr>` : ''}
      </tbody></table>
      <div class="section"><div class="title">Getting started</div>
        <div class="hint">Click any wire or component to inspect and edit it. Pick a circuit in the <b>Circuits</b> tab to trace it across the drawing.</div>
        <div class="hint"><span class="kbd">W</span> draws a wire from pin to pin, <b>Add component</b> places new parts, and every change is saved ${App.cloud && App.cloud.enabled ? 'and shared live with anyone else editing' : 'in this browser'}.</div>
        <div class="actions"><button class="btn small" id="i-help">Mouse &amp; keyboard help</button></div>
      </div>`;
    $('#i-help').addEventListener('click', () => $('#help-dialog').showModal());
  }

  function inspectComponent(el, c) {
    const wires = App.wiresAt(c.id);
    const isArt = c.style === 'art';
    const typeOpts = TYPES.map((t) => `<option${t === c.type ? ' selected' : ''}>${t}</option>`).join('');
    const styleOpts = STYLES.map((t) => `<option${t === c.style ? ' selected' : ''}>${t}</option>`).join('');
    const pinRows = c.pins.map((p) => {
      const n = wires.filter((w) => (w.from.c === c.id && w.from.p === p.id) || (w.to.c === c.id && w.to.p === p.id)).length;
      return `<tr data-pin="${esc(p.id)}"><td><input value="${esc(p.name)}" data-pin-name></td><td class="muted">${n}</td><td><button class="btn small" data-pin-del title="Delete pin">✕</button></td></tr>`;
    }).join('');
    const pinName = (id) => (App.pin(c, id) || { name: '?' }).name;
    const bridges = (c.bridges || []).map((b, i) => `<div class="row"><span class="grow">${esc(pinName(b[0]))} ↔ ${esc(pinName(b[1]))}</span><button class="btn small" data-bridge-del="${i}">✕</button></div>`).join('');
    const pinOpts = c.pins.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const wireRows = wires.map((w) => {
      const other = w.from.c === c.id ? w.to : w.from;
      const here = w.from.c === c.id ? w.from : w.to;
      return `<tr class="clickable" data-wire="${esc(w.id)}"><td class="mono">${esc(w.circuit || '—')}</td><td>${swatch(w)}</td><td><span class="muted">${esc(pinName(here.p))} →</span> ${esc(App.endLabel(other))}</td></tr>`;
    }).join('');
    el.innerHTML = `<h3>${esc(c.name)}</h3><div class="sub">${esc(c.type)} · <span class="mono">${esc(c.id)}</span>${c.locked ? ' · locked' : ''}</div>
      ${field('Name', `<input data-k="name" value="${esc(c.name)}">`)}
      ${field('Type', `<select data-k="type">${typeOpts}</select>`)}
      ${isArt ? field('Symbol', '<span class="muted">Original drawing artwork</span>') : field('Symbol', `<select data-k="style">${styleOpts}</select>`)}
      ${c.style === 'note' ? field('Text', `<textarea data-k="text">${esc(c.text || '')}</textarea>`) + field('Font size', `<input type="number" step="0.5" min="2" data-k="fontSize" value="${c.fontSize || 6}">`) : ''}
      ${field('Position', `<div class="pair"><input type="number" step="0.5" data-k="x" value="${c.x}"><input type="number" step="0.5" data-k="y" value="${c.y}"></div>`)}
      ${isArt || c.style === 'splice' ? '' : field('Size', `<div class="pair"><input type="number" step="0.5" min="2" data-k="w" value="${c.w}"><input type="number" step="0.5" min="2" data-k="h" value="${c.h}"></div>`)}
      ${c.style === 'splice' ? '' : field('Rotation', `<select data-k="rot">${[0, 90, 180, 270].map((r) => `<option value="${r}"${r === (c.rot || 0) ? ' selected' : ''}>${r}°</option>`).join('')}</select>`)}
      ${field('Options', `<div><label class="check"><input type="checkbox" data-k="optional"${c.optional ? ' checked' : ''}> Optional fitment</label>
        <label class="check"><input type="checkbox" data-k="locked"${c.locked ? ' checked' : ''}> Locked on canvas</label>
        ${isArt || c.style === 'splice' || c.style === 'note' ? '' : `<label class="check"><input type="checkbox" data-k="showLabel"${c.showLabel !== false ? ' checked' : ''}> Show name</label>
        <label class="check"><input type="checkbox" data-k="showPinNames"${c.showPinNames ? ' checked' : ''}> Show pin names</label>`}</div>`)}
      ${field('Part no. / notes', `<textarea data-k="notes" placeholder="Part numbers, location, fitment notes…">${esc(c.notes || '')}</textarea>`)}
      ${c.type === 'panel' && !c.pins.length ? '' : `<div class="section"><div class="title">Pins <span class="count">${c.pins.length}</span></div>
        ${c.pins.length ? `<table class="grid"><thead><tr><th>Name</th><th>Wires</th><th></th></tr></thead><tbody>${pinRows}</tbody></table>` : '<div class="hint">No pins yet.</div>'}
        <div class="actions"><button class="btn small" id="i-addpin">Add pin…</button><button class="btn small${App.editor.pinEdit ? ' active' : ''}" id="i-pinedit">Move pins</button></div></div>`}
      ${c.pins.length > 1 && c.style !== 'splice' ? `<div class="section"><div class="title">Internal links <span class="count">${(c.bridges || []).length}</span></div>
        <div class="hint">Pins joined inside this part (connector cavities, fuse in/out). Net tracing follows these.</div>${bridges}
        <div class="actions"><select id="i-br-a">${pinOpts}</select><select id="i-br-b">${pinOpts}</select><button class="btn small" id="i-br-add">Link</button></div></div>` : ''}
      <div class="section"><div class="title">Connected wires <span class="count">${wires.length}</span></div>
        ${wires.length ? `<table class="grid"><tbody>${wireRows}</tbody></table>` : '<div class="hint">Nothing connected.</div>'}</div>
      <div class="actions section">
        <button class="btn small" id="i-zoom">Zoom to</button>
        ${c.style === 'splice' ? '' : '<button class="btn small" id="i-rot">Rotate 90°</button><button class="btn small" id="i-dup">Duplicate</button>'}
        <button class="btn small danger" id="i-del">Delete</button>
      </div>`;

    $$('[data-k]', el).forEach((inp) => inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      let v = inp.type === 'checkbox' ? inp.checked : inp.value;
      if (['x', 'y', 'w', 'h', 'fontSize', 'rot'].includes(k)) {
        v = parseFloat(v);
        if (!isFinite(v)) return;
      }
      if (k === 'rot') {
        App.rotateSelection((v - (c.rot || 0) + 360) % 360);
        return;
      }
      if (k === 'x' || k === 'y') {
        App.nudgeSelection(k === 'x' ? v - c.x : 0, k === 'y' ? v - c.y : 0);
        return;
      }
      App.mutate(() => {
        if (k === 'w' || k === 'h') {
          // keep pins on the edges they sat on
          const old = c[k];
          for (const p of c.pins) {
            const key = k === 'w' ? 'x' : 'y';
            if (Math.abs(p[key] - old) < 0.01) p[key] = v;
            else if (p[key] > 0.01) p[key] = App.round((p[key] / old) * v);
          }
          for (const w of App.wiresAt(c.id)) App.orthogonalize(w);
        }
        c[k] = v;
      });
    }));
    $$('[data-pin-name]', el).forEach((inp) => inp.addEventListener('change', () => {
      const pid = inp.closest('tr').dataset.pin;
      App.mutate(() => (App.pin(c, pid).name = inp.value));
    }));
    $$('[data-pin-del]', el).forEach((b) => b.addEventListener('click', () => {
      const pid = b.closest('tr').dataset.pin;
      const att = App.wiresAt(c.id, pid);
      if (att.length && !confirm(`Delete this pin and its ${att.length} wire(s)?`)) return;
      App.mutate(() => {
        App.deleteWires(att.map((w) => w.id));
        c.pins = c.pins.filter((p) => p.id !== pid);
        c.bridges = (c.bridges || []).filter((br) => !br.includes(pid));
      });
    }));
    $$('[data-bridge-del]', el).forEach((b) => b.addEventListener('click', () => App.mutate(() => c.bridges.splice(+b.dataset.bridgeDel, 1))));
    const brAdd = $('#i-br-add');
    if (brAdd) brAdd.addEventListener('click', () => {
      const a = $('#i-br-a').value, b = $('#i-br-b').value;
      if (a === b) return;
      App.mutate(() => (c.bridges = (c.bridges || []).concat([[a, b]])));
    });
    $$('[data-wire]', el).forEach((r) => r.addEventListener('click', () => selectWires([r.dataset.wire], true)));
    const on = (id, fn) => {
      const b = $('#' + id);
      if (b) b.addEventListener('click', fn);
    };
    on('i-addpin', () => {
      App.setTool('addpin');
      App.toast('Click on or near the component to place the new pin.', 'info');
    });
    on('i-pinedit', () => {
      App.editor.pinEdit = !App.editor.pinEdit;
      renderInspector();
      App.renderOverlay();
    });
    on('i-zoom', () => App.zoomTo(App.compBounds(c), 25));
    on('i-rot', () => App.rotateSelection(90));
    on('i-dup', () => App.duplicateSelection());
    on('i-del', () => App.deleteSelection());
  }

  function inspectWire(el, w) {
    const doc = state.doc;
    const st = App.wireStyle(w);
    const net = App.traceNet(w.id);
    const colourBtns = doc.colors.map((c) => `<button data-colour="${esc(c.code)}" class="${c.code === w.color ? 'on' : ''}" title="${esc(c.name)}">${swatch(c.code)}${esc(c.code)}</button>`).join('');
    const mfDefault = (App.colorDef(w.color) || {}).mf;
    const mfOpts = `<option value="">Default${mfDefault ? ' (' + esc(mfDefault) + ')' : ''}</option>` + doc.mfColors.map((m) => `<option value="${esc(m.code)}"${m.code === w.mfColor ? ' selected' : ''}>${esc(m.code)} – ${esc(m.name)}</option>`).join('');
    const sameCircuit = w.circuit ? doc.wires.filter((o) => o.circuit === w.circuit).length : 0;
    el.innerHTML = `<h3 class="mono">${esc(w.circuit || 'No circuit number')}</h3><div class="sub">${swatch(w)} ${esc(st.name)} · <span class="mono">${esc(w.id)}</span></div>
      ${field('Circuit no.', `<input data-k="circuit" class="mono" value="${esc(w.circuit || '')}" placeholder="e.g. 15065">`)}
      ${field('Colour', `<div class="colour-pick">${colourBtns}</div>`)}
      ${field('Harness colour', `<select data-k="mfColor">${mfOpts}</select>`)}
      ${field('Gauge', `<input data-k="gauge" list="gauges" value="${esc(w.gauge || '')}" placeholder="e.g. 1.0 mm² / 16 AWG"><datalist id="gauges">${GAUGES.map((g) => `<option>${g}</option>`).join('')}</datalist>`)}
      ${field('Length', `<input data-k="length" value="${esc(w.length || '')}" placeholder="e.g. 850 mm">`)}
      ${field('Options', `<label class="check"><input type="checkbox" data-k="optional"${w.optional ? ' checked' : ''}> Optional fitment</label>`)}
      ${field('Notes', `<textarea data-k="notes">${esc(w.notes || '')}</textarea>`)}
      <div class="section"><div class="title">Ends</div>
        <div class="row" data-goto="${esc(w.from.c)}"><span class="muted">From</span><span class="grow">${esc(App.endLabel(w.from))}</span></div>
        <div class="row" data-goto="${esc(w.to.c)}"><span class="muted">To</span><span class="grow">${esc(App.endLabel(w.to))}</span></div>
        <div class="hint">Drag the round end handles onto another pin to reconnect.</div>
      </div>
      <div class="section"><div class="title">Net</div>
        <div class="hint">${net.size} wire${net.size === 1 ? '' : 's'} electrically joined (through splices and connectors)${sameCircuit > 1 ? `; ${sameCircuit} wires carry ${esc(w.circuit)}` : ''}.</div>
        <div class="actions"><button class="btn small" id="i-trace">Trace net (T)</button>${sameCircuit > 1 ? '<button class="btn small" id="i-circ">Select circuit</button>' : ''}</div>
      </div>
      <div class="section"><div class="title">Route &amp; labels</div>
        <div class="actions">
          <button class="btn small" id="i-square" title="Make every segment horizontal or vertical">Square up</button>
          <button class="btn small" id="i-straight" title="Remove all bends">Straight</button>
          <button class="btn small" id="i-splice" title="Insert a splice in the middle of this wire">Add splice</button>
          <button class="btn small" id="i-label">Add label</button>
          ${w.labels.length ? '<button class="btn small" id="i-unlabel">Auto label</button>' : ''}
        </div>
      </div>
      <div class="actions section"><button class="btn small" id="i-zoom">Zoom to</button><button class="btn small danger" id="i-del">Delete wire</button></div>`;
    $$('[data-k]', el).forEach((inp) => inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      const v = inp.type === 'checkbox' ? inp.checked : inp.value.trim();
      App.mutate(() => {
        if (v === '' || v === false) delete w[k];
        else w[k] = v;
        if (k === 'circuit') w.circuit = v || '';
      });
    }));
    $$('[data-colour]', el).forEach((b) => b.addEventListener('click', () => {
      state.prefs.lastColor = b.dataset.colour;
      App.savePrefs();
      App.mutate(() => (w.color = b.dataset.colour));
      App.resetRenderCache();
      App.render();
    }));
    $$('[data-goto]', el).forEach((r) => r.addEventListener('click', () => selectComp(r.dataset.goto, true)));
    const on = (id, fn) => {
      const b = $('#' + id);
      if (b) b.addEventListener('click', fn);
    };
    on('i-trace', () => App.traceSelection());
    on('i-circ', () => App.selectCircuit(w.circuit));
    on('i-square', () => App.mutate(() => App.orthogonalize(w)));
    on('i-straight', () => App.mutate(() => (w.points = [App.wirePoints(w)[0], App.wirePoints(w).pop()])));
    on('i-splice', () => {
      const pts = App.wirePoints(w);
      let best = 0;
      for (let i = 1; i < pts.length - 1; i++) if (Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) > Math.hypot(pts[best + 1][0] - pts[best][0], pts[best + 1][1] - pts[best][1])) best = i;
      const mx = (pts[best][0] + pts[best + 1][0]) / 2, my = (pts[best][1] + pts[best + 1][1]) / 2;
      const sp = App.mutate(() => App.spliceWire(w, mx, my));
      selectComp(sp.id);
    });
    on('i-label', () => App.mutate(() => {
      const pts = App.wirePoints(w);
      let best = 0, bl = -1;
      for (let i = 0; i < pts.length - 1; i++) {
        const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        if (L > bl) {
          bl = L;
          best = i;
        }
      }
      w.labels.push([App.round((pts[best][0] + pts[best + 1][0]) / 2), App.round((pts[best][1] + pts[best + 1][1]) / 2)]);
    }));
    on('i-unlabel', () => App.mutate(() => (w.labels = [])));
    on('i-zoom', () => App.zoomTo(wireBox([w.id]), 20));
    on('i-del', () => App.deleteSelection());
  }

  function inspectMulti(el) {
    const comps = [...state.sel.comps].map(App.comp).filter(Boolean);
    const wires = [...state.sel.wires].map(App.wire).filter(Boolean);
    const circuits = [...new Set(wires.map((w) => w.circuit).filter(Boolean))];
    const colourBtns = state.doc.colors.map((c) => `<button data-colour="${esc(c.code)}" title="${esc(c.name)}">${swatch(c.code)}${esc(c.code)}</button>`).join('');
    el.innerHTML = `<h3>${comps.length + wires.length} items selected</h3>
      <div class="sub">${comps.length} component${comps.length === 1 ? '' : 's'}, ${wires.length} wire${wires.length === 1 ? '' : 's'}${circuits.length ? ' · circuits ' + esc(circuits.join(', ')) : ''}</div>
      ${state.highlight ? `<div class="hint">Tracing ${state.highlight.size} wires. Press <span class="kbd">Esc</span> to clear.</div>` : ''}
      ${wires.length ? `<div class="section"><div class="title">Wires</div>
        ${field('Set colour', `<div class="colour-pick">${colourBtns}</div>`)}
        ${field('Set circuit', `<input id="m-circuit" class="mono" placeholder="${circuits.length === 1 ? esc(circuits[0]) : 'circuit no.'}">`)}
        <table class="grid"><tbody>${wires.map((w) => `<tr class="clickable" data-wire="${esc(w.id)}"><td class="mono">${esc(w.circuit || '—')}</td><td>${swatch(w)}</td><td>${esc(App.endLabel(w.from))} <span class="muted">→</span> ${esc(App.endLabel(w.to))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${comps.length ? `<div class="section"><div class="title">Components</div>${comps.map((c) => `<div class="row" data-comp="${esc(c.id)}"><span class="grow">${esc(c.name)}</span></div>`).join('')}</div>` : ''}
      <div class="actions section">
        <button class="btn small" id="m-zoom">Zoom to</button>
        ${comps.length ? '<button class="btn small" id="m-rot">Rotate 90°</button><button class="btn small" id="m-dup">Duplicate</button>' : ''}
        <button class="btn small danger" id="m-del">Delete</button>
      </div>`;
    $$('[data-colour]', el).forEach((b) => b.addEventListener('click', () => App.mutate(() => wires.forEach((w) => (w.color = b.dataset.colour)))));
    const mc = $('#m-circuit');
    if (mc) mc.addEventListener('change', () => App.mutate(() => wires.forEach((w) => (w.circuit = mc.value.trim()))));
    $$('[data-wire]', el).forEach((r) => r.addEventListener('click', () => selectWires([r.dataset.wire], true)));
    $$('[data-comp]', el).forEach((r) => r.addEventListener('click', () => selectComp(r.dataset.comp, true)));
    const on = (id, fn) => {
      const b = $('#' + id);
      if (b) b.addEventListener('click', fn);
    };
    on('m-zoom', () => {
      const b = wires.length ? wireBox(wires.map((w) => w.id)) : { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const c of comps) {
        const cb = App.compBounds(c);
        b.x0 = Math.min(b.x0, cb.x0);
        b.y0 = Math.min(b.y0, cb.y0);
        b.x1 = Math.max(b.x1, cb.x1);
        b.y1 = Math.max(b.y1, cb.y1);
      }
      App.zoomTo(b, 20);
    });
    on('m-rot', () => App.rotateSelection(90));
    on('m-dup', () => App.duplicateSelection());
    on('m-del', () => App.deleteSelection());
  }

  // ------------------------------------------------------------------ toolbar, menus
  function syncToolbar() {
    $$('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === App.editor.tool));
    $$('[data-scheme]').forEach((b) => b.classList.toggle('active', b.dataset.scheme === state.prefs.scheme));
    $('#label-mode').value = state.prefs.labelMode;
    $('#btn-undo').disabled = !App.canUndo();
    $('#btn-redo').disabled = !App.canRedo();
    $('#project-name').textContent = state.doc ? state.doc.meta.title || 'Untitled' : '—';
  }
  function closeMenus(except) {
    $$('.menu').forEach((m) => {
      if (m !== except) m.hidden = true;
    });
  }
  function toggleMenu(menu) {
    const open = menu.hidden;
    closeMenus();
    menu.hidden = !open;
  }
  function renderProjectList() {
    const list = App.listProjects();
    $('#project-list-label').textContent = App.cloud && App.cloud.enabled ? 'Shared harnesses' : 'Saved in this browser';
    $('#project-list').innerHTML = list.map((p) => `<button data-open="${esc(p.id)}" class="${p.id === state.projectId ? 'current' : ''}">${esc(p.name)}<span class="sub">${new Date(p.updated).toLocaleString()}</span></button>`).join('') || '<div class="hint" style="padding:4px 10px">None yet.</div>';
    $$('[data-open]', $('#project-list')).forEach((b) => b.addEventListener('click', async () => {
      closeMenus();
      if (await App.openProject(b.dataset.open)) afterLoad();
    }));
  }
  async function projectCommand(cmd) {
    closeMenus();
    try {
      await runProjectCommand(cmd);
    } catch (e) {
      App.toast(e.message || String(e), 'error');
    }
  }
  async function runProjectCommand(cmd) {
    const seed = window.HARNESS_SEEDS['eh-holden'];
    switch (cmd) {
      case 'new': {
        const name = prompt('Name for the new harness:', 'New harness');
        if (name == null) return;
        await App.createProject(App.blankDoc(), name || 'New harness');
        afterLoad();
        break;
      }
      case 'example':
        await App.createProject(seed, seed.meta.title);
        afterLoad();
        App.toast('Loaded the EH Holden example as a new harness.');
        break;
      case 'duplicate':
        await App.createProject(App.exportDoc(), (state.doc.meta.title || 'Harness') + ' (copy)');
        afterLoad();
        break;
      case 'rename': {
        const name = prompt('Rename harness:', state.doc.meta.title || '');
        if (name) App.renameProject(name);
        break;
      }
      case 'import':
        $('#file-import').click();
        break;
      case 'backups':
        await App.showBackups();
        break;
      case 'signout':
        await App.signOut();
        break;
      case 'export-json':
        download(fileStem() + '.harness.json', JSON.stringify(App.exportDoc(), null, 1), 'application/json');
        break;
      case 'export-svg':
        App.renderNow();
        download(fileStem() + '.svg', App.exportSVG(), 'image/svg+xml');
        break;
      case 'export-csv':
        download(fileStem() + '-wires.csv', wireCSV(), 'text/csv');
        break;
      case 'print':
        printSchedule();
        break;
      case 'reset-example':
        if (!confirm(App.cloud && App.cloud.enabled
          ? 'Replace everything in this harness with the original EH Holden example, for everyone editing it? The current version is backed up first and can be restored from Backups.'
          : 'Replace everything in this harness with the original EH Holden example? This cannot be undone — export a JSON copy first if you need one.')) return;
        await App.replaceDoc(seed);
        afterLoad();
        break;
      case 'delete': {
        const where = App.cloud && App.cloud.enabled ? 'for everyone' : 'from this browser';
        if (!confirm(`Delete "${state.doc.meta.title}" ${where}? Export it first if you want a copy.`)) return;
        await App.deleteProject(state.projectId);
        const next = App.lastProjectId();
        state.projectId = null;
        if (!(next && (await App.openProject(next)))) await App.createProject(seed, seed.meta.title);
        afterLoad();
        break;
      }
    }
  }
  function wireRows() {
    return state.doc.wires.slice().sort((a, b) => (a.circuit || '~').localeCompare(b.circuit || '~')).map((w) => {
      const def = App.colorDef(w.color) || { name: w.color };
      const mf = state.doc.mfColors.find((m) => m.code === (w.mfColor || def.mf));
      return {
        circuit: w.circuit || '', oem: def.name || w.color, mf: mf ? mf.name : '', gauge: w.gauge || '', length: w.length || '',
        from: App.endLabel(w.from), to: App.endLabel(w.to), optional: w.optional ? 'yes' : '', notes: w.notes || '', id: w.id,
      };
    });
  }
  function wireCSV() {
    const cols = ['circuit', 'oem', 'mf', 'gauge', 'length', 'from', 'to', 'optional', 'notes', 'id'];
    const head = ['Circuit', 'OEM colour', 'Harness colour', 'Gauge', 'Length', 'From', 'To', 'Optional', 'Notes', 'Wire id'];
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    return [head.map(q).join(',')].concat(wireRows().map((r) => cols.map((c) => q(r[c])).join(','))).join('\r\n');
  }
  function printSchedule() {
    const rows = wireRows();
    const win = window.open('', '_blank');
    if (!win) return App.toast('Allow pop-ups to print the wire schedule.', 'warn');
    const doc = state.doc;
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.meta.title)} – wire schedule</title>
      <style>body{font:12px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0}p{color:#555;margin:4px 0 14px}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}
      th{background:#f2f4f7}td.m{font-family:monospace}tr:nth-child(even) td{background:#fafbfc}</style></head><body>
      <h1>${esc(doc.meta.title)}</h1><p>${esc(doc.meta.description || '')}${doc.meta.drawingNo ? ' · ' + esc(doc.meta.drawingNo) : ''} · ${rows.length} wires · printed ${new Date().toLocaleDateString()}</p>
      <table><thead><tr><th>Circuit</th><th>OEM colour</th><th>Harness colour</th><th>Gauge</th><th>Length</th><th>From</th><th>To</th><th>Notes</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="m">${esc(r.circuit)}</td><td>${esc(r.oem)}</td><td>${esc(r.mf)}</td><td>${esc(r.gauge)}</td><td>${esc(r.length)}</td><td>${esc(r.from)}</td><td>${esc(r.to)}</td><td>${esc((r.optional ? 'Optional. ' : '') + r.notes)}</td></tr>`).join('')}
      </tbody></table></body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch (e) {
        return App.toast('That file is not valid JSON.', 'error');
      }
      if (!data || !Array.isArray(data.components) || !Array.isArray(data.wires)) return App.toast('That JSON does not look like a harness export (needs components and wires).', 'error');
      Promise.resolve(App.createProject(data, (data.meta && data.meta.title) || file.name.replace(/\.json$/i, '')))
        .then(() => {
          afterLoad();
          App.toast(`Imported ${data.components.length} components and ${data.wires.length} wires.`);
        })
        .catch((e) => App.toast(e.message || String(e), 'error'));
    };
    reader.readAsText(file);
  }

  // ------------------------------------------------------------------ search
  function runSearch() {
    const q = $('#search').value.trim().toLowerCase();
    const box = $('#search-results');
    if (!q) {
      box.hidden = true;
      return;
    }
    const res = [];
    const circuits = [...new Set(state.doc.wires.map((w) => w.circuit).filter(Boolean))].sort();
    for (const c of circuits) if (c.toLowerCase().includes(q)) res.push({ kind: 'circuit', id: c, label: c, sub: 'Circuit · ' + circuitEnds(state.doc.wires.filter((w) => w.circuit === c)).join(' · ') });
    for (const c of state.doc.components) {
      if (c.style === 'splice') continue;
      if ((c.name + ' ' + c.id).toLowerCase().includes(q)) res.push({ kind: 'comp', id: c.id, label: c.name, sub: c.type });
    }
    box.innerHTML = res.slice(0, 30).map((r, i) => `<button data-i="${i}" class="${i === 0 ? 'focus' : ''}"><span class="${r.kind === 'circuit' ? 'mono' : ''}">${esc(r.label)}</span><span class="sub">${esc(r.sub)}</span></button>`).join('') || '<div class="hint" style="padding:6px 10px">No matches.</div>';
    box.hidden = false;
    box._results = res;
    $$('button', box).forEach((b) => b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickResult(res[+b.dataset.i]);
    }));
  }
  function pickResult(r) {
    if (!r) return;
    $('#search-results').hidden = true;
    $('#search').blur();
    if (r.kind === 'circuit') App.selectCircuit(r.id);
    else selectComp(r.id, true);
  }

  // ------------------------------------------------------------------ hover tooltip & HUD
  function onHover(h) {
    const tip = $('#tooltip');
    if (!h || !h.kind || App.editor.tool !== 'select' && App.editor.tool !== 'wire') {
      tip.hidden = true;
      return;
    }
    let html = '';
    if (h.kind === 'wire' || h.kind === 'label') {
      const w = App.wire(h.id);
      if (!w) return;
      const st = App.wireStyle(w);
      html = `<b class="mono">${esc(w.circuit || 'No circuit no.')}</b> ${swatch(w)} ${esc(st.name)}<br>${esc(App.endLabel(w.from))}<br>→ ${esc(App.endLabel(w.to))}${w.gauge ? '<br><span class="muted">' + esc(w.gauge) + '</span>' : ''}`;
    } else if (h.kind === 'pin') {
      const c = App.comp(h.id);
      const p = App.pin(c, h.pin);
      if (!c || !p) return;
      const ws = App.wiresAt(c.id, p.id);
      html = `<b>${esc(c.name)}</b> · pin ${esc(p.name)}<br><span class="muted">${ws.map((w) => esc(w.circuit || w.color)).join(', ') || 'no wires'}</span>`;
    } else if (h.kind === 'comp') {
      const c = App.comp(h.id);
      if (!c || c.type === 'panel') {
        tip.hidden = true;
        return;
      }
      html = `<b>${esc(c.name)}</b><br><span class="muted">${esc(c.type)} · ${c.pins.length} pins · ${App.wiresAt(c.id).length} wires</span>`;
    } else {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const x = Math.min(h.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(h.clientY + 16, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function renderHud() {
    const hud = $('#hud');
    const t = App.editor.tool;
    if (t === 'wire') {
      hud.innerHTML = App.overlay.draftBase
        ? 'Click to add a bend · click a <b>pin</b> or <b>wire</b> to finish · double-click to end on a terminal · <b>Esc</b> cancels'
        : 'Click a <b>pin</b> to start a wire, or click an existing <b>wire</b> to branch from a new splice';
    } else if (t === 'place') hud.innerHTML = `Click to place <b>${esc(App.editor.template.name)}</b> · <b>Esc</b> cancels`;
    else if (t === 'addpin') hud.innerHTML = 'Click to place the new pin · <b>Esc</b> cancels';
    else if (state.highlight) hud.innerHTML = `Tracing <b>${state.highlight.size}</b> wire${state.highlight.size === 1 ? '' : 's'} · <b>Esc</b> to clear`;
    else hud.innerHTML = '';
  }
  function renderStatus() {
    const doc = state.doc;
    const tools = { select: 'Select', wire: 'Draw wire', place: 'Place component', addpin: 'Add pin' };
    $('#st-tool').textContent = tools[App.editor.tool] || '';
    $('#st-zoom').textContent = Math.round(App.view.k * 100) + '%';
    const comps = doc.components.filter((c) => c.type !== 'panel' && c.style !== 'splice').length;
    $('#st-counts').textContent = `${comps} components · ${doc.wires.length} wires · ${new Set(doc.wires.map((w) => w.circuit).filter(Boolean)).size} circuits`;
  }

  // ------------------------------------------------------------------ wiring up
  let panelTimer = 0;
  function editingIn(sel) {
    const a = document.activeElement;
    return a && a.closest(sel) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'range';
  }
  const stale = { list: false, inspector: false };
  function refreshPanels() {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => {
      if (editingIn('#tab-body .list')) stale.list = true;
      else renderTabList();
      if (editingIn('#inspector')) stale.inspector = true;
      else renderInspector();
      renderStatus();
      renderHud();
      syncToolbar();
    }, 30);
  }
  function afterLoad() {
    App.resetRenderCache();
    $('#tab-body').dataset.tab = '';
    renderTabs();
    renderInspector();
    syncToolbar();
    renderProjectList();
    App.renderNow();
    App.fitView();
    App.renderOverlay();
    renderStatus();
  }

  function bind() {
    $('#btn-project').addEventListener('click', (e) => {
      e.stopPropagation();
      renderProjectList();
      if (App.cloud && App.cloud.enabled) App.refreshProjects().catch(() => {});
      toggleMenu($('#menu-project'));
    });
    $$('#menu-project [data-cmd]').forEach((b) => b.addEventListener('click', () => projectCommand(b.dataset.cmd)));
    $('#menu-add').innerHTML = App.templates.map((t) => `<button data-tpl="${t.key}">${esc(t.menu || t.name)}</button>`).join('');
    $('#btn-add').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu($('#menu-add'));
    });
    $$('#menu-add [data-tpl]').forEach((b) => b.addEventListener('click', () => {
      closeMenus();
      App.setTool('place', App.templates.find((t) => t.key === b.dataset.tpl));
    }));
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu') && !e.target.closest('.menu-btn')) closeMenus();
    });
    $('#btn-undo').addEventListener('click', () => App.undo());
    $('#btn-redo').addEventListener('click', () => App.redo());
    $$('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => App.setTool(b.dataset.tool)));
    $$('[data-scheme]').forEach((b) => b.addEventListener('click', () => setPref('scheme', b.dataset.scheme)));
    $('#label-mode').addEventListener('change', (e) => setPref('labelMode', e.target.value));
    $('#btn-fit').addEventListener('click', () => {
      App.fitView();
      App.renderOverlay();
    });
    $('#btn-zoom-in').addEventListener('click', () => {
      App.zoomAt(1.25);
      App.renderOverlay();
    });
    $('#btn-zoom-out').addEventListener('click', () => {
      App.zoomAt(0.8);
      App.renderOverlay();
    });
    $('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
      state.prefs.leftTab = b.dataset.tab;
      App.savePrefs();
      renderTabs();
    }));
    $$('.panel-toggle').forEach((b) => b.addEventListener('click', () => document.body.classList.toggle('show-' + b.dataset.panel)));

    const search = $('#search');
    search.addEventListener('input', runSearch);
    search.addEventListener('focus', runSearch);
    search.addEventListener('blur', () => setTimeout(() => ($('#search-results').hidden = true), 150));
    search.addEventListener('keydown', (e) => {
      const box = $('#search-results');
      if (e.key === 'Enter') pickResult((box._results || [])[Math.max(0, $$('button', box).findIndex((b) => b.classList.contains('focus')))]);
      else if (e.key === 'Escape') {
        search.value = '';
        box.hidden = true;
        search.blur();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const btns = $$('button', box);
        let i = btns.findIndex((b) => b.classList.contains('focus'));
        btns.forEach((b) => b.classList.remove('focus'));
        i = Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        if (btns[i]) {
          btns[i].classList.add('focus');
          btns[i].scrollIntoView({ block: 'nearest' });
        }
      }
    });
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        search.focus();
        search.select();
      }
    });

    $('#file-import').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) importFile(f);
      e.target.value = '';
    });
    $('#file-ref').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        App.setReferenceImage(reader.result);
        state.prefs.showRef = true;
        App.savePrefs();
        renderTabList();
      };
      reader.readAsDataURL(f);
    });

    App.on('change', () => {
      App.render();
      refreshPanels();
    });
    App.on('selection', () => {
      if (!state.sel.comps.size) App.editor.pinEdit = false;
      App.render();
      refreshPanels();
    });
    App.on('history', syncToolbar);
    App.on('tool', () => {
      syncToolbar();
      renderHud();
      renderStatus();
    });
    App.on('view', () => {
      $('#st-zoom').textContent = Math.round(App.view.k * 100) + '%';
    });
    App.on('cursor', ([x, y]) => {
      $('#st-cursor').textContent = `${x.toFixed(1)}, ${y.toFixed(1)}`;
      if (App.editor.tool === 'wire') renderHud();
    });
    App.on('hover', onHover);
    App.on('dirty', () => {
      const s = $('#st-save');
      s.textContent = 'Saving…';
      s.className = 'dirty';
    });
    App.on('saved', (ok) => {
      const s = $('#st-save');
      s.textContent = ok ? 'Saved in this browser' : 'Not saved';
      s.className = ok ? '' : 'dirty';
    });
    App.on('docLoaded', () => syncToolbar());
    App.on('wireCreated', () => {
      if (state.prefs.leftTab !== 'wires') return;
      renderTabList();
    });
    window.addEventListener('beforeunload', () => App.saveNow());
    window.addEventListener('resize', () => App.render());
  }

  App.afterLoad = () => afterLoad();
  App.refreshProjectMenu = () => renderProjectList();

  // ------------------------------------------------------------------ boot
  async function boot() {
    App.loadPrefs();
    const svg = $('#canvas');
    App.initRender(svg);
    App.initEditor(svg);
    bind();
    document.addEventListener('focusout', () => setTimeout(() => {
      if (stale.list && !editingIn('#tab-body .list')) {
        stale.list = false;
        renderTabList();
      }
      if (stale.inspector && !editingIn('#inspector')) {
        stale.inspector = false;
        renderInspector();
      }
    }, 0));
    // served by the Worker: shared, live harnesses; opened from disk: this browser only
    if (App.startCloud) await App.startCloud();
    try {
      const last = App.lastProjectId();
      if (!(last && (await App.openProject(last)))) {
        const seed = window.HARNESS_SEEDS['eh-holden'];
        await App.createProject(seed, seed.meta.title);
      }
    } catch (e) {
      App.toast(e.message || String(e), 'error');
      return;
    }
    afterLoad();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
