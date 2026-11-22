import WebSocket from "ws";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { Store } from "./store.js";
import { execute } from "./process.js";

function validate(url: string) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error("Relay must be an HTTPS origin");
  return u.origin;
}
const keychain = "dev.triggerbase.relay";
export async function login(store: Store, origin: string) {
  const relay = validate(origin),
    verifier = randomBytes(32).toString("hex"),
    challenge = createHash("sha256").update(verifier).digest("hex");
  const server = createServer();
  await new Promise<void>((ok, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", ok);
  });
  const port = (server.address() as { port: number }).port;
  try {
    const code = await new Promise<string>((ok, no) => {
      const timer = setTimeout(() => no(Error("Login expired")), 5 * 60_000);
      server.on("request", (req, res) => {
        const u = new URL(req.url!, "http://127.0.0.1"),
          code = u.searchParams.get("code") || "";
        if (
          req.headers.host !== "127.0.0.1:" + port ||
          u.pathname !== "/callback" ||
          !/^[a-f0-9]{64}$/.test(code)
        ) {
          res.writeHead(400).end();
          return;
        }
        clearTimeout(timer);
        res.setHeader("Referrer-Policy", "no-referrer");
        res.end("Return to Triggerbase.");
        ok(code);
      });
      void execute(
        [
          "open",
          relay + "/auth/start?port=" + port + "&challenge=" + challenge,
        ],
        process.cwd(),
        "",
      ).catch((e) => {
        clearTimeout(timer);
        no(e);
      });
    });
    const response = await fetch(relay + "/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, verifier }),
      redirect: "error",
    });
    if (!response.ok) throw Error("Device pairing failed");
    const { token } = (await response.json()) as { token: string };
    if (!/^\d+\.[a-f0-9]{64}$/.test(token))
      throw Error("Invalid device credential");
    // Keychain interactive mode keeps the credential off the process command line.
    const account = createHash("sha256").update(relay).digest("hex");
    await execute(
      ["security", "-i"],
      process.cwd(),
      "add-generic-password -U -a " +
        account +
        " -s " +
        keychain +
        " -w " +
        token +
        "\n",
    );
    store.transaction(() => {
      store.set("relay", relay);
      store.set("relayPairing", randomBytes(8).toString("hex"));
    });
  } finally {
    server.close();
  }
}
async function deviceToken(relay: string) {
  const account = createHash("sha256").update(validate(relay)).digest("hex");
  return (
    await execute(
      [
        "security",
        "find-generic-password",
        "-s",
        keychain,
        "-a",
        account,
        "-w",
      ],
      process.cwd(),
      "",
    )
  ).stdout.trim();
}

export async function openSignalSocket(relay: string) {
  const token = await deviceToken(relay);
  const url = new URL("/v1/notify", relay);
  url.protocol = "wss:";
  return new WebSocket(url, {
    headers: { authorization: "Bearer " + token },
    handshakeTimeout: 10_000,
    perMessageDeflate: false,
    maxPayload: 64,
  });
}

export async function api(
  store: Store,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const relay = store.get("relay", "");
  if (!relay) throw Error("Pair a relay with triggerbase login <origin>");
  return request(relay, await deviceToken(relay), path, method, body);
}

async function request(
  relay: string,
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const r = await fetch(relay + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { authorization: "Bearer " + token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok)
    throw Error(
      "Relay " +
        method +
        " " +
        path.split("/").slice(0, 3).join("/") +
        " returned " +
        r.status,
    );
  return r.json() as Promise<any>;
}
export async function pull(store: Store) {
  const relay = store.get("relay", "");
  if (!relay) return false;
  const token = await deviceToken(relay);
  const get = (path: string, method?: string) =>
    request(relay, token, path, method);
  const status = await get("/v1/status");
  store.set("relayStatus", status);
  if (!status.pending) return false;
  const full = await drain(store, get);
  if (!full) store.set("relayStatus", await get("/v1/status"));
  return full;
}
export async function drain(
  store: Store,
  request: (path: string, method?: string) => Promise<any>,
) {
  for (let count = 0; count < 16; count++) {
    const event = await request("/v1/events");
    if (!event) return false;
    store.db
      .prepare("INSERT OR IGNORE INTO inbox(id,source,body) VALUES(?,?,?)")
      .run(event.id, event.source, JSON.stringify(event.body));
    await request("/v1/events/" + encodeURIComponent(event.id), "DELETE");
  }
  return true;
}
