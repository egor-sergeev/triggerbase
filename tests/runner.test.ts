import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
const root = mkdtempSync(join(tmpdir(), "triggerbase-runner-"));
process.env.TRIGGERBASE_HOME = root;
const { Store } = await import("../src/store.js"),
  { Runner } = await import("../src/runner.js"),
  { plan, readRule, scan } = await import("../src/rules.js");
const db = new Store(),
  runner = new Runner(db),
  dir = join(root, "rules");
const source = {
  id: "deadline",
  cron: "*/15 * * * *",
  check: ["node", "./check.mjs"],
  run: { command: ["node", "-e", "process.stdin.resume()"] },
};
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
test("cron catches up once, saves cursor atomically and deduplicates on repeat", async () => {
  const file = join(dir, "deadline.trigger.yaml");
  writeFileSync(file, stringify(source));
  writeFileSync(
    join(dir, "check.mjs"),
    "import {readFileSync} from 'node:fs';const input=JSON.parse(readFileSync(0,'utf8')); console.log(JSON.stringify({events:[{id:'task-1',data:{url:'https://example.test/1'}}],cursor:(input.cursor||0)+1}));",
  );
  await runner.tick(new Date("2026-11-01T05:00Z"));
  await runner.tick(new Date("2026-11-03T12:08Z"));
  expect(db.list()).toHaveLength(1);
  expect(db.db.prepare("SELECT cursor FROM checks").get()?.cursor).toBe("2");
  writeFileSync(file, stringify({ ...source, enabled: false }));
  await runner.work();
  expect(db.list()[0].status).toBe("queued");
  writeFileSync(file, stringify(source));
  await runner.work();
  expect(db.list()[0].status).toBe("completed");
  expect(
    db.db
      .prepare("SELECT state FROM history ORDER BY rowid")
      .all()
      .map((r) => r.state),
  ).toEqual(["queued", "starting", "running", "completed"]);
  writeFileSync(join(dir, "check.mjs"), "console.log('not json')");
  await runner.tick(new Date("2026-11-03T12:15Z"));
  expect(db.db.prepare("SELECT cursor,error FROM checks").get()).toMatchObject({
    cursor: "2",
    error: expect.any(String),
  });
});
test("invalid and duplicate configs cannot run; custom paths may overlap", () => {
  const custom = join(root, "custom");
  mkdirSync(custom);
  const copy = join(custom, "copy.trigger.yaml");
  writeFileSync(copy, stringify(source));
  writeFileSync(join(custom, "bad.trigger.yaml"), "[broken");
  const res = scan([dir, custom, copy]);
  expect(res.rules.has("deadline")).toBe(false);
  expect(Object.keys(res.errors)).toHaveLength(3);
});
test("chat selection is independent from event deduplication", () => {
  const file = join(dir, "sales.trigger.yaml"),
    event = { id: "reply1", data: { thread: "customer1", text: "Hello" } };
  for (const [chat, same] of [
    ["new", false],
    ["shared", true],
    [{ key: "{{thread}}" }, true],
    [{ id: "5446fe61-f357-469e-b771-24b2cd3315a8" }, true],
  ] as const) {
    writeFileSync(
      file,
      stringify({
        id: "sales",
        webhook: "sales",
        run: {
          worktree: false,
          agent: "codex",
          cwd: root,
          chat,
          prompt: "Draft: {{text}}",
        },
      }),
    );
    const rule = readRule(file),
      p = plan(rule, event);
    expect(p.prompt).toBe("Draft: Hello");
    expect(p.key === plan(rule, { ...event, id: "reply2" }).key).toBe(same);
    expect(() => plan(rule, { ...event, data: {} })).toThrow("Missing");
  }
});
test("local durable inbox survives a restart and re-delivery", async () => {
  const file = join(dir, "inbox.trigger.yaml");
  writeFileSync(
    file,
    stringify({
      id: "inbox",
      webhook: "circleback",
      run: { command: ["true"] },
    }),
  );
  for (let i = 0; i < 2; i++) {
    db.db
      .prepare("INSERT INTO inbox(id,source,body) VALUES(?,?,?)")
      .run("meeting1", "circleback", '{"id":"meeting1"}');
    await new Runner(db).tick();
  }
  expect(db.list().filter((j) => j.rule === "inbox")).toHaveLength(1);
  db.db.prepare("UPDATE jobs SET status='running' WHERE rule='inbox'").run();
  runner.recover();
  expect(db.list().find((j) => j.rule === "inbox")?.status).toBe("unknown");
});
