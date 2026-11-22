interface Env {
  QUEUE_METRICS?: AnalyticsEngineDataset;
  EDGE_LIMIT?: RateLimit;
  ACCOUNTS: DurableObjectNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ENCRYPTION_KEY: string;
  PREVIOUS_ENCRYPTION_KEY?: string;
}
const enc = new TextEncoder(),
  dec = new TextDecoder(),
  day = 86400000;
const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join(
    "",
  );
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const digest = async (s: string | ArrayBuffer) =>
  hex(
    await crypto.subtle.digest(
      "SHA-256",
      typeof s === "string" ? enc.encode(s) : s,
    ),
  );
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
const deny = (status = 403) => json({ error: "Request rejected" }, status);
function account(env: Env, id: string) {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id));
}
function keyBytes(secret: string) {
  const bytes = Uint8Array.from(atob(secret), (s) => s.charCodeAt(0));
  if (bytes.length !== 32) throw Error("Key length");
  return bytes;
}
async function seal(
  secret: string,
  bytes: Uint8Array<ArrayBuffer>,
  context: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes(secret),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(context) },
    key,
    bytes,
  );
  const blob = new Uint8Array(12 + encrypted.byteLength);
  blob.set(iv);
  blob.set(new Uint8Array(encrypted), 12);
  return blob;
}
async function unseal(env: Env, raw: ArrayBuffer, context: string) {
  for (const secret of [env.ENCRYPTION_KEY, env.PREVIOUS_ENCRYPTION_KEY].filter(
    Boolean,
  ) as string[])
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes(secret),
        "AES-GCM",
        false,
        ["decrypt"],
      );
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: raw.slice(0, 12),
            additionalData: enc.encode(context),
          },
          key,
          raw.slice(12),
        ),
      );
    } catch {}
  throw Error("Cannot open stored data");
}
async function bounded(req: Request, max: number) {
  if (Number(req.headers.get("content-length")) > max) throw new RangeError();
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    length += r.value.byteLength;
    if (length > max) {
      await reader.cancel();
      throw new RangeError();
    }
    chunks.push(r.value);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
export default {
  async fetch(req: Request, env: Env) {
    const u = new URL(req.url),
      p = u.pathname.split("/");
    try {
      if (u.pathname === "/health") return json({ status: "ok" });
      if (
        env.EDGE_LIMIT &&
        !(
          await env.EDGE_LIMIT.limit({
            key: req.headers.get("cf-connecting-ip") || "unknown",
          })
        ).success
      )
        return deny(429);
      if (p[1] === "auth" && ["start", "callback", "exchange"].includes(p[2]))
        return account(env, "auth").fetch(req);
      if (
        p[1] === "h" &&
        p.length === 4 &&
        /^\d+$/.test(p[2]) &&
        /^[a-f0-9]{64}$/.test(p[3]) &&
        req.method === "POST"
      )
        return account(env, p[2]).fetch(req);
      const token = req.headers
        .get("authorization")
        ?.match(/^Bearer (\d+)\.([a-f0-9]{64})$/);
      if (!token || p[1] !== "v1") return deny(401);
      return account(env, token[1]).fetch(req);
    } catch {
      return deny(503);
    }
  },
};
export class Account {
  sql: SqlStorage;
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS devices(hash TEXT PRIMARY KEY,created INTEGER)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS hooks(id TEXT PRIMARY KEY,source TEXT UNIQUE,kind TEXT,secret BLOB)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS circleback_titles(hook TEXT PRIMARY KEY REFERENCES hooks(id) ON DELETE CASCADE,excluded_tags TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,source TEXT,body BLOB,created INTEGER)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY,created INTEGER)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS login(state TEXT PRIMARY KEY,challenge TEXT,port TEXT,owner TEXT,expires INTEGER)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS stats(k TEXT PRIMARY KEY,n INTEGER)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS consumers(source TEXT PRIMARY KEY,device TEXT)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS limits(k TEXT PRIMARY KEY,minute INTEGER,n INTEGER)",
    );
  }
  one(q: string, ...args: any[]) {
    return this.sql.exec(q, ...args).toArray()[0];
  }
  notify(device: string) {
    for (const socket of this.ctx.getWebSockets(device)) {
      try {
        socket.send("pending");
      } catch {
        // A disconnected device reads the durable queue when it reconnects.
      }
    }
  }
  webSocketMessage(socket: WebSocket) {
    socket.close(1008, "Notifications are server-only");
  }
  allow(k: string, n: number) {
    const min = Math.floor(Date.now() / 60000);
    this.sql.exec(
      "INSERT INTO limits VALUES(?,?,1) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN minute=excluded.minute THEN n+1 ELSE 1 END, minute=excluded.minute",
      k,
      min,
    );
    return Number(this.one("SELECT n FROM limits WHERE k=?", k)?.n) <= n;
  }
  async alarm() {
    const now = Date.now();
    const stats = this.one(
      "SELECT MIN(created) AS oldest, COUNT(CASE WHEN created < ? THEN 1 END) AS expired FROM events",
      now - 30 * day,
    );
    const expired = Number(stats?.expired || 0);
    if (stats?.oldest != null)
      this.env.QUEUE_METRICS?.writeDataPoint({
        doubles: [(now - Number(stats.oldest)) / day, expired],
      });
    if (expired)
      this.sql.exec(
        "INSERT INTO stats VALUES('expired',?) ON CONFLICT(k) DO UPDATE SET n=n+excluded.n",
        expired,
      );
    this.sql.exec("DELETE FROM events WHERE created<?", now - 30 * day);
    this.sql.exec("DELETE FROM seen WHERE created<?", now - 30 * day);
    this.sql.exec("DELETE FROM login WHERE expires<?", now);
    if (
      this.one("SELECT id FROM events LIMIT 1") ||
      this.one("SELECT id FROM seen LIMIT 1") ||
      this.one("SELECT state FROM login LIMIT 1")
    )
      await this.ctx.storage.setAlarm(now + day);
  }
  async fetch(req: Request) {
    try {
      return await this.route(req);
    } catch (e) {
      return deny(
        e instanceof RangeError ? 413 : e instanceof SyntaxError ? 400 : 503,
      );
    }
  }
  async route(req: Request): Promise<Response> {
    const u = new URL(req.url),
      p = u.pathname.split("/"),
      env = this.env,
      now = Date.now();
    if (p[1] === "_device" && req.method === "POST") {
      // reachable only by service binding
      const hash = await req.text();
      this.sql.exec("INSERT INTO devices VALUES(?,?)", hash, now);
      return json({ ok: true });
    }
    if (p[1] === "auth") {
      if (!this.allow("auth", 120)) return deny(429);
      if (!(await this.ctx.storage.getAlarm()))
        await this.ctx.storage.setAlarm(now + day);
      if (p[2] === "start" && req.method === "GET") {
        const challenge = u.searchParams.get("challenge") || "",
          port = u.searchParams.get("port") || "";
        if (
          !/^[a-f0-9]{64}$/.test(challenge) ||
          !/^\d{4,5}$/.test(port) ||
          +port < 1024 ||
          +port > 65535
        )
          return deny(400);
        const state = random();
        this.sql.exec(
          "INSERT INTO login VALUES(?,?,?,NULL,?)",
          state,
          challenge,
          port,
          now + 600000,
        );
        const dest = new URL("https://github.com/login/oauth/authorize");
        dest.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
        dest.searchParams.set("state", state);
        dest.searchParams.set("redirect_uri", u.origin + "/auth/callback");
        return new Response(null, {
          status: 302,
          headers: {
            location: dest.href,
            "set-cookie":
              "__Host-tb=" +
              state +
              "; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600",
            "cache-control": "no-store",
          },
        });
      }
      if (p[2] === "callback" && req.method === "GET") {
        const state = u.searchParams.get("state") || "";
        if (
          !/^[a-f0-9]{64}$/.test(state) ||
          !req.headers
            .get("cookie")
            ?.split("; ")
            .includes("__Host-tb=" + state)
        )
          return deny();
        const row = this.one(
          "SELECT * FROM login WHERE state=? AND owner IS NULL AND expires>?",
          state,
          now,
        );
        if (!row) return deny();
        const tokenRes = await fetch(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            headers: { accept: "application/json" },
            body: new URLSearchParams({
              client_id: env.GITHUB_CLIENT_ID,
              client_secret: env.GITHUB_CLIENT_SECRET,
              code: u.searchParams.get("code") || "",
              redirect_uri: u.origin + "/auth/callback",
            }),
          },
        );
        const token = await tokenRes.json<{ access_token?: string }>();
        if (!token.access_token) return deny();
        const user = await fetch("https://api.github.com/user", {
          headers: {
            authorization: "Bearer " + token.access_token,
            "user-agent": "Triggerbase",
          },
        });
        if (!user.ok) return deny();
        const { id } = await user.json<{ id: number }>();
        if (!Number.isSafeInteger(id)) return deny();
        const code = random();
        this.sql.exec(
          "UPDATE login SET state=?,owner=? WHERE state=?",
          code,
          String(id),
          state,
        );
        return Response.redirect(
          "http://127.0.0.1:" + row.port + "/callback?code=" + code,
        );
      }
      if (p[2] === "exchange" && req.method === "POST") {
        const { code, verifier } = JSON.parse(
          dec.decode(await bounded(req, 2048)),
        );
        if (typeof verifier !== "string" || typeof code !== "string")
          return deny();
        const challenge = await digest(verifier),
          row = this.one(
            "SELECT * FROM login WHERE state=? AND challenge=? AND expires>? AND owner IS NOT NULL",
            code,
            challenge,
            now,
          );
        if (!row) return deny();
        this.sql.exec("DELETE FROM login WHERE state=?", code);
        const token = row.owner + "." + random(),
          saved = await account(env, String(row.owner)).fetch(
            "https://internal/_device",
            { method: "POST", body: await digest(token) },
          );
        return saved.ok ? json({ token }) : deny(503);
      }
      return deny(404);
    }
    if (p[1] === "h") {
      if (!this.allow("ingress", 600)) return deny(429);
      const hook = this.one("SELECT * FROM hooks WHERE id=?", p[3]);
      if (!hook) return deny(404);
      if (!hook.secret) return deny(403);
      let body = await bounded(req, 1024 * 1024);
      const secret = await unseal(
        env,
        hook.secret as ArrayBuffer,
        "hook/" + hook.id,
      );
      if (hook.kind === "bearer") {
        const given = req.headers.get("authorization") || "";
        if (
          !crypto.subtle.timingSafeEqual(
            await crypto.subtle.digest("SHA-256", enc.encode(given)),
            await crypto.subtle.digest(
              "SHA-256",
              enc.encode("Bearer " + dec.decode(secret)),
            ),
          )
        )
          return deny();
      } else {
        const sig =
          hook.kind === "github"
            ? req.headers
                .get("x-hub-signature-256")
                ?.match(/^sha256=([a-f0-9]{64})$/)?.[1]
            : req.headers.get("x-signature");
        if (!sig || !/^[a-f0-9]{64}$/i.test(sig)) return deny();
        const key = await crypto.subtle.importKey(
          "raw",
          secret,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"],
        );
        if (
          !(await crypto.subtle.verify(
            "HMAC",
            key,
            Uint8Array.from(sig.match(/../g)!, (s) => parseInt(s, 16)),
            body,
          ))
        )
          return deny();
      }
      const payload = JSON.parse(dec.decode(body));
      if (hook.kind === "circleback") {
        const title = this.one(
          "SELECT excluded_tags FROM circleback_titles WHERE hook=?",
          hook.id,
        );
        if (title) {
          const tags: string[] = JSON.parse(String(title.excluded_tags));
          if (
            Array.isArray(payload?.tags) &&
            payload.tags.some(
              (tag: unknown) =>
                typeof tag === "string" &&
                tags.includes(tag.trim().toLowerCase()),
            )
          )
            return new Response(null, { status: 204 });
          const id = payload?.id;
          if (
            !(
              (typeof id === "string" && id.trim() && id.length <= 512) ||
              Number.isSafeInteger(id)
            ) ||
            typeof payload.name !== "string" ||
            !payload.name.trim()
          )
            return deny(400);
          body = new Uint8Array(
            enc.encode(JSON.stringify({ id: String(id), name: payload.name })),
          );
        }
      }
      const id = await digest(hook.source + ":" + (await digest(body.buffer))),
        cipher = await seal(env.ENCRYPTION_KEY, body, "event/" + id);
      if (!(await this.ctx.storage.getAlarm()))
        await this.ctx.storage.setAlarm(now + day);
      if (this.one("SELECT id FROM seen WHERE id=?", id))
        return json({ id, duplicate: true });
      const pending = Number(this.one("SELECT COUNT(*) AS n FROM events")!.n);
      if (pending >= 256) return deny(429);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("INSERT INTO seen VALUES(?,?)", id, now);
        this.sql.exec(
          "INSERT INTO events VALUES(?,?,?,?)",
          id,
          hook.source,
          cipher.buffer,
          now,
        );
      });
      const consumer = this.one("SELECT device FROM consumers WHERE source=?", hook.source);
      if (consumer) this.notify(String(consumer.device));
      if (pending === 0) this.env.QUEUE_METRICS?.writeDataPoint({ doubles: [0, 0] });
      return json({ id }, 202);
    }
    const token = (req.headers.get("authorization") || "").slice(7),
      hash = await digest(token);
    if (!this.one("SELECT hash FROM devices WHERE hash=?", hash))
      return deny(401);
    if (u.pathname === "/v1/notify" && req.method === "GET") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return deny(426);
      if (this.ctx.getWebSockets(hash).length >= 4) return deny(429);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [hash]);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (u.pathname === "/v1/devices" && req.method === "GET")
      return json(
        this.sql.exec("SELECT hash AS id,created FROM devices").toArray(),
      );
    if (p[2] === "devices" && req.method === "DELETE") {
      if (!/^[a-f0-9]{64}$/.test(p[3] || "")) return deny(400);
      this.sql.exec("DELETE FROM devices WHERE hash=?", p[3]);
      for (const socket of this.ctx.getWebSockets(p[3])) socket.close(1008, "Device revoked");
      return json({ ok: true });
    }
    if (u.pathname === "/v1/hooks" && req.method === "POST") {
      const { source, kind, titleOnly } = JSON.parse(
        dec.decode(await bounded(req, 2048)),
      );
      if (
        typeof source !== "string" ||
        !/^[a-z0-9_-]{1,80}$/.test(source) ||
        !["github", "circleback", "bearer"].includes(kind) ||
        (titleOnly !== undefined &&
          (kind !== "circleback" ||
            !Array.isArray(titleOnly) ||
            titleOnly.length > 32 ||
            titleOnly.some(
              (tag: unknown) =>
                typeof tag !== "string" || !tag.trim() || tag.length > 80,
            )))
      )
        return deny(400);
      if (this.one("SELECT id FROM hooks WHERE source=?", source))
        return deny(409);
      if (Number(this.one("SELECT COUNT(*) AS n FROM hooks")!.n) >= 32)
        return deny(429);
      const id = random(),
        secret = kind === "circleback" ? null : random(),
        cipher =
          secret === null
            ? null
            : await seal(
                env.ENCRYPTION_KEY,
                new Uint8Array(enc.encode(secret)),
                "hook/" + id,
              );
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "INSERT INTO hooks VALUES(?,?,?,?)",
          id,
          source,
          kind,
          cipher?.buffer ?? null,
        );
        if (titleOnly)
          this.sql.exec(
            "INSERT INTO circleback_titles VALUES(?,?)",
            id,
            JSON.stringify(
              titleOnly.map((tag: string) => tag.trim().toLowerCase()),
            ),
          );
        this.sql.exec(
          "INSERT OR REPLACE INTO consumers VALUES(?,?)",
          source,
          hash,
        );
      });
      if (this.one("SELECT id FROM events WHERE source=? LIMIT 1", source))
        this.notify(hash);
      return json(
        {
          url: u.origin + "/h/" + token.split(".")[0] + "/" + id,
          ...(secret === null ? { signingKeyRequired: true } : { secret }),
        },
        201,
      );
    }
    if (
      p.length === 5 &&
      p[2] === "hooks" &&
      p[4] === "signing-key" &&
      req.method === "PUT"
    ) {
      const hook = this.one(
        "SELECT hooks.id FROM hooks JOIN consumers USING(source) WHERE source=? AND kind='circleback' AND device=?",
        p[3],
        hash,
      );
      if (!hook) return deny(404);
      const { secret } = JSON.parse(dec.decode(await bounded(req, 2048)));
      if (typeof secret !== "string" || !/^[!-~]{16,512}$/.test(secret))
        return deny(400);
      const cipher = await seal(
        env.ENCRYPTION_KEY,
        new Uint8Array(enc.encode(secret)),
        "hook/" + hook.id,
      );
      const result = this.sql.exec(
        "UPDATE hooks SET secret=? WHERE id=? AND source IN (SELECT source FROM consumers WHERE device=?)",
        cipher.buffer,
        hook.id,
        hash,
      );
      return result.rowsWritten ? json({ ok: true }) : deny(404);
    }
    if (p[2] === "hooks" && req.method === "DELETE") {
      this.sql.exec("DELETE FROM hooks WHERE source=?", p[3]);
      return json({ ok: true });
    }
    if (u.pathname === "/v1/status" && req.method === "GET") {
      const counts = this.one(
        "SELECT COUNT(*) AS pending,MIN(created) AS oldest FROM events JOIN consumers USING(source) WHERE device=?",
        hash,
      );
      return json({
        pending: counts?.pending || 0,
        oldestExpires: counts?.oldest ? Number(counts.oldest) + 30 * day : null,
        expired: this.one("SELECT n FROM stats WHERE k='expired'")?.n || 0,
      });
    }
    if (u.pathname === "/v1/events" && req.method === "GET") {
      const row = this.one(
        "SELECT events.* FROM events JOIN consumers USING(source) WHERE device=? AND created>? ORDER BY events.rowid LIMIT 1",
        hash,
        now - 30 * day,
      );
      return json(
        row
          ? {
              id: row.id,
              source: row.source,
              body: JSON.parse(
                dec.decode(
                  await unseal(env, row.body as ArrayBuffer, "event/" + row.id),
                ),
              ),
            }
          : null,
      );
    }
    if (p[2] === "events" && req.method === "DELETE") {
      this.sql.exec(
        "DELETE FROM events WHERE id=? AND source IN (SELECT source FROM consumers WHERE device=?)",
        p[3],
        hash,
      );
      return json({ ok: true });
    }
    return deny(404);
  }
}
