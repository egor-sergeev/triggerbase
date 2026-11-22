import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { Miniflare } from "miniflare";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createHmac, createHash, randomBytes } from "node:crypto";
import ts from "typescript";
import { tmpdir } from "node:os";
import { join } from "node:path";
let mf: Miniflare,
  owner = "17";
const app = "https://relay.example",
  key = randomBytes(32).toString("base64");
beforeAll(() => {
  const script = ts.transpile(readFileSync("relay/src/index.ts", "utf8"), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  });
  mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-05-01",
    durableObjects: { ACCOUNTS: { className: "Account", useSQLite: true } },
    bindings: {
      ENCRYPTION_KEY: key,
      GITHUB_CLIENT_ID: "test",
      GITHUB_CLIENT_SECRET: "test",
    },
    outboundService: async (req) =>
      Response.json(
        req.url.includes("access_token")
          ? { access_token: "fixture" }
          : { id: Number(owner) },
      ),
  });
});
afterAll(async () => {
  await mf.dispose();
});
async function pair() {
  const verifier = randomBytes(32).toString("hex"),
    challenge = createHash("sha256").update(verifier).digest("hex");
  const start = await mf.dispatchFetch(
    app + "/auth/start?port=9234&challenge=" + challenge,
    { redirect: "manual" },
  );
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  );
  const callback = app + "/auth/callback?state=" + state + "&code=test";
  expect(
    (await mf.dispatchFetch(callback, { redirect: "manual" })).status,
  ).toBe(403);
  const response = await mf.dispatchFetch(callback, {
    headers: { cookie: "__Host-tb=" + state },
    redirect: "manual",
  });
  const code = new URL(response.headers.get("location")!).searchParams.get(
    "code",
  );
  const exchange = () =>
    mf.dispatchFetch(app + "/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, verifier }),
    });
  const token = ((await (await exchange()).json()) as any).token;
  expect((await exchange()).status).toBe(403);
  return token;
}
test("GitHub OAuth pairing, signed ingress, offline queue, replay, isolation and revocation", async () => {
  const token = await pair(),
    auth = { authorization: "Bearer " + token };
  const hook = await mf.dispatchFetch(app + "/v1/hooks", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ source: "pr", kind: "github" }),
  });
  expect(hook.status).toBe(201);
  const { url, secret } = (await hook.json()) as any,
    body = JSON.stringify({ action: "opened", number: 42 });
  const signature =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const send = (text: string) =>
    mf.dispatchFetch(url, {
      method: "POST",
      headers: { "x-hub-signature-256": signature },
      body: text,
    });
  expect((await send(body + " ")).status).toBe(403);
  expect((await send(body)).status).toBe(202);
  expect(await (await send(body)).json()).toMatchObject({ duplicate: true });
  const pull = (headers: Record<string, string>) =>
    mf.dispatchFetch(app + "/v1/events", { headers });
  const event = (await (await pull(auth)).json()) as any;
  expect(event.body.number).toBe(42);
  expect(await (await pull(auth)).json()).toEqual(event);
  owner = "18";
  const other = await pair();
  expect(
    await (await pull({ authorization: "Bearer " + other })).json(),
  ).toBeNull();
  expect(
    (
      await mf.dispatchFetch(app + "/v1/events/" + event.id, {
        method: "DELETE",
        headers: auth,
      })
    ).ok,
  ).toBe(true);
  expect(await (await pull(auth)).json()).toBeNull();
  expect(await (await send(body)).json()).toMatchObject({ duplicate: true });
  const [device] = (await (
    await mf.dispatchFetch(app + "/v1/devices", { headers: auth })
  ).json()) as any;
  await mf.dispatchFetch(app + "/v1/devices/" + device.id, {
    method: "DELETE",
    headers: auth,
  });
  expect((await pull(auth)).status).toBe(401);
});

