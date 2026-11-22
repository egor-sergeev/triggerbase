import { afterAll, beforeAll, expect, test } from "vitest";
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
  const { url, secret } = (await hook.json()) as any;
  const body = JSON.stringify({ id: 327, transcript: "A test conversation" });
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
