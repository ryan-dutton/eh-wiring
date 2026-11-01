import { DurableObject } from "cloudflare:workers";
import { COLLS, OpError, validateOps, type Coll, type Entity, type Op } from "./ops";

const BACKUP_DELAY_MS = 30 * 1000;
const HISTORY_EVERY_MS = 10 * 60 * 1000;
const MAX_MESSAGE = 4 * 1024 * 1024;
const PEER_COLOURS = ["#e5484d", "#30a46c", "#8e4ec6", "#f76b15", "#0091ff", "#d6409f"];

type Attachment = { client: string; email: string; colour: string; cursor?: [number, number] };
type Item = { pos: number; value: Entity };
type Loaded = { fields: Map<string, unknown>; colls: Record<Coll, Map<string, Item>> };
export type Snapshot = { doc: Record<string, unknown>; seq: number };

/**
 * One harness. Holds the canonical document in SQLite, relays edits between connected
 * browsers over hibernating WebSockets, and backs itself up to R2 shortly after changes.
 */
export class HarnessRoom extends DurableObject<Env> {
  private loaded: Loaded | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS fields (key TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS entities (coll TEXT NOT NULL, id TEXT NOT NULL, pos REAL NOT NULL, json TEXT NOT NULL, PRIMARY KEY (coll, id));
        CREATE TABLE IF NOT EXISTS art (ref TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  // ------------------------------------------------------------------ storage
  private kvGet(key: string): string | null {
    const r = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    return r ? r.value : null;
  }
  private kvSet(key: string, value: string | number): void {
    this.ctx.storage.sql.exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
  }
  private get seq(): number {
    return Number(this.kvGet("seq") || 0);
  }
  private get projectId(): string {
    return this.kvGet("project") || "";
  }

  private load(): Loaded {
    if (this.loaded) return this.loaded;
    const sql = this.ctx.storage.sql;
    const fields = new Map<string, unknown>();
    for (const r of sql.exec<{ key: string; json: string }>("SELECT key, json FROM fields")) fields.set(r.key, JSON.parse(r.json));
    const colls = { components: new Map(), wires: new Map() } as Record<Coll, Map<string, Item>>;
    for (const r of sql.exec<{ coll: Coll; id: string; pos: number; json: string }>("SELECT coll, id, pos, json FROM entities")) {
      colls[r.coll]?.set(r.id, { pos: r.pos, value: JSON.parse(r.json) });
    }
    this.loaded = { fields, colls };
    return this.loaded;
  }

  private doc(): Record<string, unknown> {
    const { fields, colls } = this.load();
    const doc: Record<string, unknown> = Object.fromEntries(fields);
    for (const c of COLLS) doc[c] = [...colls[c].values()].sort((a, b) => a.pos - b.pos).map((i) => i.value);
    return doc;
  }

  private art(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.ctx.storage.sql.exec<{ ref: string; json: string }>("SELECT ref, json FROM art")) out[r.ref] = JSON.parse(r.json);
    return out;
  }

  /** replace everything with `doc` + `art` (used for create, restore and reset) */
  private writeAll(doc: Record<string, unknown>, art: Record<string, unknown>): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM fields");
      sql.exec("DELETE FROM entities");
      sql.exec("DELETE FROM art");
      for (const [k, v] of Object.entries(doc)) {
        if ((COLLS as readonly string[]).includes(k) || v === undefined) continue;
        sql.exec("INSERT INTO fields (key, json) VALUES (?, ?)", k, JSON.stringify(v));
      }
      for (const c of COLLS) {
        const list = Array.isArray(doc[c]) ? (doc[c] as Entity[]) : [];
        list.forEach((e, i) => sql.exec("INSERT OR REPLACE INTO entities (coll, id, pos, json) VALUES (?, ?, ?, ?)", c, String(e.id), i, JSON.stringify(e)));
      }
      for (const [ref, a] of Object.entries(art || {})) sql.exec("INSERT INTO art (ref, json) VALUES (?, ?)", ref, JSON.stringify(a));
      this.kvSet("seq", this.seq + 1);
      this.kvSet("dirty", 1);
    });
    this.loaded = null;
  }

  private applyOps(ops: Op[]): { seq: number; title?: string } {
    const { fields, colls } = this.load();
    const sql = this.ctx.storage.sql;
    let title: string | undefined;
    this.ctx.storage.transactionSync(() => {
      for (const o of ops) {
        if (o.op === "set") {
          if (o.value === undefined) {
            fields.delete(o.key);
            sql.exec("DELETE FROM fields WHERE key = ?", o.key);
          } else {
            fields.set(o.key, o.value);
            sql.exec("INSERT INTO fields (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json", o.key, JSON.stringify(o.value));
            if (o.key === "meta") title = String((o.value as { title?: unknown }).title || "Untitled");
          }
          continue;
        }
        const map = colls[o.coll];
        if (o.op === "del") {
          map.delete(o.id);
          sql.exec("DELETE FROM entities WHERE coll = ? AND id = ?", o.coll, o.id);
          continue;
        }
        const existing = map.get(o.id);
        const pos = existing ? existing.pos : positionFor(map, o.index);
        map.set(o.id, { pos, value: o.value });
        sql.exec(
          "INSERT INTO entities (coll, id, pos, json) VALUES (?, ?, ?, ?) ON CONFLICT(coll, id) DO UPDATE SET json = excluded.json",
          o.coll, o.id, pos, JSON.stringify(o.value),
        );
      }
      this.kvSet("seq", this.seq + 1);
      this.kvSet("dirty", 1);
    });
    return { seq: this.seq, title };
  }

  // ------------------------------------------------------------------ RPC (from the Worker)
  async init(projectId: string, doc: Record<string, unknown>, art: Record<string, unknown>): Promise<void> {
    this.kvSet("project", projectId);
    this.writeAll(doc, art);
    await this.scheduleBackup();
  }

  snapshot(): Snapshot {
    return { doc: this.doc(), seq: this.seq };
  }

  artMap(): Record<string, unknown> {
    return this.art();
  }

  /** swap in a whole new document (restore / reset); the previous state is backed up first */
  async replace(doc: Record<string, unknown>, art: Record<string, unknown>, by: string): Promise<number> {
    await this.backup(true, `before-replace-by-${by}`);
    this.writeAll(doc, art);
    await this.scheduleBackup();
    this.broadcast({ t: "reload", by });
    const meta = doc.meta as { title?: string } | undefined;
    if (meta?.title) await this.env.DIRECTORY.getByName("main").touchProject(this.projectId, meta.title);
    return this.seq;
  }

  /** final backup, disconnect everyone, then wipe this object */
  async destroy(by: string): Promise<void> {
    await this.backup(true, `before-delete-by-${by}`);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ t: "deleted", by }));
        ws.close(4004, "harness deleted");
      } catch {
        /* already gone */
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.loaded = null;
  }

  // ------------------------------------------------------------------ WebSockets
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const email = request.headers.get("X-User-Email") || "unknown";
    if (!this.projectId) return new Response("No such harness", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const used = new Set(this.ctx.getWebSockets().map((w) => (w.deserializeAttachment() as Attachment | null)?.colour));
    const att: Attachment = {
      client: crypto.randomUUID().slice(0, 8),
      email,
      colour: PEER_COLOURS.find((c) => !used.has(c)) || PEER_COLOURS[0],
    };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(att);
    const peers = this.ctx
      .getWebSockets()
      .filter((w) => w !== server)
      .map((w) => w.deserializeAttachment() as Attachment)
      .filter(Boolean);
    server.send(JSON.stringify({ t: "hello", you: att, peers, seq: this.seq, doc: this.doc() }));
    this.broadcast({ t: "join", peer: att }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_MESSAGE) return;
    let msg: { t?: string; rid?: number; ops?: unknown; x?: unknown; y?: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment() as Attachment;
    if (msg.t === "ops") {
      let ops: Op[];
      try {
        ops = validateOps(msg.ops);
      } catch (e) {
        ws.send(JSON.stringify({ t: "error", rid: msg.rid, message: e instanceof OpError ? e.message : "invalid edit" }));
        ws.send(JSON.stringify({ t: "reload", by: "server" }));
        return;
      }
      const { seq, title } = this.applyOps(ops);
      ws.send(JSON.stringify({ t: "ack", rid: msg.rid, seq }));
      this.broadcast({ t: "ops", ops, seq, by: me.email, client: me.client }, ws);
      if (title !== undefined) await this.env.DIRECTORY.getByName("main").touchProject(this.projectId, title);
      await this.scheduleBackup();
    } else if (msg.t === "cursor" && typeof msg.x === "number" && typeof msg.y === "number") {
      me.cursor = [Math.round(msg.x * 10) / 10, Math.round(msg.y * 10) / 10];
      ws.serializeAttachment(me);
      this.broadcast({ t: "cursor", client: me.client, x: me.cursor[0], y: me.cursor[1] }, ws);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.leave(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* runtime already completed the close handshake */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.leave(ws);
  }

  private leave(ws: WebSocket): void {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (me) this.broadcast({ t: "leave", client: me.client }, ws);
  }

  private broadcast(msg: unknown, except?: WebSocket): void {
    const s = JSON.stringify(msg);
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      try {
        w.send(s);
      } catch {
        /* closing socket */
      }
    }
  }

  // ------------------------------------------------------------------ R2 backups
  private async scheduleBackup(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + BACKUP_DELAY_MS);
  }

  async alarm(): Promise<void> {
    if (this.kvGet("dirty") === "1") await this.backup(false);
  }

  /**
   * Write latest.json, plus a timestamped copy in history/ at most every 10 minutes
   * (or always when `forceHistory`).
   */
  private async backup(forceHistory: boolean, note?: string): Promise<void> {
    const id = this.projectId;
    if (!id) return;
    const seq = this.seq;
    const body = JSON.stringify({ project: id, seq, savedAt: new Date().toISOString(), note, doc: this.doc(), art: this.art() });
    const meta = { httpMetadata: { contentType: "application/json" }, customMetadata: { seq: String(seq), ...(note ? { note } : {}) } };
    await this.env.BACKUPS.put(`projects/${id}/latest.json`, body, meta);
    const last = Number(this.kvGet("lastHistory") || 0);
    if (forceHistory || Date.now() - last >= HISTORY_EVERY_MS) {
      await this.env.BACKUPS.put(`projects/${id}/history/${new Date().toISOString()}.json`, body, meta);
      this.kvSet("lastHistory", Date.now());
    }
    // only clear the flag if nothing changed while we were writing
    if (this.seq === seq) this.kvSet("dirty", 0);
    else await this.ctx.storage.setAlarm(Date.now() + BACKUP_DELAY_MS);
    await this.env.DIRECTORY.getByName("main").touchProject(id);
  }
}

/** sort key that slots a new item in at `index` without renumbering the rest */
function positionFor(map: Map<string, Item>, index?: number): number {
  const sorted = [...map.values()].map((i) => i.pos).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  if (index === undefined || index >= sorted.length) return sorted[sorted.length - 1] + 1;
  if (index <= 0) return sorted[0] - 1;
  return (sorted[index - 1] + sorted[index]) / 2;
}
