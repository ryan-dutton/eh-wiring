/* Pointer and keyboard interaction: select/move, wire editing, wire drawing, placing components. */
(function () {
  'use strict';
  const App = window.App;
  const state = App.state;
  const view = App.view;

  const editor = (App.editor = { tool: 'select', pinEdit: false, template: null });
  const ov = (App.overlay = {});
  let svg = null;
  let drag = null;
  let spaceDown = false;
  let lastClick = { t: 0, x: 0, y: 0 };

  App.setTool = function (tool, template) {
    abortDraft();
    editor.tool = tool;
    editor.template = template || null;
    ov.ghost = null;
    svg.dataset.mode = tool;
    App.emit('tool', tool);
    App.renderOverlay();
  };

  // ------------------------------------------------------------------ helpers
  function targetInfo(ev) {
    const el = ev.target.closest && ev.target.closest('[data-kind]');
    if (!el) return { kind: null };
    const d = el.dataset;
    return { kind: d.kind, id: d.id, c: d.c, p: d.p, i: d.i != null ? +d.i : null, end: d.end, el };
  }
  function pinNear(x, y, exclude) {
    const tol = 9 / view.k;
    let best = null;
    for (const c of state.doc.components) {
      if (c.type === 'panel') continue;
      for (const p of c.pins) {
        if (exclude && exclude.c === c.id && exclude.p === p.id) continue;
        const [px, py] = App.toWorld(c, p.x, p.y);
        const d = Math.hypot(px - x, py - y);
        if (d < tol && (!best || d < best.d)) best = { d, c: c.id, p: p.id, x: px, y: py };
      }
    }
    return best;
  }
  function wireNear(x, y, excludeComp) {
    const tol = 6 / view.k;
    let best = null;
    for (const [id, pts] of App.cache.wirePts) {
      if (excludeComp) {
        const w = App.wire(id);
        if (w && (w.from.c === excludeComp || w.to.c === excludeComp)) continue;
      }
      const n = App.nearestOnPolyline(pts, x, y);
      if (n.d < tol && (!best || n.d < best.n.d)) best = { id, n };
    }
    return best;
  }
  const snap = (v) => App.snap(v);

  /** move one end of an (original) polyline, keeping the adjoining segment orthogonal */
  function moveEnd(pts, endIdx, nx, ny) {
    const n = pts.length;
    const [ox, oy] = pts[endIdx];
    if (n === 2) {
      const [fx, fy] = pts[endIdx === 0 ? 1 : 0];
      const horiz = Math.abs(fy - oy) < 0.05, vert = Math.abs(fx - ox) < 0.05;
      pts[endIdx] = [nx, ny];
      if (horiz && Math.abs(ny - fy) > 0.05) {
        const m = App.round((nx + fx) / 2);
        const mid = endIdx === 0 ? [[m, ny], [m, fy]] : [[m, fy], [m, ny]];
        pts.splice(1, 0, ...mid);
      } else if (vert && Math.abs(nx - fx) > 0.05) {
        const m = App.round((ny + fy) / 2);
        const mid = endIdx === 0 ? [[nx, m], [fx, m]] : [[fx, m], [nx, m]];
        pts.splice(1, 0, ...mid);
      }
      return pts;
    }
    const ni = endIdx === 0 ? 1 : n - 2;
    const nb = pts[ni];
    if (Math.abs(nb[1] - oy) < 0.05) nb[1] = ny;
    else if (Math.abs(nb[0] - ox) < 0.05) nb[0] = nx;
    pts[endIdx] = [nx, ny];
    return pts;
  }

  // ------------------------------------------------------------------ touch pinch-zoom
  const touches = new Map();
  let pinch = null;
  function pinchState() {
    const [a, b] = [...touches.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  function trackTouch(ev) {
    if (ev.pointerType !== 'touch') return false;
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (touches.size === 2) {
      if (drag && drag.type !== 'pan') {
        App.discardCheckpointIfUnchanged();
      }
      drag = null;
      pinch = pinchState();
      return true;
    }
    return touches.size > 2;
  }

  // ------------------------------------------------------------------ pointer events
  function onDown(ev) {
    if (trackTouch(ev)) return;
    if (ev.button === 1 || (ev.button === 0 && spaceDown) || ev.button === 2) {
      if (ev.button === 2 && editor.tool === 'wire' && ov.draft) return;
      startPan(ev);
      return;
    }
    if (ev.button !== 0) return;
    const [x, y] = App.screenToWorld(ev.clientX, ev.clientY);
    const t = targetInfo(ev);
    const now = Date.now();
    const dbl = now - lastClick.t < 350 && Math.hypot(ev.clientX - lastClick.x, ev.clientY - lastClick.y) < 5;
    lastClick = { t: now, x: ev.clientX, y: ev.clientY };

    if (editor.tool === 'wire') return wireToolDown(ev, x, y, t, dbl);
    if (editor.tool === 'place') return placeDown(x, y);
    if (editor.tool === 'addpin') return addPinDown(x, y);

    // select tool
    if (t.kind === 'vertex') return startVertexDrag(ev, t.i, x, y);
    if (t.kind === 'seg') return startSegDrag(ev, t.i, x, y);
    if (t.kind === 'end') return startEndDrag(ev, t.end);
    if (t.kind === 'pinhandle') return startPinDrag(ev, t.c, t.p, x, y);
    if (t.kind === 'label') {
      if (!state.sel.wires.has(t.id) || ev.shiftKey) App.select('wire', t.id, ev.shiftKey);
      return startLabelDrag(ev, t.id, t.i, x, y);
    }
    if (t.kind === 'wire') {
      if (dbl && state.sel.wires.has(t.id)) return insertVertex(t.id, x, y);
      App.select('wire', t.id, ev.shiftKey);
      ov.activeVertex = null;
      return;
    }
    if (t.kind === 'comp' || t.kind === 'pin') {
      const id = t.kind === 'pin' ? t.c : t.id;
      const c = App.comp(id);
      if (c && c.locked) return startPanOrBox(ev, x, y);
      if (!state.sel.comps.has(id) || ev.shiftKey) App.select('comp', id, ev.shiftKey);
      if (state.sel.comps.has(id)) startMove(ev, x, y);
      return;
    }
    startPanOrBox(ev, x, y);
  }

  function startPanOrBox(ev, x, y) {
    if (ev.shiftKey) {
      drag = { type: 'box', x0: x, y0: y };
      ov.box = [x, y, x, y];
      capture(ev);
      return;
    }
    if (state.sel.comps.size || state.sel.wires.size || state.highlight) App.clearSelection();
    startPan(ev);
  }
  function startPan(ev) {
    drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, tx: view.tx, ty: view.ty, moved: false };
    svg.classList.add('panning');
    capture(ev);
  }
  function capture(ev) {
    try {
      svg.setPointerCapture(ev.pointerId);
    } catch (e) { /* ignore */ }
  }

  function startMove(ev, x, y) {
    const ids = new Set([...state.sel.comps].filter((id) => !App.comp(id).locked));
    const comps = [...ids].map((id) => App.comp(id));
    const orig = new Map(comps.map((c) => [c.id, [c.x, c.y]]));
    const wires = state.doc.wires.filter((w) => ids.has(w.from.c) || ids.has(w.to.c)).map((w) => ({ w, pts: App.wirePoints(w), labels: App.clone(w.labels), both: ids.has(w.from.c) && ids.has(w.to.c) }));
    App.checkpoint();
    drag = { type: 'move', x0: x, y0: y, ids, comps, orig, wires };
    capture(ev);
  }
  function doMove(x, y) {
    let dx = x - drag.x0, dy = y - drag.y0;
    const first = drag.comps[0];
    if (first) {
      const [ox, oy] = drag.orig.get(first.id);
      dx = snap(ox + dx) - ox;
      dy = snap(oy + dy) - oy;
    }
    for (const c of drag.comps) {
      const [ox, oy] = drag.orig.get(c.id);
      c.x = App.round(ox + dx);
      c.y = App.round(oy + dy);
    }
    for (const { w, pts, labels, both } of drag.wires) {
      if (both) {
        w.points = pts.map(([px, py]) => [App.round(px + dx), App.round(py + dy)]);
        w.labels = labels.map(([lx, ly]) => [App.round(lx + dx), App.round(ly + dy)]);
        continue;
      }
      let np = pts.map((p) => p.slice());
      if (drag.ids.has(w.from.c)) np = moveEnd(np, 0, App.round(pts[0][0] + dx), App.round(pts[0][1] + dy));
      if (drag.ids.has(w.to.c)) {
        const last = pts[pts.length - 1];
        np = moveEnd(np, np.length - 1, App.round(last[0] + dx), App.round(last[1] + dy));
      }
      w.points = np;
    }
    App.render();
  }

  function startVertexDrag(ev, i, x, y) {
    const w = App.wire([...state.sel.wires][0]);
    App.checkpoint();
    ov.activeVertex = i;
    drag = { type: 'vertex', w, i, pts: App.wirePoints(w), x0: x, y0: y };
    capture(ev);
  }
  function doVertex(x, y) {
    const { w, i, pts } = drag;
    let nx = snap(pts[i][0] + x - drag.x0), ny = snap(pts[i][1] + y - drag.y0);
    // align with neighbours to keep runs straight
    const tol = 4 / view.k;
    for (const j of [i - 1, i + 1]) {
      if (Math.abs(nx - pts[j][0]) < tol) nx = pts[j][0];
      if (Math.abs(ny - pts[j][1]) < tol) ny = pts[j][1];
    }
    const np = pts.map((p) => p.slice());
    np[i] = [nx, ny];
    w.points = np;
    App.render();
  }

  function startSegDrag(ev, i, x, y) {
    const w = App.wire([...state.sel.wires][0]);
    const pts = App.wirePoints(w);
    App.checkpoint();
    const a = pts[i], b = pts[i + 1];
    const horiz = Math.abs(b[1] - a[1]) <= Math.abs(b[0] - a[0]);
    if (i === 0) {
      pts.splice(0, 0, pts[0].slice());
      i = 1;
    }
    if (i + 1 === pts.length - 1) pts.push(pts[pts.length - 1].slice());
    drag = { type: 'seg', w, i, pts, horiz, x0: x, y0: y };
    capture(ev);
  }
  function doSeg(x, y) {
    const { w, i, pts, horiz } = drag;
    const np = pts.map((p) => p.slice());
    if (horiz) {
      const ny = snap(pts[i][1] + y - drag.y0);
      np[i][1] = ny;
      np[i + 1][1] = ny;
    } else {
      const nx = snap(pts[i][0] + x - drag.x0);
      np[i][0] = nx;
      np[i + 1][0] = nx;
    }
    w.points = np;
    App.render();
  }

  function startEndDrag(ev, end) {
    const w = App.wire([...state.sel.wires][0]);
    App.checkpoint();
    drag = { type: 'end', w, end, pts: App.wirePoints(w), orig: App.clone(w[end]) };
    capture(ev);
  }
  function doEnd(x, y) {
    const { w, end, pts } = drag;
    const hit = pinNear(x, y);
    ov.hoverPin = hit ? [hit.x, hit.y] : null;
    const tx = hit ? hit.x : x, ty = hit ? hit.y : y;
    const np = pts.map((p) => p.slice());
    np[end === 'from' ? 0 : np.length - 1] = [tx, ty];
    // temporarily detach so the preview follows the pointer
    w[end] = hit ? { c: hit.c, p: hit.p } : { c: '__drag__', p: '' };
    w.points = np;
    App.render();
  }
  function endEnd(x, y) {
    const { w, end, pts } = drag;
    const hit = pinNear(x, y);
    ov.hoverPin = null;
    if (hit) {
      w[end] = { c: hit.c, p: hit.p };
      const np = pts.map((p) => p.slice());
      const idx = end === 'from' ? 0 : np.length - 1;
      w.points = moveEnd(np, idx, hit.x, hit.y);
      App.pruneSplices();
      App.changed();
    } else {
      w[end] = drag.orig;
      w.points = pts;
      App.discardCheckpointIfUnchanged();
      App.render();
    }
  }

  function startLabelDrag(ev, wid, i, x, y) {
    const w = App.wire(wid);
    App.checkpoint();
    if (i < 0) {
      w.labels.push([App.round(x), App.round(y)]);
      i = w.labels.length - 1;
    }
    drag = { type: 'label', w, i, x0: x, y0: y, orig: w.labels[i].slice() };
    capture(ev);
  }
  function doLabel(x, y) {
    const { w, i, orig } = drag;
    const pts = App.cache.wirePts.get(w.id);
    const n = App.nearestOnPolyline(pts, orig[0] + x - drag.x0, orig[1] + y - drag.y0);
    w.labels[i] = [App.round(n.x), App.round(n.y)];
    App.render();
  }

  function startPinDrag(ev, cid, pid, x, y) {
    const c = App.comp(cid);
    const p = App.pin(c, pid);
    App.checkpoint();
    const wires = App.wiresAt(cid, pid).map((w) => ({ w, pts: App.wirePoints(w) }));
    drag = { type: 'pin', c, p, orig: [p.x, p.y], wires, x0: x, y0: y };
    capture(ev);
  }
  function doPin(x, y) {
    const { c, p, orig, wires } = drag;
    const [wx, wy] = App.toWorld(c, orig[0], orig[1]);
    const nx = snap(wx + x - drag.x0), ny = snap(wy + y - drag.y0);
    const [lx, ly] = App.toLocal(c, nx, ny);
    p.x = App.round(lx);
    p.y = App.round(ly);
    for (const { w, pts } of wires) {
      let np = pts.map((q) => q.slice());
      if (w.from.c === c.id && w.from.p === p.id) np = moveEnd(np, 0, nx, ny);
      if (w.to.c === c.id && w.to.p === p.id) np = moveEnd(np, np.length - 1, nx, ny);
      w.points = np;
    }
    App.invalidateComp(c.id);
    App.render();
  }

  function insertVertex(wid, x, y) {
    const w = App.wire(wid);
    const pts = App.wirePoints(w);
    const n = App.nearestOnPolyline(pts, x, y);
    App.mutate(() => {
      pts.splice(n.i + 1, 0, [App.round(n.x), App.round(n.y)]);
      w.points = pts;
      ov.activeVertex = n.i + 1;
    });
  }

  function onMove(ev) {
    if (touches.has(ev.pointerId)) {
      touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinch && touches.size === 2) {
        const now = pinchState();
        App.zoomAt(now.d / pinch.d, now.x, now.y);
        App.view.tx += now.x - pinch.x;
        App.view.ty += now.y - pinch.y;
        App.applyView();
        pinch = now;
        App.renderOverlay();
        return;
      }
    }
    const [x, y] = App.screenToWorld(ev.clientX, ev.clientY);
    App.emit('cursor', [x, y]);
    if (!drag) {
      hover(ev, x, y);
      return;
    }
    drag.moved = true;
    switch (drag.type) {
      case 'pan':
        view.tx = drag.tx + ev.clientX - drag.sx;
        view.ty = drag.ty + ev.clientY - drag.sy;
        App.applyView();
        break;
      case 'move': doMove(x, y); break;
      case 'vertex': doVertex(x, y); break;
      case 'seg': doSeg(x, y); break;
      case 'end': doEnd(x, y); break;
      case 'label': doLabel(x, y); break;
      case 'pin': doPin(x, y); break;
      case 'box':
        ov.box = [drag.x0, drag.y0, x, y];
        App.renderOverlay();
        break;
    }
  }

  function onUp(ev) {
    touches.delete(ev.pointerId);
    if (pinch) {
      if (touches.size < 2) pinch = null;
      return;
    }
    if (!drag) return;
    const d = drag;
    drag = null;
    svg.classList.remove('panning');
    const [x, y] = App.screenToWorld(ev.clientX, ev.clientY);
    switch (d.type) {
      case 'pan':
        if (!d.moved && editor.tool === 'select') App.emit('selection');
        return;
      case 'end':
        drag = d;
        endEnd(x, y);
        drag = null;
        return;
      case 'box': {
        const [x0, y0, x1, y1] = ov.box;
        ov.box = null;
        const bx0 = Math.min(x0, x1), bx1 = Math.max(x0, x1), by0 = Math.min(y0, y1), by1 = Math.max(y0, y1);
        for (const c of state.doc.components) {
          if (c.locked || (c.type === 'panel' && !state.prefs.showPanels)) continue;
          const b = App.compBounds(c);
          if (b.x0 >= bx0 && b.x1 <= bx1 && b.y0 >= by0 && b.y1 <= by1) state.sel.comps.add(c.id);
        }
        App.emit('selection');
        return;
      }
      case 'vertex':
      case 'seg':
        if (d.moved) d.w.points = App.simplifyPoints(d.w.points);
        if (d.type === 'seg') ov.activeVertex = null;
        break;
    }
    if (App.discardCheckpointIfUnchanged()) App.render();
    else App.changed();
  }

  function hover(ev, x, y) {
    const t = targetInfo(ev);
    if (editor.tool === 'wire') {
      const hit = pinNear(x, y);
      ov.hoverPin = hit ? [hit.x, hit.y] : null;
      ov.splicePoint = null;
      if (!hit) {
        const wn = wireNear(x, y, ov.draftFrom && ov.draftFrom.c);
        if (wn) ov.splicePoint = [wn.n.x, wn.n.y];
      }
      if (ov.draftBase) ov.draft = draftPreview(x, y, ev.altKey);
      App.renderOverlay();
    } else if (editor.tool === 'place' && editor.template) {
      const tp = editor.template;
      ov.ghost = { x: snap(x - tp.w / 2), y: snap(y - tp.h / 2), w: tp.w, h: tp.h };
      App.renderOverlay();
    } else if (editor.tool === 'addpin') {
      ov.hoverPin = [snap(x), snap(y)];
      App.renderOverlay();
    }
    App.emit('hover', { kind: t.kind, id: t.id || t.c, pin: t.p, clientX: ev.clientX, clientY: ev.clientY });
  }

  function onWheel(ev) {
    ev.preventDefault();
    if (ev.shiftKey && !ev.ctrlKey) {
      view.tx -= ev.deltaY;
      App.applyView();
      return;
    }
    const factor = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0018));
    App.zoomAt(factor, ev.clientX, ev.clientY);
    App.renderOverlay();
  }

  // ------------------------------------------------------------------ wire tool
  function draftPreview(x, y, free) {
    const base = ov.draftBase;
    const last = base[base.length - 1];
    let tx = snap(x), ty = snap(y);
    const hit = pinNear(x, y);
    if (hit) {
      tx = hit.x;
      ty = hit.y;
      if (!free && Math.abs(tx - last[0]) > 0.05 && Math.abs(ty - last[1]) > 0.05) {
        const prev = base.length > 1 ? base[base.length - 2] : null;
        const lastHoriz = prev && Math.abs(prev[1] - last[1]) < 0.05;
        const elbow = lastHoriz ? [last[0], ty] : [tx, last[1]];
        return base.concat([elbow, [tx, ty]]);
      }
      return base.concat([[tx, ty]]);
    }
    if (!free) {
      if (Math.abs(tx - last[0]) > Math.abs(ty - last[1])) ty = last[1];
      else tx = last[0];
    }
    return base.concat([[tx, ty]]);
  }
  /** cancel drawing; if we already split a wire to start it, put that wire back */
  function abortDraft() {
    const undoSplice = ov.startedSplice;
    cancelDraft();
    ov.startedSplice = false;
    if (undoSplice) App.undo();
  }
  function cancelDraft() {
    ov.draft = null;
    ov.draftBase = null;
    ov.draftFrom = null;
    ov.hoverPin = null;
    ov.splicePoint = null;
  }
  function wireToolDown(ev, x, y, t, dbl) {
    const pin = pinNear(x, y);
    // never splice back into the wires at the start of this draft
    const wn = !pin ? wireNear(x, y, ov.draftFrom && ov.draftFrom.c) : null;
    if (!ov.draftBase) {
      if (pin) {
        ov.draftFrom = { c: pin.c, p: pin.p };
        ov.draftBase = [[pin.x, pin.y]];
      } else if (wn) {
        App.checkpoint();
        const sp = App.spliceWire(App.wire(wn.id), x, y);
        ov.startedSplice = true;
        ov.draftFrom = { c: sp.id, p: 'p1' };
        ov.draftBase = [App.toWorld(sp, 1.5, 1.5)];
        App.render();
      } else {
        App.toast('Start a wire on a pin (or on an existing wire to splice into it).', 'info');
        return;
      }
      ov.draft = ov.draftBase.slice();
      App.renderOverlay();
      return;
    }
    // continuing
    const pts = draftPreview(x, y, ev.altKey);
    if (pin && !(pin.c === ov.draftFrom.c && pin.p === ov.draftFrom.p)) return finishWire(pts, { c: pin.c, p: pin.p });
    if (wn && !pin) {
      if (!ov.startedSplice) App.checkpoint();
      ov.startedSplice = true;
      const sp = App.spliceWire(App.wire(wn.id), x, y);
      const end = App.toWorld(sp, 1.5, 1.5);
      const base = ov.draftBase;
      const last = base[base.length - 1];
      const route = Math.abs(end[0] - last[0]) > 0.05 && Math.abs(end[1] - last[1]) > 0.05 && !ev.altKey ? base.concat([[end[0], last[1]], end]) : base.concat([end]);
      return finishWire(route, { c: sp.id, p: 'p1' });
    }
    if (dbl) {
      // finish on a free-standing terminal
      const last = pts[pts.length - 1];
      if (!ov.startedSplice) App.checkpoint();
      ov.startedSplice = true;
      const tid = App.uid('T');
      state.doc.components.push({ id: tid, name: 'Terminal ' + tid.slice(1), type: 'terminal', style: 'terminal', x: last[0] - 3, y: last[1] - 3, w: 6, h: 6, rot: 0, pins: [{ id: 'p1', name: '1', x: 3, y: 3 }] });
      const trimmed = App.simplifyPoints(pts);
      return finishWire(trimmed, { c: tid, p: 'p1' });
    }
    ov.draftBase = pts;
    ov.draft = pts.slice();
    App.renderOverlay();
  }
  function finishWire(pts, to) {
    if (!ov.startedSplice) App.checkpoint();
    const w = {
      id: App.uid('W'), circuit: '', color: state.prefs.lastColor || 'R', gauge: '', length: '', notes: '',
      from: ov.draftFrom, to, points: App.simplifyPoints(pts).map((p) => [App.round(p[0]), App.round(p[1])]), labels: [],
    };
    state.doc.wires.push(w);
    cancelDraft();
    ov.startedSplice = false;
    state.sel.comps.clear();
    state.sel.wires = new Set([w.id]);
    App.changed();
    App.emit('selection');
    App.emit('wireCreated', w);
  }

  // ------------------------------------------------------------------ placing
  function placeDown(x, y) {
    const tp = editor.template;
    if (!tp) return;
    const c = App.makeComponent(tp, snap(x - tp.w / 2), snap(y - tp.h / 2));
    App.mutate(() => state.doc.components.push(c));
    App.setTool('select');
    App.select('comp', c.id);
  }
  function addPinDown(x, y) {
    const c = App.comp([...state.sel.comps][0]);
    if (!c) return App.setTool('select');
    const [lx, ly] = App.toLocal(c, snap(x), snap(y));
    App.mutate(() => {
      let n = c.pins.length + 1;
      while (c.pins.some((p) => p.id === 'p' + n)) n++;
      c.pins.push({ id: 'p' + n, name: String(c.pins.length + 1), x: App.round(lx), y: App.round(ly) });
    });
    App.setTool('select');
  }
  App.makeComponent = function (tp, x, y) {
    const id = App.uid(tp.prefix || 'C');
    return {
      id, name: tp.name, type: tp.type, style: tp.style, x, y, w: tp.w, h: tp.h, rot: 0,
      pins: tp.pins.map((p, i) => ({ id: 'p' + (i + 1), name: p.name, x: p.x, y: p.y })),
      bridges: tp.bridges ? App.clone(tp.bridges) : undefined,
      text: tp.text, fontSize: tp.fontSize, showLabel: tp.showLabel !== false,
    };
  };

  // ------------------------------------------------------------------ keyboard
  function onKey(ev) {
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || ev.target.isContentEditable) return;
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.code === 'Space') {
      spaceDown = true;
      svg.classList.add('pan-ready');
      ev.preventDefault();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      ev.shiftKey ? App.redo() : App.undo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      App.redo();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'd') {
      ev.preventDefault();
      App.duplicateSelection();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'a') {
      ev.preventDefault();
      for (const c of state.doc.components) if (!c.locked && c.type !== 'panel') state.sel.comps.add(c.id);
      App.emit('selection');
      return;
    }
    if (mod) return;
    switch (ev.key) {
      case 'Escape':
        if (ov.draftBase) {
          abortDraft();
          App.renderOverlay();
        } else if (editor.tool !== 'select') App.setTool('select');
        else App.clearSelection();
        break;
      case 'Backspace':
        if (ov.draftBase && ov.draftBase.length > 1) {
          ov.draftBase.pop();
          ov.draft = ov.draftBase.slice();
          App.renderOverlay();
          break;
        }
      // fall through
      case 'Delete':
        ev.preventDefault();
        App.deleteSelection();
        break;
      case 'v': case 'V': App.setTool('select'); break;
      case 'w': case 'W': App.setTool('wire'); break;
      case 'f': case 'F': App.fitView(); App.renderOverlay(); break;
      case 'r': case 'R': App.rotateSelection(ev.shiftKey ? -90 : 90); break;
      case 't': case 'T': App.traceSelection(); break;
      case '+': case '=': App.zoomAt(1.25); App.renderOverlay(); break;
      case '-': App.zoomAt(0.8); App.renderOverlay(); break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!state.sel.comps.size) return;
        ev.preventDefault();
        const step = ev.shiftKey ? 10 : state.prefs.grid || 1;
        const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
        const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
        App.nudgeSelection(dx, dy);
        break;
      }
    }
  }
  function onKeyUp(ev) {
    if (ev.code === 'Space') {
      spaceDown = false;
      svg.classList.remove('pan-ready');
    }
  }

  // ------------------------------------------------------------------ selection-level commands
  App.deleteSelection = function () {
    if (ov.activeVertex != null && state.sel.wires.size === 1 && !state.sel.comps.size) {
      const w = App.wire([...state.sel.wires][0]);
      const i = ov.activeVertex;
      ov.activeVertex = null;
      if (w && i > 0 && i < w.points.length - 1) {
        App.mutate(() => {
          const pts = App.wirePoints(w);
          pts.splice(i, 1);
          w.points = pts;
        });
        return;
      }
    }
    const comps = [...state.sel.comps].filter((id) => !App.comp(id).locked);
    const wires = [...state.sel.wires];
    if (!comps.length && !wires.length) return;
    const attached = state.doc.wires.filter((w) => comps.includes(w.from.c) || comps.includes(w.to.c)).length;
    if (comps.length && attached && !confirm(`Delete ${comps.length} component(s) and ${attached} attached wire(s)?`)) return;
    App.mutate(() => {
      App.deleteWires(wires);
      App.deleteComponents(comps);
    });
    App.emit('selection');
  };
  App.nudgeSelection = function (dx, dy) {
    const ids = new Set([...state.sel.comps].filter((id) => !App.comp(id).locked));
    App.checkpoint();
    const wires = state.doc.wires.filter((w) => ids.has(w.from.c) || ids.has(w.to.c));
    for (const w of wires) {
      const pts = App.wirePoints(w);
      if (ids.has(w.from.c) && ids.has(w.to.c)) {
        w.points = pts.map(([x, y]) => [App.round(x + dx), App.round(y + dy)]);
        w.labels = w.labels.map(([x, y]) => [App.round(x + dx), App.round(y + dy)]);
        continue;
      }
      let np = pts;
      if (ids.has(w.from.c)) np = moveEnd(np, 0, pts[0][0] + dx, pts[0][1] + dy);
      if (ids.has(w.to.c)) {
        const l = pts[pts.length - 1];
        np = moveEnd(np, np.length - 1, l[0] + dx, l[1] + dy);
      }
      w.points = np;
    }
    for (const id of ids) {
      const c = App.comp(id);
      c.x = App.round(c.x + dx);
      c.y = App.round(c.y + dy);
    }
    App.changed();
  };
  App.rotateSelection = function (deg) {
    const ids = [...state.sel.comps].filter((id) => !App.comp(id).locked && App.comp(id).style !== 'splice');
    if (!ids.length) return;
    App.mutate(() => {
      for (const id of ids) {
        const c = App.comp(id);
        const before = new Map(c.pins.map((p) => [p.id, App.toWorld(c, p.x, p.y)]));
        c.rot = (((c.rot || 0) + deg) % 360 + 360) % 360;
        for (const w of App.wiresAt(id)) {
          let pts = App.wirePoints(w);
          for (const end of ['from', 'to']) {
            if (w[end].c !== id) continue;
            const p = App.pin(c, w[end].p);
            const [nx, ny] = App.toWorld(c, p.x, p.y);
            const idx = end === 'from' ? 0 : pts.length - 1;
            pts[idx] = before.get(p.id);
            pts = moveEnd(pts, idx, App.round(nx), App.round(ny));
          }
          w.points = pts;
        }
      }
    });
  };
  App.duplicateSelection = function () {
    const ids = [...state.sel.comps].filter((id) => App.comp(id).style !== 'splice');
    if (!ids.length) return;
    App.mutate(() => {
      state.sel.comps.clear();
      for (const id of ids) {
        const src = App.comp(id);
        const c = App.clone(src);
        c.id = App.uid(id.replace(/\d+$/, '').replace(/_$/, '') + '_');
        c.name = src.name + ' (copy)';
        c.x += 10;
        c.y += 10;
        c.locked = false;
        state.doc.components.push(c);
        state.sel.comps.add(c.id);
      }
    });
    App.emit('selection');
  };
  App.traceSelection = function () {
    const ids = [...state.sel.wires];
    if (!ids.length) return;
    const all = new Set();
    for (const id of ids) for (const w of App.traceNet(id)) all.add(w);
    state.highlight = all;
    App.emit('selection');
  };

  // ------------------------------------------------------------------ init
  App.initEditor = function (el) {
    svg = el;
    svg.dataset.mode = 'select';
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (editor.tool === 'wire' && ov.draftBase) {
        abortDraft();
        App.renderOverlay();
      }
    });
    svg.addEventListener('pointerleave', () => App.emit('hover', { kind: null }));
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
  };
})();
