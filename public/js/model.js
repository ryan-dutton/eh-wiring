/* Document model, geometry, persistence (localStorage) and undo history. */
(function () {
  'use strict';
  const App = (window.App = window.App || {});

  const KEY_INDEX = 'ehw.projects';
  const KEY_PREFS = 'ehw.prefs';
  const keyDoc = (id) => 'ehw.doc.' + id;
  const keyArt = (id) => 'ehw.art.' + id;
  const keyRef = (id) => 'ehw.ref.' + id;

  const state = (App.state = {
    doc: null,
    art: {},            // artRef -> [{d, stroke, fill, sw}] (immutable, shared by duplicates)
    projectId: null,
    artDirty: false,
    sel: { comps: new Set(), wires: new Set() },
    highlight: null,    // Set of wire ids being traced, or null
    prefs: null,
  });

  const DEFAULT_PREFS = {
    scheme: 'oem',          // 'oem' | 'mf'
    labelMode: 'circuit',   // 'circuit' | 'color' | 'both' | 'none'
    autoLabels: true,
    hops: true,
    rounded: true,
    showRef: false,
    refOpacity: 0.35,
    showPanels: true,
    showGrid: true,
    snap: true,
    grid: 1,
    dim: true,
    leftTab: 'components',
    lastColor: 'R',
  };

  // ------------------------------------------------------------------ utils
  App.uid = function (prefix) {
    const doc = state.doc;
    const used = new Set([...doc.components.map((c) => c.id), ...doc.wires.map((w) => w.id)]);
    let n = 1;
    while (used.has(prefix + n)) n++;
    return prefix + n;
  };
  App.clone = (o) => JSON.parse(JSON.stringify(o));
  App.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  App.round = (v) => Math.round(v * 100) / 100;

  App.comp = (id) => state.doc.components.find((c) => c.id === id);
  App.wire = (id) => state.doc.wires.find((w) => w.id === id);
  App.pin = (c, pid) => c && c.pins.find((p) => p.id === pid);

  // ------------------------------------------------------------------ geometry
  /** local (component) coords -> world coords, honouring rotation about the box centre */
  App.toWorld = function (c, x, y) {
    const rot = ((c.rot || 0) % 360 + 360) % 360;
    if (!rot) return [c.x + x, c.y + y];
    const cx = c.w / 2, cy = c.h / 2;
    const dx = x - cx, dy = y - cy;
    const a = (rot * Math.PI) / 180;
    const cos = Math.round(Math.cos(a) * 1e6) / 1e6, sin = Math.round(Math.sin(a) * 1e6) / 1e6;
    return [c.x + cx + dx * cos - dy * sin, c.y + cy + dx * sin + dy * cos];
  };
  App.toLocal = function (c, wx, wy) {
    const rot = ((c.rot || 0) % 360 + 360) % 360;
    if (!rot) return [wx - c.x, wy - c.y];
    const cx = c.w / 2, cy = c.h / 2;
    const dx = wx - c.x - cx, dy = wy - c.y - cy;
    const a = (-rot * Math.PI) / 180;
    const cos = Math.round(Math.cos(a) * 1e6) / 1e6, sin = Math.round(Math.sin(a) * 1e6) / 1e6;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
  App.pinWorld = function (ref) {
    const c = App.comp(ref.c);
    const p = App.pin(c, ref.p);
    if (!c || !p) return null;
    return App.toWorld(c, p.x, p.y);
  };
  App.compBounds = function (c) {
    const pts = [App.toWorld(c, 0, 0), App.toWorld(c, c.w, 0), App.toWorld(c, 0, c.h), App.toWorld(c, c.w, c.h)];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  /** wire polyline with ends pinned to their terminals */
  App.wirePoints = function (w) {
    const pts = w.points.map((p) => [p[0], p[1]]);
    const a = App.pinWorld(w.from), b = App.pinWorld(w.to);
    if (a) pts[0] = a;
    if (b) pts[pts.length - 1] = b;
    return pts;
  };
  App.nearestOnPolyline = function (pts, x, y) {
    let best = { d: Infinity };
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      let t = L2 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (d < best.d) best = { d, i, t, x: px, y: py, vertical: Math.abs(dy) > Math.abs(dx) };
    }
    return best;
  };
  App.snap = function (v) {
    const g = state.prefs.snap ? state.prefs.grid : 0;
    return g ? Math.round(v / g) * g : App.round(v);
  };

  // ------------------------------------------------------------------ colours
  App.colorDef = function (code) {
    return state.doc.colors.find((c) => c.code === code);
  };
  /** resolved drawing style for a wire in the active colour scheme */
  App.wireStyle = function (w) {
    const doc = state.doc;
    let def = App.colorDef(w.color) || { code: w.color || '?', name: w.color || 'Unknown', hex: '#888888' };
    if (state.prefs.scheme === 'mf') {
      const code = w.mfColor || def.mf;
      const mf = doc.mfColors.find((c) => c.code === code);
      if (mf) def = mf;
    }
    return {
      code: def.code, name: def.name, hex: def.hex, outline: !!def.outline,
      tracer: w.tracer || def.tracer || null, tracer2: def.tracer2 || null,
    };
  };

  // ------------------------------------------------------------------ nets
  /** wires electrically joined to `wireId` via shared pins, splices and component bridges */
  App.traceNet = function (wireId) {
    const doc = state.doc;
    const key = (r) => r.c + '\u0000' + r.p;
    const adj = new Map();
    const link = (a, b, w) => {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push([b, w]);
      adj.get(b).push([a, w]);
    };
    for (const w of doc.wires) link(key(w.from), key(w.to), w.id);
    for (const c of doc.components) {
      for (const [a, b] of c.bridges || []) link(key({ c: c.id, p: a }), key({ c: c.id, p: b }), null);
      if (c.style === 'splice' && c.pins.length > 1) {
        for (let i = 1; i < c.pins.length; i++) link(key({ c: c.id, p: c.pins[0].id }), key({ c: c.id, p: c.pins[i].id }), null);
      }
    }
    const start = App.wire(wireId);
    if (!start) return new Set();
    const wires = new Set([wireId]);
    const seen = new Set();
    const queue = [key(start.from), key(start.to)];
    while (queue.length) {
      const k = queue.pop();
      if (seen.has(k)) continue;
      seen.add(k);
      for (const [n, w] of adj.get(k) || []) {
        if (w) wires.add(w);
        if (!seen.has(n)) queue.push(n);
      }
    }
    return wires;
  };
  App.wiresAt = function (cid, pid) {
    return state.doc.wires.filter((w) => (w.from.c === cid && (!pid || w.from.p === pid)) || (w.to.c === cid && (!pid || w.to.p === pid)));
  };
  App.endLabel = function (ref) {
    const c = App.comp(ref.c);
    if (!c) return '?';
    const p = App.pin(c, ref.p);
    if (c.style === 'splice') return c.name;
    return c.name + (p ? ' [' + p.name + ']' : '');
  };

  // ------------------------------------------------------------------ doc load / normalise
  /** split art out of the document so undo snapshots stay small */
  function absorb(raw) {
    const doc = App.clone(raw);
    const art = {};
    // share the original (immutable) art arrays so seed artwork can be saved by reference
    raw.components.forEach((rc, i) => {
      if (Array.isArray(rc.art)) doc.components[i].art = seedArtFor(rc) || rc.art;
    });
    doc.version = doc.version || 1;
    doc.meta = doc.meta || { title: 'Untitled harness' };
    doc.page = doc.page || { w: 1190.55, h: 841.89 };
    doc.colors = doc.colors || App.defaultColors();
    doc.mfColors = doc.mfColors || [];
    doc.components = doc.components || [];
    doc.wires = doc.wires || [];
    for (const c of doc.components) {
      if (Array.isArray(c.art)) {
        const ref = c.artRef || c.id;
        art[ref] = c.art;
        c.artRef = ref;
        delete c.art;
      }
      if (raw.art && c.artRef && raw.art[c.artRef]) art[c.artRef] = raw.art[c.artRef];
      c.pins = c.pins || [];
      c.rot = c.rot || 0;
      c.style = c.style || (c.artRef ? 'art' : 'box');
    }
    for (const w of doc.wires) {
      w.labels = w.labels || [];
      w.points = w.points && w.points.length >= 2 ? w.points : [[0, 0], [0, 0]];
    }
    return { doc, art };
  }
  App.defaultColors = function () {
    return App.clone(window.HARNESS_SEEDS['eh-holden'].colors);
  };
  App.blankDoc = function () {
    const seed = window.HARNESS_SEEDS['eh-holden'];
    return {
      version: 1,
      meta: { title: 'New harness', description: '' },
      page: { w: 1190.55, h: 841.89 },
      colors: App.clone(seed.colors),
      mfColors: App.clone(seed.mfColors),
      components: [],
      wires: [],
    };
  };
  App._absorb = absorb;
  App.exportDoc = function () {
    const doc = App.clone(state.doc);
    for (const c of doc.components) {
      if (c.artRef && state.art[c.artRef]) c.art = state.art[c.artRef];
    }
    return doc;
  };

  // ------------------------------------------------------------------ persistence
  /** art arrays that come straight from a bundled seed are stored as {seedRef} */
  let seedIndex = null;
  function seedArtIndex() {
    if (seedIndex) return seedIndex;
    seedIndex = new Map();
    for (const [key, seed] of Object.entries(window.HARNESS_SEEDS || {})) {
      for (const c of seed.components) if (Array.isArray(c.art)) seedIndex.set(c.art, key + ':' + c.id);
    }
    return seedIndex;
  }
  /** an imported component whose artwork matches a bundled seed reuses the seed's array */
  let seedJson = null;
  function seedArtFor(rc) {
    if (seedArtIndex().has(rc.art)) return rc.art;
    if (!seedJson) {
      seedJson = new Map();
      for (const seed of Object.values(window.HARNESS_SEEDS || {})) {
        for (const c of seed.components) if (Array.isArray(c.art)) seedJson.set(c.id + '\u0000' + JSON.stringify(c.art), c.art);
      }
    }
    return seedJson.get((rc.artRef || rc.id) + '\u0000' + JSON.stringify(rc.art)) || seedJson.get(rc.id + '\u0000' + JSON.stringify(rc.art)) || null;
  }
  function packArt(art) {
    const idx = seedArtIndex();
    const out = {};
    for (const [ref, a] of Object.entries(art)) out[ref] = idx.has(a) ? { seedRef: idx.get(a) } : a;
    return out;
  }
  function unpackArt(art) {
    const out = {};
    for (const [ref, a] of Object.entries(art || {})) {
      if (a && a.seedRef) {
        const [key, id] = a.seedRef.split(':');
        const seed = (window.HARNESS_SEEDS || {})[key];
        const c = seed && seed.components.find((sc) => sc.id === id);
        out[ref] = (c && c.art) || [];
      } else out[ref] = a;
    }
    return out;
  }
  App._packArt = packArt;
  App._unpackArt = unpackArt;
  function readJSON(key, fallback) {
    try {
      const s = localStorage.getItem(key);
      return s ? JSON.parse(s) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJSON(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      App.toast('Could not save to local storage: ' + (e.name === 'QuotaExceededError' ? 'storage is full' : e.message), 'error');
      return false;
    }
  }
  App.loadPrefs = function () {
    state.prefs = Object.assign({}, DEFAULT_PREFS, readJSON(KEY_PREFS, {}));
  };
  App.savePrefs = function () {
    writeJSON(KEY_PREFS, state.prefs);
  };
  App.listProjects = function () {
    return readJSON(KEY_INDEX, []);
  };
  function writeIndexEntry(id, name) {
    const list = App.listProjects().filter((p) => p.id !== id);
    list.unshift({ id, name, updated: new Date().toISOString() });
    writeJSON(KEY_INDEX, list);
  }
  App.lastProjectId = function () {
    const list = App.listProjects();
    return list.length ? list[0].id : null;
  };

  let saveTimer = null;
  App.saveNow = function () {
    clearTimeout(saveTimer);
    saveTimer = null;
    const id = state.projectId;
    if (!id) return;
    state.doc.meta.updated = new Date().toISOString();
    let ok = writeJSON(keyDoc(id), state.doc);
    if (ok && state.artDirty) {
      ok = writeJSON(keyArt(id), packArt(state.art));
      if (ok) state.artDirty = false;
    }
    if (ok) writeIndexEntry(id, state.doc.meta.title || 'Untitled');
    App.emit('saved', ok);
  };
  App.scheduleSave = function () {
    clearTimeout(saveTimer);
    App.emit('dirty');
    saveTimer = setTimeout(App.saveNow, 500);
  };

  App.openProject = function (id) {
    const doc = readJSON(keyDoc(id), null);
    if (!doc) return false;
    App.saveNow();
    const art = unpackArt(readJSON(keyArt(id), {}));
    const r = absorb(doc);
    state.doc = r.doc;
    state.art = Object.assign(art, r.art);
    state.projectId = id;
    state.artDirty = false;
    state.refData = readJSON(keyRef(id), null);
    App.resetHistory();
    App.clearSelection(true);
    writeIndexEntry(id, state.doc.meta.title || 'Untitled');
    App.emit('docLoaded');
    return true;
  };
  App.createProject = function (rawDoc, name) {
    App.saveNow();
    const r = absorb(rawDoc);
    const id = 'p' + Date.now().toString(36);
    if (name) r.doc.meta.title = name;
    state.doc = r.doc;
    state.art = r.art;
    state.projectId = id;
    state.artDirty = true;
    state.refData = null;
    App.resetHistory();
    App.clearSelection(true);
    App.saveNow();
    App.emit('docLoaded');
    return id;
  };
  /** replace this harness's contents (reset to example); not undoable */
  App.replaceDoc = function (rawDoc) {
    const title = state.doc.meta.title;
    const r = absorb(rawDoc);
    r.doc.meta.title = title;
    state.doc = r.doc;
    state.art = r.art;
    state.artDirty = true;
    App.resetHistory();
    App.clearSelection(true);
    App.saveNow();
    App.emit('docLoaded');
  };
  App.deleteProject = function (id) {
    localStorage.removeItem(keyDoc(id));
    localStorage.removeItem(keyArt(id));
    localStorage.removeItem(keyRef(id));
    writeJSON(KEY_INDEX, App.listProjects().filter((p) => p.id !== id));
  };
  App.renameProject = function (name) {
    App.mutate(() => {
      state.doc.meta.title = name;
    });
  };
  App.setReferenceImage = function (dataUrl) {
    state.refData = dataUrl;
    if (dataUrl) {
      if (!writeJSON(keyRef(state.projectId), dataUrl)) App.toast('The image is shown for this session only (too large to store).', 'warn');
    } else localStorage.removeItem(keyRef(state.projectId));
    App.emit('change');
  };
  App.storageUsed = function () {
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('ehw.')) n += k.length + (localStorage.getItem(k) || '').length;
    }
    return n * 2;
  };
  /** world-space box around every component, wire and label, or null for an empty drawing */
  App.contentBounds = function () {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const add = (x, y) => {
      b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y);
      b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
    };
    for (const c of state.doc.components) {
      const cb = App.compBounds(c);
      add(cb.x0, cb.y0);
      add(cb.x1, cb.y1);
    }
    for (const w of state.doc.wires) for (const [x, y] of [...App.wirePoints(w), ...w.labels]) add(x, y);
    return b.x0 === Infinity ? null : b;
  };
  /**
   * Resize the page to w × h, moving the whole drawing (and its reference underlay) by dx, dy
   * so the page can grow to the left or top. One undoable edit.
   */
  App.resizePage = function (w, h, dx, dy) {
    dx = dx || 0;
    dy = dy || 0;
    const doc = state.doc;
    App.mutate(() => {
      // pin the underlay where it is now; by default it stretches to fill the page
      const ref = doc.reference || { x: 0, y: 0, w: doc.page.w, h: doc.page.h };
      if (dx || dy) {
        for (const c of doc.components) {
          c.x = App.round(c.x + dx);
          c.y = App.round(c.y + dy);
        }
        const shift = ([x, y]) => [App.round(x + dx), App.round(y + dy)];
        for (const wr of doc.wires) {
          wr.points = wr.points.map(shift);
          wr.labels = wr.labels.map(shift);
        }
      }
      doc.reference = Object.assign({}, ref, { x: App.round((ref.x || 0) + dx), y: App.round((ref.y || 0) + dy) });
      doc.page = { w: App.round(w), h: App.round(h) };
    });
  };
  App.addArt = function (ref, art) {
    state.art[ref] = art;
    state.artDirty = true;
  };

  // ------------------------------------------------------------------ edit operations
  /*
   * Every committed edit is described as ops on whole components, wires and top-level fields:
   *   {op:'put', coll, id, value, index} | {op:'del', coll, id} | {op:'set', key, value}
   * Undo/redo replay inverse ops, so they only touch what this user changed, and the same ops
   * are what a live-collaboration backend sends to other people.
   */
  const COLLS = ['components', 'wires'];
  App.diffDocs = function (a, b) {
    const ops = [];
    for (const coll of COLLS) {
      const before = new Map((a[coll] || []).map((x) => [x.id, JSON.stringify(x)]));
      (b[coll] || []).forEach((x, index) => {
        const s = JSON.stringify(x);
        if (before.get(x.id) !== s) ops.push({ op: 'put', coll, id: x.id, value: JSON.parse(s), index });
      });
      const after = new Set((b[coll] || []).map((x) => x.id));
      for (const id of before.keys()) if (!after.has(id)) ops.push({ op: 'del', coll, id });
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !COLLS.includes(k)));
    for (const key of keys) {
      const sa = JSON.stringify(a[key]), sb = JSON.stringify(b[key]);
      if (sa !== sb) ops.push(sb === undefined ? { op: 'set', key } : { op: 'set', key, value: JSON.parse(sb) });
    }
    return ops;
  };
  /** apply ops to doc in place; existing objects are updated rather than replaced */
  App.applyOps = function (doc, ops) {
    for (const o of ops) {
      if (o.op === 'set') {
        if (o.value === undefined) delete doc[o.key];
        else doc[o.key] = App.clone(o.value);
        continue;
      }
      const arr = doc[o.coll];
      if (!arr) continue;
      const i = arr.findIndex((x) => x.id === o.id);
      if (o.op === 'del') {
        if (i >= 0) arr.splice(i, 1);
      } else if (o.op === 'put') {
        const v = App.clone(o.value);
        if (i >= 0) {
          const t = arr[i];
          for (const k of Object.keys(t)) delete t[k];
          Object.assign(t, v);
        } else arr.splice(Math.min(o.index == null ? arr.length : o.index, arr.length), 0, v);
      }
    }
  };

  // ------------------------------------------------------------------ history
  const history = { undo: [], redo: [], pending: null };
  const LIMIT = 200;
  App.resetHistory = function () {
    history.undo = [];
    history.redo = [];
    history.pending = null;
    App.emit('history');
  };
  /** remember the document before an edit; the edit is recorded when App.changed() runs */
  App.checkpoint = function () {
    if (history.pending == null) history.pending = JSON.stringify(state.doc);
  };
  /** forget the checkpoint if nothing actually changed (e.g. a click without drag) */
  App.discardCheckpointIfUnchanged = function () {
    if (history.pending == null) return true;
    if (history.pending === JSON.stringify(state.doc)) {
      history.pending = null;
      return true;
    }
    return false;
  };
  App.canUndo = () => history.undo.length > 0 || history.pending != null;
  App.canRedo = () => history.redo.length > 0;
  function commit() {
    if (history.pending == null) return null;
    const before = JSON.parse(history.pending);
    history.pending = null;
    const redo = App.diffDocs(before, state.doc);
    if (!redo.length) return null;
    history.undo.push({ undo: App.diffDocs(state.doc, before), redo });
    if (history.undo.length > LIMIT) history.undo.shift();
    history.redo = [];
    return redo;
  }
  function fixSelection() {
    const ids = new Set(state.doc.components.map((c) => c.id));
    const wids = new Set(state.doc.wires.map((w) => w.id));
    state.sel.comps = new Set([...state.sel.comps].filter((id) => ids.has(id)));
    state.sel.wires = new Set([...state.sel.wires].filter((id) => wids.has(id)));
    if (state.highlight) state.highlight = new Set([...state.highlight].filter((id) => wids.has(id)));
  }
  function replay(ops) {
    App.applyOps(state.doc, ops);
    fixSelection();
    state.highlight = null;
    App.emit('ops', ops);
    App.scheduleSave();
    App.emit('history');
    App.emit('change');
  }
  App.undo = function () {
    if (history.pending != null) {
      // abandon an edit that was started but never committed
      state.doc = JSON.parse(history.pending);
      history.pending = null;
      fixSelection();
      App.emit('history');
      App.emit('change');
      return;
    }
    const e = history.undo.pop();
    if (!e) return;
    history.redo.push(e);
    replay(e.undo);
  };
  App.redo = function () {
    const e = history.redo.pop();
    if (!e) return;
    history.undo.push(e);
    replay(e.redo);
  };
  /** run fn as one undoable edit */
  App.mutate = function (fn) {
    App.checkpoint();
    const r = fn();
    App.changed();
    return r;
  };
  App.changed = function () {
    const ops = commit();
    if (ops) App.emit('ops', ops);
    App.scheduleSave();
    App.emit('history');
    App.emit('change');
  };
  /** edits made by someone else; they also flow into an edit in progress */
  App.applyRemoteOps = function (ops) {
    App.applyOps(state.doc, ops);
    if (history.pending != null) {
      const p = JSON.parse(history.pending);
      App.applyOps(p, ops);
      history.pending = JSON.stringify(p);
    }
    fixSelection();
    App.emit('change');
  };

  // ------------------------------------------------------------------ selection
  App.clearSelection = function (silent) {
    state.sel.comps.clear();
    state.sel.wires.clear();
    state.highlight = null;
    if (!silent) App.emit('selection');
  };
  App.select = function (kind, id, additive) {
    if (!additive) {
      state.sel.comps.clear();
      state.sel.wires.clear();
    }
    const set = kind === 'comp' ? state.sel.comps : state.sel.wires;
    if (additive && set.has(id)) set.delete(id);
    else set.add(id);
    state.highlight = null;
    App.emit('selection');
  };

  // ------------------------------------------------------------------ edits
  App.deleteComponents = function (ids) {
    const doc = state.doc;
    const set = new Set(ids);
    doc.wires = doc.wires.filter((w) => !set.has(w.from.c) && !set.has(w.to.c));
    doc.components = doc.components.filter((c) => !set.has(c.id));
    for (const id of ids) state.sel.comps.delete(id);
    App.pruneSplices();
  };
  App.deleteWires = function (ids) {
    const set = new Set(ids);
    state.doc.wires = state.doc.wires.filter((w) => !set.has(w.id));
    for (const id of ids) state.sel.wires.delete(id);
    App.pruneSplices();
  };
  /** splices left with no wires are removed */
  App.pruneSplices = function () {
    const doc = state.doc;
    const used = new Set();
    for (const w of doc.wires) {
      used.add(w.from.c);
      used.add(w.to.c);
    }
    doc.components = doc.components.filter((c) => c.style !== 'splice' || used.has(c.id));
  };
  /** split wire w at world point (x,y), joining both halves to a new splice; returns the splice */
  App.spliceWire = function (w, x, y) {
    const pts = App.wirePoints(w);
    const near = App.nearestOnPolyline(pts, x, y);
    const sx = App.round(near.x), sy = App.round(near.y);
    const sp = {
      id: App.uid('SP'), name: '', type: 'splice', style: 'splice',
      x: sx - 1.5, y: sy - 1.5, w: 3, h: 3, rot: 0, pins: [{ id: 'p1', name: '1', x: 1.5, y: 1.5 }],
    };
    sp.name = 'Splice ' + sp.id.slice(2);
    state.doc.components.push(sp);
    const a = pts.slice(0, near.i + 1).concat([[sx, sy]]);
    const b = [[sx, sy]].concat(pts.slice(near.i + 1));
    const w2 = App.clone(w);
    w2.id = App.uid('W');
    w.points = a;
    w.to = { c: sp.id, p: 'p1' };
    w2.points = b;
    w2.from = { c: sp.id, p: 'p1' };
    // keep each circuit label with the half it sits on
    const keepA = [], keepB = [];
    for (const l of w.labels) {
      const da = App.nearestOnPolyline(a, l[0], l[1]).d, db = App.nearestOnPolyline(b, l[0], l[1]).d;
      (da <= db ? keepA : keepB).push(l);
    }
    w.labels = keepA;
    w2.labels = keepB;
    state.doc.wires.push(w2);
    return sp;
  };
  /** remove collinear and duplicate interior points */
  App.simplifyPoints = function (pts) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.01) continue;
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 0.01) continue;
      out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  };
  /** make every segment horizontal or vertical by inserting elbows */
  App.orthogonalize = function (w) {
    const pts = App.wirePoints(w);
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = out[out.length - 1], b = pts[i];
      if (Math.abs(a[0] - b[0]) > 0.01 && Math.abs(a[1] - b[1]) > 0.01) out.push([b[0], a[1]]);
      out.push(b);
    }
    w.points = App.simplifyPoints(out).map((p) => [App.round(p[0]), App.round(p[1])]);
  };

  // ------------------------------------------------------------------ events
  const listeners = {};
  App.on = function (ev, fn) {
    (listeners[ev] = listeners[ev] || []).push(fn);
  };
  App.emit = function (ev, arg) {
    for (const fn of listeners[ev] || []) fn(arg);
  };
})();
