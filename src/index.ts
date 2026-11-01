import { Directory, SESSION_TTL_MS } from "./directory";
import { HarnessRoom } from "./room";

export { Directory, HarnessRoom };

const COOKIE = "__Host-harness_session";
const PROJECT_RE = /^[a-z0-9-]{8,40}$/;
const MAX_BODY = 20 * 1024 * 1024;

type User = { email: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withSecurityHeaders(await route(request, env));
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("unhandled", e);
      return json({ error: "Something went wrong" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const dir = env.DIRECTORY.getByName("main");

  // state-changing requests and WebSocket upgrades must come from our own pages
  if (method !== "GET" && method !== "HEAD") checkOrigin(request, url);

  // ---------------------------------------------------------------- public: sign-in
  if (path === "/login" || path === "/login.html") {
    if (await currentUser(request, env)) return Response.redirect(new URL("/", url).toString(), 302);
    return env.ASSETS.fetch(new Request(new URL("/login", url), request));
  }
  if (path === "/auth/request" && method === "POST") {
    const { email } = await body<{ email?: string }>(request);
    const addr = normaliseEmail(email);
    if (addr && allowed(env).has(addr)) {
      const code = await dir.issueCode(addr);
      if (code) await sendCode(env, addr, code, url.host);
    }
    // same answer whether or not the address is allowed
    return json({ ok: true });
  }
  if (path === "/auth/verify" && method === "POST") {
    const { email, code } = await body<{ email?: string; code?: string }>(request);
    const addr = normaliseEmail(email);
    const clean = String(code || "").replace(/\D/g, "");
    if (!addr || !allowed(env).has(addr) || clean.length !== 6) return json({ error: "That code is not valid." }, 401);
    const token = await dir.verifyCode(addr, clean);
    if (!token) return json({ error: "That code is not valid or has expired." }, 401);
    return json({ ok: true, email: addr }, 200, {
      "Set-Cookie": `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    });
  }
  if (path === "/auth/logout" && method === "POST") {
    const token = readCookie(request, COOKIE);
    if (token) await dir.endSession(token);
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` });
  }

  // ---------------------------------------------------------------- everything else needs a session
  const user = await currentUser(request, env);
  if (!user) {
    if (path.startsWith("/api/")) return json({ error: "Not signed in" }, 401);
    const accept = request.headers.get("Accept") || "";
    if (method === "GET" && (accept.includes("text/html") || path === "/")) {
      return Response.redirect(new URL("/login", url).toString(), 302);
    }
    return new Response("Not signed in", { status: 401 });
  }

  if (path === "/api/me") return json({ email: user.email });
  if (path === "/api/projects" && method === "GET") return json(await dir.listProjects());
  if (path === "/api/projects" && method === "POST") {
    const { doc, art, title } = await body<{ doc?: Record<string, unknown>; art?: Record<string, unknown>; title?: string }>(request);
    if (!doc || !Array.isArray(doc.components) || !Array.isArray(doc.wires)) throw new HttpError(400, "doc must have components and wires");
    const id = crypto.randomUUID();
    const name = String(title || (doc.meta as { title?: string })?.title || "Untitled harness").slice(0, 200);
    doc.meta = { ...((doc.meta as object) || {}), title: name };
    await env.ROOMS.getByName(id).init(id, doc, art || {});
    await dir.addProject(id, name, user.email);
    return json({ id, title: name }, 201);
  }

  const m = path.match(/^\/api\/projects\/([^/]+)(\/[a-z]+)?$/);
  if (m) {
    const [, id, sub = ""] = m;
    if (!PROJECT_RE.test(id) || !(await dir.hasProject(id))) return json({ error: "No such harness" }, 404);
    const room = env.ROOMS.getByName(id);
    if (sub === "" && method === "GET") return json(await room.snapshot());
    if (sub === "" && method === "DELETE") {
      await room.destroy(user.email);
      await dir.removeProject(id);
      return json({ ok: true });
    }
    if (sub === "/art" && method === "GET") return json(await room.artMap());
    if (sub === "/ws" && method === "GET") {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
      checkOrigin(request, url);
      const headers = new Headers(request.headers);
      headers.set("X-User-Email", user.email);
      return room.fetch(new Request(request.url, { headers }));
    }
    if (sub === "/replace" && method === "POST") {
      const { doc, art } = await body<{ doc?: Record<string, unknown>; art?: Record<string, unknown> }>(request);
      if (!doc || !Array.isArray(doc.components) || !Array.isArray(doc.wires)) throw new HttpError(400, "doc must have components and wires");
      return json({ seq: await room.replace(doc, art || {}, user.email) });
    }
    if (sub === "/backups" && method === "GET") {
      const list = await env.BACKUPS.list({ prefix: `projects/${id}/history/`, include: ["customMetadata"] } as R2ListOptions);
      const items = list.objects
        .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString(), note: o.customMetadata?.note || "" }))
        .sort((a, b) => b.uploaded.localeCompare(a.uploaded));
      return json(items);
    }
    if (sub === "/restore" && method === "POST") {
      const { key } = await body<{ key?: string }>(request);
      if (!key || !key.startsWith(`projects/${id}/`) || key.includes("..")) throw new HttpError(400, "Unknown backup");
      const obj = await env.BACKUPS.get(key);
      if (!obj) throw new HttpError(404, "Backup not found");
      const saved = (await obj.json()) as { doc: Record<string, unknown>; art: Record<string, unknown> };
      return json({ seq: await room.replace(saved.doc, saved.art || {}, user.email) });
    }
    return json({ error: "Not found" }, 404);
  }
  if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);

  const res = await env.ASSETS.fetch(request);
  // the app shell must not be cached across sign-outs
  if ((res.headers.get("Content-Type") || "").includes("text/html")) {
    const r = new Response(res.body, res);
    r.headers.set("Cache-Control", "no-store");
    return r;
  }
  return res;
}

