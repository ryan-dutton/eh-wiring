import { DurableObject } from "cloudflare:workers";

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const CODE_REQUESTS_PER_WINDOW = 3;
const CODE_WINDOW_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type ProjectInfo = { id: string; title: string; created: number; updated: number; createdBy: string };

/**
 * The one small coordination point: sign-in codes, sessions and the list of harnesses.
 * Traffic is two people, so a single instance ("main") is plenty.
 */
export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS code_requests (email TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, created_by TEXT NOT NULL);
      `);
    });
  }

  /** New one-time code for `email`, or null when too many were requested recently. */
  async issueCode(email: string): Promise<string | null> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM code_requests WHERE at < ?", now - CODE_WINDOW_MS);
    const recent = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM code_requests WHERE email = ?", email).one().n;
    if (recent >= CODE_REQUESTS_PER_WINDOW) return null;
    const code = randomCode();
    const hash = await sha256(`${email}:${code}`);
    sql.exec("INSERT INTO code_requests (email, at) VALUES (?, ?)", email, now);
    sql.exec(
      "INSERT INTO codes (email, hash, expires, attempts) VALUES (?, ?, ?, 0) ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires, attempts = 0",
      email, hash, now + CODE_TTL_MS,
    );
    return code;
  }

  /** Session token if `code` is the live code for `email`; each code works once. */
  async verifyCode(email: string, code: string): Promise<string | null> {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ hash: string; expires: number; attempts: number }>("SELECT hash, expires, attempts FROM codes WHERE email = ?", email).toArray()[0];
    if (!row) return null;
    if (row.expires < Date.now() || row.attempts >= CODE_MAX_ATTEMPTS) {
      sql.exec("DELETE FROM codes WHERE email = ?", email);
      return null;
    }
    const hash = await sha256(`${email}:${code}`);
    if (!timingSafeEqual(hash, row.hash)) {
      sql.exec("UPDATE codes SET attempts = attempts + 1 WHERE email = ?", email);
      return null;
    }
    sql.exec("DELETE FROM codes WHERE email = ?", email);
    const token = randomToken();
    const now = Date.now();
    sql.exec("DELETE FROM sessions WHERE expires < ?", now);
    sql.exec("INSERT INTO sessions (hash, email, created, expires) VALUES (?, ?, ?, ?)", await sha256(token), email, now, now + SESSION_TTL_MS);
    return token;
  }

  async session(token: string): Promise<{ email: string; expires: number } | null> {
    const row = this.ctx.storage.sql
      .exec<{ email: string; expires: number }>("SELECT email, expires FROM sessions WHERE hash = ?", await sha256(token))
      .toArray()[0];
    if (!row || row.expires < Date.now()) return null;
    return row;
  }

  async endSession(token: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE hash = ?", await sha256(token));
  }

  listProjects(): ProjectInfo[] {
    return this.ctx.storage.sql
      .exec<{ id: string; title: string; created: number; updated: number; created_by: string }>(
        "SELECT id, title, created, updated, created_by FROM projects ORDER BY updated DESC",
      )
      .toArray()
      .map((r) => ({ id: r.id, title: r.title, created: r.created, updated: r.updated, createdBy: r.created_by }));
  }

  hasProject(id: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM projects WHERE id = ?", id).toArray().length > 0;
  }

  addProject(id: string, title: string, by: string): void {
    const now = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO projects (id, title, created, updated, created_by) VALUES (?, ?, ?, ?, ?)", id, title, now, now, by);
  }

  touchProject(id: string, title?: string): void {
    if (title !== undefined) this.ctx.storage.sql.exec("UPDATE projects SET title = ?, updated = ? WHERE id = ?", title, Date.now(), id);
    else this.ctx.storage.sql.exec("UPDATE projects SET updated = ? WHERE id = ?", Date.now(), id);
  }

  removeProject(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM projects WHERE id = ?", id);
  }
}

function randomCode(): string {
  // rejection sampling keeps the 6 digits uniform
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