test("offline receiver → durable local inbox → interrupted ACK → restart → one external command", async () => {
  owner = "19";
  const token = await pair(),
    auth = { authorization: "Bearer " + token };
  const hook = await mf.dispatchFetch(app + "/v1/hooks", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ source: "meetings", kind: "circleback" }),
  });
  const { url, ...registration } = (await hook.json()) as any;
  expect(registration).toEqual({ signingKeyRequired: true });
  const secret = "circleback-provider-issued-key";
  const body = JSON.stringify({ id: 327, transcript: "A test conversation" });
  const headers = {
    "x-signature": createHmac("sha256", secret).update(body).digest("hex"),
  };
  expect(
    (await mf.dispatchFetch(url, { method: "POST", body, headers })).status,
  ).toBe(403);
  const setKey = (token: string, value: string) =>
    mf.dispatchFetch(app + "/v1/hooks/meetings/signing-key", {
      method: "PUT",
      headers: { authorization: "Bearer " + token },
      body: JSON.stringify({ secret: value }),
    });
  expect((await setKey(await pair(), secret)).status).toBe(404);
  expect((await setKey(token, "")).status).toBe(400);
  expect((await setKey(token, secret)).status).toBe(200);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  expect(
    (
      await mf.dispatchFetch(url, {
        method: "POST",
        body,
        headers: { "x-signature": signature },
      })
    ).status,
  ).toBe(202);
  const dir = mkdtempSync(join(tmpdir(), "tb-offline-"));
  process.env.TRIGGERBASE_HOME = dir;
  const { Store } = await import("../src/store.js"),
    { drain } = await import("../src/cloud.js"),
    { Runner } = await import("../src/runner.js");
  const output = join(dir, "effect.txt"),
    request = async (path: string, method = "GET") =>
      (await mf.dispatchFetch(app + path, { method, headers: auth })).json();
  let store = new Store();
  writeFileSync(
    join(dir, "rules", "meet.trigger.yaml"),
    JSON.stringify({
      schemaVersion: 2,
      id: "meet",
      webhook: "meetings",
      run: {
        command: [
          process.execPath,
          "-e",
          'require("node:fs").appendFileSync(' +
            JSON.stringify(output) +
            ',"once")',
        ],
      },
    }),
  );
  try {
    await expect(
      drain(store, (path, method) =>
        method === "DELETE"
          ? Promise.reject(Error("network lost"))
          : request(path, method),
      ),
    ).rejects.toThrow("network lost");
    store.close();
    store = new Store();
    await drain(store, request);
    const runner = new Runner(store);
    await runner.tick();
    await runner.work();
    expect(store.list()).toHaveLength(1);
    expect(readFileSync(output, "utf8")).toBe("once");
    expect(await request("/v1/events")).toBeNull();
    expect(
      (
        await mf.dispatchFetch(url, {
          method: "POST",
          body: "a".repeat(1048577),
          headers: { "x-signature": signature },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await mf.dispatchFetch(url, {
          method: "POST",
          body,
          headers: { "x-signature": "wrong" },
        })
      ).status,
    ).toBe(403);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Circleback title-only mode filters signed tags before storage and rotates the provider key", async () => {
  owner = "32";
  const auth = { authorization: "Bearer " + (await pair()) };
  const request = (path: string, method: string, value?: unknown) =>
    mf.dispatchFetch(app + path, {
      method,
      headers: auth,
      body: JSON.stringify(value),
    });
  const registered = await request("/v1/hooks", "POST", {
    source: "titles",
    kind: "circleback",
    titleOnly: ["personal", "Sensitive"],
  });
  expect(registered.status).toBe(201);
  const { url } = (await registered.json()) as { url: string };
  const old = "old-provider-signing-key",
    key = "new-provider-signing-key";
  for (const secret of [old, key])
    expect(
      (await request("/v1/hooks/titles/signing-key", "PUT", { secret })).status,
    ).toBe(200);
  const send = (payload: object, secret = key) => {
    const body = JSON.stringify(payload);
    return mf.dispatchFetch(url, {
      method: "POST",
      body,
      headers: {
        "x-signature": createHmac("sha256", secret).update(body).digest("hex"),
      },
    });
  };
  const meeting = { id: 123, name: "Title", transcript: "private" };
  expect((await send(meeting, old)).status).toBe(403);
  expect((await send({ ...meeting, tags: [" SENSITIVE "] })).status).toBe(204);
  expect(await (await request("/v1/events", "GET")).json()).toBeNull();
  expect((await send(meeting)).status).toBe(202);
  expect((await send({ ...meeting, transcript: "updated" })).status).toBe(200);
  expect(
    ((await (await request("/v1/events", "GET")).json()) as any).body,
  ).toEqual({ id: "123", name: "Title" });
});

test("server wakes only the subscribed device after persistence and disconnects it on revocation", async () => {
  owner = "20";
  const ownerToken = await pair();
  const bystander = await pair();
  const open = (token: string) =>
    mf.dispatchFetch(app + "/v1/notify", {
      headers: { upgrade: "websocket", authorization: "Bearer " + token },
    });
  expect((await open("invalid")).status).toBe(401);
  const watch = async (token: string) => {
    const response = await open(token);
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    return ws;
  };
  const ws = await watch(ownerToken),
    other = await watch(bystander);
  const messages: unknown[] = [],
    otherMessages: unknown[] = [];
  ws.addEventListener("message", (event) => messages.push(event.data));
  other.addEventListener("message", (event) => otherMessages.push(event.data));
  const headers = { authorization: "Bearer " + ownerToken };
  try {
    const hook = await mf.dispatchFetch(app + "/v1/hooks", {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "test", kind: "bearer" }),
    });
    const { url, secret } = (await hook.json()) as {
      url: string;
      secret: string;
    };
    const send = () =>
      mf.dispatchFetch(url, {
        method: "POST",
        headers: { authorization: "Bearer " + secret },
        body: '{"n":1}',
      });
    expect((await send()).status).toBe(202);
    await vi.waitFor(() => expect(messages).toEqual(["pending"]));
    expect(
      await (await mf.dispatchFetch(app + "/v1/events", { headers })).json(),
    ).toMatchObject({ body: { n: 1 } });
    expect((await send()).status).toBe(200);
    const closed = new Promise<number>((ok) =>
      ws.addEventListener("close", (event) => ok(event.code)),
    );
    const id = createHash("sha256").update(ownerToken).digest("hex");
    expect(
      (
        await mf.dispatchFetch(app + "/v1/devices/" + id, {
          method: "DELETE",
          headers,
        })
      ).ok,
    ).toBe(true);
    expect(await closed).toBe(1008);
    expect((await open(ownerToken)).status).toBe(401);
    expect(messages).toEqual(["pending"]);
    expect(otherMessages).toEqual([]);
  } finally {
    other.close();
  }
});

