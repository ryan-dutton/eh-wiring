/* Live collaboration: when served by the Worker, harnesses live in Durable Objects and edits
   are exchanged over a WebSocket. Opened from disk, none of this activates. */
(function () {
  'use strict';
  const App = window.App;
  const state = App.state;
  const esc = App.esc;
  const $ = (sel) => document.querySelector(sel);

  const cloud = (App.cloud = { enabled: false, email: null, projects: [], peers: new Map(), you: null, seq: 0 });
  let ws = null;
  let wantId = null;
  let rid = 0;
  let queue = [];          // edits sent but not yet acknowledged
  let retry = 0;
  let retryTimer = 0;
  let helloWaiter = null;
  let skipReload = 0;
  let cursorTimer = 0;
  let lastCursor = null;
  let status = 'offline';

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }, opts));
    if (r.status === 401) {
      location.href = '/login';
      throw new Error('Your session has ended. Please sign in again.');
    }
    let body = null;
    try {
      body = await r.json();
    } catch (e) { /* no body */ }
    if (!r.ok) throw new Error((body && body.error) || `Request failed (${r.status})`);
    return body;
  }

  /** true when this page is served by the Worker and the user is signed in */
  App.startCloud = async function () {
    if (location.protocol === 'file:') return false;
    let me = null;
    try {
      const r = await fetch('/api/me', { headers: { Accept: 'application/json' } });
      if (r.status === 401) {
        location.href = '/login';
        await new Promise(() => {});
      }
      if (r.ok) me = await r.json();
    } catch (e) {
      return false;
    }
    if (!me || !me.email) return false;
    cloud.enabled = true;
    cloud.email = me.email;
    install();
    await refreshProjects();
    return true;
  };

  function install() {
    App.listProjects = () => cloud.projects;
    App.lastProjectId = () => {
      const want = state.prefs.lastProject;
      if (want && cloud.projects.some((p) => p.id === want)) return want;
      return cloud.projects[0] ? cloud.projects[0].id : null;
    };
    App.saveNow = () => {};
    App.scheduleSave = () => {};
    App.openProject = openProject;
    App.createProject = createProject;
    App.deleteProject = deleteProject;
    App.replaceDoc = replaceDoc;
    App.storageUsed = () => 0;
    App.on('ops', send);
    App.on('cursor', onCursor);
    document.querySelectorAll('.cloud-only').forEach((el) => (el.hidden = false));
    const who = $('#signout-label');
    if (who) who.textContent = cloud.email;
    setInterval(() => {
      if (ws && ws.readyState === 1) ws.send('{"t":"ping"}');
    }, 25000);
    setStatus('connecting');
  }

  async function refreshProjects() {
    const list = await api('/api/projects');
    cloud.projects = list.map((p) => ({ id: p.id, name: p.title, updated: new Date(p.updated).toISOString(), createdBy: p.createdBy }));
    if (App.refreshProjectMenu) App.refreshProjectMenu();
    return cloud.projects;
  }
  App.refreshProjects = refreshProjects;

  // ------------------------------------------------------------------ projects
  function toLocalDoc(serverDoc, art) {
    const raw = Object.assign({}, serverDoc);
    if (art) raw.art = art;
    const r = App._absorb(raw);
    delete r.doc.art;
    return r;
  }
  async function openProject(id) {
    disconnect();
    let art;
    try {
      art = App._unpackArt(await api(`/api/projects/${encodeURIComponent(id)}/art`));
    } catch (e) {
      return false;
    }
    const hello = await connect(id);
    const r = toLocalDoc(hello.doc, art);
    state.doc = r.doc;
    state.art = r.art;
    state.projectId = id;
    state.artDirty = false;
    try {
      state.refData = JSON.parse(localStorage.getItem('ehw.ref.' + id) || 'null');
    } catch (e) {
      state.refData = null;
    }
    state.prefs.lastProject = id;
    App.savePrefs();
    App.resetHistory();
    App.clearSelection(true);
    App.emit('docLoaded');
    return true;
  }
  async function createProject(rawDoc, name) {
    const r = App._absorb(rawDoc);
    delete r.doc.art;
    if (name) r.doc.meta.title = name;
    const res = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title: r.doc.meta.title, doc: r.doc, art: App._packArt(r.art) }),
    });
    await refreshProjects();
    await openProject(res.id);
    return res.id;
  }
  async function deleteProject(id) {
    if (id === wantId) disconnect();
    await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await refreshProjects();
  }
  async function replaceDoc(rawDoc) {
    const r = App._absorb(rawDoc);
    delete r.doc.art;
    r.doc.meta.title = state.doc.meta.title;
    skipReload++;
    await api(`/api/projects/${encodeURIComponent(state.projectId)}/replace`, {
      method: 'POST',
      body: JSON.stringify({ doc: r.doc, art: App._packArt(r.art) }),
    });
    await openProject(state.projectId);
  }

  // ------------------------------------------------------------------ socket
  function connect(id) {
    wantId = id;
    return new Promise((resolve, reject) => {
      helloWaiter = { resolve, reject };
      open();
    });
  }
  function disconnect() {
    wantId = null;
    clearTimeout(retryTimer);
    queue = [];
    if (ws) {
      const s = ws;
      ws = null;
      try {
        s.close(1000, 'switching harness');
      } catch (e) { /* ignore */ }
    }
    cloud.peers.clear();
    updatePeers();
  }
  function open() {
    if (!wantId) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/api/projects/${encodeURIComponent(wantId)}/ws`);
    ws = sock;
    setStatus(retry ? 'reconnecting' : 'connecting');
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      onMessage(msg);
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      cloud.peers.clear();
      updatePeers();
      if (ev.code === 4004) return onDeleted('someone');
      scheduleReconnect();
    };
  }
  async function scheduleReconnect() {
    if (!wantId) return;
    retry++;
    setStatus('reconnecting');
    // a refused upgrade looks like a plain close: find out whether we were signed out
    if (retry >= 2) {
      try {
        await api(`/api/projects/${encodeURIComponent(wantId)}`);
      } catch (e) {
        if (helloWaiter) {
          helloWaiter.reject(e);
          helloWaiter = null;
        }
        if (/No such harness/.test(e.message)) return onDeleted('someone');
      }
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, Math.min(10000, 400 * 2 ** Math.min(retry, 5)));
  }

  function onMessage(msg) {
    switch (msg.t) {
      case 'hello':
        cloud.you = msg.you;
        cloud.seq = msg.seq;
        cloud.peers = new Map((msg.peers || []).map((p) => [p.client, p]));
        retry = 0;
        if (helloWaiter) {
          helloWaiter.resolve(msg);
          helloWaiter = null;
        } else {
          rejoin(msg);
        }
        updatePeers();
        setStatus('live');
        break;
      case 'ops':
        cloud.seq = msg.seq;
        App.applyRemoteOps(msg.ops);
        notePeerEdit(msg.client);
        break;
      case 'ack':
        cloud.seq = msg.seq;
        queue = queue.filter((q) => q.rid !== msg.rid);
        setStatus('live');
        break;
      case 'cursor': {
        const p = cloud.peers.get(msg.client);
        if (p) {
          p.cursor = [msg.x, msg.y];
          renderPeers();
        }
        break;
      }
      case 'join':
        cloud.peers.set(msg.peer.client, msg.peer);
        if (msg.peer.email !== cloud.email) App.toast(`${shortName(msg.peer.email)} joined`);
        updatePeers();
        break;
      case 'leave':
        cloud.peers.delete(msg.client);
        updatePeers();
        break;
      case 'reload':
        if (skipReload > 0) {
          skipReload--;
          break;
        }
        App.toast(msg.by === 'server' ? 'Reloading the latest version from the server.' : `${shortName(msg.by)} replaced this harness. Reloading.`, 'warn');
        openProject(wantId).then(() => App.afterLoad());
        break;
      case 'deleted':
        onDeleted(msg.by);
        break;
      case 'error':
        App.toast('The server rejected an edit: ' + msg.message, 'error');
        break;
    }
  }

  /** reconnected: take the server's copy, put our unacknowledged edits back on top, resend them */
  function rejoin(hello) {
    const r = toLocalDoc(hello.doc, null);
    for (const q of queue) App.applyOps(r.doc, q.ops);
    state.doc = r.doc;
    App.applyRemoteOps([]);
    App.resetRenderCache();
    App.render();
    for (const q of queue) ws.send(JSON.stringify({ t: 'ops', rid: q.rid, ops: q.ops }));
    if (queue.length) App.toast(`Back online. Sent ${queue.length} edit${queue.length === 1 ? '' : 's'} made while offline.`);
  }

  async function onDeleted(by) {
    disconnect();
    App.toast(`This harness was deleted by ${shortName(by)}.`, 'warn');
    await refreshProjects();
    const next = App.lastProjectId();
    if (next) {
      await openProject(next);
      App.afterLoad();
    }
  }

  function send(ops) {
    if (!cloud.enabled || !wantId || !ops.length) return;
    const item = { rid: ++rid, ops };
    queue.push(item);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ops', rid: item.rid, ops }));
    setStatus(ws && ws.readyState === 1 ? 'saving' : 'reconnecting');
  }

  function onCursor(pt) {
    lastCursor = pt;
    if (cursorTimer) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = 0;
      if (ws && ws.readyState === 1 && lastCursor && cloud.peers.size) ws.send(JSON.stringify({ t: 'cursor', x: lastCursor[0], y: lastCursor[1] }));
    }, 60);
  }

  // ------------------------------------------------------------------ presence & status
  function shortName(email) {
    return String(email || '').split('@')[0];
  }
  function renderPeers() {
    App.overlay.peers = [...cloud.peers.values()].filter((p) => p.cursor).map((p) => ({ x: p.cursor[0], y: p.cursor[1], colour: p.colour, name: shortName(p.email) }));
    App.renderOverlay();
  }
  function updatePeers() {
    const el = $('#st-peers');
    if (el) {
      const others = [...cloud.peers.values()];
      el.innerHTML = others.length
        ? others.map((p) => `<span class="peer" data-client="${esc(p.client)}" title="${esc(p.email)}"><i style="background:${esc(p.colour)}"></i>${esc(shortName(p.email))}</span>`).join('')
        : '<span class="muted">Only you</span>';
    }
    renderPeers();
  }
  function notePeerEdit(client) {
    const el = document.querySelector(`#st-peers [data-client="${CSS.escape(client || '')}"]`);
    if (!el) return;
    el.classList.add('editing');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('editing'), 1200);
  }
  function setStatus(s) {
    status = s === 'live' && queue.length ? 'saving' : s;
    const el = $('#st-save');
    if (!el) return;
    const waiting = queue.length ? ` · ${queue.length} edit${queue.length === 1 ? '' : 's'} waiting` : '';
    const text = { connecting: 'Connecting…', reconnecting: 'Reconnecting…' + waiting, saving: 'Saving…', live: 'Live · saved', offline: 'Offline' + waiting }[status];
    el.textContent = text;
    el.className = status === 'live' ? '' : 'dirty';
  }

  // ------------------------------------------------------------------ backups & sign-out
  App.showBackups = async function () {
    const dlg = $('#backups-dialog');
    const list = $('#backups-list');
    list.innerHTML = '<div class="hint">Loading…</div>';
    dlg.showModal();
    try {
      const items = await api(`/api/projects/${encodeURIComponent(state.projectId)}/backups`);
      if (!items.length) {
        list.innerHTML = '<div class="hint">No snapshots yet. One is kept at most every 10 minutes while the harness is being edited, and before any restore, reset or delete.</div>';
        return;
      }
      list.innerHTML = `<table class="grid"><thead><tr><th>Saved</th><th>Note</th><th>Size</th><th></th></tr></thead><tbody>${items
        .map((b) => `<tr><td>${esc(new Date(b.uploaded).toLocaleString())}</td><td class="muted">${esc(b.note.replace(/-/g, ' '))}</td><td class="muted">${Math.round(b.size / 1024)} KB</td>
          <td><button class="btn small" data-key="${esc(b.key)}">Restore</button></td></tr>`)
        .join('')}</tbody></table>`;
      list.querySelectorAll('[data-key]').forEach((btn) => btn.addEventListener('click', async () => {
        if (!confirm('Restore this snapshot for everyone? The current version is backed up first.')) return;
        btn.disabled = true;
        try {
          skipReload++;
          await api(`/api/projects/${encodeURIComponent(state.projectId)}/restore`, { method: 'POST', body: JSON.stringify({ key: btn.dataset.key }) });
          await openProject(state.projectId);
          App.afterLoad();
          dlg.close();
          App.toast('Snapshot restored.');
        } catch (e) {
          skipReload = Math.max(0, skipReload - 1);
          App.toast(e.message, 'error');
          btn.disabled = false;
        }
      }));
    } catch (e) {
      list.innerHTML = `<div class="hint">${esc(e.message)}</div>`;
    }
  };
  App.signOut = async function () {
    disconnect();
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } finally {
      location.href = '/login';
    }
  };
})();
