import { afterAll, expect, test } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { stringify, parse } from "yaml";
const dir = mkdtempSync(join(tmpdir(), "tb-scenarios-"));
process.env.TRIGGERBASE_HOME = dir;
const { Store } = await import("../src/store.js"),
  { Runner } = await import("../src/runner.js");
const db = new Store(),
  r = new Runner(db),
  bin = join(dir, "bin"),
  sink = join(dir, "calls.jsonl"),
  fixture = join(dir, "fixture.json");
mkdirSync(bin);
const oldPath = process.env.PATH;
process.env.PATH = bin + ":" + oldPath;
function program(name: string, script: string) {
  const p = join(bin, name);
  writeFileSync(p, "#!/usr/bin/env node\n" + script);
  chmodSync(p, 0o700);
}
const read =
  'const fs=require("node:fs");const fixture=JSON.parse(fs.readFileSync(' +
  JSON.stringify(fixture) +
  ',"utf8"));';
program("security", 'console.log("fixture")');
program(
  "triggerbase",
  read + "console.log(JSON.stringify({structuredContent:{data:fixture}}))",
);
program(
  "codex",
  'const fs=require("node:fs");if(process.argv[2]==="login"){console.log("Logged in using ChatGPT");process.exit(0)}const args=process.argv.slice(2),id=args.includes("resume")?args[2]:require("crypto").randomUUID();fs.appendFileSync(' +
    JSON.stringify(sink) +
    ',JSON.stringify({id,agent:"codex",prompt:fs.readFileSync(0,"utf8")})+"\\n");for(const m of [{type:"thread.started",thread_id:id},{type:"turn.started"},{type:"turn.completed"}])console.log(JSON.stringify(m))',
);
program(
  "claude",
  'const fs=require("node:fs");if(process.argv[2]==="auth"){console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai"}));process.exit(0)}const args=process.argv.slice(2),id=args[args.findIndex(v=>v==="--session-id"||v==="--resume")+1];fs.appendFileSync(' +
    JSON.stringify(sink) +
    ',JSON.stringify({id,agent:"claude",prompt:fs.readFileSync(0,"utf8")})+"\\n");console.log(JSON.stringify({type:"assistant"}));console.log(JSON.stringify({type:"result",is_error:false}))',
);
const mock = join(dir, "provider.mjs");
writeFileSync(
  mock,
  'import fs from "node:fs";globalThis.fetch=async(url,init)=>{if(String(url).startsWith("https://hooks.slack.com/")){fs.appendFileSync(' +
    JSON.stringify(sink) +
    ',JSON.stringify({slack:JSON.parse(init.body)})+"\\n");return new Response("ok")}return Response.json(JSON.parse(fs.readFileSync(' +
    JSON.stringify(fixture) +
    ',"utf8")))}',
);
function install(name: string) {
  const rule = parse(
    readFileSync("examples/" + name + ".trigger.yaml", "utf8"),
  );
  rule.enabled = true;
  rule.check = [
    process.execPath,
    "--import",
    mock,
    resolve("examples", rule.check[1]),
    ...rule.check.slice(2),
  ];
  rule.run.cwd = dir;
  if (rule.run.command)
    rule.run.command = [
      process.execPath,
      "--import",
      mock,
      resolve("examples", rule.run.command[1]),
    ];
  const path = join(dir, "rules", rule.id + ".trigger.yaml");
  writeFileSync(path, stringify(rule));
  return { rule, path };
}
function calls() {
  return readFileSync(sink, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
}
function inbox(id: string, source: string, body: unknown) {
  db.db
    .prepare("INSERT INTO inbox(id,source,body) VALUES(?,?,?)")
    .run(id, source, JSON.stringify(body));
}
afterAll(() => {
  db.close();
  process.env.PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
});
test.each(["lemlist", "getsales"])(
  "%s: two replies continue one chat; repeated polls do not duplicate",
  async (name) => {
    const { path, rule } = install(name);
    const now = new Date("2026-11-01T12:00:00Z");
    const rows = [1, 2].map((n) =>
      name === "lemlist"
        ? { _id: "msg" + n, leadId: "client", campaignId: "campaign" }
        : {
            uuid: "msg" + n,
            lead_uuid: "client",
            sender_profile_uuid: "sender",
            direction: "inbound",
            created_at: now.toISOString(),
          },
    );
    writeFileSync(fixture, JSON.stringify(rows));
    await r.tick(now);
    await r.work();
    await r.tick(new Date(+now + 300000));
    await r.work();
    const jobs = db.list().filter((j) => j.rule === rule.id);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.status === "completed")).toBe(true);
    expect(new Set(jobs.map((j) => j.session)).size).toBe(1);
    rmSync(path);
  },
);
test("Attio: due task, future task, completed task and catch-up after sleep", async () => {
  const { path, rule } = install("attio"),
    tasks = [
      {
        id: { task_id: "due" },
        deadline_at: "2026-11-02",
        is_completed: false,
      },
      { id: { task_id: "later" }, deadline_at: "2026-12-01" },
      {
        id: { task_id: "finished" },
        deadline_at: "2026-10-01",
        is_completed: true,
      },
    ];
  writeFileSync(fixture, JSON.stringify(tasks));
  await r.tick(new Date("2026-11-01T12:00Z"));
  expect(db.list().filter((j) => j.rule === rule.id)).toHaveLength(0);
  await r.tick(new Date("2026-11-03T12:09Z"));
  await r.work();
  await r.tick(new Date("2026-11-03T12:15Z"));
  expect(db.list().filter((j) => j.rule === rule.id)).toHaveLength(1);
  rmSync(path);
});
test("Circleback: duplicate meeting deliveries create a single Claude job", async () => {
  const { path, rule } = install("circleback"),
    body = {
      id: 12,
      transcript: [{ speaker: "Guest", text: "Plan the next demo." }],
      actionItems: [{ id: 17, title: "Book demo" }],
    };
  inbox("a", "circleback", body);
  inbox("b", "circleback", body);
  await r.tick();
  await r.work();
  expect(db.list().filter((j) => j.rule === rule.id)).toHaveLength(1);
  expect(calls().find((j) => j.agent === "claude").prompt).toContain(
    "Book demo",
  );
  rmSync(path);
});
test("GitHub: one Slack notification for opening and one for merging", async () => {
  program(
    "security",
    'console.log("https://hooks.slack.com/services/fixture")',
  );
  const { path } = install("github");
  for (const [n, action, merged] of [
    [1, "opened", false],
    [2, "closed", false],
    [3, "closed", true],
    [4, "closed", true],
  ]) {
    inbox("gh" + n, "pull-requests", {
      action,
      pull_request: {
        merged,
        number: 4,
        html_url: "https://example.test/pull/4",
      },
      repository: { id: 14 },
    });
  }
  await r.tick();
  await r.work();
  expect(
    calls()
      .filter((x) => x.slack)
      .map((x) => x.slack.text),
  ).toEqual([
    "PR opened — https://example.test/pull/4",
    "PR merged — https://example.test/pull/4",
  ]);
  rmSync(path);
});