test("daily alarm records anonymous queue age and reports each expiry once", async () => {
  const { Account } = await import("../relay/src/index.js");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const measurements: unknown[] = [];
  const alarms: number[] = [];
  const day = 86_400_000;
  try {
    const storage = {
      sql: {
        exec(sql: string, ...args: (number | string)[]) {
          const statement = db.prepare(sql);
          const rows = statement.all(...args);
          return { toArray: () => rows };
        },
      },
      setAlarm: async (time: number) => { alarms.push(time); },
    };
    const actor = new Account({ storage } as never, {
      QUEUE_METRICS: { writeDataPoint: (point: unknown) => measurements.push(point) },
    } as never);
    const put = db.prepare("INSERT INTO events VALUES(?, 'private-source', X'01', ?)");
    const now = Date.now();
    put.run("old", now - 31 * day);
    put.run("recent", now - day);
    await actor.alarm();
    await actor.alarm();
    expect(measurements).toEqual([
      { doubles: [expect.closeTo(31, 2), 1] },
      { doubles: [expect.closeTo(1, 2), 0] },
    ]);
    expect(alarms).toHaveLength(2);
    expect(db.prepare("SELECT id FROM events").all()).toEqual([{ id: "recent" }]);
    expect(db.prepare("SELECT n FROM stats WHERE k='expired'").get()?.n).toBe(1);
  } finally {
    db.close();
  }
});
