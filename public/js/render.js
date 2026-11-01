/* SVG rendering: components (extracted artwork or generated symbols), wires with hops, labels, overlays. */
(function () {
  'use strict';
  const App = window.App;
  const state = App.state;
  const NS = 'http://www.w3.org/2000/svg';
  const esc = App.esc;

  const view = (App.view = { tx: 0, ty: 0, k: 1 });
  const els = {};
  const compCache = new Map(); // id -> {el, key}
  App.cache = { wirePts: new Map() };

  App.initRender = function (svg) {
    els.svg = svg;
    svg.innerHTML = `
      <defs>
        <pattern id="grid-minor" width="5" height="5" patternUnits="userSpaceOnUse">
          <path d="M5 0H0V5" fill="none" stroke="#dfe6ee" stroke-width="0.12"/>
        </pattern>
        <pattern id="grid-major" width="50" height="50" patternUnits="userSpaceOnUse">
          <rect width="50" height="50" fill="url(#grid-minor)"/>
          <path d="M50 0H0V50" fill="none" stroke="#c6d2de" stroke-width="0.25"/>
        </pattern>
      </defs>
      <g id="viewport">
        <rect id="paper" x="0" y="0" fill="#fff"/>
        <rect id="grid" x="0" y="0" fill="url(#grid-major)"/>
        <image id="ref-img" preserveAspectRatio="none"/>
        <g id="layer-panels"></g>
        <g id="layer-wires"></g>
        <g id="layer-comps"></g>
        <g id="layer-labels"></g>
        <g id="layer-overlay"></g>
      </g>`;
    for (const id of ['viewport', 'paper', 'grid', 'ref-img', 'layer-panels', 'layer-wires', 'layer-comps', 'layer-labels', 'layer-overlay']) {
      els[id] = svg.querySelector('#' + id);
    }
  };

  App.applyView = function () {
    els.viewport.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.k})`);
    els.svg.style.setProperty('--k', view.k);
    App.emit('view');
  };
  App.screenToWorld = function (sx, sy) {
    const r = els.svg.getBoundingClientRect();
    return [(sx - r.left - view.tx) / view.k, (sy - r.top - view.ty) / view.k];
  };
  App.fitView = function (box) {
    const r = els.svg.getBoundingClientRect();
    const b = box || { x0: -10, y0: -10, x1: state.doc.page.w + 10, y1: state.doc.page.h + 10 };
    const k = Math.min(r.width / (b.x1 - b.x0), r.height / (b.y1 - b.y0)) * 0.96;
    view.k = Math.max(0.1, Math.min(k, 40));
    view.tx = (r.width - (b.x1 - b.x0) * view.k) / 2 - b.x0 * view.k;
    view.ty = (r.height - (b.y1 - b.y0) * view.k) / 2 - b.y0 * view.k;
    App.applyView();
  };
  App.zoomAt = function (factor, sx, sy) {
    const r = els.svg.getBoundingClientRect();
    if (sx == null) {
      sx = r.left + r.width / 2;
      sy = r.top + r.height / 2;
    }
    const k2 = Math.max(0.1, Math.min(view.k * factor, 60));
    const px = sx - r.left, py = sy - r.top;
    view.tx = px - ((px - view.tx) * k2) / view.k;
    view.ty = py - ((py - view.ty) * k2) / view.k;
    view.k = k2;
    App.applyView();
  };
  App.zoomTo = function (box, pad) {
    pad = pad == null ? 30 : pad;
    App.fitView({ x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad });
  };

  // ------------------------------------------------------------------ components
  function artMarkup(c) {
    const art = state.art[c.artRef] || [];
    let s = '';
    for (const a of art) {
      if (a.fill && !a.stroke) s += `<path d="${a.d}" fill="${a.fill}" stroke="${a.fill}" stroke-width="0.12"/>`;
      else s += `<path d="${a.d}" fill="${a.fill || 'none'}" stroke="${a.stroke}" stroke-width="${a.sw || 0.3}"/>`;
    }
    if (c.image) s += `<image href="${c.image.href}" x="${c.image.x}" y="${c.image.y}" width="${c.image.w}" height="${c.image.h}"/>`;
    return s;
  }

  const SYM_STROKE = 'fill="none" stroke="#111" stroke-width="0.5"';
  function symbolMarkup(c) {
    const w = c.w, h = c.h, cx = w / 2, cy = h / 2, r = Math.max(1, Math.min(w, h) / 2 - 1);
    switch (c.style) {
      case 'lamp': {
        const d = r * 0.7;
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="#111" stroke-width="0.5"/>
          <path d="M${cx - d} ${cy - d}L${cx + d} ${cy + d}M${cx + d} ${cy - d}L${cx - d} ${cy + d}" ${SYM_STROKE}/>`;
      }
      case 'motor':
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="#111" stroke-width="0.5"/>
          <text x="${cx}" y="${cy}" class="sym-text" font-size="${Math.min(r * 1.2, 8)}">M</text>`;
      case 'switch':
        return `<rect width="${w}" height="${h}" fill="#fff" stroke="#111" stroke-width="0.5"/>
          <circle cx="${w * 0.3}" cy="${cy}" r="0.9" ${SYM_STROKE}/><circle cx="${w * 0.7}" cy="${cy}" r="0.9" ${SYM_STROKE}/>
          <path d="M${w * 0.3 + 0.8} ${cy - 0.4}L${w * 0.68} ${cy - h * 0.25}" ${SYM_STROKE}/>`;
      case 'relay': {
        const zx = w * 0.25, zy = h * 0.3, zh = h * 0.4;
        return `<rect width="${w}" height="${h}" fill="#fff" stroke="#111" stroke-width="0.5"/>
          <rect x="${zx - 2}" y="${zy}" width="4" height="${zh}" ${SYM_STROKE}/>
          <path d="M${zx - 2} ${zy + zh}L${zx + 2} ${zy}" ${SYM_STROKE}/>
          <path d="M${w * 0.6} ${cy + h * 0.2}L${w * 0.6} ${cy}L${w * 0.78} ${cy - h * 0.15}M${w * 0.78} ${cy}L${w * 0.78} ${cy - h * 0.25}" ${SYM_STROKE}/>`;
      }
      case 'fuse':
        return `<rect width="${w}" height="${h}" fill="#fff" stroke="#111" stroke-width="0.5"/>
          <path d="M${cx} 2C${cx + w * 0.35} ${h * 0.3} ${cx - w * 0.35} ${h * 0.7} ${cx} ${h - 2}" ${SYM_STROKE}/>`;
      case 'connector':
        return `<rect width="${w}" height="${h}" fill="#fff" stroke="#111" stroke-width="0.5"/>` +
          (h >= w ? `<path d="M${cx} 0V${h}" ${SYM_STROKE}/>` : `<path d="M0 ${cy}H${w}" ${SYM_STROKE}/>`);
      case 'ground':
        return `<path d="M${cx} 0V${h * 0.45}M${cx - w * 0.45} ${h * 0.45}H${cx + w * 0.45}M${cx - w * 0.3} ${h * 0.65}H${cx + w * 0.3}M${cx - w * 0.15} ${h * 0.85}H${cx + w * 0.15}" fill="none" stroke="#111" stroke-width="0.6"/>`;
      case 'battery':
        return `<rect width="${w}" height="${h}" fill="#fff" stroke="#111" stroke-width="0.5"/>
          <path d="M${cx - 2} ${h * 0.25}V${h * 0.75}M${cx + 2} ${h * 0.35}V${h * 0.65}" fill="none" stroke="#111" stroke-width="0.8"/>`;
      case 'terminal':
        return `<circle cx="${cx}" cy="${cy}" r="1.2" fill="#fff" stroke="#111" stroke-width="0.4"/>`;
      case 'note': {
        const fs = c.fontSize || 6;
        const lines = String(c.text || c.name || '').split('\n');
        return lines.map((ln, i) => `<text x="0" y="${fs * (i + 0.85)}" class="note-text" font-size="${fs}">${esc(ln)}</text>`).join('');
      }
      default:
        return `<rect width="${w}" height="${h}" rx="1" fill="#fff" stroke="#111" stroke-width="0.5"/>`;
    }
  }
  function nameMarkup(c) {
    if (c.style === 'art' || c.style === 'splice' || c.style === 'note' || c.style === 'terminal' || c.showLabel === false) return '';
    const fs = 4.2;
    const inside = c.style === 'box' && c.h >= 8;
    const rot = c.rot || 0;
    // keep the name upright and below the part whatever its rotation
    const turned = rot === 90 || rot === 270;
    const half = (turned ? c.w : c.h) / 2;
    const y = inside && !turned ? c.h / 2 : c.h / 2 + half + fs * 0.9;
    const tf = rot ? ` transform="rotate(${-rot} ${c.w / 2} ${c.h / 2})"` : '';
    return `<text x="${c.w / 2}" y="${y}" class="comp-name" font-size="${fs}"${tf}>${esc(c.name)}</text>`;
  }
  function pinsMarkup(c) {
    let s = '';
    for (const p of c.pins) {
      s += `<circle class="pin" data-kind="pin" data-c="${esc(c.id)}" data-p="${esc(p.id)}" cx="${p.x}" cy="${p.y}" r="1.3"><title>${esc(c.name)} · ${esc(p.name)}</title></circle>`;
      if (c.showPinNames && c.style !== 'art') s += `<text class="pin-name" x="${p.x}" y="${p.y - 1.8}" font-size="2.8">${esc(p.name)}</text>`;
    }
    return s;
  }
  function compInner(c) {
    if (c.style === 'splice') {
      const w = App.wiresAt(c.id)[0];
      const col = w ? App.wireStyle(w) : { hex: '#333' };
      const fill = col.outline ? '#545454' : col.hex;
      return `<circle class="splice-dot" cx="${c.w / 2}" cy="${c.h / 2}" r="1.6" fill="${fill}"/>
        <circle class="hit" cx="${c.w / 2}" cy="${c.h / 2}" r="3"/>` + pinsMarkup(c);
    }
    const body = c.style === 'art' ? artMarkup(c) : symbolMarkup(c);
    return `<g class="body">${body}</g>${nameMarkup(c)}<rect class="hit" width="${c.w}" height="${c.h}"/><g class="pins">${pinsMarkup(c)}</g>`;
  }
  function compKey(c) {
    let k = [c.style, c.w, c.h, c.rot, c.name, c.artRef, c.text, c.fontSize, c.showLabel, c.showPinNames, JSON.stringify(c.pins)].join('|');
    if (c.style === 'splice') {
      const w = App.wiresAt(c.id)[0];
      k += '|' + (w ? App.wireStyle(w).hex : '');
    }
    return k;
  }

  function renderComponents() {
    const seen = new Set();
    const showPanels = state.prefs.showPanels;
    const dimSet = state.highlight;
    let dimComps = null;
    if (dimSet && state.prefs.dim) {
      dimComps = new Set();
      for (const id of dimSet) {
        const w = App.wire(id);
        if (w) {
          dimComps.add(w.from.c);
          dimComps.add(w.to.c);
        }
      }
    }
    for (const c of state.doc.components) {
      seen.add(c.id);
      let entry = compCache.get(c.id);
      const parent = c.type === 'panel' ? els['layer-panels'] : els['layer-comps'];
      if (!entry) {
        const g = document.createElementNS(NS, 'g');
        g.dataset.kind = 'comp';
        g.dataset.id = c.id;
        entry = { el: g, key: null };
        compCache.set(c.id, entry);
      }
      if (entry.el.parentNode !== parent) parent.appendChild(entry.el);
      const key = compKey(c);
      if (key !== entry.key) {
        entry.el.innerHTML = compInner(c);
        entry.key = key;
      }
      const rot = c.rot ? ` rotate(${c.rot} ${c.w / 2} ${c.h / 2})` : '';
      entry.el.setAttribute('transform', `translate(${c.x},${c.y})${rot}`);
      let cls = 'comp style-' + c.style + ' type-' + (c.type || 'x');
      if (state.sel.comps.has(c.id)) cls += ' selected';
      if (c.locked) cls += ' locked';
      if (c.type === 'panel' && !showPanels) cls += ' hidden';
      if (dimComps && !dimComps.has(c.id) && c.type !== 'panel') cls += ' dim';
      if (c.optional) cls += ' optional';
      entry.el.setAttribute('class', cls);
    }
    // keep draw order = document order
    const order = state.doc.components;
    for (const layer of [els['layer-panels'], els['layer-comps']]) {
      const kids = [...layer.children];
      const want = order.filter((c) => compCache.get(c.id) && compCache.get(c.id).el.parentNode === layer).map((c) => compCache.get(c.id).el);
      if (kids.length !== want.length || kids.some((k, i) => k !== want[i])) want.forEach((el) => layer.appendChild(el));
    }
    for (const [id, entry] of compCache) {
      if (!seen.has(id)) {
        entry.el.remove();
        compCache.delete(id);
      }
    }
  }
  App.invalidateComp = function (id) {
    const e = compCache.get(id);
    if (e) e.key = null;
  };

  // ------------------------------------------------------------------ wires
  function segIntersect(a, b, c, d) {
    const r1 = b[0] - a[0], r2 = b[1] - a[1], s1 = d[0] - c[0], s2 = d[1] - c[1];
    const den = r1 * s2 - r2 * s1;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((c[0] - a[0]) * s2 - (c[1] - a[1]) * s1) / den;
    const u = ((c[0] - a[0]) * r2 - (c[1] - a[1]) * r1) / den;
    if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
    return t;
  }
  const HOP = 1.5;
  /** hops[i][k] = list of distances along segment k of wire i where it jumps an earlier wire */
  function computeHops(list) {
    const hops = list.map((pts) => pts.slice(1).map(() => []));
    if (!state.prefs.hops) return hops;
    const boxes = list.map((pts) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      return [x0, y0, x1, y1];
    });
    for (let j = 1; j < list.length; j++) {
      const pj = list[j], bj = boxes[j];
      for (let i = 0; i < j; i++) {
        const bi = boxes[i];
        if (bi[0] > bj[2] || bi[2] < bj[0] || bi[1] > bj[3] || bi[3] < bj[1]) continue;
        const pi = list[i];
        for (let k = 0; k < pj.length - 1; k++) {
          const a = pj[k], b = pj[k + 1];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (L < HOP * 2.5) continue;
          for (let m = 0; m < pi.length - 1; m++) {
            const t = segIntersect(a, b, pi[m], pi[m + 1]);
            if (t == null) continue;
            const s = t * L;
            if (s < HOP * 1.2 || s > L - HOP * 1.2) continue;
            hops[j][k].push(s);
          }
        }
      }
    }
    return hops;
  }
  /** path with rounded corners and hop arcs */
  function wirePath(pts, segHops) {
    const R = state.prefs.rounded ? 3 : 0;
    const n = pts.length;
    if (n < 2) return '';
    const seg = [];
    for (let k = 0; k < n - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      seg.push({ a, b, L, ux: L ? (b[0] - a[0]) / L : 0, uy: L ? (b[1] - a[1]) / L : 0 });
    }
    const rad = new Array(n).fill(0);
    for (let k = 1; k < n - 1; k++) {
      const s0 = seg[k - 1], s1 = seg[k];
      const cross = s0.ux * s1.uy - s0.uy * s1.ux;
      if (Math.abs(cross) < 0.05) continue;
      rad[k] = Math.min(R, s0.L / 2, s1.L / 2);
    }
    const f = (v) => Math.round(v * 100) / 100;
    let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
    for (let k = 0; k < n - 1; k++) {
      const s = seg[k];
      const r0 = rad[k], r1 = rad[k + 1];
      const hops = (segHops && segHops[k]) || [];
      if (hops.length) {
        const sweep = Math.abs(s.ux) >= Math.abs(s.uy) ? (s.ux > 0 ? 1 : 0) : (s.uy < 0 ? 1 : 0);
        const sorted = hops.slice().sort((p, q) => p - q);
        let last = -Infinity;
        for (const h of sorted) {
          if (h - HOP < r0 || h + HOP > s.L - r1 || h - HOP < last) continue;
          d += `L${f(s.a[0] + s.ux * (h - HOP))} ${f(s.a[1] + s.uy * (h - HOP))}`;
          d += `A${HOP} ${HOP} 0 0 ${sweep} ${f(s.a[0] + s.ux * (h + HOP))} ${f(s.a[1] + s.uy * (h + HOP))}`;
          last = h + HOP;
        }
      }
      if (k < n - 2 && r1 > 0) {
        const nx = seg[k + 1];
        d += `L${f(s.b[0] - s.ux * r1)} ${f(s.b[1] - s.uy * r1)}`;
        d += `Q${f(s.b[0])} ${f(s.b[1])} ${f(s.b[0] + nx.ux * r1)} ${f(s.b[1] + nx.uy * r1)}`;
      } else {
        d += `L${f(s.b[0])} ${f(s.b[1])}`;
      }
    }
    return d;
  }

  function labelText(w, st) {
    switch (state.prefs.labelMode) {
      case 'none': return '';
      case 'color': return st.code;
      case 'both': return w.circuit ? w.circuit + ' ' + st.code : st.code;
      default: return w.circuit || '';
    }
  }
  /** label anchors: stored positions snapped onto the wire, or one automatic label */
  function labelAnchors(w, pts) {
    if (w.labels.length) return w.labels.map((l, i) => Object.assign(App.nearestOnPolyline(pts, l[0], l[1]), { idx: i }));
    if (!state.prefs.autoLabels) return [];
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (!best || L > best.L) best = { L, i };
    }
    if (!best || best.L < 26) return [];
    const a = pts[best.i], b = pts[best.i + 1];
    return [{ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, vertical: Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]), idx: -1 }];
  }

  function renderWires() {
    const wires = state.doc.wires;
    const list = wires.map((w) => App.wirePoints(w));
    App.cache.wirePts = new Map(wires.map((w, i) => [w.id, list[i]]));
    const hops = computeHops(list);
    const hl = state.highlight;
    const dim = hl && state.prefs.dim;
    let s = '';
    let labels = '';
    wires.forEach((w, i) => {
      const st = App.wireStyle(w);
      const d = wirePath(list[i], hops[i]);
      const sel = state.sel.wires.has(w.id);
      const cls = 'wire' + (sel ? ' selected' : '') + (hl && hl.has(w.id) ? ' traced' : '') + (dim && !hl.has(w.id) ? ' dim' : '') + (w.optional ? ' optional' : '');
      s += `<g class="${cls}" data-kind="wire" data-id="${esc(w.id)}">`;
      if (sel || (hl && hl.has(w.id))) s += `<path class="glow" d="${d}"/>`;
      if (st.outline) s += `<path class="w-outline" d="${d}"/><path class="w-core thin" d="${d}" stroke="${st.hex}"/>`;
      else s += `<path class="w-core" d="${d}" stroke="${st.hex}"/>`;
      if (st.tracer && st.tracer2) {
        s += `<path class="w-tracer" d="${d}" stroke="${st.tracer}" stroke-dasharray="5 1.4 0 0 0 1.4"/>`;
        s += `<path class="w-tracer dot" d="${d}" stroke="${st.tracer2}" stroke-dasharray="0 5.7 0.6 0.7"/>`;
      } else if (st.tracer) s += `<path class="w-tracer" d="${d}" stroke="${st.tracer}" stroke-dasharray="2.4 2.4"/>`;
      s += `<path class="hit" d="${d}"/></g>`;

      const text = labelText(w, st);
      if (text) {
        for (const a of labelAnchors(w, list[i])) {
          const fs = 5.6;
          const tw = text.length * fs * 0.6 + 2.4;
          const rot = a.vertical ? ` rotate(-90)` : '';
          labels += `<g class="wlabel${a.idx < 0 ? ' auto' : ''}${dim && !hl.has(w.id) ? ' dim' : ''}" data-kind="label" data-id="${esc(w.id)}" data-i="${a.idx}" transform="translate(${App.round(a.x)},${App.round(a.y)})${rot}">` +
            `<rect x="${-tw / 2}" y="${-fs * 0.72}" width="${tw}" height="${fs * 1.44}"/><text font-size="${fs}">${esc(text)}</text></g>`;
        }
      }
    });
    els['layer-wires'].innerHTML = s;
    els['layer-labels'].innerHTML = labels;
  }

  // ------------------------------------------------------------------ overlay (handles, previews)
  function renderOverlay() {
    const k = view.k;
    const hs = 7 / k;
    let s = '';
    const ov = App.overlay || {};
    // selected components: bounds
    for (const id of state.sel.comps) {
      const c = App.comp(id);
      if (!c) continue;
      const b = App.compBounds(c);
      s += `<rect class="sel-box" x="${b.x0 - 1}" y="${b.y0 - 1}" width="${b.x1 - b.x0 + 2}" height="${b.y1 - b.y0 + 2}"/>`;
      if (App.editor && App.editor.pinEdit && state.sel.comps.size === 1) {
        for (const p of c.pins) {
          const [x, y] = App.toWorld(c, p.x, p.y);
          s += `<rect class="handle pin-handle" data-kind="pinhandle" data-c="${esc(c.id)}" data-p="${esc(p.id)}" x="${x - hs / 2}" y="${y - hs / 2}" width="${hs}" height="${hs}"><title>${esc(p.name)}</title></rect>`;
        }
      }
    }
    // selected wire handles
    if (state.sel.wires.size === 1 && state.sel.comps.size === 0) {
      const w = App.wire([...state.sel.wires][0]);
      const pts = w && App.cache.wirePts.get(w.id);
      if (pts) {
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) * k < 22) continue;
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          s += `<circle class="handle seg-handle" data-kind="seg" data-i="${i}" cx="${mx}" cy="${my}" r="${hs * 0.45}"><title>Drag to move this segment</title></circle>`;
        }
        for (let i = 1; i < pts.length - 1; i++) {
          const act = ov.activeVertex === i ? ' active' : '';
          s += `<rect class="handle vertex-handle${act}" data-kind="vertex" data-i="${i}" x="${pts[i][0] - hs / 2}" y="${pts[i][1] - hs / 2}" width="${hs}" height="${hs}"><title>Drag to move · Delete to remove</title></rect>`;
        }
        for (const [end, p] of [['from', pts[0]], ['to', pts[pts.length - 1]]]) {
          s += `<circle class="handle end-handle" data-kind="end" data-end="${end}" cx="${p[0]}" cy="${p[1]}" r="${hs * 0.6}"><title>Drag onto another pin to reconnect</title></circle>`;
        }
      }
    }
    // wire-draw preview
    if (ov.draft) {
      const pts = ov.draft;
      s += `<polyline class="draft" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
      for (const p of pts.slice(0, -1)) s += `<circle class="draft-pt" cx="${p[0]}" cy="${p[1]}" r="${3 / k}"/>`;
    }
    if (ov.hoverPin) {
      const [x, y] = ov.hoverPin;
      s += `<circle class="pin-hover" cx="${x}" cy="${y}" r="${6 / k}"/>`;
    }
    if (ov.box) {
      const b = ov.box;
      s += `<rect class="rubber" x="${Math.min(b[0], b[2])}" y="${Math.min(b[1], b[3])}" width="${Math.abs(b[2] - b[0])}" height="${Math.abs(b[3] - b[1])}"/>`;
    }
    if (ov.ghost) {
      const g = ov.ghost;
      s += `<rect class="ghost" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}"/>`;
    }
    for (const p of ov.peers || []) {
      s += `<g class="peer-cursor" transform="translate(${p.x},${p.y}) scale(${1 / k})"><path d="M0 0V15L4.2 11.3L7.2 18L9.8 16.9L6.9 10.4H12Z" fill="${esc(p.colour)}"/>` +
        `<text x="13" y="24" fill="${esc(p.colour)}">${esc(p.name)}</text></g>`;
    }
    if (ov.splicePoint) {
      const [x, y] = ov.splicePoint;
      s += `<circle class="splice-preview" cx="${x}" cy="${y}" r="${4 / k}"/>`;
    }
    els['layer-overlay'].innerHTML = s;
  }

  function renderStatic() {
    const doc = state.doc;
    for (const id of ['paper', 'grid']) {
      els[id].setAttribute('width', doc.page.w);
      els[id].setAttribute('height', doc.page.h);
    }
    els.grid.style.display = state.prefs.showGrid ? '' : 'none';
    const ref = doc.reference;
    const href = state.refData || (ref && ref.href);
    if (state.prefs.showRef && href) {
      const r = ref || { x: 0, y: 0, w: doc.page.w, h: doc.page.h };
      els['ref-img'].setAttribute('href', href);
      for (const a of ['x', 'y']) els['ref-img'].setAttribute(a, r[a] || 0);
      els['ref-img'].setAttribute('width', r.w || doc.page.w);
      els['ref-img'].setAttribute('height', r.h || doc.page.h);
      els['ref-img'].setAttribute('opacity', state.prefs.refOpacity);
      els['ref-img'].style.display = '';
    } else {
      els['ref-img'].style.display = 'none';
    }
  }

  let frame = 0;
  App.render = function () {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      App.renderNow();
    });
  };
  App.renderNow = function () {
    if (!state.doc) return;
    renderStatic();
    renderComponents();
    renderWires();
    renderOverlay();
  };
  App.renderOverlay = renderOverlay;
  App.resetRenderCache = function () {
    for (const e of compCache.values()) e.el.remove();
    compCache.clear();
  };

  // ------------------------------------------------------------------ standalone SVG export
  App.exportSVG = function () {
    const doc = state.doc;
    const clone = els.viewport.cloneNode(true);
    clone.removeAttribute('transform');
    clone.querySelector('#layer-overlay').remove();
    clone.querySelector('#grid').remove();
    clone.querySelectorAll('.hit, .pins, .pin, .glow').forEach((n) => n.remove());
    clone.querySelectorAll('.hidden').forEach((n) => n.remove());
    const ref = clone.querySelector('#ref-img');
    if (ref && ref.style.display === 'none') ref.remove();
    const css = `.w-core{fill:none;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}.w-core.thin{stroke-width:1}
      .w-outline{fill:none;stroke:#545454;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
      .w-tracer{fill:none;stroke-width:0.55}.w-tracer.dot{stroke-width:0.9}
      .wlabel rect{fill:#fff}.wlabel text{font-family:'DejaVu Sans Mono',Consolas,monospace;text-anchor:middle;dominant-baseline:central}
      .comp-name,.sym-text{font-family:Arial,sans-serif;text-anchor:middle;dominant-baseline:central}
      .note-text{font-family:Arial,sans-serif}.dim{opacity:.15}`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${doc.page.w} ${doc.page.h}" width="${doc.page.w}pt" height="${doc.page.h}pt">` +
      `<title>${esc(doc.meta.title)}</title><style>${css}</style>${clone.innerHTML}</svg>`;
  };
})();