// ------------------------------------------------------------------ helpers
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

async function body<T>(request: Request): Promise<T> {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) throw new HttpError(413, "Too large");
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Expected JSON");
  }
}

function checkOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "Cross-origin request refused");
}

function allowed(env: Env): Set<string> {
  return new Set(
    String(env.ALLOWED_EMAILS || "")
      .split(",")
      .map((s) => normaliseEmail(s))
      .filter(Boolean) as string[],
  );
}

function normaliseEmail(s: unknown): string | null {
  const v = String(s || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? v : null;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

async function currentUser(request: Request, env: Env): Promise<User | null> {
  const token = readCookie(request, COOKIE);
  if (!token || token.length > 100) return null;
  const s = await env.DIRECTORY.getByName("main").session(token);
  if (!s || !allowed(env).has(s.email)) return null;
  return { email: s.email };
}

async function sendCode(env: Env, to: string, code: string, host: string): Promise<void> {
  const text = `Your Harness Editor sign-in code is ${code}\n\nIt expires in 10 minutes and works once. If you didn't ask to sign in to ${host}, ignore this email.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:24px auto;color:#1c2430">
    <p style="margin:0 0 12px">Your Harness Editor sign-in code is</p>
    <p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:0 0 16px;font-family:ui-monospace,monospace">${code}</p>
    <p style="color:#637083;font-size:13px;margin:0">It expires in 10 minutes and works once. If you didn't ask to sign in to ${host}, ignore this email.</p></div>`;
  try {
    await env.EMAIL.send({
      from: { email: env.EMAIL_FROM, name: "Harness Editor" },
      to,
      subject: `${code} is your Harness Editor sign-in code`,
      text,
      html,
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error("sign-in email failed", err.code, err.message);
    throw new HttpError(502, "Could not send the sign-in email. Try again shortly.");
  }
}

function withSecurityHeaders(res: Response): Response {
  if (res.status === 101) return res;
  const r = new Response(res.body, res);
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set("Referrer-Policy", "same-origin");
  r.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  return r;
}
